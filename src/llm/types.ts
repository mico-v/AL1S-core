/**
 * LLM 层共享类型：消息 / 流式事件 / 工具 schema，以及 token 估算工具。
 * 所有 provider 实现遵循 LLMProvider 契约：事件永不 throw，错误编码为 done(error)。
 */

/** 消息角色 */
export type LLMRole = 'system' | 'user' | 'assistant' | 'tool';

/** 一次工具调用（arguments 为 JSON 字符串，由调用方解析） */
export interface LLMToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** LLM 消息 */
export interface LLMMessage {
  role: LLMRole;
  content: string | null;
  toolCalls?: LLMToolCall[]; // 仅 role === 'assistant'
  toolCallId?: string; // 仅 role === 'tool'
  name?: string; // 仅 role === 'tool'，工具名
}

/** 工具声明（OpenAI function 格式的子集） */
export interface LLMToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 流式事件：文本增量 / 完整工具调用 / 结束 */
export type LLMStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; call: LLMToolCall }
  | { type: 'done'; message: LLMMessage; error?: string };

/** 一次流式对话的参数 */
export interface LLMChatOptions {
  messages: LLMMessage[];
  tools?: LLMToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** LLM Provider 契约：流式对话，永不 throw */
export interface LLMProvider {
  streamChat(options: LLMChatOptions): AsyncIterable<LLMStreamEvent>;
}

/** 粗略估算一段文本的 token 数（chars/4 取整，pi 的做法，不引入分词器） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 估算一批消息的总 token（逐条估算，供 session 窗口选择使用） */
export function countMessagesTokens(msgs: LLMMessage[]): number {
  let total = 0;
  for (const msg of msgs) {
    total += estimateTokens(msg.content ?? '');
    if (msg.toolCalls) {
      for (const call of msg.toolCalls) {
        total += estimateTokens(call.name);
        total += estimateTokens(call.arguments);
      }
    }
    if (msg.toolCallId) total += estimateTokens(msg.toolCallId);
  }
  return total;
}
