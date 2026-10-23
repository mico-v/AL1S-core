/**
 * 用真实模型试跑一句，不连 QQ。
 *
 *   AGENT_API_KEY=... pnpm agent:try "今天上课好累啊"
 *
 * 走的是与线上完全相同的 agent 链路（人格 + 群聊缓冲 + 记忆注入），
 * 只是把「发给 QQ」换成了打印到终端。
 */

import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { ChatAgent, readAgentConfig } from '../agent/index.js';
import type { Bot } from '../bot.js';
import type { AppLogger } from '../logger.js';

const quiet: AppLogger = {
  debug: () => {},
  info: () => {},
  warn: (...args: unknown[]) => console.warn('[warn]', ...args),
  error: (...args: unknown[]) => console.error('[error]', ...args),
} as unknown as AppLogger;

const text = process.argv.slice(2).join(' ').trim() || '今天上课好累啊 感觉一天白过了';
const group = process.env.AGENT_TRY_GROUP ?? 'try-group';
const botOpenid = (process.env.AGENT_BOT_OPENIDS ?? 'bot').split(',')[0];
const config = readAgentConfig({ ...process.env, AGENT_GROUPS: '' } as NodeJS.ProcessEnv);

if (!config.llm.apiKey) {
  console.error('缺少 AGENT_API_KEY');
  process.exit(1);
}

const agent = new ChatAgent(config, quiet);
const bot = {
  replyText: async (_target: unknown, reply: string) => {
    console.log(`\nKei：${reply}\n`);
  },
} as unknown as Bot;

const message = {
  kind: 'group',
  groupOpenid: group,
  senderId: process.env.AGENT_TRY_SENDER ?? 'B8312115BE2DD526518258E2A861F479',
  senderName: process.env.AGENT_TRY_NAME ?? '謎矢',
  senderIsBot: false,
  content: text,
  messageId: `try-${Date.now()}`,
  replyTarget: { kind: 'group', groupOpenid: group },
  mentions: [{ member_openid: botOpenid, username: 'Kei', bot: true }],
} as unknown as QQBotInboundMessage;

await agent.handle(message, bot);
