import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { MspBackend, MspInternalResult, MspSessionSnapshot, MspSessionState } from './protocol/types';

export interface MspSessionRecord {
  sessionId: number;
  child: ChildProcessWithoutNullStreams;
  backend: MspBackend;
  workdir: string;
  startedAt: number;
  state: MspSessionState;
  stdinClosed: boolean;
  stdout: Buffer[];
  stderr: Buffer[];
  combined: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  consumed: boolean;
  retainedOutputBytes: number;
  done: Promise<void>;
  resolveDone: () => void;
}

export class MspSessionManager {
  private readonly sessions = new Map<number, MspSessionRecord>();
  private nextId = 1;

  private readonly maxLiveSessions: number;
  private readonly maxOutputBytes: number;

  constructor(maxLiveSessions = 64, maxOutputBytes = 40_000) {
    this.maxLiveSessions = maxLiveSessions;
    this.maxOutputBytes = maxOutputBytes;
  }

  create(child: ChildProcessWithoutNullStreams, backend: MspBackend, workdir: string): MspSessionRecord {
    this.pruneIfNeeded();
    if (this.sessions.size >= this.maxLiveSessions) throw new Error('live session limit reached');
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const record: MspSessionRecord = {
      sessionId: this.nextId++, child, backend, workdir, startedAt: Date.now(), state: 'running', stdinClosed: false,
      stdout: [], stderr: [], combined: [], stdoutBytes: 0, stderrBytes: 0, outputTruncated: false,
      exitCode: null, signal: null, consumed: false, retainedOutputBytes: 0, done, resolveDone,
    };
    this.sessions.set(record.sessionId, record);
    return record;
  }

  get(sessionId: number): MspSessionRecord | undefined { return this.sessions.get(sessionId); }
  delete(sessionId: number): void { this.sessions.delete(sessionId); }
  list(): MspSessionRecord[] { return [...this.sessions.values()]; }

  append(record: MspSessionRecord, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const bytes = chunk.byteLength;
    if (stream === 'stdout') record.stdoutBytes += bytes; else record.stderrBytes += bytes;
    const remaining = Math.max(0, this.maxOutputBytes - record.retainedOutputBytes);
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      const target = stream === 'stdout' ? record.stdout : record.stderr;
      target.push(retained);
      record.combined.push(retained);
      record.retainedOutputBytes += retained.byteLength;
    }
    if (record.stdoutBytes + record.stderrBytes > this.maxOutputBytes) record.outputTruncated = true;
  }

  snapshot(record: MspSessionRecord): MspSessionSnapshot {
    const durationMs = Date.now() - record.startedAt;
    return {
      sessionId: record.sessionId, state: record.state, backend: record.backend, workdir: record.workdir,
      startedAt: record.startedAt, durationMs, stdinClosed: record.stdinClosed,
      stdout: Buffer.concat(record.stdout).toString('utf8'), stderr: Buffer.concat(record.stderr).toString('utf8'),
      combinedOutput: Buffer.concat(record.combined).toString('utf8'), stdoutBytes: record.stdoutBytes,
      stderrBytes: record.stderrBytes, outputTruncated: record.outputTruncated, exitCode: record.exitCode,
      signal: record.signal, consumed: record.consumed,
      retainedOutputBytes: record.retainedOutputBytes,
    };
  }

  toInternal(record: MspSessionRecord, operation: MspInternalResult['operation']): MspInternalResult {
    const snapshot = this.snapshot(record);
    return { operation, ...snapshot, running: record.state === 'running' };
  }

  markComplete(record: MspSessionRecord, exitCode: number | null, signal: NodeJS.Signals | null, state: MspSessionState = 'completed'): void {
    if (record.state !== 'running') return;
    record.exitCode = exitCode;
    record.signal = signal;
    record.state = state;
    record.resolveDone();
  }

  consume(record: MspSessionRecord): void { record.consumed = true; }

  private pruneIfNeeded(): void {
    if (this.sessions.size < this.maxLiveSessions) return;
    const oldest = this.list().sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!oldest) return;
    try { oldest.child.kill('SIGTERM'); } catch { /* 已退出 */ }
    oldest.state = 'terminated';
    oldest.resolveDone();
    this.sessions.delete(oldest.sessionId);
  }
}
