/**
 * 上下文压缩：链太长时用摘要替换旧对话，而不是整条丢掉。
 *
 * 参考 Codex（`core/src/compact.rs` + `prompts/templates/compact/`）：
 *   - 按 token 水位触发，不看轮数；
 *   - 压缩 = 摘要 + 保留最近的真实用户消息与最近工具输出，插在最后一条用户消息之前；
 *   - 摘要带固定前缀，下次能认出来，不会把摘要再摘一遍。
 *
 * Kei 原来的减重靠换链（`thread.ts`）：换链等于把之前的决策全丢。这里补的是「链内减重」，
 * 换链退化成最后手段。
 */

import { readFileSync } from 'node:fs';
import type { ChatMessage } from './llm.js';
import { readPrompt } from './prompts.js';

/** 摘要固定前缀：认得出这是压缩产物，不再当原始对话摘一遍。 */
export const SUMMARY_PREFIX =
  'Another language model started to solve this problem and produced a summary of its work. ' +
  'You also have access to the state of the tools it used. Build on that work instead of repeating it.';

const HERE = new URL('../../prompts/', import.meta.url);

/** 压缩提示词放仓库 prompts/ 下（和 personas/ 一个待遇）：口径要能单独改，不埋在代码字符串中。 */
export function compactionPrompt(): string {
  return readPrompt(
    'compaction',
    'Create a handoff summary for another LLM that will resume this task: progress, decisions, constraints, what remains.',
  );
}

export interface CompactOptions {
  /** 上下文窗口（token）。 */
  contextWindow: number;
  /** 绝对水位（token）：配了就优先于百分比。 */
  maxTokens?: number;
  /** 触发水位（0–1），默认 0.75：留出摘要本身与后续回合的空间。 */
  threshold?: number;
  /** 保留几条最近的真实用户消息。 */
  keepUserMessages?: number;
  /** 保留几条最近的工具输出（`keepRecentMessages=0` 时才按它数）。 */
  keepToolOutputs?: number;
  /**
   * 保留最近几条消息的尾巴（含 assistant 与其工具结果，默认 8）。
   *
   * 只留 3 条工具输出的话，压完当场就丢掉了「刚刚在改哪个文件」—— 模型只能重新摸一遍仓库，
   * 白白再烧几轮。Codex 的压缩也是留一段最近的真实上下文，不是只留工具结果。
   */
  keepRecentMessages?: number;
}

export function compactThreshold(options: CompactOptions): number {
  if (options.maxTokens && options.maxTokens > 0) {
    return options.maxTokens;
  }
  const percent = options.threshold ?? 0.75;
  return Math.max(2_000, Math.floor(options.contextWindow * percent));
}

/** 要不要压缩：只按 token 水位判，轮数交给换链那套。 */
export function shouldCompact(tokens: number, options: CompactOptions): boolean {
  return tokens >= compactThreshold(options);
}

function isSummary(message: ChatMessage): boolean {
  return message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(SUMMARY_PREFIX);
}

/**
 * 找出「没有对应 assistant tool_calls」的工具消息。
 *
 * 这类消息发给上游就是 400：tool 角色的消息必须紧跟在发起调用的那条 assistant 后面。
 * 切片式保留（只留最近几条工具输出）很容易造出孤儿，所以压缩前必须验一遍。
 */
export function orphanToolMessages(convo: ChatMessage[]): string[] {
  const seen = new Set<string>();
  const orphans: string[] = [];
  for (const message of convo) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        seen.add(call.id);
      }
      continue;
    }
    if (message.role === 'tool' && (!message.tool_call_id || !seen.has(message.tool_call_id))) {
      orphans.push(message.tool_call_id ?? '(无 id)');
    }
  }
  return orphans;
}

/**
 * 尾巴的起点：不能落在工具结果中间。
 *
 * 从末尾往前留 N 条时，第 N 条可能正好是 tool 消息 —— 它爹（带 tool_calls 的 assistant）
 * 被截在外面就是孤儿。往前推到第一条不是 tool 的位置，顺带把那几条无主结果丢掉。
 */
function tailStartIndex(rest: ChatMessage[], keepRecent: number): number {
  let start = Math.max(0, rest.length - keepRecent);
  while (start < rest.length && rest[start]?.role === 'tool') {
    start += 1;
  }
  return start;
}

/**
 * 把旧对话换成交接摘要。
 *
 * 结构：[system] + [摘要（带前缀）] + [保留的最近用户消息] + [保留的最近工具输出] + [最新一条用户消息]
 * —— 摘要插在最后一条真实用户消息之前（Codex 的位置），这样模型看到的「当前请求」永远是真的那条。
 */
export function buildCompactedHistory(
  convo: ChatMessage[],
  summary: string,
  options: CompactOptions = { contextWindow: 100_000 },
): ChatMessage[] {
  const keepUsers = options.keepUserMessages ?? 2;
  const keepTools = options.keepToolOutputs ?? 3;
  const keepRecent = options.keepRecentMessages ?? 8;
  const system = convo[0]?.role === 'system' ? convo[0] : undefined;
  const rest = system ? convo.slice(1) : convo;

  const users = rest.filter((message) => message.role === 'user' && !isSummary(message));
  const latest = users[users.length - 1];
  const keptUsers = users.slice(-(keepUsers + 1), -1);

  const kept = new Set<ChatMessage>(keptUsers);
  if (keepRecent > 0) {
    for (const message of rest.slice(tailStartIndex(rest, keepRecent))) {
      kept.add(message);
    }
  } else {
    for (const message of rest.filter((item) => item.role === 'tool').slice(-keepTools)) {
      kept.add(message);
    }
    if (latest) {
      kept.add(latest);
    }
  }

  // 按原顺序输出，顺便去重（最近用户消息可能已经在尾巴里）
  const ordered = rest.filter((message) => kept.has(message));
  const summaryMessage: ChatMessage = {
    role: 'user',
    content: `${SUMMARY_PREFIX}\n\n${summary.trim()}`,
  };
  return [...(system ? [system] : []), summaryMessage, ...ordered];
}

/** 压缩用的输入：把旧对话压成一段可读文本（工具输出截断，避免摘要本身超长）。 */
export function renderForSummary(convo: ChatMessage[], limitChars = 40_000): string {
  const lines: string[] = [];
  for (const message of convo) {
    if (message.role === 'system') {
      continue;
    }
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : '[图片]')).join(' ');
    const text = content.length > 2_000 ? `${content.slice(0, 2_000)}…` : content;
    lines.push(`### ${message.role}\n${text}`);
  }
  const joined = lines.join('\n\n');
  return joined.length > limitChars ? `${joined.slice(0, limitChars)}\n\n…（更早的内容已省略）` : joined;
}
