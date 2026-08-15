/**
 * 会话管理器：按 chatId 管理 ChatSession，LRU 淘汰最久未活跃的会话。
 */
import { ChatSession } from './session';
import { logger } from '../logging/logger';

const log = logger.child('session');

export interface SessionManagerOptions {
  tokenBudget: number; // 传给每个新建会话的上下文预算
  maxSessions: number; // LRU 上限
  getTokenBudget?: () => number; // 运行时现读（管理后台热更新用）
  getMaxSessions?: () => number; // 运行时现读
}

export class SessionManager {
  private readonly _tokenBudget: number;
  private readonly _maxSessions: number;
  private readonly _getTokenBudget?: () => number;
  private readonly _getMaxSessions?: () => number;
  private readonly _sessions = new Map<string, ChatSession>(); // 迭代序 = 最近使用序
  /** 会话创建工厂（持久化模块可替换为「磁盘恢复 + 变更落盘」） */
  createSession: (chatId: string, tokenBudget: number) => ChatSession;

  constructor(options: SessionManagerOptions) {
    this._tokenBudget = options.tokenBudget;
    this._maxSessions = Math.max(1, options.maxSessions);
    this._getTokenBudget = options.getTokenBudget;
    this._getMaxSessions = options.getMaxSessions;
    this.createSession = (chatId, tokenBudget) => new ChatSession({ chatId, tokenBudget });
  }

  /** 获取会话；不存在则创建；每次访问刷新为最近使用 */
  get(chatId: string): ChatSession {
    const existing = this._sessions.get(chatId);
    if (existing) {
      // delete+set 把当前会话移到迭代器末尾（最近使用）
      this._sessions.delete(chatId);
      this._sessions.set(chatId, existing);
      return existing;
    }
    const budget = this._getTokenBudget ? this._getTokenBudget() : this._tokenBudget;
    const created = this.createSession(chatId, budget);
    this._sessions.set(chatId, created);
    const max = this._getMaxSessions ? this._getMaxSessions() : this._maxSessions;
    while (this._sessions.size > max) {
      const oldest = this._sessions.keys().next().value; // 迭代器第一个 = 最久未用
      if (oldest === undefined) break;
      log.debug('淘汰会话', { chatId: oldest });
      this._sessions.delete(oldest);
    }
    log.debug('新建会话', { chatId });
    return created;
  }

  /** 删除指定会话 */
  clear(chatId: string): void {
    this._sessions.delete(chatId);
  }

  /** 全部会话（LRU 序，不保证顺序稳定） */
  list(): ChatSession[] {
    return [...this._sessions.values()];
  }

  get size(): number {
    return this._sessions.size;
  }
}
