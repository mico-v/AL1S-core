import { createServer, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SnowLumaApiClient, OutgoingMessage } from '@snowluma/sdk';
import type { BotConfig } from '../config';
import type { SessionManager } from '../session/manager';
import type { SkillRegistry } from '../skills/registry';
import { validateArgs } from '../skills/registry';
import type { CommandBrokerRequest, CommandBrokerResponse, CommandBrokerEffect } from './command-protocol';
import { cliPluginManifests } from '../cli/plugins';
import { logger } from '../logging/logger';
import { logSend } from '../logging/send-log';

const log = logger.child('command-broker');

const MAX_FRAME_BYTES = 1_000_000;

/**
 * MSP CLI 宿主代理：CLI 进程只通过本机 Unix socket 调用宿主插件状态和 OneBot 能力。
 * stdout 是业务文本，富消息通过宿主 API 发送并只返回脱敏 effect 摘要。
 */
export class CommandBroker {
  readonly socketPath: string;
  readonly auth: string;
  private readonly registry: SkillRegistry;
  private readonly sessions: SessionManager;
  private readonly api: SnowLumaApiClient;
  private readonly config: BotConfig;
  private server?: Server;
  private accepting = false;
  private readonly invocationCache = new Map<string, CommandBrokerResponse>();

  constructor(
    registry: SkillRegistry,
    sessions: SessionManager,
    api: SnowLumaApiClient,
    config: BotConfig,
    socketPath = './data/msp-command.sock',
  ) {
    this.registry = registry;
    this.sessions = sessions;
    this.api = api;
    this.config = config;
    this.socketPath = resolve(socketPath);
    this.auth = randomUUID();
  }

  async start(): Promise<void> {
    const parent = dirname(this.socketPath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { chmodSync(parent, 0o700); } catch { /* Windows/权限受限时继续 */ }
    if (existsSync(this.socketPath)) {
      try {
        if (statSync(this.socketPath).isSocket()) unlinkSync(this.socketPath);
      } catch { /* 残留 socket 无法确认类型时不覆盖任意文件 */ }
    }
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
    try { chmodSync(this.socketPath, 0o600); } catch { /* Windows 忽略 */ }
    this.accepting = true;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try { if (existsSync(this.socketPath)) unlinkSync(this.socketPath); } catch { /* 忽略清理失败 */ }
  }

  private accept(socket: Socket): void {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        socket.destroy(new Error('命令代理请求过大'));
        return;
      }
      while (true) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void this.handleLine(line, socket);
      }
    });
  }

  private async handleLine(line: string, socket: Socket): Promise<void> {
    let response: CommandBrokerResponse;
    try {
      const request = JSON.parse(line) as CommandBrokerRequest;
      response = await this.invoke(request);
    } catch (error) {
      response = {
        protocol: 'al1s.command-broker.v1',
        id: 'invalid',
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        effects: [],
      };
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
  }

  private async invoke(request: CommandBrokerRequest): Promise<CommandBrokerResponse> {
    const base = {
      protocol: 'al1s.command-broker.v1' as const,
      id: request.id,
      effects: [] as CommandBrokerEffect[],
      stdout: '',
      stderr: '',
      exitCode: 1,
      ok: false,
    };
    if (!this.accepting || request.protocol !== 'al1s.command-broker.v1' || request.op !== 'invoke') return { ...base, stderr: '命令代理未接受请求' };
    if (request.auth !== this.auth) return { ...base, exitCode: 126, stderr: '命令代理认证失败' };
    const cached = this.invocationCache.get(request.id);
    if (cached) return cached;
    if (!request.command || request.plugin !== request.plugin.trim()) return { ...base, exitCode: 2, stderr: '命令参数非法' };
    if (!request.context.chatId) return { ...base, exitCode: 2, stderr: '缺少 chatId' };
    const descriptor = this.registry.getAllPluginCommands().find((item) => item.plugin === request.plugin && (item.name === request.command || item.aliases.includes(request.command)));
    log.info('收到插件 CLI 请求', { module: 'src/msp/command-broker.ts', plugin: request.plugin, command: request.command, chatId: request.context.chatId, groupId: request.context.groupId, senderId: request.context.senderId, input: request.input });
    const manifest = cliPluginManifests.find((item) => item.name === request.plugin);
    if (!descriptor || !descriptor.enabled) return { ...base, exitCode: 126, stderr: `命令未启用：${request.command}` };
    const spec = manifest?.commands.find((item) => item.name === descriptor.name);
    if (spec?.permission === 'admin' && !this.isAdmin(request.context.senderId)) return { ...base, exitCode: 126, stderr: '该命令仅管理员可用' };
    if (spec?.permission === 'owner' && request.context.senderId === undefined) return { ...base, exitCode: 126, stderr: '该命令需要发起人身份' };
    if (descriptor.supportsChat === false && request.source === 'chat') return { ...base, exitCode: 126, stderr: `命令不支持聊天调用：${request.command}` };
    if (descriptor.supportsAgent === false && request.source === 'agent') return { ...base, exitCode: 126, stderr: `命令不支持 Agent 调用：${request.command}` };
    if (descriptor.kind === 'command' && request.command === '同步课表' && request.context.groupId === undefined) return { ...base, exitCode: 126, stderr: '同步课表只能在群聊中执行' };
    const output: string[] = [];
    const effects: CommandBrokerEffect[] = [];
    const reply = async (message: string): Promise<void> => {
      output.push(message);
    };
    const send = async (message: OutgoingMessage): Promise<unknown> => {
      if (request.context.groupId !== undefined) {
        await this.api.sendGroupMessage(request.context.groupId, message);
        logSend({ module: 'src/msp/command-broker.ts', command: request.command, chatId: request.context.chatId, groupId: request.context.groupId, senderId: request.context.senderId, messageType: 'group' }, message);
        effects.push({ type: 'message', target: `g:${request.context.groupId}`, summary: '已发送群消息' });
      } else if (request.context.senderId !== undefined) {
        await this.api.sendPrivateMessage(request.context.senderId, message);
        logSend({ module: 'src/msp/command-broker.ts', command: request.command, chatId: request.context.chatId, senderId: request.context.senderId, messageType: 'private' }, message);
        effects.push({ type: 'message', target: `p:${request.context.senderId}`, summary: '已发送私聊消息' });
      }
      return undefined;
    };
    try {
      const command = this.registry.findCommand(descriptor.name);
      if (command) {
        const rest = commandRest(request.command, request.args, request.input);
        await command.handler({
          chatId: request.context.chatId,
          groupId: request.context.groupId,
          senderId: request.context.senderId,
          senderName: request.context.senderName,
          rest,
          input: request.input,
          reply,
          send,
          api: this.api,
          sessions: this.sessions,
          config: this.config,
        });
      } else {
        const skill = this.registry.findSkill(descriptor.name);
        if (!skill) return { ...base, exitCode: 127, stderr: `宿主未找到命令：${descriptor.name}` };
        const args = validateArgs(skill.inputSchema, request.input);
        output.push(await skill.run(args, {
          chatId: request.context.chatId,
          senderId: request.context.senderId,
          senderName: request.context.senderName ?? '',
          config: this.config,
        }));
      }
      const response = { ...base, ok: true, exitCode: 0, stdout: output.filter(Boolean).join('\n'), effects };
      this.invocationCache.set(request.id, response);
      return response;
    } catch (error) {
      const response = { ...base, exitCode: 1, stderr: error instanceof Error ? error.message : String(error), effects };
      this.invocationCache.set(request.id, response);
      return response;
    }
  }
  private isAdmin(senderId: number | undefined): boolean {
    return (this.config.adminIds.length === 0) || (senderId !== undefined && this.config.adminIds.includes(senderId));
  }
}

function commandRest(command: string, args: string[], input: Record<string, unknown>): string {
  if (command === '选人') return String(input.count ?? args.find((item) => /^\d+$/.test(item)) ?? '');
  if (command === '查撤回') return String(input.count ?? args.find((item) => /^\d+$/.test(item)) ?? '');
  if (command === '重放') return String(input.index ?? args.find((item) => /^\d+$/.test(item)) ?? '');
  if (command === '课堂提醒') return String(input.mode ?? args.find((item) => !item.startsWith('--')) ?? 'status');
  return args.join(' ');
}
