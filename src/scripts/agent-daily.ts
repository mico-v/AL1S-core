/**
 * 每日体检：把「运行情况 / 缓存命中 / 消耗 / 回复样本」整理成一份可判断的摘要。
 *
 * 定时任务调用（`pnpm -s agent:daily`），输出是给人看 + 给模型判断用的，
 * 不做任何自动修改 —— 策略由上层分析后决定。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readRecords, summarize, type CallRecord } from '../agent/telemetry.js';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const DAY = 86_400_000;
const since = Date.now() - DAY;

interface Line {
  timestamp?: string;
  senderIsBot?: boolean;
  senderName?: string;
  content?: string;
  groupOpenid?: string;
}

function fmtMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function readChatLines(): Promise<Line[]> {
  const dir = path.join(DATA, 'chats', 'group');
  if (!existsSync(dir)) {
    return [];
  }
  const { readdir } = await import('node:fs/promises');
  const groups = await readdir(dir);
  const out: Line[] = [];
  for (const group of groups) {
    const file = path.join(dir, group, 'messages.jsonl');
    if (!existsSync(file)) {
      continue;
    }
    for (const raw of (await readFile(file, 'utf8')).split('\n')) {
      if (!raw.trim()) {
        continue;
      }
      try {
        const rec = JSON.parse(raw) as Line;
        const at = rec.timestamp ? Date.parse(rec.timestamp) : 0;
        if (at >= since) {
          out.push(rec);
        }
      } catch {
        // 坏行跳过
      }
    }
  }
  return out.sort((a, b) => (Date.parse(a.timestamp ?? '') || 0) - (Date.parse(b.timestamp ?? '') || 0));
}

interface ReplyLine {
  at: string;
  speaker: string;
  text: string;
  chars?: number;
  chunks: number;
  silent?: boolean;
  ms?: number;
}

async function readReplies(): Promise<ReplyLine[]> {
  const dir = path.join(DATA, 'replies');
  if (!existsSync(dir)) {
    return [];
  }
  const { readdir } = await import('node:fs/promises');
  const out: ReplyLine[] = [];
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.jsonl')) {
      continue;
    }
    for (const raw of (await readFile(path.join(dir, file), 'utf8')).split('\n')) {
      if (!raw.trim()) {
        continue;
      }
      try {
        const rec = JSON.parse(raw) as ReplyLine;
        if (Date.parse(rec.at) >= since) {
          out.push(rec);
        }
      } catch {
        // 坏行跳过
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

function byPurpose(records: CallRecord[]): Array<[string, CallRecord[]]> {
  const map = new Map<string, CallRecord[]>();
  for (const rec of records) {
    const key = rec.purpose ?? 'unknown';
    map.set(key, [...(map.get(key) ?? []), rec]);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

async function main(): Promise<void> {
  const records = (await readRecords(path.join(DATA, 'calls'), 1)).filter(
    (r) => Date.parse(r.at) >= since,
  );
  const lines = await readChatLines();
  const human = lines.filter((l) => !l.senderIsBot);
  // chat-log 里没有 bot 自己的话（平台不回投），回复样本读 data/replies
  const botLines = await readReplies();

  console.log(`# Kei 每日体检 · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  console.log(
    `窗口：最近 24 小时 · 群消息 ${lines.length} 条（真人 ${human.length} / Kei ${botLines.length}）`,
  );

  if (records.length === 0) {
    console.log('\n没有任何模型调用记录。');
  } else {
    const total = summarize(records);
    console.log(
      `\n## 总览\n调用 ${total.calls} 次（失败 ${total.failedCalls}）· ` +
        `prompt ${total.promptTokens.toLocaleString()} / completion ${total.completionTokens.toLocaleString()} token · ` +
        `缓存 ${pct(total.cacheRate)} · p50 ${fmtMs(total.p50Ms)} / p95 ${fmtMs(total.p95Ms)}`,
    );

    console.log('\n## 按用途');
    for (const [purpose, list] of byPurpose(records)) {
      const s = summarize(list);
      console.log(
        `- ${purpose.padEnd(9)} ${String(s.calls).padStart(4)} 次  失败 ${s.failedCalls}  ·  ` +
          `缓存 ${pct(s.cacheRate).padStart(6)}  ·  平均 ${fmtMs(s.avgMs)}  ·  ` +
          `p50 ${fmtMs(s.p50Ms)} / p95 ${fmtMs(s.p95Ms)}  ·  ` +
          `token ${(s.promptTokens + s.completionTokens).toLocaleString()}`,
      );
    }

    const chat = records.filter((r) => r.purpose === 'chat');
    if (chat.length > 0) {
      const cs = summarize(chat);
      const avgPrompt = Math.round(cs.promptTokens / Math.max(1, cs.calls));
      console.log(
        `\n## 对话质量相关的硬指标\n` +
          `单次上下文 ${avgPrompt.toLocaleString()} token · 缓存 ${pct(cs.cacheRate)} · ` +
          `平均 ${fmtMs(cs.avgMs)} · 失败 ${cs.failedCalls}`,
      );
    }

    const failures = records.filter((r) => !r.ok);
    if (failures.length > 0) {
      const kinds = new Map<string, number>();
      for (const f of failures) {
        const key = `${f.purpose}: ${(f.error ?? '未知').slice(0, 60)}`;
        kinds.set(key, (kinds.get(key) ?? 0) + 1);
      }
      console.log('\n## 失败分布');
      for (const [key, count] of [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
        console.log(`- ${count}× ${key}`);
      }
    }

    const slow = [...records].sort((a, b) => b.ms - a.ms).slice(0, 3);
    console.log('\n## 最慢 3 次');
    for (const s of slow) {
      console.log(
        `- ${fmtMs(s.ms)} ${s.purpose} · prompt ${s.promptTokens} · ${s.ok ? 'ok' : (s.error ?? '失败').slice(0, 40)}`,
      );
    }
  }

  console.log('\n## 最近回复样本（用于判断质量，不含 @ 前缀）');
  const samples = botLines.filter((r) => !r.silent && r.text).slice(-8);
  if (samples.length === 0) {
    console.log('（这段时间 Kei 没说话）');
  }
  for (const s of samples) {
    const at = s.at.slice(11, 16);
    const text = s.text.replace(/\s+/g, ' ').slice(0, 160);
    console.log(`- [${at}] → ${s.speaker}：${text}`);
  }

  const hours = new Set(human.map((l) => (l.timestamp ?? '').slice(0, 13))).size;
  const spoke = botLines.filter((r) => !r.silent && r.text);
  const silent = botLines.filter((r) => r.silent);
  const avgMs = spoke.length > 0 ? Math.round(spoke.reduce((a, r) => a + (r.ms ?? 0), 0) / spoke.length) : 0;
  const avgChars = spoke.length > 0 ? Math.round(spoke.reduce((a, r) => a + (r.chars ?? r.text.length), 0) / spoke.length) : 0;
  const answered = spoke.length + silent.length;
  console.log(
    `\n## 活跃度\n真人发言覆盖 ${hours} 个小时段 · 被叫 ${answered} 次 ` +
      `（开口 ${spoke.length} · 选择沉默 ${silent.length}）`,
  );
  if (spoke.length > 0) {
    console.log(`开口时平均 ${avgChars} 字 · 平均耗时 ${fmtMs(avgMs)}`);
  }
}

void main();
