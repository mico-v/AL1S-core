import { ChatAgent, readAgentConfig } from '../agent/index.js';
import type { AppLogger } from '../logger.js';

const BOT = '010356C972961F4612B45B858C77091A';
const GROUP = '2735F7F55B6B1D1B0D47D8BD8F315E49';
const quiet = { debug() {}, info() {}, warn() {}, error() {} } as unknown as AppLogger;
const config = readAgentConfig(process.env);
const agent = new ChatAgent(config, quiet);
const bot = { replyText: async () => {} } as never;
const msg = (o: Record<string, unknown>) => ({
  kind: 'group', groupOpenid: GROUP, senderIsBot: false,
  messageId: `m-${Math.random()}`, mentions: [], replyTarget: {},
  ...o,
}) as never;

const at = (content: string, senderId = 'A4C9671D0DD438DB6AED7F5FD85E3437', name = '星月神话') =>
  agent.handle(msg({ content: `<@${BOT}> ${content}`, senderId, senderName: name, mentions: [{ member_openid: BOT, is_you: true }] }), bot);

await at('今天服务器是不是有点卡');
await at('你觉得是什么原因');
await at('那就先这样吧');
console.log('done');
