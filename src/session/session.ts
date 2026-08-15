/**
 * 会话层：每个聊天（群/私聊）一个有界上下文日志。
 *
 * 记录格式见 LoggedMessage；buildContext() 按 token 预算从新到旧选窗口，
 * 并保证「机器人上次回复之后」的消息全部进上下文（AstrBot 连贯性保证）。
 */
import { estimateTokens } from '../llm/types';
import type { LLMMessage } from '../llm/types';

/** 日志里的一条消息 */
export interface LoggedMessage {
  role: 'user' | 'assistant';
  senderId?: number;
  senderName: string;
  text: string;
  atBot: boolean;
  time: number;
}

export interface SessionOptions {
  chatId: string;
  tokenBudget: number;
  maxMessages?: number; // 环形日志上限，默认 200
}

export class ChatSession {
  readonly chatId: string;
  /** 管道用：生成期间置 true 防重复回复（MaiBot 每会话串行化简化） */
  isGenerating = false;

  private readonly _tokenBudget: number;
  private readonly _maxMessages: number;
  private readonly _messages: LoggedMessage[] = []; // 旧 → 新
  private _personaOverride: string | undefined;
  private _lastBotReplyTime: number | undefined;

  constructor(options: SessionOptions) {
    this.chatId = options.chatId;
    this._tokenBudget = options.tokenBudget;
    this._maxMessages = Math.max(1, options.maxMessages ?? 200);
  }

  /** 追加一条消息；time 缺失时补当前时间；环形超限丢最旧 */
  append(msg: LoggedMessage): void {
    if (!msg.time) msg.time = Date.now();
    if (msg.role === 'assistant') this._lastBotReplyTime = msg.time;
    this._messages.push(msg);
    while (this._messages.length > this._maxMessages) this._messages.shift();
  }

  clear(): void {
    this._messages.length = 0;
    this._lastBotReplyTime = undefined;
  }

  setPersonaOverride(text?: string): void {
    this._personaOverride = text || undefined;
  }

  get personaOverride(): string | undefined {
    return this._personaOverride;
  }

  get lastBotReplyTime(): number | undefined {
    return this._lastBotReplyTime;
  }

  get size(): number {
    return this._messages.length;
  }

  /**
   * 组装上下文（不含 system），按时间序返回（最后一条 = 最新）。
   * 选窗口：从新到旧回扫；「机器人上次回复之后」的消息无条件包含，
   * 更旧的消息在 token 预算内继续纳入，超出即停。
   */
  buildContext(): LLMMessage[] {
    const msgs = this._messages;
    const out: LLMMessage[] = [];
    let tokens = 0;

    // 定位最新的机器人回复，作为连贯性锚点；没有则整窗都受预算约束
    let anchor = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === 'assistant') {
        anchor = i;
        break;
      }
    }
    const hasAnchor = anchor >= 0;

    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      const rendered = renderLogged(m);
      const cost = estimateTokens(rendered.content ?? '');
      const mustInclude = hasAnchor && i > anchor; // 上次回复之后的消息，超预算也全含
      if (!mustInclude && tokens + cost > this._tokenBudget) break;
      out.push(rendered);
      tokens += cost;
    }

    return out.reverse(); // 时间序：旧 → 新，最后一条为最新
  }
}

/** 日志条目 → LLM 消息：user 带说话人标注（MaiBot），assistant 为机器人原文 */
function renderLogged(msg: LoggedMessage): LLMMessage {
  if (msg.role === 'assistant') {
    return { role: 'assistant', content: msg.text };
  }
  const body = msg.atBot ? `[DIRECTED AT YOU] ${msg.text}` : msg.text;
  return { role: 'user', content: `${msg.senderName}: ${body}` };
}
