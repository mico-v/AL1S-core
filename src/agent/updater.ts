/**
 * 成员档案自动归纳。
 *
 * 读 chat-log 里还没处理过的群消息 → 让模型归纳进每个人的档案 → 落盘。
 * 由定时器或 `pnpm agent:learn` 触发，不参与实时回复，所以慢一点没关系。
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { AppLogger } from '../logger.js';
import { chatComplete, type LlmOptions } from './llm.js';
import { GroupMemory, readNewRecords, type RawRecord } from './memory.js';

const MIN_RECORDS = 6;
// 一次喂太多（120 条 × 1200 字）会让归纳请求超过 90s 超时，
// 超时后还会重试，白烧 4 分钟。60 条足够覆盖一天。
const MAX_RECORDS_PER_RUN = 60;
const MAX_CONTENT_CHARS = 1200;
/**
 * 一轮最多更新多少人的档案。
 *
 * 之前把全群档案都塞进提示词、让模型整体重写，输出很容易超过 max_tokens
 * 被截断 —— JSON 尾巴一断，整批档案都写不进去。现在只处理这批里真正说过话的人。
 */
const MAX_MEMBERS_PER_RUN = 20;

export interface UpdaterConfig {
  dataRoot: string;
  llm: LlmOptions;
  /** 每个群每轮最多处理多少条。 */
  batchSize?: number;
}

interface ParsedProfile {
  openid: string;
  name: string;
  markdown: string;
}

/**
 * 归纳提示词。
 *
 * 关键变化：事实带时间区间，新事实不覆盖旧事实 —— 只给旧条目补结束日期。
 * 覆盖写会丢掉「什么时候变的」，而群聊里"他之前说在准备比赛，现在说考研了"
 * 这种时间线恰恰是最有用的信息。
 */
export function learnSystem(today = new Date().toISOString().slice(0, 10)): string {
  return `你在维护一个 QQ 群聊机器人的长期记忆。今天是 ${today}。

给你一批群聊消息，请判断哪些人在这一批里暴露了**稳定的特征**，并更新他们的档案。

规则：
- 只写有证据的；推测必须标「（推测）」。
- 性格要具体（「爱起哄但别人认真时会收敛」），不要「友好」「活跃」这种空话。
- 口癖、说话长短、常用表情、作息、常聊话题、人际关系，都是有用的信息。
- **绝不写**：真实姓名、电话、住址、学校班级学号、身份证、密码、医疗、财务、感情隐私细节。
- **会变的事要带时间区间**，写在括号里：
  · 现在仍然成立：\`（2026-09-12 ~ ）\`
  · 已经结束或被取代：\`（2026-05-01 ~ 2026-08-30）\`
  例：\`- 近况: 在准备 CSP（2026-09-12 ~ 2026-10-20） / 改准备考研（2026-10-20 ~ ）\`
- 稳定不变的特征（口癖、性格底色、惯用表情）不用标时间。
- 事实发生变化时**不要删旧条目**：给旧的补上结束日期，再加一条新的。允许同一类留 2~3 条历史。
- 不要写「本批」「这批消息」这种视角说明，直接写事实；也不要写「第 N 条」。
- 档案该写多少写多少，不要为了篇幅删信息；开头必须是「# 昵称」。

只输出 JSON，不要任何解释：
{"profiles":[{"openid":"...","name":"昵称","markdown":"# 昵称\\n- 性格: ..."}]}
如果这批消息没有值得记的内容，输出 {"profiles":[]}`;
}

const SYSTEM = learnSystem();

/** 从可能带 markdown 围栏或前后废话的回复里抠出 JSON。 */
function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced?.[1] ?? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (!candidate) {
    return undefined;
  }
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

interface ParsedResult {
  profiles: ParsedProfile[];
  /** 模型是否给出了合法 JSON —— 用来区分「确实没什么可记」和「输出坏了」 */
  valid: boolean;
}

function parseProfiles(raw: string): ParsedResult {
  const data = extractJson(raw) as { profiles?: unknown } | undefined;
  if (!data || !Array.isArray(data.profiles)) {
    return { profiles: [], valid: false };
  }
  const out: ParsedProfile[] = [];
  for (const item of data.profiles) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const openid = typeof rec.openid === 'string' ? rec.openid.trim() : '';
    const markdown = typeof rec.markdown === 'string' ? rec.markdown.trim() : '';
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : openid.slice(0, 8);
    if (!openid || !markdown) {
      continue;
    }
    out.push({ openid, name, markdown });
  }
  return { profiles: out, valid: true };
}

function renderRecords(records: RawRecord[]): string {
  return records
    .map((r) => {
      const who = r.senderName ?? r.senderId.slice(0, 8);
      const text = r.content.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_CHARS);
      return `[${r.senderId}] ${who}: ${text}`;
    })
    .join('\n');
}

/** 处理一个群。返回本轮是否写入了档案。 */
export async function learnGroup(
  config: UpdaterConfig,
  groupOpenid: string,
  log: AppLogger,
): Promise<{ processed: number; written: number }> {
  const memory = new GroupMemory(config.dataRoot, groupOpenid);
  const state = await memory.readState();
  const batch = config.batchSize ?? MAX_RECORDS_PER_RUN;
  const records = (await readNewRecords(config.dataRoot, groupOpenid, state.lastMessageId)).slice(-batch);

  if (records.length < MIN_RECORDS) {
    log.debug('记录太少，跳过归纳', { groupOpenid, count: records.length });
    return { processed: records.length, written: 0 };
  }

  // 只挑这批里说话最多的几个人：既省 token，也避免输出被截断
  const counts = new Map<string, { name: string; n: number }>();
  for (const r of records) {
    if (r.senderIsBot) {
      continue;
    }
    const name = r.senderName ?? r.senderId.slice(0, 8);
    const prev = counts.get(r.senderId);
    counts.set(r.senderId, { name: prev?.name ?? name, n: (prev?.n ?? 0) + 1 });
  }
  const active = [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, MAX_MEMBERS_PER_RUN);

  if (active.length === 0) {
    log.debug('这批没有真人发言，跳过归纳', { groupOpenid });
    return { processed: records.length, written: 0 };
  }

  const allMembers = await memory.listMembers();
  const memberMap = new Map(allMembers.map((m) => [m.openid, m]));

  /**
   * 跑一次归纳。人数越多输出越长，越容易顶到 max_tokens 被截断，
   * 所以失败就对半砍人数重试 —— 宁可这轮少更新几个人，也别整批丢掉。
   */
  const attempt = async (members: Array<[string, { name: string; n: number }]>) => {
    const scopeLine = members.map(([openid, info]) => `- ${info.name} (${openid}) ${info.n} 条`).join('\n');
    const existingBlock = members
      .map(([openid]) => memberMap.get(openid))
      .filter((m): m is NonNullable<typeof m> => Boolean(m))
      .map((m) => `### ${m.name} (${m.openid})\n${m.profile}`)
      .join('\n\n')
      .slice(0, 20_000) || '（这些人还没有档案）';

    const raw = await chatComplete(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `## 本轮只更新这些人（其他人不要动）\n${scopeLine}\n\n## 他们现有的档案\n\n${existingBlock}\n\n## 新消息\n\n${renderRecords(records)}`,
        },
      ],
      {
        ...config.llm,
        // 不设卡：输出多少由模型决定（实测接口 200k 也收）。
        // 下面的砍半重试只是兜底，正常情况下不会触发。
        maxTokens: 64_000,
        temperature: 0.3,
        // 结构化输出不需要推理；开着会把预算烧光，返回空内容
        disableThinking: true,
        // 归纳是一次性长调用：给足 3 分钟；不重试 —— 重试只会把 90s 变成 270s
        timeoutMs: 180_000,
        purpose: 'learn',
        conversationId: groupOpenid,
      },
      0,
    );
    return parseProfiles(raw);
  };

  let members = active;
  let result = await attempt(members);
  let rounds = 1;
  while (!result.valid && members.length > 1 && rounds < 3) {
    members = members.slice(0, Math.ceil(members.length / 2));
    log.warn('归纳输出被截断，砍半人数重试', { groupOpenid, members: members.length, rounds });
    result = await attempt(members);
    rounds += 1;
  }

  const { profiles, valid } = result;
  for (const profile of profiles) {
    await memory.saveMember(profile.openid, profile.name, profile.markdown);
  }

  // 输出坏了（多半被截断）就别推进水位线，否则这批消息永远学不到
  if (!valid) {
    log.warn('归纳结果不合法，保留水位线下次重试', {
      groupOpenid,
      members: members.length,
      rounds,
    });
    return { processed: records.length, written: profiles.length };
  }

  const last = records[records.length - 1];
  await memory.writeState({
    lastMessageId: last?.messageId,
    lastMessageAt: new Date().toISOString(),
  });

  log.info('归纳完成', { groupOpenid, records: records.length, written: profiles.length });
  return { processed: records.length, written: profiles.length };
}

/** 遍历 dataRoot 下所有群，各归纳一轮。定时任务用。 */
export async function learnAllGroups(
  config: UpdaterConfig,
  log: AppLogger,
): Promise<{ groups: number; written: number }> {
  const dir = path.join(config.dataRoot, 'chats', 'group');
  if (!existsSync(dir)) {
    return { groups: 0, written: 0 };
  }
  let groups = 0;
  let written = 0;
  for (const name of await readdir(dir)) {
    if (name.startsWith('.')) {
      continue;
    }
    groups += 1;
    try {
      const result = await learnGroup(config, name, log);
      written += result.written;
    } catch (error) {
      log.warn('归纳失败', { groupOpenid: name, error });
    }
  }
  return { groups, written };
}
