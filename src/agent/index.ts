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
import { matchCommand, renderStatus } from './commands.js';
import { GroupBuffer, renderBuffer } from './context.js';
import { DigestEngine } from './digest.js';
import {
  chatComplete,
  chatCompleteRaw,
  type ChatMessage,
  type ChatResponse,
  type LlmOptions,
} from './llm.js';
import { GroupMemory } from './memory.js';
import { CONTEXT_FOOTER, CONTEXT_HEADER, PERSONA } from './persona.js';
import { cleanQQText } from './text.js';
import { TOOL_DEFINITIONS, executeTool, type ToolContext } from './tools.js';
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
  /** 是否允许模型调用工具（查历史、查档案）。 */
  toolsEnabled: boolean;
  /** 对话摘要：累积到多少条归档一次；0 表示关闭。 */
  digestThreshold: number;
  /** 单次摘要最多喂多少条。 */
  digestMaxBatch: number;
  /** 调用审计。 */
  callLog: {
    enabled: boolean;
    dir: string;
    contextWindow: number;
  };
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
    toolsEnabled: env.AGENT_TOOLS !== 'false',
    digestThreshold: Number(env.AGENT_DIGEST_THRESHOLD ?? 40),
    digestMaxBatch: Number(env.AGENT_DIGEST_MAX_BATCH ?? 120),
    callLog: {
      enabled: env.AGENT_CALL_LOG !== 'false',
      dir: env.AGENT_CALL_LOG_DIR ?? './data/calls',
      contextWindow: Number(env.AGENT_CONTEXT_WINDOW ?? 128_000),
    },
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

export type CompleteFn = (messages: ChatMessage[], opts: LlmOptions, retries?: number) => Promise<string>;
export type RawCompleteFn = (
  messages: ChatMessage[],
  opts: LlmOptions,
  retries?: number,
) => Promise<ChatResponse>;

/** 一条消息的处理方式。三态显式化：可观测、可扩展。 */
export type InboundMode = 'drop' | 'store' | 'process';

interface Addressee {
  to?: string;
  toBot: boolean;
}

/** 从 mentions 推断「这句在跟谁说话」。多人对话里这层结构必须由系统给，别让模型猜。 */
export function addresseeOf(message: QQBotInboundMessage, config: AgentConfig): Addressee {
  const mentions = (message as unknown as { mentions?: unknown }).mentions;
  if (!Array.isArray(mentions)) {
    return { toBot: false };
  }
  const names: string[] = [];
  let toBot = false;
  for (const raw of mentions) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const m = raw as MentionLike;
    const openid = [m.member_openid, m.user_openid, m.union_openid, m.id].find(
      (v): v is string => typeof v === 'string',
    );
    const name = typeof m.username === 'string' ? m.username.trim() : '';
    const isSelf =
      (openid !== undefined && config.botOpenids.includes(openid)) ||
      (m.bot === true && name !== '' && config.botUsernames.includes(name));
    if (isSelf) {
      toBot = true;
    } else if (name !== '') {
      names.push(name);
    }
  }
  const result: Addressee = { toBot };
  if (names.length > 0) {
    result.to = names.join('、');
  }
  return result;
}

/** 单条消息上限（QQ 文本消息过长会被截断或发送失败）。 */
export const MAX_REPLY_CHARS = 700;

/** 一条回复最多拆成几条消息。QQ 群被动回复 5 分钟内最多 5 次，留余量。 */
export const MAX_REPLY_CHUNKS = 3;

/**
 * 把模型输出切成要发送的消息。
 *
 * 空行（两个以上换行）= 换一条消息 —— 人格提示词里就是用空行表示「分开说」。
 * 单个换行只是行内换行，仍算同一条。
 * 单段超长再按句末/逗号切，避免一条撑爆 QQ 的长度限制。
 */
export function splitReply(text: string, limit: number = MAX_REPLY_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= limit) {
      chunks.push(paragraph);
      continue;
    }
    let rest = paragraph;
    while (rest.length > limit) {
      const window = rest.slice(0, limit);
      const breakAt = Math.max(
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
  }

  const nonEmpty = chunks.filter(Boolean);
  if (nonEmpty.length <= MAX_REPLY_CHUNKS) {
    return nonEmpty;
  }

  // 条数超限时把尾巴并成一条；并完还是太长就宁可多发，也不截断内容
  const merged = nonEmpty.slice(MAX_REPLY_CHUNKS - 1).join('\n');
  if (merged.length <= limit) {
    return [...nonEmpty.slice(0, MAX_REPLY_CHUNKS - 1), merged];
  }
  return nonEmpty;
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
  private readonly completeRaw: RawCompleteFn;
  private readonly digest: DigestEngine;
  private readonly startedAt = Date.now();
  /** 处理门分状态计数：drop / store / process */
  private readonly modes = { drop: 0, store: 0, process: 0 };
  /** 同一会话串行处理，避免同一群里两条 @ 并发抢回复。 */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    config: AgentConfig,
    log: AppLogger,
    complete: CompleteFn = chatComplete,
    completeRaw: RawCompleteFn = chatCompleteRaw,
    hooks: { onMemoryWorthy?: (chatId: string, note: string) => void } = {},
  ) {
    this.config = config;
    this.log = log;
    this.complete = complete;
    this.completeRaw = completeRaw;
    this.buffer = new GroupBuffer(config.contextSize);
    this.digest = new DigestEngine({
      dataRoot: config.dataRoot,
      llm: config.llm,
      log,
      threshold: config.digestThreshold > 0 ? config.digestThreshold : 40,
      maxBatch: config.digestMaxBatch,
      onMemoryWorthy: hooks.onMemoryWorthy,
    });
  }

  /** 定时兜底：群里安静下来、没到阈值时也把已有的对话归档掉。 */
  async runDigestSweep(chatIds: string[]): Promise<number> {
    let count = 0;
    // 冷场的话题先归档：没人再说话也必须落盘，不能等下一句。
    this.digest.sweepIdle();
    for (const chatId of chatIds) {
      try {
        const due = await this.digest.dueCount(chatId);
        if (due >= this.config.digestThreshold) {
          const record = await this.digest.digest(chatId);
          if (record) {
            count += 1;
          }
        }
      } catch (error) {
        this.log.warn('摘要巡检失败', { chatId, error });
      }
    }
    return count;
  }

  /**
   * 跑一轮对话，允许模型中途调工具。
   *
   * 回合上限 3：查历史 / 查档案 / 再补一次，足够覆盖真实提问，
   * 又不至于让一条群消息拖出十几秒。
   */
  private async converse(messages: ChatMessage[], opts: LlmOptions, chatId?: string): Promise<string> {
    if (!this.config.toolsEnabled) {
      return this.complete(messages, opts, 1);
    }

    const ctx: ToolContext = {
      dataRoot: this.config.dataRoot,
      // 私聊没有群 id，就搜全部历史，否则会一条都搜不到
      groupId: chatId,
      log: this.log,
    };

    let convo = [...messages];
    for (let round = 0; round < 3; round += 1) {
      const response = await this.completeRaw(convo, { ...opts, tools: TOOL_DEFINITIONS }, 1);
      if (response.toolCalls.length === 0) {
        return response.content;
      }
      this.log.info('工具调用', {
        round,
        tools: response.toolCalls.map((call) => call.function.name),
        conversationId: opts.conversationId,
      });
      convo = [...convo, { role: 'assistant', content: response.content, tool_calls: response.toolCalls }];
      for (const call of response.toolCalls) {
        const output = await executeTool(call.function.name, call.function.arguments, ctx);
        convo = [...convo, { role: 'tool', tool_call_id: call.id, content: output }];
      }
    }

    // 回合用完还没收敛：要一次纯文本，别把 tool_calls 暴露给群友
    this.log.warn('工具回合超限，强制收尾', { conversationId: opts.conversationId });
    return this.complete(convo, { ...opts, tools: undefined }, 1);
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
      this.modes.drop += 1;
      return;
    }
    // 自己的指令：不走模型，立刻回
    const command = matchCommand(withoutMentions);
    if (command !== undefined) {
      const body = await renderStatus({
        chatId: scope.conversationId,
        dataRoot: this.config.dataRoot,
        bufferLines: scope.isDirect ? 0 : this.buffer.peek(scope.conversationId).length,
        bufferLimit: this.config.contextSize,
        model: this.config.llm.model,
        contextWindow: this.config.callLog.contextWindow,
        startedAt: this.startedAt,
        modes: this.modes,
      });
      await bot.replyText(scope.replyTarget, body);
      this.log.info('指令', { command, conversationId: scope.conversationId });
      return;
    }

    // 别的机器人的命令（@课表Bot /课表 也算）
    if (withoutMentions.startsWith('/')) {
      this.modes.drop += 1;
      this.log.debug('忽略命令类消息', { conversationId: scope.conversationId, text: withoutMentions.slice(0, 40) });
      return;
    }

    // 每条群消息都计数，累积到阈值就后台归档（不阻塞回复）
    if (!scope.isDirect && this.config.digestThreshold > 0) {
      this.digest.observe(scope.conversationId, text, Date.now());
    }

    const called = scope.isDirect || isBotMentioned(message, this.config);
    if (!called) {
      const line = {
        senderName: message.senderName ?? message.senderId.slice(0, 8),
        text,
        timestamp: Date.now(),
        ...addresseeOf(message, this.config),
      };
      this.buffer.push(scope.conversationId, line);
      this.modes.store += 1;
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

    this.modes.process += 1;

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
    const now = new Date();
    const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const current = `[${stamp}] ${speaker}${scope.isDirect ? '' : ' → Kei'}：${text}`;
    const userText = history
      ? `${CONTEXT_HEADER}\n${history}\n${CONTEXT_FOOTER}\n\n${current}`
      : current;

    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: userText },
    ];

    try {
      const reply = await this.converse(
        messages,
        {
          ...this.config.llm,
          purpose: 'chat',
          conversationId: scope.conversationId,
          speaker,
        },
        scope.isDirect ? undefined : scope.conversationId,
      );
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
