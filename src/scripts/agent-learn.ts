/**
 * 手动跑一次成员档案归纳。
 *
 *   pnpm agent:learn              # 全部群
 *   pnpm agent:learn <群openid>   # 只处理一个群
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readAgentConfig } from '../agent/index.js';
import { learnGroup } from '../agent/updater.js';
import type { AppLogger } from '../logger.js';

const config = readAgentConfig(process.env);
const log: AppLogger = {
  debug: () => {},
  info: (msg: string, meta?: unknown) => console.log(`[info] ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: unknown) => console.warn(`[warn] ${msg}`, meta ?? ''),
  error: (msg: string, meta?: unknown) => console.error(`[error] ${msg}`, meta ?? ''),
} as unknown as AppLogger;

if (!config.llm.apiKey) {
  console.error('缺少 AGENT_API_KEY');
  process.exit(1);
}

const explicit = process.argv[2];
let groups: string[] = [];
if (explicit) {
  groups = [explicit];
} else {
  const dir = path.join(config.dataRoot, 'chats', 'group');
  if (!existsSync(dir)) {
    console.error(`没有找到聊天记录目录：${dir}`);
    process.exit(1);
  }
  groups = (await readdir(dir)).filter((name) => !name.startsWith('.'));
}

if (groups.length === 0) {
  console.log('没有可处理的群');
  process.exit(0);
}

let totalWritten = 0;
for (const group of groups) {
  try {
    const result = await learnGroup({ dataRoot: config.dataRoot, llm: config.llm }, group, log);
    totalWritten += result.written;
    console.log(`${group}: 处理 ${result.processed} 条，更新 ${result.written} 份档案`);
  } catch (error) {
    console.error(`${group}: 失败`, error);
  }
}
console.log(`\n共更新 ${totalWritten} 份档案`);
