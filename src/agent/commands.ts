/**
 * 指令（命令面板里点一下就发的那种）。
 *
 * 指令不走模型：立刻回、不花钱，也不会占用被动回复次数之外的额度。
 * 目前只有一个 /status —— 让她能自己报当前对话状况。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readRecords, summarize } from './telemetry.js';

export type CommandName = 'status';

/** 识别指令；不认识的 / 开头消息仍然当别人的命令忽略。 */
export function matchCommand(text: string): CommandName | undefined {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  // 面板里的 name 会被 QQ 规范成不带斜杠的 "status"，点击后可能原样发出来
  if (
    normalized === '/status' ||
    normalized === 'status' ||
    normalized === '/kei status' ||
    normalized === '/状态'
  ) {
    return 'status';
  }
  return undefined;
}

export interface StatusInput {
  chatId: string;
  dataRoot: string;
  /** 当前缓冲里攒了多少条 */
  bufferLines: number;
  bufferLimit: number;
  model: string;
  contextWindow: number;
  /** 进程启动时间戳 */
  startedAt: number;
}

function fmtNum(value: number): string {
  return value.toLocaleString('en-US');
}

function fmtMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function fmtDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return `${days}天${hours % 24}小时`;
  }
  if (hours > 0) {
    return `${hours}小时${minutes % 60}分`;
  }
  return `${minutes}分`;
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '—';
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function countMessages(
  dataRoot: string,
  chatId: string,
): Promise<{ total: number; today: number }> {
  // 群聊落盘在 chats/group/<群>/messages.jsonl；私聊退化为 0
  const file = path.join(dataRoot, 'chats', 'group', chatId, 'messages.jsonl');
  if (!existsSync(file)) {
    return { total: 0, today: 0 };
  }
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  // 本地时区的“今天”，跟群友感知一致
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let today = 0;
  for (const line of lines) {
    const match = /"timestamp":"([^"]+)"/.exec(line);
    if (match?.[1]?.startsWith(todayKey)) {
      today += 1;
    }
  }
  return { total: lines.length, today };
}

/** 渲染 /status 的正文。 */
export async function renderStatus(input: StatusInput): Promise<string> {
  const messages = await countMessages(input.dataRoot, input.chatId);
  const calls = (await readRecords(path.join(input.dataRoot, 'calls'), 7)).filter(
    (record) => record.conversationId === input.chatId,
  );
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayCalls = calls.filter((record) => record.at.slice(0, 10) === todayKey);
  const all = summarize(calls);
  const today = summarize(todayCalls);
  const last = calls[calls.length - 1];

  // 归档情况
  const digestDir = path.join(input.dataRoot, 'memory', input.chatId, 'digest');
  let topics = 0;
  let lastDigest = '—';
  const topicsFile = path.join(digestDir, 'topics.json');
  if (existsSync(topicsFile)) {
    try {
      topics = (JSON.parse(await readFile(topicsFile, 'utf8')) as unknown[]).length;
    } catch {
      topics = 0;
    }
  }
  const recordsFile = path.join(digestDir, 'records.jsonl');
  if (existsSync(recordsFile)) {
    const rows = (await readFile(recordsFile, 'utf8')).split('\n').filter(Boolean);
    const lastLine = rows[rows.length - 1];
    if (lastLine) {
      try {
        const parsed = JSON.parse(lastLine) as { to?: string };
        lastDigest = fmtDay(parsed.to ?? '');
      } catch {
        // 坏行忽略
      }
    }
  }

  const contextLine = last
    ? `上轮 prompt ${fmtNum(last.promptTokens)} tok · 占用 ${(last.contextRate * 100).toFixed(1)}%`
    : '还没调过模型';
  const cacheRate = all.promptTokens > 0 ? all.cachedTokens / all.promptTokens : 0;

  return [
    'Kei 在跑呢，报个数：',
    `模型 ${input.model}`,
    `本群消息 ${fmtNum(messages.total)} 条（今天 +${fmtNum(messages.today)}）`,
    `上下文 缓冲 ${input.bufferLines}/${input.bufferLimit} 条 · ${contextLine}`,
    `调用 ${fmtNum(all.calls)} 次（今天 ${todayCalls.length} 次）· token ${fmtNum(all.totalTokens)}`,
    `缓存命中 ${(cacheRate * 100).toFixed(1)}% · 平均 ${fmtMs(all.avgMs)} · p95 ${fmtMs(all.p95Ms)}`,
    `话题 ${topics} 个 · 最近归档 ${lastDigest}`,
    `已连续运行 ${fmtDuration(Date.now() - input.startedAt)}`,
  ].join('\n');
}
