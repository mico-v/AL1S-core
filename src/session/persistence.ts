/**
 * 会话持久化：把会话历史落盘到 `data/sessions/<chatId>.json`，
 * 满足「已有对话数据跨重启保留」（仿 AstrBot conversations 惰性恢复）。
 *
 * - chatId（g:<gid> / p:<uid>）本就是确定性 key → 启动后首次访问某会话时从磁盘恢复。
 * - 每次追加/清空/改人设触发 2s 防抖落盘；退出时 flushAll 全量落盘。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
      const size = statSync(file).size;
      if (size > 5 * 1024 * 1024) return;
      const data = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SessionFile>;
      if (data.version !== 1 || !Array.isArray(data.messages)) return;
      const restored: LoggedMessage[] = [];
      for (const msg of data.messages.slice(-500)) {
        if (!msg || (msg.role !== 'user' && msg.role !== 'assistant') || typeof msg.text !== 'string') continue;
        restored.push({
          role: msg.role,
          senderId: typeof msg.senderId === 'number' ? msg.senderId : undefined,
          senderName: typeof msg.senderName === 'string' ? msg.senderName : '',
          text: msg.text,
          atBot: Boolean(msg.atBot),
          time: typeof msg.time === 'number' && Number.isFinite(msg.time) ? msg.time : Date.now(),
        });
      }
      session.restore(restored, typeof data.personaOverride === 'string' ? data.personaOverride : undefined);
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

  /** 扫描磁盘会话，供管理端展示尚未惰性恢复的会话 */
  listDiskSummaries(): Array<{ chatId: string; messageCount: number; lastActivity: number; isGenerating: boolean; personaOverride?: string }> {
    try {
      if (!existsSync(this.dir)) return [];
      const out: Array<{ chatId: string; messageCount: number; lastActivity: number; isGenerating: boolean; personaOverride?: string }> = [];
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const data = JSON.parse(readFileSync(join(this.dir, name), 'utf-8')) as Partial<SessionFile>;
          const encoded = name.slice(0, -5);
          const chatId = decodeURIComponent(encoded);
          const messages = Array.isArray(data.messages) ? data.messages : [];
          const last = messages.at(-1) as LoggedMessage | undefined;
          out.push({ chatId, messageCount: messages.length, lastActivity: typeof last?.time === 'number' ? last.time : 0, isGenerating: false, personaOverride: data.personaOverride });
        } catch { /* 忽略损坏文件 */ }
      }
      return out;
    } catch {
      return [];
    }
  }


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
    for (const candidate of [file, `${file}.tmp`, `${file}.del`]) {
      try {
        rmSync(candidate, { force: true });
      } catch {
        // 忽略
      }
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
