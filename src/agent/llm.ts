/**
 * OpenAI 兼容的 chat completions 客户端。
 *
 * 只做一件事：把 messages 发出去，拿回文本。
 * 不引入 SDK，避免为了一个 POST 拉一堆依赖。
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildRecord, recordCall } from './telemetry.js';

/** opencode-go 要求带上会话标识，否则拒收请求（MissingSessionID）。 */
const PROCESS_SESSION_ID = randomUUID();

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface LlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** opencode-go 的会话标识；不传则用进程级 UUID。 */
  sessionId?: string;
  /**
   * 关掉推理（deepseek-v4.1-flash 是推理模型）。
   * 闲聊不需要长思考，而且推理会吃掉 max_tokens 导致正文为空。
   */
  disableThinking?: boolean;
  /** 用途标签，进调用记录：chat / caption / learn … */
  purpose?: string;
  conversationId?: string;
  speaker?: string;
  /** 模型上下文窗口，用来算占用率。 */
  contextWindow?: number;
}

export interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export class LlmError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

/** 调一次 chat completions，返回纯文本。失败按退避重试。 */
export async function chatComplete(
  messages: ChatMessage[],
  opts: LlmOptions,
  retries = 2,
): Promise<string> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const maxTokens = opts.maxTokens ?? 500;
  const temperature = opts.temperature ?? 0.9;
  const body = JSON.stringify({
    model: opts.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
    ...(opts.disableThinking ? { thinking: { type: 'disabled' } } : {}),
  });

  const startedAt = Date.now();
  const stack = new Error().stack;
  const shape = {
    messages: messages.length,
    promptChars: messages.reduce((acc, m) => {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return acc + text.length;
    }, 0),
    images: messages.reduce((acc, m) => {
      if (!Array.isArray(m.content)) {
        return acc;
      }
      return acc + m.content.filter((part) => part.type === 'image_url').length;
    }, 0),
    maxTokens,
    temperature,
  };

  let lastError: unknown;
  let attemptsUsed = 0;

  const recordFailure = async (error: unknown): Promise<void> => {
    const err = error instanceof Error ? error : new LlmError(String(error));
    await recordCall(
      buildRecord({
        purpose: opts.purpose ?? 'chat',
        model: opts.model,
        attempt: attemptsUsed,
        ok: false,
        status: err instanceof LlmError ? err.status : undefined,
        error: err.message.slice(0, 300),
        ms: Date.now() - startedAt,
        ...shape,
        conversationId: opts.conversationId,
        speaker: opts.speaker,
        stack,
        contextWindow: opts.contextWindow,
      }),
    );
  };

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    attemptsUsed = attempt;
    if (attempt > 0) {
      await sleep(400 * 2 ** (attempt - 1));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.apiKey}`,
          'x-opencode-session': opts.sessionId ?? PROCESS_SESSION_ID,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 4xx 除了 429 之外重试没有意义
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new LlmError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
        }
        lastError = new LlmError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
        continue;
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: UsageLike;
      };
      const choice = data.choices?.[0];
      const text = choice?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        // 推理模型可能把预算全烧在 reasoning 上，content 就是空的
        lastError = new LlmError(`空回复（finish_reason=${choice?.finish_reason ?? '未知'}）`);
        continue;
      }
      await recordCall(
        buildRecord({
          purpose: opts.purpose ?? 'chat',
          model: opts.model,
          attempt,
          ok: true,
          ms: Date.now() - startedAt,
          usage: data.usage,
          ...shape,
          conversationId: opts.conversationId,
          speaker: opts.speaker,
          stack,
          contextWindow: opts.contextWindow,
        }),
      );
      return text.trim();
    } catch (error) {
      if (error instanceof LlmError && error.status && error.status < 500) {
        await recordFailure(error);
        throw error;
      }
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  await recordFailure(lastError);
  throw lastError instanceof Error ? lastError : new LlmError(String(lastError));
}
