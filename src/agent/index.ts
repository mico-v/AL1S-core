/**
 * 群聊 agent 编排层。
 *
 * 规则：
 *   - 没被 @ → 不进模型，只进滚动缓冲；
 *   - 被 @   → 把「上次说话之后群里发生了什么」+ 说话人档案一起喂进去，回一条；
 *   - / 开头的消息是别的机器人的命令，直接忽略。
 */

import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { Bot } from '../bot.js';
import type { AppLogger } from '../logger.js';
import { GroupBuffer, renderBuffer } from './context.js';
import { chatComplete, type ChatMessage, type LlmOptions } from './llm.js';
import { GroupMemory } from './memory.js';
import { CONTEXT_FOOTER, CONTEXT_HEADER, PERSONA } from './persona.js';
import { cleanQQText } from './text.js';
import { digestAttachments } from './vision.js';

export interface AgentConfig {
  enabled: boolean;
  llm: LlmOptions;
  /** 数据根目录（chat-log 与 memory 都在下面）。 */
  dataRoot: string;
  /** 视为「在叫我」的 openid（机器人在群里的 member_openid 等）。 */
  botOpenids: string[];
  /** 视为「在叫我」的用户名，需同时是 bot 账号。 */
  botUsernames: string[];
  /** 只在这些群里生效；空数组表示全部群。 */
  groupAllowlist: string[];
  /** 缓冲多少条非 @ 消息。 */
  contextSize: number;
  /** 主人的 openid：语气可以更放松。 */
  ownerOpenids: string[];
  /** 私聊是否启用。 */
  directEnabled: boolean;
}

export function readAgentConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const list = (raw: string | undefined): string[] =>
    (raw ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

  return {
    enabled: env.AGENT_ENABLED !== 'false',
    llm: {
      baseUrl: env.AGENT_API_BASE ?? 'https://opencode.ai/zen/go/v1',
      apiKey: env.AGENT_API_KEY ?? '',
      model: env.AGENT_MODEL ?? 'deepseek-v4.1-flash',
      temperature: Number(env.AGENT_TEMPERATURE ?? 0.95),
      maxTokens: Number(env.AGENT_MAX_TOKENS ?? 400),
      timeoutMs: Number(env.AGENT_TIMEOUT_MS ?? 45_000),
      disableThinking: env.AGENT_DISABLE_THINKING !== 'false',
    },
    dataRoot: env.CHAT_DATA_DIR ?? './data',
    botOpenids: list(env.AGENT_BOT_OPENIDS),
    botUsernames: list(env.AGENT_BOT_USERNAMES),
    groupAllowlist: list(env.AGENT_GROUPS),
    contextSize: Number(env.AGENT_CONTEXT_SIZE ?? 40),
    ownerOpenids: list(env.AGENT_OWNER_OPENIDS),
    directEnabled: env.AGENT_DIRECT_ENABLED !== 'false',
  };
}

interface MentionLike {
  member_openid?: unknown;
  user_openid?: unknown;
  union_openid?: unknown;
  id?: unknown;
  username?: unknown;
  bot?: unknown;
}

/** 这条消息是不是 @ 了机器人本人。只看 openid / bot+username，不看空的 bot 标志。 */
export function isBotMentioned(message: QQBotInboundMessage, config: AgentConfig): boolean {
  const mentions = (message as unknown as { mentions?: unknown }).mentions;
  if (!Array.isArray(mentions)) {
    return false;
  }
  for (const raw of mentions) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const m = raw as MentionLike;
    for (const key of ['member_openid', 'user_openid', 'union_openid', 'id'] as const) {
      const value = m[key];
      if (typeof value === 'string' && config.botOpenids.includes(value)) {
        return true;
      }
    }
    const name = typeof m.username === 'string' ? m.username.trim() : '';
    if (m.bot === true && name && config.botUsernames.includes(name)) {
      return true;
    }
  }
  return false;
}

export type CompleteFn = (messages: ChatMessage[], opts: LlmOptions) => Promise<string>;

/** 单条消息上限（QQ 文本消息过长会被截断或发送失败）。 */
export const MAX_REPLY_CHARS = 700;

/** 长回复切成多条：优先在空行/换行/句末断开，避免劈开句子。 */
export function splitReply(text: string, limit: number = MAX_REPLY_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.length <= limit) {
    return [trimmed];
  }
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const breakAt = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('，'),
    );
    const cut = breakAt > limit * 0.5 ? breakAt + 1 : limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks.filter(Boolean);
}

interface Scope {
  conversationId: string;
  memoryKey: string;
  isDirect: boolean;
  replyTarget: QQBotInboundMessage['replyTarget'];
}

export class ChatAgent {
  private readonly config: AgentConfig;
  private readonly log: AppLogger;
  private readonly buffer: GroupBuffer;
  private readonly members = new Map<string, GroupMemory>();
  private readonly complete: CompleteFn;
  /** 同一会话串行处理，避免同一群里两条 @ 并发抢回复。 */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(config: AgentConfig, log: AppLogger, complete: CompleteFn = chatComplete) {
    this.config = config;
    this.log = log;
    this.complete = complete;
    this.buffer = new GroupBuffer(config.contextSize);
  }

  private memory(groupOpenid: string): GroupMemory {
    let store = this.members.get(groupOpenid);
    if (!store) {
      store = new GroupMemory(this.config.dataRoot, groupOpenid);
      this.members.set(groupOpenid, store);
    }
    return store;
  }

  private resolveScope(message: QQBotInboundMessage): Scope | undefined {
    if (message.kind === 'group') {
      const groupOpenid = message.groupOpenid;
      if (!groupOpenid) {
        return undefined;
      }
      if (this.config.groupAllowlist.length > 0 && !this.config.groupAllowlist.includes(groupOpenid)) {
        return undefined;
      }
      return {
        conversationId: groupOpenid,
        memoryKey: groupOpenid,
        isDirect: false,
        replyTarget: message.replyTarget,
      };
    }
    if (message.kind === 'c2c' || message.kind === 'dm') {
      if (!this.config.directEnabled) {
        return undefined;
      }
      return {
        conversationId: `dm:${message.senderId}`,
        memoryKey: `dm_${message.senderId}`,
        isDirect: true,
        replyTarget: message.replyTarget,
      };
    }
    // guild / 频道消息暂不处理
    return undefined;
  }

  /** 入口：所有消息都从这里过。 */
  async handle(message: QQBotInboundMessage, bot: Bot): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    const scope = this.resolveScope(message);
    if (!scope) {
      return;
    }

    const raw = (message.content ?? '').trim();
    const withoutMentions = raw.replace(/<@!?[0-9A-Fa-f]{16,}>/g, '').trim();
    const text = cleanQQText(raw);
    const attachments = message.attachments ?? [];
    const hasAttachments = attachments.length > 0;

    if (message.senderIsBot || (!text && !hasAttachments)) {
      return;
    }
    // 别的机器人的命令（@课表Bot /课表 也算）
    if (withoutMentions.startsWith('/')) {
      this.log.debug('忽略命令类消息', { conversationId: scope.conversationId, text: withoutMentions.slice(0, 40) });
      return;
    }

    const called = scope.isDirect || isBotMentioned(message, this.config);
    if (!called) {
      const line = {
        senderName: message.senderName ?? message.senderId.slice(0, 8),
        text,
        timestamp: Date.now(),
      };
      this.buffer.push(scope.conversationId, line);
      if (hasAttachments) {
        // 后台看懂，看懂后原地补进这一行，别挡住后续消息
        void this.enrich(message, attachments).then((extra) => {
          if (extra) {
            line.text = `${line.text}\n${extra}`.trim();
          }
        });
      }
      return;
    }

    // 被 @ 了：先把图看懂，再回
    const extra = hasAttachments ? await this.enrich(message, attachments) : '';
    const fullText = [text, extra].filter(Boolean).join('\n');

    // 同会话串行：把本次处理挂在上一次后面
    const prev = this.chains.get(scope.conversationId) ?? Promise.resolve();
    const task: Promise<void> = prev.catch(() => undefined).then(() => this.reply(message, bot, scope, fullText));
    const tail: Promise<void> = task.finally(() => {
      if (this.chains.get(scope.conversationId) === tail) {
        this.chains.delete(scope.conversationId);
      }
    });
    this.chains.set(scope.conversationId, tail);
    await task;
  }

  /** 把附件转成可读文本；失败也返回「没看清」这类标记，绝不留空。 */
  private async enrich(
    message: QQBotInboundMessage,
    attachments: NonNullable<QQBotInboundMessage['attachments']>,
  ): Promise<string> {
    const startedAt = Date.now();
    const digest = await digestAttachments(attachments, this.config.llm, this.log);
    if (digest.imagesSeen > 0 || digest.imagesFailed > 0) {
      this.log.info('看图', {
        conversationId: message.groupOpenid ?? message.senderId.slice(0, 8),
        seen: digest.imagesSeen,
        failed: digest.imagesFailed,
        ms: Date.now() - startedAt,
      });
    }
    return digest.text;
  }

  private async reply(
    message: QQBotInboundMessage,
    bot: Bot,
    scope: Scope,
    text: string,
  ): Promise<void> {
    const pending = scope.isDirect ? [] : this.buffer.drain(scope.conversationId);
    const memory = this.memory(scope.memoryKey);
    const speaker = message.senderName ?? message.senderId.slice(0, 8);

    const remembered = await memory.renderContext([message.senderId]);
    const parts: string[] = [];
    if (remembered) {
      parts.push(`## 你记得的 ${speaker}\n\n${remembered}`);
    }
    if (this.config.ownerOpenids.includes(message.senderId)) {
      parts.push('## 提示\n\n现在说话的是**主人**，可以更放松、更直接一点。');
    }
    if (scope.isDirect) {
      parts.push('## 提示\n\n现在是私聊，不是群里，可以放开一点聊。');
    }

    const system = [PERSONA, ...parts].join('\n\n---\n\n');
    const history = renderBuffer(pending);
    const userText = history
      ? `${CONTEXT_HEADER}\n${history}\n${CONTEXT_FOOTER}\n\n${speaker}：${text}`
      : `${speaker}：${text}`;

    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: userText },
    ];

    try {
      const reply = await this.complete(messages, this.config.llm);
      const cleaned = reply.replace(/^\s*\[SILENT\]\s*$/i, '').trim();
      if (!cleaned) {
        return;
      }
      const chunks = splitReply(cleaned);
      for (let i = 0; i < chunks.length; i += 1) {
        await bot.replyText(scope.replyTarget, chunks[i] as string);
        if (i < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
      this.log.info('已回复', {
        conversationId: scope.conversationId,
        speaker,
        chars: cleaned.length,
        chunks: chunks.length,
        contextLines: pending.length,
      });
    } catch (error) {
      this.log.error('回复失败', { conversationId: scope.conversationId, error });
    }
  }

  /** 让后续的记忆归纳任务能拿到同一个 store。 */
  memoryFor(groupOpenid: string): GroupMemory {
    return this.memory(groupOpenid);
  }
}
