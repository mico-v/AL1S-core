/**
 * 主动参与：判断「这轮群聊是不是卡住了」，只在真有必要时开口。
 *
 * 依据 ProACT (arXiv 2607.03730) 的 breakdown-aware 思路：不是看到关键词就插嘴，
 * 而是先判断有没有「协作断裂」——有人提问没人接、明显矛盾、讨论原地打转、
 * 有人求助、气氛僵住——有才考虑说，且必须先给出理由。
 *
 * 输出是一次结构化判断（JSON），不给理由就不许说话，避免它自嗨。
 */

import type { AppLogger } from '../logger.js';
import type { BufferedLine } from './context.js';
import type { ChatMessage, LlmOptions } from './llm.js';

export interface CompleteFn {
  (messages: ChatMessage[], opts: LlmOptions, retries?: number): Promise<string>;
}

export interface ProactiveWindow {
  groupId: string;
  lines: BufferedLine[];
  /** 这个群最近归档的摘要（有就给，帮它判断上下文） */
  digest?: string;
}

export interface ProactiveDecision {
  speak: boolean;
  reason: string;
  text?: string;
}

/** 一次最多看多少条。太多会让判断变糊，太少看不出「卡住」。 */
export const PROACTIVE_WINDOW = 24;

/** 群聊记录里的断裂信号。写进提示词，模型按这些判，不自由发挥。 */
export const BREAKDOWN_RULES = `判断标准（出现任意一条才算「断裂」）：
1. 有人提了明确问题，过了好几条没人回答；
2. 有人说要做什么/约什么，没人回应，事情悬着；
3. 两个人明显在说岔了（各说各的，或者理解错了对方）；
4. 讨论在同一句话上反复打转，没有推进；
5. 有人求助/明显受挫，群里没人接；
6. 气氛僵住（冷场、尴尬、有人被忽略）。

不算断裂（不许插话）：
- 聊得正热闹、话题在推进；
- 只是有人发了句玩笑、表情、复读；
- 只是你插得上话、或者你想说点什么。`;

export const PROACTIVE_INSTRUCTION = `你要判断：现在该不该在群里说一句。

${BREAKDOWN_RULES}

如果该说：
- 一句话解决问题，或者把话题往前推一点，最多两句；
- 像群里的一员，不当主持人、不当裁判、不复述别人说的；
- 不要「我注意到」「大家是不是」「需要我帮忙吗」这种客服腔。

只输出 JSON，不要别的：
{"speak": true/false, "reason": "一句话说明为什么（不说话也写原因）", "text": "要说的话，不说话留空"}`;

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function buildProactiveMessages(window: ProactiveWindow): ChatMessage[] {
  const lines = window.lines.slice(-PROACTIVE_WINDOW);
  const transcript = lines
    .map((l) => {
      const arrow = l.toBot ? ' → Kei' : l.to ? ` → ${l.to}` : '';
      return `[${hhmm(l.timestamp)}] ${l.senderName}${arrow}: ${l.text.replace(/\s+/g, ' ').trim()}`;
    })
    .join('\n');

  const parts = [PROACTIVE_INSTRUCTION];
  if (window.digest) {
    parts.push(`## 这个群最近的背景\n\n${window.digest.slice(0, 600)}`);
  }

  return [
    { role: 'system', content: parts.join('\n\n---\n\n') },
    { role: 'user', content: `## 刚才的群聊\n\n${transcript}\n\n现在该说话吗？` },
  ];
}

/** 从模型输出里抠出 JSON（可能裹在 ```json 或说明文字里）。 */
export function parseProactive(raw: string): ProactiveDecision {
  const text = raw.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { speak: false, reason: '未给出可解析的判断' };
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      speak?: unknown;
      reason?: unknown;
      text?: unknown;
    };
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    const speak = parsed.speak === true;
    const message = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    if (!speak || message === '') {
      return { speak: false, reason: reason || '判断为不需要插话' };
    }
    return { speak: true, reason: reason || '需要接一下', text: message.slice(0, 300) };
  } catch {
    return { speak: false, reason: '判断结果不是合法 JSON' };
  }
}

/** 跑一次判断。失败一律当作「不说话」——宁可漏说，不能乱说。 */
export async function judgeProactive(
  window: ProactiveWindow,
  opts: { complete: CompleteFn; llm: LlmOptions; log: AppLogger },
): Promise<ProactiveDecision> {
  if (window.lines.length < 4) {
    return { speak: false, reason: '发言太少，看不出是否卡住' };
  }
  try {
    const raw = await opts.complete(buildProactiveMessages(window), {
      ...opts.llm,
      temperature: 0.3,
      maxTokens: 400,
      disableThinking: true,
      purpose: 'proactive',
      conversationId: window.groupId,
      speaker: 'judge',
    });
    return parseProactive(raw);
  } catch (error) {
    opts.log.warn('主动判断失败', { groupId: window.groupId, error });
    return { speak: false, reason: '判断调用失败' };
  }
}
