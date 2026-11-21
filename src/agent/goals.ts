/**
 * 持续目标（sustained goal）：把「一个长活」写成 JSON，每轮只推进一片。
 *
 * 依据两条实践：
 *   1. Anthropic《Effective harnesses for long-running agents》：长任务要拆成可判定的
 *      feature 列表（用 JSON 而不是 Markdown，模型不容易乱改），每轮只做一片，
 *      进度必须落盘并 commit，离开时环境要干净。
 *   2. nanobot 的 `/goal` 口径：目标由人显式发起、正文不超过 4000 字、
 *      带明确的完成判据，并且有轮数预算 —— 没有预算的自动续跑就是烧钱。
 *
 * 落地：data/goals/<群>.json，一个群同时只允许一个 active 目标。
 * 代码只管记账与预算，怎么推进由模型决定；能不能自动续跑由 index.ts 的闸门决定。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isGoalKind, kindPack, type GoalKind } from './kinds.js';

export const SLICE_STATUSES = ['todo', 'doing', 'review', 'done', 'blocked', 'dropped'] as const;
export type SliceStatus = (typeof SLICE_STATUSES)[number];

export const GOAL_STATUSES = ['active', 'paused', 'done', 'blocked', 'cancelled'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const MAX_OBJECTIVE_CHARS = 4000;
export const MAX_SLICES = 12;
export const MAX_CRITERIA = 10;

export interface GoalSlice {
  id: string;
  title: string;
  status: SliceStatus;
  note?: string;
  /** 出处：issue 号、PR 链接、commit。 */
  ref?: string;
}

export interface GoalLogEntry {
  at: string;
  text: string;
  by?: string;
}

export interface GoalBudget {
  /** 已经自动续跑了几轮。 */
  rounds: number;
  /** 一段预算内的轮数上限：到点不是停，而是看有没有进展（见 renew）。 */
  maxRounds: number;
  /** 这一段预算的起始时间，用来算墙钟。 */
  startedAt: string;
  maxWallMs: number;
  lastTickAt?: string;
  /** 距离上一次切片状态变化跑了几轮：0 = 刚有进展，>0 = 在空转。 */
  roundsSinceProgress?: number;
  /** 续命次数（预算到点但有进展时自动续），只用于观测。 */
  renews?: number;
  lastProgressAt?: string;
}

export interface Goal {
  id: string;
  objective: string;
  /** 活儿的类型：决定提示词与能力包（code / research / ops / review）。 */
  kind?: GoalKind;
  criteria: string[];
  slices: GoalSlice[];
  status: GoalStatus;
  /** 谁起的头（openid 或昵称）。 */
  by?: string;
  createdAt: string;
  updatedAt: string;
  recap?: string;
  /**
   * 正在等 NPC 干活：记下 issue 号与当时的状态指纹。
   * 调度器先拿探针比对指纹，没变就不开模型回合（省额度），变了才叫醒。
   */
  awaiting?: { issue: number; sig: string; note?: string; since: string };
  budget: GoalBudget;
  log: GoalLogEntry[];
}

export function isSliceStatus(value: unknown): value is SliceStatus {
  return typeof value === 'string' && (SLICE_STATUSES as readonly string[]).includes(value);
}

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === 'string' && (GOAL_STATUSES as readonly string[]).includes(value);
}

/** 探针已经挂了多久（毫秒）：没在等就是 0。 */
export function watchIdleMs(awaiting: Goal['awaiting'], now = Date.now()): number {
  if (!awaiting) {
    return 0;
  }
  const since = Date.parse(awaiting.since);
  return Number.isFinite(since) ? Math.max(0, now - since) : 0;
}

/**
 * 等太久该自查了吗。
 *
 * 2026-11-21 实测：它用裸 `cnb issues comment` 发了「复核不通过，请在这分支补…」，
 * 没带 @CodeBuddy + work_mode，NPC 压根不会下场；探针只看指纹，于是两条 issue 干等 2 小时半。
 * 所以等够 idleMs 必须自己醒一次，去核实「对方到底有没有被叫醒」。
 */
export function shouldSelfCheck(
  awaiting: Goal['awaiting'],
  idleMs: number,
  now = Date.now(),
): boolean {
  if (!awaiting || idleMs <= 0) {
    return false;
  }
  return watchIdleMs(awaiting, now) >= idleMs;
}

/** 下一片该做的：先 todo，再看 doing / review（有活干就别开新的）。 */
export function nextSlice(goal: Goal): GoalSlice | undefined {
  return (
    goal.slices.find((slice) => slice.status === 'doing') ??
    goal.slices.find((slice) => slice.status === 'review') ??
    goal.slices.find((slice) => slice.status === 'todo')
  );
}

export function goalProgress(goal: Goal): string {
  const total = goal.slices.length;
  const done = goal.slices.filter((slice) => slice.status === 'done' || slice.status === 'dropped').length;
  return `${done}/${total}`;
}

/** 还能不能自动续跑：状态、轮数、墙钟三道闸门。 */
export function canContinue(
  goal: Goal,
  options: { now?: number; maxRounds?: number; maxWallMs?: number } = {},
): { ok: boolean; reason?: string } {
  if (goal.status !== 'active') {
    return { ok: false, reason: `目标状态是 ${goal.status}` };
  }
  const maxRounds = options.maxRounds ?? goal.budget.maxRounds;
  // 0 = 不限轮数，只剩墙钟闸门（长任务跟进想要它一直跑）
  if (maxRounds > 0 && goal.budget.rounds >= maxRounds) {
    return { ok: false, reason: `自动续跑用满 ${maxRounds} 轮` };
  }
  const now = options.now ?? Date.now();
  const maxWallMs = options.maxWallMs ?? goal.budget.maxWallMs;
  const started = Date.parse(goal.budget.startedAt);
  if (Number.isFinite(started) && now - started > maxWallMs) {
    return { ok: false, reason: `超出墙钟预算（${Math.round(maxWallMs / 60000)} 分钟）` };
  }
  if (!nextSlice(goal)) {
    // 挂着探针 = 在等外部交货：探针只读两个接口，不烧回合，别把它当「没活干」停掉
    if (goal.awaiting) {
      return { ok: true };
    }
    return { ok: false, reason: '没有待推进的切片' };
  }
  return { ok: true };
}

function nowIso(): string {
  return new Date().toISOString();
}

function newGoalId(at: Date): string {
  return `g${at.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function safeGroup(groupId: string): string {
  return groupId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
}

function asSliceList(raw: unknown): GoalSlice[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: GoalSlice[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ id: `s${out.length + 1}`, title: clip(item, 120), status: 'todo' });
      continue;
    }
    if (!item || typeof item !== 'object') {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? clip(obj.title, 160) : '';
    if (!title) {
      continue;
    }
    out.push({
      id: typeof obj.id === 'string' && obj.id ? obj.id : `s${out.length + 1}`,
      title,
      status: isSliceStatus(obj.status) ? obj.status : 'todo',
      ...(typeof obj.note === 'string' ? { note: clip(obj.note, 400) } : {}),
      ...(typeof obj.ref === 'string' ? { ref: clip(obj.ref, 300) } : {}),
    });
  }
  return out.slice(0, MAX_SLICES);
}

export interface GoalCreateInput {
  objective: string;
  criteria: string[];
  slices: Array<string | { title: string; id?: string }>;
  kind?: GoalKind;
  by?: string;
  maxRounds?: number;
  maxWallMs?: number;
}

export class GoalStore {
  readonly file: string;
  readonly groupId: string;

  constructor(dataRoot: string, groupId: string) {
    this.groupId = safeGroup(groupId);
    this.file = path.join(dataRoot, 'goals', `${this.groupId}.json`);
  }

  async read(): Promise<Goal | undefined> {
    if (!existsSync(this.file)) {
      return undefined;
    }
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Goal;
      if (!raw || typeof raw.objective !== 'string' || !Array.isArray(raw.slices)) {
        return undefined;
      }
      return raw;
    } catch {
      return undefined;
    }
  }

  private async save(goal: Goal): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(goal, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
  }

  async create(input: GoalCreateInput, defaults: { maxRounds: number; maxWallMs: number }): Promise<string> {
    const objective = clip(input.objective ?? '', MAX_OBJECTIVE_CHARS);
    if (!objective) {
      return '目标正文不能为空：一句话说清要交付什么。';
    }
    const existing = await this.read();
    if (existing && existing.status === 'active') {
      return `已经有一个进行中的目标（${existing.objective.slice(0, 40)}…，进度 ${goalProgress(existing)}）。要么 goal_step 推进它，要么 goal_finish / goal_block 收尾后再开新的。`;
    }
    const criteria = input.criteria.map((item) => clip(item, 300)).filter(Boolean).slice(0, MAX_CRITERIA);
    if (criteria.length === 0) {
      return '至少要有一条可判定的完成判据（测试全绿 / PR 合并 / 页面能打开），写不出判据就说明还没想清楚。';
    }
    const slices = asSliceList(input.slices);
    if (slices.length === 0) {
      return '至少切成一片；建议 3–5 片，一片一个 PR。';
    }
    const at = new Date();
    const goal: Goal = {
      id: newGoalId(at),
      objective,
      ...(isGoalKind(input.kind) ? { kind: input.kind } : {}),
      criteria,
      slices,
      status: 'active',
      ...(input.by ? { by: input.by } : {}),
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      budget: {
        rounds: 0,
        maxRounds: input.maxRounds ?? defaults.maxRounds,
        startedAt: at.toISOString(),
        maxWallMs: input.maxWallMs ?? defaults.maxWallMs,
      },
      log: [{ at: at.toISOString(), text: `目标建立：${slices.length} 片`, ...(input.by ? { by: input.by } : {}) }],
    };
    await this.save(goal);
    return renderGoal(goal);
  }

  /** 按 id / 序号 / 标题片段找切片；找不到返回 undefined。 */
  sliceByKey(key: string): Promise<GoalSlice | undefined> {
    return this.read().then((goal) => (goal ? this.resolveSlice(goal, key) : undefined));
  }

  /** 复核结果落盘：data/reviews/<群>/<切片>-<时间>.json，只追加不改历史。 */
  async saveReview(sliceId: string, review: { pass: boolean; note: string; model?: string }): Promise<string> {
    const dir = path.join(path.dirname(path.dirname(this.file)), 'reviews', safeGroup(this.groupId));
    const at = nowIso();
    const file = path.join(dir, `${sliceId}-${at.replace(/[:.]/g, '-')}.json`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, `${JSON.stringify({ at, slice: sliceId, ...review }, null, 2)}\n`, 'utf8');
    return file;
  }

  /** 按 id / 序号 / 标题片段找切片；找不到返回 undefined。 */
  private resolveSlice(goal: Goal, key: string): GoalSlice | undefined {
    const wanted = key.trim();
    if (!wanted) {
      return nextSlice(goal);
    }
    const byId = goal.slices.find((slice) => slice.id === wanted);
    if (byId) {
      return byId;
    }
    const index = Number.parseInt(wanted, 10);
    if (Number.isInteger(index) && index >= 1 && index <= goal.slices.length) {
      return goal.slices[index - 1];
    }
    return goal.slices.find((slice) => slice.title.includes(wanted));
  }

  async step(
    key: string,
    status: SliceStatus,
    options: { note?: string; ref?: string; by?: string } = {},
  ): Promise<string> {
    const goal = await this.read();
    if (!goal) {
      return '这个群还没有目标；先用 goal_create 立一个。';
    }
    const slice = this.resolveSlice(goal, key);
    if (!slice) {
      return `找不到切片「${key}」：可用 ${goal.slices.map((s) => `${s.id}=${s.title}`).join(' / ')}`;
    }
    slice.status = status;
    if (options.note) {
      slice.note = clip(options.note, 400);
    }
    if (options.ref) {
      slice.ref = clip(options.ref, 300);
    }
    goal.updatedAt = nowIso();
    // 切片真变了才算进展：续跑闸门看的是这个，不是轮数
    if (goal.budget) {
      goal.budget.roundsSinceProgress = 0;
      goal.budget.lastProgressAt = goal.updatedAt;
    }
    const line = `${slice.id} ${slice.title} → ${status}${options.ref ? `（${options.ref}）` : ''}`;
    goal.log.push({ at: goal.updatedAt, text: line, ...(options.by ? { by: options.by } : {}) });
    goal.log = goal.log.slice(-80);
    await this.save(goal);
    return `${line}\n${renderGoal(goal)}`;
  }

  /** 记下「在等这个 issue」：调度器从此只做廉价探针，不烧回合。 */
  async watch(issue: number, sig: string, note?: string): Promise<string> {
    const goal = await this.read();
    if (!goal) {
      return '这个群还没有目标。';
    }
    if (goal.status !== 'active') {
      // 探针只叫醒 active 目标。挂在 done / paused 上 = 静默停摆（2026-11-20 踩过：
      // 目标已经 goal_finish，又挂了 #25 的探针，之后再没人叫醒它）
      return (
        `目标 ${goal.id} 状态是 ${goal.status}，挂探针不会叫醒你 —— 自动续跑只跑 active 目标。` +
        '要跟进的是新活，就先 goal_create 立新目标（判据 + 3~5 片）再挂探针；' +
        '要继续这一条就 /goal resume。'
      );
    }
    goal.awaiting = { issue, sig, since: nowIso(), ...(note ? { note: clip(note, 300) } : {}) };
    goal.updatedAt = nowIso();
    goal.log.push({ at: goal.updatedAt, text: `等 #${issue} 的 NPC 交货${note ? `：${clip(note, 160)}` : ''}` });
    goal.log = goal.log.slice(-80);
    await this.save(goal);
    return `已挂上探针：#${issue}。NPC 那边一有变化（新评论 / 开 PR / 关 issue）就叫醒我继续，期间不烧回合。`;
  }

  /** 等到了（或不等了）：清掉探针。 */
  async clearWatch(reason?: string): Promise<void> {
    const goal = await this.read();
    if (!goal || !goal.awaiting) {
      return;
    }
    const issue = goal.awaiting.issue;
    delete goal.awaiting;
    goal.updatedAt = nowIso();
    goal.log.push({ at: goal.updatedAt, text: `#${issue} 等到了${reason ? `：${clip(reason, 160)}` : ''}` });
    goal.log = goal.log.slice(-80);
    await this.save(goal);
  }

  async note(text: string, by?: string): Promise<string> {    const goal = await this.read();
    if (!goal) {
      return '这个群还没有目标。';
    }
    const body = clip(text, 600);
    if (!body) {
      return '要记的内容是空的。';
    }
    goal.log.push({ at: nowIso(), text: body, ...(by ? { by } : {}) });
    goal.log = goal.log.slice(-80);
    goal.updatedAt = nowIso();
    await this.save(goal);
    return `已记录到目标日志：${body}`;
  }

  async finish(recap: string, by?: string): Promise<string> {
    const goal = await this.read();
    if (!goal) {
      return '这个群还没有目标。';
    }
    const remaining = goal.slices.filter((slice) => slice.status !== 'done' && slice.status !== 'dropped');
    goal.status = 'done';
    goal.recap = clip(recap, 800);
    // 收尾就把探针拆了：done 的目标不会再被续跑叫醒，留着只会变成「静默停摆」
    const watched = goal.awaiting?.issue;
    delete goal.awaiting;
    goal.updatedAt = nowIso();
    goal.log.push({ at: goal.updatedAt, text: `收尾：${goal.recap}`, ...(by ? { by } : {}) });
    await this.save(goal);
    const warn =
      remaining.length > 0
        ? `\n注意：还有 ${remaining.length} 片没标完成（${remaining.map((s) => s.id).join('/')}）—— 别把没验过的当完成了。`
        : '';
    const dropped = watched ? `\n顺手拆了 #${watched} 的探针（目标已收尾，不会再叫醒）。` : '';
    return `目标已收尾。${goal.recap}${warn}${dropped}`;
  }

  async block(reason: string, by?: string): Promise<string> {
    const goal = await this.read();
    if (!goal) {
      return '这个群还没有目标。';
    }
    const body = clip(reason, 400);
    goal.status = 'blocked';
    goal.updatedAt = nowIso();
    goal.log.push({ at: goal.updatedAt, text: `卡住：${body}`, ...(by ? { by } : {}) });
    await this.save(goal);
    return `目标标记为卡住：${body}。自动续跑已停，等人接手。`;
  }

  async cancel(reason: string): Promise<string> {
    const goal = await this.read();
    if (!goal) {
      return '这个群还没有目标。';
    }
    goal.status = 'cancelled';
    goal.updatedAt = nowIso();
    goal.log.push({ at: goal.updatedAt, text: `取消：${clip(reason, 200)}` });
    await this.save(goal);
    return '目标已取消，自动续跑停止。';
  }

  /** 预算到点但有进展：开新的一段，而不是停下等人。 */
  async renew(reason: string): Promise<number> {
    const goal = await this.read();
    if (!goal) {
      return 0;
    }
    goal.budget.rounds = 0;
    goal.budget.startedAt = nowIso();
    goal.budget.renews = (goal.budget.renews ?? 0) + 1;
    goal.updatedAt = goal.budget.startedAt;
    goal.log.push({ at: goal.updatedAt, text: `续命（第 ${goal.budget.renews} 次）：${clip(reason, 200)}` });
    goal.log = goal.log.slice(-80);
    await this.save(goal);
    return goal.budget.renews;
  }

  /** 预算用尽：转 paused。只改状态，说不说由调用方决定；/goal resume 可续。 */
  async pause(reason: string): Promise<boolean> {
    const goal = await this.read();
    if (!goal || goal.status !== 'active') {
      return false;
    }
    goal.status = 'paused';
    goal.updatedAt = nowIso();
    goal.log.push({ at: goal.updatedAt, text: `自动续跑暂停：${clip(reason, 200)}` });
    goal.log = goal.log.slice(-80);
    await this.save(goal);
    return true;
  }

  async resume(): Promise<string> {
    const goal = await this.read();
    if (!goal) {
      return '这个群还没有目标。';
    }
    if (goal.status === 'done') {
      return '这个目标已经收尾了；要接着做就开新目标。';
    }
    goal.status = 'active';
    goal.budget.startedAt = nowIso();
    goal.budget.rounds = 0;
    goal.updatedAt = nowIso();
    goal.log.push({ at: goal.updatedAt, text: '恢复推进（预算重置）' });
    await this.save(goal);
    return '已恢复，预算重置。';
  }

  /** 记一轮自动续跑，并回报是否还允许继续。 */
  async tick(options: { maxRounds: number; maxWallMs: number }): Promise<{ goal: Goal; ok: boolean; reason?: string } | undefined> {
    const goal = await this.read();
    if (!goal) {
      return undefined;
    }
    const verdict = canContinue(goal, { maxRounds: options.maxRounds, maxWallMs: options.maxWallMs });
    if (!verdict.ok) {
      return { goal, ok: false, reason: verdict.reason };
    }
    goal.budget.rounds += 1;
    goal.budget.roundsSinceProgress = (goal.budget.roundsSinceProgress ?? 0) + 1;
    goal.budget.lastTickAt = nowIso();
    goal.updatedAt = goal.budget.lastTickAt;
    goal.log.push({ at: goal.updatedAt, text: `自动续跑第 ${goal.budget.rounds} 轮` });
    goal.log = goal.log.slice(-80);
    await this.save(goal);
    return { goal, ok: true };
  }
}

/** 在等 NPC 的一句话：带已等时长，超过阈值就明说会自查。 */
export function describeAwaiting(goal: Goal, now = Date.now()): string | undefined {
  if (!goal.awaiting) {
    return undefined;
  }
  const minutes = Math.floor(watchIdleMs(goal.awaiting, now) / 60000);
  const waited = minutes >= 1 ? `已等 ${minutes} 分钟` : '刚挂上';
  return `在等 #${goal.awaiting.issue}（${waited}）：NPC 那边一动就叫醒，别自己轮询。`;
}

/** 给工具返回的完整视图。 */
export function renderGoal(goal: Goal): string {
  const next = nextSlice(goal);
  const waiting = describeAwaiting(goal);
  const slices = goal.slices
    .map((slice) => {
      const flags = [
        slice.status,
        slice.ref ? `出处 ${slice.ref}` : '',
        slice.note ? slice.note : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const arrow = next && slice.id === next.id ? '▶ ' : '  ';
      return `${arrow}${slice.id} ${slice.title}（${flags}）`;
    })
    .join('\n');
  return [
    `目标 ${goal.id} · 类型 ${kindPack(goal.kind).label} · 状态 ${goal.status} · 进度 ${goalProgress(goal)} · 自动续跑 ${
      goal.budget.maxRounds > 0 ? `${goal.budget.rounds}/${goal.budget.maxRounds}` : `${goal.budget.rounds}（不限轮数）`
    }`,
    goal.objective,
    `完成判据：\n${goal.criteria.map((item) => `- ${item}`).join('\n')}`,
    `切片：\n${slices}`,
    ...(waiting ? [waiting] : []),
    next ? `下一片：${next.id} ${next.title}` : '没有待推进的切片 —— 要么收尾（goal_finish），要么说清卡在哪（goal_block）。',
  ].join('\n');
}

/** 塞进 system 的简报：只留该说的，别把整份日志倒进上下文。 */
export function goalBrief(goal: Goal): string {
  const next = nextSlice(goal);
  const lines = [
    `目标（${kindPack(goal.kind).label}）：${goal.objective.slice(0, 200)}`,
    `状态 ${goal.status} · 进度 ${goalProgress(goal)} · 自动续跑 ${
      goal.budget.maxRounds > 0 ? `${goal.budget.rounds}/${goal.budget.maxRounds}` : `${goal.budget.rounds}（不限轮数）`
    }`,
  ];
  if (next) {
    lines.push(`下一片：${next.id} ${next.title}`);
  } else {
    lines.push('切片都处理完了：该 goal_finish 收尾，或 goal_block 说明卡点。');
  }
  if (goal.awaiting) {
    lines.push(describeAwaiting(goal) ?? `在等 #${goal.awaiting.issue}`);
  }
  const recent = goal.log.slice(-3).map((entry) => `- ${entry.at.slice(5, 16).replace('T', ' ')} ${entry.text}`);
  if (recent.length > 0) {
    lines.push(`最近动作：\n${recent.join('\n')}`);
  }
  return lines.join('\n');
}
