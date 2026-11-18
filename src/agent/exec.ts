/**
 * 命令执行。
 *
 * Kei 要跟进开发就得有手：看 git 状态、跑测试、看构建日志。但「能跑命令」等于
 * 「能跑任意命令」，所以三件事一起做：
 *
 *   1. 工作区限制：cwd 必须是 workspace 里面的目录，`cd ..` 之后也出不去；
 *   2. 分档白名单：dev 档只放行读与测试类命令，owner 档才放开写与 git 写操作；
 *   3. 危险命令黑名单：连 owner 都不给 sudo / systemctl / mkfs / 直接写 /etc 这类。
 *
 * 进程本身以 kei 用户身份运行（systemd 的 User=），没有 sudo，越权也越不出去。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Tier } from './policy.js';

export interface RunLimits {
  timeoutMs: number;
  /** stdout + stderr 合计上限，超出截断并标注。 */
  maxBytes: number;
}

export const DEFAULT_LIMITS: RunLimits = { timeoutMs: 120_000, maxBytes: 8_000 };

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

/** 任何档位都禁止：改系统、提权、动别的服务、往外吐密钥。 */
const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /\bsudo\b|\bsu\s+-|\bdoas\b/, why: '不能提权' },
  { re: /\bsystemctl\b|\bservice\s+\w+\s+(start|stop|restart)\b/, why: '不能动系统服务' },
  { re: /\b(shutdown|reboot|poweroff|halt|init\s+[06])\b/, why: '不能关机重启' },
  { re: /\b(mkfs|fdisk|parted|dd\s+if=)/, why: '不能碰磁盘' },
  { re: /\brm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/, why: '不能删根目录' },
  { re: /\/etc\/|\/boot\/|\/root\/|\.ssh\/|\.env\b|nanobot_secrets/, why: '不能读改写系统配置与密钥' },
  { re: /\b(curl|wget)\b[^|;]*\|\s*(ba)?sh/, why: '不能把网络内容直接交给 shell' },
  { re: /\b(useradd|userdel|usermod|passwd|visudo|chpasswd)\b/, why: '不能改用户与密码' },
  { re: /\bcrontab\b|\bat\s+-f\b/, why: '不能装定时任务' },
  { re: /\b(ssh|scp|rsync)\b.*@/, why: '不能连别的机器' },
  { re: /\b(nc|ncat|netcat|socat)\b/, why: '不能开网络隧道' },
  { re: /\bgit\s+push\b[^\n]*--force|\bgit\s+push\b[^\n]*\s-f(\s|$)/, why: '不能强推' },
  { re: /\bgit\s+push\b[^\n]*\b(main|master)\b/, why: '不能直推 main，必须开分支走 PR' },
  { re: /\bgit\s+(reset|checkout)\b[^\n]*--hard/, why: '不能硬回滚，会丢别人未提交的工作' },
  { re: /\bnpm\s+publish\b|\bpnpm\s+publish\b/, why: '不能发版' },
];

/** dev 档只放行这些（读、查、跑测试与构建）。 */
const DEV_ALLOW: RegExp[] = [
  /^(pwd|whoami|date|uname|node\s+-v|npm\s+-v|pnpm\s+-v|git\s+--version)\s*$/,
  /^(ls|cat|head|tail|wc|stat|file|du|df|tree|which|echo|sort|uniq|cut|column|jq)\b/,
  /^(grep|rg|find|fd|ag)\b/,
  /^git\s+(status|log|diff|show|branch|remote|ls-remote|rev-parse|describe|blame|shortlog|tag)\b/,
  /^(npm|pnpm)\s+(test|run\s+(test|build|lint|typecheck|check|ci)[\w:-]*)\b/,
  /^(npm|pnpm)\s+exec\s+(vitest|tsc|astro|vite)\b/,
  /^(npx\s+)?(vitest|tsc)\b/,
];

function collapsed(cmd: string): string {
  return cmd.replace(/\s+/g, ' ').trim();
}

/** 一段命令是不是全在 dev 白名单里（按 && ; | 切开，逐段判断）。 */
export function devAllowed(cmd: string): boolean {
  const segments = collapsed(cmd)
    .split(/&&|\|\||;|\|/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return false;
  }
  return segments.every((segment) => DEV_ALLOW.some((re) => re.test(segment)));
}

export interface CheckResult {
  allowed: boolean;
  why?: string;
}

/** 判一条命令能不能跑。不给理由就不许跑，便于日志定位。 */
export function checkCommand(cmd: string, tier: Tier, workspace: string): CheckResult {
  const text = collapsed(cmd);
  if (!text) {
    return { allowed: false, why: '空命令' };
  }
  // guest 一律不给：这一层不靠能力集兜底，两层都堵住
  if (tier === 'guest') {
    return { allowed: false, why: '这个身份不能跑命令' };
  }
  for (const rule of FORBIDDEN) {
    if (rule.re.test(text)) {
      return { allowed: false, why: rule.why };
    }
  }
  // 命令里出现的绝对路径必须落在工作区（或 /tmp、基础命令目录）里
  const mentioned = text.match(/(?:^|\s)(\/[A-Za-z0-9._-]+(?:\/[^\s]*)?)/g) ?? [];
  const harmless = new Set(['/tmp', '/dev/null', '/usr/bin', '/bin', '/usr/local/bin', '/usr/share']);
  for (const raw of mentioned) {
    const candidate = path.resolve(raw.trim());
    const inside = candidate === workspace || candidate.startsWith(`${workspace}/`);
    const tempZone = candidate === '/tmp' || candidate.startsWith('/tmp/');
    if (!inside && !tempZone && !harmless.has(candidate)) {
      return { allowed: false, why: `不能访问工作区外的路径：${candidate}` };
    }
  }
  if (tier !== 'owner' && !devAllowed(text)) {
    return { allowed: false, why: '这个身份只能跑读与测试类命令；改代码要主人来' };
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
  const verdict = checkCommand(options.cmd, options.tier, path.resolve(options.workspace));
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
