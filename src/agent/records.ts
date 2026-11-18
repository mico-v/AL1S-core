/**
 * 记录：项目和群聊共用一套「条目」结构。
 *
 * 聊天记录是流水（谁在几点说了什么），不适合直接当工作记忆用 —— 翻一百行才能
 * 找到一句「接口先定成 M1」。所以另存一层结构化条目：决策、任务、里程碑、风险，
 * 每条带状态与出处，只追加不改写（改状态就再追加一条 status，最新的算数）。
 *
 * 落地在 data/memory/<群>/records/YYYY-MM.jsonl，和成员档案、群日记同一棵树，
 * 一个群一套，互不串味。检索与简报都由这里出，不靠模型记性。
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export type RecordKind = 'decision' | 'task' | 'milestone' | 'risk' | 'note' | 'status';
export type RecordStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'dropped';

export interface RecordEntry {
  id: string;
  at: string;
  kind: RecordKind;
  title: string;
  body?: string;
  status?: RecordStatus;
  owner?: string;
  tags?: string[];
  refs?: string[];
  /** 谁说的（记录来源，群昵称或「主人」）。 */
  by?: string;
  /** kind=status 时，改的是哪一条。 */
  ref?: string;
}

const KINDS: RecordKind[] = ['decision', 'task', 'milestone', 'risk', 'note', 'status'];
const STATUSES: RecordStatus[] = ['todo', 'doing', 'done', 'blocked', 'dropped'];

export function isKind(value: unknown): value is RecordKind {
  return typeof value === 'string' && (KINDS as string[]).includes(value);
}

export function isStatus(value: unknown): value is RecordStatus {
  return typeof value === 'string' && (STATUSES as string[]).includes(value);
}

function newId(at: Date): string {
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export class RecordStore {
  readonly dir: string;

  constructor(dataRoot: string, groupId: string) {
    const safe = groupId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
    this.dir = path.join(dataRoot, 'memory', safe, 'records');
  }

  private fileFor(at: Date): string {
    return path.join(this.dir, `${at.toISOString().slice(0, 7)}.jsonl`);
  }

  async append(
    entry: Omit<RecordEntry, 'id' | 'at'> & { id?: string; at?: Date },
  ): Promise<RecordEntry> {
    const at = entry.at ?? new Date();
    const record: RecordEntry = {
      ...entry,
      id: entry.id ?? newId(at),
      at: at.toISOString(),
    };
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.fileFor(at), `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  /** 读最近几个月（默认 6）的全部条目，坏行跳过。 */
  async all(months = 6): Promise<RecordEntry[]> {
    if (!existsSync(this.dir)) {
      return [];
    }
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.jsonl')).sort().slice(-months);
    const out: RecordEntry[] = [];
    for (const file of files) {
      const raw = await readFile(path.join(this.dir, file), 'utf8').catch(() => '');
      for (const line of raw.split('\n')) {
        if (!line.trim()) {
          continue;
        }
        try {
          out.push(JSON.parse(line) as RecordEntry);
        } catch {
          // 半行（正在写）就当没看见
        }
      }
    }
    out.sort((a, b) => a.at.localeCompare(b.at));
    return out;
  }

  /** 把 status 记录折叠进去，得到每条的最新状态。 */
  async resolved(): Promise<Array<RecordEntry & { effectiveStatus?: RecordStatus; updatedAt?: string }>> {
    const entries = await this.all();
    const byId = new Map<string, RecordEntry & { effectiveStatus?: RecordStatus; updatedAt?: string }>();
    for (const entry of entries) {
      if (entry.kind === 'status') {
        const target = entry.ref ? byId.get(entry.ref) : undefined;
        if (target && entry.status) {
          target.effectiveStatus = entry.status;
          target.updatedAt = entry.at;
        }
        continue;
      }
      byId.set(entry.id, {
        ...entry,
        effectiveStatus: entry.status,
        updatedAt: entry.at,
      });
    }
    return [...byId.values()].sort((a, b) => (b.updatedAt ?? b.at).localeCompare(a.updatedAt ?? a.at));
  }

  async query(options: { text?: string; kind?: RecordKind; status?: RecordStatus; limit?: number } = {}): Promise<string> {
    const rows = await this.resolved();
    const text = (options.text ?? '').trim().toLowerCase();
    const hits = rows.filter((row) => {
      if (options.kind && row.kind !== options.kind) {
        return false;
      }
      if (options.status && row.effectiveStatus !== options.status) {
        return false;
      }
      if (!text) {
        return true;
      }
      const haystack = `${row.title} ${row.body ?? ''} ${(row.tags ?? []).join(' ')} ${row.owner ?? ''}`.toLowerCase();
      return haystack.includes(text);
    });
    if (hits.length === 0) {
      return text ? `记录里没有跟「${options.text}」相关的条目。` : '这个群还没有任何记录。';
    }
    return hits
      .slice(0, options.limit ?? 12)
      .map((row) => {
        const flags = [
          row.kind,
          row.effectiveStatus ? `状态 ${row.effectiveStatus}` : '',
          row.owner ? `负责 ${row.owner}` : '',
          (row.refs ?? []).length > 0 ? `出处 ${(row.refs ?? []).slice(0, 2).join(' ')}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        const when = row.at.slice(5, 16).replace('T', ' ');
        const body = row.body ? `\n    ${row.body.replace(/\n/g, '\n    ').slice(0, 400)}` : '';
        return `[${row.id}] ${when} ${row.title}（${flags}）${body}`;
      })
      .join('\n');
  }

  /**
   * 对话前的简报：未完成的任务、最近决策、卡住的点。
   *
   * 只挑该说的，不把整个记录本倒进上下文 —— 提示词前缀要稳定，[简报] 放 system 里
   * 每轮都会变，所以这里只在工程群里注入，并且限量。
   */
  async brief(options: { tasks?: number; decisions?: number; risks?: number } = {}): Promise<string> {
    const rows = await this.resolved();
    if (rows.length === 0) {
      return '';
    }
    const openTasks = rows.filter(
      (row) => row.kind === 'task' && ['todo', 'doing', 'blocked'].includes(row.effectiveStatus ?? 'todo'),
    );
    const decisions = rows.filter((row) => row.kind === 'decision');
    const risks = rows.filter((row) => row.kind === 'risk' && row.effectiveStatus !== 'done' && row.effectiveStatus !== 'dropped');
    const milestones = rows.filter((row) => row.kind === 'milestone');

    const fmt = (row: RecordEntry & { effectiveStatus?: RecordStatus }, withStatus: boolean): string => {
      const when = row.at.slice(5, 10);
      const status = withStatus && row.effectiveStatus ? ` [${row.effectiveStatus}]` : '';
      const owner = row.owner ? ` @${row.owner}` : '';
      const id = `#${row.id.slice(-4)}`;
      return `- ${when} ${row.title}${status}${owner} ${id}`;
    };

    const blocks: string[] = [];
    if (openTasks.length > 0) {
      blocks.push(
        `未完成任务：\n${openTasks.slice(0, options.tasks ?? 6).map((row) => fmt(row, true)).join('\n')}`,
      );
    }
    if (decisions.length > 0) {
      blocks.push(
        `最近决策：\n${decisions.slice(0, options.decisions ?? 4).map((row) => fmt(row, false)).join('\n')}`,
      );
    }
    if (risks.length > 0) {
      blocks.push(`未解决风险：\n${risks.slice(0, options.risks ?? 3).map((row) => fmt(row, true)).join('\n')}`);
    }
    if (milestones.length > 0) {
      blocks.push(`最近里程碑：\n${milestones.slice(0, 2).map((row) => fmt(row, false)).join('\n')}`);
    }
    return blocks.join('\n\n');
  }

  /** 记一条：给模型用的入口，参数容错，别因为少字段就整条丢。 */
  async note(input: {
    kind: string;
    title: string;
    body?: string;
    status?: string;
    owner?: string;
    tags?: string[];
    refs?: string[];
    by?: string;
  }): Promise<string> {
    const title = input.title.trim();
    if (!title) {
      return '需要提供 title。';
    }
    if (!isKind(input.kind)) {
      return `kind 只能是 ${KINDS.join(' / ')}；任务用 task，定下来的事用 decision。`;
    }
    const status = isStatus(input.status) ? input.status : input.kind === 'task' ? 'todo' : undefined;
    const record = await this.append({
      kind: input.kind,
      title: title.slice(0, 160),
      body: input.body?.trim() || undefined,
      status,
      owner: input.owner?.trim() || undefined,
      tags: input.tags?.filter(Boolean).slice(0, 6),
      refs: input.refs?.filter(Boolean).slice(0, 6),
      by: input.by,
    });
    return `已记录 #${record.id.slice(-4)}（${record.kind}${status ? ` · ${status}` : ''}）：${record.title}`;
  }

  /** 改状态：追加一条 status，不改历史。 */
  async setStatus(id: string, status: string, by?: string): Promise<string> {
    if (!isStatus(status)) {
      return `status 只能是 ${STATUSES.join(' / ')}。`;
    }
    const rows = await this.resolved();
    const target = rows.find((row) => row.id === id || row.id.endsWith(id));
    if (!target) {
      return `找不到条目 ${id}，先用 memory_query 看编号。`;
    }
    await this.append({ kind: 'status', title: `状态 → ${status}`, status, ref: target.id, by });
    return `#${target.id.slice(-4)} 状态改为 ${status}：${target.title}`;
  }
}
