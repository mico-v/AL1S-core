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
    },
    dataRoot: env.CHAT_DATA_DIR ?? './data',
    botOpenids: list(env.AGENT_BOT_OPENIDS),
    botUsernames: list(env.AGENT_BOT_USERNAMES),
    groupAllowlist: list(env.AGENT_GROUPS),
    contextSize: Number(env.AGENT_CONTEXT_SIZE ?? 40),
    ownerOpenids: list(env.AGENT_OWNER_OPENIDS),
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

export class ChatAgent {
  private readonly config: AgentConfig;
  private readonly log: AppLogger;
  private readonly buffer: GroupBuffer;
  private readonly members = new Map<string, GroupMemory>();
  private readonly complete: CompleteFn;

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

  /** 入口：所有群消息都从这里过。 */
  async handle(message: QQBotInboundMessage, bot: Bot): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    if (message.kind !== 'group' || !message.groupOpenid) {
      return;
    }
    const groupOpenid = message.groupOpenid;
    if (this.config.groupAllowlist.length > 0 && !this.config.groupAllowlist.includes(groupOpenid)) {
      return;
    }

    const text = (message.content ?? '').trim();
    if (!text || message.senderIsBot) {
      return;
    }
    // 别的机器人的命令
    if (text.startsWith('/')) {
      this.log.debug('忽略命令类消息', { groupOpenid, text: text.slice(0, 40) });
      return;
    }

    const called = isBotMentioned(message, this.config);
    if (!called) {
      this.buffer.push(groupOpenid, {
        senderName: message.senderName ?? message.senderId.slice(0, 8),
        text,
        timestamp: Date.now(),
      });
      return;
    }

    const pending = this.buffer.drain(groupOpenid);
    const memory = this.memory(groupOpenid);
    const speaker = message.senderName ?? message.senderId.slice(0, 8);

    const remembered = await memory.renderContext([message.senderId]);
    const parts: string[] = [];
    if (remembered) {
      parts.push(`## 你记得的 ${speaker}\n\n${remembered}`);
    }
    if (this.config.ownerOpenids.includes(message.senderId)) {
      parts.push('## 提示\n\n现在说话的是**主人**，可以更放松、更直接一点。');
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
      const cleaned = reply.replace(/^\[SILENT\]$/i, '').trim();
      if (!cleaned) {
        return;
      }
      await bot.replyText(message.replyTarget, cleaned);
      this.log.info('已回复', {
        groupOpenid,
        speaker,
        chars: cleaned.length,
        contextLines: pending.length,
      });
    } catch (error) {
      this.log.error('回复失败', { groupOpenid, error });
    }
  }

  /** 让后续的记忆归纳任务能拿到同一个 store。 */
  memoryFor(groupOpenid: string): GroupMemory {
    return this.memory(groupOpenid);
  }
}
