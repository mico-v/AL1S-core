/**
 * CNB 官方 CLI（@cnbcool/cnb-cli）的薄封装。
 *
 * 背景：CNB 把平台能力做成了一套官方 skill（cnb-api / cnb-pipeline / cnb-code-review /
 * cnb-upload-attachment / cnb-docs / cnb-knowledge-base / cnb-tapd / cnb-version ...），
 * 底层收敛成一条命令线 `cnb <module> <tool>`。这里把这条线接给模型：
 *   - `cnb` 工具：按 argv 跑命令（不经 shell），危险模块与覆盖凭据的参数在入口挡掉；
 *   - 官方 skill 文档放在 guideDir，用 `cnb_guide` 按需读，不往 system 里塞几十 KB。
 *
 * 认证沿用 issue 通道那份令牌，仓库靠 CNB_REPO_SLUG 固定 —— 模型漏了 `--repo` 也不会打错仓库
 * （实测 CLI 从 cwd 推断不可靠：仓库有 github origin 时会走偏，返回 404）。
 */

import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppLogger } from '../logger.js';
import { readCnbConfig, type CnbConfig } from './cnb.js';

const DEFAULT_BIN = '/usr/local/bin/cnb';
const DEFAULT_HOME = '/srv/kei';
const DEFAULT_GUIDE_SUBDIR = 'cnb-skills';
const DEFAULT_REPO_SUBDIR = path.join('work', 'campus-nav-3d');

export interface CnbCliConfig {
  /** cnb 可执行文件。 */
  bin: string;
  /** 默认仓库（org/repo），注入 CNB_REPO_SLUG。 */
  repo: string;
  token: string;
  apiBase: string;
  /** kei 的 HOME：CLI 会找 ~/.cnb/token，也给 git 用。 */
  home: string;
  /** 命令的工作目录（git 仓库；CNB 相关命令不会真改它）。 */
  cwd: string;
  /** 官方 skill 文档根目录。 */
  guideDir: string;
}

/** 从已有的 issue 通道配置派生；没有令牌就没有 CLI 工具。 */
export function readCnbCliConfig(env: NodeJS.ProcessEnv, base?: CnbConfig): CnbCliConfig | undefined {
  const cnb = base ?? readCnbConfig(env);
  if (!cnb) {
    return undefined;
  }
  const home = (env.AGENT_CNB_HOME ?? env.HOME ?? DEFAULT_HOME).trim() || DEFAULT_HOME;
  return {
    bin: (env.AGENT_CNB_CLI ?? DEFAULT_BIN).trim() || DEFAULT_BIN,
    repo: cnb.repo,
    token: cnb.token,
    apiBase: cnb.apiBase,
    home,
    cwd: (env.AGENT_CNB_CWD ?? path.join(home, DEFAULT_REPO_SUBDIR)).trim(),
    guideDir: (env.AGENT_CNB_GUIDE_DIR ?? path.join(home, DEFAULT_GUIDE_SUBDIR)).trim(),
  };
}

/**
 * 允许的模块 = `cnb --help` 里列的那些。
 * login / logout / git-credential 故意不在里面：一个要交互、一个会把令牌吐给 git，
 * 令牌由 systemd 与 `.cnb/token` 管，不该从工具层走。
 */
export const CNB_MODULES = [
  'issues',
  'pulls',
  'repositories',
  'git',
  'build',
  'assets',
  'releases',
  'repo-labels',
  'repo-code-issue',
  'repo-contributor',
  'members',
  'organizations',
  'registries',
  'missions',
  'mission-resources',
  'knowledge-base',
  'search',
  'users',
  'starring',
  'activities',
  'followers',
  'workspace',
  'rank',
  'ai',
  'badge',
  'authentication',
  'git-settings',
  'charge',
  'npc-observability',
  'security',
  'artifact-security',
  'event',
  'skills',
  'status',
] as const;

const DENIED_MODULES = new Set(['login', 'logout', 'git-credential']);
/** 覆盖凭据的参数一律不许。 */
const DENIED_ARGS = [/^--?token$/i, /^--?password$/i, /^--?secret$/i, /^--?access-token$/i, /^--?api-key$/i];
/** 不可逆、且必须有人看着做的事。 */
const DENIED_WORDS = [/delete-repo/i, /delete-organization/i, /delete-mission/i, /delete-user/i];

export type CnbArgCheck = { ok: true; args: string[] } | { ok: false; reason: string };

/** 入口检查：argv 形状、模块白名单、凭据与不可逆操作。 */
export function checkCnbArgs(raw: unknown): CnbArgCheck {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: 'args 必须是非空字符串数组，例如 ["issues","get","--number","24"]。' };
  }
  if (raw.length > 40) {
    return { ok: false, reason: '参数太多（上限 40 个）。' };
  }
  const args: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, reason: 'args 里只能放字符串。' };
    }
    if (item.includes('\0')) {
      return { ok: false, reason: '参数里有 NUL 字节。' };
    }
    if (item.length > 8000) {
      return { ok: false, reason: '单个参数太长（上限 8000 字），正文请先写进文件再传 --body-file。' };
    }
    args.push(item);
  }
  const head = args[0] ?? '';
  if (head === '--help' || head === '-h' || head === '--version') {
    return { ok: true, args };
  }
  if (DENIED_MODULES.has(head)) {
    return { ok: false, reason: `「${head}」不给跑：令牌由服务端管，交互式登录会卡死整轮。` };
  }
  if (!(CNB_MODULES as readonly string[]).includes(head)) {
    return {
      ok: false,
      reason: `不认识的模块「${head}」。可用模块：${CNB_MODULES.join(' ')}（细节用 cnb_guide）。`,
    };
  }
  for (const arg of args) {
    if (DENIED_ARGS.some((re) => re.test(arg))) {
      return { ok: false, reason: `不允许在参数里覆盖凭据：${arg}` };
    }
  }
  const joined = args.join(' ');
  for (const re of DENIED_WORDS) {
    if (re.test(joined)) {
      return { ok: false, reason: '删仓库 / 删组织这类不可逆操作交给主人手动做。' };
    }
  }
  return { ok: true, args };
}

export type IssueCommentRoute =
  | { kind: 'dispatch'; number: number; body: string }
  | { kind: 'plain'; number: number; body: string }
  | { kind: 'none' };

/**
 * `cnb issues comment` 的落点判断：默认按派工发（带 work_mode + @CodeBuddy）。
 *
 * 2026-11-21 实测踩坑：它用裸 CLI 发了「复核不通过，请在这个分支补…」，没带 work_mode，
 * NPC 根本不会下场，评论看着像派了活，实际干等 2 小时半。
 * 所以走 CLI 发评论一律升级成派工；只想留一句记录就写 `note:` 前缀（会去掉前缀再发）。
 */
export function routeIssueComment(args: string[]): IssueCommentRoute {
  if (args[0] !== 'issues' || args[1] !== 'comment') {
    return { kind: 'none' };
  }
  const value = (names: string[]): string | undefined => {
    for (let i = 0; i < args.length; i += 1) {
      const flag = args[i];
      if (!flag || !names.includes(flag)) {
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        return next;
      }
    }
    return undefined;
  };
  const number = Number(value(['--number', '-n', '--issue', '-i']));
  const body = value(['--body', '-b']);
  if (!Number.isFinite(number) || number <= 0 || !body || !body.trim()) {
    return { kind: 'none' };
  }
  const trimmed = body.trim();
  if (/^note[:：]/i.test(trimmed)) {
    return { kind: 'plain', number, body: trimmed.replace(/^note[:：]\s*/i, '') };
  }
  return { kind: 'dispatch', number, body: trimmed };
}

/** 派工正文一定要有 @：模型漏了就补上，不靠它记。 */
export function ensureBuddyMention(body: string): string {
  const trimmed = body.trim();
  return /@CodeBuddy\b/i.test(trimmed) ? trimmed : `@CodeBuddy\n\n${trimmed}`;
}


export interface CnbRunResult {
  /** 进程退出码；-1 = 起不来，-2 = 超时被杀。 */
  code: number;
  out: string;
  err: string;
  ms: number;
}

export class CnbCli {
  readonly config: CnbCliConfig;
  private readonly log?: AppLogger;

  constructor(config: CnbCliConfig, log?: AppLogger) {
    this.config = config;
    this.log = log;
  }

  /** 跑一条 cnb 命令。argv 直接交给 spawn，不经 shell。 */
  async run(args: string[], opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<CnbRunResult> {
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 60_000, 5_000), 180_000);
    const maxBytes = Math.min(Math.max(opts.maxBytes ?? 20_000, 1_000), 80_000);
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: this.config.home,
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
      CNB_TOKEN: this.config.token,
      CNB_API_ENDPOINT: this.config.apiBase,
      CNB_REPO_SLUG: this.config.repo,
      CNB_WEB_PROTOCOL: 'https',
      CNB_WEB_HOST: 'cnb.cool',
    };
    const started = Date.now();
    return await new Promise<CnbRunResult>((resolve) => {
      let out = '';
      let err = '';
      let killed = false;
      let settled = false;
      const finish = (code: number, extraErr = ''): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ code, out, err: extraErr ? `${err}${extraErr}` : err, ms: Date.now() - started });
      };
      const child = spawn(this.config.bin, args, {
        cwd: this.config.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const append = (prev: string, chunk: Buffer): string =>
        prev.length >= maxBytes ? prev : prev + chunk.toString('utf8').slice(0, maxBytes - prev.length);
      child.stdout.on('data', (chunk: Buffer) => {
        out = append(out, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        err = append(err, chunk);
      });
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', (error: Error) => {
        this.log?.warn('cnb 命令起不来', { bin: this.config.bin, error: error.message });
        finish(-1, `起不来：${error.message}`);
      });
      child.on('close', (code: number | null) => {
        finish(killed ? -2 : (code ?? -1));
      });
    });
  }
}

/** 命令结果的紧凑视图。注意：CLI 对 HTTP 404 也退出 0，结论看输出里的 status / errcode。 */
export function renderCnbRun(result: CnbRunResult, args: string[]): string {
  const status =
    result.code === 0
      ? 'ok'
      : result.code === -2
        ? '超时被杀'
        : result.code === -1
          ? '起不来'
          : `退出码 ${result.code}`;
  const lines = [`cnb ${args.join(' ')} → ${status}（${(result.ms / 1000).toFixed(1)}s）`];
  const body = result.out.trim();
  const err = result.err.trim();
  if (body) {
    lines.push(body);
  }
  if (err) {
    lines.push(`stderr:\n${err}`);
  }
  if (!body && !err) {
    lines.push('（没有输出）');
  }
  return lines.join('\n');
}

export interface GuideEntry {
  name: string;
  description: string;
  files: string[];
}

async function walk(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walk(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files.sort();
}

/** frontmatter 里的 description（只认单行）。 */
function frontmatterDescription(text: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) {
    return '';
  }
  const body = match[1] ?? '';
  const line = body
    .split('\n')
    .find((item) => item.trim().startsWith('description:'));
  return line ? line.replace(/^\s*description:\s*/, '').replace(/^['"]|['"]$/g, '').trim() : '';
}

/** 列出官方 skill 文档。 */
export async function listCnbGuide(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const skills: GuideEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const root = path.join(dir, entry.name);
    const files = await walk(root);
    if (!files.includes('SKILL.md')) {
      continue;
    }
    const text = await readFile(path.join(root, 'SKILL.md'), 'utf8').catch(() => '');
    skills.push({ name: entry.name, description: frontmatterDescription(text), files });
  }
  if (skills.length === 0) {
    return `官方 skill 文档目录是空的：${dir}（装法见 cnb-skill 仓库的 npx skills add）。`;
  }
  const lines = [`CNB 官方 skill 文档（${skills.length} 个，目录 ${dir}）：`];
  for (const skill of skills) {
    const refs = skill.files.filter((file) => file !== 'SKILL.md');
    lines.push(
      `- ${skill.name}：${skill.description || '（无说明）'}${refs.length > 0 ? `（另有 ${refs.length} 份参考：${refs.join('、')}）` : ''}`,
    );
  }
  lines.push('用法：cnb_guide name=<技能名> 读正文；name + path 读参考文件；query 关键词全库检索。');
  return lines.join('\n');
}

function resolveInside(dir: string, ...parts: string[]): string | undefined {
  const root = path.resolve(dir);
  const target = path.resolve(root, ...parts);
  return target === root || target.startsWith(`${root}${path.sep}`) ? target : undefined;
}

/** 读某个 skill 的正文（或它下面的参考文件）。 */
export async function readCnbGuide(dir: string, name: string, sub?: string): Promise<string> {
  if (!name || name.includes('..') || name.includes('/')) {
    return `技能名不合法：${name}。先用 cnb_guide 不带参数看列表。`;
  }
  const target = resolveInside(dir, name, sub ?? 'SKILL.md');
  if (!target) {
    return '路径跑到文档目录外面了，不给读。';
  }
  const text = await readFile(target, 'utf8').catch(() => undefined);
  if (text === undefined) {
    return `没有这个文件：${path.join(name, sub ?? 'SKILL.md')}。先 cnb_guide 看有哪些。`;
  }
  return text.length > 12_000 ? `${text.slice(0, 12_000)}\n…（已截断，需要细节用 cnb_guide query 定位）` : text;
}

/** 全库检索：返回 文件:行 的命中。 */
export async function searchCnbGuide(dir: string, query: string, limit = 30): Promise<string> {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return 'query 不能为空。';
  }
  const files = await walk(dir);
  const hits: string[] = [];
  for (const rel of files) {
    if (!rel.endsWith('.md')) {
      continue;
    }
    const target = resolveInside(dir, rel);
    if (!target) {
      continue;
    }
    const text = await readFile(target, 'utf8').catch(() => '');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const row = lines[i] ?? '';
      if (row.toLowerCase().includes(needle)) {
        hits.push(`${rel}:${i + 1}: ${row.trim().slice(0, 200)}`);
        if (hits.length >= limit) {
          return `${hits.join('\n')}\n（命中已达 ${limit} 条，缩小关键词再查）`;
        }
      }
    }
  }
  return hits.length > 0 ? hits.join('\n') : `文档里没有「${query}」。换个词，或不带参数看技能列表。`;
}
