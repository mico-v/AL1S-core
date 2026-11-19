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

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  /** assistant 发起工具调用时携带 */
  tool_calls?: ToolCall[];
  /** role=tool 时指向对应的调用 */
  tool_call_id?: string;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
}

/**
 * DeepSeek 系模型的 DSML 标记：服务端没把工具调用解析成 `tool_calls` 时，
 * 原生文本格式会原样落在 content 里（`<｜DSML｜ invoke name="run_command">…`）。
 * 实测 opencode-go 上的 deepseek-v4.1-flash 会间歇这样，同一进程里有时正常有时漏。
 * 所以客户端自己兼容一层，不指望上游。
 */
const DSML_MARK = /<[｜|]\s*DSML\s*[｜|]/;
const INVOKE_BLOCK = /<[｜|]\s*DSML\s*[｜|]\s*(?:tool_)?invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/[｜|]\s*DSML\s*[｜|]\s*(?:tool_)?invoke\s*>/g;
const PARAM_BLOCK = /<[｜|]\s*DSML\s*[｜|]\s*(?:tool_)?parameter\s+name\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/[｜|]\s*DSML\s*[｜|]\s*(?:tool_)?parameter\s*>/g;

export interface DsmlParse {
  /** 去掉标记后的正文。 */
  content: string;
  /** 解析出来的调用；解析不出来就是空数组。 */
  toolCalls: ToolCall[];
  /** 正文里有没有 DSML 标记（不管解没解析出来）。 */
  found: boolean;
}

/**
 * 把 DSML 文本还原成标准 tool_calls。
 *
 * 标记长这样（`｜` 是全角竖线，也容忍半角）：
 *   <｜DSML｜ calls><｜DSML｜ invoke name="run_command">
 *   <｜DSML｜ parameter name="cmd" string="true">ls</｜DSML｜ parameter>
 *   </｜DSML｜ invoke></｜DSML｜ calls>
 * 写错格式不抛错：把标记剔掉、当成纯文本回复，不能让用户看到这堆东西。
 */
export function extractDsmlCalls(text: string): DsmlParse {
  if (!DSML_MARK.test(text)) {
    return { content: text, toolCalls: [], found: false };
  }
  const toolCalls: ToolCall[] = [];
  for (const match of text.matchAll(INVOKE_BLOCK)) {
    const name = (match[1] ?? '').trim();
    const body = match[2] ?? '';
    const args: Record<string, unknown> = {};
    for (const param of body.matchAll(PARAM_BLOCK)) {
      const key = (param[1] ?? '').trim();
      if (!key) {
        continue;
      }
      const meta = param[2] ?? '';
      const raw = (param[3] ?? '').trim();
      if (/string\s*=\s*["']?false/.test(meta)) {
        try {
          args[key] = JSON.parse(raw);
          continue;
        } catch {
          // 不是合法 JSON 就按字符串收，别丢参数
        }
      }
      args[key] = raw;
    }
    if (name) {
      toolCalls.push({
        id: `dsml_${toolCalls.length + 1}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      });
    }
  }
  const content = text
    .replace(/<[｜|]\s*DSML\s*[｜|][\s\S]*?<\/[｜|]\s*DSML\s*[｜|]\s*(?:tool_)?calls\s*>/gi, '')
    .replace(/<\/?[｜|]\s*DSML\s*[｜|][^>]*>/gi, '')
    .trim();
  return { content, toolCalls, found: true };
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
  /** OpenAI 风格的工具定义；给了就允许模型发起调用。 */
  tools?: unknown[];
  toolChoice?: 'auto' | 'none' | 'required';
}

export interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/**
 * 配额熔断。
 *
 * 服务端周配额打满时每次请求都会 429，而 digest / learn 是定时任务，
 * 会每 10 分钟、每 30 分钟重打同一批 —— 一晚能空转上千次请求。
 * 识别到 weekly 配额耗尽就记一个恢复时间点，期间后台任务直接跳过。
 */
let quotaPausedUntil = 0;

export function quotaPausedUntilAt(): number {
  return quotaPausedUntil;
}

export function isQuotaPaused(): boolean {
  return Date.now() < quotaPausedUntil;
}

/** 从错误文本判断配额类型，返回需要暂停到的时刻；不是配额错误返回 0。 */
export function quotaPauseFrom(text: string): number {
  if (!/usage.?limit|quota|GoUsageLimitError/i.test(text)) {
    return 0;
  }
  const now = new Date();
  if (/weekly/i.test(text)) {
    // 周配额按 UTC 自然日重置
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  }
  return Date.now() + 3600_000;
}

/** 只有后台任务会被熔断；chat 仍然放行，让用户拿到真实错误而不是静默。 */
function guardQuota(purpose?: string): void {
  if (purpose === 'chat' || !isQuotaPaused()) {
    return;
  }
  throw new LlmError(
    `配额已暂停（至 ${new Date(quotaPausedUntil).toISOString()}），跳过本次 ${purpose ?? '调用'}`,
    429,
  );
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
export async function chatCompleteRaw(
  messages: ChatMessage[],
  opts: LlmOptions,
  retries = 2,
): Promise<ChatResponse> {
  guardQuota(opts.purpose);
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  // 不传就不设上限：由模型自己决定生成多长
  const maxTokens = opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : undefined;
  const temperature = opts.temperature ?? 0.9;
  const body = JSON.stringify({
    model: opts.model,
    messages,
    temperature,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    stream: false,
    ...(opts.disableThinking ? { thinking: { type: 'disabled' } } : {}),
    ...(opts.tools && opts.tools.length > 0
      ? { tools: opts.tools, tool_choice: opts.toolChoice ?? 'auto' }
      : {}),
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
    maxTokens: maxTokens ?? 0,
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
        if (res.status === 429) {
          const until = quotaPauseFrom(text);
          if (until > quotaPausedUntil) {
            quotaPausedUntil = until;
          }
        }
        // 4xx 除了 429 之外重试没有意义
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new LlmError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
        }
        lastError = new LlmError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
        continue;
      }
      const data = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string; tool_calls?: ToolCall[] };
          finish_reason?: string;
        }>;
        usage?: UsageLike;
      };
      const choice = data.choices?.[0];
      let text = choice?.message?.content ?? '';
      let toolCalls = choice?.message?.tool_calls ?? [];
      // 上游没把 DSML 解析成 tool_calls 时自己兼容一层（见 extractDsmlCalls）
      const dsml = extractDsmlCalls(text);
      if (dsml.found) {
        if (toolCalls.length === 0 && dsml.toolCalls.length > 0) {
          toolCalls = dsml.toolCalls;
        }
        text = dsml.content;
      }
      if (!text.trim() && toolCalls.length === 0) {
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
      return { content: text.trim(), toolCalls, finishReason: choice?.finish_reason };
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

/** 只取文本的调用方（看图、归纳、纯文本闲聊）用这个。 */
export async function chatComplete(
  messages: ChatMessage[],
  opts: LlmOptions,
  retries = 2,
): Promise<string> {
  guardQuota(opts.purpose);
  const response = await chatCompleteRaw(messages, opts, retries);
  if (!response.content) {
    throw new LlmError('空回复');
  }
  return response.content;
}
