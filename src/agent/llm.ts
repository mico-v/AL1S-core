/**
 * OpenAI 兼容的 chat completions 客户端。
 *
 * 只做一件事：把 messages 发出去，拿回文本。
 * 不引入 SDK，避免为了一个 POST 拉一堆依赖。
 */

import { randomUUID } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseNativeToolCalls } from './dsml.js';
import { buildRecord, recordCall } from './telemetry.js';

/** opencode-go 要求带上会话标识，否则拒收请求（MissingSessionID）。 */
const PROCESS_SESSION_ID = randomUUID();

// 本机没有全局 IPv6：解析器偶尔把 AAAA 排前面，Node 的 fetch 直接 ETIMEDOUT
// （账本里就是一条「fetch failed」）。放在这里而不是 index.ts：
// agent-try / agent-learn / agent-daily 这些脚本不经过主入口，也得同样对待。
setDefaultResultOrder('ipv4first');

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
  /**
   * 思考模式下模型返回的思维链。按 DeepSeek 手册：请求带 tools 时，
   * 历史里每条 assistant 消息都必须把 reasoning_content 原样回传，
   * 否则模型会丢掉自己上一轮的推理（官方 API 直接 400）。
   */
  reasoning_content?: string;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  /** 思维链；带 tools 的下一轮要回传。 */
  reasoningContent?: string;
  finishReason?: string;
  /**
   * 上游自己报的 prompt 度量。
   *
   * 本地粗估（字符÷字数比）对中文与工具参数都会偏，压缩水位拿它当锚更靠得住：
   * 上一轮真实 prompt + 之后新增的粗估 = 这一轮的真实水位。
   */
  usage?: { promptTokens: number; cachedTokens: number };
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

/**
 * 组请求体（纯函数，便于断言）。参数按 DeepSeek 手册定：
 *
 *   - 思考模式默认开，这里显式写 `thinking.type`，不靠默认值；
 *   - 思考模式下 `temperature` 无效（传了也不报错，但属于噪声），只在关掉时发；
 *   - `max_tokens` 为 0 就不传，长度交给模型；
 *   - 带 tools 时一并给 `tool_choice`，缺省 auto。
 */
export function buildRequestBody(messages: ChatMessage[], opts: LlmOptions): string {
  const maxTokens = opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : undefined;
  const temperature = opts.temperature ?? 0.9;
  const thinkingOn = !opts.disableThinking;
  return JSON.stringify({
    model: opts.model,
    messages,
    ...(thinkingOn ? {} : { temperature }),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    stream: false,
    thinking: { type: thinkingOn ? 'enabled' : 'disabled' },
    ...(opts.tools && opts.tools.length > 0
      ? { tools: opts.tools, tool_choice: opts.toolChoice ?? 'auto' }
      : {}),
  });
}

/** 调一次 chat completions，返回纯文本。失败按退避重试。 */
export async function chatCompleteRaw(
  messages: ChatMessage[],
  opts: LlmOptions,
  retries = 2,
): Promise<ChatResponse> {
  guardQuota(opts.purpose);
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const maxTokens = opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : undefined;
  const temperature = opts.temperature ?? 0.9;
  const body = buildRequestBody(messages, opts);

  const startedAt = Date.now();
  const stack = new Error().stack;
  const shape = {
    messages: messages.length,
    // 工具调用的 arguments 也是真发出去的 token（改文件的 heredoc 动辄几千字），
    // 不数进去账本就永远少报一截
    promptChars: messages.reduce((acc, m) => {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const args = (m.tool_calls ?? []).reduce((sum, call) => sum + (call.function?.arguments?.length ?? 0), 0);
      return acc + text.length + args;
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

  // 网络层的抖动（fetch failed）不消耗正常重试额度：本机实测偶发 1~2 秒连不上
  // 模型端点，两次快速重试全落在同一段抖动里，整条回复就成了「我卡住了」（2026-11-19）。
  let networkRetries = 0;
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
          message?: { content?: string; tool_calls?: ToolCall[]; reasoning_content?: string };
          finish_reason?: string;
        }>;
        usage?: UsageLike;
      };
      const choice = data.choices?.[0];
      const message = choice?.message ?? {};
      // 响应边界只认标准 tool_calls：上游没解析的原生格式在这里归一（dsml.ts）
      const native = parseNativeToolCalls(typeof message.content === 'string' ? message.content : '');
      const toolCalls =
        message.tool_calls && message.tool_calls.length > 0 ? message.tool_calls : native.toolCalls;
      const text = native.content;
      const reasoningContent =
        typeof message.reasoning_content === 'string' && message.reasoning_content.trim()
          ? message.reasoning_content
          : undefined;
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
      return {
        content: text.trim(),
        toolCalls,
        reasoningContent,
        finishReason: choice?.finish_reason,
        usage: {
          promptTokens: Number(data.usage?.prompt_tokens ?? 0) || 0,
          cachedTokens: Number(data.usage?.prompt_tokens_details?.cached_tokens ?? 0) || 0,
        },
      };
    } catch (error) {
      if (error instanceof LlmError && error.status && error.status < 500) {
        await recordFailure(error);
        throw error;
      }
      // 把底层原因（ENETUNREACH / ECONNRESET / ETIMEDOUT …）带进错误文案，
      // 不然账本里永远只有一句 fetch failed，猜不透是 DNS 还是对方拒接。
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const code = cause?.code ?? cause?.message;
      const wrapped =
        error instanceof Error
          ? new LlmError(`${error.message}${code ? ` (${code})` : ''}`)
          : new LlmError(String(error));
      const transient = !(error instanceof LlmError && error.status);
      if (transient && networkRetries < 3) {
        networkRetries += 1;
        clearTimeout(timer);
        await sleep(700 * networkRetries + Math.floor(Math.random() * 300));
        attempt -= 1;
        continue;
      }
      lastError = wrapped;
    } finally {
      clearTimeout(timer);
    }
  }
  await recordFailure(lastError);
  throw lastError instanceof Error ? lastError : new LlmError(String(lastError));
}

/**
 * 复核调用的参数：只要两行 PASS/FAIL。
 *
 * 关思考 + 压 maxTokens + 短超时。实测同一批切片（s1/s2/s4/s6）开着思考结论完全一致，
 * 却多烧 10 倍 completion（401 vs 43 token）、慢 2–4 倍；11-21 还有三次跑到 45 秒超时被中断后重试，
 * 单条 66–85 秒 —— 复核卡住时整轮都停在这里。
 */
export function reviewOptions(base: LlmOptions): LlmOptions {
  return {
    ...base,
    purpose: 'review',
    temperature: 0,
    disableThinking: true,
    maxTokens: 300,
    timeoutMs: 25_000,
  };
}

/** 只取文本的调用方（看图、归纳、纯文本闲聊）用这个。 */
export async function chatComplete(
  messages: ChatMessage[],
  opts: LlmOptions,
  retries = 2,
): Promise<string> {
  guardQuota(opts.purpose);
  const response = await chatCompleteRaw(messages, opts, retries);
  if (response.content) {
    return response.content;
  }
  // 思考模式可能把预算全烧在思维链上，正文空着回来（手册：思考模式默认开）。
  // 关掉思考再要一次纯文本，比直接抛错让整条消息哑掉强。
  if (!opts.disableThinking) {
    const plain = await chatCompleteRaw(messages, { ...opts, disableThinking: true }, 1);
    if (plain.content) {
      return plain.content;
    }
  }
  throw new LlmError('空回复');
}
