/**
 * 课程表数据存储（移植自 astrbot_plugin_CourseSchedule/plugin/store.py + files.py 的持久化部分）。
 * AstrBot KV → 本地 JSON 文件，路径由 COURSE_DATA_FILE 配置（默认 ./data/course-schedule.json）。
 * 读-改-写用单锁串行化，写入走 tmp + rename 原子替换。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ScheduleEvent } from './ics';

/** 一个成员的课程表信息 */
export interface MemberInfo {
  name: string;
  schedule: string;
  updated_at: string;
  schedule_updated_at?: string;
  remote_updated_at?: string;
  last_synced_at?: string;
  content_updated_at?: string;
  last_modified_at?: string;
  last_modified_by?: string;
  source: string; // 'ics' | 'manual'
  source_file: string;
  uploader_id: string;
  event_count: number;
  events: ScheduleEvent[];
  ics: string;
}

/** 存储结构：group:<gid> / private:<uid> → members */
export interface Store {
  version: number;
  groups: Record<string, { members: Record<string, MemberInfo> }>;
}

export function emptyStore(): Store {
  return { version: 1, groups: {} };
}

function normalizeStore(raw: unknown): Store {
  const store = (raw && typeof raw === 'object' ? raw : {}) as Partial<Store>;
  const groups = store.groups && typeof store.groups === 'object' ? store.groups : {};
  return { version: 1, groups };
}

/** 从 chatId（g:<gid> / p:<uid>）推导存储作用域 */
export function scopeFromChatId(chatId: string): string {
  if (chatId.startsWith('g:')) return `group:${chatId.slice(2)}`;
  if (chatId.startsWith('p:')) return `private:${chatId.slice(2)}`;
  return chatId;
}

/** 作用域展示标签 */
export function scopeLabel(scope: string): string {
  if (scope.startsWith('group:')) return `群 ${scope.slice(6)}`;
  if (scope.startsWith('private:')) return '私聊';
  return scope;
}

/** 读取某作用域成员表（不存在时返回空对象，不落盘） */
export function scopeMembers(store: Store, scope: string): Record<string, MemberInfo> {
  const scopeData = store.groups[scope];
  if (!scopeData || typeof scopeData.members !== 'object') return {};
  return scopeData.members;
}

/** 确保某作用域成员表存在并返回引用（会修改 store，调用方负责保存） */
export function ensureScopeMembers(store: Store, scope: string): Record<string, MemberInfo> {
  const scopeData = (store.groups[scope] ??= { members: {} });
  if (!scopeData.members || typeof scopeData.members !== 'object') scopeData.members = {};
  return scopeData.members;
}

/** 串行化 JSON 文件存储 */
export class ScheduleStore {
  private readonly filePath: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async read(): Promise<Store> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      return normalizeStore(JSON.parse(raw));
    } catch {
      return emptyStore();
    }
  }

  private async write(store: Store): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
    await rename(tmp, this.filePath);
  }

  /** 在单锁内读-改-写（回调里直接改 store，写回自动发生） */
  async withStore<T>(fn: (store: Store) => T | Promise<T>): Promise<T> {
    return this.locked(async () => {
      const store = await this.read();
      const result = await fn(store);
      await this.write(store);
      return result;
    });
  }

  /** 在单锁内只读（不改写文件），与 withStore 互斥 */
  async readStore<T>(fn: (store: Store) => T | Promise<T>): Promise<T> {
    return this.locked(async () => {
      const store = await this.read();
      return fn(store);
    });
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
