/**
 * 群记忆：成员档案 + 群日记。
 *
 * 数据来源是 chat-log 已经落盘的 JSONL（data/chats/group/<openid>/messages.jsonl），
 * 所以这里不重复采集，只负责：
 *   1. 读取某个群的原始消息（增量）；
 *   2. 让模型把这批消息归纳进成员档案；
 *   3. 给对话时提供「我记得的事」文本块。
 */

import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface RawRecord {
  messageId: string;
  timestamp: string;
  senderId: string;
  senderName?: string;
  senderIsBot?: boolean;
  content: string;
  groupOpenid?: string;
}

export interface MemberEntry {
  openid: string;
  name: string;
  profilePath: string;
  profile: string;
  /** 档案最后更新时间；归纳时用来把「刚改过的人」排到最后，保住提示词缓存前缀。 */
  mtimeMs: number;
}

const MAX_CONTEXT_PROFILE_CHARS = 700;

/** 一个群的记忆目录。 */
export class GroupMemory {
  readonly dir: string;
  private readonly membersDir: string;
  private readonly diaryDir: string;
  private readonly stateFile: string;

  constructor(root: string, groupOpenid: string) {
    const safe = groupOpenid.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
    this.dir = path.join(root, 'memory', safe);
    this.membersDir = path.join(this.dir, 'members');
    this.diaryDir = path.join(this.dir, 'diary');
    this.stateFile = path.join(this.dir, 'state.json');
  }

  async ensure(): Promise<void> {
    await mkdir(this.membersDir, { recursive: true });
    await mkdir(this.diaryDir, { recursive: true });
  }

  /** 全部成员档案（含正文）。 */
  async listMembers(): Promise<MemberEntry[]> {
    if (!existsSync(this.membersDir)) {
      return [];
    }
    const files = (await readdir(this.membersDir)).filter((f) => f.endsWith('.md'));
    const out: MemberEntry[] = [];
    for (const file of files) {
      const profilePath = path.join(this.membersDir, file);
      const [profile, info] = await Promise.all([
        readFile(profilePath, 'utf8'),
        stat(profilePath).catch(() => undefined),
      ]);
      const openid = file.replace(/\.md$/, '');
      const name = /^#\s*(.+)$/m.exec(profile)?.[1]?.trim() ?? openid.slice(0, 8);
      out.push({ openid, name, profilePath, profile, mtimeMs: info?.mtimeMs ?? 0 });
    }
    return out;
  }

  async getMember(openid: string): Promise<MemberEntry | undefined> {
    const profilePath = path.join(this.membersDir, `${openid}.md`);
    if (!existsSync(profilePath)) {
      return undefined;
    }
    const [profile, info] = await Promise.all([
      readFile(profilePath, 'utf8'),
      stat(profilePath).catch(() => undefined),
    ]);
    const name = /^#\s*(.+)$/m.exec(profile)?.[1]?.trim() ?? openid.slice(0, 8);
    return { openid, name, profilePath, profile, mtimeMs: info?.mtimeMs ?? 0 };
  }

  async saveMember(openid: string, name: string, body: string): Promise<void> {
    await this.ensure();
    const raw = body.trimStart().startsWith('#') ? body : `# ${name}\n\n${body}`;
    const text = normalizeProfile(raw, name);
    await writeFile(path.join(this.membersDir, `${openid}.md`), `${text.trimEnd()}\n`, 'utf8');
  }

  /** 渲染成给模型看的「我记得的事」。只挑相关的人，避免撑爆上下文。 */
  async renderContext(openids: string[], maxPeople = 3): Promise<string> {
    const blocks: string[] = [];
    for (const openid of openids.slice(0, maxPeople)) {
      const member = await this.getMember(openid);
      if (!member) {
        continue;
      }
      const body = member.profile.trim();
      blocks.push(body.length > MAX_CONTEXT_PROFILE_CHARS
        ? `${body.slice(0, MAX_CONTEXT_PROFILE_CHARS)}…`
        : body);
    }
    return blocks.join('\n\n');
  }

  async readState(): Promise<{ lastMessageId?: string; lastMessageAt?: string; lastOffset?: number }> {
    if (!existsSync(this.stateFile)) {
      return {};
    }
    try {
      return JSON.parse(await readFile(this.stateFile, 'utf8')) as {
        lastMessageId?: string;
        lastMessageAt?: string;
        lastOffset?: number;
      };
    } catch {
      return {};
    }
  }

  async writeState(state: {
    lastMessageId?: string;
    lastMessageAt?: string;
    lastOffset?: number;
  }): Promise<void> {
    await this.ensure();
    await writeFile(this.stateFile, JSON.stringify(state, null, 2), 'utf8');
  }

  async appendDiary(date: string, text: string): Promise<void> {
    await this.ensure();
    const file = path.join(this.diaryDir, `${date}.md`);
    const prev = existsSync(file) ? await readFile(file, 'utf8') : `# ${date} 群日记\n`;
    await writeFile(file, `${prev.trimEnd()}\n\n${text.trim()}\n`, 'utf8');
  }
}

/** 一条档案变更。模型只给「改了什么」，不再整份重写。 */
export interface ProfileChange {
  op: 'add' | 'replace' | 'remove';
  /** replace / remove 用来定位旧行的片段 */
  match?: string;
  /** add / replace 的新内容（一整行，以「- 」开头） */
  text?: string;
}

const MAX_PROFILE_LINES = 40;
/** 单条事实上限：一行超过这个长度就说明它不是「一条事实」，而是罗列。 */
const MAX_LINE_CHARS = 200;
const MAX_PROFILE_CHARS = 2400;

function clip(text: string, limit = MAX_LINE_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * 把增量变更合并进现有档案。
 *
 * 增量比整份重写省 35%~45% 的输出 token，也避免模型每次都把旧事实重编一遍
 * （重编就容易丢时间区间、改错名字）。冲突时以新内容为准，旧行按 match 定位替换。
 */
/**
 * 档案归一：压掉超长行、限制总字数。
 *
 * 模型有时会把一条事实写成上千字的长句（罗列几十个例子），
 * 这种档案既读不进上下文，也看不出重点。这里只做体积约束，不改语义。
 */
export function normalizeProfile(text: string, fallbackName = '成员'): string {
  const lines = text.trimEnd().split('\n');
  const header = lines[0]?.startsWith('# ') ? lines[0] : `# ${fallbackName}`;
  const body = lines
    .slice(header === lines[0] ? 1 : 0)
    .filter((line) => line.trim() !== '')
    .map((line) => clip(line));
  let kept = body.slice(-MAX_PROFILE_LINES);
  while (kept.join('\n').length > MAX_PROFILE_CHARS && kept.length > 1) {
    kept = kept.slice(1);
  }
  return [header, ...kept].join('\n');
}

export function applyProfileChanges(existing: string, name: string, changes: ProfileChange[]): string {
  const lines = existing.trim() ? existing.trimEnd().split('\n') : [`# ${name}`];
  const body = lines.slice(1);

  // 去掉列表符号和标点后比较前 12 个字：同类事实只留一条，别越堆越长
  const key = (s: string): string =>
    s.replace(/^[-*\s]+/, '').replace(/[（(].*?[）)]/g, '').replace(/[\s，。、；：]/g, '').slice(0, 12);

  for (const change of changes) {
    const text = (change.text ?? '').trim();
    const match = (change.match ?? '').trim();
    if (change.op === 'add') {
      if (!text) {
        continue;
      }
      const line = clip(text.startsWith('-') ? text : `- ${text}`);
      // 同类条目已存在就并进去（保留新的），否则追加
      const index = body.findIndex((item) => key(item) === key(line) && key(line) !== '');
      if (index >= 0) {
        body[index] = line;
      } else {
        body.push(line);
      }
      continue;
    }
    if (!match) {
      continue;
    }
    const index = body.findIndex((item) => item.includes(match));
    if (index === -1) {
      continue;
    }
    if (change.op === 'remove') {
      body.splice(index, 1);
    } else if (text) {
      body[index] = clip(text.startsWith('-') ? text : `- ${text}`);
    }
  }

  // 超长行压一压：历史档案里有模型写成上千字的长句
  const normalized = body.filter((line) => line.trim() !== '').map((line) => clip(line));
  let kept = normalized.slice(-MAX_PROFILE_LINES);
  // 总字数兜底：从最早的条目开始丢，保证档案还能被读进上下文
  while (kept.join('\n').length > MAX_PROFILE_CHARS && kept.length > 1) {
    kept = kept.slice(1);
  }
  return [lines[0] ?? `# ${name}`, ...kept].join('\n');
}

/** 文件末尾对齐到最后一行的偏移（append 写的是整行，正常就等于文件大小）。 */
async function endOffset(file: string): Promise<number> {
  const info = await stat(file);
  if (info.size === 0) {
    return 0;
  }
  const fh = await open(file, 'r');
  try {
    const tail = Buffer.allocUnsafe(1);
    await fh.read(tail, 0, 1, info.size - 1);
    if (tail[0] === 0x0a) {
      return info.size;
    }
    // 最后一行还没写完：退到它之前，留给下次
    const back = Buffer.allocUnsafe(Math.min(4096, info.size));
    const { bytesRead } = await fh.read(back, 0, back.length, info.size - back.length);
    const nl = back.subarray(0, bytesRead).lastIndexOf(0x0a);
    return nl >= 0 ? info.size - bytesRead + nl + 1 : 0;
  } finally {
    await fh.close();
  }
}

/** 从 chat-log 的 JSONL 里读增量记录（按 messageId 去重，取 watermark 之后的部分）。 */
export async function readNewRecords(
  chatRoot: string,
  groupOpenid: string,
  afterMessageId?: string,
): Promise<RawRecord[]> {
  const file = path.join(chatRoot, 'chats', 'group', groupOpenid, 'messages.jsonl');
  if (!existsSync(file)) {
    return [];
  }
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  const records: RawRecord[] = [];
  let seenWatermark = !afterMessageId;
  for (const line of lines) {
    let rec: RawRecord;
    try {
      rec = JSON.parse(line) as RawRecord;
    } catch {
      continue;
    }
    if (!seenWatermark) {
      if (rec.messageId === afterMessageId) {
        seenWatermark = true;
      }
      continue;
    }
    if (rec.senderIsBot) {
      continue;
    }
    if (!rec.content?.trim()) {
      continue;
    }
    records.push(rec);
  }
  return records;
}

/** 一次增量读的结果。 */
export interface TailRead {
  records: RawRecord[];
  /** 这次读完的最后一个完整行之后的字节偏移；下次从这里接着读。 */
  offset: number;
}

/** 单次最多往回读多少字节（防止水位丢了之后一次读爆内存）。 */
const MAX_TAIL_BYTES = 64 * 1024 * 1024;

/**
 * 按字节偏移增量读 chat-log。
 *
 * 旧实现每次 readFile 整个 messages.jsonl 再逐行 JSON.parse（一个群一天长 1.7MB，
 * 而巡检每 10 分钟、归纳每 30 分钟、每次归档前后都各读一遍），白白烧 CPU 和 GC。
 * 这里改成只读上次之后的字节，而且只解析到最后一个换行符 —— 半行留给下次。
 */
export async function readNewRecordsFrom(
  chatRoot: string,
  groupOpenid: string,
  fromOffset?: number,
  /**
   * 老状态兼容：state.json 里只有 messageId、还没写 lastOffset 时，
   * 走一次旧的全量扫描拿到准确的未读集合，顺便把 offset 补齐。
   */
  fallbackAfterMessageId?: string,
): Promise<TailRead> {
  const file = path.join(chatRoot, 'chats', 'group', groupOpenid, 'messages.jsonl');
  if (!existsSync(file)) {
    return { records: [], offset: 0 };
  }
  if (fromOffset === undefined && fallbackAfterMessageId !== undefined) {
    const records = await readNewRecords(chatRoot, groupOpenid, fallbackAfterMessageId);
    return { records, offset: await endOffset(file) };
  }
  const info = await stat(file);
  // 文件被截断/换掉（偏移超出大小）就从头读
  let start = fromOffset !== undefined && fromOffset > 0 && fromOffset <= info.size ? fromOffset : 0;
  if (info.size - start > MAX_TAIL_BYTES) {
    start = info.size - MAX_TAIL_BYTES;
    // 从中间开始读会切出半行，丢第一行就行
  }
  if (info.size === start) {
    return { records: [], offset: start };
  }

  const fh = await open(file, 'r');
  try {
    const length = info.size - start;
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    const chunk = buf.subarray(0, bytesRead);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      // 连一个完整行都没有：等下次
      return { records: [], offset: start };
    }
    const text = chunk.subarray(0, lastNewline).toString('utf8');
    const offset = start + lastNewline + 1;
    const records: RawRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line) {
        continue;
      }
      let rec: RawRecord;
      try {
        rec = JSON.parse(line) as RawRecord;
      } catch {
        // 从中间截断时第一行可能是半截，跳过
        continue;
      }
      if (rec.senderIsBot) {
        continue;
      }
      if (!rec.content?.trim()) {
        continue;
      }
      records.push(rec);
    }
    return { records, offset };
  } finally {
    await fh.close();
  }
}
