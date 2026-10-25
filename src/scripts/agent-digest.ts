/**
 * 手动跑一次对话归档。
 *
 *   pnpm agent:digest                # 所有群
 *   pnpm agent:digest <群openid>     # 指定群
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readAgentConfig } from '../agent/index.js';
import { DigestEngine } from '../agent/digest.js';
import type { AppLogger } from '../logger.js';

const log: AppLogger = {
  debug: () => {},
  info: (msg: string, meta?: unknown) => console.log(`[info] ${msg}`, meta ? JSON.stringify(meta) : ''),
  warn: (msg: string, meta?: unknown) => console.warn(`[warn] ${msg}`, meta ? JSON.stringify(meta) : ''),
  error: (msg: string, meta?: unknown) => console.error(`[error] ${msg}`, meta ? JSON.stringify(meta) : ''),
} as unknown as AppLogger;

const config = readAgentConfig(process.env);
if (!config.llm.apiKey) {
  console.error('缺少 AGENT_API_KEY');
  process.exit(1);
}

const explicit = process.argv[2];
let groups: string[] = [];
if (explicit) {
  groups = [explicit];
} else {
  const dir = path.join(config.dataRoot, 'memory');
  groups = existsSync(dir) ? (await readdir(dir)).filter((n) => !n.startsWith('.')) : [];
}

if (groups.length === 0) {
  console.log('没有可处理的群（先让群里有聊天记录）');
  process.exit(0);
}

const engine = new DigestEngine({
  dataRoot: config.dataRoot,
  llm: config.llm,
  log,
  threshold: config.digestThreshold,
  maxBatch: config.digestMaxBatch,
});

for (const chatId of groups) {
  const due = await engine.dueCount(chatId);
  console.log(`\n${chatId}: 待归档 ${due} 条`);
  if (due < Math.min(8, config.digestThreshold)) {
    console.log('  太少，跳过');
    continue;
  }
  const record = await engine.digest(chatId);
  if (!record) {
    console.log('  未产出摘要');
    continue;
  }
  console.log(`  ✓ ${record.count} 条 · ${record.from.slice(5, 16)} → ${record.to.slice(11, 16)}`);
  console.log(`  摘要: ${record.summary}`);
  for (const t of record.topics) {
    console.log(`  · ${t.title} [${t.keywords.join(',')}] ${t.summary ?? ''}`);
  }
  if (record.note) {
    console.log(`  记忆点: ${record.note}`);
  }
}
