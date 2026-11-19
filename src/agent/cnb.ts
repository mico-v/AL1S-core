/**
 * cnb.cool 接口的薄客户端：issue 协作通道。
 *
 * 开发通道的口径（2026-11-18 定）：需求先落 CNB issue → 评论里 `work_mode: true`
 * 派给 NPC/CodeBuddy → 它拉分支、写代码、开 PR → 这里复核 → 合 PR、关 issue。
 * 这个模块只负责把接口包成函数，判定（谁该干、能不能合）留给模型和复核。
 *
 * 认证：令牌只给 repo 级权限，放在 /srv/kei/.config/cnb/token（kei 600）。
 * Accept 头必须是 `application/vnd.cnb.api+json`，写 `application/json` 会 406。
 */

import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import type { AppLogger } from '../logger.js';

export interface CnbConfig {
  apiBase: string;
  repo: string;
  token: string;
}

export interface CnbIssue {
  number: number;
  state: string;
  title: string;
  body?: string;
  comment_count?: number;
  created_at?: string;
  updated_at?: string;
  author?: { username?: string };
}

export interface CnbPull {
  number: number;
  state: string;
  title: string;
  created_at?: string;
  updated_at?: string;
  merged?: boolean;
  head?: { ref?: string };
  base?: { ref?: string };
}

const DEFAULT_API_BASE = 'https://api.cnb.cool';
const DEFAULT_TOKEN_FILE = '/srv/kei/.config/cnb/token';
const DEFAULT_REPO = 'mico-v/campus-nav-3d';

/** 从环境变量 + 令牌文件拼配置；没有令牌就返回 undefined（工具直接不挂）。 */
export function readCnbConfig(env: NodeJS.ProcessEnv): CnbConfig | undefined {
  const inline = (env.KEI_CNB_TOKEN ?? '').trim();
  const tokenFile = (env.AGENT_CNB_TOKEN_FILE ?? DEFAULT_TOKEN_FILE).trim();
  let token = inline;
  if (!token && tokenFile && existsSync(tokenFile)) {
    try {
      token = readFileSync(tokenFile, 'utf8').trim();
    } catch {
      token = '';
    }
  }
  if (!token) {
    return undefined;
  }
  return {
    apiBase: (env.AGENT_CNB_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, ''),
    repo: (env.AGENT_CNB_REPO ?? DEFAULT_REPO).trim(),
    token,
  };
}

export class CnbError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CnbError';
    this.status = status;
  }
}

export interface CnbProbe {
  /** 状态指纹：状态 / 评论数 / 更新时间 / 开着的 PR 都会变。 */
  sig: string;
  summary: string;
}

/**
 * 状态指纹：用来判断「NPC 那边动没动」。
 *
 * 没变就一个字也不用回（不花模型钱），变了再把变化摘要喂回去。
 */
export function buildProbeSignature(
  issue: { state?: string; comment_count?: number; updated_at?: string },
  pulls: CnbPull[],
): string {
  const open = pulls
    .filter((pull) => pull.state === 'open' || pull.merged)
    .map((pull) => `${pull.number}:${pull.state}:${pull.updated_at ?? ''}`)
    .sort()
    .join(',');
  return [issue.state ?? '', issue.comment_count ?? 0, issue.updated_at ?? '', open].join('|');
}

export class CnbClient {
  readonly repo: string;
  private readonly apiBase: string;
  private readonly token: string;
  private readonly log: AppLogger;

  constructor(config: CnbConfig, log: AppLogger) {
    this.apiBase = config.apiBase;
    this.repo = config.repo;
    this.token = config.token;
    this.log = log;
  }

  private async call<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.apiBase}/${this.repo}/-${pathname}`;
    const response = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.cnb.api+json',
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await response.text();
    if (!response.ok) {
      this.log.warn('CNB 请求失败', { pathname, status: response.status, body: raw.slice(0, 200) });
      throw new CnbError(`CNB ${response.status}：${raw.slice(0, 200) || '空响应'}`, response.status);
    }
    if (!raw.trim()) {
      return {} as T;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new CnbError(`CNB 返回的不是 JSON：${raw.slice(0, 120)}`, 502);
    }
  }

  async listIssues(state: 'open' | 'closed' = 'open'): Promise<CnbIssue[]> {
    const data = await this.call<CnbIssue[] | { list?: CnbIssue[] }>(`/issues?state=${state}`);
    if (Array.isArray(data)) {
      return data;
    }
    return data.list ?? [];
  }

  async getIssue(number: number): Promise<CnbIssue> {
    return await this.call<CnbIssue>(`/issues/${number}`);
  }

  async createIssue(input: { title: string; body: string }): Promise<CnbIssue> {
    return await this.call<CnbIssue>('/issues', {
      method: 'POST',
      body: JSON.stringify({ title: input.title, body: input.body }),
    });
  }

  /** 派工评论：带 work_mode 才会让 NPC 真正下场写代码。 */
  async commentIssue(number: number, body: string, workMode = false): Promise<void> {
    await this.call(`/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify(workMode ? { body, work_mode: true } : { body }),
    });
  }

  async closeIssue(number: number, body?: string): Promise<void> {
    if (body) {
      await this.commentIssue(number, body);
    }
    await this.call(`/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
    });
  }

  async listPulls(state: 'open' | 'closed' | 'all' = 'open'): Promise<CnbPull[]> {
    const data = await this.call<CnbPull[] | { list?: CnbPull[] }>(`/pulls?state=${state}`);
    if (Array.isArray(data)) {
      return data;
    }
    return data.list ?? [];
  }

  /** 轻量探针：只读两个接口，不花模型钱。 */
  async probeIssue(number: number): Promise<CnbProbe> {
    const issue = await this.getIssue(number);
    const pulls = await this.listPulls('open');
    const sig = buildProbeSignature(issue, pulls);
    const lines = [
      `#${issue.number} [${issue.state}] ${issue.title}`,
      `评论 ${issue.comment_count ?? 0} 条 · 最近更新 ${shortTime(issue.updated_at)}`,
    ];
    if (pulls.length > 0) {
      lines.push(
        `open PR：${pulls
          .slice(0, 5)
          .map((pull) => `#${pull.number} ${pull.title}`)
          .join(' / ')}`,
      );
    } else {
      lines.push('open PR：无（NPC 还没提）');
    }
    return { sig, summary: lines.join('\n') };
  }
}

function shortTime(iso: string | undefined): string {
  if (!iso) {
    return '';
  }
  return iso.slice(5, 16).replace('T', ' ');
}

export function renderIssues(issues: CnbIssue[], repo: string): string {
  if (issues.length === 0) {
    return `${repo} 没有 issue。要开工就先开一个：目标 / 范围 / 验收 / 风险四段。`;
  }
  return issues
    .slice(0, 20)
    .map((issue) => {
      const author = issue.author?.username ? ` @${issue.author.username}` : '';
      const comments = issue.comment_count ? ` · ${issue.comment_count} 条评论` : '';
      return `#${issue.number} [${issue.state}] ${issue.title}（${shortTime(issue.updated_at)}${author}${comments}）`;
    })
    .join('\n');
}

export function renderIssue(issue: CnbIssue, repo: string): string {
  const head = `#${issue.number} [${issue.state}] ${issue.title} · ${repo}`;
  const meta = [shortTime(issue.created_at), issue.author?.username ? `@${issue.author.username}` : '']
    .filter(Boolean)
    .join(' · ');
  const body = (issue.body ?? '').trim();
  return [head, meta, body ? `\n${body.slice(0, 2500)}` : '（正文为空）'].filter(Boolean).join('\n');
}

export function renderPulls(pulls: CnbPull[], repo: string): string {
  if (pulls.length === 0) {
    return `${repo} 没有 PR。派工之后 PR 还没出来，就等 NPC 回话或看 issue 评论。`;
  }
  return pulls
    .slice(0, 20)
    .map((pull) => {
      const state = pull.merged ? 'merged' : pull.state;
      const head = pull.head?.ref ? ` ${pull.head.ref} → ${pull.base?.ref ?? 'main'}` : '';
      return `#${pull.number} [${state}] ${pull.title}${head}（${shortTime(pull.updated_at ?? pull.created_at)}）`;
    })
    .join('\n');
}
