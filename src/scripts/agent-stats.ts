/**
 * 看 AI 调用账本。
 *
 *   pnpm agent:stats             # 最近 1 天
 *   pnpm agent:stats --days 7
 *   pnpm agent:stats --json      # 原始聚合，给脚本用
 */

import { readAgentConfig } from '../agent/index.js';
import { readRecords, summarize, type CallRecord } from '../agent/telemetry.js';

const argv = process.argv.slice(2);
const daysIndex = argv.indexOf('--days');
const days = daysIndex >= 0 ? Number(argv[daysIndex + 1]) : 1;
const asJson = argv.includes('--json');

const config = readAgentConfig(process.env);
const dir = config.callLog.dir;

const records = await readRecords(dir, Number.isFinite(days) ? days : 1);

if (asJson) {
  console.log(JSON.stringify({ days, dir, summary: summarize(records), calls: records.length }, null, 2));
  process.exit(0);
}

if (records.length === 0) {
  console.log(`最近 ${days} 天没有调用记录（目录：${dir}）`);
  process.exit(0);
}

const summary = summarize(records);
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const num = (value: number): string => value.toLocaleString('en-US');

console.log(`最近 ${days} 天 · ${dir}`);
console.log('');
console.log(`调用 ${num(summary.calls)} 次   成功 ${num(summary.okCalls)}   失败 ${num(summary.failedCalls)}`);
console.log(
  `token  prompt ${num(summary.promptTokens)}   completion ${num(summary.completionTokens)}   ` +
    `cached ${num(summary.cachedTokens)}   reasoning ${num(summary.reasoningTokens)}`,
);
console.log(
  `缓存命中 ${pct(summary.cacheRate)}   平均 ${(summary.avgMs / 1000).toFixed(1)}s   ` +
    `p50 ${(summary.p50Ms / 1000).toFixed(1)}s   p95 ${(summary.p95Ms / 1000).toFixed(1)}s   ` +
    `速度 ${summary.avgTokensPerSecond} tok/s`,
);
console.log(`最大上下文占用 ${pct(summary.maxContextRate)}`);

// 缓存要看两层：回合首调（跨回合延续的命中）与回合内（追加增长的命中）。
// 首调低于 90% = 前缀在变，去看看 system 里是不是又塞了会动的东西。
const chatCalls = records
  .filter((r) => r.purpose === 'chat' && r.ok)
  .sort((a, b) => a.at.localeCompare(b.at));
const median = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const turnFirst: number[] = [];
const turnRest: number[] = [];
let previous: CallRecord | undefined;
for (const record of chatCalls) {
  const gap = previous ? Date.parse(record.at) - Date.parse(previous.at) : Number.POSITIVE_INFINITY;
  const sameChat = previous?.conversationId === record.conversationId;
  if (!previous || !sameChat || gap > 60_000) {
    turnFirst.push(record.cacheRate);
  } else {
    turnRest.push(record.cacheRate);
  }
  previous = record;
}
console.log(
  `缓存分层  首调 p50 ${pct(median(turnFirst))}（${turnFirst.length} 次）   ` +
    `回合内 p50 ${pct(median(turnRest))}（${turnRest.length} 次）   ` +
    `零缓存 ${pct(turnFirst.filter((v) => v < 0.05).length / Math.max(1, turnFirst.length))}`,
);
if (median(turnFirst) < 0.9) {
  console.log('提示：首调命中偏低 —— system 里可能又放进了会变的内容（记录本/目标/时间/工作区状态）。');
}

function groupBy(pick: (record: CallRecord) => string): Map<string, CallRecord[]> {
  const map = new Map<string, CallRecord[]>();
  for (const record of records) {
    const key = pick(record);
    const list = map.get(key) ?? [];
    list.push(record);
    map.set(key, list);
  }
  return map;
}

console.log('');
console.log('按用途');
for (const [purpose, list] of groupBy((r) => r.purpose)) {
  const s = summarize(list);
  console.log(
    `  ${purpose.padEnd(10)} ${String(s.calls).padStart(3)} 次   ` +
      `prompt ${num(s.promptTokens).padStart(8)}   cached ${pct(s.cacheRate).padStart(6)}   ` +
      `平均 ${(s.avgMs / 1000).toFixed(1)}s   ${s.avgTokensPerSecond} tok/s`,
  );
}

console.log('');
console.log('按天');
for (const [day, list] of groupBy((r) => r.at.slice(0, 10))) {
  const s = summarize(list);
  console.log(
    `  ${day}  ${String(s.calls).padStart(4)} 次   ` +
      `token ${num(s.totalTokens).padStart(9)}   缓存 ${pct(s.cacheRate).padStart(6)}   失败 ${s.failedCalls}`,
  );
}

const slowest = [...records].sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log('');
console.log('最慢 5 次');
for (const record of slowest) {
  const frames = record.stack.slice(0, 2).join(' ← ');
  console.log(
    `  ${(record.ms / 1000).toFixed(1).padStart(5)}s  ${record.purpose.padEnd(8)} ` +
      `${num(record.promptTokens)}→${num(record.completionTokens)} tok  ${frames}`,
  );
}

const failures = records.filter((r) => !r.ok);
if (failures.length > 0) {
  console.log('');
  console.log(`失败 ${failures.length} 次`);
  for (const record of failures.slice(-5)) {
    console.log(`  ${record.at.slice(11, 19)}  ${record.purpose.padEnd(8)} ${record.status ?? ''} ${record.error ?? ''}`);
  }
}
