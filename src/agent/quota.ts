/**
 * 配额查询。
 *
 * OpenCode Zen 有官方接口：GET /zen/go/v1/usage
 * 返回 rolling（滚动窗口）/ weekly / monthly 三段，各带 status、percent、resetsAt。
 *
 * 用途：后台任务（摘要、归纳、主动参与）在发请求前先看一眼，
 * 配额已经打满就直接跳过 —— 而不是等到 429 再重试，白烧上千次请求。
 */

import type { AppLogger } from '../logger.js';
import type { LlmOptions } from './llm.js';

export interface QuotaWindow {
  status: string;
  percent: number;
  resetsAt: string;
}

export interface Quota {
  rolling?: QuotaWindow;
  weekly?: QuotaWindow;
  monthly?: QuotaWindow;
  fetchedAt: number;
}

const CACHE_MS = 60_000;
const TIMEOUT_MS = 8_000;

let cache: { at: number; quota?: Quota } = { at: 0 };

/** 读配额。失败返回 undefined（调用方当作「不知道」，不要因此停摆）。 */
export async function currentQuota(llm: LlmOptions, log?: AppLogger): Promise<Quota | undefined> {
  if (Date.now() - cache.at < CACHE_MS) {
    return cache.quota;
  }
  const base = llm.baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/usage`, {
      headers: {
        authorization: `Bearer ${llm.apiKey}`,
        'x-opencode-session': llm.sessionId ?? 'quota-probe',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as { usage?: Omit<Quota, 'fetchedAt'> };
    const quota: Quota = { ...(data.usage ?? {}), fetchedAt: Date.now() };
    cache = { at: Date.now(), quota };
    return quota;
  } catch (error) {
    log?.debug('配额查询失败', { error });
    cache = { at: Date.now(), quota: undefined };
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 哪个窗口已经打满。 */
export function blockingWindow(quota: Quota | undefined): { name: string; window: QuotaWindow } | undefined {
  if (!quota) {
    return undefined;
  }
  for (const name of ['weekly', 'rolling', 'monthly'] as const) {
    const window = quota[name];
    if (!window) {
      continue;
    }
    if (window.status !== 'ok' || window.percent >= 100) {
      return { name, window };
    }
  }
  return undefined;
}

/**
 * 后台任务还能不能跑。
 *
 * 返回 0 表示可以；否则返回要等到的时间戳（配额的 resetsAt，解析不出来就 +1 小时）。
 */
export async function backgroundPauseUntil(llm: LlmOptions, log?: AppLogger): Promise<number> {
  const quota = await currentQuota(llm, log);
  const blocked = blockingWindow(quota);
  if (!blocked) {
    return 0;
  }
  const reset = Date.parse(blocked.window.resetsAt);
  const until = Number.isFinite(reset) && reset > Date.now() ? reset : Date.now() + 3600_000;
  log?.info('配额未恢复，后台任务暂停', {
    window: blocked.name,
    status: blocked.window.status,
    percent: blocked.window.percent,
    until: new Date(until).toISOString(),
  });
  return until;
}

/** 渲染一行摘要，给 /status 和每日体检用。 */
export function renderQuota(quota: Quota | undefined): string {
  if (!quota) {
    return '配额：查不到';
  }
  const part = (name: string, window?: QuotaWindow): string =>
    window ? `${name} ${window.percent}%` : '';
  return [
    part('滚动', quota.rolling),
    part('周', quota.weekly),
    part('月', quota.monthly),
  ]
    .filter(Boolean)
    .join(' · ');
}
