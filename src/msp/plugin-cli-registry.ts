import type { MspCommandDescriptor, MspCommandResult } from './protocol/types';
import type { CliHandler, CliPluginManifest, CliPluginContext } from './plugin-cli-types';
import type { MspPluginCliExecutor } from './plugin-cli-executor';
import type { SessionCommandRunner } from './session-command-runner';
import { logReject } from '../logging/send-log';

export interface PluginCliCommandEntry {
  manifest: CliPluginManifest;
  handler: CliHandler;
  command: string;
  aliases: string[];
  enabled: boolean;
}

/** 插件 CLI 注册表：只保存 manifest 与统一 MSP executor。 */
export class PluginCliRegistry {
  private readonly commands = new Map<string, PluginCliCommandEntry>();
  private readonly pluginEnabled = new Map<string, boolean>();
  private runtimeEnabled = true;
  private config?: { adminIds: number[] };
  private executor?: MspPluginCliExecutor;
  private sessionRunner?: SessionCommandRunner;

  setConfig(config: { adminIds: number[] }): void { this.config = config; }
  setExecutor(executor: MspPluginCliExecutor | undefined): void { this.executor = executor; }
  setSessionRunner(runner: SessionCommandRunner | undefined): void { this.sessionRunner = runner; }
  setRuntimeEnabled(enabled: boolean): void { this.runtimeEnabled = enabled; }
  hasExecutor(): boolean { return this.executor !== undefined; }

  register(manifest: CliPluginManifest, command: string, handler: CliHandler, aliases: string[] = []): void {
    if (!manifest.commands.some((item) => item.name === command)) throw new Error(`CLI manifest 未声明命令：${manifest.name}/${command}`);
    if (this.commands.has(command)) throw new Error(`CLI command 重复注册：${command}`);
    if (!this.pluginEnabled.has(manifest.name)) this.pluginEnabled.set(manifest.name, manifest.enabled);
    this.commands.set(command, { manifest, handler, command, aliases, enabled: manifest.enabled });
  }

  find(name: string): PluginCliCommandEntry | undefined {
    return this.commands.get(name) ?? [...this.commands.values()].find((item) => item.aliases.includes(name));
  }

  async invoke(name: string, invocation: Parameters<CliHandler>[0], context: CliPluginContext): Promise<MspCommandResult> {
    const command = this.find(name);
    if (!command) return { stdout: '', stderr: `command not found: ${name}\n`, exitCode: 127 };
    const spec = command.manifest.commands.find((entry) => entry.name === command.command);
    if (command.manifest.execution !== 'runtime') return { stdout: '', stderr: `命令 ${name} 不是 runtime CLI\n`, exitCode: 126 };
    if (!this.runtimeEnabled) return { stdout: '', stderr: 'MSP 模拟执行器未启用\n', exitCode: 126 };
    if (!command.enabled || this.pluginEnabled.get(command.manifest.name) === false) return { stdout: '', stderr: `command disabled: ${name}\n`, exitCode: 126 };
    if (spec?.permission === 'admin' && !this.isAdmin(context.senderId)) return { stdout: '', stderr: '该命令仅管理员可用\n', exitCode: 126 };
    if (spec?.permission === 'owner' && context.senderId === undefined) return { stdout: '', stderr: '该命令需要发起人身份\n', exitCode: 126 };
    if (this.sessionRunner) {
      if (!context.chatId) return { stdout: '', stderr: 'CLI 缺少 chatId\n', exitCode: 2 };
      const commandLine = [command.command, ...invocation.arguments.map(shellQuote)].join(' ');
      const result = await this.sessionRunner.run(commandLine, { chatId: context.chatId, groupId: context.groupId, senderId: context.senderId, senderName: context.senderName, source: context.source === 'agent' ? 'agent' : 'chat' });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1, effects: result.effects };
    }
    const reason = 'SessionCommandRunner 未配置，拒绝回退到旧 CLI executor';
    logReject({ module: 'src/msp/plugin-cli-registry.ts', command: command.command, chatId: context.chatId, groupId: context.groupId, senderId: context.senderId, reason });
    return { stdout: '', stderr: `${reason}\n`, exitCode: 126 };
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const command = this.find(name);
    if (!command) return false;
    command.enabled = enabled;
    return true;
  }

  setPluginEnabled(name: string, enabled: boolean): boolean {
    if (!this.commandsByPlugin(name).length) return false;
    this.pluginEnabled.set(name, enabled);
    return true;
  }

  isPluginEnabled(name: string): boolean { return this.pluginEnabled.get(name) ?? true; }

  private commandsByPlugin(name: string): PluginCliCommandEntry[] {
    return [...this.commands.values()].filter((item) => item.manifest.name === name);
  }

  list(): Array<MspCommandDescriptor & { id: string; aliases: string[]; inputSchema?: Record<string, unknown>; execution?: string; supportsChat: boolean; supportsAgent: boolean }> {
    return [...this.commands.values()].map((item) => {
      const spec = item.manifest.commands.find((entry) => entry.name === item.command);
      return {
        id: `${item.manifest.name}:command:${item.command}`,
        name: item.command,
        summary: spec?.summary,
        plugin: item.manifest.name,
        executable: item.manifest.entrypoint,
        lookupPaths: item.aliases,
        aliases: item.aliases,
        inputSchema: spec?.inputSchema,
        execution: item.manifest.execution,
        supportsChat: spec?.supportsChat ?? item.manifest.supportsChat ?? true,
        supportsAgent: spec?.supportsAgent ?? item.manifest.supportsAgent ?? false,
        enabled: item.enabled && this.isPluginEnabled(item.manifest.name) && this.runtimeEnabled,
      };
    });
  }
  private isAdmin(senderId: number | undefined): boolean {
    const adminIds = this.config?.adminIds ?? [];
    return adminIds.length === 0 || (senderId !== undefined && adminIds.includes(senderId));
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
