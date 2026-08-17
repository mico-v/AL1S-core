export type ShellRuntime = 'local';

export interface ShellRequest {
  command: string;
  runtime?: ShellRuntime;
  timeoutMs?: number;
}

export interface ShellPolicy {
  enabled: boolean;
  runtime: ShellRuntime;
  cwd: string;
  allowlist: string[];
  denylist: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  adminIds: number[];
  scrubEnv: boolean;
  selfModifyMode: 'disabled' | 'reserved';
}

export interface ShellDecision {
  allowed: boolean;
  reason?: string;
  executable?: string;
  args?: string[];
  command?: string;
}

export interface ShellResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  error?: string;
}

export interface ShellAuditRecord {
  event: 'started' | 'accepted' | 'rejected' | 'completed' | 'stopped' | 'failed';
  requestId: string;
  taskId?: string;
  actorId?: number;
  chatId?: string;
  groupId?: number;
  command: string;
  runtime: ShellRuntime;
  cwd: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  ok?: boolean;
  reason?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
}
