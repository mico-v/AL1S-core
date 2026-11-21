/**
 * 发一张图文卡片（`msg_type=8`），用来验证通道或手动补一条摘要。
 *
 *   pnpm qq:card                                  # 发给 AGENT_OWNER_OPENIDS 的第一个人
 *   pnpm qq:card --to <openid>                    # 指定收件人（单聊）
 *   pnpm qq:card --title … --desc … --url … --pic …
 *   pnpm qq:card --dry-run                        # 只校验内容，不调接口
 *
 * 卡片内容与平台约束都在 src/agent/cards.ts；这个脚本只负责取配置与发。
 * 走的是线上同一个 `Bot.pushCard()`，所以跑通即代表 `send_card` 工具也通。
 */

import { Bot } from '../bot.js';
import { loadConfig } from '../config.js';
import { buildCard } from '../agent/cards.js';
import { createLogger } from '../logger.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function envList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const dryRun = flag('dry-run');
const to = arg('to') ?? envList('AGENT_OWNER_OPENIDS')[0];

if (!to) {
  console.error('没给 --to，AGENT_OWNER_OPENIDS 也是空的：不知道发给谁。');
  process.exit(1);
}

const built = buildCard({
  title: arg('title') ?? '图文卡片已上线',
  description:
    arg('desc') ?? 'Kei 现在能把 PR / issue 摘要发成卡片：标题 + 一句说明 + 配图 + 可点链接。',
  url: arg('url') ?? 'https://github.com/mico-v/AL1S-core',
  picUrl: arg('pic') ?? 'https://avatars.githubusercontent.com/u/232133607?v=4',
});

if ('error' in built) {
  console.error(`卡片内容不合规：${built.error}`);
  process.exit(1);
}

console.log(`卡片：${built.card.content.title} / ${built.card.content.description}`);
console.log(`链接：${built.card.content.url}  配图：${built.card.content.pic_url}`);

if (dryRun) {
  console.log('--dry-run：只校验，不发。');
  process.exit(0);
}

const config = loadConfig();
const bot = new Bot(
  { ...config, chatLog: { ...config.chatLog, enabled: false } },
  createLogger({ level: 'info', console: true, file: null }),
  { chatLogEnabled: false },
);

try {
  const res = await bot.pushCard({ scope: 'c2c', targetId: to } as unknown as Parameters<Bot['pushCard']>[0], built.card);
  console.log(`已发出：id=${res?.id ?? '(无)'} timestamp=${res?.timestamp ?? '(无)'}`);
} catch (error) {
  console.error(`发送失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
