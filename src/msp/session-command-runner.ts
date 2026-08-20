import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MspRuntime, MspToolResult } from './protocol/types';
import type { MspWorkspace } from './workspace';
import type { PluginCliRegistry } from './plugin-cli-registry';
import type { CommandBroker } from './command-broker';
import type { SessionSandboxManager } from './session-sandbox-manager';
import { logger } from '../logging/logger';
import { COMMAND_BROKER_EFFECT_MARKER, type CommandBrokerEffect } from './command-protocol';
import { logReject } from '../logging/send-log';

const log = logger.child('session-cli');

export interface SessionCommandContext {
  chatId: string;
  groupId?: number;
  senderId?: number;
  senderName?: string;
  source: 'chat' | 'agent';
}

export interface SessionCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  effects: CommandBrokerEffect[];
  internal: MspToolResult['internal'];
}

/**
 * 每个会话的标准 bash 执行入口。
 * 插件命令只是 PATH 中的普通 executable，因此 pipe/redirect/&& 等全部由 bash 处理。
 */
export class SessionCommandRunner {
  private readonly runtime: MspRuntime;
  private readonly workspace: MspWorkspace;
  private readonly cliRegistry: PluginCliRegistry;
  private readonly broker?: CommandBroker;
  private readonly manager?: SessionSandboxManager;
  private readonly entryFile: string;
  private readonly executable: string;

  constructor(runtime: MspRuntime, workspace: MspWorkspace, cliRegistry: PluginCliRegistry, broker?: CommandBroker);
  constructor(manager: SessionSandboxManager, cliRegistry: PluginCliRegistry, broker?: CommandBroker);
  constructor(runtimeOrManager: MspRuntime | SessionSandboxManager, workspaceOrCli: MspWorkspace | PluginCliRegistry, cliOrBroker?: PluginCliRegistry | CommandBroker, broker?: CommandBroker) {
    if (isRuntime(runtimeOrManager)) {
      this.runtime = runtimeOrManager;
      this.workspace = workspaceOrCli as MspWorkspace;
      this.cliRegistry = cliOrBroker as PluginCliRegistry;
      this.broker = broker;
    } else {
      this.manager = runtimeOrManager;
      this.runtime = undefined as unknown as MspRuntime;
      this.workspace = undefined as unknown as MspWorkspace;
      this.cliRegistry = workspaceOrCli as PluginCliRegistry;
      this.broker = cliOrBroker as CommandBroker | undefined;
    }
    const here = dirname(fileURLToPath(import.meta.url));
    this.entryFile = resolve(here, '../cli/entry.ts');
    this.executable = resolve(here, '../../node_modules/.bin/tsx');
  }

  async inspectAvailability(): Promise<{ available: boolean; backend?: 'podman' | 'docker' | 'local-bash'; isolated: boolean; reason?: string }> {
    if (this.manager) return await this.manager.inspect();
    return { available: true, isolated: true };
  }

  async run(commandText: string, context: SessionCommandContext): Promise<SessionCommandResult> {
    const command = commandText.trim();
    if (!command) {
      const reason = '命令不能为空';
      const publicReason = '命令拒绝（模块：src/msp/session-command-runner.ts）：命令不能为空';
      logReject({ module: 'src/msp/session-command-runner.ts', sourceModule: 'src/msp/session-command-runner.ts', command: redactCommand(command), chatId: context.chatId, groupId: context.groupId, senderId: context.senderId, reason });
      return { stdout: '', stderr: publicReason, exitCode: 2, effects: [], internal: emptyInternal() };
    }
    try {
      return await this.runAvailable(command, context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return unavailableResult(command, context, reason);
    }
  }

  private async runAvailable(command: string, context: SessionCommandContext): Promise<SessionCommandResult> {
    const sandbox = this.manager ? await this.manager.get(context.chatId) : undefined;
    const runtime = sandbox?.runtime ?? this.runtime;
    const workspace = sandbox?.workspace ?? this.workspace;
    const bin = await this.ensureCommandBin(workspace, sandbox?.backend);
    const environment: Record<string, string> = {
      PATH: sandbox?.isolated
        ? `${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
        : `${bin}:${process.env.PATH ?? ''}`,
      AL1S_CHAT_ID: context.chatId,
      AL1S_COMMAND_SOURCE: context.source,
      ...(context.groupId === undefined ? {} : { AL1S_GROUP_ID: String(context.groupId) }),
      ...(context.senderId === undefined ? {} : { AL1S_SENDER_ID: String(context.senderId) }),
      ...(context.senderName === undefined ? {} : { AL1S_SENDER_NAME: context.senderName }),
    };
    if (this.broker) {
      // 容器内只暴露固定 capability socket；绝不把宿主 Docker/Podman socket 暴露给执行面。
      environment.AL1S_COMMAND_SOCKET = sandbox?.isolated ? '/run/al1s/command.sock' : this.broker.socketPath;
      environment.AL1S_COMMAND_TOKEN = this.broker.auth;
      environment.AL1S_COMMAND_CONTEXT = Buffer.from(JSON.stringify({
        chatId: context.chatId,
        groupId: context.groupId,
        senderId: context.senderId,
        senderName: context.senderName,
        source: context.source,
        workspace: '/',
      })).toString('base64url');
    }
    log.info('启动会话 bash', { module: 'src/msp/session-command-runner.ts', command: redactCommand(command), chatId: context.chatId, groupId: context.groupId, senderId: context.senderId, sourceModule: 'src/msp/session-command-runner.ts', source: context.source });
    let result = await runtime.execCommand({ cmd: command, workdir: '/', shell: '/bin/bash' }, {
      chatId: context.chatId,
      actorId: context.senderId,
      actorName: context.senderName,
      workspaceId: '/',
      environment,
      audit: { source: context.source, command },
    });
    while (result.internal.running && result.internal.sessionId !== undefined) {
      result = await runtime.writeStdin({ session_id: result.internal.sessionId, chars: '', yield_time_ms: 5000 }, { chatId: context.chatId, actorId: context.senderId, actorName: context.senderName });
    }
    log.info('会话 bash 完成', { module: 'src/msp/session-command-runner.ts', command: redactCommand(command), chatId: context.chatId, groupId: context.groupId, senderId: context.senderId, sourceModule: 'src/msp/session-command-runner.ts', exitCode: result.internal.exitCode, stdout: redactOutput(result.internal.stdout), stderr: redactOutput(stripEffects(result.internal.stderr)) });
    return { stdout: result.internal.stdout, stderr: stripEffects(result.internal.stderr), exitCode: result.internal.exitCode, effects: extractEffects(result.internal.stderr), internal: result.internal };
  }

  private async ensureCommandBin(workspace: MspWorkspace, backend?: 'podman' | 'docker' | 'local-bash'): Promise<string> {
    return this.createCommandBin(workspace, backend);
  }

  private async createCommandBin(workspace: MspWorkspace, backend?: 'podman' | 'docker' | 'local-bash'): Promise<string> {
    const resolved = await workspace.resolveVirtualPath('/.msp/bin');
    await mkdir(resolved.hostPath, { recursive: true });
    for (const command of this.cliRegistry.list().filter((item) => item.enabled)) {
      const names = [command.name, ...(command.aliases ?? [])];
      for (const name of names) {
        if (!isSafeCommandName(name)) continue;
        const target = join(resolved.hostPath, name);
        const executable = backend === 'podman' || backend === 'docker' ? '/app/node_modules/.bin/tsx' : this.executable;
        const entryFile = backend === 'podman' || backend === 'docker' ? '/app/src/cli/entry.ts' : this.entryFile;
        const script = `#!/bin/sh\nexec ${shellQuote(executable)} ${shellQuote(entryFile)} ${shellQuote(command.name)} "$@"\n`;
        await writeFile(target, script, 'utf8');
        await chmod(target, 0o700);
      }
    }
    return resolved.hostPath;
  }
}

function extractEffects(stderr: string): CommandBrokerEffect[] {
  const effects: CommandBrokerEffect[] = [];
  for (const line of stderr.split('\n')) {
    if (!line.startsWith(COMMAND_BROKER_EFFECT_MARKER)) continue;
    try {
      const decoded = Buffer.from(line.slice(COMMAND_BROKER_EFFECT_MARKER.length), 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as unknown;
      if (Array.isArray(parsed)) effects.push(...parsed.filter(isCommandBrokerEffect));
    } catch {
      // 损坏的 effects marker 不得影响命令 stderr/退出码。
    }
  }
  return effects;
}

function stripEffects(stderr: string): string {
  return stderr.split('\n').filter((line) => !line.startsWith(COMMAND_BROKER_EFFECT_MARKER)).join('\n').replace(/\n+$/, '');
}

function isCommandBrokerEffect(value: unknown): value is CommandBrokerEffect {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string' && typeof (value as { summary?: unknown }).summary === 'string';
}

function isRuntime(value: MspRuntime | SessionSandboxManager): value is MspRuntime {
  return 'execCommand' in value;
}

function isSafeCommandName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function redactCommand(command: string): string {
  const first = command.trim().split(/\s+/u)[0] ?? '';
  return first ? `${first} [已脱敏]` : '[空命令]';
}

function redactOutput(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/(token|password|secret|key|authorization)=?[^ ]*/gi, '$1=[已脱敏]')
    .slice(0, 500);
}

function unavailableResult(command: string, context: SessionCommandContext, reason: string): SessionCommandResult {
  const message = '工具执行失败（模块：src/msp/session-command-runner.ts）：Session sandbox 不可用，已停止处理。';
  const internal = { ...emptyInternal(), stderr: message, combinedOutput: message, stderrBytes: Buffer.byteLength(message), exitCode: 126, error: { code: 'SANDBOX_UNAVAILABLE', message, retryable: false } };
  log.warn('拒绝执行命令', { module: 'src/msp/session-command-runner.ts', command: redactCommand(command), chatId: context.chatId, groupId: context.groupId, senderId: context.senderId, sourceModule: 'src/msp/session-command-runner.ts', reason: redactOutput(reason) });
  return { stdout: '', stderr: message, exitCode: 126, effects: [], internal };
}

function emptyInternal(): MspToolResult['internal'] {
  return { operation: 'exec_command', state: 'not_started', backend: 'pipe', startedAt: Date.now(), durationMs: 0, stdout: '', stderr: '', combinedOutput: '', stdoutBytes: 0, stderrBytes: 0, outputTruncated: false, exitCode: 2, signal: null, running: false };
}
