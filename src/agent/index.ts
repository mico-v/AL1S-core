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
import { judgeProactive } from './proactive.js';
import {
  chatComplete,
  chatCompleteRaw,
  type ChatMessage,
  type ChatResponse,
  type ContentPart,
  type LlmOptions,
} from './llm.js';
import { GroupMemory } from './memory.js';
import { CONTEXT_FOOTER, CONTEXT_HEADER, OWNER_MODE, PERSONA } from './persona.js';
import { cleanQQText } from './text.js';
import { TOOL_DEFINITIONS, executeTool, type ToolContext } from './tools.js';
import { digestAttachments, loadImageParts } from './vision.js';

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
  /** 主动参与（默认为关）。 */
  proactive: {
    enabled: boolean;
    /** 只在哪些群主动；空数组表示跟随 groupAllowlist。 */
    groups: string[];
    /** 两次主动发言之间至少隔多久。 */
    cooldownMs: number;
    /** 至少积累多少条再判断。 */
    minLines: number;
    /** 最后一条消息距今超过这个时间就不接（话题已经凉了）。 */
    staleMs: number;
  };
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
      // 0 或未设 → 不传 max_tokens，长度交给模型
      maxTokens: Number(env.AGENT_MAX_TOKENS ?? 0) || undefined,
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
    proactive: {
      enabled: env.AGENT_PROACTIVE === 'true',
      groups: list(env.AGENT_PROACTIVE_GROUPS),
      cooldownMs: Number(env.AGENT_PROACTIVE_COOLDOWN_MS ?? 30 * 60 * 1000),
      minLines: Number(env.AGENT_PROACTIVE_MIN_LINES ?? 8),
      staleMs: Number(env.AGENT_PROACTIVE_STALE_MS ?? 15 * 60 * 1000),
    },
    callLog: {
      enabled: env.AGENT_CALL_LOG !== 'false',
      dir: env.AGENT_CALL_LOG_DIR ?? './data/calls',
      contextWindow: Number(env.AGENT_CONTEXT_WINDOW ?? 1_000_000),
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
export function splitReply(
  text: string,
  limit: number = MAX_REPLY_CHARS,
  maxChunks: number = MAX_REPLY_CHUNKS,
  /** true = 不按空行拆，尽量并成少数几条（主人模式用，避免刷屏式轰炸） */
  compact = false,
): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const paragraphs = compact
    ? [trimmed.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean).join('\n')]
    : trimmed.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);

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
  if (nonEmpty.length <= maxChunks) {
    return nonEmpty;
  }

  // 条数超限时把尾巴并成一条；并完还是太长就宁可多发，也不截断内容
  const merged = nonEmpty.slice(maxChunks - 1).join('\n');
  if (merged.length <= limit) {
    return [...nonEmpty.slice(0, maxChunks - 1), merged];
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
  /** 每个群上次主动发言的时间（冷却用） */
  private readonly lastProactiveAt = new Map<string, number>();
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
   * 主动参与巡检：判断有没有群聊卡住、值不值得接一句。
   *
   * 默认关闭（config.proactive.enabled）；开启后也受冷却与最小条数约束。
   * 判断失败、理由为空、内容为空，一律不发言。
   */
  async runProactiveSweep(bot: Bot, chatIds: string[]): Promise<number> {
    if (!this.config.proactive.enabled) {
      return 0;
    }
    let spoken = 0;
    for (const chatId of chatIds) {
      const allowed =
        this.config.proactive.groups.length === 0
          ? true
          : this.config.proactive.groups.includes(chatId);
      if (!allowed) {
        continue;
      }
      const lines = this.buffer.peek(chatId);
      if (lines.length < this.config.proactive.minLines) {
        continue;
      }
      const lastAt = this.buffer.lastMessageAt(chatId) ?? 0;
      if (Date.now() - lastAt > this.config.proactive.staleMs) {
        continue;
      }
      const lastSpoke = this.lastProactiveAt.get(chatId) ?? 0;
      if (Date.now() - lastSpoke < this.config.proactive.cooldownMs) {
        continue;
      }

      const decision = await judgeProactive(
        { groupId: chatId, lines },
        { complete: this.complete, llm: this.config.llm, log: this.log },
      );
      if (!decision.speak || !decision.text) {
        this.log.debug('主动判断：不说话', { chatId, reason: decision.reason });
        continue;
      }
      try {
        const chunks = splitReply(decision.text);
        for (let i = 0; i < chunks.length; i += 1) {
          await bot.replyText(
            { scope: 'group', targetId: chatId } as unknown as Parameters<Bot['replyText']>[0],
            chunks[i] as string,
          );
          if (i < chunks.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 350));
          }
        }
        this.lastProactiveAt.set(chatId, Date.now());
        spoken += 1;
        this.log.info('主动发言', { chatId, reason: decision.reason, chars: decision.text.length });
      } catch (error) {
        this.log.warn('主动发言失败', { chatId, error });
      }
    }
    return spoken;
  }

  /**
   * 跑一轮对话，允许模型中途调工具。
   *
   * 回合上限 3：查历史 / 查档案 / 再补一次，足够覆盖真实提问，
   * 又不至于让一条群消息拖出十几秒。
   */
  private async converse(
    messages: ChatMessage[],
    opts: LlmOptions,
    chatId?: string,
    maxRounds = 3,
  ): Promise<string> {
    if (!this.config.toolsEnabled) {
      return this.complete(messages, opts, 1);
    }

    const ctx: ToolContext = {
      dataRoot: this.config.dataRoot,
      // 私聊没有群 id，就搜全部历史，否则会一条都搜不到
      groupId: chatId,
      log: this.log,
      complete: this.complete,
      llm: { ...this.config.llm, purpose: 'expand' },
    };

    let convo = [...messages];
    for (let round = 0; round < maxRounds; round += 1) {
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
      const imageUrls = attachments
        .filter((item) => (item.content_type ?? '').startsWith('image/') || item.url?.includes('multimedia'))
        .map((item) => item.url)
        .filter((url): url is string => Boolean(url))
        .slice(0, 3);
      const line = {
        senderName: message.senderName ?? message.senderId.slice(0, 8),
        text,
        timestamp: Date.now(),
        ...addresseeOf(message, this.config),
        ...(imageUrls.length > 0 ? { imageUrls } : {}),
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

    // 被 @ 了：图直接塞进模型上下文，不再只发一句描述
    const images = hasAttachments
      ? await loadImageParts(attachments, this.log)
      : { parts: [], markers: [], failed: 0 };
    let imageParts = images.parts;
    const markers = [...images.markers];

    // 「刚才那张图怎么样」：把缓冲里最近发过的图也带上，合计不超过 3 张
    if (!scope.isDirect && imageParts.length < 3) {
      const recentUrls = this.buffer.recentImageUrls(scope.conversationId, 3 - imageParts.length);
      if (recentUrls.length > 0) {
        const older = await loadImageParts(
          recentUrls.map((url) => ({ content_type: 'image/jpeg', url })),
          this.log,
        );
        if (older.parts.length > 0) {
          imageParts = [...imageParts, ...older.parts];
          markers.push(`[前面还有人发过 ${older.parts.length} 张图，也已附上]`);
        }
      }
    }

    const extra = hasAttachments
      ? await this.enrich(message, attachments, { skipImages: images.parts.length > 0 })
      : '';
    const fullText = [text, ...markers, extra].filter(Boolean).join('\n');

    // 同会话串行：把本次处理挂在上一次后面
    const prev = this.chains.get(scope.conversationId) ?? Promise.resolve();
    const task: Promise<void> = prev
      .catch(() => undefined)
      .then(() => this.reply(message, bot, scope, fullText, imageParts));
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
    options: { skipImages?: boolean } = {},
  ): Promise<string> {
    const startedAt = Date.now();
    const digest = await digestAttachments(attachments, this.config.llm, this.log, options);
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
    imageParts: ContentPart[] = [],
  ): Promise<void> {
    const pending = scope.isDirect ? [] : this.buffer.drain(scope.conversationId);
    const memory = this.memory(scope.memoryKey);
    const speaker = message.senderName ?? message.senderId.slice(0, 8);

    const remembered = await memory.renderContext([message.senderId]);
    const parts: string[] = [];
    if (remembered) {
      parts.push(`## 你记得的 ${speaker}\n\n${remembered}`);
    }
    const isOwner = this.config.ownerOpenids.includes(message.senderId);
    if (isOwner) {
      parts.push(OWNER_MODE);
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

    const buildMessages = (body: string, withImages: boolean): ChatMessage[] => [
      { role: 'system', content: system },
      {
        role: 'user',
        content:
          withImages && imageParts.length > 0
            ? [{ type: 'text' as const, text: body }, ...imageParts]
            : body,
      },
    ];

    const send = async (raw: string): Promise<boolean> => {
      const cleaned = raw.replace(/^\s*\[SILENT\]\s*$/i, '').trim();
      if (!cleaned) {
        return false;
      }
      // 主人可以长；群里仍然限制条数免得刷屏
      const chunks = isOwner
        ? splitReply(cleaned, 3000, 4, true)
        : splitReply(cleaned);
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
        images: imageParts.length,
      });
      return true;
    };

    const opts = {
      ...this.config.llm,
      purpose: 'chat' as const,
      conversationId: scope.conversationId,
      speaker,
      // 主人问正经事：让它完整推理，别为了省几百毫秒把思考关掉
      ...(isOwner ? { disableThinking: false, timeoutMs: 120_000 } : {}),
    };
    const chatId = scope.isDirect ? undefined : scope.conversationId;

    try {
      const reply = await this.converse(buildMessages(userText, true), opts, chatId, isOwner ? 6 : 3);
      await send(reply);
    } catch (error) {
      // 带图请求失败（模型不支持 / 图太大被拒）就退回文字描述，别整条哑掉
      if (imageParts.length === 0) {
        this.log.error('回复失败', { conversationId: scope.conversationId, error });
        return;
      }
      this.log.warn('带图对话失败，退回文字描述重试', {
        conversationId: scope.conversationId,
        images: imageParts.length,
        error,
      });
      try {
        const captions = await this.enrich(message, message.attachments ?? []);
        const fallbackBody = `${userText}\n${captions}`.trim();
        const reply = await this.converse(buildMessages(fallbackBody, false), opts, chatId, isOwner ? 6 : 3);
        await send(reply);
      } catch (retryError) {
        this.log.error('回复失败（退化后）', { conversationId: scope.conversationId, error: retryError });
      }
    }
  }

  /** 让后续的记忆归纳任务能拿到同一个 store。 */
  memoryFor(groupOpenid: string): GroupMemory {
    return this.memory(groupOpenid);
  }
}
