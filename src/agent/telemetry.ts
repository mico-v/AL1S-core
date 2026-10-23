/**
 * AI 调用审计。
 *
 * 每一次 chat completion 都落一行 JSON：token、缓存命中、耗时、速度、
 * 上下文占用、调用栈、用途。出问题时能一眼看出「慢在哪、贵在哪、谁调的」。
 *
 * 刻意不做聚合缓存：写 JSONL 一行一个 append，崩溃也不丢历史。
 */

import { appendFile, mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppLogger } from '../logger.js';

export interface CallRecord {
  /** ISO 时间 */
  at: string;
  /** chat / caption / learn … */
  purpose: string;
  model: string;
  /** 同一次调用内的第几次尝试，0 表示第一次就成功 */
  attempt: number;
  ok: boolean;
  status?: number;
  error?: string;

  /** 总耗时（含重试等待） */
  ms: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  /** cachedTokens / promptTokens */
  cacheRate: number;
  /** completionTokens / 秒 */
  tokensPerSecond: number;
  /** promptTokens / contextWindow */
  contextRate: number;
  contextWindow: number;

  /** 请求形状 */
  messages: number;
  promptChars: number;
  images: number;
  maxTokens: number;
  temperature: number;

  conversationId?: string;
  speaker?: string;
  /** 调用来源（应用内帧） */
  stack: string[];
}

export interface TelemetryOptions {
  dir: string;
  enabled: boolean;
  contextWindow: number;
  log?: AppLogger;
  /** 单文件上限，超过就滚动。 */
  maxFileBytes?: number;
}

const DEFAULT_OPTIONS: TelemetryOptions = {
  dir: path.join(process.cwd(), 'data', 'calls'),
  enabled: true,
  contextWindow: 128_000,
};

let options: TelemetryOptions = DEFAULT_OPTIONS;
let ready: Promise<void> | undefined;

export function configureTelemetry(next: Partial<TelemetryOptions>): void {
  options = { ...options, ...next };
  ready = undefined;
}

export function telemetryOptions(): TelemetryOptions {
  return options;
}

/** 从 V8 的堆栈里挑出应用自己的帧，去掉 node_modules 和内部实现。 */
export function appFrames(stack: string | undefined, limit = 6): string[] {
  if (!stack) {
    return [];
  }
  return stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .map((line) => line.replace(/^at\s+/, '').replace(/^file:\/\//, ''))
    .filter((line) => !line.includes('node_modules') && !line.includes('node:internal'))
    .map((line) => {
      // /opt/git/.../src/agent/index.ts:123:45 → src/agent/index.ts:123
      const match = /(\S*\/)?(src\/[^:]+):(\d+):\d+/.exec(line);
      if (match) {
        return `${line.split(' (')[0]?.split('/').pop() ?? ''} ${match[2]}:${match[3]}`.trim();
      }
      return line.length > 120 ? `${line.slice(0, 117)}…` : line;
    })
    .slice(0, limit);
}

async function ensureDir(): Promise<void> {
  ready ??= mkdir(options.dir, { recursive: true }).then(() => undefined);
  await ready;
}

function fileFor(date: Date): string {
  return path.join(options.dir, `${date.toISOString().slice(0, 10)}.jsonl`);
}

async function rotateIfNeeded(file: string): Promise<void> {
  const limit = options.maxFileBytes ?? 50 * 1024 * 1024;
  try {
    const info = await stat(file);
    if (info.size < limit) {
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await rename(file, `${file}.${stamp}.old`);
  } catch {
    // 文件还不存在，正常
  }
}

/** 落盘一条记录。永不抛错 —— 审计不能把业务搞挂。 */
export async function recordCall(record: CallRecord): Promise<void> {
  if (!options.enabled) {
    return;
  }
  try {
    await ensureDir();
    const file = fileFor(new Date(record.at));
    await rotateIfNeeded(file);
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    options.log?.warn('调用记录写入失败', { error });
  }
}

/** 由 usage 算出所有派生指标，避免各处各算一套。 */
export function buildRecord(input: {
  at?: Date;
  purpose: string;
  model: string;
  attempt: number;
  ok: boolean;
  status?: number;
  error?: string;
  ms: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  messages: number;
  promptChars: number;
  images: number;
  maxTokens: number;
  temperature: number;
  conversationId?: string;
  speaker?: string;
  stack?: string;
  contextWindow?: number;
}): CallRecord {
  const usage = input.usage ?? {};
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  const contextWindow = input.contextWindow ?? options.contextWindow;
  const seconds = input.ms / 1000;

  return {
    at: (input.at ?? new Date()).toISOString(),
    purpose: input.purpose,
    model: input.model,
    attempt: input.attempt,
    ok: input.ok,
    status: input.status,
    error: input.error,
    ms: Math.round(input.ms),
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    cacheRate: promptTokens > 0 ? Number((cachedTokens / promptTokens).toFixed(4)) : 0,
    tokensPerSecond: seconds > 0 ? Number((completionTokens / seconds).toFixed(2)) : 0,
    contextRate: contextWindow > 0 ? Number((promptTokens / contextWindow).toFixed(4)) : 0,
    contextWindow,
    messages: input.messages,
    promptChars: input.promptChars,
    images: input.images,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    conversationId: input.conversationId,
    speaker: input.speaker,
    stack: appFrames(input.stack),
  };
}

export interface Summary {
  calls: number;
  okCalls: number;
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cacheRate: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  avgTokensPerSecond: number;
  maxContextRate: number;
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index] as number;
}

export function summarize(records: CallRecord[]): Summary {
  const durations = records.map((r) => r.ms).sort((a, b) => a - b);
  const sum = (pick: (r: CallRecord) => number): number => records.reduce((acc, r) => acc + pick(r), 0);
  const promptTokens = sum((r) => r.promptTokens);
  const cachedTokens = sum((r) => r.cachedTokens);
  const speeds = records.filter((r) => r.tokensPerSecond > 0).map((r) => r.tokensPerSecond);

  return {
    calls: records.length,
    okCalls: records.filter((r) => r.ok).length,
    failedCalls: records.filter((r) => !r.ok).length,
    promptTokens,
    completionTokens: sum((r) => r.completionTokens),
    cachedTokens,
    reasoningTokens: sum((r) => r.reasoningTokens),
    totalTokens: sum((r) => r.totalTokens),
    cacheRate: promptTokens > 0 ? Number((cachedTokens / promptTokens).toFixed(4)) : 0,
    avgMs: records.length > 0 ? Math.round(sum((r) => r.ms) / records.length) : 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    avgTokensPerSecond:
      speeds.length > 0 ? Number((speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(2)) : 0,
    maxContextRate: records.length > 0 ? Math.max(...records.map((r) => r.contextRate)) : 0,
  };
}

/** 读最近 N 天的记录。坏行跳过，不让一条脏数据毁掉统计。 */
export async function readRecords(dir: string, days = 1): Promise<CallRecord[]> {
  const since = Date.now() - days * 86_400_000;
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: CallRecord[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    let raw: string;
    try {
      raw = await readFile(full, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line) as CallRecord;
        if (Date.parse(record.at) >= since) {
          out.push(record);
        }
      } catch {
        // 半行/坏行，跳过
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
