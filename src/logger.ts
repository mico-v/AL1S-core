/**
 * 分级日志：控制台输出 + 自动落盘（按大小轮转）。
 *
 * 特性：
 *   - debug / info / warn / error 四级，按级别过滤；
 *   - 同时写控制台与文件（文件可选、可关）；
 *   - 文件超过阈值自动轮转，保留最近 N 个文件；
 *   - meta 结构化输出，Error 自动展开 name/message/stack；
 *   - 对 secret / token / authorization 类字段脱敏；
 *   - 落盘失败只告警一次并自动降级，不影响机器人运行。
 *
 * 兼容 `@tencent-connect/qqbot-nodejs` 的 Logger 接口（info / error 必需，
 * warn / debug 可选）。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogMeta {
  [key: string]: unknown;
}

/** 项目内统一使用的日志接口。 */
export interface AppLogger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

export interface LoggerOptions {
  /** 最低输出级别，默认 info。 */
  level?: LogLevel;
  /** 是否输出到控制台，默认 true。 */
  console?: boolean;
  /** 落盘文件路径；null / 空字符串表示不落盘，默认 logs/bot.log。 */
  file?: string | null;
  /** 单文件大小上限（字节），超过后轮转，默认 10MB。 */
  maxSizeBytes?: number;
  /** 保留的日志文件总数（含当前文件），默认 5，最小 2。 */
  maxFiles?: number;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 以这些后缀结尾的 key 会被脱敏（如 appSecret / accessToken / clientToken）。 */
const SECRET_KEY_SUFFIX = /(secret|token)$/i;
/** 需要精确匹配的敏感 key。 */
const SECRET_KEYS = new Set(['authorization', 'auth']);

function isSecretKey(key: string): boolean {
  return SECRET_KEY_SUFFIX.test(key) || SECRET_KEYS.has(key.toLowerCase());
}

const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (value === undefined || value === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }
  return fallback;
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function redact(meta: LogMeta): LogMeta {
  const result: LogMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    result[key] = isSecretKey(key) ? '***' : serializeValue(value);
  }
  return result;
}

function format(level: LogLevel, message: string, meta?: LogMeta): string {
  const base = `[${new Date().toISOString()}] [${level}] ${message}`;
  if (meta === undefined) {
    return base;
  }
  const keys = Object.keys(meta);
  if (keys.length === 0) {
    return base;
  }
  return `${base} ${JSON.stringify(redact(meta))}`;
}

interface FileSink {
  write(line: string): void;
  /** 当前文件大小（字节），用于测试与诊断。 */
  size(): number;
}

/**
 * 创建按大小轮转的文件 sink。
 *
 * 轮转规则（maxFiles = N）：删除最旧的 `path.N-1`，其余依次后移，
 * 当前文件改名为 `path.1`，再新建当前文件。
 */
function createFileSink(path: string, maxSizeBytes: number, maxFiles: number): FileSink {
  let size = 0;
  let broken = false;
  const keep = Math.max(2, maxFiles);

  try {
    mkdirSync(dirname(path), { recursive: true });
    size = existsSync(path) ? statSync(path).size : 0;
  } catch (error) {
    broken = true;
    console.error(`[logger] 初始化日志文件失败，已禁用落盘：${error instanceof Error ? error.message : String(error)}`);
  }

  const rotate = (): void => {
    try {
      const oldest = `${path}.${keep - 1}`;
      if (existsSync(oldest)) {
        rmSync(oldest, { force: true });
      }
      for (let i = keep - 2; i >= 1; i -= 1) {
        const source = `${path}.${i}`;
        if (existsSync(source)) {
          renameSync(source, `${path}.${i + 1}`);
        }
      }
      if (existsSync(path)) {
        renameSync(path, `${path}.1`);
      }
      size = 0;
    } catch (error) {
      broken = true;
      console.error(`[logger] 轮转日志文件失败，已禁用落盘：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    write(line: string): void {
      if (broken) {
        return;
      }
      try {
        const bytes = Buffer.byteLength(line, 'utf8');
        if (size > 0 && size + bytes > maxSizeBytes) {
          rotate();
          if (broken) {
            return;
          }
        }
        appendFileSync(path, line, 'utf8');
        size += bytes;
      } catch (error) {
        broken = true;
        console.error(`[logger] 写入日志文件失败，已禁用落盘：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    size(): number {
      return size;
    },
  };
}

export function createLogger(options: LoggerOptions = {}): AppLogger {
  const level = options.level ?? 'info';
  const threshold = LEVEL_WEIGHT[level];
  const toConsole = options.console ?? true;

  const file = options.file === undefined ? 'logs/bot.log' : options.file;
  const sink =
    file === null || file === ''
      ? null
      : createFileSink(file, options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES, options.maxFiles ?? DEFAULT_MAX_FILES);

  const write = (target: LogLevel, message: string, meta?: LogMeta): void => {
    if (LEVEL_WEIGHT[target] < threshold) {
      return;
    }
    const line = format(target, message, meta);
    if (toConsole) {
      if (target === 'error') {
        console.error(line);
      } else if (target === 'warn') {
        console.warn(line);
      } else {
        console.log(line);
      }
    }
    sink?.write(`${line}\n`);
  };

  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  };
}
