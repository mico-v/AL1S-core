import type { MspRuntime, MspToolResult, MspRuntimeCapabilities, MspCommandDescriptor, ExecCommandInput, WriteStdinInput, MspRuntimeContext, MspInternalResult } from './protocol/types';
import type { SessionCommandRunner } from './session-command-runner';

/** 将 AgentBridge 绑定到按会话选择隔离后端的统一 runner。 */
export class SessionMspRuntime implements MspRuntime {
  readonly mode = 'full' as const;
  private readonly runner: SessionCommandRunner;
  private commands: () => MspCommandDescriptor[];

  constructor(runner: SessionCommandRunner, commands: () => MspCommandDescriptor[] = () => []) {
    this.runner = runner;
    this.commands = commands;
  }

  setCommandDescriptors(commands: () => MspCommandDescriptor[]): void { this.commands = commands; }
  async execCommand(input: ExecCommandInput, context: MspRuntimeContext = {}): Promise<MspToolResult> {
    if (!context.chatId) return unsupported('exec_command', '缺少 chatId，无法选择会话 sandbox');
    const command = input.workdir && input.workdir !== '/' ? `cd ${quote(input.workdir)} && ${input.cmd}` : input.cmd;
    const result = await this.runner.run(command, {
      chatId: context.chatId,
      groupId: numberValue(context.audit?.groupId),
      senderId: context.actorId,
      senderName: context.actorName,
      source: context.audit?.source === 'agent' ? 'agent' : 'chat',
    });
    return { text: [result.stdout, result.stderr].filter(Boolean).join('\n'), internal: result.internal };
  }

  async writeStdin(_input: WriteStdinInput): Promise<MspToolResult> {
    return unsupported('write_stdin', '容器 sandbox 的命令由统一 runner 一次性收敛，不支持跨容器 stdin session');
  }

  async readSession(sessionId: number): Promise<MspToolResult> { return unsupported('read', `不存在 session：${sessionId}`); }
  async terminateSession(sessionId: number): Promise<MspToolResult> { return unsupported('terminate', `不存在 session：${sessionId}`); }
  listCommands(): MspCommandDescriptor[] { return this.commands(); }
  listSessions() { return []; }
  getCapabilities(): MspRuntimeCapabilities { return { protocol: 'msp-agent.v1', mode: 'full', tty: false, sessions: false, stdin: false, updatePlan: false, applyPatch: false }; }
  async dispose(): Promise<void> {}
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function numberValue(value: string | number | boolean | undefined): number | undefined { return typeof value === 'number' ? value : value === undefined ? undefined : Number(value); }
function unsupported(operation: MspInternalResult['operation'], message: string): MspToolResult {
  const internal: MspInternalResult = { operation, state: 'not_started', backend: 'pipe', startedAt: Date.now(), durationMs: 0, stdout: '', stderr: message, combinedOutput: '', stdoutBytes: 0, stderrBytes: Buffer.byteLength(message), outputTruncated: false, exitCode: 126, signal: null, running: false };
  return { text: message, internal };
}
