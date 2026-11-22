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

/** 摘要固定前缀：认得出这是压缩产物，不再当原始对话摘一遍。 */
export const SUMMARY_PREFIX =
  'Another language model started to solve this problem and produced a summary of its work. ' +
  'You also have access to the state of the tools it used. Build on that work instead of repeating it.';

const HERE = new URL('../../prompts/', import.meta.url);

/** 压缩提示词放仓库 prompts/ 下（和 personas/ 一个待遇）：口径要能单独改，不埋在代码字符串中。 */
export function compactionPrompt(): string {
  try {
    return readFileSync(new URL('compaction.md', HERE), 'utf8').trim();
  } catch {
    return 'Create a handoff summary for another LLM that will resume this task: progress, decisions, constraints, what remains.';
  }
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
  /** 保留几条最近的工具输出。 */
  keepToolOutputs?: number;
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
  const system = convo[0]?.role === 'system' ? convo[0] : undefined;
  const rest = system ? convo.slice(1) : convo;

  const users = rest.filter((message) => message.role === 'user' && !isSummary(message));
  const tools = rest.filter((message) => message.role === 'tool');
  const latest = users[users.length - 1];
  const keptUsers = users.slice(-(keepUsers + 1), -1);
  const keptTools = tools.slice(-keepTools);

  const summaryMessage: ChatMessage = {
    role: 'user',
    content: `${SUMMARY_PREFIX}\n\n${summary.trim()}`,
  };
  const kept = [...keptUsers, ...keptTools, ...(latest ? [latest] : [])];
  return [...(system ? [system] : []), summaryMessage, ...kept];
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
