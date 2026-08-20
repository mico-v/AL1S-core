import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { logger } from '../logging/logger';
import { MspSessionManager, type MspSessionRecord } from './session-manager';
import { asMspToolResult } from './render';
import { MSP_ERROR_CODES, mspError } from './protocol/error-codes';
import { parseExecCommandInput, parseWriteStdinInput } from './protocol/validate';
import type {
  ExecCommandInput,
  MspInternalResult,
  MspRuntime,
  MspRuntimeCapabilities,
  MspRuntimeContext,
  MspSessionState,
  MspToolResult,
  WriteStdinInput,
} from './protocol/types';
import { MspWorkspace } from './workspace';

const log = logger.child('msp-local-bash');

export interface LocalBashRuntimeOptions {
  workspace: MspWorkspace;
  shell?: string;
  maxLiveSessions?: number;
  maxOutputBytes?: number;
  defaultYieldTimeMs?: number;
  maxYieldTimeMs?: number;
  emptyPollMs?: number;
  maxEmptyPollMs?: number;
  defaultMaxOutputTokens?: number;
  formatOutput?: boolean;
  timeoutMs?: number;
}

/**
 * 开发阶段 MSP 模拟器：严格实现 AgentBridge 的 session/tool 边界，
 * 但底层暂时使用独立 bash -c 进程。它不是生产沙箱。
 */
export class LocalBashMspRuntime implements MspRuntime {
  readonly mode = 'local-bash' as const;
  private readonly workspace: MspWorkspace;
  private readonly shell: string;
  private readonly sessions: MspSessionManager;
  private readonly defaultYieldTimeMs: number;
  private readonly maxYieldTimeMs: number;
  private readonly emptyPollMs: number;
  private readonly maxEmptyPollMs: number;
  private defaultMaxOutputTokens: number;
  private formatOutput: boolean;
  private timeoutMs: number;
  private commandDescriptors: MspRuntime['listCommands'] = () => [];
  private disposed = false;

  constructor(options: LocalBashRuntimeOptions) {
    this.workspace = options.workspace;
    this.shell = options.shell || '/bin/bash';
    this.sessions = new MspSessionManager(options.maxLiveSessions ?? 64, options.maxOutputBytes ?? 40_000);
    this.defaultYieldTimeMs = options.defaultYieldTimeMs ?? 10_000;
    this.maxYieldTimeMs = options.maxYieldTimeMs ?? 30_000;
    this.emptyPollMs = options.emptyPollMs ?? 5_000;
    this.maxEmptyPollMs = options.maxEmptyPollMs ?? 300_000;
    this.defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? 10_000;
    this.formatOutput = options.formatOutput ?? true;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  updateOptions(options: { defaultMaxOutputTokens?: number; formatOutput?: boolean; timeoutMs?: number }): void {
    if (options.defaultMaxOutputTokens !== undefined) this.defaultMaxOutputTokens = Math.max(0, options.defaultMaxOutputTokens);
    if (options.formatOutput !== undefined) this.formatOutput = options.formatOutput;
    if (options.timeoutMs !== undefined) this.timeoutMs = Math.max(1, options.timeoutMs);
  }

  async execCommand(input: ExecCommandInput, context: MspRuntimeContext = {}): Promise<MspToolResult> {
    if (this.disposed) return this.errorResult('exec_command', mspError(MSP_ERROR_CODES.processStartFailed, 'MSP runtime 已关闭'));
    let request: ExecCommandInput;
    try { request = parseExecCommandInput(input); } catch (error) { return this.validationResult('exec_command', error); }
    if (request.tty) return this.errorResult('exec_command', mspError(MSP_ERROR_CODES.ptyUnavailable, '当前 local-bash 模拟器不提供 Linux PTY'));

    const workdir = await this.resolveWorkdir(request.workdir);
    if (!workdir.ok) return this.errorResult('exec_command', workdir.error);
    const shell = request.shell?.trim() || this.shell;
    if (!isSupportedShell(shell)) {
      return this.errorResult('exec_command', mspError(MSP_ERROR_CODES.processStartFailed, '当前模拟器只允许 bash/sh shell'));
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(shell, ['-c', request.cmd], {
        cwd: workdir.hostPath,
        env: { ...safeEnvironment(workdir.virtualPath), ...(context.environment ?? {}) },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      return this.errorResult('exec_command', mspError(MSP_ERROR_CODES.processStartFailed, '无法启动命令', false, undefined, safeCause(error)));
    }

    let session: MspSessionRecord;
    try {
      session = this.sessions.create(child, 'pipe', workdir.virtualPath);
    } catch (error) {
      killProcessGroup(child.pid, 'SIGTERM');
      return this.errorResult('exec_command', mspError(MSP_ERROR_CODES.sessionLimit, '运行中的 session 已达到上限', false, undefined, safeCause(error)));
    }
    this.attachProcess(session, context);
    log.info('启动 local-bash 模拟执行', { requestId: randomUUID(), sessionId: session.sessionId, workdir: workdir.virtualPath });

    const timeout = setTimeout(() => this.interrupt(session, 'timeout'), this.timeoutMs);
    const abort = (): void => this.interrupt(session, 'abort');
    const cleanup = (): void => {
      clearTimeout(timeout);
      context.signal?.removeEventListener('abort', abort);
    };
    void session.done.then(cleanup);
    if (context.signal?.aborted) abort(); else context.signal?.addEventListener('abort', abort, { once: true });
    const waitMs = clamp(request.yield_time_ms ?? this.defaultYieldTimeMs, 250, this.maxYieldTimeMs);
    await this.waitForSession(session, waitMs);
    if (session.state !== 'running') cleanup();

    const result = this.sanitizedInternal(session, 'exec_command');
    result.error = session.state === 'interrupted'
      ? mspError(MSP_ERROR_CODES.processInterrupted, '命令已中断')
      : session.state === 'terminated' && session.exitCode === 124
        ? mspError(MSP_ERROR_CODES.processTimeout, '命令执行超时', true)
        : session.state === 'terminated'
          ? mspError(MSP_ERROR_CODES.processTerminated, '命令已终止')
          : undefined;
    const toolResult = asMspToolResult(result, request.max_output_tokens ?? this.defaultMaxOutputTokens, this.formatOutput);
    if (!result.running) this.sessions.delete(session.sessionId);
    return toolResult;
  }

  async writeStdin(input: WriteStdinInput, context: MspRuntimeContext = {}): Promise<MspToolResult> {
    let request: WriteStdinInput;
    try { request = parseWriteStdinInput(input); } catch (error) { return this.validationResult('write_stdin', error); }
    const session = this.sessions.get(request.session_id);
    if (!session || session.state !== 'running') {
      if (session) this.sessions.delete(session.sessionId);
      return this.errorResult('write_stdin', mspError(MSP_ERROR_CODES.sessionInactive, 'session 不存在或已结束', false, { session_id: request.session_id }));
    }
    const chars = request.chars ?? '';
    const ctrlC = String.fromCharCode(3);
    const ctrlD = String.fromCharCode(4);
    if (chars.includes(ctrlC)) this.interrupt(session, 'ctrl-c');
    if (chars.includes(ctrlD)) {
      session.stdinClosed = true;
      session.child.stdin.end(chars.replaceAll(ctrlD, ''));
    } else if (chars.length > 0 && session.state === 'running') {
      try { session.child.stdin.write(chars, 'utf8'); } catch (error) {
        return this.errorResult('write_stdin', mspError(MSP_ERROR_CODES.stdinWriteFailed, '写入 session stdin 失败', true, undefined, safeCause(error)));
      }
    }
    const waitMs = chars.length > 0 ? clamp(request.yield_time_ms ?? 250, 250, this.maxYieldTimeMs) : clamp(request.yield_time_ms ?? this.emptyPollMs, this.emptyPollMs, this.maxEmptyPollMs);
    await this.waitForSession(session, waitMs);
    const result = this.sanitizedInternal(session, 'write_stdin');
    result.error = this.sessionError(session);
    const toolResult = asMspToolResult(result, request.max_output_tokens ?? this.defaultMaxOutputTokens, this.formatOutput);
    if (!result.running) this.sessions.delete(session.sessionId);
    return toolResult;
  }

  async readSession(sessionId: number): Promise<MspToolResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return this.errorResult('read', mspError(MSP_ERROR_CODES.sessionInactive, 'session 不存在或已结束', false, { session_id: sessionId }));
    const result = this.sanitizedInternal(session, 'read');
    result.error = this.sessionError(session);
    const output = asMspToolResult(result, this.defaultMaxOutputTokens, this.formatOutput);
    if (!result.running) this.sessions.delete(sessionId);
    return output;
  }

  async terminateSession(sessionId: number): Promise<MspToolResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return this.errorResult('terminate', mspError(MSP_ERROR_CODES.sessionInactive, 'session 不存在或已结束', false, { session_id: sessionId }));
    if (session.state === 'running') {
      session.state = 'terminated';
      session.exitCode = 143;
      killProcessGroup(session.child.pid, 'SIGTERM');
    }
    await this.waitForSession(session, 250);
    const result = this.sanitizedInternal(session, 'terminate');
    result.error = mspError(MSP_ERROR_CODES.processTerminated, '命令已终止');
    const output = asMspToolResult(result, this.defaultMaxOutputTokens, this.formatOutput);
    this.sessions.delete(sessionId);
    return output;
  }

  setCommandDescriptors(provider: () => MspRuntime['listCommands'] extends () => infer T ? T : never): void {
    this.commandDescriptors = provider;
  }

  listCommands() { return this.commandDescriptors(); }

  listSessions() {
    return this.sessions.list().map((session) => this.sessions.snapshot(session));
  }

  getCapabilities(): MspRuntimeCapabilities {
    return { protocol: 'msp-agent.v1', mode: this.mode, tty: false, sessions: true, stdin: true, updatePlan: false, applyPatch: false };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const session of this.sessions.list()) {
      session.state = 'terminated';
      killProcessGroup(session.child.pid, 'SIGTERM');
    }
    this.sessions.list().forEach((session) => this.sessions.delete(session.sessionId));
  }

  private attachProcess(session: MspSessionRecord, context: MspRuntimeContext): void {
    session.child.stdout.on('data', (chunk: Buffer | string) => this.sessions.append(session, 'stdout', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    session.child.stderr.on('data', (chunk: Buffer | string) => this.sessions.append(session, 'stderr', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    session.child.once('error', (error) => {
      if (session.state === 'running') {
        session.state = 'terminated';
        session.exitCode = 127;
        log.warn('MSP 模拟命令启动失败', { chatId: context.chatId, err: safeCause(error) });
      }
      session.resolveDone();
    });
    session.child.once('close', (exitCode, signal) => {
      if (session.state === 'running') this.sessions.markComplete(session, exitCode, signal, 'completed');
      else session.resolveDone();
    });
  }

  private async waitForSession(session: MspSessionRecord, waitMs: number): Promise<void> {
    if (session.state !== 'running') return;
    await Promise.race([session.done, new Promise<void>((resolve) => setTimeout(resolve, waitMs))]);
  }

  private interrupt(session: MspSessionRecord, reason: 'timeout' | 'abort' | 'ctrl-c'): void {
    if (session.state !== 'running') return;
    if (reason === 'timeout') { session.state = 'terminated'; session.exitCode = 124; }
    else { session.state = 'interrupted'; session.exitCode = 130; }
    killProcessGroup(session.child.pid, 'SIGTERM');
    setTimeout(() => { if (session.state !== 'completed') killProcessGroup(session.child.pid, 'SIGKILL'); }, 250);
  }

  private async resolveWorkdir(workdir: string | undefined): Promise<{ ok: true; hostPath: string; virtualPath: string } | { ok: false; error: ReturnType<typeof mspError> }> {
    try { return { ok: true, ...(await this.workspace.resolveVirtualPath(workdir, '/')) }; }
    catch (error) { return { ok: false, error: error instanceof Error && 'record' in error ? (error as { record: ReturnType<typeof mspError> }).record : mspError(MSP_ERROR_CODES.policyDenied, '工作目录不在工作区内') }; }
  }

  private errorResult(operation: MspInternalResult['operation'], error: ReturnType<typeof mspError>): MspToolResult {
    const result: MspInternalResult = { operation, state: 'not_started', backend: 'pipe', startedAt: Date.now(), durationMs: 0, stdout: '', stderr: '', combinedOutput: '', stdoutBytes: 0, stderrBytes: 0, outputTruncated: false, exitCode: null, signal: null, running: false, error };
    return asMspToolResult(result, this.defaultMaxOutputTokens, this.formatOutput);
  }

  private validationResult(operation: MspInternalResult['operation'], error: unknown): MspToolResult {
    if (error && typeof error === 'object' && 'record' in error) return this.errorResult(operation, (error as { record: ReturnType<typeof mspError> }).record);
    return this.errorResult(operation, mspError(MSP_ERROR_CODES.inputInvalidValue, '工具参数校验失败'));
  }

  private sanitizeOutput(text: string): string {
    return text.replaceAll(this.workspace.hostRoot, '/');
  }

  private sanitizedInternal(session: MspSessionRecord, operation: MspInternalResult['operation']): MspInternalResult {
    const result = this.sessions.toInternal(session, operation);
    result.stdout = this.sanitizeOutput(result.stdout);
    result.stderr = this.sanitizeOutput(result.stderr);
    result.combinedOutput = this.sanitizeOutput(result.combinedOutput);
    result.workdir = this.sanitizeOutput(result.workdir ?? '/');
    return result;
  }

  private sessionError(session: MspSessionRecord) {
    if (session.state === 'interrupted') return mspError(MSP_ERROR_CODES.processInterrupted, '命令已中断');
    if (session.state === 'terminated' && session.exitCode === 124) return mspError(MSP_ERROR_CODES.processTimeout, '命令执行超时', true);
    if (session.state === 'terminated') return mspError(MSP_ERROR_CODES.processTerminated, '命令已终止');
    return undefined;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(value), min), max);
}

function isSupportedShell(shell: string): boolean {
  const name = basename(shell);
  return name === 'bash' || name === 'sh';
}

function safeEnvironment(virtualPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PWD = virtualPath;
  env.OLDPWD = virtualPath;
  env.HOME = '/';
  env.TMPDIR = '/tmp';
  env.MSP_WORKSPACE_ROOT = '/';
  return env;
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid || pid <= 0) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* 进程已退出 */ } }
}

function safeCause(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}
