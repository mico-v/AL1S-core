/**
 * 会话管理器：按 chatId 管理 ChatSession，LRU 淘汰最久未活跃的会话。
 */
import { ChatSession } from './session';
import { logger } from '../logging/logger';

const log = logger.child('session');

export interface SessionManagerOptions {
  tokenBudget: number; // 传给每个新建会话的上下文预算
  maxSessions: number; // LRU 上限
}

export class SessionManager {
  private readonly _tokenBudget: number;
  private readonly _maxSessions: number;
  private readonly _sessions = new Map<string, ChatSession>(); // 迭代序 = 最近使用序

  constructor(options: SessionManagerOptions) {
    this._tokenBudget = options.tokenBudget;
    this._maxSessions = Math.max(1, options.maxSessions);
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
    const created = new ChatSession({ chatId, tokenBudget: this._tokenBudget });
    this._sessions.set(chatId, created);
    if (this._sessions.size > this._maxSessions) {
      const oldest = this._sessions.keys().next().value; // 迭代器第一个 = 最久未用
      if (oldest !== undefined) {
        log.debug('淘汰会话', { chatId: oldest });
        this._sessions.delete(oldest);
      }
    }
    log.debug('新建会话', { chatId });
    return created;
  }

  /** 删除指定会话 */
  clear(chatId: string): void {
    this._sessions.delete(chatId);
  }

  get size(): number {
    return this._sessions.size;
  }
}
