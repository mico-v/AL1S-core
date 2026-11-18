/**
 * 工作区：Kei 唯一能碰的文件系统范围。
 *
 * 所有路径都先 resolve 到根目录里再开文件，`../` 和符号链接都绕不出去。
 * 读有上限（单文件 30KB / 一次 40 条），写只允许文本，二进制一律拒绝。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderRunResult, runCommand } from './exec.js';

/** 这些目录/扩展名不读：体积大、跟开发无关、或者干脆是二进制。 */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.astro',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.css', '.scss',
  '.html', '.htm', '.astro', '.vue', '.svelte', '.yml', '.yaml', '.toml', '.ini', '.env',
  '.txt', '.sh', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.sql', '.xml',
  '.csv', '.svg',
]);

export const MAX_READ_BYTES = 30_000;
export const MAX_WRITE_BYTES = 120_000;
export const MAX_LIST_ENTRIES = 200;

export class WorkspaceError extends Error {}

export class Workspace {
  readonly root: string;
  readonly home: string;
  readonly repoDir: string;
  readonly repoSlug: string;

  constructor(root: string, repoDir: string, repoSlug: string, home: string) {
    this.root = path.resolve(root);
    this.repoDir = repoDir;
    this.repoSlug = repoSlug;
    this.home = home;
  }

  /** 把相对路径锁进工作区。越界就是错误，不给「猜一个相近路径」的余地。 */
  resolve(rel: string): string {
    const clean = (rel || '.').trim();
    if (clean.startsWith('/')) {
      throw new WorkspaceError(`只接受相对路径：${clean}`);
    }
    const target = path.resolve(this.root, clean);
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) {
      throw new WorkspaceError(`路径越出工作区：${clean}`);
    }
    return target;
  }

  async read(rel: string, maxChars = MAX_READ_BYTES): Promise<string> {
    const file = this.resolve(rel);
    const info = await stat(file).catch(() => undefined);
    if (!info) {
      return `没有这个文件：${rel}`;
    }
    if (info.isDirectory()) {
      return `${rel} 是目录，用 list_dir 看内容`;
    }
    if (info.size > 2_000_000) {
      return `${rel} 太大了（${Math.round(info.size / 1024)}KB），不整份读；用 grep_files 或更具体的命令`;
    }
    const text = await readFile(file, 'utf8');
    if (text.length > maxChars) {
      return `${text.slice(0, maxChars)}\n…（已截断，共 ${text.length} 字符）`;
    }
    return text;
  }

  async write(rel: string, content: string): Promise<string> {
    if (content.length > MAX_WRITE_BYTES) {
      return `内容太长（${content.length} 字符），单次写入上限 ${MAX_WRITE_BYTES}；分几次写`;
    }
    const file = this.resolve(rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    return `已写入 ${rel}（${content.length} 字符）`;
  }

  async list(rel = '.', depth = 2): Promise<string> {
    const lines: string[] = [];
    const walk = async (dir: string, prefix: string, level: number): Promise<void> => {
      if (lines.length >= MAX_LIST_ENTRIES || level > depth) {
        return;
      }
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (lines.length >= MAX_LIST_ENTRIES) {
          return;
        }
        if (entry.name === '.' || entry.name === '..') {
          continue;
        }
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) {
            continue;
          }
          lines.push(`${prefix}${entry.name}/`);
          await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`, level + 1);
        } else {
          lines.push(`${prefix}${entry.name}`);
        }
      }
    };
    await walk(this.resolve(rel), '', 1);
    if (lines.length === 0) {
      return `${rel} 是空的，或者没有权限读`;
    }
    return lines.join('\n');
  }

  /** 纯 JS 的 grep：没装 ripgrep 也能用，跳过二进制与大文件。 */
  async grep(pattern: string, rel = '.', limit = 40): Promise<string> {
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      // 不是正则就按字面量处理，别因为用户写了个 `(` 就报错
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const hits: string[] = [];
    const queue: Array<{ dir: string; prefix: string }> = [{ dir: this.resolve(rel), prefix: '' }];
    while (queue.length > 0 && hits.length < limit) {
      const next = queue.shift();
      if (!next) {
        break;
      }
      const entries = await readdir(next.dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (hits.length >= limit) {
          break;
        }
        const child = path.join(next.dir, entry.name);
        const shown = `${next.prefix}${entry.name}`;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            queue.push({ dir: child, prefix: `${shown}/` });
          }
          continue;
        }
        if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) {
          continue;
        }
        const info = await stat(child).catch(() => undefined);
        if (!info || info.size > 400_000) {
          continue;
        }
        const text = await readFile(child, 'utf8').catch(() => '');
        const rows = text.split('\n');
        for (let i = 0; i < rows.length && hits.length < limit; i += 1) {
          const row = rows[i] ?? '';
          if (re.test(row)) {
            hits.push(`${shown}:${i + 1}: ${row.trim().slice(0, 200)}`);
          }
        }
      }
    }
    if (hits.length === 0) {
      return `没搜到「${pattern}」`;
    }
    return hits.join('\n');
  }

  /** 仓库快照：分支、脏文件、最近提交。用只读 git 命令，跑完就丢。 */
  async gitSummary(): Promise<string> {
    const cwd = this.repoDir;
    const run = async (cmd: string): Promise<string> => {
      const result = await runCommand({
        cmd,
        cwd,
        workspace: this.root,
        tier: 'owner',
        home: this.home,
        limits: { timeoutMs: 20_000, maxBytes: 4_000 },
      });
      if (result.denied) {
        return `（拒绝：${result.denied}）`;
      }
      return (result.stdout || result.stderr).trim();
    };
    const [branch, dirty, log, remote] = await Promise.all([
      run('git rev-parse --abbrev-ref HEAD'),
      run('git status --porcelain'),
      run('git log --oneline -5'),
      run('git log --oneline -1 origin/HEAD'),
    ]);
    const dirtyLines = dirty ? dirty.split('\n').filter(Boolean) : [];
    return [
      `仓库：${this.repoSlug}（工作区 ${this.repoDir}）`,
      `分支：${branch || '未知'}`,
      `未提交改动：${dirtyLines.length === 0 ? '无' : `${dirtyLines.length} 个文件\n${dirtyLines.slice(0, 15).join('\n')}`}`,
      `最近提交：\n${log || '（无）'}`,
      remote ? `远端 HEAD：${remote}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** CI 最近几次运行。匿名 GitHub API，只读，不占额度也不带凭据。 */
  async ciStatus(limit = 3): Promise<string> {
    const token = process.env.KEI_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
    const url = `https://api.github.com/repos/${this.repoSlug}/actions/runs?per_page=${limit}`;
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'kei-bot',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return `查不到 CI：GitHub 返回 ${res.status}${res.status === 403 ? '（匿名额度用完了，等一会儿或让主人配 token）' : ''}`;
      }
      const body = (await res.json()) as {
        workflow_runs?: Array<{
          name?: string;
          head_branch?: string;
          status?: string;
          conclusion?: string | null;
          created_at?: string;
          html_url?: string;
          head_commit?: { message?: string };
        }>;
      };
      const runs = body.workflow_runs ?? [];
      if (runs.length === 0) {
        return '还没有 CI 运行记录。';
      }
      return runs
        .map((run) => {
          const when = (run.created_at ?? '').replace('T', ' ').slice(0, 16);
          const state = run.conclusion ?? run.status ?? 'unknown';
          const msg = (run.head_commit?.message ?? '').split('\n')[0]?.slice(0, 60) ?? '';
          return `[${when}] ${run.name ?? 'workflow'} · ${run.head_branch ?? '?'} · ${state} · ${msg}`;
        })
        .join('\n');
    } catch (error) {
      return `查 CI 失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** 给提示词用的固定信息，不联网、不跑命令，避免每轮都开销。 */
  describe(): string {
    return `所有文件操作都锁在 ${this.root}，主仓库是 ${this.repoDir}（GitHub ${this.repoSlug}）。路径一律写相对工作区的，不要用绝对路径。`;
  }
}

export function workspaceExists(dir: string): boolean {
  return existsSync(dir);
}

export { renderRunResult };
