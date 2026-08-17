import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ShellPolicy, ShellRequest, ShellResult } from './types';
import { evaluateShellRequest, resolveFixedCwd } from './policy';
import { truncateUtf8 } from './output';

const SAFE_ENV = new Set(['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'HOME']);

function scrubEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** 限制内存中的输出缓存；不等进程结束才截断。 */
class OutputCollector {
  private readonly chunks: Buffer[] = [];
  private readonly maxBytes: number;
  private retainedBytes = 0;
  totalBytes = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  add(chunk: string | Buffer): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.totalBytes += bytes.byteLength;
    if (this.retainedBytes >= this.maxBytes + 4) return;
    const remaining = this.maxBytes + 4 - this.retainedBytes;
    const retained = bytes.subarray(0, remaining);
    if (retained.byteLength > 0) {
      this.chunks.push(retained);
      this.retainedBytes += retained.byteLength;
    }
  }

  finish(): { text: string; truncated: boolean } {
    const text = Buffer.concat(this.chunks).toString('utf8');
    const result = truncateUtf8(text, this.maxBytes);
    return { text: result.text, truncated: this.totalBytes > this.maxBytes || result.truncated };
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 0) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* 进程已退出 */ } }
}

/** 固定 cwd、shell=false、超时与 AbortSignal 可取消的本地执行器。 */
export async function executeShell(
  request: ShellRequest,
  policy: ShellPolicy,
  actorId?: number,
  signal?: AbortSignal,
): Promise<{ decision: ReturnType<typeof evaluateShellRequest>; result?: ShellResult; requestId: string }> {
  const requestId = randomUUID();
  const decision = evaluateShellRequest(request, policy, actorId);
  if (!decision.allowed || decision.executable === undefined || decision.args === undefined) return { decision, requestId };
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, Math.min(request.timeoutMs ?? policy.timeoutMs, policy.timeoutMs));
  // 通过固定 shell 执行完整聊天命令；detached 使停止时可终止整个进程组。
  const child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/d', '/s', '/c', decision.executable] : ['-c', decision.executable], {
    cwd: resolveFixedCwd(policy),
    env: policy.scrubEnv ? scrubEnv() : { ...process.env },
    shell: false,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = new OutputCollector(policy.maxOutputBytes);
  const stderr = new OutputCollector(policy.maxOutputBytes);
  child.stdout?.on('data', (chunk: string | Buffer) => stdout.add(chunk));
  child.stderr?.on('data', (chunk: string | Buffer) => stderr.add(chunk));
  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => { timedOut = true; killGroup(child.pid ?? 0, 'SIGTERM'); }, timeoutMs);
  const forceTimer = setTimeout(() => {
    if (timedOut || aborted) killGroup(child.pid ?? 0, 'SIGKILL');
  }, timeoutMs + 250);
  const abort = (): void => { aborted = true; killGroup(child.pid ?? 0, 'SIGTERM'); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const result = await new Promise<ShellResult>((resolve) => {
    child.once('error', (error) => resolve({ ok: false, exitCode: null, signal: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: Date.now() - startedAt, error: error.message }));
    child.once('close', (exitCode, exitSignal) => {
      const out = stdout.finish();
      const err = stderr.finish();
      resolve({
        ok: exitCode === 0 && !timedOut && !aborted,
        exitCode,
        signal: exitSignal,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        durationMs: Date.now() - startedAt,
        error: timedOut ? '命令执行超时' : aborted ? '命令执行已取消' : undefined,
      });
    });
  });
  clearTimeout(timer);
  clearTimeout(forceTimer);
  signal?.removeEventListener('abort', abort);
  return { decision, result, requestId };
}
