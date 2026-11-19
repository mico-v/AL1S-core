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
import { matchCommand, matchGoalCommand, renderStatus } from './commands.js';
import { GroupBuffer, renderBuffer } from './context.js';
import { DigestEngine } from './digest.js';
import { judgeProactive } from './proactive.js';
import { QuoteResolver } from './quote.js';
import { backgroundPauseUntil, currentQuota, renderQuota } from './quota.js';
import {
  chatComplete,
  chatCompleteRaw,
  type ChatMessage,
  type ChatResponse,
  type ContentPart,
  type LlmOptions,
} from './llm.js';
import { GroupMemory } from './memory.js';
import { CONTEXT_FOOTER, CONTEXT_HEADER, resolvePersona } from './persona.js';
import { capabilitiesFor, describeTier, resolveTier, type PolicyConfig, type Tier } from './policy.js';
import { RecordStore } from './records.js';
import { GoalStore, canContinue, goalBrief, nextSlice, renderGoal } from './goals.js';
import { CnbClient, readCnbConfig } from './cnb.js';
import { cleanQQText } from './text.js';
import { parseBlacklist } from './exec.js';
import { executeTool, toolDefinitionsFor, type ToolContext } from './tools.js';

import { Workspace } from './workspace.js';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { captionStorePath, digestAttachments, loadImageParts } from './vision.js';

/**
 * 找出最近几次回复里重复使用的起手式（同一个词出现 ≥2 次）。
 *
 * 「换个说法」这种提醒模型会当耳旁风；必须点名是哪个词、用了几次，
 * 它才会真的换。实测同一个字连用 32/45 次就是这么来的。
 */
export function repeatedOpener(openers: string[]): { word: string; count: number } | undefined {
  const counts = new Map<string, number>();
  for (const word of openers) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  let best: { word: string; count: number } | undefined;
  for (const [word, count] of counts) {
    if (count >= 2 && (!best || count > best.count)) {
      best = { word, count };
    }
  }
  return best;
}

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
  /** 权限分档、代码工作区、工程群。 */
  policy: PolicyConfig;
  /** 一条消息最多几轮「模型→工具」往返。开发类问题要读十几个文件，刻意给得宽。 */
  toolRounds: number;
  /** 一条消息的总时间预算（毫秒）：真正的闸门是时间，不是轮数。 */
  turnBudgetMs: number;
  /** 持续目标：切片账本 + 自动续跑。 */
  goals: {
    enabled: boolean;
    /** 自动续跑（没有任何人发话也自己往下推）。 */
    auto: boolean;
    /** 两轮自动续跑之间至少隔多久，给群友插话的机会。 */
    gapMs: number;
    maxRounds: number;
    maxWallMs: number;
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
    policy: {
      ownerOpenids: list(env.AGENT_OWNER_OPENIDS),
      devOpenids: list(env.AGENT_DEV_OPENIDS),
      devGroups: list(env.AGENT_DEV_GROUPS),
      codeTools: env.AGENT_CODE_TOOLS !== 'false',
      workspace: env.AGENT_WORKSPACE ?? '/srv/kei/work',
      repo: env.AGENT_REPO ?? 'campus-nav-3d',
      repoSlug: env.AGENT_REPO_SLUG ?? 'mico-v/campus-nav-3d',
      // 黑名单模式：默认空 = 全部放行；收紧时只改 .env，不改代码
      cmdBlacklist: parseBlacklist(env.AGENT_CMD_BLACKLIST),
    },
    toolRounds: Number(env.AGENT_TOOL_ROUNDS ?? 40) || 40,
    turnBudgetMs: Number(env.AGENT_TURN_BUDGET_MS ?? 300_000) || 300_000,
    goals: {
      enabled: env.AGENT_GOAL_ENABLED !== 'false',
      auto: env.AGENT_GOAL_AUTO === 'true',
      gapMs: Number(env.AGENT_GOAL_GAP_MS ?? 90_000) || 90_000,
      maxRounds: Number(env.AGENT_GOAL_MAX_ROUNDS ?? 12) || 12,
      maxWallMs: Number(env.AGENT_GOAL_MAX_WALL_MS ?? 4 * 60 * 60 * 1000) || 4 * 60 * 60 * 1000,
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

/**
 * 这条消息是不是「@ 专用事件」推来的。
 *
 * 群主没开「允许机器人接收全部消息」时，QQ 只投递 @ 消息，
 * 事件是 GROUP_AT_MESSAGE_CREATE —— 而且**会把 @ 从正文里剥掉**，
 * mentions 也可能是空的。所以这种事件本身就等于「有人在叫她」。
 */
export function isAtEvent(message: QQBotInboundMessage): boolean {
  return (message as unknown as { rawEventType?: string }).rawEventType === 'GROUP_AT_MESSAGE_CREATE';
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
export const MAX_REPLY_CHARS = 1500;

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

  // 条数超限：按总字数均分成 maxChunks 组。
  // 不丢内容，也不至于把一段完整回答拆成二十条刷屏。
  const total = nonEmpty.join('\n').length;
  const per = Math.ceil(total / maxChunks);
  const buckets: string[] = [];
  let current = '';
  for (const part of nonEmpty) {
    const next = current ? `${current}\n${part}` : part;
    // 到了最后一格就全吃进 current，保证不丢内容、条数不超限
    if (buckets.length >= maxChunks - 1) {
      current = next;
      continue;
    }
    if (current && next.length > per) {
      buckets.push(current);
      current = part;
    } else {
      current = next;
    }
  }
  if (current) {
    buckets.push(current);
  }
  return buckets;
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
  /** 每个会话最近几次的开头词，用来提醒别重复同一个起手式 */
  private readonly recentOpeners = new Map<string, string[]>();
  /** 已处理过的 messageId，防止同一条消息被事件与全量通道投递两次 */
  private readonly handled = new Set<string>();
  /** 引用解析：从 chat-log 增量建索引，重启不丢 */
  private readonly quotes: QuoteResolver;
  /** 每个会话最后一句回复（引用不到时当候选，明确标注不确定） */
  private readonly lastReply = new Map<string, { text: string; at: number }>();
  /** 同一会话串行处理，避免同一群里两条 @ 并发抢回复。 */
  private readonly chains = new Map<string, Promise<void>>();
  /** 代码工作区：只有开了代码工具才存在。 */
  private readonly workspace?: Workspace;
  /** 每个群一个记录本（直接对话也一个）。 */
  private readonly recordStores = new Map<string, RecordStore>();
  private readonly goalStores = new Map<string, GoalStore>();
  /** 待执行的自动续跑定时器（每群最多一个）。 */
  private readonly goalTimers = new Map<string, NodeJS.Timeout>();
  /** 正在跑自动续跑的群，防止重入。 */
  private readonly goalRunning = new Set<string>();
  private readonly cnb?: CnbClient;

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
    this.quotes = new QuoteResolver(config.dataRoot);
    if (config.policy.codeTools) {
      this.workspace = new Workspace(
        config.policy.workspace,
        config.policy.repo,
        config.policy.repoSlug,
        homedir(),
      );
    }
    // CNB 通道：没配令牌就不挂工具（模型看不到就不会去试）
    const cnbConfig = readCnbConfig(process.env);
    if (cnbConfig) {
      this.cnb = new CnbClient(cnbConfig, log);
    }
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
    const pausedUntil = await backgroundPauseUntil(this.config.llm, this.log);
    if (pausedUntil > Date.now()) {
      this.log.debug('配额未恢复，跳过摘要巡检', { until: new Date(pausedUntil).toISOString() });
      return 0;
    }
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
    const pausedUntil = await backgroundPauseUntil(this.config.llm, this.log);
    if (pausedUntil > Date.now()) {
      this.log.debug('配额未恢复，跳过主动巡检', { until: new Date(pausedUntil).toISOString() });
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
   * 上限有两个：轮数（`AGENT_TOOL_ROUNDS`，默认 40）与时间（`AGENT_TURN_BUDGET_MS`，
   * 默认 5 分钟）。轮数是防死循环的粗网，真正拦住跑飞的是时间预算 ——
   * 开发类任务读十几个文件很正常，卡死在 5 轮只会把活切成两份让人追问。
   * 两个都得有个头：不然一条群消息能把队列堵一下午。
   */
  private async converse(
    messages: ChatMessage[],
    opts: LlmOptions,
    chatId?: string,
    maxRounds = 40,
    access: { tier: Tier; speaker: string } = { tier: 'guest', speaker: '' },
  ): Promise<string> {
    if (!this.config.toolsEnabled) {
      return this.complete(messages, opts, 1);
    }

    const caps = capabilitiesFor(access.tier, this.config.policy);
    const tools = toolDefinitionsFor(caps);
    const ctx: ToolContext = {
      dataRoot: this.config.dataRoot,
      // 私聊没有群 id，就搜全部历史，否则会一条都搜不到
      groupId: chatId,
      log: this.log,
      complete: this.complete,
      llm: { ...this.config.llm, purpose: 'expand' },
      tier: access.tier,
      capabilities: caps,
      cmdBlacklist: this.config.policy.cmdBlacklist,
      workspace: caps.repoRead ? this.workspace : undefined,
      records: this.recordsFor(chatId ?? 'direct'),
      goals: this.config.goals.enabled ? this.goalStoreFor(chatId ?? 'direct') : undefined,
      cnb: caps.repoWrite ? this.cnb : undefined,
      speaker: access.speaker,
    };

    let convo = [...messages];
    const deadline = Date.now() + this.config.turnBudgetMs;
    // 同一组调用重复出现 = 模型在原地打转，再给工具也是空转
    const repeats = new Map<string, number>();
    for (let round = 0; round < maxRounds; round += 1) {
      if (Date.now() > deadline) {
        this.log.warn('时间预算用完，强制收尾', {
          conversationId: opts.conversationId,
          round,
          budgetMs: this.config.turnBudgetMs,
        });
        return this.wrapUp(convo, opts);
      }
      const response = await this.completeRaw(convo, { ...opts, tools }, 1);
      if (response.toolCalls.length === 0) {
        return response.content;
      }
      const signature = response.toolCalls
        .map((call) => `${call.function.name}:${call.function.arguments}`)
        .join('|');
      const times = (repeats.get(signature) ?? 0) + 1;
      repeats.set(signature, times);
      if (times >= 3) {
        this.log.warn('工具调用原地打转，强制收尾', { conversationId: opts.conversationId, round });
        return this.wrapUp(convo, opts);
      }
      this.log.info('工具调用', {
        round,
        tools: response.toolCalls.map((call) => call.function.name),
        conversationId: opts.conversationId,
      });
      convo = [
        ...convo,
        {
          role: 'assistant',
          content: response.content,
          tool_calls: response.toolCalls,
          // 手册：带 tools 的请求里，assistant 消息必须把思维链原样回传
          ...(response.reasoningContent ? { reasoning_content: response.reasoningContent } : {}),
        },
      ];
      for (const call of response.toolCalls) {
        const output = await executeTool(call.function.name, call.function.arguments, ctx);
        convo = [...convo, { role: 'tool', tool_call_id: call.id, content: output }];
      }
    }

    // 轮数用完还没收敛：要一次纯文本，别把 tool_calls 暴露给群友
    this.log.warn('工具轮数用尽，强制收尾', { conversationId: opts.conversationId, rounds: maxRounds });
    return this.wrapUp(convo, opts);
  }

  /**
   * 收尾：不要再给工具，只要一句结论。
   *
   * 之前这里是直接 `complete()`：模型还想调工具、或者思考把预算吃光，
   * 拿到的就是空正文，`chatComplete` 抛错，整条消息就吐不出来了（2026-11-19 真事）。
   * 现在明确告诉它工具阶段结束，并关掉思考 —— 只要文本。
   */
  private async wrapUp(convo: ChatMessage[], opts: LlmOptions): Promise<string> {
    const nudge: ChatMessage = {
      role: 'user',
      content: '（系统）工具调用阶段结束。现在只用一两句话给结论：已经确认了什么、下一步建议怎么做。不要再调用任何工具。',
    };
    try {
      const text = await this.complete([...convo, nudge], { ...opts, tools: undefined, disableThinking: true }, 1);
      if (text.trim()) {
        return text;
      }
    } catch (error) {
      this.log.warn('收尾失败', { conversationId: opts.conversationId, error });
    }
    return '这条我做到一半就卡住了（工具回合用完了还没跑完），你把要的结果再说细一点，我重新跑一遍。';
  }

  /**
   * 整轮失败时也要出个声。
   *
   * 不发声等于「发了条消息没反应」—— 2026-11-19 就发生过一次：模型返回空正文，
   * 日志里有 error，群里什么都没有，主人只能来问我。宁可说一句卡住了。
   */
  private async notifyFailure(send: (text: string) => Promise<boolean>, conversationId: string): Promise<void> {
    try {
      await send('这条我这边卡住了（模型没返回可用内容），稍后再 @ 我一次试试。');
    } catch (error) {
      this.log.warn('失败提示也没发出去', { conversationId, error });
    }
  }

  private memory(groupOpenid: string): GroupMemory {
    let store = this.members.get(groupOpenid);
    if (!store) {
      store = new GroupMemory(this.config.dataRoot, groupOpenid);
      this.members.set(groupOpenid, store);
    }
    return store;
  }

  /** 记录本按会话分开：群用自己的 openid，私聊用 direct。 */
  private recordsFor(key: string): RecordStore {
    let store = this.recordStores.get(key);
    if (!store) {
      store = new RecordStore(this.config.dataRoot, key);
      this.recordStores.set(key, store);
    }
    return store;
  }

  private goalStoreFor(key: string): GoalStore {
    let store = this.goalStores.get(key);
    if (!store) {
      store = new GoalStore(this.config.dataRoot, key);
      this.goalStores.set(key, store);
    }
    return store;
  }

  /** 取消排队中的自动续跑（有人说话、或目标已收尾时）。 */
  private cancelGoalTick(chatId: string): void {
    const timer = this.goalTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.goalTimers.delete(chatId);
      this.log.debug('取消自动续跑', { conversationId: chatId });
    }
  }

  /**
   * 回合结束后安排下一轮自动续跑。
   *
   * 四道闸门：开关、工程群、目标状态/预算、每群只排一个。
   * 目的不是让它自己无限干活，而是让长活跨过上下文窗口不断线 ——
   * 所以轮数与墙钟都由预算管，到点就停，等人接手。
   */
  private scheduleGoalTick(scope: Scope, bot: Bot): void {
    if (!this.config.goals.enabled || !this.config.goals.auto || scope.isDirect) {
      return;
    }
    const chatId = scope.conversationId;
    if (!this.config.policy.devGroups.includes(chatId)) {
      return;
    }
    if (this.goalTimers.has(chatId) || this.goalRunning.has(chatId)) {
      return;
    }
    const store = this.goalStoreFor(chatId);
    void (async () => {
      const goal = await store.read();
      if (!goal) {
        return;
      }
      const verdict = canContinue(goal, {
        maxRounds: this.config.goals.maxRounds,
        maxWallMs: this.config.goals.maxWallMs,
      });
      if (!verdict.ok) {
        this.log.info('不续跑', { conversationId: chatId, reason: verdict.reason });
        return;
      }
      if (this.goalTimers.has(chatId) || this.goalRunning.has(chatId)) {
        return;
      }
      const timer = setTimeout(() => {
        this.goalTimers.delete(chatId);
        void this.runGoalTick(scope, bot).catch((error) =>
          this.log.warn('自动续跑失败', { conversationId: chatId, error }),
        );
      }, this.config.goals.gapMs);
      timer.unref();
      this.goalTimers.set(chatId, timer);
      this.log.info('安排自动续跑', {
        conversationId: chatId,
        gapMs: this.config.goals.gapMs,
        slice: nextSlice(goal)?.id,
      });
    })();
  }

  /** 跑一轮自动续跑：记预算 → 把「继续推下一片」当成一条消息走完整回合。 */
  private async runGoalTick(scope: Scope, bot: Bot): Promise<void> {
    const chatId = scope.conversationId;
    if (this.goalRunning.has(chatId)) {
      return;
    }
    this.goalRunning.add(chatId);
    let keepGoing = false;
    try {
      const store = this.goalStoreFor(chatId);
      const tick = await store.tick({
        maxRounds: this.config.goals.maxRounds,
        maxWallMs: this.config.goals.maxWallMs,
      });
      if (!tick) {
        return;
      }
      if (!tick.ok) {
        this.log.info('自动续跑停止', { conversationId: chatId, reason: tick.reason });
        return;
      }
      const goal = tick.goal;
      const slice = nextSlice(goal);
      const text =
        `（自动续跑 ${goal.budget.rounds}/${goal.budget.maxRounds}）接着推目标：${goal.objective.slice(0, 120)}\n` +
        `这一轮只做一片 —— ${slice ? `${slice.id} ${slice.title}` : '没有待办切片'}。` +
        '做完就 goal_step 标进度，做完所有切片再 goal_finish，卡住就 goal_block。';
      // 用主人的身份跑，否则降成 guest 就什么工具都没了
      const synthetic = {
        kind: 'group',
        groupOpenid: chatId,
        senderId: this.config.ownerOpenids[0] ?? goal.by ?? '',
        senderName: '（goal 自动续跑）',
        senderIsBot: false,
        content: text,
        messageId: `goal-${goal.id}-${goal.budget.rounds}`,
      } as unknown as QQBotInboundMessage;
      this.log.info('自动续跑开跑', { conversationId: chatId, round: goal.budget.rounds, slice: slice?.id });
      await this.reply(synthetic, bot, scope, text);
      keepGoing = true;
    } finally {
      this.goalRunning.delete(chatId);
      if (keepGoing) {
        this.scheduleGoalTick(scope, bot);
      }
    }
  }

  /** 记下这次的开头词（前 1-3 个字）。 */
  private noteOpener(conversationId: string, text: string): void {
    const match = /^[\s「"'（(]*([^\s，。！？,.!?~～]{1,3})/.exec(text);
    const opener = match?.[1] ?? text.slice(0, 2);
    if (!opener) {
      return;
    }
    const list = this.recentOpeners.get(conversationId) ?? [];
    list.push(opener);
    if (list.length > 3) {
      list.splice(0, list.length - 3);
    }
    this.recentOpeners.set(conversationId, list);
  }

  /** 白名单外的群：每 6 小时提示一次，避免刷屏。 */
  private noteUnlistedGroup(groupOpenid: string, message: QQBotInboundMessage): void {
    this.modes.drop += 1;
    const key = `unlisted:${groupOpenid}`;
    const last = this.lastProactiveAt.get(key) ?? 0;
    if (Date.now() - last < 6 * 3600_000) {
      return;
    }
    this.lastProactiveAt.set(key, Date.now());
    this.log.info('群不在白名单，只记录不回复', {
      groupOpenid,
      sender: message.senderName ?? message.senderId.slice(0, 8),
      text: (message.content ?? '').slice(0, 40),
      hint: '要启用请把 group_openid 加进 AGENT_GROUPS',
    });
  }

  /** 这条消息引用了谁、引用了什么。查 chat-log 里的 msgIdx。 */
  private async resolveQuote(
    groupId: string,
    message: QQBotInboundMessage,
  ): Promise<{ sender: string; text: string } | undefined> {
    const ref = (message as unknown as { refMsgIdx?: unknown }).refMsgIdx;
    if (typeof ref !== 'string' || !ref) {
      return undefined;
    }
    const hit = await this.quotes.resolve(groupId, ref);
    return hit ? { sender: hit.sender, text: hit.text } : undefined;
  }

  /**
   * 引用了一条我这边没有的消息时给模型的提示。
   *
   * QQ 不回投 bot 自己的消息，所以大量「引用 Kei 的话再 @ 她」的引用是解析不到的。
   * 如果对方刚在我上一句之后不久发问，大概率就是在接那句 —— 给出来，但标明是猜测。
   */
  private unresolvedQuoteHint(conversationId: string): string {
    const last = this.lastReply.get(conversationId);
    if (last && Date.now() - last.at < 5 * 60_000) {
      return `（对方引用了一条我看不到的消息，很可能是我刚才说的「${last.text.slice(0, 50)}」；按这个理解答，拿不准就问一句）`;
    }
    return '（引用了一条我看不到的消息：可能是我更早说的，也可能我没收到；不确定就问对方指的是哪句，别猜）';
  }

  /** 有没有引用（不管能不能解析）：解析不到时要明确告诉模型，不许猜。 */
  private hasQuoteRef(message: QQBotInboundMessage): boolean {
    const ref = (message as unknown as { refMsgIdx?: unknown }).refMsgIdx;
    return typeof ref === 'string' && ref.length > 0;
  }

  private resolveScope(message: QQBotInboundMessage): Scope | undefined {
    if (message.kind === 'group') {
      const groupOpenid = message.groupOpenid;
      if (!groupOpenid) {
        return undefined;
      }
      if (this.config.groupAllowlist.length > 0 && !this.config.groupAllowlist.includes(groupOpenid)) {
        // 不在白名单：不回复，但要让运维看得见「有个新群在说话」。
        // 消息本身已经由 chat-log 落盘了（那层与白名单无关）。
        this.noteUnlistedGroup(groupOpenid, message);
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
    // 有人说话就是最高优先级：先把排队中的自动续跑取消，等这一轮完再安排
    if (!scope.isDirect) {
      this.cancelGoalTick(scope.conversationId);
    }

    const raw = (message.content ?? '').trim();
    const withoutMentions = raw.replace(/<@!?[0-9A-Fa-f]{16,}>/g, '').trim();
    const text = cleanQQText(raw);
    const attachments = message.attachments ?? [];
    const hasAttachments = attachments.length > 0;

    if (message.senderIsBot) {
      // 自己说过的话也要留在缓冲里：否则下一句被追问「你刚才说什么」，直接断片
      if (this.config.botOpenids.includes(message.senderId)) {
        const said = text || '（发了条消息）';
        this.buffer.push(scope.conversationId, {
          senderName: this.config.botUsernames[0] ?? 'Kei',
          text: said,
          timestamp: Date.now(),
          messageId: message.messageId,
          isSelf: true,
        });
        this.modes.store += 1;
      } else {
        this.modes.drop += 1;
      }
      return;
    }
    if (!text && !hasAttachments) {
      this.modes.drop += 1;
      return;
    }
    // 自己的指令：不走模型，立刻回
    const command = matchCommand(withoutMentions);    if (command !== undefined) {
      const body = await renderStatus({
        chatId: scope.conversationId,
        dataRoot: this.config.dataRoot,
        bufferLines: scope.isDirect ? 0 : this.buffer.peek(scope.conversationId).length,
        bufferLimit: this.config.contextSize,
        model: this.config.llm.model,
        contextWindow: this.config.callLog.contextWindow,
        startedAt: this.startedAt,
        modes: this.modes,
        quota: renderQuota(await currentQuota(this.config.llm, this.log)),
      });
      await bot.replyText(scope.replyTarget, body);
      this.log.info('指令', { command, conversationId: scope.conversationId });
      return;
    }

    // 目标指令：/goal 看状态，/goal stop 停，/goal resume 恢复。不走模型。
    if (!scope.isDirect && this.config.goals.enabled) {
      const goalCommand = matchGoalCommand(withoutMentions);
      if (goalCommand) {
        const store = this.goalStoreFor(scope.conversationId);
        let body: string;
        if (goalCommand === 'stop') {
          this.cancelGoalTick(scope.conversationId);
          body = await store.cancel(`/goal stop（${message.senderName ?? '某人'}）`);
        } else if (goalCommand === 'resume') {
          body = await store.resume();
        } else {
          const goal = await store.read();
          body = goal
            ? renderGoal(goal)
            : '这个群还没有目标。要立就用 goal_create（正文 + 判据 + 3~5 片），或者直接说「把这个做成目标」。';
        }
        await bot.replyText(scope.replyTarget, body);
        this.log.info('目标指令', { command: goalCommand, conversationId: scope.conversationId });
        return;
      }
    }

    // 别的机器人的命令（@课表Bot /课表 也算）
    if (withoutMentions.startsWith('/')) {      this.modes.drop += 1;
      this.log.debug('忽略命令类消息', { conversationId: scope.conversationId, text: withoutMentions.slice(0, 40) });
      return;
    }

    // 每条群消息都计数，累积到阈值就后台归档（不阻塞回复）
    if (!scope.isDirect && this.config.digestThreshold > 0) {
      this.digest.observe(scope.conversationId, text, Date.now());
    }

    const called = scope.isDirect || isAtEvent(message) || isBotMentioned(message, this.config);
    if (!called) {
      const imageUrls = attachments
        .filter((item) => (item.content_type ?? '').startsWith('image/') || item.url?.includes('multimedia'))
        .map((item) => item.url)
        .filter((url): url is string => Boolean(url))
        .slice(0, 3);
      const sender = message.senderName ?? message.senderId.slice(0, 8);
      const quote = await this.resolveQuote(scope.conversationId, message);
      const line = {
        senderName: sender,
        text,
        timestamp: Date.now(),
        messageId: message.messageId,
        ...addresseeOf(message, this.config),
        ...(imageUrls.length > 0 ? { imageUrls } : {}),
        ...(quote ? { quote } : {}),
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

    // 同一条消息可能从 GROUP_AT_MESSAGE_CREATE 和 GROUP_MESSAGE_CREATE 各来一次
    if (message.messageId) {
      if (this.handled.has(message.messageId)) {
        this.log.debug('重复投递，已忽略', { messageId: message.messageId });
        return;
      }
      this.handled.add(message.messageId);
      if (this.handled.size > 500) {
        const first = this.handled.values().next().value;
        if (first !== undefined) {
          this.handled.delete(first);
        }
      }
    }
    this.modes.process += 1;

    // 被 @ 的消息同样进缓冲：它不是「说完就忘」的，下一轮还会被追问
    {
      const sender = message.senderName ?? message.senderId.slice(0, 8);
      const quote = await this.resolveQuote(scope.conversationId, message);
      this.buffer.push(scope.conversationId, {
        senderName: sender,
        text,
        timestamp: Date.now(),
        messageId: message.messageId,
        ...addresseeOf(message, this.config),
        ...(quote ? { quote } : {}),
      });
    }

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
    const digest = await digestAttachments(attachments, this.config.llm, this.log, {
      ...options,
      captionStore: captionStorePath(this.config.dataRoot),
    });
    if (digest.imagesSeen > 0 || digest.imagesFailed > 0) {
      this.log.info('看图', {
        conversationId: message.groupOpenid ?? message.senderId.slice(0, 8),
        seen: digest.imagesSeen,
        failed: digest.imagesFailed,
        cached: digest.imagesCached,
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
    // 不再「用完即清」：缓冲是一条滚动上下文，当前这条排除掉就行
    const pending = scope.isDirect
      ? []
      : this.buffer.peek(scope.conversationId).filter((line) => line.messageId !== message.messageId);
    const memory = this.memory(scope.memoryKey);
    const speaker = message.senderName ?? message.senderId.slice(0, 8);

    const remembered = await memory.renderContext([message.senderId]);
    // 注意：memory 不放进 system。它在每轮都可能变，放在最前面会整段击穿提示词缓存；
    // 放到 user 消息末尾，前面的人格与群聊记录就能命中缓存。
    const parts: string[] = [];
    // 怎么答由模型自己判断（人格里已经写清楚了），代码不预分类
    if (scope.isDirect) {
      parts.push('## 提示\n\n现在是私聊，不是群里，可以放开一点聊。');
    }

    // 权限与能力：写在提示词里，模型才不会去碰它没有的工具
    const tier = resolveTier(
      message.senderId,
      scope.isDirect ? undefined : scope.conversationId,
      this.config.policy,
    );
    parts.push(`## 你的身份与边界\n\n${describeTier(tier)}`);
    if (tier !== 'guest' && this.workspace) {
      parts.push(
        `## 工作区\n\n${this.workspace.describe()}\n` +
          '动作顺序：先 repo_status 看清现状 → 读相关文件 → 改 → 跑测试 → 按时张提交 → 推分支开 PR。main 不直推。',
      );
    }
    const brief = await this.recordsFor(scope.isDirect ? 'direct' : scope.conversationId).brief();
    if (brief) {
      parts.push(`## 记录本摘要（开场先心里有数，不用逐条念）\n\n${brief}`);
    }

    // 当前目标：长活的切片账本。每轮只推一片，不然会一口气做完就断在半路。
    if (this.config.goals.enabled) {
      const goal = await this.goalStoreFor(scope.isDirect ? 'direct' : scope.conversationId).read();
      if (goal && goal.status !== 'cancelled') {
        parts.push(
          `## 当前目标\n\n${goalBrief(goal)}\n\n` +
            '一轮只推一片：看清现状 → 做 → 自己验 → goal_step 标进度（done/review/blocked 都要一句结论与出处）。' +
            '所有切片都验过才 goal_finish；缺权限或等人拍板就 goal_block，别硬往下做。',
        );
      }
    }

    // 连着几次都用同一个词开头，一眼就是模板；点名那个词，别只说「换个说法」
    const openers = this.recentOpeners.get(scope.conversationId) ?? [];
    const repeated = repeatedOpener(openers);
    if (repeated) {
      parts.push(
        `## 别重复自己\n\n你最近 ${openers.length} 次是这样开头的：「${openers.join('」「')}」。` +
          `其中「${repeated.word}」已经用了 ${repeated.count} 次 —— 这次不要用「${repeated.word}」开头，` +
          '直接从一个动作、一句判断或一句追问切进去；结尾也别每次都挂同一个表情。',
      );
    }

    const system = [resolvePersona(scope.isDirect ? undefined : scope.conversationId, this.config.dataRoot), ...parts].join(
      '\n\n---\n\n',
    );
    const history = renderBuffer(pending);
    const now = new Date();
    const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const quoted = scope.isDirect ? undefined : await this.resolveQuote(scope.conversationId, message);
    const quotedPrefix = quoted
      ? `（回 ${quoted.sender}「${quoted.text.slice(0, 60)}」）`
      : !scope.isDirect && this.hasQuoteRef(message)
        ? this.unresolvedQuoteHint(scope.conversationId)
        : '';
    const current = `[${stamp}] ${speaker}${scope.isDirect ? '' : ' → Kei'}：${quotedPrefix}${text}`;
    const memoryBlock = remembered ? `## 你记得的 ${speaker}\n\n${remembered}\n\n` : '';
    const userText = history
      ? `${CONTEXT_HEADER}\n${history}\n${CONTEXT_FOOTER}\n\n${memoryBlock}${current}`
      : `${memoryBlock}${current}`;

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

    const startedAt = Date.now();
    const send = async (raw: string): Promise<boolean> => {
      const cleaned = raw.replace(/^\s*\[SILENT\]\s*$/i, '').trim();
      if (!cleaned) {
        // 她选择不说话也要留痕，否则「没叫她」和「叫了但沉默」分不清
        await this.recordReply(scope.conversationId, speaker, '', 0, {
          silent: true,
          ms: Date.now() - startedAt,
        });
        return false;
      }
      const chunks = splitReply(cleaned);
      for (let i = 0; i < chunks.length; i += 1) {
        await bot.replyText(scope.replyTarget, chunks[i] as string);
        if (i < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
      // QQ 不回投 bot 自己的消息 → 自己说的话要主动记进缓冲，否则下一轮就断片
      if (!scope.isDirect) {
        const selfName = this.config.botUsernames[0] ?? 'Kei';
        for (const chunk of chunks) {
          this.buffer.push(scope.conversationId, {
            senderName: selfName,
            text: chunk,
            timestamp: Date.now(),
            isSelf: true,
          });
        }
      }
      this.noteOpener(scope.conversationId, cleaned);
      if (!scope.isDirect) {
        this.lastReply.set(scope.conversationId, { text: cleaned, at: Date.now() });
      }
      await this.recordReply(scope.conversationId, speaker, cleaned, chunks.length, {
        ms: Date.now() - startedAt,
      });
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
      // 思考与超时走配置（AGENT_DISABLE_THINKING / AGENT_TIMEOUT_MS），
      // 不按消息类型切换 —— 怎么答交给模型判断
    };
    const chatId = scope.isDirect ? undefined : scope.conversationId;

    try {
      const reply = await this.converse(buildMessages(userText, true), opts, chatId, this.config.toolRounds, {
        tier,
        speaker,
      });
      await send(reply);
      // 回合结束：还有目标就安排下一轮自动续跑（人一插话就会被取消）
      this.scheduleGoalTick(scope, bot);
    } catch (error) {
      // 带图请求失败（模型不支持 / 图太大被拒）就退回文字描述，别整条哑掉
      if (imageParts.length === 0) {
        this.log.error('回复失败', { conversationId: scope.conversationId, error });
        await this.notifyFailure(send, scope.conversationId);
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
        const reply = await this.converse(buildMessages(fallbackBody, false), opts, chatId, this.config.toolRounds, {
          tier,
          speaker,
        });
        await send(reply);
      } catch (retryError) {
        this.log.error('回复失败（退化后）', { conversationId: scope.conversationId, error: retryError });
        await this.notifyFailure(send, scope.conversationId);
      }
    }
  }

  /** 把自己的回复落一行，供每日体检取样本（chat-log 里没有 bot 自己的话）。 */
  private async recordReply(
    chatId: string,
    speaker: string,
    text: string,
    chunks: number,
    extra: { silent?: boolean; ms?: number } = {},
  ): Promise<void> {
    // 自检/试跑用假模型，不该把测试数据写进真实样本
    if (process.env.AGENT_REPLY_LOG === 'false') {
      return;
    }
    try {
      const dir = path.join(this.config.dataRoot, 'replies');
      await mkdir(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      await appendFile(
        path.join(dir, `${day}.jsonl`),
        `${JSON.stringify({
          at: new Date().toISOString(),
          chatId,
          speaker,
          text,
          chars: text.length,
          chunks,
          silent: extra.silent ?? false,
          ms: extra.ms ?? 0,
        })}\n`,
        'utf8',
      );
    } catch (error) {
      this.log.warn('回复落盘失败', { error });
    }
  }

  /** 让后续的记忆归纳任务能拿到同一个 store。 */
  memoryFor(groupOpenid: string): GroupMemory {
    return this.memory(groupOpenid);
  }
}
