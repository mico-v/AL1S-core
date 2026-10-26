/**
 * 线下验证主动判断：给一段假对话，看它到底会不会开口、为什么。
 *
 *   pnpm agent:proactive
 *   pnpm agent:proactive -- --spoke   # 用一段"卡住"的对话
 */

import { chatComplete } from '../agent/llm.js';
import { judgeProactive } from '../agent/proactive.js';
import type { BufferedLine } from '../agent/context.js';
import { readAgentConfig } from '../agent/index.js';
import { createLogger } from '../logger.js';

const config = readAgentConfig(process.env);
const log = createLogger({ level: 'info', file: 'logs/proactive-try.log' });
const now = Date.now();
const min = 60_000;

const stuck: BufferedLine[] = [
  { senderName: '星落夕', text: '周六有人一起去线下赛吗', timestamp: now - 9 * min },
  { senderName: '落樱', text: '我可能去不了', timestamp: now - 8 * min },
  { senderName: '星落夕', text: '那还有人吗', timestamp: now - 7 * min },
  { senderName: '小麻瓜', text: '我在想要不要报', timestamp: now - 6 * min },
  { senderName: '星落夕', text: '报名今天截止诶', timestamp: now - 5 * min },
  { senderName: '小麻瓜', text: '啊 那我再看看', timestamp: now - 4 * min },
];

const normal: BufferedLine[] = [
  { senderName: '含糖不甜', text: '刚打完那个新本 有点难', timestamp: now - 3 * min },
  { senderName: '风纪扣', text: '几阶段啊', timestamp: now - 2 * min },
  { senderName: '含糖不甜', text: '八个 最后那个机制挺烦', timestamp: now - 1 * min },
  { senderName: '风纪扣', text: '那得练', timestamp: now - 40_000 },
];

const useStuck = process.argv.includes('--spoke');
const lines = useStuck ? stuck : normal;

const decision = await judgeProactive(
  { groupId: 'try', lines },
  { complete: chatComplete, llm: config.llm, log },
);
console.log(JSON.stringify(decision, null, 2));
