/**
 * OpenAI 兼容的 chat completions 客户端。
 *
 * 只做一件事：把 messages 发出去，拿回文本。
 * 不引入 SDK，避免为了一个 POST 拉一堆依赖。
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

/** opencode-go 要求带上会话标识，否则拒收请求（MissingSessionID）。 */
const PROCESS_SESSION_ID = randomUUID();

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
  const body = JSON.stringify({
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0.9,
    max_tokens: opts.maxTokens ?? 500,
    stream: false,
  });

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
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
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        lastError = new LlmError('空回复');
        continue;
      }
      return text.trim();
    } catch (error) {
      if (error instanceof LlmError && error.status && error.status < 500) {
        throw error;
      }
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new LlmError(String(lastError));
}
