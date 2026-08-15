/**
 * 会话持久化：把会话历史落盘到 `data/sessions/<chatId>.json`，
 * 满足「已有对话数据跨重启保留」（仿 AstrBot conversations 惰性恢复）。
 *
 * - chatId（g:<gid> / p:<uid>）本就是确定性 key → 启动后首次访问某会话时从磁盘恢复。
 * - 每次追加/清空/改人设触发 2s 防抖落盘；退出时 flushAll 全量落盘。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatSession, type LoggedMessage } from './session';
import type { SessionManager } from './manager';

interface SessionFile {
  version: number;
  messages: LoggedMessage[];
  personaOverride?: string;
}

export class SessionPersistence {
  private readonly dir: string;
  private readonly manager: SessionManager;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(manager: SessionManager, dir = './data/sessions') {
    this.manager = manager;
    this.dir = dir;
  }

  /** 挂接：把 manager 的会话创建替换为「磁盘恢复 + 变更防抖落盘」 */
  attach(): void {
    this.manager.createSession = (chatId, tokenBudget) => {
      const session = new ChatSession({
        chatId,
        tokenBudget,
        onChange: () => this.scheduleFlush(chatId),
      });
      this.loadInto(session);
      return session;
    };
  }

  /** 从磁盘恢复该会话历史 */
  private loadInto(session: ChatSession): void {
    const file = this.fileOf(session.chatId);
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as SessionFile;
      for (const msg of data.messages ?? []) session.append({ ...msg });
      if (data.personaOverride) session.setPersonaOverride(data.personaOverride);
    } catch {
      // 损坏文件视为空会话
    }
  }

  private scheduleFlush(chatId: string): void {
    const existing = this.timers.get(chatId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      chatId,
      setTimeout(() => {
        this.timers.delete(chatId);
        this.flush(chatId);
      }, 2000),
    );
  }

  /** 立即写盘某会话 */
  flush(chatId: string): void {
    const session = this.manager.list().find((s) => s.chatId === chatId);
    if (!session) return;
    const file = this.fileOf(chatId);
    try {
      mkdirSync(this.dir, { recursive: true });
      const payload: SessionFile = {
        version: 1,
        messages: session.getSnapshot(),
        personaOverride: session.personaOverride,
      };
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
      renameSync(tmp, file);
    } catch {
      // 落盘失败仅降级，不影响机器人
    }
  }

  /** 清空会话时同步删除磁盘文件 */
  remove(chatId: string): void {
    const timer = this.timers.get(chatId);
    if (timer) clearTimeout(timer);
    this.timers.delete(chatId);
    const file = this.fileOf(chatId);
    try {
      if (existsSync(file)) renameSync(file, `${file}.del`);
    } catch {
      // 忽略
    }
  }

  /** 退出前全量落盘 */
  flushAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const session of this.manager.list()) this.flush(session.chatId);
  }

  private fileOf(chatId: string): string {
    // chatId 含 ':'，做文件系统安全化
    return join(this.dir, `${encodeURIComponent(chatId)}.json`);
  }
}
