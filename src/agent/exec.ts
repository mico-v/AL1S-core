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

export type HeavyMode = 'block' | 'warn' | 'allow';

/** 解析 `AGENT_LOCAL_HEAVY`；不认识的写法当默认（block）。 */
export function parseHeavyMode(raw: string | undefined): HeavyMode {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'allow' || value === 'warn' ? value : 'block';
}

/**
 * 命令里真会跑东西的那几段：按 `;` `&&` `||` `|` 换行切开。
 * 只看版本的段（`--version` / `-v` / `--help`）不算，那是探路不是跑测试。
 */
function segments(cmd: string): string[] {
  return cmd
    .split(/;|&&|\|\||\||\n/)
    .map((part) => collapsed(part))
    .filter(Boolean)
    .filter((part) => !/(?:^|\s)(?:--version|--help|-v)(?:\s|$)/.test(part));
}

/** 明确点名了用例文件：`src/a.test.ts`、`tests/x.spec.ts`、`tests/` 目录。 */
const TEST_TARGET = /\.(?:test|spec)\.[cm]?[jt]sx?\b|(?:^|\s)(?:tests?|__tests__)\//;

/** 真去跑测试的写法：vitest/jest 在命令位（前面只有 npx/pnpm 这类启动器与 env 赋值）。 */
const TEST_RUNNER =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:npx|pnpm|npm|yarn|bun|corepack|node|time)\s+)*(?:vitest|jest)\b/;

/** 只读查看：命令里提到 vitest 不代表要跑它。 */
const READ_ONLY = /^(?:git|grep|rg|cat|ls|head|tail|sed|awk|wc|find|diff|jq|echo)\b/;

/**
 * 这条命令是不是「CI 的活」：全量单测 / 全量构建。
 *
 * 2026-11-21 口径：Kei 是指挥，不是施工队。一次 `npx vitest run` 在本机要 167 秒，
 * 输出还得吃几千 token；这活本来就该 NPC 在 PR 里跑、CI 在云端跑。
 *
 * 2026-11-22 改按段判：11-21 共拦下 52 次，其中 9 次是误伤 —— `npx vitest run src/data/adapter.test.ts`
 * 这种点名单个用例的（几秒），以及「`tsc --noEmit`; 定向用例」拼起来的复合命令，
 * 被整条当成全量拦掉；模型于是改用 force 重跑，49 次强制重活合计 25 分钟，还白烧轮数。
 * 所以：定向用例放行；`tsc --noEmit` 也不再算重活（实测 campus-nav-3d 全量类型检查 17.9 秒，
 * 是标 done 前的常规证据，拦它换来的是一轮重试，更贵）。
 */
export function heavyLocalHint(cmd: string): string | undefined {
  for (const part of segments(cmd)) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    // 只读查看不算重活：`git show HEAD:vitest.config.ts`、`grep -n vitest src/` 都只是看字，
    // 却曾因「出现 vitest 字样」被拦下，模型改用 force 重跑（2026-11-22 实测一次白烧两分钟）
    if (READ_ONLY.test(trimmed)) {
      continue;
    }
    if (TEST_RUNNER.test(trimmed)) {
      const targeted = TEST_TARGET.test(trimmed) || /--testNamePattern|(?:^|\s)-t\s/.test(trimmed);
      if (!targeted) {
        return '全量单测';
      }
      continue;
    }
    if (/\b(npm|pnpm|yarn)\s+(run\s+)?(build|test)\b/.test(trimmed)) {
      return '全量构建/测试';
    }
    if (/\b(vite|astro|rollup)\b.*\bbuild\b/.test(trimmed)) {
      return '全量构建';
    }
  }
  return undefined;
}

/**
 * 命令里是不是在「原地等」：`sleep N` 超过 20 秒。
 *
 * 11-19 到 11-21 共 31 条这种命令，光 sleep 就占 48 分钟，而且整轮卡在里面 ——
 * 等 CI 的几分钟里它什么都干不了，主人那边也看不到任何进展。
 * 等 NPC/CI 应该挂探针（goal_watch），那边一动就叫醒，不烧回合。
 */
export function waitLocalHint(cmd: string): number | undefined {
  let longest: number | undefined;
  for (const part of segments(cmd)) {
    const match = /\bsleep\s+(\d+(?:\.\d+)?)\s*([smh])?\b/.exec(part);
    if (!match) {
      continue;
    }
    const amount = Number(match[1]);
    const unit = match[2] ?? 's';
    const secs = unit === 'm' ? amount * 60 : unit === 'h' ? amount * 3600 : amount;
    if (secs >= 20 && (longest === undefined || secs > longest)) {
      longest = secs;
    }
  }
  return longest;
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
