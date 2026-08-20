import type { MspCommandInvocation, MspCommandResult } from './protocol/types';
import type { CommandContext } from '../skills/registry';

export interface CliAction {
  type: 'reply' | 'send_text';
  text: string;
}

export interface CliPluginContext {
  chatId?: string;
  groupId?: number;
  senderId?: number;
  senderName?: string;
  source?: 'chat' | 'agent' | 'cli';
  workspace: string;
  input?: Record<string, unknown>;
  /** 仅宿主内使用，绝不序列化到 CLI 子进程。 */
  commandContext?: CommandContext;
  /** CLI 子进程通过 MSP side-channel 请求宿主能力。 */
  capabilityBroker?: MspCapabilityBroker;
}

export interface CliCommandSpec {
  name: string;
  summary: string;
  aliases?: string[];
  inputSchema?: Record<string, unknown>;
  risk?: 'low' | 'medium' | 'high';
  permission?: 'public' | 'admin' | 'owner';
  supportsChat?: boolean;
  supportsAgent?: boolean;
}

export interface CliPluginManifest {
  name: string;
  version: string;
  displayName: string;
  description: string;
  commands: CliCommandSpec[];
  entrypoint: string;
  enabled: boolean;
  execution?: 'runtime';
  supportsChat?: boolean;
  supportsAgent?: boolean;
}

export interface CliInvocation {
  protocol: 'al1s-plugin.v1';
  plugin: string;
  command: string;
  args: Record<string, unknown>;
  context: Omit<CliPluginContext, 'commandContext' | 'capabilityBroker'>;
}

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  actions: CliAction[];
}

export interface MspCapabilityRequest {
  type: 'invoke_command';
  command: string;
  arguments: string[];
}

export interface MspCapabilityResponse {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  effects?: unknown[];
}

export type MspCapabilityBroker = (request: MspCapabilityRequest) => Promise<MspCapabilityResponse>;

/** stdout 只保留命令业务文本；actions/stderr 不拼入 stdout。 */
export function renderCliResult(result: CliResult): string {
  return result.stdout;
}

export type CliHandler = (invocation: MspCommandInvocation, context: CliPluginContext) => Promise<CliResult>;

export function cliResultToMsp(result: CliResult): MspCommandResult {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.ok ? 0 : 1,
  };
}
