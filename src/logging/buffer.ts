/**
 * 日志环形缓冲：内存保留最近 N 条结构化日志，供管理后台回溯与 SSE 实时推送。
 * logger 写入时同步 push 一份到这里（push 内部 try/catch，绝不抛错）。
 */
import type { LogLevel } from './logger';

/** 一条结构化日志记录（管理后台 /api/logs 与 SSE 使用的形态） */
export interface LogRecord {
  time: string; // "YYYY-MM-DD HH:mm:ss.mmm"
  level: LogLevel;
  tag: string;
  msg: string;
  fields?: Record<string, string>;
}

export class LogBuffer {
  private records: LogRecord[] = [];
  private readonly listeners = new Set<(record: LogRecord) => void>();
  private readonly limit: number;

  constructor(limit = 1000) {
    this.limit = limit;
  }

  push(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.limit) {
      this.records = this.records.slice(-this.limit);
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(record);
      } catch {
        // 订阅者抛错不影响日志主流程
      }
    }
  }

  /** 最近 limit 条（不指定则全部保留范围内记录） */
  recent(limit?: number): LogRecord[] {
    return limit !== undefined ? this.records.slice(-limit) : this.records.slice();
  }

  /** 订阅实时日志；返回取消订阅函数 */
  subscribe(listener: (record: LogRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get size(): number {
    return this.records.length;
  }
}

/** 全局日志缓冲（AdminServer 日志接口与 SSE 使用） */
export const logBuffer = new LogBuffer();
