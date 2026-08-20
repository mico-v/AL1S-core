import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MspCommandResult, MspRuntime, MspRuntimeContext } from './protocol/types';
import type { CliPluginContext, CliPluginManifest } from './plugin-cli-types';
import type { CommandBroker } from './command-broker';

/** 通过当前 MSP runtime 启动插件 CLI；local-bash 只是这个接口的开发实现。 */
export class MspPluginCliExecutor {
  private readonly runtime: MspRuntime;
  private readonly entryFile: string;
  private readonly broker?: CommandBroker;
  private readonly brokerAuth?: string;
  private effects: unknown[] = [];

  constructor(runtime: MspRuntime, entryFile?: string, broker?: CommandBroker) {
    this.runtime = runtime;
    this.entryFile = entryFile ?? resolve(dirname(fileURLToPath(import.meta.url)), '../cli/entry.ts');
    this.broker = broker;
    this.brokerAuth = broker?.auth;
  }

  async run(
    manifest: CliPluginManifest,
    command: string,
    args: string[],
    context: CliPluginContext,
  ): Promise<MspCommandResult> {
    if (manifest.execution !== 'runtime') {
      return { stdout: '', stderr: `不支持的 CLI execution：${manifest.execution ?? 'unknown'}\n`, exitCode: 126 };
    }
    const executable = resolve(dirname(this.entryFile), '../../node_modules/.bin/tsx');
    const cmd = [quote(executable), quote(this.entryFile), quote(command), ...args.map(quote)].join(' ');
    const commandContext = JSON.stringify({ chatId: context.chatId, groupId: context.groupId, senderId: context.senderId, senderName: context.senderName, source: context.source ?? 'cli', workspace: context.workspace, input: context.input ?? {} });
    const encodedContext = Buffer.from(commandContext).toString('base64url');
    const env = this.broker && this.brokerAuth ? {
      AL1S_COMMAND_SOCKET: this.broker.socketPath,
      AL1S_COMMAND_TOKEN: this.brokerAuth,
      AL1S_COMMAND_CONTEXT: encodedContext,
      AL1S_COMMAND_PLUGIN: manifest.name,
      AL1S_COMMAND_SOURCE: context.source ?? 'cli',
    } : undefined;
    let result = await this.runtime.execCommand(
      { cmd, workdir: context.workspace, yield_time_ms: 250, max_output_tokens: 10000, shell: '/bin/bash' },
      {
        chatId: context.chatId,
        actorId: context.senderId,
        actorName: context.senderName,
        workspaceId: context.workspace,
        environment: env,
        audit: { plugin: manifest.name, command, mode: this.runtime.mode },
      } satisfies MspRuntimeContext,
    );
    // CLI 通常是短命令：模拟器先按 MSP yield 规则返回，随后由内部 runtime read path 收敛到终态。
    while (result.internal.running && result.internal.sessionId !== undefined) {
      result = await this.runtime.writeStdin({ session_id: result.internal.sessionId, chars: '', yield_time_ms: 5000, max_output_tokens: 10000 }, {
        chatId: context.chatId,
        actorId: context.senderId,
        actorName: context.senderName,
        workspaceId: context.workspace,
      });
    }
    return {
      stdout: result.internal.stdout,
      stderr: result.internal.stderr || (result.internal.error ? result.internal.error.message : ''),
      exitCode: result.internal.exitCode ?? (result.internal.running ? 0 : 1),
      effects: this.effects,
    };
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
