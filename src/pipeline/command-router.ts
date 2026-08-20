import { text } from '@snowluma/sdk';
import type { OneBotMessageEvent, SnowLumaEventContext } from '@snowluma/sdk';
import type { BotConfig } from '../config';
import type { SessionManager } from '../session/manager';
import type { SkillRegistry } from '../skills/registry';
import type { PluginCliRegistry } from '../msp/plugin-cli-registry';
import { logger } from '../logging/logger';
import { sendLogged } from '../logging/send-log';

const log = logger.child('command-router');

export interface PluginCommandRouteResult {
  handled: boolean;
}

/** 把 OneBot 事件边界归一化成插件 CLI 使用的群/私聊上下文。 */
export function normalizeGroupId(event: OneBotMessageEvent): number | undefined {
  const value = 'group_id' in event ? Number(event.group_id) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** CLI 参数标量解析；命令业务参数与宿主 context 分离。 */
function scalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const number = Number(value);
  return Number.isNaN(number) ? value : number;
}

/** 将聊天 positional/flags 归一化为 manifest command input。 */
export function parsePluginCommandInput(command: string, args: string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equal = raw.indexOf('=');
    if (equal >= 0) {
      input[raw.slice(0, equal)] = scalar(raw.slice(equal + 1));
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      input[raw] = scalar(next);
      i++;
    } else {
      input[raw] = true;
    }
  }
  if (command === '选人' && input.count === undefined && positional[0] !== undefined) input.count = scalar(positional[0]);
  if (command === '查撤回' && input.count === undefined && positional[0] !== undefined) input.count = scalar(positional[0]);
  if (command === '重放' && input.index === undefined && positional[0] !== undefined) input.index = scalar(positional[0]);
  if (command === '课堂提醒' && input.mode === undefined && positional[0] !== undefined) input.mode = positional[0];
  return input;
}

/**
 * 插件 CLI 分流器：命中注册命令后永远消费消息；未命中才交给普通 Shell。
 * 这里是“命令 vs bash”的唯一分流边界，不在 Shell handler 中重复判断。
 */
export class PluginCommandRouter {
  private readonly registry: SkillRegistry;
  private readonly cliRegistry: PluginCliRegistry;
  private readonly sessions: SessionManager;
  private readonly config: BotConfig;

  constructor(registry: SkillRegistry, cliRegistry: PluginCliRegistry, sessions: SessionManager, config: BotConfig) {
    this.registry = registry;
    this.cliRegistry = cliRegistry;
    this.sessions = sessions;
    this.config = config;
  }

  async dispatch(raw: string, ctx: SnowLumaEventContext): Promise<PluginCommandRouteResult> {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    const commandName = tokens[0] ?? '';
    const entry = this.cliRegistry.find(commandName);
    if (!entry) return { handled: false };

    const event = ctx.event as OneBotMessageEvent;
    const groupId = normalizeGroupId(event);
    const senderId = typeof event.user_id === 'number' ? event.user_id : Number(event.user_id);
    const normalizedSenderId = Number.isSafeInteger(senderId) ? senderId : undefined;
    const senderName = event.sender?.nickname || (normalizedSenderId === undefined ? '未知用户' : `用户${normalizedSenderId}`);
    const chatId = groupId === undefined ? `p:${normalizedSenderId ?? ''}` : `g:${groupId}`;
    const args = tokens.slice(1);
    const input = parsePluginCommandInput(entry.command, args);
    const source = 'chat' as const;

    log.info('命中插件 CLI', {
      module: 'src/pipeline/command-router.ts',
      plugin: entry.manifest.name,
      command: entry.command,
      chatId,
      groupId,
      senderId: normalizedSenderId,
      input,
    });

    const result = await this.cliRegistry.invoke(
      commandName,
      { name: entry.command, arguments: args, rawInput: raw },
      {
        chatId,
        groupId,
        senderId: normalizedSenderId,
        senderName,
        source,
        workspace: '/',
        input,
        commandContext: {
          chatId,
          groupId,
          senderId: normalizedSenderId,
          senderName,
          rest: args.join(' '),
          input,
          reply: async (message) => { await sendLogged((out) => ctx.reply(text(String(out))), { module: 'src/pipeline/command-router.ts', command: entry.command, chatId, groupId, senderId: normalizedSenderId, messageType: 'text' }, message); },
          send: (message) => sendLogged((out) => ctx.reply(out as never), { module: 'src/pipeline/command-router.ts', command: entry.command, chatId, groupId, senderId: normalizedSenderId, messageType: 'segments' }, message),
          api: ctx.client,
          sessions: this.sessions,
          config: this.config,
        },
      },
    );

    const output = [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ''].filter(Boolean).join('\n');
    log.info('命令 CLI 输出', { module: 'src/pipeline/command-router.ts', plugin: entry.manifest.name, command: entry.command, chatId, groupId, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
    if (output) {
      await sendLogged((message) => ctx.reply(message as never), { module: 'src/pipeline/command-router.ts', command: entry.command, chatId, groupId, senderId: normalizedSenderId, messageType: 'text' }, output);
    }
    if (result.exitCode !== 0) {
      log.warn('插件 CLI 拒绝或执行失败', {
        module: 'src/msp/plugin-cli-registry.ts',
        plugin: entry.manifest.name,
        command: entry.command,
        exitCode: result.exitCode,
        chatId,
        groupId,
        senderId: normalizedSenderId,
        reason: result.stderr || '无错误详情',
      });
    }
    return { handled: true };
  }
}
