/**
 * 轻量日志器：分级过滤 + 彩色终端 + 可选文件输出（启动时按大小轮转）。
 *
 * 设计约束：
 * - 零依赖、永不抛错（文件写失败只降级，绝不影响机器人运行）。
 * - 级别从环境变量 LOG_LEVEL 惰性读取，与 config.ts 解耦（避免循环依赖）。
 * - 一条记录一行（便于 grep），字段值清洗换行与超长截断。
 * - 写文件时强制无色；stdout/stderr 在 TTY 下才着色（尊重 NO_COLOR / FORCE_COLOR）。
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 级别数值，用于过滤 */
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
/** 级别名，右对齐 5 位（对齐 [INFO ] 风格） */
const LEVEL_NAME: Record<LogLevel, string> = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };

/** 终端颜色 */
const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  level: { debug: '\x1b[90m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[1;31m' },
} as const;

/** 字段值最大长度，超长截断（防止刷屏） */
const MAX_FIELD = 300;

/** 本地时间：YYYY-MM-DD HH:mm:ss.mmm */
function formatTime(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/** 字段值 → 单行字符串（JSON 化对象、转义换行、超长截断） */
function formatValue(v: unknown): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else if (v === null) s = 'null';
  else if (v === undefined) s = 'undefined';
  else if (typeof v === 'object') {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = '[unserializable]';
    }
  } else s = String(v);
  if (s.length > MAX_FIELD) s = `${s.slice(0, MAX_FIELD)}…`;
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/** fields → "k=v k2=v2"；含空格/引号/等号的字符串加引号 */
function formatFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const s = formatValue(v);
    const quoted = s === '' || s.includes(' ') || s.includes('"') || s.includes('=');
    parts.push(quoted ? `${k}="${s}"` : `${k}=${s}`);
  }
  return parts.join(' ');
}

/** 渲染一行（plain 无色 / color 着色两种） */
function renderLine(
  level: LogLevel,
  tag: string,
  msg: string,
  fields: Record<string, unknown>,
  color: boolean,
): string {
  const head = `[${formatTime(new Date())}] [${LEVEL_NAME[level]}]`;
  const tagPart = tag ? ` [${tag}]` : '';
  const fieldPart = formatFields(fields);
  const body = `${msg}${fieldPart ? ` ${fieldPart}` : ''}`;
  if (!color) return `${head}${tagPart} ${body}`;
  const lv = COLOR.level[level];
  return `${COLOR.dim}${head}${COLOR.reset} ${lv}[${LEVEL_NAME[level]}]${COLOR.reset}` +
    `${tagPart ? ` ${COLOR.cyan}[${tag}]${COLOR.reset}` : ''} ${COLOR.gray}${msg}${COLOR.reset}` +
    `${fieldPart ? ` ${COLOR.dim}${fieldPart}${COLOR.reset}` : ''}`;
}

// --- 文件输出（惰性、一次轮转检查、写失败仅降级） ---

/** 当前日志文件路径（LOG_FILE 为空则无文件输出） */
function getLogFilePath(): string | undefined {
  const p = process.env.LOG_FILE;
  return p && p.trim() !== '' ? p : undefined;
}

let rotated = false;
/** 启动后首次写前做一次轮转：超过 LOG_MAX_SIZE_MB（默认 10MB）则改名 .1 再写新的 */
function rotateIfNeeded(file: string): void {
  if (rotated) return;
  rotated = true;
  try {
    const max = Number(process.env.LOG_MAX_SIZE_MB);
    const mb = Number.isNaN(max) || max <= 0 ? 10 : max;
    const st = statSync(file);
    if (st.size > mb * 1024 * 1024) {
      try {
        rmSync(`${file}.1`, { force: true });
      } catch {
        /* 清理旧备份失败忽略 */
      }
      try {
        renameSync(file, `${file}.1`);
      } catch {
        /* 轮转失败忽略 */
      }
    }
  } catch {
    /* 文件不存在/无法 stat，跳过轮转 */
  }
}

function writeToFile(text: string): void {
  const file = getLogFilePath();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true }); // 目录不存在时自动创建
    rotateIfNeeded(file);
    appendFileSync(file, text);
  } catch {
    // 写文件失败仅降级，绝不让日志影响机器人
  }
}

// --- Logger ---

export interface LoggerOptions {
  tag?: string;
}

export class Logger {
  private readonly tag: string;

  constructor(options: LoggerOptions = {}) {
    this.tag = options.tag ?? '';
  }

  /** 派生子日志器：tag 点号拼接，如 logger.child('pipeline') */
  child(tag: string): Logger {
    return new Logger({ tag: this.tag ? `${this.tag}.${tag}` : tag });
  }

  /** 当前生效级别：惰性读 LOG_LEVEL（debug|info|warn|error，缺省 info） */
  get level(): LogLevel {
    const raw = process.env.LOG_LEVEL;
    return raw && raw in LEVEL_ORDER ? (raw as LogLevel) : 'info';
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields);
  }

  /** error 级别：fields 可直接传 Error（自动取 message + 附 stack） */
  error(msg: string, fields?: Record<string, unknown> | Error): void {
    let f = fields;
    let stack: string | undefined;
    if (fields instanceof Error) {
      f = { err: fields.message };
      stack = fields.stack;
    }
    this.write('error', msg, f, stack);
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown> | Error, stack?: string): void {
    try {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
      const f = fields instanceof Error ? { err: fields.message } : (fields ?? {});
      const plain = renderLine(level, this.tag, msg, f, false);
      const colored = this.useColor() ? renderLine(level, this.tag, msg, f, true) : plain;
      const block = level === 'error' && stack ? `\n${stack}` : '';

      // warn/error 走 stderr，debug/info 走 stdout
      const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
      stream.write(`${colored}${block}\n`);

      // 文件输出：无色纯文本（含 stack）
      writeToFile(`${plain}${block}\n`);
    } catch {
      // 日志绝不允许抛错
    }
  }

  /** 终端着色开关：NO_COLOR 关闭、FORCE_COLOR 强制、否则按 TTY 判断 */
  private useColor(): boolean {
    if (process.env.NO_COLOR !== undefined) return false;
    if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
    return Boolean(process.stdout.isTTY || process.stderr.isTTY);
  }
}

/** 工厂：createLogger({ tag: 'x' }) */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}

/** 根日志器：各模块 import 后 logger.child('模块名') 使用 */
export const logger = new Logger();
