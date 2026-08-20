import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { MspConfig } from '../config';
import { logger } from '../logging/logger';
import { LocalBashMspRuntime } from './local-bash-runtime';
import { MspWorkspace } from './workspace';
import type { ExecCommandInput, MspRuntime, MspRuntimeCapabilities, MspToolResult, MspRuntimeContext, WriteStdinInput } from './protocol/types';
import { MSP_ERROR_CODES, mspError } from './protocol/error-codes';
import type { CommandBroker } from './command-broker';
import { asMspToolResult } from './render';

const execFileAsync = promisify(execFile);
const log = logger.child('session-sandbox');

export type SessionSandboxBackend = 'podman' | 'docker' | 'local-bash';

export interface SessionSandbox {
  chatId: string;
  workspace: MspWorkspace;
  runtime: MspRuntime;
  backend: SessionSandboxBackend;
  isolated: boolean;
}

/**
 * 每会话唯一工作区和执行后端的控制面。
 * 默认只接受 rootless Podman；local-bash 必须显式允许，避免离线环境把“未隔离”伪装成沙箱。
 */
export class SessionSandboxManager {
  private readonly config: MspConfig;
  private readonly root: string;
  private readonly sessions = new Map<string, SessionSandbox>();
  private readonly broker?: CommandBroker;
  private selectedBackend?: SessionSandboxBackend;
  private availability?: Promise<{ backend?: SessionSandboxBackend; reason?: string }>;

  constructor(config: MspConfig, broker?: CommandBroker) {
    this.config = config;
    this.root = config.workspaceRoot;
    this.broker = broker;
  }

  async inspect(): Promise<{ backend?: SessionSandboxBackend; isolated: boolean; available: boolean; reason?: string }> {
    const selected = await this.selectBackend();
    return { backend: selected.backend, isolated: selected.backend === 'podman' || selected.backend === 'docker', available: selected.backend !== undefined, reason: selected.reason };
  }

  async get(chatId: string): Promise<SessionSandbox> {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;
    const selected = await this.selectBackend();
    if (!selected.backend) throw new Error(`Session sandbox 不可用：${selected.reason ?? '未检测到隔离后端'}；如仅开发测试请显式设置 MSP_RUNTIME_MODE=local-bash 与 MSP_ALLOW_LOCAL_BASH_FALLBACK=true`);
    const key = createHash('sha256').update(chatId).digest('hex').slice(0, 32);
    const workspace = new MspWorkspace(`${this.root}/sessions/${key}`, chatId);
    await workspace.initialize();
    const runtime = selected.backend === 'local-bash'
      ? new LocalBashMspRuntime({ workspace, shell: this.config.shell, maxLiveSessions: this.config.maxLiveSessions, maxOutputBytes: this.config.maxOutputBytes, defaultYieldTimeMs: this.config.defaultYieldTimeMs, maxYieldTimeMs: this.config.maxYieldTimeMs, emptyPollMs: this.config.emptyPollMs, maxEmptyPollMs: this.config.maxEmptyPollMs, defaultMaxOutputTokens: this.config.maxOutputTokens, formatOutput: this.config.formatOutput, timeoutMs: this.config.timeoutMs })
      : new ContainerMspRuntime(selected.backend, workspace, this.config, this.broker);
    const sandbox: SessionSandbox = { chatId, workspace, runtime, backend: selected.backend, isolated: selected.backend !== 'local-bash' };
    this.sessions.set(chatId, sandbox);
    return sandbox;
  }

  async dispose(): Promise<void> {
    for (const sandbox of this.sessions.values()) await sandbox.runtime.dispose();
    this.sessions.clear();
  }

  private async selectBackend(): Promise<{ backend?: SessionSandboxBackend; reason?: string }> {
    if (!this.availability) this.availability = this.detectBackend();
    const found = await this.availability;
    if (this.config.runtimeMode === 'local-bash') return this.config.allowLocalFallback ? { backend: 'local-bash' } : { reason: 'local-bash 被禁用，需显式 MSP_ALLOW_LOCAL_BASH_FALLBACK=true' };
    if (this.config.runtimeMode === 'podman') return found.backend === 'podman' ? found : { reason: found.reason ?? 'Podman 不可用' };
    if (this.config.runtimeMode === 'docker') return found.backend === 'docker' ? found : { reason: found.reason ?? 'Docker 不可用' };
    if (found.backend) return found;
    return this.config.allowLocalFallback ? { backend: 'local-bash', reason: found.reason } : { reason: found.reason ?? '没有可用 rootless 容器后端' };
  }

  private async detectBackend(): Promise<{ backend?: SessionSandboxBackend; reason?: string }> {
    const candidates: Array<{ name: 'podman' | 'docker'; command: string }> = [{ name: 'podman', command: 'podman' }, { name: 'docker', command: 'docker' }];
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate.command, ['--version'], { timeout: 4000, maxBuffer: 16_000 });
        const format = candidate.name === 'podman' ? '{{.Host.Security.Rootless}}' : '{{json .SecurityOptions}}';
        const result = await execFileAsync(candidate.command, ['info', '--format', format], { timeout: 4000, maxBuffer: 16_000 });
        const security = String(result.stdout).trim().toLowerCase();
        if (candidate.name === 'podman' ? security !== 'true' : !security.includes('rootless')) {
          errors.push(`${candidate.name} 不是 rootless runtime`);
          continue;
        }

        // 只接受已经存在且能在隔离参数下启动的配置镜像；不在消息处理路径隐式拉取镜像。
        const image = this.config.image;
        try {
          await execFileAsync(candidate.command, ['image', 'inspect', image], { timeout: 4000, maxBuffer: 16_000 });
        } catch {
          errors.push(`${candidate.name} 配置镜像不可用（缺失或不可拉取）：${image}`);
          continue;
        }
        try {
          await execFileAsync(candidate.command, [
            'run', '--rm', '--network=none', '--read-only', '--user=10001:10001',
            '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint', '/bin/true', image,
          ], { timeout: 8000, maxBuffer: 16_000 });
        } catch {
          errors.push(`${candidate.name} 配置镜像无法在隔离参数下运行：${image}`);
          continue;
        }
        return { backend: candidate.name };
      } catch (error) {
        errors.push(`${candidate.name} 不可用: ${error instanceof Error ? sanitizeProbeReason(error.message) : 'runtime probe failed'}`);
      }
    }
    return { reason: errors.join('; ') || '未检测到 Podman/Docker' };
  }
}

function sanitizeProbeReason(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/(token|password|secret|key)=?[^ ]*/gi, '$1=[已脱敏]').slice(0, 240);
}

class ContainerMspRuntime implements MspRuntime {
  readonly mode = 'full' as const;
  private readonly command: 'podman' | 'docker';
  private readonly workspace: MspWorkspace;
  private readonly config: MspConfig;
  private readonly broker?: CommandBroker;
  private disposed = false;

  constructor(command: 'podman' | 'docker', workspace: MspWorkspace, config: MspConfig, broker?: CommandBroker) {
    this.command = command;
    this.workspace = workspace;
    this.config = config;
    this.broker = broker;
  }

  async execCommand(input: ExecCommandInput, context: MspRuntimeContext = {}): Promise<MspToolResult> {
    const startedAt = Date.now();
    if (this.disposed) return this.error('exec_command', '容器 runtime 已关闭', startedAt);
    const resolved = await this.workspace.resolveVirtualPath(input.workdir, '/');
    const env = context.environment ?? {};
    const args = this.containerArgs(resolved.hostPath, resolved.virtualPath, env, input.cmd);
    try {
      const result = await execFileAsync(this.command, args, { timeout: this.config.timeoutMs, maxBuffer: this.config.maxOutputBytes });
      return this.completed('exec_command', startedAt, String(result.stdout), String(result.stderr), 0, resolved.virtualPath);
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; code?: number | string; signal?: string };
      const exitCode = typeof e.code === 'number' ? e.code : e.code === 'ETIMEDOUT' ? 124 : 1;
      const stderr = String(e.stderr ?? (error instanceof Error ? error.message : error));
      return this.completed('exec_command', startedAt, String(e.stdout ?? ''), stderr, exitCode, resolved.virtualPath);
    }
  }

  async writeStdin(_input: WriteStdinInput): Promise<MspToolResult> { return this.error('write_stdin', '容器后端当前只支持单次命令；不提供 stdin session', Date.now()); }
  async readSession(sessionId: number): Promise<MspToolResult> { return this.error('read', `不存在 session：${sessionId}`, Date.now()); }
  async terminateSession(sessionId: number): Promise<MspToolResult> { return this.error('terminate', `不存在 session：${sessionId}`, Date.now()); }
  listCommands() { return []; }
  listSessions() { return []; }
  getCapabilities(): MspRuntimeCapabilities { return { protocol: 'msp-agent.v1', mode: 'full', tty: false, sessions: false, stdin: false, updatePlan: false, applyPatch: false }; }
  async dispose(): Promise<void> { this.disposed = true; }

  private containerArgs(hostPath: string, virtualPath: string, env: Record<string, string>, command: string): string[] {
    const args = ['run', '--rm', '--init', '--network=none', '--read-only', '--user=10001:10001', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--cpus=1', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--mount', `type=bind,src=${hostPath},dst=/workspace,rw`, '--workdir', `/workspace${virtualPath === '/' ? '' : virtualPath}`];
    if (this.broker) args.push('--mount', `type=bind,src=${this.broker.socketPath},dst=/run/al1s/command.sock,rw`);
    for (const [key, value] of Object.entries(env)) if (/^[A-Z_][A-Z0-9_]*$/.test(key)) args.push('--env', `${key}=${value}`);
    args.push(this.config.image, '/bin/bash', '-lc', command);
    return args;
  }

  private completed(operation: 'exec_command' | 'write_stdin' | 'read' | 'terminate', startedAt: number, stdout: string, stderr: string, exitCode: number, workdir: string): MspToolResult {
    const internal = { operation, state: 'completed' as const, backend: 'pipe' as const, workdir, startedAt, durationMs: Date.now() - startedAt, stdout: trimOutput(stdout, this.config.maxOutputBytes), stderr: trimOutput(stderr, this.config.maxOutputBytes), combinedOutput: trimOutput(`${stdout}${stderr}`, this.config.maxOutputBytes), stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), outputTruncated: Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > this.config.maxOutputBytes, exitCode, signal: null, running: false };
    return asMspToolResult(internal, this.config.maxOutputTokens, this.config.formatOutput);
  }

  private error(operation: 'exec_command' | 'write_stdin' | 'read' | 'terminate', message: string, startedAt: number): MspToolResult {
    const internal = { operation, state: 'not_started' as const, backend: 'pipe' as const, startedAt, durationMs: 0, stdout: '', stderr: message, combinedOutput: '', stdoutBytes: 0, stderrBytes: Buffer.byteLength(message), outputTruncated: false, exitCode: null, signal: null, running: false, error: mspError(MSP_ERROR_CODES.processStartFailed, message) };
    return asMspToolResult(internal, this.config.maxOutputTokens, this.config.formatOutput);
  }
}

function trimOutput(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  return bytes.byteLength <= maxBytes ? value : bytes.subarray(0, maxBytes).toString('utf8');
}

