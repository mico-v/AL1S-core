/** MSP AgentBridge v1 的跨运行时数据结构。 */
export const MSP_PROTOCOL_VERSION = 'msp-agent.v1' as const;

export type MspProtocolVersion = typeof MSP_PROTOCOL_VERSION;
export type MspBackend = 'pipe' | 'pty';
export type MspSessionState = 'running' | 'completed' | 'interrupted' | 'terminated';
export type MspRuntimeMode = 'local-bash' | 'full';

/** 与 MSP exec_command.input.schema.json 对齐。 */
export interface ExecCommandInput {
  cmd: string;
  workdir?: string;
  shell?: string;
  tty?: boolean;
  yield_time_ms?: number;
  max_output_tokens?: number;
}

/** 与 MSP write_stdin.input.schema.json 对齐。 */
export interface WriteStdinInput {
  session_id: number;
  chars?: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
}

export interface MspErrorRecord {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, string | number | boolean | null>;
  cause?: string;
}

export interface MspOutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
  bytes: number;
  time: number;
}

export interface MspSessionSnapshot {
  sessionId: number;
  state: MspSessionState;
  backend: MspBackend;
  workdir: string;
  startedAt: number;
  durationMs: number;
  stdinClosed: boolean;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
  exitCode: number | null;
  signal: string | null;
  consumed: boolean;
  retainedOutputBytes: number;
}

export interface MspInternalResult {
  operation: 'exec_command' | 'write_stdin' | 'read' | 'terminate';
  sessionId?: number;
  state: MspSessionState | 'not_started';
  backend: MspBackend;
  workdir?: string;
  startedAt: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
  exitCode: number | null;
  signal: string | null;
  running: boolean;
  error?: MspErrorRecord;
}

/** 工具回填给模型的是 text；internal 仅供 Runtime、审计、UI 和测试使用。 */
export interface MspToolResult {
  text: string;
  internal: MspInternalResult;
}

export interface MspRuntimeContext {
  chatId?: string;
  actorId?: number;
  actorName?: string;
  workspaceId?: string;
  signal?: AbortSignal;
  environment?: Record<string, string>;
  audit?: Record<string, string | number | boolean | undefined>;
}

export interface MspCommandDescriptor {
  name: string;
  summary?: string;
  plugin?: string;
  executable?: string;
  lookupPaths?: string[];
  enabled: boolean;
}

export interface MspRuntimeCapabilities {
  protocol: MspProtocolVersion;
  mode: MspRuntimeMode;
  tty: boolean;
  sessions: boolean;
  stdin: boolean;
  updatePlan: boolean;
  applyPatch: boolean;
}

export interface MspRuntime {
  readonly mode: MspRuntimeMode;
  execCommand(input: ExecCommandInput, context?: MspRuntimeContext): Promise<MspToolResult>;
  writeStdin(input: WriteStdinInput, context?: MspRuntimeContext): Promise<MspToolResult>;
  readSession(sessionId: number, context?: MspRuntimeContext): Promise<MspToolResult>;
  terminateSession(sessionId: number, context?: MspRuntimeContext): Promise<MspToolResult>;
  listCommands(): MspCommandDescriptor[];
  listSessions(): MspSessionSnapshot[];
  getCapabilities(): MspRuntimeCapabilities;
  dispose(): Promise<void>;
}

export interface MspCommandInvocation {
  name: string;
  arguments: string[];
  rawInput: string;
}

export interface MspCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  effects?: unknown[];
  stateChange?: { currentDirectory?: string };
}
