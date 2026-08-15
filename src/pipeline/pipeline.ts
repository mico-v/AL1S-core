/**
 * 消息管道：归一化 → 命令分发 / 记日志 → 触发判定 → 冷却 → 并发锁 → 生成 → 回复。
 *
 * 群聊：仅 @ 或命中关键词触发，且有冷却与白名单；私聊恒触发。
 * 全程 try/catch，异常回复「内部出错了」，绝不冒泡到 SDK 事件循环。
 */
import { at, text } from '@snowluma/sdk';
import type { OneBotGroupMessageEvent, OneBotPrivateMessageEvent, SnowLumaEventContext } from '@snowluma/sdk';
import { runAgentLoop } from '../agent/loop';
import type { LLMMessage, LLMProvider } from '../llm/types';
import { logger } from '../logging/logger';
import type { BotConfig } from '../config';
import type { SessionManager } from '../session/manager';
import type { SkillRegistry } from '../skills/registry';
import { normalizeMessage } from './normalize';
import { evaluateTrigger } from './trigger';

const log = logger.child('pipeline');

/** 管道依赖：由 bot.ts 组装注入 */
export interface PipelineDeps {
  config: BotConfig;
  provider: LLMProvider;
  sessions: SessionManager;
  registry: SkillRegistry;
  botNickname?: string;
}

/** 单条回复的最大字数，超长分条发送 */
const MAX_CHUNK = 500;

/** 把长文本按段落/长度分条（每条 ≤limit 字，超长段落硬切） */
function splitText(text: string, limit: number): string[] {
  const out: string[] = [];
  let buf = '';
  for (const para of text.split(/\n+/)) {
    if (para.length === 0) continue;
    if (buf !== '' && buf.length + para.length + 1 > limit) {
      out.push(buf);
      buf = '';
    }
    if (para.length <= limit) {
      buf = buf === '' ? para : `${buf}\n${para}`;
      continue;
    }
    // 单段超长：按 limit 硬切
    if (buf !== '') {
      out.push(buf);
      buf = '';
    }
    let rest = para;
    while (rest.length > limit) {
      out.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    buf = rest;
  }
  if (buf !== '') out.push(buf);
  return out;
}

export class Pipeline {
  private readonly config: BotConfig;
  private readonly provider: LLMProvider;
  private readonly sessions: SessionManager;
  private readonly registry: SkillRegistry;
  private _botNickname: string;

  constructor(deps: PipelineDeps) {
    this.config = deps.config;
    this.provider = deps.provider;
    this.sessions = deps.sessions;
    this.registry = deps.registry;
    this._botNickname = deps.botNickname ?? '';
  }

  /** 登录后写入机器人昵称（bot.ts 调用，用于 bot 回复日志的发送者名） */
  setBotNickname(name: string): void {
    this._botNickname = name;
  }

  /** 群消息处理 */
  async handleGroupMessage(
    event: OneBotGroupMessageEvent,
    ctx: SnowLumaEventContext<OneBotGroupMessageEvent>,
  ): Promise<void> {
    // a) 群白名单：非空且不含本群 → 忽略
    if (this.config.enabledGroups.length > 0 && !this.config.enabledGroups.includes(event.group_id)) {
      log.debug('群白名单忽略', { group: event.group_id });
      return;
    }

    const norm = normalizeMessage(event);
    const chatId = `g:${event.group_id}`;
    log.debug('收到群消息', { group: event.group_id, user: event.user_id, atBot: norm.atBot, text: norm.text });

    // c) 命令分发：命令不记日志、不触发（同样兜底，异常回复「内部出错了」）
    if (norm.text.startsWith('/')) {
      try {
        await this.dispatchCommand(norm.text, chatId, ctx);
      } catch (err) {
        await this.safeErrorReply(ctx, err);
      }
      return;
    }

    try {
      const senderName = event.sender.nickname || `用户${event.user_id}`;
      // d) 记日志
      this.sessions.get(chatId).append({
        role: 'user',
        senderId: event.user_id,
        senderName,
        text: norm.text,
        atBot: norm.atBot,
        time: event.time,
      });

      // e) 触发判定
      if (!evaluateTrigger({ atBot: norm.atBot, rawText: norm.text, keywords: this.config.triggerKeywords })) {
        log.debug('未触发', { group: event.group_id, atBot: norm.atBot, keywords: this.config.triggerKeywords });
        return;
      }

      // f) 冷却：机器人上次回复后冷却期内不再回
      const s = this.sessions.get(chatId);
      if (s.lastBotReplyTime !== undefined && Date.now() - s.lastBotReplyTime < this.config.replyCooldownSeconds * 1000) {
        log.debug('冷却跳过', { group: event.group_id });
        return;
      }

      // g) 防并发：生成期间忽略新消息，结束后释放
      if (s.isGenerating) {
        log.debug('生成中，忽略', { group: event.group_id });
        return;
      }
      s.isGenerating = true;
      try {
        await this.generate(chatId, norm.atBot, event.user_id, senderName, ctx);
      } finally {
        s.isGenerating = false;
      }
    } catch (err) {
      await this.safeErrorReply(ctx, err);
    }
  }

  /** 私聊消息处理：命令同上，非命令直接生成（恒触发，不做触发/冷却判定） */
  async handlePrivateMessage(
    event: OneBotPrivateMessageEvent,
    ctx: SnowLumaEventContext<OneBotPrivateMessageEvent>,
  ): Promise<void> {
    const norm = normalizeMessage(event);
    const chatId = `p:${event.user_id}`;
    log.debug('收到私聊消息', { user: event.user_id, text: norm.text });

    if (norm.text.startsWith('/')) {
      try {
        await this.dispatchCommand(norm.text, chatId, ctx);
      } catch (err) {
        await this.safeErrorReply(ctx, err);
      }
      return;
    }

    try {
      const senderName = event.sender.nickname || `用户${event.user_id}`;
      this.sessions.get(chatId).append({
        role: 'user',
        senderId: event.user_id,
        senderName,
        text: norm.text,
        atBot: false,
        time: event.time,
      });

      const s = this.sessions.get(chatId);
      if (s.isGenerating) return;
      s.isGenerating = true;
      try {
        await this.generate(chatId, false, event.user_id, senderName, ctx);
      } finally {
        s.isGenerating = false;
      }
    } catch (err) {
      await this.safeErrorReply(ctx, err);
    }
  }

  /** 命令分发：取第一个空白前 token 去掉 '/' 作为命令名，构造 CommandContext 执行 */
  private async dispatchCommand(raw: string, chatId: string, ctx: SnowLumaEventContext): Promise<void> {
    const spaceIdx = raw.indexOf(' ');
    const head = spaceIdx >= 0 ? raw.slice(0, spaceIdx) : raw;
    const name = head.slice(1); // 去掉开头的 '/'
    const rest = spaceIdx >= 0 ? raw.slice(spaceIdx + 1) : '';
    const cmd = this.registry.findCommand(name);
    if (!cmd) {
      log.debug('未知命令', { chatId, name });
      return; // 未知命令静默忽略
    }
    log.info('命令', { chatId, name });
    await cmd.handler({
      chatId,
      rest,
      reply: async (t: string) => {
        await ctx.reply(text(t));
      },
      sessions: this.sessions,
      config: this.config,
    });
  }

  /** 生成并回复：组装 system + 上下文 → agent loop → 分条回复 → 记 bot 回复日志 */
  private async generate(
    chatId: string,
    atBot: boolean,
    senderId: number,
    senderName: string,
    ctx: SnowLumaEventContext,
  ): Promise<void> {
    const s = this.sessions.get(chatId);
    const persona = s.personaOverride ?? this.config.persona;
    const system: LLMMessage = {
      role: 'system',
      content: `${persona}\n可用工具：${this.registry.getSkills().map((x) => x.name).join('、')}`,
    };
    const messages: LLMMessage[] = [system, ...s.buildContext()];
    log.info('开始生成', { chatId, atBot });
    const startedAt = Date.now();

    const res = await runAgentLoop({
      provider: this.provider,
      skills: this.registry.getSkills(),
      messages,
      maxIterations: this.config.maxToolIterations,
      temperature: this.config.llm.temperature,
      maxTokens: this.config.llm.maxTokens,
      chatId,
      senderId,
      senderName,
    });
    log.info('回复完成', { chatId, ms: Date.now() - startedAt, toolCalls: res.toolCallsUsed, chars: res.text.length });

    if (res.error) {
      await ctx.reply(text(`（出错了：${res.error}）`));
    } else {
      const chunks = splitText(res.text, MAX_CHUNK);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        // 群聊且 @ 了机器人时，第一条前加 @ 发送者
        const chain = atBot && i === 0 ? at(senderId).text(chunk) : text(chunk);
        await ctx.reply(chain);
      }
    }

    // 记 bot 回复日志（供上下文连贯）
    s.append({
      role: 'assistant',
      senderId: undefined,
      senderName: this._botNickname,
      text: res.text,
      atBot: false,
      time: Date.now(),
    });
  }

  /** 非命令路径兜底：异常回复「内部出错了」，绝不冒泡 */
  private async safeErrorReply(ctx: SnowLumaEventContext, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('内部出错了', { err: msg });
    try {
      await ctx.reply(text(`内部出错了：${msg}`));
    } catch {
      // 回复失败也静默，避免二次抛错
    }
  }
}
