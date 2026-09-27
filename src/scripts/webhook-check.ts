/**
 * Webhook 模式端到端自检（本地回环，不依赖公网 QQ）。
 *
 * 用假凭据在本机起一个 webhook 服务，然后模拟 QQ 平台：
 *   1. 发送 op=13 回调地址验证，校验 Ed25519 回包；
 *   2. 发送带合法签名的 op=0 GROUP_AT_MESSAGE_CREATE，校验 Bot 能收到并归一化；
 *   3. 发送伪造签名，校验被拒绝。
 *
 * token 基址指向本地关闭端口，避免真实网络请求；tokenPrefetch=async 不阻塞启动。
 *
 * 运行：pnpm webhook:check
 */

import { createServer } from 'node:net';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { ed25519Sign, signValidationResponse } from '@tencent-connect/qqbot-nodejs/protocol';
import { Bot } from '../bot.js';
import type { BotConfig } from '../config.js';

const SECRET = 'DG5g3B4jX2KOErG';
const PATH = '/webhook';

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

const silentLogger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('无法分配空闲端口')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

const port = await getFreePort();
const base = `http://127.0.0.1:${port}${PATH}`;

const config: BotConfig = {
  appId: '10000',
  appSecret: SECRET,
  accountId: 'selftest',
  transport: 'webhook',
  webhook: { port, path: PATH },
  markdownSupport: false,
  tokenPrefetch: 'async',
  logging: { level: 'error', console: false, file: null },
  chatLog: { enabled: false, root: 'data', saveMedia: false, maxMediaBytes: 0 },
  // 指向本地关闭端口，让 token 预取立即失败，不产生外网请求。
  apiBaseUrl: 'http://127.0.0.1:1',
  tokenBaseUrl: 'http://127.0.0.1:1',
};

const bot = new Bot(config, silentLogger);

let received: QQBotInboundMessage | undefined;
bot.onMessage((message) => {
  received = message;
});

const ready = new Promise<void>((resolve) => {
  bot.client.on('ready', () => resolve());
});

const started = bot.start();
// 防止启动失败变成 unhandled rejection。
const startedSafe = started.catch(() => undefined);

try {
  await Promise.race([
    ready,
    started.then(() => {
      throw new Error('webhook 启动流程提前结束');
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('等待 webhook ready 超时')), 5000);
    }),
  ]);

  // ---- op=13 回调地址验证 ----
  const eventTs = '1725442341';
  const plainToken = 'Arq0D5A61EgUu4OxUvOp';
  const validationResponse = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 13, d: { plain_token: plainToken, event_ts: eventTs } }),
  });
  const validationBody = (await validationResponse.json()) as { plain_token?: string; signature?: string };
  const expected = signValidationResponse({ plainToken, eventTs, botSecret: SECRET });
  check('op13 HTTP 200', validationResponse.status === 200, `status=${validationResponse.status}`);
  check('op13 返回 plain_token', validationBody.plain_token === plainToken);
  check('op13 签名正确', validationBody.signature === expected.signature);
  check('op13 签名为 64 字节 hex', validationBody.signature?.length === 128);

  // ---- op=0 群 @ 消息 ----
  const payload = {
    op: 0,
    id: 'EVENT_ID',
    s: 1,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'ROBOT1.0_MSG',
      author: { member_openid: 'MEMBER', username: '小明', bot: false },
      content: 'hello webhook',
      group_openid: 'GROUP_OPENID',
      timestamp: '2026-07-21T10:00:00+08:00',
      message_type: 0,
      message_scene: { source: 'default', ext: ['msg_idx=REFIDX_x=='] },
    },
  };
  const raw = JSON.stringify(payload);
  const signature = ed25519Sign(SECRET, Buffer.concat([Buffer.from(eventTs, 'utf8'), Buffer.from(raw, 'utf8')]));

  const dispatchResponse = await fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': signature,
      'x-signature-timestamp': eventTs,
    },
    body: raw,
  });
  const ack = (await dispatchResponse.json()) as { op?: number };
  check('op0 HTTP 200', dispatchResponse.status === 200, `status=${dispatchResponse.status}`);
  check('op0 返回 op=12 ACK', ack.op === 12, JSON.stringify(ack));

  // webhook 先回 ACK，事件异步处理，轮询等待。
  const deadline = Date.now() + 2000;
  while (received === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  check('Bot 收到并分发消息', received !== undefined);
  if (received !== undefined) {
    check('消息 kind = group', received.kind === 'group');
    check('消息内容正确', received.content === 'hello webhook');
    check('群 OpenID 正确', received.groupOpenid === 'GROUP_OPENID');
    check('发送者 OpenID 正确', received.senderId === 'MEMBER');
  }

  // ---- 非法签名必须被拒绝 ----
  const badResponse = await fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': '00'.repeat(64),
      'x-signature-timestamp': eventTs,
    },
    body: raw,
  });
  check('伪造签名被拒绝 (401)', badResponse.status === 401, `status=${badResponse.status}`);
} catch (error) {
  failures += 1;
  console.error(`  ✗ 自检异常 — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  bot.stop();
  await startedSafe;
}

if (failures > 0) {
  console.error(`\nWebhook 自检失败：${failures} 项`);
  process.exit(1);
}
console.log('\nWebhook 自检通过');
