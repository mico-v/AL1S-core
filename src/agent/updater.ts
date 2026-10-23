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
const MAX_RECORDS_PER_RUN = 120;
const MAX_CONTENT_CHARS = 1200;

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

const SYSTEM = `你在维护一个 QQ 群聊机器人的长期记忆。

给你一批群聊消息，请判断哪些人在这一批里暴露了**稳定的特征**，并更新他们的档案。

规则：
- 只写有证据的；推测必须标「（推测）」。
- 性格要具体（「爱起哄但别人认真时会收敛」），不要「友好」「活跃」这种空话。
- 口癖、说话长短、常用表情、作息、常聊话题、人际关系，都是有用的信息。
- **绝不写**：真实姓名、电话、住址、学校班级学号、身份证、密码、医疗、财务、感情隐私细节。
- 档案是「覆盖写」：把旧档案合并进去，保留仍然成立的内容，补充新发现，过时的就删掉。
- 每人档案控制在 25 行以内。开头必须是「# 昵称」。

只输出 JSON，不要任何解释：
{"profiles":[{"openid":"...","name":"昵称","markdown":"# 昵称\\n- 性格: ..."}]}
如果这批消息没有值得记的内容，输出 {"profiles":[]}`;

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

function parseProfiles(raw: string): ParsedProfile[] {
  const data = extractJson(raw) as { profiles?: unknown } | undefined;
  if (!data || !Array.isArray(data.profiles)) {
    return [];
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
  return out;
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

  const existing = await memory.listMembers();
  const existingBlock = existing.length
    ? existing.map((m) => `### ${m.name} (${m.openid})\n${m.profile}`).join('\n\n').slice(0, 12_000)
    : '（还没有任何档案）';

  const messages = [
    { role: 'system' as const, content: SYSTEM },
    {
      role: 'user' as const,
      content: `## 现有档案\n\n${existingBlock}\n\n## 新消息\n\n${renderRecords(records)}`,
    },
  ];

  const raw = await chatComplete(messages, { ...config.llm, maxTokens: 2000, temperature: 0.3 });
  const profiles = parseProfiles(raw);
  for (const profile of profiles) {
    await memory.saveMember(profile.openid, profile.name, profile.markdown);
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
