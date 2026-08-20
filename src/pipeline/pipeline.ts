/**
 * 消息管道：归一化 → 命令分发 / 记日志 → 触发判定 → 冷却 → 并发锁 → 生成 → 回复。
 *
 * 群聊：仅 @ 或命中关键词触发，且有冷却与白名单；私聊恒触发。
 * 全程 try/catch，异常回复「内部出错了」，绝不冒泡到 SDK 事件循环。
 */
import { at, text } from '@snowluma/sdk';
import type { OneBotGroupMessageEvent, OneBotMessageEvent, OneBotPrivateMessageEvent, SnowLumaEventContext } from '@snowluma/sdk';
import { runAgentLoop } from '../agent/loop';
import type { LLMMessage, LLMProvider } from '../llm/types';
import { logger } from '../logging/logger';
import { metrics } from '../metrics';
import type { BotConfig } from '../config';
import type { SessionManager } from '../session/manager';
import type { SkillRegistry } from '../skills/registry';
import type { OutputFormatter } from '../format/formatter';
import type { MspAgentBridge } from '../msp/agent-bridge';
import type { ExecCommandInput, WriteStdinInput } from '../msp/protocol/types';
import type { AdminCommandDispatcher } from '../admin/commands';
import type { PluginCliRegistry } from '../msp/plugin-cli-registry';
import type { SessionCommandRunner } from '../msp/session-command-runner';
import { normalizeMessage } from './normalize';
import { evaluateTrigger } from './trigger';
import { getToolName } from '../agent/tool-names';
import { sendLogged } from '../logging/send-log';

const log = logger.child('pipeline');

/** 管道依赖：由 bot.ts 组装注入 */
export interface PipelineDeps {
  config: BotConfig;
  provider: LLMProvider;
  sessions: SessionManager;
  registry: SkillRegistry;
  botNickname?: string;
  formatter?: OutputFormatter; // 可开关的 LLM 输出格式化层
  mspBridge?: MspAgentBridge;
  adminCommands?: AdminCommandDispatcher;
  cliRegistry?: PluginCliRegistry;
  sessionCommandRunner?: SessionCommandRunner;
}

/** 单条回复的最大字数，超长分条发送 */
const MAX_CHUNK = 500;

/** 异步等待，用于分段发送的逐段延时 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  private readonly formatter?: OutputFormatter;
  private readonly mspBridge?: MspAgentBridge;
  private readonly adminCommands?: AdminCommandDispatcher;
  private readonly cliRegistry?: PluginCliRegistry;
  private readonly sessionCommandRunner?: SessionCommandRunner;
  private _botNickname: string;

  constructor(deps: PipelineDeps) {
    this.config = deps.config;
    this.provider = deps.provider;
    this.sessions = deps.sessions;
    this.registry = deps.registry;
    this.formatter = deps.formatter;
    this.mspBridge = deps.mspBridge;
    this.adminCommands = deps.adminCommands;
    this.cliRegistry = deps.cliRegistry;
    this.sessionCommandRunner = deps.sessionCommandRunner;
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
    metrics.messagesReceived++;
    log.debug('收到群消息', { group: event.group_id, user: event.user_id, atBot: norm.atBot, text: norm.text });

    // c) 命令分发：命令不记日志、不触发（同样兜底，异常回复「内部出错了」）
    if (norm.text.startsWith('/')) {
      try {
        const adminHandled = this.adminCommands ? await this.adminCommands.dispatch(norm.text, {
          chatId,
          senderId: event.user_id,
          senderName: event.sender.nickname || `用户${event.user_id}`,
          reply: async (message) => {
            await sendLogged((out) => ctx.reply(text(String(out))), { module: 'src/pipeline/pipeline.ts', command: 'builtin', chatId, senderId: event.user_id, messageType: 'text' }, message);
          },
        }) : false;
        // 普通插件只走 $/Agent；/ 保留给 builtin 管理命令。
        if (!adminHandled) log.debug('未知管理命令', { chatId, text: norm.text });
      } catch (err) {
        await this.safeErrorReply(ctx, err);
      }
      return;
    }

    try {
      const senderName = event.sender.nickname || `用户${event.user_id}`;
      // d) 记日志（时间统一毫秒：OneBot time 是秒）
      this.sessions.get(chatId).append({
        role: 'user',
        senderId: event.user_id,
        senderName,
        text: norm.text,
        atBot: norm.atBot,
        time: event.time * 1000,
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
    metrics.messagesReceived++;
    log.debug('收到私聊消息', { user: event.user_id, text: norm.text });

    if (norm.text.startsWith('/')) {
      try {
        const adminHandled = this.adminCommands ? await this.adminCommands.dispatch(norm.text, {
          chatId,
          senderId: event.user_id,
          senderName: event.sender.nickname || `用户${event.user_id}`,
          reply: async (message) => {
            await sendLogged((out) => ctx.reply(text(String(out))), { module: 'src/pipeline/pipeline.ts', command: 'builtin', chatId, senderId: event.user_id, messageType: 'text' }, message);
          },
        }) : false;
        // 普通插件只走 $/Agent；/ 保留给 builtin 管理命令。
        if (!adminHandled) log.debug('未知管理命令', { chatId, text: norm.text });
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
        time: event.time * 1000,
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

  /** 普通插件命令：命令描述来自统一 CLI registry，执行通过 MSP runtime。 */
  private async dispatchCommand(raw: string, chatId: string, ctx: SnowLumaEventContext): Promise<void> {
    const spaceIdx = raw.indexOf(' ');
    const head = spaceIdx >= 0 ? raw.slice(0, spaceIdx) : raw;
    const name = head.slice(1);
    const rest = spaceIdx >= 0 ? raw.slice(spaceIdx + 1) : '';
    const pluginCommand = this.registry.findPluginCommand(name);
    if (!pluginCommand || !pluginCommand.enabled) {
      log.debug('未知命令', { chatId, name });
      return;
    }

    const ev = ctx.event as OneBotMessageEvent;
    const groupId = 'group_id' in ev && typeof ev.group_id === 'number' ? ev.group_id : undefined;
    const senderId = ev.user_id;
    const senderName = ev.sender?.nickname || `用户${ev.user_id}`;
    log.info('命令', { chatId, name });

    if (this.cliRegistry?.find(name)) {
      const result = await this.cliRegistry.invoke(name, { name, arguments: rest ? rest.split(/\s+/) : [], rawInput: raw }, {
        chatId,
        senderId,
        senderName,
        workspace: '/',
        commandContext: {
          chatId,
          groupId,
          senderId,
          senderName,
          rest,
          reply: async (message) => {
            const out = this.formatter?.enabled && this.formatter.globalMarkdownKiller ? this.formatter.cleanText(message) : message;
            await sendLogged((out) => ctx.reply(out as never), { module: 'src/pipeline/pipeline.ts', command: name, chatId, groupId, senderId, messageType: 'text' }, out);
          },
          send: (message) => sendLogged((out) => ctx.reply(out as never), { module: 'src/pipeline/pipeline.ts', command: name, chatId, groupId, senderId, messageType: 'segments' }, message),
          api: ctx.client,
          sessions: this.sessions,
          config: this.config,
        },
      });
      const output = [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ''].filter(Boolean).join('\n');
      if (output) {
        const clean = this.formatter?.enabled && this.formatter.globalMarkdownKiller ? this.formatter.cleanText(output) : output;
        await sendLogged((out) => ctx.reply(text(String(out))), { module: 'src/pipeline/pipeline.ts', command: name, chatId, groupId, senderId, messageType: 'text' }, clean);
      }
      return;
    }

    return;
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
    const event = ctx.event as OneBotMessageEvent;
    const groupId = 'group_id' in event && typeof event.group_id === 'number' ? event.group_id : undefined;
    if (this.config.msp.enabled) {
      const availability = this.sessionCommandRunner
        ? await this.sessionCommandRunner.inspectAvailability()
        : { available: false, isolated: false, reason: 'SessionCommandRunner 未配置' };
      if (!availability.available || !this.mspBridge) {
        const reason = !availability.available ? (availability.reason ?? 'Session sandbox 不可用') : 'MspAgentBridge 未配置';
        log.warn('拒绝进入 Agent', { module: 'src/pipeline/pipeline.ts', sourceModule: 'src/msp/session-command-runner.ts', chatId, groupId, senderId, reason });
        const message = '工具执行失败（模块：src/msp/session-command-runner.ts）：Session sandbox 不可用，已停止处理。';
        await sendLogged((out) => ctx.reply(out as never), { module: 'src/pipeline/pipeline.ts', command: 'msp-sandbox', chatId, groupId, senderId, messageType: 'text' }, message);
        metrics.errors++;
        return;
      }
    }
    const persona = s.personaOverride ?? this.config.persona;
    const tools = this.registry.getEnabledSkills();
    const commandSkills = this.registry.getAllPluginCommands()
      .filter((command) => command.enabled && command.supportsAgent && command.kind === 'command');
    const mspTools = this.config.msp.enabled ? this.mspBridge!.getModelTools() : [];
    const agentSkills = [
      ...tools,
      ...commandSkills
        .filter((command) => !tools.some((skill) => skill.name === command.name))
        .map((command) => ({
          name: command.name,
          toolName: getToolName(command.name, command.plugin),
          description: command.description,
          inputSchema: command.inputSchema,
          run: async (args: Record<string, unknown>, context: { chatId: string; senderId?: number; senderName: string; signal?: AbortSignal }) => {
            const cliArgs = Object.entries(args).flatMap(([key, value]) => value === undefined ? [] : [`--${key}`, String(value)]);
            const result = await this.cliRegistry!.invoke(command.name, { name: command.name, arguments: cliArgs, rawInput: cliArgs.join(' ') }, { chatId: context.chatId, groupId, senderId: context.senderId, senderName: context.senderName, source: 'agent', workspace: '/', input: args });
            return [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ''].filter(Boolean).join('\n');
          },
        })),
      ...mspTools.map((tool) => ({
        name: tool.name,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        run: async (args: Record<string, unknown>, context: { chatId: string; senderId?: number; senderName: string; signal?: AbortSignal }) => {
          if (tool.name === 'exec_command' && this.sessionCommandRunner) {
            const request = args as unknown as ExecCommandInput;
            const result = await this.sessionCommandRunner.run(request.cmd, { chatId: context.chatId, groupId, senderId: context.senderId, senderName: context.senderName, source: 'agent' });
            return [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ''].filter(Boolean).join('\n');
          }
          if (tool.name === 'exec_command') return this.mspBridge!.execCommand(args as unknown as ExecCommandInput, { chatId: context.chatId, actorId: context.senderId, actorName: context.senderName, signal: context.signal }).then((result) => result.text);
          return this.mspBridge!.writeStdin(args as unknown as WriteStdinInput, { chatId: context.chatId, actorId: context.senderId, actorName: context.senderName, signal: context.signal }).then((result) => result.text);
        },
      })),
    ];
    const system: LLMMessage = {
      role: 'system',
      content: `${persona}\n可用工具：${agentSkills.map((x) => x.toolName ?? x.name).join('、')}`,
    };
    const messages: LLMMessage[] = [system, ...s.buildContext()];
    log.info('开始生成', { chatId, atBot });
    const startedAt = Date.now();

    const res = await runAgentLoop({
      provider: this.provider,
      skills: agentSkills,
      messages,
      maxIterations: this.config.maxToolIterations,
      temperature: this.config.llm.temperature,
      maxTokens: this.config.llm.maxTokens,
      chatId,
      senderId,
      senderName,
      signal: undefined,
      config: this.config,
    });
    log.info('回复完成', { chatId, ms: Date.now() - startedAt, toolCalls: res.toolCallsUsed, chars: res.text.length });
    metrics.toolCalls += res.toolCallsUsed;

    // 实际发送的文本：格式化层开启时先做 Markdown 清理
    const formatted = this.formatter?.enabled ? this.formatter.cleanText(res.text) : res.text;

    const responseText = res.error ? `（出错了：${res.error}）` : formatted;
    try {
      if (res.error) {
        metrics.errors++;
        await sendLogged((out) => ctx.reply(out as never), { module: 'src/pipeline/pipeline.ts', command: 'agent-error', chatId, groupId, senderId, messageType: 'text' }, responseText);
      } else if (this.formatter?.enabled && this.formatter.lineSplit) {
        const segs = this.formatter.buildSegments(formatted);
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i]!;
          const rendered = this.formatter.renderSegment(seg);
          const chain = atBot && i === 0 ? at(senderId).text(rendered) : text(rendered);
          await sendLogged((out) => ctx.reply(out as never), { module: 'src/pipeline/pipeline.ts', command: 'agent', chatId, groupId, senderId, messageType: 'text' }, chain);
          metrics.messagesSent++;
          const delay = this.formatter.segmentDelay(seg);
          if (delay > 0) await sleep(delay * 1000);
        }
      } else {
        const chunks = splitText(formatted, MAX_CHUNK);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!;
          const chain = atBot && i === 0 ? at(senderId).text(chunk) : text(chunk);
          await sendLogged((out) => ctx.reply(out as never), { module: 'src/pipeline/pipeline.ts', command: 'agent', chatId, groupId, senderId, messageType: 'text' }, chain);
          metrics.messagesSent++;
        }
      }
    } finally {
      // 即使 OneBot 发送失败，也保留 Agent 最终回复，避免上下文断裂。
      s.append({ role: 'assistant', senderId: undefined, senderName: this._botNickname, text: responseText, atBot: false, time: Date.now() });
    }
  }

  /** 非命令路径兜底：异常回复「内部出错了」，绝不冒泡 */
  private async safeErrorReply(ctx: SnowLumaEventContext, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    metrics.errors++;
    log.error('内部出错了', { module: 'src/pipeline/pipeline.ts', reason: msg });
    try {
      const message = '内部出错了（模块：src/pipeline/pipeline.ts），请稍后重试。';
      await sendLogged((out) => ctx.reply(out as never), { module: 'src/pipeline/pipeline.ts', command: 'error', messageType: 'text' }, message);
    } catch {
      // 回复失败也静默，避免二次抛错
    }
  }
}
