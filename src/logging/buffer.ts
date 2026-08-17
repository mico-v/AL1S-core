/**
 * 日志环形缓冲：内存保留最近 N 条结构化日志，供管理后台回溯与 SSE 实时推送。
 * logger 写入时同步 push 一份到这里（push 内部 try/catch，绝不抛错）。
 */
import type { LogLevel } from './logger';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
  private historyFile?: string;

  constructor(limit = 1000, historyFile = process.env.LOG_HISTORY_FILE || './data/logs/history.jsonl') {
    this.limit = Math.max(1, limit);
    this.historyFile = historyFile.trim() || undefined;
    this.loadHistory();
  }

  private loadHistory(): void {
    if (!this.historyFile) return;
    try {
      if (statSync(this.historyFile).size > 20 * 1024 * 1024) return;
      const lines = readFileSync(this.historyFile, 'utf-8').split(/\r?\n/);
      for (const line of lines.slice(-this.limit * 2)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as LogRecord;
          if (record && typeof record.time === 'string' && typeof record.msg === 'string') this.records.push(record);
        } catch { /* 忽略截断或损坏行 */ }
      }
      this.records = this.records.slice(-this.limit);
    } catch { /* 历史文件不存在时正常启动 */ }
  }

  configureHistory(file?: string): void {
    this.historyFile = file?.trim() || undefined;
    this.records = [];
    this.loadHistory();
  }

  private persist(record: LogRecord): void {
    if (!this.historyFile) return;
    try {
      mkdirSync(dirname(this.historyFile), { recursive: true });
      appendFileSync(this.historyFile, `${JSON.stringify(record)}\n`, 'utf-8');
      const size = statSync(this.historyFile).size;
      if (size > 20 * 1024 * 1024) {
        const tmp = `${this.historyFile}.tmp`;
        writeFileSync(tmp, `${this.records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf-8');
        renameSync(tmp, this.historyFile);
      }
    } catch { /* 历史落盘失败不影响日志 */ }
  }

  push(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.limit) {
      this.records = this.records.slice(-this.limit);
    }
    this.persist(record);
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
