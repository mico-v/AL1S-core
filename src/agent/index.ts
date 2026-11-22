/**
 * 群聊 agent 编排层。
 *
 * 规则：
 *   - 没被 @ → 不进模型，只进滚动缓冲；
 *   - 被 @   → 把「上次说话之后群里发生了什么」+ 说话人档案一起喂进去，回一条；
 *   - / 开头的消息是别的机器人的命令，直接忽略。
 */

import { createHash } from 'node:crypto';
import type { InteractionEvent, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
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
  reviewOptions,
  type ChatMessage,
  type ChatResponse,
  type ContentPart,
  type LlmOptions,
  type ToolCall,
} from './llm.js';
import { GroupMemory } from './memory.js';
import { SUMMARY_PREFIX, buildCompactedHistory, compactionPrompt, compactThreshold, renderForSummary, shouldCompact, type CompactOptions } from './compact.js';
import { CONTEXT_FOOTER, CONTEXT_HEADER, resolvePersona } from './persona.js';
import { capabilitiesFor, describeTier, resolveTier, type PolicyConfig, type Tier } from './policy.js';
import { RecordStore } from './records.js';
import {
  GoalStore,
  canContinue,
  describeTurn,
  goalBrief,
  nextSlice,
  renderGoal,
  shouldSelfCheck,
  watchIdleMs,
  type Goal,
  type GoalSlice,
} from './goals.js';
import { CnbClient, readCnbConfig } from './cnb.js';
import { CnbCli, readCnbCliConfig } from './cnbcli.js';
import { cleanQQText } from './text.js';
import { parseBlacklist, parseHeavyMode, runCommand } from './exec.js';
import { kindPack } from './kinds.js';
import { renderHandoff, handoffPath, shouldRotateThread, writeHandoff } from './thread.js';
import { PARALLEL_TOOLS, executeTool, toolDefinitionsFor, type ToolContext } from './tools.js';
import {
  ChoiceStore,
  MAX_CHOICE_OPTIONS,
  buildChoiceKeyboard,
  parseChoiceData,
  renderChoiceMarkdown,
  type ChoiceOption,
  type PendingChoice,
} from './choices.js';
import { buildCard, renderCardLine, type CardInput } from './cards.js';

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
  /** 干活期间的进度播报：长回合不再一声不吭。 */
  progress: {
    enabled: boolean;
    /** 两条进度之间至少隔多久。 */
    gapMs: number;
    /** 一个回合最多播报几条，防刷屏。 */
    max: number;
  };
  /** 工具输出预算：单条多大、保留几条、累计多少就瘦身。 */
  toolOutput: ToolOutputPolicy;
  /** 跨回合会话链：同一会话的消息追加推进，不每轮重渲（前缀缓存靠它）。 */
  thread: {
    /** 超过多少估算 token 就压缩一次。 */
    maxTokens: number;
    /** 一段会话最多活多久：到点写交接单、换新链，不是停工。 */
    maxAgeMs: number;
    /** 一段会话最多几轮：到点同上。 */
    maxTurns: number;
  };
  /**
   * 前几轮开思考，之后关掉。
   *
   * 账本里推理超过 500 token 的调用中位耗时 17.5s（不开思考的只有 5.6s），
   * 而工具轮的任务由工具结果限定得很死，不需要每轮从头推理。
   * -1 表示全程不干预（回到旧行为）。
   */
  thinkingRounds: number;
  /** 持续目标：切片账本 + 自动续跑。 */
  goals: {
    enabled: boolean;
    /** 自动续跑（没有任何人发话也自己往下推）。 */
    auto: boolean;
    /** 两轮自动续跑之间至少隔多久，给群友插话的机会。 */
    gapMs: number;
    maxRounds: number;
    maxWallMs: number;
    /** 探针等这么久（毫秒）还没动静就叫醒自查；0 = 不自查。 */
    probeIdleMs: number;
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
      // 全量测试/构建是 CI 的活：默认拦，别让它在 1.6G 机器上跑 167 秒的单测
      localHeavy: parseHeavyMode(env.AGENT_LOCAL_HEAVY),
    },
    toolRounds: Number(env.AGENT_TOOL_ROUNDS ?? 40) || 40,
    // 5 分钟一刀切会把活切成两半（2026-11-19 日志：14~19 轮必然撞墙），
    // 配上进度播报之后可以放心放宽到 8 分钟。
    turnBudgetMs: Number(env.AGENT_TURN_BUDGET_MS ?? 480_000) || 480_000,
    progress: {
      enabled: env.AGENT_PROGRESS !== 'false',
      gapMs: Number(env.AGENT_PROGRESS_GAP_MS ?? 75_000) || 75_000,
      max: Number(env.AGENT_PROGRESS_MAX ?? 3) || 3,
    },
    toolOutput: {
      maxChars: Number(env.AGENT_TOOL_OUTPUT_MAX ?? 4_000) || 4_000,
      keepRecent: Number(env.AGENT_TOOL_KEEP_RECENT ?? 3) || 3,
      clearAtChars: Number(env.AGENT_TOOL_CLEAR_AT ?? 14_000) || 14_000,
    },
    thinkingRounds: Number(env.AGENT_THINKING_ROUNDS ?? 2),
    thread: {
      maxTokens: Number(env.AGENT_THREAD_MAX_TOKENS ?? 60_000) || 60_000,
      // 3 小时 / 30 轮：到点交接换会话，不降能力（Humanize 实测长会话 token 缩水 30%–45%）
      maxAgeMs: Number(env.AGENT_THREAD_MAX_AGE_MS ?? 3 * 60 * 60 * 1000) || 0,
      maxTurns: Number(env.AGENT_THREAD_MAX_TURNS ?? 30) || 0,
    },
    goals: {
      enabled: env.AGENT_GOAL_ENABLED !== 'false',
      auto: env.AGENT_GOAL_AUTO === 'true',
      gapMs: Number(env.AGENT_GOAL_GAP_MS ?? 90_000) || 90_000,
      // 0 = 不按轮数限，只剩墙钟闸门（长任务跟进需要它一直跑）
      maxRounds: Number(env.AGENT_GOAL_MAX_ROUNDS ?? 0) || 0,
      maxWallMs: Number(env.AGENT_GOAL_MAX_WALL_MS ?? 12 * 60 * 60 * 1000) || 12 * 60 * 60 * 1000,
      // 30 分钟没动静就自查：NPC 可能压根没被叫醒（派工评论漏了 @ / work_mode）
      probeIdleMs: Number(env.AGENT_GOAL_PROBE_IDLE_MS ?? 30 * 60 * 1000) || 0,
    },
  };
}

export interface ToolOutputPolicy {
  /** 单条工具结果上限（字符）。 */
  maxChars: number;
  /** 最近几条原样保留。 */
  keepRecent: number;
  /** 累计多少字符就清一次；一次清完，别每轮清（每清一次都作废 KV 缓存）。 */
  clearAtChars: number;
}

const CLEARED_PREFIX = '［已清理］';

/**
 * 把老的工具结果折成一行摘要。
 *
 * Anthropic《Effective context engineering》：工具结果被调用过一阵之后模型不会再回头看原文，
 * 但它照样占着注意力与 prefill。所以最近 keepRecent 条原样留着，其余换成
 * 「头部 160 字 + 原文多少字」—— 可恢复的压缩，不是丢信息。
 */
export function pruneToolResults(
  convo: ChatMessage[],
  policy: ToolOutputPolicy,
  log?: AppLogger,
  conversationId?: string,
): ChatMessage[] {
  const toolIndexes = convo.flatMap((message, index) => (message.role === 'tool' ? [index] : []));
  if (toolIndexes.length <= policy.keepRecent) {
    return convo;
  }
  const total = toolIndexes.reduce((sum, index) => {
    const content = convo[index]?.content;
    if (typeof content !== 'string' || content.startsWith(CLEARED_PREFIX)) {
      return sum;
    }
    return sum + content.length;
  }, 0);
  if (total <= policy.clearAtChars) {
    return convo;
  }
  const keep = new Set(toolIndexes.slice(-policy.keepRecent));
  let cleared = 0;
  let freed = 0;
  const next = convo.map((message, index) => {
    if (message.role !== 'tool' || keep.has(index)) {
      return message;
    }
    const raw = typeof message.content === 'string' ? message.content : '';
    if (!raw || raw.startsWith(CLEARED_PREFIX)) {
      return message;
    }
    cleared += 1;
    freed += raw.length;
    return {
      ...message,
      content: `${CLEARED_PREFIX}${raw.slice(0, 160).replace(/\s+/g, ' ')} …（原文 ${raw.length} 字，要用就重跑一次）`,
    };
  });
  if (cleared > 0) {
    log?.info('工具输出瘦身', { conversationId, cleared, freedChars: freed, kept: policy.keepRecent });
  }
  return next;
}

/** 单条工具输出剪到上限：保留头与尾，中间标注截了多少。 */
export function clipToolOutput(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.max(0, maxChars - head - 40);
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n…（中间 ${dropped} 字已截断，要看就用更精确的命令取片段）…\n${
    tail > 0 ? text.slice(-tail) : ''
  }`;
}

/** 跨回合会话链：system 之外的完整消息，追加式推进。 */
export interface ThreadState {
  /** 建链时的 system（人格/身份/工作区），一变就重建。 */
  system: string;
  messages: ChatMessage[];
  /** 已经追进链里的最后一条群消息 id，下次只追加它之后的。 */
  lastMessageId?: string;
  /** 同一条消息的时间戳锚点：id 被 100 行窗口挤掉时按它续，不整条重建。 */
  lastAt?: number;
  turns: number;
  /** 建链时间：到了 maxAgeMs 就交接换链。 */
  bornAt: number;
  /** 上一轮尾部简报的指纹：没变就不重念（重念=每轮多烧一份未命中的新 token）。 */
  tailSig?: string;
}

/** 尾部简报的指纹：只用来判断「跟上轮一模一样吗」，不参与语义。 */
export function digestOf(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** 粗估 token：中文按 3 字/token 算，图按 2000 字等价。 */
export function approxTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    const content = message.content;
    if (typeof content === 'string') {
      chars += content.length;
    } else {
      for (const part of content) {
        chars += part.type === 'text' ? part.text.length : 2_000;
      }
    }
    if (message.reasoning_content) {
      chars += message.reasoning_content.length;
    }
  }
  return Math.round(chars / 3);
}

const COMPACT_NOTE =
  '（此前对话已归档到此。接着按记录本、当前目标与仓库现状往下推，别重问我上面已经说过的事；缺信息就去看文件或翻记录本。）';

/**
 * 只抽 pending 里还没折进链里的新行。
 *
 * 锚点先按 messageId 精确找（一条不多一条不少）；被 100 行窗口挤掉了就退回时间戳 ——
 * 这时候链里本来就装着更早的发言，按 id 找不到就整条重建等于把一两万 token 重发一遍全冷，
 * 而且工具结果、上一轮的结论全丢，模型要重新摸一遍（2026-11-21 实测 53 次/两天）。
 * 两个锚点都没有（老线程）就当作没有新行：链比缓冲更全。
 */
export function linesAfter<T extends { messageId?: string; timestamp?: number }>(
  lines: T[],
  thread: { lastMessageId?: string; lastAt?: number },
): T[] {
  const index = thread.lastMessageId ? lines.findIndex((line) => line.messageId === thread.lastMessageId) : -1;
  if (index >= 0) {
    return lines.slice(index + 1);
  }
  if (thread.lastAt) {
    return lines.filter((line) => (line.timestamp ?? 0) > (thread.lastAt ?? 0));
  }
  return [];
}

const PROGRESS_VERBS: Record<string, string> = {
  run_command: '跑命令',
  read_file: '读文件',
  write_file: '写文件',
  list_dir: '看目录',
  repo_status: '看仓库',
  ci_status: '查 CI',
  memory_query: '翻记忆',
  member_profile: '查群友档',
  goal_step: '记进度',
  goal_watch: '挂探针',
  goal_status: '看目标',
};

function progressArg(raw: string): string {
  try {
    const args = JSON.parse(raw || '{}') as Record<string, unknown>;
    const pick = args.cmd ?? args.path ?? args.query ?? args.title ?? args.slice ?? args.issue;
    return typeof pick === 'string' ? pick.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  } catch {
    return '';
  }
}

/**
 * 探针等太久的自查单。
 *
 * 最常见的情况不是 NPC 慢，而是它压根没被叫醒：派工评论走了裸 `cnb issues comment`，
 * 没带 @CodeBuddy + work_mode。所以先查这个，再谈等。
 */
export function selfCheckNotice(issue: number, minutes: number): string {
  return [
    `#${issue} 已经等了 ${minutes} 分钟，一点变化都没有 —— 先自查，别接着空等：`,
    `1) cnb_issue_get #${issue} 看最近那条派工评论：有没有 @CodeBuddy、发的时候带没带 work_mode。` +
      '没带就用 cnb_issue_dispatch 重派一次（裸评论 NPC 不会下场）。',
    '2) 看对应 PR 是不是还挂在旧 base 上：是就直接推 fix/ 分支并在 issue 里重派，别等 NPC 自己发现。',
    '3) 顺手看别的 todo 切片能不能先起：能并行就一次派 2~3 片，别串着等。',
  ].join('\n');
}

/** 一行进度：「⏳ 第 8 步 · 跑命令：npm test」。 */
export function describeProgress(round: number, calls: ToolCall[]): string {
  if (calls.length === 0) {
    return '';
  }
  const first = calls[0];
  if (!first) {
    return '';
  }
  const verb = PROGRESS_VERBS[first.function.name] ?? first.function.name;
  const arg = progressArg(first.function.arguments);
  const more = calls.length > 1 ? ` 等 ${calls.length} 个动作` : '';
  return `⏳ 第 ${round} 步 · ${verb}${arg ? `：${arg}` : ''}${more}`;
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

/**
 * 这条消息是「主人点了选项按钮」合成出来的。
 *
 * 它没有 @ 也没有 mention，但必须进模型：点按钮就是回答，
 * 当成普通群消息丢进缓冲等于没听见。
 */
export function isChoiceMessage(message: QQBotInboundMessage): boolean {
  return (message as unknown as { rawEventType?: string }).rawEventType === 'CHOICE_INTERACTION';
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
  /** 待选选项卡片（按钮），按会话分开。 */
  private readonly choiceStores = new Map<string, ChoiceStore>();
  /**
   * 每个群里「主人 / 开发成员」的 member_openid。
   *
   * 群里的 id 是 member_openid，和单聊的 user_openid 不是同一个值；
   * 只能从「已经认出来的人说过话」里学，学不到就不限按钮、靠 tier 拦。
   */
  private readonly ownerIdsByChat = new Map<string, Set<string>>();
  /** 待执行的自动续跑定时器（每群最多一个）。 */
  private readonly goalTimers = new Map<string, NodeJS.Timeout>();
  /** 正在跑自动续跑的群，防止重入。 */
  private readonly goalRunning = new Set<string>();
  /** 每个会话正在跑几个回合：>0 说明有活干，残留标记不算被打断。 */
  private readonly turnDepth = new Map<string, number>();
  /** 每个会话最外层回合的 id：收尾时只清自己那一笔。 */
  private readonly turnIds = new Map<string, string>();
  /** 上次不续跑的原因：同一条理由不重复刷日志。 */
  private readonly goalStopReason = new Map<string, string>();
  /** 已经发过「预算用满」提示的目标，一个目标只说一次。 */
  private readonly goalNotices = new Set<string>();
  /** 每个会话的追加式消息链（不含 system），跨回合复用前缀缓存。 */
  private readonly threads = new Map<string, ThreadState>();
  private readonly cnb?: CnbClient;
  /** CNB 官方 CLI + 官方 skill 文档。 */
  private readonly cnbCli?: CnbCli;

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
      // 官方 CLI：同一份令牌，跑全模块命令（issue / PR / CI / 附件 / 知识库 / TAPD）
      const cliConfig = readCnbCliConfig(process.env, cnbConfig);
      if (cliConfig) {
        this.cnbCli = new CnbCli(cliConfig, log);
      }
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
          await this.deliver(
            bot,
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
    access: {
      tier: Tier;
      speaker: string;
      onProgress?: (line: string) => void | Promise<void>;
      /** 回合结束后把完整对话交回去，供跨回合续用（前缀缓存靠它）。 */
      onConvo?: (convo: ChatMessage[], text: string) => void;
      /** 发选项卡片（主人档才有）；不传就是没这个能力。 */
      askChoice?: (input: { question: string; options: ChoiceOption[] }) => Promise<string>;
      /** 发图文卡片（开发档以上才有）。 */
      sendCard?: (input: CardInput) => Promise<string>;
    } = {
      tier: 'guest',
      speaker: '',
    },
  ): Promise<string> {
    // 留痕：这一轮如果被重启打断，回来时才知道有活没干完（否则群里就是干到一半人没了）
    if (chatId) {
      await this.beginTurn(chatId);
    }
    try {
      return await this.converseRounds(messages, opts, chatId, maxRounds, access);
    } finally {
      if (chatId) {
        await this.endTurn(chatId);
      }
    }
  }

  /** 回合开始：同一个会话嵌套/并行时只在最外层落标记。 */
  private async beginTurn(chatId: string): Promise<void> {
    const depth = (this.turnDepth.get(chatId) ?? 0) + 1;
    this.turnDepth.set(chatId, depth);
    if (depth > 1) {
      return;
    }
    const kind = this.goalRunning.has(chatId) ? 'goal' : 'chat';
    const id = await this.goalStoreFor(chatId)
      .beginTurn(kind)
      .catch(() => undefined);
    if (id) {
      this.turnIds.set(chatId, id);
    }
  }

  private async endTurn(chatId: string): Promise<void> {
    const depth = (this.turnDepth.get(chatId) ?? 1) - 1;
    if (depth > 0) {
      this.turnDepth.set(chatId, depth);
      return;
    }
    this.turnDepth.delete(chatId);
    const id = this.turnIds.get(chatId);
    this.turnIds.delete(chatId);
    await this.goalStoreFor(chatId)
      .endTurn(id)
      .catch(() => undefined);
  }

  private async converseRounds(
    messages: ChatMessage[],
    opts: LlmOptions,
    chatId?: string,
    maxRounds = 40,
    access: {
      tier: Tier;
      speaker: string;
      onProgress?: (line: string) => void | Promise<void>;
      /** 回合结束后把完整对话交回去，供跨回合续用（前缀缓存靠它）。 */
      onConvo?: (convo: ChatMessage[], text: string) => void;
      /** 发选项卡片（主人档才有）；不传就是没这个能力。 */
      askChoice?: (input: { question: string; options: ChoiceOption[] }) => Promise<string>;
      /** 发图文卡片（开发档以上才有）。 */
      sendCard?: (input: CardInput) => Promise<string>;
    } = {
      tier: 'guest',
      speaker: '',
    },
  ): Promise<string> {
    let convo = [...messages];
    const finish = (text: string): string => {
      access.onConvo?.(convo, text);
      return text;
    };
    if (!this.config.toolsEnabled) {
      const text = await this.complete(messages, opts, 1);
      return finish(text);
    }

    const caps = capabilitiesFor(access.tier, this.config.policy);
    // 目标类型决定能力包：调研/运维/评审按需收窄工具面，code 拿全部
    const goalForKind = chatId && this.config.goals.enabled
      ? await this.goalStoreFor(chatId).read().catch(() => undefined)
      : undefined;
    const tools = toolDefinitionsFor(caps, goalForKind?.kind, {
      canAskChoice: access.tier === 'owner' && access.askChoice !== undefined,
      canSendCard: caps.repoRead && access.sendCard !== undefined,
    });
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
      localHeavy: this.config.policy.localHeavy,
      workspace: caps.repoRead ? this.workspace : undefined,
      records: this.recordsFor(chatId ?? 'direct'),
      goals: this.config.goals.enabled ? this.goalStoreFor(chatId ?? 'direct') : undefined,
      cnb: caps.repoWrite ? this.cnb : undefined,
      cnbCli: caps.repoRead ? this.cnbCli : undefined,
      speaker: access.speaker,
      reviewSlice: (input) => this.reviewSlice(input),
      ...(access.askChoice ? { askChoice: access.askChoice } : {}),
      ...(access.sendCard ? { sendCard: access.sendCard } : {}),
    };

    // 上一轮攒下的长链：先压再干活，别带着 80k 的旧历史开场
    convo = await this.maybeCompact(convo, opts);
    const deadline = Date.now() + this.config.turnBudgetMs;
    // 同一组调用重复出现 = 模型在原地打转，再给工具也是空转
    const repeats = new Map<string, number>();
    // 长回合也要有声音：头一轮不报（大多数消息一轮就完了，报了纯嗡嗡声）
    const progress = this.config.progress;
    const startedAt = Date.now();
    let progressSent = 0;
    let progressAt = 0;
    let lastCalls: ToolCall[] = [];
    for (let round = 0; round < maxRounds; round += 1) {
      if (Date.now() > deadline) {
        this.log.warn('时间预算用完，强制收尾', {
          conversationId: opts.conversationId,
          round,
          budgetMs: this.config.turnBudgetMs,
        });
        return finish(await this.wrapUp(convo, opts));
      }
      const tick = await this.reportProgress(access.onProgress, {
        round,
        calls: lastCalls,
        state: {
          sent: progressSent,
          at: progressAt,
          startedAt,
          gapMs: progress.gapMs,
          max: progress.max,
          enabled: progress.enabled,
        },
      });
      progressSent = tick.sent;
      progressAt = tick.at;
      // 工具轮默认不开思考：账本里推理 >500 token 的调用中位 17.5s，≤500 的只有 5.6s；
      // 工具轮的下一步由工具结果限定得很死，不需要每轮从头推理。
      const thinkingOff = this.config.thinkingRounds >= 0 && round >= this.config.thinkingRounds;
      const response = await this.completeRaw(
        convo,
        { ...opts, tools, ...(thinkingOff ? { disableThinking: true } : {}) },
        1,
      );
      if (response.toolCalls.length === 0) {
        // 终回复也要留在串里，下一回合才能接着往下聊
        convo = [...convo, { role: 'assistant', content: response.content }];
        return finish(response.content);
      }
      const signature = response.toolCalls
        .map((call) => `${call.function.name}:${call.function.arguments}`)
        .join('|');
      const times = (repeats.get(signature) ?? 0) + 1;
      repeats.set(signature, times);
      if (times >= 3) {
        this.log.warn('工具调用原地打转，强制收尾', { conversationId: opts.conversationId, round });
        return finish(await this.wrapUp(convo, opts));
      }
      this.log.info('工具调用', {
        round,
        tools: response.toolCalls.map((call) => call.function.name),
        conversationId: opts.conversationId,
      });
      lastCalls = response.toolCalls;
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
      const outputs = await this.runToolCalls(response.toolCalls, ctx);
      response.toolCalls.forEach((call, index) => {
        convo = [
          ...convo,
          {
            role: 'tool',
            tool_call_id: call.id,
            content: clipToolOutput(outputs[index] ?? '', this.config.toolOutput.maxChars),
          },
        ];
      });
      // 上下文瘦身：老的整段输出折成一行，别让 17 轮命令回显把 prompt 塞到 70k
      convo = pruneToolResults(convo, this.config.toolOutput, this.log, opts.conversationId);
      // 链内减重：快顶到窗口就压成交接摘要（换链是最后手段，不拿它当日常）
      convo = await this.maybeCompact(convo, opts);
    }

    // 轮数用完还没收敛：要一次纯文本，别把 tool_calls 暴露给群友
    this.log.warn('工具轮数用尽，强制收尾', { conversationId: opts.conversationId, rounds: maxRounds });
    return finish(await this.wrapUp(convo, opts));
  }

  /**
   * 进度播报：长回合里每隔一段报一句在干什么。
   *
   * 一条群消息跑 5 分钟一件事都不说，群里只会以为它死了（2026-11-19 的反馈）。
   * 播报本身很便宜（一条纯文本，不过模型），失败不能影响回合，所以全程兜住。
   */
  private async reportProgress(
    onProgress: ((line: string) => void | Promise<void>) | undefined,
    input: {
      round: number;
      calls: ToolCall[];
      state: { sent: number; at: number; startedAt: number; gapMs: number; max: number; enabled: boolean };
    },
  ): Promise<{ sent: number; at: number }> {
    const { state } = input;
    const current = { sent: state.sent, at: state.at };
    if (!onProgress || !state.enabled || state.sent >= state.max || input.round < 2) {
      return current;
    }
    const now = Date.now();
    // 第一句从「回合开始」算间隔，之后按上一句算 —— 两三步就完的短回合一句都不发
    const since = state.at || state.startedAt;
    if (now - since < state.gapMs) {
      return current;
    }
    const line = describeProgress(input.round, input.calls);
    if (!line) {
      return current;
    }
    current.sent = state.sent + 1;
    current.at = now;
    try {
      await onProgress(line);
    } catch (error) {
      this.log.warn('进度播报失败', { error });
    }
    return current;
  }

  /**
   * 跑一组的工具调用：只读的并行跑，有副作用的按顺序串行。
   *
   * 一轮里发三个 read_file / grep 是常态，串行等于是白招两次往返的延迟。
   * run_command / write_file / goal_* / cnb_* 会把世界改掉，顺序不能乱，保持串行。
   */
  private async runToolCalls(calls: ToolCall[], ctx: ToolContext): Promise<string[]> {
    const results: string[] = new Array(calls.length).fill('');
    let batch: number[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) {
        return;
      }
      const pending = batch;
      batch = [];
      await Promise.all(
        pending.map(async (index) => {
          const call = calls[index];
          if (!call) {
            return;
          }
          results[index] = await executeTool(call.function.name, call.function.arguments, ctx);
        }),
      );
    };
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      if (call && PARALLEL_TOOLS.has(call.function.name)) {
        batch.push(index);
        continue;
      }
      await flush();
      if (call) {
        results[index] = await executeTool(call.function.name, call.function.arguments, ctx);
      }
    }
    await flush();
    return results;
  }

  /**
   * 收尾：不要再给工具，只要一句结论。
   *
   * 之前这里是直接 `complete()`：模型还想调工具、或者思考把预算吃光，
   * 拿到的就是空正文，`chatComplete` 抛错，整条消息就吐不出来了（2026-11-19 真事）。
   * 现在明确告诉它工具阶段结束，并关掉思考 —— 只要文本。
   */
  /**
   * 链内压缩：按 token 水位触发，摘要 + 保留最近用户消息与工具输出（参考 Codex）。
   *
   * 失败不阻事：拿不到摘要就原样返回，下一轮接着试（换链那边还有兵底）。
   */
  private async maybeCompact(convo: ChatMessage[], opts: LlmOptions): Promise<ChatMessage[]> {
    const options: CompactOptions = {
      contextWindow: this.config.callLog.contextWindow,
      maxTokens: this.config.thread.maxTokens,
    };
    const tokens = approxTokens(convo);
    if (!shouldCompact(tokens, options)) {
      return convo;
    }
    try {
      const summary = await this.complete(
        [
          { role: 'system', content: compactionPrompt() },
          { role: 'user', content: renderForSummary(convo) },
        ],
        { ...opts, tools: undefined, disableThinking: true, maxTokens: 1_200 },
        1,
      );
      if (!summary.trim()) {
        this.log.warn('压缩摘要为空，保持原链', { conversationId: opts.conversationId, tokens });
        return convo;
      }
      const next = buildCompactedHistory(convo, summary, options);
      this.log.info('上下文已压缩', {
        conversationId: opts.conversationId,
        before: tokens,
        after: approxTokens(next),
        threshold: compactThreshold(options),
      });
      return next;
    } catch (error) {
      this.log.warn('压缩失败，下一轮再试', { conversationId: opts.conversationId, error });
      return convo;
    }
  }

  private async wrapUp(convo: ChatMessage[], opts: LlmOptions): Promise<string> {    const nudge: ChatMessage = {
      role: 'user',
      content: '（系统）工具调用阶段结束。现在只用一两句话给结论：做到哪一步、已经确认了什么、下一步建议怎么做。不要再调用任何工具。',
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

  /**
   * 发一条文本：默认走主动推送，带 msg_id 的被动回复只当退路。
   *
   * QQ 的被动回复只在收到消息后 5 分钟内有效、条数也有限，长回合跑完再回就是
   * 「msg_id已过期」/「被动回复时间或者次数超过限制」，整条结论凭空消失。
   * 主动消息通道没这个窗口（本 bot 有权限，2026-11-19 私聊与群聊实测均 200）。
   * 万一主动配额耗尽 / 临时无权限，再退回带 msg_id 的被动回复。
   */
  private async deliver(bot: Bot, target: Scope['replyTarget'], text: string): Promise<void> {
    try {
      await bot.pushText(target, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('主动推送失败，退回被动回复', { message: message.slice(0, 120) });
      await bot.replyText(target, text);
    }
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

  /** 待选卡片按会话分开存：一张卡片可能挂一整天，重启后还得能点。 */
  private choiceStoreFor(key: string): ChoiceStore {
    let store = this.choiceStores.get(key);
    if (!store) {
      store = new ChoiceStore(this.config.dataRoot, key);
      this.choiceStores.set(key, store);
    }
    return store;
  }

  /**
   * 按钮点回来了：把「主人选了 X」合成一条用户消息，照常走 handle。
   *
   * 只做转译，不另开一条路径 —— 上下文、权限档、目标续跑、落盘都复用现有的。
   */
  async handleChoice(event: InteractionEvent, bot: Bot): Promise<void> {
    const parsed = parseChoiceData(event.data.resolved.button_data);
    if (!parsed) {
      return;
    }
    const groupOpenid = event.group_openid;
    const userOpenid = event.user_openid ?? event.group_member_openid ?? '';
    const clicker = event.group_member_openid ?? userOpenid;
    const chatId = groupOpenid ?? `dm:${userOpenid}`;
    const target = (groupOpenid
      ? { scope: 'group', targetId: groupOpenid }
      : { scope: 'c2c', targetId: userOpenid }) as unknown as Parameters<Bot['replyText']>[0];

    // 谁能点：单聊就是卡片发过去的那个会话；群里按权限档（主人 / 开发成员）算，
    // 群友点了不算数 —— 按钮上可能已经限了指定用户，这里再挡一道。
    const authorized = groupOpenid
      ? resolveTier(clicker, groupOpenid, this.config.policy) !== 'guest'
      : `dm:${clicker}` === `dm:${userOpenid}`;
    if (!authorized) {
      this.log.info('选项卡片被无权限的人点击，忽略', {
        chatId,
        clicker: clicker.slice(0, 8),
      });
      return;
    }

    const pending = await this.choiceStoreFor(chatId).take(parsed.token);
    if (!pending) {
      await this.deliver(bot, target, '这张卡片过期了（或者已经点过），要的话我重发一张。').catch(
        () => undefined,
      );
      return;
    }
    const option = pending.options[parsed.index];
    if (!option) {
      await this.deliver(bot, target, '按钮对不上（选项序号越界），我重发一张吧。').catch(() => undefined);
      return;
    }

    const text = `（点了按钮）${option.label}${option.detail ? `：${option.detail}` : ''}\n\n原先要定的是：${pending.question}`;
    const synthetic = {
      rawEventType: 'CHOICE_INTERACTION',
      kind: groupOpenid ? 'group' : 'c2c',
      senderId: clicker,
      senderName: '主人',
      content: text,
      messageId: `choice-${pending.token}-${parsed.index}`,
      timestamp: new Date().toISOString(),
      ...(groupOpenid ? { groupOpenid } : {}),
      replyTarget: target,
    } as unknown as QQBotInboundMessage;
    this.log.info('按钮选择', {
      conversationId: chatId,
      token: pending.token,
      option: option.label,
    });
    await this.handle(synthetic, bot);
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
  private async scheduleGoalTick(scope: Scope, bot: Bot): Promise<boolean> {
    if (!this.config.goals.enabled || !this.config.goals.auto || scope.isDirect) {
      return false;
    }
    const chatId = scope.conversationId;
    if (!this.config.policy.devGroups.includes(chatId)) {
      return false;
    }
    if (this.goalTimers.has(chatId) || this.goalRunning.has(chatId)) {
      return false;
    }
    const store = this.goalStoreFor(chatId);
    const goal = await store.read();
    if (!goal) {
      return false;
    }
    const verdict = canContinue(goal, {
      maxRounds: this.config.goals.maxRounds,
      maxWallMs: this.config.goals.maxWallMs,
    });
    if (!verdict.ok) {
      const exhausted = /用满|墙钟/.test(verdict.reason ?? '');
      const stalled = goal.budget.roundsSinceProgress ?? 0;
      // 探针挂在非 active 目标上 = 永远不会被叫醒（2026-11-20 实测停摆一小时）。
      // 自动续跑只认 active，所以这里必须出声，不能只写日志。
      if (goal.awaiting && goal.status !== 'active') {
        const key = `orphan:${goal.id}:${goal.awaiting.issue}`;
        if (!this.goalNotices.has(key)) {
          this.goalNotices.add(key);
          this.log.warn('探针挂在非 active 目标上，不会被叫醒', {
            conversationId: chatId,
            status: goal.status,
            issue: goal.awaiting.issue,
          });
          void this
            .deliver(
              bot,
              scope.replyTarget,
              `⚠ 我把 #${goal.awaiting.issue} 的探针挂在了${goal.status}的目标 ${goal.id} 上 —— ` +
                '自动续跑只跑 active 目标，所以它不会叫醒我。要接着干就 /goal resume，' +
                '或者让我 goal_create 立个新目标。',
            )
            .catch((error) => this.log.warn('探针告警发送失败', { conversationId: chatId, error }));
        }
      }
      // 预算到点但上一段确实有推进：续命接着干。配额是异常保护，不是给 agent 上锁。
      if (exhausted && stalled === 0 && nextSlice(goal)) {
        const renews = await store.renew(`${verdict.reason}，但上一段有进展`).catch(() => 0);
        this.log.info('预算到点但有进展，续命继续', {
          conversationId: chatId,
          renews,
          reason: verdict.reason,
        });
        void this
          .deliver(
            bot,
            scope.replyTarget,
            `🔁 ${verdict.reason}，但上一段有推进，续命接着干（第 ${renews} 次）。`,
          )
          .catch((error) => this.log.warn('续命提示发送失败', { conversationId: chatId, error }));
        return this.scheduleGoalTick(scope, bot);
      }
      // 同一个理由不要每 2 分钟刷一遍（之前一天几百行「不续跑」就是这么来的）
      if (this.goalStopReason.get(chatId) !== verdict.reason) {
        this.log.info('不续跑', { conversationId: chatId, reason: verdict.reason, stalled });
        this.goalStopReason.set(chatId, verdict.reason ?? '');
      }
      // 没进展才停：留在 active 会被巡检每 2 分钟捞起来空转，日志看着像在干活。
      // 停的原因是预算用尽，所以落 budget_limited（终态），不占 paused —— paused 只给主人要求停
      if (exhausted) {
        await store.limit(`${verdict.reason}${stalled > 0 ? `，连续 ${stalled} 轮没进展` : ''}`).catch((error) => {
          this.log.warn('目标转 budget_limited 失败', { conversationId: chatId, error });
        });
      }
      // 必须说一句 —— 不然群里看到的就是「干到一半人没了」
      if (exhausted && !this.goalNotices.has(goal.id)) {
        this.goalNotices.add(goal.id);
        void this
          .deliver(
            bot,
            scope.replyTarget,
            `⏸ ${verdict.reason}${stalled > 0 ? `，连续 ${stalled} 轮没进展` : ''}，已停在 budget_limited。` +
              '回 /goal resume 重置预算就能接着干；要换方向就 goal_step 改切片。',
          )
          .catch((error) => this.log.warn('停跑提示发送失败', { conversationId: chatId, error }));
      }
      return false;
    }
    if (this.goalTimers.has(chatId) || this.goalRunning.has(chatId)) {
      return false;
    }
    const timer = setTimeout(() => {
      this.goalTimers.delete(chatId);
      void this.goalWake(scope, bot).catch((error) =>
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
    return true;
  }

  /**
   * 叫醒：先廉价探针，再决定开不开模型回合。
   *
   * 等 NPC 干活的时候，每一跳只读两个 CNB 接口（issue + PR 列表）：
   * 指纹没变就继续睡，变了才把变化摘要喂回去。这样「NPC 一交货就接着干」
   * 不用拿模型回合去轮询，一个子儿不花。
   */
  private async goalWake(scope: Scope, bot: Bot): Promise<void> {
    const chatId = scope.conversationId;
    const store = this.goalStoreFor(chatId);
    const goal = await store.read();
    if (!goal) {
      return;
    }
    const awaiting = goal.awaiting;
    if (!awaiting) {
      await this.runGoalTick(scope, bot);
      return;
    }
    if (!this.cnb) {
      this.log.info('没 CNB 通道，探针退回直接续跑', { conversationId: chatId });
      await this.runGoalTick(scope, bot);
      return;
    }
    let probe;
    try {
      probe = await this.cnb.probeIssue(awaiting.issue);
    } catch (error) {
      this.log.warn('CNB 探针失败，下一跳再试', { conversationId: chatId, issue: awaiting.issue, error });
      void this.scheduleGoalTick(scope, bot);
      return;
    }
    if (probe.sig === awaiting.sig) {
      // 指纹不变不等于「对方在干活」：派工评论漏了 @CodeBuddy / work_mode，NPC 根本不会下场，
      // 这时候死等就是白等（2026-11-21 实测干等 2 小时半）。等够 probeIdleMs 就叫醒自查。
      if (shouldSelfCheck(awaiting, this.config.goals.probeIdleMs)) {
        const minutes = Math.max(1, Math.round(watchIdleMs(awaiting) / 60000));
        this.log.info('探针等太久，叫醒自查', {
          conversationId: chatId,
          issue: awaiting.issue,
          minutes,
        });
        await store.clearWatch(`等了 ${minutes} 分钟没动静，自查派工是否生效`);
        await this.runGoalTick(scope, bot, selfCheckNotice(awaiting.issue, minutes));
        return;
      }
      this.log.info('NPC 还没动，继续等', { conversationId: chatId, issue: awaiting.issue });
      void this.scheduleGoalTick(scope, bot);
      return;
    }
    this.log.info('NPC 有动静，叫醒', { conversationId: chatId, issue: awaiting.issue });
    await store.clearWatch('状态指纹变了');
    await this.runGoalTick(scope, bot, `NPC 那边有变化：\n${probe.summary}`);
  }

  /**
   * 启动/巡检兜底：恢复只有一个入口。
   *
   * 以前这里是两套逻辑（只认 active 的续跑 + 只看残留标记的恢复），任一处漏判就是
   * 「干到一半人没了」。现在一个会话一次 reconcile：先判被打断，再决定续不续，
   * 两件事共用同一份 thread 状态（参考 Codex 的 resume：重放状态，而不是补一段逻辑）。
   */
  async runGoalSweep(bot: Bot, chatIds: string[]): Promise<number> {
    if (!this.config.goals.enabled || !this.config.goals.auto) {
      return 0;
    }
    let resumed = 0;
    for (const chatId of chatIds) {
      if (!this.config.policy.devGroups.includes(chatId)) {
        continue;
      }
      // 正在跑的会话不碰（巡检每 2 分钟一次，会撞上正常回合）
      if (this.goalTimers.has(chatId) || this.goalRunning.has(chatId) || (this.turnDepth.get(chatId) ?? 0) > 0) {
        continue;
      }
      if (await this.reconcile(bot, chatId)) {
        resumed += 1;
      }
    }
    return resumed;
  }

  /** 一个会话的恢复：判打断 → 能续就续 → 状态有变才出声。 */
  private async reconcile(bot: Bot, chatId: string): Promise<boolean> {
    const store = this.goalStoreFor(chatId);
    const mark = await store.pendingTurn().catch(() => undefined);
    const scope: Scope = {
      conversationId: chatId,
      memoryKey: chatId,
      isDirect: false,
      replyTarget: { scope: 'group', targetId: chatId },
    };
    const say = (text: string): void => {
      void this
        .deliver(bot, scope.replyTarget, text)
        .catch((error) => this.log.warn('恢复提示发送失败', { conversationId: chatId, error }));
    };
    let interrupted: string | undefined;
    if (mark) {
      // 先落「被打断」再清回合标记：哪怕后面发送失败，也不会每次巡检重跑一遍
      await store.markInterrupted(mark).catch(() => undefined);
      interrupted = describeTurn(mark);
      this.log.warn('上一轮被重启打断', {
        conversationId: chatId,
        startedAt: mark.startedAt,
        kind: mark.kind,
      });
    }
    let goal = await store.read().catch(() => undefined);
    if (!goal) {
      if (interrupted) {
        say(`♻ 我上一轮（${interrupted}）被重启打断了，那次的回复没发出去。当时没有进行中的目标，要接着干什么说一声。`);
      }
      return false;
    }
    const unfinished = goal.slices.filter((slice) => slice.status !== 'done' && slice.status !== 'dropped');
    // done 却还有没收口的片 = 那一轮本来还在干活，被重启打断才没标完：接上，别等人来问
    if (goal.status === 'done' && unfinished.length > 0) {
      await store.resume().catch(() => '');
      goal = (await store.read().catch(() => undefined)) ?? goal;
      this.log.warn('上一轮被打断，目标续上', {
        conversationId: chatId,
        unfinished: unfinished.map((slice) => slice.id),
      });
    }
    if (await this.scheduleGoalTick(scope, bot)) {
      const slice = nextSlice(goal);
      if (interrupted) {
        say(
          `♻ 我上一轮（${interrupted}）被重启打断了，回复没发出去。已经接上了，接着推${slice ? ` ${slice.id} ${slice.title}` : '目标'}。`,
        );
      }
      return true;
    }
    if (interrupted) {
      const verdict = canContinue(goal, {
        maxRounds: this.config.goals.maxRounds,
        maxWallMs: this.config.goals.maxWallMs,
      });
      say(
        `⚠ 我上一轮（${interrupted}）被重启打断了，现在续不上：${verdict.reason ?? '没有待推进的切片'}。` +
          '要接着干就回 /goal resume，或者 goal_create 开新目标。',
      );
    }
    return false;
  }

  /** 上一轮被打断的交代：取走一次，附在下一轮的开头（参考 Codex 的 <turn_aborted>）。 */
  private async interruptedNotice(chatId: string): Promise<string> {
    const mark = await this.goalStoreFor(chatId)
      .takeInterrupted()
      .catch(() => undefined);
    if (!mark) {
      return '';
    }
    return (
      `[上一轮被打断 · ${describeTurn({ id: 'x', startedAt: mark.at, kind: mark.kind })}] ` +
      '那个回合跑到一半进程重启了：工具可能只执行了一部分，回复也没发出去。' +
      '先看当前实际状态（文件、PR、CI），别把已完成的动作再做一遍。\n\n'
    );
  }


  /** 跑一轮自动续跑：记预算 → 把「继续推下一片」当成一条消息走完整回合。 */
  private async runGoalTick(scope: Scope, bot: Bot, notice?: string): Promise<void> {
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
      const text = [
        notice ?? '',
        `（自动续跑 ${goal.budget.rounds}/${goal.budget.maxRounds}）接着推目标：${goal.objective.slice(0, 120)}`,
        `这一轮只做一片 —— ${slice ? `${slice.id} ${slice.title}` : '没有待办切片'}。` +
          '你的活是**指挥与验收**，不是搬砖：需求拆成切片派给 NPC（cnb_issue_dispatch），' +
          '验收看 PR 里 NPC 贴的输出 + ci_status / cnb pulls check-status，**别在本地跑全量测试与构建**' +
          '（要复现只跑定向用例，几秒的那种）。互不碰目录的片一次派 2~3 个并行跑，派完 goal_watch 挂探针。' +
          '做完就 goal_step 标进度，全部验过再 goal_finish，卡住就 goal_block。',
      ]
        .filter(Boolean)
        .join('\n');
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
        void this.scheduleGoalTick(scope, bot);
      }
    }
  }

  /**
   * 独立复核：空上下文、温度 0，只给判据、切片说明、证据与仓库现状。
   * 解析不出 PASS 一律按未过处理 —— 宁可退回 review 重做，不可假 done。
   */
  private async reviewSlice(input: {
    goal: Goal;
    slice: GoalSlice;
    evidence?: string;
  }): Promise<{ pass: boolean; note: string }> {
    const { goal, slice } = input;
    const snapshot = await this.repoSnapshot();
    const payload = [
      `目标：${goal.objective}`,
      `类型：${kindPack(goal.kind).label}`,
      `完成判据：\n${goal.criteria.map((item) => `- ${item}`).join('\n')}`,
      `切片：${slice.id} ${slice.title}`,
      slice.note ? `执行者说明：${slice.note}` : '',
      slice.ref ? `出处：${slice.ref}` : '',
      input.evidence ? `证据：\n${input.evidence.slice(0, 4000)}` : '证据：执行者没有提供',
      snapshot ? `仓库现状：\n${snapshot}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const system =
      '你是独立复核者：只按判据核对证据，不看执行者的自我评价。' +
      '只看「这一片该交的东西」：目标级判据里涉及其他切片的交付物（别的 PR、别的模块）不算本片的判据，' +
      '不要因为它还没完成就判 FAIL。' +
      '证据不足以证明本片判据满足时一律 FAIL。' +
      '只输出两行：第一行 PASS 或 FAIL，第二行一句理由（指出缺哪条证据）。';
    try {
      // 关思考 + 压 maxTokens：这段只要两行 PASS/FAIL，实测同一批切片开着思考结论完全一致，
      // 却多烧 10 倍 completion（401 vs 43 token）；11-21 有三次单条跑 66~85 秒（45 秒超时被中断后重试），
      // 复核卡住时整轮都停在这里。
      const raw = await this.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: payload },
        ],
        {
          ...reviewOptions(this.config.llm),
        },
        1,
      );
      const lines = raw
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const pass = /^PASS/i.test(lines[0] ?? '');
      const note = (lines.slice(1).join(' ') || lines[0] || '无说明').slice(0, 300);
      this.log.info('切片复核', { slice: slice.id, pass, note });
      return { pass, note };
    } catch (error) {
      this.log.warn('切片复核失败，按未过处理', { slice: slice.id, error });
      return { pass: false, note: '复核调用失败，按未过处理（重试或补证据）' };
    }
  }

  /** 复核用的仓库现状：只看现状，不跑测试（测试结果由执行者当证据提供）。 */
  private async repoSnapshot(): Promise<string> {
    if (!this.workspace) {
      return '';
    }
    try {
      const result = await runCommand({
        cmd: 'git status --short && git diff --stat && git log --oneline -3',
        cwd: this.workspace.repoDir,
        workspace: this.workspace.root,
        tier: 'owner',
        home: this.workspace.home,
        limits: { timeoutMs: 15_000, maxBytes: 4_000 },
      });
      return [result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n')
        .trim()
        .slice(0, 2000);
    } catch (error) {
      this.log.warn('取仓库现状失败', { error });
      return '';
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
        events: await this.goalStoreFor(scope.conversationId)
          .events()
          .catch(() => []),
      });
      await this.deliver(bot, scope.replyTarget, body);
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
        await this.deliver(bot, scope.replyTarget, body);
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

    const called =
      scope.isDirect || isAtEvent(message) || isBotMentioned(message, this.config) || isChoiceMessage(message);
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
    // 会变的那些（记录本、目标、开头词）不进 system：system 一动，前缀缓存全作废，
    // 而且它们在尾部才拿得到注意力（Manus 的 recitation：把目标重念到上下文末尾）。
    const tailParts: string[] = [];
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
    // 顺手学一下「这个群里谁是自己人」：群里的 member_openid 和单聊 openid 不是一个值，
    // 选项卡片的按钮要限人时只能靠这个表（学不到就不限，服务端 tier 再拦）
    if (tier !== 'guest' && !scope.isDirect && message.senderId) {
      let known = this.ownerIdsByChat.get(scope.conversationId);
      if (!known) {
        known = new Set<string>();
        this.ownerIdsByChat.set(scope.conversationId, known);
      }
      if (known.size < 8) {
        known.add(message.senderId);
      }
    }
    parts.push(`## 你的身份与边界\n\n${describeTier(tier)}`);
    if (tier !== 'guest' && this.workspace) {
      parts.push(
        `## 工作区\n\n${this.workspace.describe()}\n` +
          '动作顺序：先 repo_status 看清现状 → 读相关文件 → 改 → 跑测试 → 按时张提交 → 推分支开 PR。main 不直推。\n\n' +
          '怎么用工具（回合有预算，往返次数就是预帚）：\n' +
          '· 一条 run_command 里用 && / ; 把多条命令串起来（看状态 + 读文件 + 跑测试一次干完），别一条一条试 —— 每次往返都要重新过一遍模型。\n' +
          '· 输出先收敛再读：长日志用 head / tail / grep -c，别把整份 npm test 回显抱进上下文。\n' +
          '· 要反复看的东西先落到文件里，下次用 sed -n 取片段，不要重复整文输出。\n' +
          '· 一轮只推一片，推完当场 goal_step 标 done，不要攒到最后一起记。',
      );
    }
    const brief = await this.recordsFor(scope.isDirect ? 'direct' : scope.conversationId).brief();
    if (brief) {
      tailParts.push(`## 记录本摘要（开场先心里有数，不用逐条念）\n\n${brief}`);
    }

    // 当前目标：长活的切片账本。每轮只推一片，不然会一口气做完就断在半路。
    // 只念 active / paused 的：done 的目标再念一遍只会把「在等 #N」这种陈旧探针带进上下文。
    let goalLine = '';
    if (this.config.goals.enabled) {
      const goal = await this.goalStoreFor(scope.isDirect ? 'direct' : scope.conversationId).read();
      if (goal && (goal.status === 'active' || goal.status === 'paused')) {
        const pack = kindPack(goal.kind);
        const next = nextSlice(goal);
        goalLine = next
          ? `目标 ${goal.id}（${goal.status}）下一片 ${next.id} ${next.title}`
          : `目标 ${goal.id}（${goal.status}）没有待推进的切片`;
        tailParts.push(
          `## 当前目标\n\n${goalBrief(goal)}\n\n` +
            `这类活（${pack.label}）的干法与验收：\n${pack.prompt}\n\n` +
            '一轮只推一片：看清现状 → 做 → 自己验 → goal_step 标进度（done/review/blocked 都要一句结论与出处）。' +
            '标 done 前会有一次独立复核，证据写进 evidence（测试输出、CI 结论、PR 链接），没证据会被退回。' +
            '所有切片都验过才 goal_finish；缺权限或等人拍板就 goal_block，别硬往下做。',
        );
      }
    }

    // 连着几次都用同一个词开头，一眼就是模板；点名那个词，别只说「换个说法」
    const openers = this.recentOpeners.get(scope.conversationId) ?? [];
    const repeated = repeatedOpener(openers);
    if (repeated) {
      tailParts.push(
        `## 别重复自己\n\n你最近 ${openers.length} 次是这样开头的：「${openers.join('」「')}」。` +
          `其中「${repeated.word}」已经用了 ${repeated.count} 次 —— 这次不要用「${repeated.word}」开头，` +
          '直接从一个动作、一句判断或一句追问切进去；结尾也别每次都挂同一个表情。',
      );
    }

    const system = [resolvePersona(scope.isDirect ? undefined : scope.conversationId, this.config.dataRoot), ...parts].join(
      '\n\n---\n\n',
    );

    // 跨回合会话链：同一会话不再每轮从头重建，而是追加推进 ——
    // 前缀一字不差才能命中 provider 的 KV 缓存（Codex 的 history 也是 append-only）。
    const threadKey = scope.conversationId;
    const cachedThread = this.threads.get(threadKey);
    const usable = cachedThread && cachedThread.system === system ? cachedThread : undefined;
    // 有链就接着链走：锚点滚出窗口时只补时间戳之后的新行，不再把整条链丢掉重发
    const prior = usable ? usable.messages : [];
    const deltaLines = usable ? linesAfter(pending, usable) : pending;
    const history = renderBuffer(deltaLines);

    // 记录本 / 目标 / 成员档案每轮都贴一遍，等于每轮白烧 1.5~2k 未命中的 token，
    // 首调命中就是这么被拖到 80% 的。只在内容变了才重念，没变就一句「见上文」。
    const tailSig = digestOf([...tailParts, remembered ?? ''].join('\u0000'));
    const hasTail = tailParts.length > 0 || Boolean(remembered);
    const repeat = hasTail && usable !== undefined && usable.tailSig === tailSig;
    const tailBlock = !hasTail
      ? ''
      : repeat
        ? `## 记录本 / 目标 / 记忆\n\n（自上一轮没变化${goalLine ? `：${goalLine}` : ''}。记录本摘要、${speaker} 的档案与目标清单都在上文，按那个继续；要看最新状态用 goal_status / memory_search。）\n\n`
        : `${tailParts.join('\n\n')}\n\n`;
    const now = new Date();
    const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const quoted = scope.isDirect ? undefined : await this.resolveQuote(scope.conversationId, message);
    const quotedPrefix = quoted
      ? `（回 ${quoted.sender}「${quoted.text.slice(0, 60)}」）`
      : !scope.isDirect && this.hasQuoteRef(message)
        ? this.unresolvedQuoteHint(scope.conversationId)
        : '';
    const current = `[${stamp}] ${speaker}${scope.isDirect ? '' : ' → Kei'}：${quotedPrefix}${text}`;
    const memoryBlock = !repeat && remembered ? `## 你记得的 ${speaker}\n\n${remembered}\n\n` : '';
    const userText = history
      ? `${CONTEXT_HEADER}\n${history}\n${CONTEXT_FOOTER}\n\n${tailBlock}${memoryBlock}${current}`
      : `${tailBlock}${memoryBlock}${current}`;

    // 上一轮被重启打断就只说一次：告诉模型工具可能只跑了一半，先看实际状态
    // （参考 Codex 的 <turn_aborted>；不这样它会把已完成的动作再做一遍）
    const abortedNotice = await this.interruptedNotice(scope.conversationId);

    const buildMessages = (body: string, withImages: boolean): ChatMessage[] => [
      { role: 'system', content: system },
      ...prior,
      {
        role: 'user',
        content:
          withImages && imageParts.length > 0
            ? [{ type: 'text' as const, text: `${abortedNotice}${body}` }, ...imageParts]
            : `${abortedNotice}${body}`,
      },
    ];

    // 回合结束后把整条串存回去，下一轮接在尾巴上（只追加，不改前文）
    const lastMessageId =
      (pending.length > 0 ? pending[pending.length - 1]?.messageId : undefined) ?? message.messageId;
    // 时间戳锚点取「这一轮已经折进去的最新一条」：当前这条也算（它的行就在缓冲里，
    // 不能留到下一轮再折一次）；这一轮中途进来的消息时间戳更大，下一轮照旧折进去。
    const selfLine = scope.isDirect
      ? undefined
      : this.buffer.peek(scope.conversationId).find((line) => line.messageId === message.messageId);
    const lastAt = Math.max(
      usable?.lastAt ?? 0,
      ...pending.map((line) => line.timestamp ?? 0),
      selfLine?.timestamp ?? 0,
    );
    const remember = (convo: ChatMessage[]): void => {
      const rest = convo[0]?.role === 'system' ? convo.slice(1) : convo;
      let next: ThreadState = {
        system,
        messages: rest,
        lastMessageId,
        lastAt,
        turns: (usable?.turns ?? 0) + 1,
        bornAt: usable?.bornAt ?? Date.now(),
        tailSig,
      };
      // 会话寿命：到点不是停工，是写交接单后换一条新链（新链只带目标 + 最近几句）
      const rotation = shouldRotateThread({
        ...(usable ? { bornAt: usable.bornAt } : {}),
        turns: next.turns,
        maxAgeMs: this.config.thread.maxAgeMs,
        maxTurns: this.config.thread.maxTurns,
      });
      if (rotation.rotate) {
        const at = new Date();
        const tail = rest
          .slice(-6)
          .map((item) => {
            const body = typeof item.content === 'string' ? item.content : '[图片/多段内容]';
            return `- ${item.role}: ${body.replace(/\s+/g, ' ').slice(0, 200)}`;
          })
          .join('\n');
        const rel = handoffPath(threadKey, at);
        const note =
          `（上一段会话已交接：${rel}。${rotation.reason}，按交接单与记录本接着往下推，` +
          '别重问我上面已经说过的事；缺信息就去看文件。）';
        const store = this.config.goals.enabled ? this.goalStoreFor(threadKey) : undefined;
        void (async () => {
          const goal = await store?.read().catch(() => undefined);
          const body = renderHandoff({
            reason: rotation.reason ?? '到点交接',
            turns: next.turns,
            ...(goal ? { goalBrief: goalBrief(goal) } : {}),
            tail,
            at,
          });
          await writeHandoff(this.config.dataRoot, threadKey, body, at);
        })().catch((error) => this.log.warn('交接单落盘失败', { conversationId: threadKey, error }));
        this.log.info('会话交接', {
          conversationId: threadKey,
          reason: rotation.reason,
          turns: next.turns,
          handoff: rel,
        });
        next = {
          system,
          messages: [{ role: 'user', content: note }],
          lastMessageId,
          lastAt,
          turns: 0,
          bornAt: at.getTime(),
        };
      }
      const tokens = approxTokens(next.messages);
      // 硬兵底：压缩一直失败时也不能把请求撑爆（正常路径是下一轮开头先压一次）
      if (tokens > this.config.thread.maxTokens * 3) {
        const kept = next.messages.slice(-6);
        next = { ...next, messages: [{ role: 'user', content: COMPACT_NOTE }, ...kept] };
        this.log.warn('对话链超硬顶，丢掉旧段', {
          conversationId: threadKey,
          tokens,
          kept: kept.length,
          turns: next.turns,
        });
      }
      this.threads.set(threadKey, next);
    };

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
        await this.deliver(bot, scope.replyTarget, chunks[i] as string);
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

    // 干活期间的短播报：直接发，不走 send（否则会被记成一条「已回复」并污染开头词统计）
    const onProgress = async (line: string): Promise<void> => {
      try {
        await this.deliver(bot, scope.replyTarget, line);
        if (!scope.isDirect) {
          this.buffer.push(scope.conversationId, {
            senderName: this.config.botUsernames[0] ?? 'Kei',
            text: line,
            timestamp: Date.now(),
            isSelf: true,
          });
        }
        this.log.info('进度播报', { conversationId: scope.conversationId, line });
      } catch (error) {
        this.log.warn('进度播报失败', { conversationId: scope.conversationId, error });
      }
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

    // 要主人拍板时出按钮：点回来会当成一条新消息再走一遍 handle
    const askChoice = async (input: { question: string; options: ChoiceOption[] }): Promise<string> => {
      if (tier !== 'owner') {
        return '当前身份发不了选项卡片：直接问一句就行。';
      }
      if (this.config.ownerOpenids.length === 0) {
        return '没配 AGENT_OWNER_OPENIDS，发不了卡片。';
      }
      const options = input.options.slice(0, MAX_CHOICE_OPTIONS);
      if (options.length < 2) {
        return '至少两个选项才值得出卡片：直接说结论。';
      }
      const token = createHash('sha256')
        .update(`${scope.conversationId}:${Date.now()}:${Math.random()}`)
        .digest('hex')
        .slice(0, 10);
      const choice: PendingChoice = {
        token,
        chatId: scope.conversationId,
        question: input.question.slice(0, 120),
        options,
        createdAt: Date.now(),
        by: speaker,
      };
      const store = this.choiceStoreFor(scope.conversationId);
      await store.add(choice);
      const card = renderChoiceMarkdown(choice);
      // 群里的按钮只能限「已知的这个人在这群的 member_openid」；还不知道就不限，
      // 靠 handleChoice 里的 tier 再拦一道（宁可多一步校验，不要错认别人的选择）
      const restrictTo = scope.isDirect
        ? []
        : [...(this.ownerIdsByChat.get(scope.conversationId) ?? [])];
      try {
        await bot.pushMarkdown(
          scope.replyTarget,
          card,
          buildChoiceKeyboard(choice, { restrictTo, withGroupId: scope.isDirect }),
        );
      } catch (error) {
        await store.take(token).catch(() => undefined);
        this.log.warn('选项卡片发送失败', { conversationId: scope.conversationId, error });
        return '卡片没发出去（接口报错）：改成一句话问。';
      }
      if (!scope.isDirect) {
        this.buffer.push(scope.conversationId, {
          senderName: this.config.botUsernames[0] ?? 'Kei',
          text: card,
          timestamp: Date.now(),
          isSelf: true,
        });
      }
      this.log.info('发出选项卡片', {
        conversationId: scope.conversationId,
        token,
        options: options.length,
      });
      return `已发出选项卡片（${options.length} 个按钮，token ${token}）。主人点按钮后会以新消息进来；本轮只回一句很短的话，不要重复选项内容。`;
    };

    // 成组的信息发成图文卡片：PR / issue 交付、构建结果。开发档以上才有
    const sendCard = async (input: CardInput): Promise<string> => {
      if (tier === 'guest') {
        return '当前身份发不了图文卡片：把结论写成文字就行。';
      }
      const built = buildCard(input);
      if ('error' in built) {
        return built.error;
      }
      try {
        await bot.pushCard(scope.replyTarget, built.card);
      } catch (error) {
        this.log.warn('图文卡片发送失败', { conversationId: scope.conversationId, error });
        const reason = error instanceof Error ? error.message.slice(0, 120) : '';
        return `卡片没发出去（${reason || '接口报错'}）：换个国内可达的 https 配图，或者把结论写成文字。`;
      }
      if (!scope.isDirect) {
        this.buffer.push(scope.conversationId, {
          senderName: this.config.botUsernames[0] ?? 'Kei',
          text: renderCardLine(built.card),
          timestamp: Date.now(),
          isSelf: true,
        });
      }
      this.log.info('发出图文卡片', {
        conversationId: scope.conversationId,
        title: built.card.content.title,
      });
      return `已发出图文卡片「${built.card.content.title}」。本轮补一句结论就行，不要把卡片内容再贴一遍。`;
    };

    try {
      const reply = await this.converse(buildMessages(userText, true), opts, chatId, this.config.toolRounds, {
        tier,
        speaker,
        onProgress,
        onConvo: remember,
        askChoice,
        sendCard,
      });
      await send(reply);
      // 回合结束：还有目标就安排下一轮自动续跑（人一插话就会被取消）
      void this.scheduleGoalTick(scope, bot);
    } catch (error) {
      // 自动续跑失败不发「我卡住了」：下一跳会自己重试，群里只看到一堆广播反而更吓人。
      const autoTick = (message.messageId ?? '').startsWith('goal-');
      // 带图请求失败（模型不支持 / 图太大被拒）就退回文字描述，别整条哑掉
      if (imageParts.length === 0) {
        this.log.error('回复失败', { conversationId: scope.conversationId, autoTick, error });
        if (!autoTick) {
          await this.notifyFailure(send, scope.conversationId);
        }
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
          onProgress,
          onConvo: remember,
          askChoice,
          sendCard,
        });
        await send(reply);
      } catch (retryError) {
        this.log.error('回复失败（退化后）', { conversationId: scope.conversationId, autoTick, error: retryError });
        if (!autoTick) {
          await this.notifyFailure(send, scope.conversationId);
        }
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
