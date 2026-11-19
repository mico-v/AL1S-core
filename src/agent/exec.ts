/**
 * 命令执行。
 *
 * 2026-11-19 起是**黑名单模式**：默认不拦任何命令（`AGENT_CMD_BLACKLIST` 为空），
 * 判断只有三步 —— 身份够不够、命令是不是空的、有没有命中黑名单。
 *
 * 兜底不靠这层正则，靠系统层：进程以 `kei` 用户跑、没有 sudo，systemd 带
 * `ProtectSystem=strict` + 只放行 `data / logs /srv/kei` 可写，越权也越不出去。
 * cwd 仍然锁在工作区里。要收紧只改 `.env` 的 `AGENT_CMD_BLACKLIST`（正则，逗号或换行分隔），
 * 不用动代码 —— 白名单时代那种「改代码才能放行一条命令」的摩擦已经去掉了。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Tier } from './policy.js';

export interface RunLimits {
  timeoutMs: number;
  /** stdout + stderr 合计上限，超出截断并标注。 */
  maxBytes: number;
}

export const DEFAULT_LIMITS: RunLimits = { timeoutMs: 120_000, maxBytes: 6_000 };

export interface RunResult {
  ok: boolean;
  code: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** 被策略拦下时给模型看的原因。 */
  denied?: string;
}

/** 默认黑名单：空 —— 全部放行。收紧时只改 .env，不改这里。 */
export const DEFAULT_BLACKLIST: string[] = [];

/** 把 `AGENT_CMD_BLACKLIST` 解析成正则列表（逗号或换行分隔，空 = 不拦）。 */
export function parseBlacklist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function collapsed(cmd: string): string {
  return cmd.replace(/\s+/g, ' ').trim();
}

export interface CheckResult {
  allowed: boolean;
  why?: string;
}

/**
 * 判一条命令能不能跑。
 *
 * 黑名单条目是正则（写错了就当没写，不因此拦人）。
 * `workspace` 参数留给调用方做 cwd 锁定；这里不再扫命令里的绝对路径 ——
 * 路径边界交给文件系统权限，正则扫路径只会误伤正常命令。
 */
export function checkCommand(cmd: string, tier: Tier, blacklist: string[] = DEFAULT_BLACKLIST): CheckResult {
  const text = collapsed(cmd);
  if (!text) {
    return { allowed: false, why: '空命令' };
  }
  // guest 一律不给：这一层不靠能力集兜底，两层都堵住
  if (tier === 'guest') {
    return { allowed: false, why: '这个身份不能跑命令' };
  }
  for (const pattern of blacklist) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      continue;
    }
    if (re.test(text)) {
      return { allowed: false, why: `命中命令黑名单：${pattern}` };
    }
  }
  return { allowed: true };
}

export interface RunOptions {
  cmd: string;
  /** 相对工作区的目录；越界会被拒。 */
  cwd: string;
  workspace: string;
  tier: Tier;
  home: string;
  limits?: RunLimits;
  /** 命令黑名单（正则源），来自 `AGENT_CMD_BLACKLIST`；空数组 = 全放行。 */
  blacklist?: string[];
  /** 额外环境变量（如 git 身份），不继承进程环境里的密钥。 */
  extraEnv?: Record<string, string>;
}

/** 子进程环境：只给最小集合，绝不把 AGENT_API_KEY 之类带进去。 */
function baseEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'dumb',
    CI: '1',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

/** 解析并锁定 cwd：必须落在 workspace 内。 */
export function resolveInside(workspace: string, rel: string): string | undefined {
  const root = path.resolve(workspace);
  const target = path.resolve(root, rel || '.');
  if (target !== root && !target.startsWith(`${root}/`)) {
    return undefined;
  }
  return target;
}

export async function runCommand(options: RunOptions): Promise<RunResult> {
  const verdict = checkCommand(options.cmd, options.tier, options.blacklist ?? DEFAULT_BLACKLIST);
  if (!verdict.allowed) {
    return {
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      denied: verdict.why ?? '被策略拦下',
    };
  }
  const cwd = resolveInside(options.workspace, options.cwd);
  if (!cwd) {
    return {
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      denied: 'cwd 越出了工作区',
    };
  }

  const limits = options.limits ?? DEFAULT_LIMITS;
  return await new Promise<RunResult>((resolve) => {
    const child = spawn('/bin/bash', ['-lc', options.cmd], {
      cwd,
      env: baseEnv(options.home, options.extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const collect = (chunk: Buffer, into: 'out' | 'err'): void => {
      const text = chunk.toString('utf8');
      if (stdout.length + stderr.length + text.length > limits.maxBytes) {
        truncated = true;
        const room = Math.max(0, limits.maxBytes - stdout.length - stderr.length);
        if (room > 0) {
          if (into === 'out') {
            stdout += text.slice(0, room);
          } else {
            stderr += text.slice(0, room);
          }
        }
        return;
      }
      if (into === 'out') {
        stdout += text;
      } else {
        stderr += text;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'err'));

    const timer = setTimeout(() => {
      timedOut = true;
      // detached 之后子进程自成进程组，整组杀掉，别留孤儿 npm
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
    }, limits.timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut,
        truncated,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal: signal ?? undefined,
        stdout,
        stderr,
        timedOut,
        truncated,
      });
    });
  });
}

/** 给模型看的紧凑结果：退出码 + 输出；超时/截断/被拒都写清楚。 */
export function renderRunResult(result: RunResult, cmd: string): string {
  if (result.denied) {
    return `命令被策略拒绝：${result.denied}\n执行的命令：${cmd}`;
  }
  const head = result.timedOut
    ? `超时被杀（命令：${cmd}）`
    : `退出码 ${result.code ?? 'null'}（命令：${cmd}）`;
  const out = result.stdout.trim();
  const err = result.stderr.trim();
  const parts = [head];
  if (out) {
    parts.push(`--- stdout ---\n${out}`);
  }
  if (err) {
    parts.push(`--- stderr ---\n${err}`);
  }
  if (!out && !err) {
    parts.push('（没有输出）');
  }
  if (result.truncated) {
    parts.push('（输出过长已截断，需要更多就用更精确的命令）');
  }
  return parts.join('\n');
}
