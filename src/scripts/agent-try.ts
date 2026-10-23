/**
 * 用真实模型试跑一句，不连 QQ。
 *
 *   pnpm agent:try "今天上课好累啊"
 *   pnpm agent:try --image data/media-cache/xxx "这图好笑吗"
 *
 * 走的是与线上完全相同的 agent 链路（人格 + 群聊缓冲 + 记忆 + 看图），
 * 只是把「发给 QQ」换成了打印到终端。
 * 图片会在本机起一个临时 HTTP 服务，模拟 QQ 的附件下载地址。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { ChatAgent, readAgentConfig } from '../agent/index.js';
import type { Bot } from '../bot.js';
import type { AppLogger } from '../logger.js';

const verbose: AppLogger = {
  debug: () => {},
  info: (msg: string, meta?: unknown) => console.log(`[info] ${msg}`, meta ? JSON.stringify(meta) : ''),
  warn: (msg: string, meta?: unknown) => console.warn(`[warn] ${msg}`, meta ? JSON.stringify(meta) : ''),
  error: (msg: string, meta?: unknown) => console.error(`[error] ${msg}`, meta ? JSON.stringify(meta) : ''),
} as unknown as AppLogger;

const argv = process.argv.slice(2);
let imagePath: string | undefined;
const imageIndex = argv.indexOf('--image');
if (imageIndex >= 0) {
  imagePath = argv[imageIndex + 1];
  argv.splice(imageIndex, 2);
}
let imageUrl: string | undefined;
const urlIndex = argv.indexOf('--image-url');
if (urlIndex >= 0) {
  imageUrl = argv[urlIndex + 1];
  argv.splice(urlIndex, 2);
}
const text = argv.join(' ').trim() || (imagePath ? '这图什么意思' : '今天上课好累啊 感觉一天白过了');

const group = process.env.AGENT_TRY_GROUP ?? 'try-group';
const botOpenid = (process.env.AGENT_BOT_OPENIDS ?? 'bot').split(',')[0];
const config = readAgentConfig({ ...process.env, AGENT_GROUPS: '' } as NodeJS.ProcessEnv);

if (!config.llm.apiKey) {
  console.error('缺少 AGENT_API_KEY');
  process.exit(1);
}

let attachments: unknown[] = [];
let server: ReturnType<typeof createServer> | undefined;

if (imageUrl) {
  attachments = [{ content_type: 'image/jpeg', url: imageUrl }];
  console.log(`[试跑] 图片地址 ${imageUrl}`);
}

if (imagePath) {
  const bytes = await readFile(imagePath);
  const mime = imagePath.endsWith('.png')
    ? 'image/png'
    : imagePath.endsWith('.gif')
      ? 'image/gif'
      : 'image/jpeg';
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': mime, 'content-length': bytes.byteLength });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  attachments = [{ content_type: mime, url: `http://127.0.0.1:${port}/img`, size: bytes.byteLength }];
  console.log(`[试跑] 图片 ${imagePath} (${bytes.byteLength}B) 经 127.0.0.1:${port} 提供`);
}

const agent = new ChatAgent(config, verbose);
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
  attachments,
} as unknown as QQBotInboundMessage;

const startedAt = Date.now();
await agent.handle(message, bot);
console.log(`[试跑] 总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
server?.close();
