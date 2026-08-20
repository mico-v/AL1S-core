/**
 * XXT 学习通模仿娱乐插件核心逻辑（移植自 astrbot_plugin_XXT/main.py）。
 *
 * 三类能力，全部内存态、重启即清空：
 * - 随机选人（/选人 N）
 * - 防撤回：缓存两分钟内消息，收到撤回通知后记录，可查询/重放/清空
 * - 课堂提醒：上课时段内提醒发言者、被 @ 超时未回复时提醒发起者
 *
 * 依赖 OneBot：get_group_member_list（选人）、send_group_msg / send_group_forward_msg / get_forward_msg（重放）、
 * group_recall 通知（撤回监听）。后台通过 registry 的消息/通知钩子驱动。
 */
import { at, chain, text } from '@snowluma/sdk';
import type { JsonValue, OneBotMessageEvent, OutgoingMessage, SnowLumaApiClient } from '@snowluma/sdk';
import type { CommandContext } from '../registry';

const MESSAGE_CACHE_TTL_SECONDS = 120;
const MAX_MESSAGE_CACHE_SIZE = 500;
const MAX_RECALLED_RECORDS = 50;
const MAX_QUERY_COUNT = 10;

/** 宽松的消息/通知事件视图（OneBot 字段均为可选） */
interface RawEventLike {
  post_type?: string;
  notice_type?: string;
  message_id?: number | string;
  group_id?: number | string;
  user_id?: number | string;
  operator_id?: number | string;
  self_id?: number | string;
  time?: number;
  message?: JsonValue;
  raw_message?: string;
  sender?: { user_id?: number; nickname?: string };
}

/** 合并转发节点（send_group_forward_msg 的 messages 项） */
interface ForwardNode {
  type: string;
  data: Record<string, unknown>;
  sourceForwardId?: string;
}

/** 缓存的消息 */
interface CachedMessage {
  messageId: string;
  sessionId: string;
  groupId: string;
  senderId: string;
  senderName: string;
  time: number;
  cachedAt: number;
  messageStr: string;
  message: JsonValue; // 段数组（array 事件）或 []
  onebotMessage: JsonValue; // 原样 message（array 或 CQ 字符串）
  forwardIds: string[];
  forwardNodes: ForwardNode[];
}

/** 已撤回消息记录 */
interface RecalledRecord extends CachedMessage {
  recordId: number;
  recallTime: number;
  operatorId: string;
}

/** 课堂提醒时段 */
interface ClassPeriod {
  name: string;
  startMinute: number;
  endMinute: number;
}

/** 待提醒的 @ 未回复任务 */
interface PendingTask {
  timer: ReturnType<typeof setTimeout>;
  groupId: string;
  mentionerId: string;
  targetId: string;
  className: string;
  createdAt: number;
}

function norm(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  return ['true', '1', 'on', 'yes'].includes(v);
}

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parseTimeToMinutes(value: string): number | null {
  const m = value.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 从 XXT_CLASS_PERIODS 解析时段：逗号分隔的 "08:30-10:00:课程名" */
function parseClassPeriods(raw: string | undefined): ClassPeriod[] {
  if (!raw) return [];
  const out: ClassPeriod[] = [];
  for (const item of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = item.match(/^\s*(\d{1,2}:\d{2})\s*[-—~]\s*(\d{1,2}:\d{2})(?:\s*[:：]\s*(.+))?\s*$/);
    if (!m) continue;
    const start = parseTimeToMinutes(m[1]!);
    const end = parseTimeToMinutes(m[2]!);
    if (start === null || end === null) continue;
    out.push({ name: (m[3] ?? '').trim() || '课程', startMinute: start, endMinute: end });
  }
  return out;
}

function formatTimestamp(ts: number): string {
  if (!ts || ts <= 0) return '未知时间';
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Fisher–Yates 洗牌后取前 n 项（等价 random.sample） */
function sample<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy.slice(0, n);
}

/** 把 JsonValue 的 message 规整为段列表 */
function iterSegments(message: JsonValue | undefined): Array<{ type: string; data: Record<string, unknown> }> {
  if (Array.isArray(message)) {
    return message
      .filter((s) => typeof s === 'object' && s !== null)
      .map((s) => {
        const o = s as Record<string, unknown>;
        const d = typeof o['data'] === 'object' && o['data'] !== null ? (o['data'] as Record<string, unknown>) : {};
        return { type: norm(o['type']).toLowerCase(), data: d };
      });
  }
  if (typeof message === 'object' && message !== null) {
    const o = message as Record<string, unknown>;
    return [{ type: norm(o['type']).toLowerCase(), data: (o['data'] as Record<string, unknown>) ?? {} }];
  }
  return [];
}

function isForwardSegment(seg: { type: string }): boolean {
  return seg.type === 'forward';
}

/** 提取消息里的合并转发 id（段数组 + CQ 字符串两种来源） */
function extractForwardIds(message: JsonValue): string[] {
  const ids: string[] = [];
  for (const seg of iterSegments(message)) {
    if (!isForwardSegment(seg)) continue;
    const id = seg.data['id'];
    if (id) ids.push(norm(id));
  }
  if (typeof message === 'string') {
    for (const item of message.match(/\[CQ:forward,[^\]]*id=([^,\]]+)/g) ?? []) {
      const id = item.match(/id=([^,\]]+)/)?.[1];
      if (id) ids.push(norm(id));
    }
  }
  return [...new Set(ids)];
}

/** 去掉 forward 段，用于重放时先发普通消息 */
function removeForwardSegments(message: JsonValue): JsonValue {
  if (Array.isArray(message)) {
    return message.filter((s) => !(typeof s === 'object' && s !== null && isForwardSegment({ type: norm((s as Record<string, unknown>)['type']).toLowerCase() })));
  }
  if (typeof message === 'string') return message.replace(/\[CQ:forward,[^\]]+\]/g, '').trim();
  return message;
}

function isEmptyMessage(message: JsonValue | undefined): boolean {
  if (message === null || message === undefined) return true;
  if (typeof message === 'string') return message.trim() === '';
  if (Array.isArray(message)) return message.length === 0;
  return false;
}

/** 提取 @ 的用户 QQ（段 + CQ 字符串），跳过 all */
function extractMentionedIds(event: OneBotMessageEvent): string[] {
  const mentioned: string[] = [];
  const seen = new Set<string>();
  const add = (id: unknown): void => {
    const n = norm(id);
    if (!n || n === 'all') return;
    if (!seen.has(n)) {
      seen.add(n);
      mentioned.push(n);
    }
  };
  const ev = event as unknown as RawEventLike;
  for (const seg of iterSegments(ev.message)) {
    if (seg.type === 'at') add(seg.data['qq']);
  }
  if (typeof ev.message === 'string') {
    for (const item of ev.message.match(/\[CQ:at,qq=([^,\]]+)/g) ?? []) {
      const id = item.match(/qq=([^,\]]+)/)?.[1];
      if (id) add(id);
    }
  }
  return mentioned;
}

/** 判断是否为撤回通知 */
function isRecallEvent(event: unknown): boolean {
  const ev = event as RawEventLike;
  if (ev.post_type && ev.post_type !== 'notice') return false;
  return ['group_recall', 'friend_recall', 'message_recall', 'recall'].includes(norm(ev.notice_type));
}

export class XxtPlugin {
  private api?: SnowLumaApiClient;
  private readonly adminIds: number[];

  private classReminderEnabled: boolean;
  private classPeriods: ClassPeriod[];
  private disposed = false;
  /** 运行时读 env（管理后台改 env.XXT_CLASS_* 即时生效） */
  private get classWarningCooldown(): number {
    return intEnv('XXT_CLASS_WARNING_COOLDOWN_SECONDS', 60);
  }

  private get classReplyTimeout(): number {
    return intEnv('XXT_CLASS_REPLY_TIMEOUT_SECONDS', 60);
  }

  private recentMessages = new Map<string, CachedMessage>();
  private recalledMessages: RecalledRecord[] = [];
  private nextRecalledRecordId = 1;
  private classWarningLastAt = new Map<string, number>();
  private classMentionPending = new Map<string, PendingTask>();
  private selfIdCache?: number;

  constructor() {
    this.adminIds = norm(process.env.BOT_ADMINS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => !Number.isNaN(n));
    this.classReminderEnabled = boolEnv('XXT_CLASS_REMINDER_ENABLED', false);
    this.classPeriods = parseClassPeriods(process.env.XXT_CLASS_PERIODS);
  }

  reloadFromConfig(): void {
    this.adminIds.splice(0, this.adminIds.length, ...norm(process.env.BOT_ADMINS).split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n)));
    this.classPeriods = parseClassPeriods(process.env.XXT_CLASS_PERIODS);
    this.classReminderEnabled = boolEnv('XXT_CLASS_REMINDER_ENABLED', this.classReminderEnabled);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const rec of this.classMentionPending.values()) clearTimeout(rec.timer);
    this.classMentionPending.clear();
    this.recentMessages.clear();
    this.recalledMessages = [];
    this.classWarningLastAt.clear();
  }

  setApi(api: SnowLumaApiClient | undefined): void {
    this.api = api;
  }

  // --- 后台钩子 ---

  /** 消息钩子：清缓存 + 缓存消息 + 课堂提醒判定 */
  async messageHook(event: OneBotMessageEvent): Promise<void> {
    if (this.disposed) return;
    this.purgeExpiredCache();
    if (this.isCacheableMessage(event)) {
      await this.cacheMessage(event);
      await this.handleClassReminder(event);
    }
  }

  /** 通知钩子：撤回通知 → 记录 */
  noticeHook(event: unknown): void {
    if (this.disposed) return;
    if (isRecallEvent(event)) this.handleRecallEvent(event);
  }

  // --- 命令 ---

  /** /选人 N：随机 @ 群成员 */
  async cmdPick(ctx: CommandContext): Promise<void> {
    if (!ctx.groupId) {
      await ctx.reply('该指令仅支持群聊使用。');
      return;
    }
    const m = (ctx.input?.count !== undefined ? String(ctx.input.count) : (ctx.rest ?? '')).match(/(\d+)/);
    if (!m) {
      await ctx.reply('用法：/选人 人数，例如 /选人 3');
      return;
    }
    const pickCount = parseInt(m[1]!, 10);
    if (pickCount <= 0) {
      await ctx.reply('人数必须大于 0。');
      return;
    }
    let members: unknown[];
    try {
      members = (await ctx.api.getGroupMemberList(ctx.groupId)) as unknown[];
    } catch {
      await ctx.reply('读取群成员失败，请确认当前平台为 QQ(OneBot) 并重试。');
      return;
    }
    if (!Array.isArray(members) || members.length === 0) {
      await ctx.reply('群成员列表为空，无法选人。');
      return;
    }
    const selfId = await this.selfId(ctx.api);
    const candidates = members.filter((m0) => {
      const o = m0 as Record<string, unknown>;
      return norm(o['user_id']) !== norm(selfId);
    });
    if (candidates.length === 0) {
      await ctx.reply('群成员列表为空，无法选人。');
      return;
    }
    if (pickCount > candidates.length) {
      await ctx.reply(`人数过多，当前可选成员共 ${candidates.length} 人。`);
      return;
    }
    const selected = sample(candidates, pickCount);
    const selectedIds = selected.map((mem) => String((mem as Record<string, unknown>)['user_id']));
    await ctx.reply(`随机选中：${selectedIds.join(' ')}`);
    let output = chain().text('随机选中：');
    selected.forEach((mem, idx) => {
      output = output.at(Number((mem as Record<string, unknown>)['user_id']));
      if (idx < selected.length - 1) output = output.text(' ');
    });
    await ctx.send(output);
  }

  /** /查撤回 [N]：列出最近撤回记录（管理员） */
  async cmdQueryRecall(ctx: CommandContext): Promise<void> {
    if (!ctx.groupId) {
      await ctx.reply('该指令仅支持群聊使用。');
      return;
    }
    if (!this.requireAdmin(ctx)) return;
    const m = (ctx.input?.count !== undefined ? String(ctx.input.count) : (ctx.rest ?? '')).match(/(\d+)/);
    let count = 5;
    if (m) {
      count = parseInt(m[1]!, 10);
      if (count <= 0) {
        await ctx.reply('查询数量必须大于 0。');
        return;
      }
    }
    const groupId = String(ctx.groupId);
    const filtered = this.recalledMessages.filter((r) => r.groupId === groupId);
    if (filtered.length === 0) {
      await ctx.reply('暂无已记录的撤回消息。仅能记录插件收到后两分钟内被撤回的消息。');
      return;
    }
    const records = [...filtered.slice(-Math.min(count, MAX_QUERY_COUNT))].reverse();
    const lines = ['最近记录的撤回消息：'];
    records.forEach((rec, idx) => {
      const sender = rec.senderName || rec.senderId || '未知用户';
      lines.push(`#${idx + 1} ${formatTimestamp(rec.time)} ${sender}(${rec.senderId || '未知'})`);
    });
    await ctx.reply(lines.join('\n'));
  }

  /** /重放 N：按编号重放撤回消息（管理员） */
  async cmdReplay(ctx: CommandContext): Promise<void> {
    if (!ctx.groupId) {
      await ctx.reply('该指令仅支持群聊使用。');
      return;
    }
    if (!this.requireAdmin(ctx)) return;
    const m = (ctx.input?.count !== undefined ? String(ctx.input.count) : (ctx.rest ?? '')).match(/(\d+)/);
    const recordId = m ? parseInt(m[1]!, 10) : 0;
    if (!recordId || recordId <= 0) {
      await ctx.reply('用法：/重放 序号，例如 /重放 3。');
      return;
    }
    const record = this.findRecalledRecord(String(ctx.groupId), recordId);
    if (!record) {
      await ctx.reply(`未找到编号 #${recordId} 的撤回消息。`);
      return;
    }
    const hasForward = record.forwardIds.length > 0 || record.forwardNodes.length > 0;
    try {
      if (await this.tryReplayWithOnebot(ctx.groupId, record)) return;
    } catch (e) {
      if (hasForward) {
        await ctx.reply(`重放失败：${errMsg(e)}`);
        return;
      }
    }
    if (hasForward) {
      await ctx.reply('重放合并转发需要 OneBot API，当前适配器无法发送。');
      return;
    }
    const components = this.replayComponents(record);
    await ctx.send(components);
  }

  /** /清空撤回：清空当前群撤回记录（管理员） */
  async cmdClearRecall(ctx: CommandContext): Promise<void> {
    if (!ctx.groupId) {
      await ctx.reply('该指令仅支持群聊使用。');
      return;
    }
    if (!this.requireAdmin(ctx)) return;
    const groupId = String(ctx.groupId);
    const before = this.recalledMessages.length;
    this.recalledMessages = this.recalledMessages.filter((r) => r.groupId !== groupId);
    await ctx.reply(`已清空 ${before - this.recalledMessages.length} 条撤回消息记录。`);
  }

  /** /课堂提醒 开|关|状态（管理员） */
  async cmdClassReminder(ctx: CommandContext): Promise<void> {
    if (!this.requireAdmin(ctx)) return;
    const arg = (ctx.rest ?? '').trim().toLowerCase();
    if (['开', '开启', 'on', 'true', '启用', 'enable', '1', '打开'].includes(arg)) {
      this.classReminderEnabled = true;
      this.classPeriods = parseClassPeriods(process.env.XXT_CLASS_PERIODS);
      await ctx.reply('课堂提醒已开启。');
      return;
    }
    if (['关', '关闭', 'off', 'false', '停用', 'disable', '0', '关闭功能'].includes(arg)) {
      this.classReminderEnabled = false;
      for (const rec of [...this.classMentionPending.values()]) clearTimeout(rec.timer);
      this.classMentionPending.clear();
      this.classWarningLastAt.clear();
      await ctx.reply('课堂提醒已关闭。');
      return;
    }
    if (['状态', '', '查看', 'status', 'check'].includes(arg)) {
      await ctx.reply(`课堂提醒当前${this.classReminderEnabled ? '开启' : '关闭'}。`);
      return;
    }
    await ctx.reply('用法：/课堂提醒 开|关|状态。开启后会在上课时段内提醒发言与@未及时回应。');
  }

  // --- 权限 ---

  private requireAdmin(ctx: CommandContext): boolean {
    if (this.adminIds.length === 0) return true; // 未配置管理员 = 不限制
    if (ctx.senderId !== undefined && this.adminIds.includes(ctx.senderId)) return true;
    void ctx.reply('该指令仅管理员可用。');
    return false;
  }

  private async selfId(api: SnowLumaApiClient): Promise<number> {
    if (this.selfIdCache === undefined) {
      try {
        const info = await api.getLoginInfo();
        this.selfIdCache = info.user_id;
      } catch {
        this.selfIdCache = 0;
      }
    }
    return this.selfIdCache;
  }

  // --- 防撤回：缓存与记录 ---

  private isCacheableMessage(event: OneBotMessageEvent): boolean {
    const ev = event as unknown as RawEventLike;
    if (ev.post_type && ev.post_type !== 'message') return false;
    if (!norm(ev.message_id)) return false;
    return !isEmptyMessage(ev.message);
  }

  private purgeExpiredCache(): void {
    const now = Date.now() / 1000;
    for (const [key, rec] of [...this.recentMessages]) {
      if (now - rec.cachedAt > MESSAGE_CACHE_TTL_SECONDS) this.recentMessages.delete(key);
    }
  }

  private async cacheMessage(event: OneBotMessageEvent): Promise<void> {
    const ev = event as unknown as RawEventLike;
    const messageId = norm(ev.message_id);
    const sessionId = norm(ev.group_id ?? ev.user_id ?? '');
    if (!sessionId || !messageId) return;
    const sender = ev.sender;
    const senderId = norm(sender?.user_id ?? ev.user_id ?? '');
    const senderName = norm(sender?.nickname ?? '') || senderId;
    const groupId = norm(ev.group_id ?? '');
    const timestamp = Number(ev.time ?? Math.floor(Date.now() / 1000));
    const onebotMessage = ev.message ?? ev.raw_message ?? [];
    const forwardIds = extractForwardIds(onebotMessage);
    const forwardNodes = forwardIds.length ? await this.loadForwardNodes(onebotMessage) : [];

    const record: CachedMessage = {
      messageId,
      sessionId,
      groupId,
      senderId,
      senderName,
      time: timestamp,
      cachedAt: Date.now() / 1000,
      messageStr: typeof onebotMessage === 'string' ? onebotMessage : '',
      message: Array.isArray(onebotMessage) ? onebotMessage : [],
      onebotMessage,
      forwardIds,
      forwardNodes,
    };
    this.recentMessages.set(`${sessionId}:${messageId}`, record);
    while (this.recentMessages.size > MAX_MESSAGE_CACHE_SIZE) {
      const firstKey = this.recentMessages.keys().next().value;
      if (firstKey === undefined) break;
      this.recentMessages.delete(firstKey);
    }
  }

  private handleRecallEvent(event: unknown): void {
    const ev = event as RawEventLike;
    const messageId = norm(ev.message_id);
    if (!messageId) return;
    const sessionId = norm(ev.group_id ?? ev.user_id ?? '');
    const record = this.popCached(sessionId, messageId);
    if (!record) return;
    const recalled: RecalledRecord = {
      ...record,
      recordId: this.nextRecalledRecordId++,
      recallTime: Math.floor(Date.now() / 1000),
      operatorId: norm(ev.operator_id ?? ''),
    };
    this.recalledMessages.push(recalled);
    if (this.recalledMessages.length > MAX_RECALLED_RECORDS) {
      this.recalledMessages = this.recalledMessages.slice(-MAX_RECALLED_RECORDS);
    }
  }

  private popCached(sessionId: string, messageId: string): CachedMessage | undefined {
    const key = `${sessionId}:${messageId}`;
    const rec = this.recentMessages.get(key);
    if (rec) {
      this.recentMessages.delete(key);
      return rec;
    }
    for (const [k, r] of [...this.recentMessages]) {
      if (r.messageId !== messageId) continue;
      if (sessionId && r.sessionId !== sessionId) continue;
      this.recentMessages.delete(k);
      return r;
    }
    return undefined;
  }

  private findRecalledRecord(groupId: string, recordId: number): RecalledRecord | undefined {
    const ordered = [...this.recalledMessages.filter((r) => r.groupId === groupId)].reverse();
    const byIndex = ordered.findIndex((_, i) => i + 1 === recordId);
    if (byIndex >= 0) return ordered[byIndex];
    return ordered.find((r) => norm(r.recordId) === String(recordId));
  }

  private replayComponents(record: RecalledRecord): OutgoingMessage {
    if (record.messageStr) return text(record.messageStr);
    if (Array.isArray(record.message) && record.message.length > 0) return text('[消息内容]');
    return text('');
  }

  // --- 重放（OneBot） ---

  private async tryReplayWithOnebot(groupId: number, record: RecalledRecord): Promise<boolean> {
    const api = this.api;
    if (!api) return false;
    const hasForward = record.forwardIds.length > 0 || record.forwardNodes.length > 0;
    if (hasForward) {
      const normal = removeForwardSegments(record.onebotMessage);
      if (!isEmptyMessage(normal)) {
        await api.call('send_group_msg', { group_id: groupId, message: normal, auto_escape: false });
      }
      let nodes = record.forwardNodes;
      if (nodes.length === 0) {
        nodes = await this.loadForwardNodes(record.onebotMessage);
        if (nodes.length) record.forwardNodes = nodes;
      }
      if (nodes.length === 0) throw new Error('未能展开合并转发内容，可能转发 ID 已失效。');
      await api.call('send_group_forward_msg', { group_id: groupId, messages: nodes as unknown as JsonValue });
      return true;
    }
    if (!isEmptyMessage(record.onebotMessage)) {
      await api.call('send_group_msg', { group_id: groupId, message: record.onebotMessage, auto_escape: false });
      return true;
    }
    return false;
  }

  // --- 合并转发展开 ---

  private async loadForwardNodes(message: JsonValue): Promise<ForwardNode[]> {
    const api = this.api;
    if (!api) return [];
    const nodes: ForwardNode[] = [];
    for (const seg of iterSegments(message)) {
      if (!isForwardSegment(seg)) continue;
      const inline = this.normalizeForwardNodes(seg.data['content'] ?? seg.data['messages']);
      const fid = norm(seg.data['id']);
      for (const n of inline) n.sourceForwardId = fid;
      if (inline.length) {
        nodes.push(...inline);
        continue;
      }
      if (!fid) continue;
      const fetched = await this.fetchForwardNodes(fid);
      for (const n of fetched) n.sourceForwardId = fid;
      nodes.push(...fetched);
    }
    for (const fid of extractForwardIds(message)) {
      const has = nodes.some((n) => n.sourceForwardId === fid);
      if (!has) nodes.push(...(await this.fetchForwardNodes(fid)));
    }
    for (const n of nodes) delete n.sourceForwardId;
    return nodes;
  }

  private async fetchForwardNodes(forwardId: string): Promise<ForwardNode[]> {
    const api = this.api;
    if (!api) return [];
    for (const params of [{ message_id: forwardId }, { id: forwardId }]) {
      try {
        const resp = (await api.call('get_forward_msg', params as never)) as unknown;
        const data = (resp as { data?: unknown } | null)?.data ?? resp;
        const nodes = this.normalizeForwardNodes(data);
        if (nodes.length) return nodes;
      } catch {
        // 尝试下一种参数
      }
    }
    return [];
  }

  private normalizeForwardNodes(data: unknown): ForwardNode[] {
    let list: unknown[] = [];
    if (Array.isArray(data)) {
      list = data;
    } else if (typeof data === 'object' && data !== null) {
      const d = data as Record<string, unknown>;
      if (this.looksLikeForwardNode(d)) {
        list = [d];
      } else {
        const m = d['messages'] ?? d['message'] ?? d['content'] ?? [];
        list = Array.isArray(m) ? (m as unknown[]) : [m];
      }
    }

    const nodes: ForwardNode[] = [];
    for (const item of list) {
      const node = this.normalizeForwardNode(item);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  private looksLikeForwardNode(d: Record<string, unknown>): boolean {
    if (norm(d['type']).toLowerCase() === 'node') return true;
    const contentKeys = ['content', 'message', 'raw_message', 'id'];
    const senderKeys = ['sender', 'user_id', 'uin', 'nickname', 'name'];
    return contentKeys.some((k) => k in d) && senderKeys.some((k) => k in d);
  }

  private normalizeForwardNode(item: unknown): ForwardNode | null {
    let nodeData: Record<string, unknown>;
    let content: unknown;
    let nodeId = '';
    if (typeof item === 'string') {
      nodeData = {};
      content = item;
    } else if (typeof item === 'object' && item !== null) {
      const d = item as Record<string, unknown>;
      const nested = d['data'] && typeof d['data'] === 'object' ? (d['data'] as Record<string, unknown>) : {};
      nodeData = norm(d['type']).toLowerCase() === 'node' ? nested : d;
      nodeId = norm(nodeData['id'] ?? nodeData['message_id'] ?? '');
      content = nodeData['content'] ?? nodeData['message'] ?? nodeData['raw_message'] ?? '';
    } else {
      return null;
    }

    if (isEmptyMessage(content as JsonValue)) {
      return nodeId ? { type: 'node', data: { id: nodeId } } : null;
    }
    const sender =
      typeof nodeData['sender'] === 'object' && nodeData['sender'] !== null ? (nodeData['sender'] as Record<string, unknown>) : {};
    const uid = nodeData['user_id'] ?? nodeData['uin'] ?? sender['user_id'] ?? sender['uin'] ?? 0;
    const nickname = norm(nodeData['nickname'] ?? nodeData['name'] ?? sender['nickname'] ?? sender['card'] ?? String(uid));
    return {
      type: 'node',
      data: {
        user_id: uid === 0 || uid === '' || uid === null || uid === undefined ? 0 : Number(uid),
        nickname: nickname || '未知用户',
        content,
      },
    };
  }

  // --- 课堂提醒 ---

  private async handleClassReminder(event: OneBotMessageEvent): Promise<void> {
    const ev = event as unknown as RawEventLike;
    const groupId = norm(ev.group_id ?? '');
    if (!groupId) return;
    const senderId = norm(ev.user_id ?? ev.sender?.user_id ?? '');
    if (!senderId) return;
    const botId = norm(ev.self_id ?? '');
    if (botId && senderId === botId) return;

    this.markTargetReplied(groupId, senderId);

    if (!this.classReminderEnabled) return;
    const className = this.getCurrentClassName();
    if (!className) return;

    this.warnSpeakerIfNeeded(groupId, senderId, className);

    for (const targetId of extractMentionedIds(event)) {
      if (targetId === senderId) continue;
      this.scheduleOrRefreshMentionReminder(groupId, senderId, targetId, className);
    }
  }

  private markTargetReplied(groupId: string, senderId: string): void {
    for (const [key, rec] of [...this.classMentionPending]) {
      if (groupId !== rec.groupId || senderId !== rec.targetId) continue;
      clearTimeout(rec.timer);
      this.classMentionPending.delete(key);
    }
  }

  private warnSpeakerIfNeeded(groupId: string, senderId: string, className: string): void {
    const key = `${groupId}:${senderId}`;
    const lastAt = this.classWarningLastAt.get(key) ?? 0;
    const now = Date.now() / 1000;
    const cooldown = Math.max(1, this.classWarningCooldown);
    if (now - lastAt < cooldown) return;
    this.classWarningLastAt.set(key, now);
    void this.safeSend(groupId, chain().at(Number(senderId)).text(`现在是 ${className} 上课时间，请先上课好好听讲。`));
  }

  private scheduleOrRefreshMentionReminder(groupId: string, mentionerId: string, targetId: string, className: string): void {
    if (!targetId || targetId === 'all') return;
    if (!this.api) return;
    const key = `${groupId}:${targetId}:${mentionerId}`;
    const existing = this.classMentionPending.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      void this.sendLateReplyReminder(groupId, mentionerId, targetId, className);
    }, this.classReplyTimeout * 1000);
    this.classMentionPending.set(key, {
      timer,
      groupId,
      mentionerId,
      targetId,
      className,
      createdAt: Date.now() / 1000,
    });
  }

  private async sendLateReplyReminder(groupId: string, mentionerId: string, targetId: string, className: string): Promise<void> {
    const key = `${groupId}:${targetId}:${mentionerId}`;
    const record = this.classMentionPending.get(key);
    this.classMentionPending.delete(key);
    if (!record) return;
    if (!this.classReminderEnabled) return;
    await this.safeSend(groupId, chain().at(Number(mentionerId)).text('对方 ').at(Number(targetId)).text(` 当前未回复，正在上课：${className}，先好好听讲。`));
  }

  private async safeSend(groupId: string, message: OutgoingMessage): Promise<void> {
    try {
      if (!this.api) return;
      const segments = message instanceof Object && 'build' in message && typeof (message as { build?: unknown }).build === 'function'
        ? (message as { build: () => JsonValue }).build()
        : message;
      await this.api.call('send_group_msg', { group_id: Number(groupId), message: segments as JsonValue, auto_escape: false });
    } catch {
      // 主动推送失败静默，不打扰群
    }
  }

  private getCurrentClassName(): string {
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    for (const p of this.classPeriods) {
      if (p.startMinute < 0 || p.endMinute < 0) continue;
      if (p.startMinute < p.endMinute) {
        if (p.startMinute <= currentMinute && currentMinute < p.endMinute) return p.name;
      } else if (currentMinute >= p.startMinute || currentMinute < p.endMinute) {
        return p.name;
      }
    }
    return '';
  }
}
