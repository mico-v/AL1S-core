/**
 * Asia/Shanghai（UTC+8，无夏令时）时间工具。
 *
 * 约定：插件内部把「上海本地时间」表示为一个 JS Date，其 UTC 字段即上海墙上时钟
 * （即 Date.now() + 8h，或用 Date.UTC 直接构造）。这类 Date 之间可直接比较，
 * 格式化用 getUTC* 方法。存储层的时间戳则用真实 UTC（toISOString）字符串，
 * 由 parseTimestamp 归一化后比较。
 */

/** UTC+8 偏移（毫秒） */
export const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

/** 当前上海本地时间（UTC 字段 = 上海墙上时钟） */
export function nowLocal(): Date {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS);
}

/** 上海本地日期各分量（weekday: 0=周一 … 6=周日，同 Python datetime.weekday） */
export interface LocalDateParts {
  y: number;
  m: number; // 0-based
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export function localDateParts(d: Date): LocalDateParts {
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: (d.getUTCDay() + 6) % 7,
  };
}

/** 用上海本地日期分量构造 Date（UTC 字段 = 上海墙上时钟） */
export function combineLocalDate(y: number, m: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(y, m, day, hour, minute, 0));
}

/** 上海本地日期加减天数 */
export function addLocalDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function formatHm(d: Date): string {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function formatDateTime(d: Date): string {
  return `${formatDate(d)} ${formatHm(d)}`;
}

/** 解析任意时间戳（数字秒/毫秒、ISO 字符串、上海本地 "YYYY-MM-DD HH:MM:SS"）为真实 UTC Date */
export function parseTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    let ts = value;
    if (ts > 10_000_000_000) ts /= 1000;
    const d = new Date(ts * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return parseTimestamp(Number(text));
  const iso = text.replace('Z', '+00:00');
  const parsed = new Date(iso);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  // "YYYY-MM-DD HH:MM:SS" / "YYYY-MM-DD HH:MM"：按上海本地墙钟解释
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const utc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)) - SHANGHAI_OFFSET_MS;
    const d = new Date(utc);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** 当前真实 UTC ISO 字符串 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 把时间戳归一化为真实 UTC ISO 字符串；缺失时用当前时间 */
export function timestampIso(value?: unknown): string {
  const d = value === undefined ? new Date() : (parseTimestamp(value) ?? new Date());
  return d.toISOString();
}

/** 比较两个真实 UTC 时间戳：差值 ≤2s 视为相等；任一缺失返回 null */
export function compareTimestamps(left: Date | null | undefined, right: Date | null | undefined): number | null {
  if (!left || !right) return null;
  const delta = left.getTime() - right.getTime();
  if (Math.abs(delta) <= 2000) return 0;
  return delta > 0 ? 1 : -1;
}
