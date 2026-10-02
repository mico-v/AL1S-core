/**
 * 离线协议自检：不连接 QQ、不访问网络。
 *
 * 覆盖：
 *   - 环境变量配置解析与校验；
 *   - 日志级别；
 *   - Webhook Ed25519 验签 / op13 回包；
 *   - Gateway 事件解码与归一化；
 *   - Bot 组装。
 *
 * 运行：pnpm qq:check
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { MsgType, QQBot } from '@tencent-connect/qqbot-nodejs';
import {
  decodeGatewayMessageData,
  dispatchEvent,
  ed25519Sign,
  signValidationResponse,
  verifyWebhookSignature,
} from '@tencent-connect/qqbot-nodejs/protocol';
import { Bot, looksLikeQqMarkdown, requiresQqMarkdown } from '../bot.js';
import { ChatStore } from '../chat-log.js';
import { ConfigError, loadConfig } from '../config.js';
import { createLogger, parseLogLevel } from '../logger.js';

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
section('配置加载');

try {
  loadConfig({});
  check('缺少凭据时抛错', false);
} catch (error) {
  check('缺少凭据时抛错', error instanceof ConfigError, String(error));
}

const config = loadConfig({
  QQBOT_APP_ID: '10000',
  QQBOT_APP_SECRET: 'super-secret',
  QQBOT_TRANSPORT: 'webhook',
  QQBOT_WEBHOOK_PORT: '8443',
  QQBOT_WEBHOOK_PATH: '/qq/webhook',
  QQBOT_MARKDOWN_SUPPORT: 'true',
  QQBOT_TOKEN_PREFETCH: 'async',
  LOG_LEVEL: 'debug',
  CHAT_LOG_ENABLED: 'false',
});

check('解析 AppID', config.appId === '10000');
check('解析 transport', config.transport === 'webhook');
check('解析 webhook 端口', config.webhook.port === 8443);
check('解析 webhook 路径', config.webhook.path === '/qq/webhook');
check('解析 markdown 开关', config.markdownSupport === true);
check('解析 tokenPrefetch', config.tokenPrefetch === 'async');
check('解析日志级别', config.logging.level === 'debug');
check('默认落盘到 logs/bot.log', config.logging.file === 'logs/bot.log');
check('默认保留 5 个日志文件', config.logging.maxFiles === 5);
check('解析聊天记录开关', config.chatLog.enabled === false);
check('accountId 回退 AppID', config.accountId === '10000');

const chatConfig = loadConfig({
  QQBOT_APP_ID: '1',
  QQBOT_APP_SECRET: 'x',
  CHAT_DATA_DIR: './mydata',
  CHAT_SAVE_MEDIA: 'true',
  CHAT_MEDIA_MAX_MB: '7',
});
check('解析聊天记录目录', chatConfig.chatLog.root === './mydata');
check('解析媒体保存开关', chatConfig.chatLog.saveMedia === true);
check('解析媒体大小上限', chatConfig.chatLog.maxMediaBytes === 7 * 1024 * 1024);

const aliasConfig = loadConfig({ QQ_APP_ID: '20000', QQ_APP_SECRET: 'x' });
check('兼容 QQ_APP_ID 别名', aliasConfig.appId === '20000');

// ---------------------------------------------------------------------------
section('日志');

check('parseLogLevel 识别 warn', parseLogLevel('warn') === 'warn');
check('parseLogLevel 非法值回退', parseLogLevel('verbose', 'error') === 'error');

const logDir = mkdtempSync(join(tmpdir(), 'al1s-log-'));
try {
  // --- 内容 / 脱敏 / 级别 ---
  const logFile = join(logDir, 'content.log');
  const logger = createLogger({ level: 'debug', console: false, file: logFile });
  check(
    'logger 提供 SDK 所需方法',
    typeof logger.info === 'function' && typeof logger.error === 'function',
  );

  logger.debug('调试行');
  logger.info('普通行', { foo: 'bar' });
  logger.info('密钥脱敏', { appSecret: 'topsecret', token: 'abc123' });
  logger.info('非密钥', { tokenPrefetch: 'sync' });
  logger.warn('警告行');
  logger.error('错误行', { error: new Error('boom') });

  const content = readFileSync(logFile, 'utf8');
  check('落盘包含 info 行', content.includes('普通行'));
  check('落盘包含 debug 行', content.includes('调试行'));
  check('meta 结构化序列化', content.includes('"foo":"bar"'));
  check('secret 字段已脱敏', content.includes('"appSecret":"***"') && !content.includes('topsecret'));
  check('非密钥字段不误伤', content.includes('"tokenPrefetch":"sync"'));
  check('Error 展开 name/message', content.includes('"name":"Error"') && content.includes('boom'));

  const quiet = createLogger({ level: 'error', console: false, file: join(logDir, 'quiet.log') });
  quiet.debug('不应出现 debug');
  quiet.info('不应出现 info');
  quiet.error('应出现 error');
  const quietContent = readFileSync(join(logDir, 'quiet.log'), 'utf8');
  check('低于级别的日志不落盘', !quietContent.includes('不应出现') && quietContent.includes('应出现 error'));

  // --- 轮转 ---
  const rotFile = join(logDir, 'rot.log');
  const rotating = createLogger({ level: 'info', console: false, file: rotFile, maxSizeBytes: 300, maxFiles: 3 });
  for (let i = 0; i < 200; i += 1) {
    rotating.info(`填充行 ${i} ${'x'.repeat(20)}`);
  }
  const files = readdirSync(logDir).filter((name) => name.startsWith('rot.log'));
  check('超过阈值自动轮转', files.length >= 2, files.join(','));
  check('保留文件数不超过 maxFiles', files.length <= 3, files.join(','));
  check('轮转后主文件仍可写', readFileSync(rotFile, 'utf8').length > 0);
} finally {
  rmSync(logDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section('Webhook Ed25519');

const secret = 'DG5g3B4jX2KOErG';
const timestamp = '1725442341';
const body = Buffer.from(JSON.stringify({ op: 0, d: {}, t: 'GATEWAY_EVENT_NAME' }));
const signature = ed25519Sign(secret, Buffer.concat([Buffer.from(timestamp, 'utf8'), body]));

check('合法签名通过', verifyWebhookSignature({ body, timestamp, signature, botSecret: secret }));
check(
  '伪造签名被拒绝',
  !verifyWebhookSignature({ body, timestamp, signature: '00'.repeat(64), botSecret: secret }),
);

const validation = signValidationResponse({
  plainToken: 'Arq0D5A61EgUu4OxUvOp',
  eventTs: timestamp,
  botSecret: secret,
});
check('op13 回包 plain_token 一致', validation.plain_token === 'Arq0D5A61EgUu4OxUvOp');
check(
  'op13 回包签名可复现',
  validation.signature === ed25519Sign(secret, Buffer.from(`${timestamp}Arq0D5A61EgUu4OxUvOp`)),
);

// ---------------------------------------------------------------------------
section('Gateway 事件解码');

const groupMessage = {
  id: 'ROBOT1.0_GROUP_MSG',
  author: { member_openid: 'MEMBER', username: '小明', bot: false },
  content: 'hello',
  group_openid: 'GROUP',
  timestamp: '2026-07-21T10:00:00+08:00',
  message_type: 0,
  message_scene: { source: 'default', ext: ['msg_idx=REFIDX_x=='] },
};
const envelope = { op: 0, s: 42, t: 'GROUP_AT_MESSAGE_CREATE', id: 'EVENT', d: groupMessage };

const decoded = decodeGatewayMessageData(Buffer.from(JSON.stringify(envelope)));
check('Buffer 解码为 JSON 文本', decoded === JSON.stringify(envelope));

const groupResult = dispatchEvent('GROUP_AT_MESSAGE_CREATE', groupMessage, 'acct');
check('解析为 message 事件', groupResult.action === 'message');
if (groupResult.action === 'message') {
  check('kind = group', groupResult.msg.kind === 'group');
  check('内容归一化', groupResult.msg.content === 'hello');
  check('群 OpenID 归一化', groupResult.msg.groupOpenid === 'GROUP');
}

const c2cMessage = {
  id: 'ROBOT1.0_C2C_MSG',
  author: { user_openid: 'USER' },
  content: 'hi',
  timestamp: '2026-07-21T10:00:00+08:00',
  message_type: 0,
};
const c2cResult = dispatchEvent('C2C_MESSAGE_CREATE', c2cMessage, 'acct');
check('解析单聊事件', c2cResult.action === 'message');
if (c2cResult.action === 'message') {
  check('kind = c2c', c2cResult.msg.kind === 'c2c');
  check('单聊发送者 OpenID', c2cResult.msg.senderId === 'USER');
}

const guildMessage = {
  id: 'ROBOT1.0_GUILD_MSG',
  author: { id: 'GUILD-USER', username: '频道用户', bot: false },
  content: 'guild hello',
  channel_id: 'CHANNEL',
  guild_id: 'GUILD',
  timestamp: '2026-07-21T10:02:00+08:00',
};
const guildResult = dispatchEvent('AT_MESSAGE_CREATE', guildMessage, 'acct');
check('解析频道消息事件', guildResult.action === 'message');
if (guildResult.action === 'message') {
  check('kind = guild', guildResult.msg.kind === 'guild');
  check(
    '频道消息保留 guild/channel ID',
    guildResult.msg.guildId === 'GUILD' && guildResult.msg.channelId === 'CHANNEL',
  );
}

const dmMessage = {
  id: 'ROBOT1.0_DM_MSG',
  author: { id: 'DM-USER', username: '私信用户', bot: false },
  content: 'dm hello',
  channel_id: 'DM-CHANNEL',
  guild_id: 'DM-GUILD',
  timestamp: '2026-07-21T10:03:00+08:00',
};
const dmResult = dispatchEvent('DIRECT_MESSAGE_CREATE', dmMessage, 'acct');
check('解析频道私信事件', dmResult.action === 'message');
if (dmResult.action === 'message') {
  check('kind = dm', dmResult.msg.kind === 'dm');
  check('私信保留 guild ID', dmResult.msg.guildId === 'DM-GUILD');
}

const unknownResult = dispatchEvent('SOME_UNKNOWN_EVENT', { a: 1 }, 'acct');
check('未知事件走 raw 分支', unknownResult.action === 'raw');

// ---------------------------------------------------------------------------
section('Bot 组装');

const bot = new Bot(config, createLogger({ level: 'error', console: false, file: null }));
check('实例化 QQBot', bot.client instanceof QQBot);
check('保留原始配置', bot.config.appId === '10000');

let registered = 0;
bot.onMessage(() => {
  registered += 1;
});
check('注册处理器不触发', registered === 0);

const inboundMessages: QQBotInboundMessage[] = [];
bot.onMessage((message) => {
  inboundMessages.push(message);
});
const internalClient = bot.client as unknown as {
  handleInboundMessage(message: Omit<QQBotInboundMessage, 'replyTarget'>): Promise<void>;
};
await internalClient.handleInboundMessage({
  rawEventType: 'AT_MESSAGE_CREATE',
  kind: 'guild',
  senderId: 'GUILD-USER',
  senderName: '频道用户',
  content: 'guild hello',
  messageId: 'GUILD-MESSAGE',
  timestamp: '2026-07-21T10:02:00+08:00',
  channelId: 'CHANNEL',
  guildId: 'GUILD',
  raw: guildMessage,
});
await internalClient.handleInboundMessage({
  rawEventType: 'DIRECT_MESSAGE_CREATE',
  kind: 'dm',
  senderId: 'DM-USER',
  senderName: '私信用户',
  content: 'dm hello',
  messageId: 'DM-MESSAGE',
  timestamp: '2026-07-21T10:03:00+08:00',
  channelId: 'DM-CHANNEL',
  guildId: 'DM-GUILD',
  raw: dmMessage,
});
check(
  '频道消息公开事件生成 guild replyTarget',
  inboundMessages[0]?.replyTarget.scope === 'guild' &&
    inboundMessages[0].replyTarget.targetId === 'CHANNEL' &&
    inboundMessages[0].replyTarget.msgId === 'GUILD-MESSAGE',
);
check(
  '频道私信公开事件生成 dm replyTarget',
  inboundMessages[1]?.replyTarget.scope === 'dm' &&
    inboundMessages[1].replyTarget.targetId === 'DM-GUILD' &&
    inboundMessages[1].replyTarget.msgId === 'DM-MESSAGE',
);

check('识别 Markdown 标题', looksLikeQqMarkdown('# 标题'));
check('识别 Markdown 粗体', looksLikeQqMarkdown('这是 **粗体**'));
check('普通乘号不误判为 Markdown', !looksLikeQqMarkdown('2 * 3 * 4'));
check('识别 QQ 兼容提及标记', requiresQqMarkdown('你好 <@OPENID>'));
check(
  '识别 QQ 官方提及标签',
  requiresQqMarkdown('你好 <qqbot-at-user id="OPENID" />'),
);
check('普通 @ 文本不误判为 QQ 提及', !requiresQqMarkdown('你好 @OPENID'));

const outgoingOptions: Array<Parameters<QQBot['send']>[0]> = [];
bot.client.send = async (options) => {
  outgoingOptions.push(options);
  return { id: `markdown-${String(outgoingOptions.length)}`, timestamp: 1 };
};
await bot.replyText(
  { scope: 'group', targetId: 'GROUP' },
  '**粗体**',
  { messageReference: 'REFIDX-test' },
);
check(
  'Markdown 正文使用 msg_type=2 并保留引用',
  outgoingOptions[0]?.msgType === MsgType.MARKDOWN &&
    outgoingOptions[0]?.markdown?.content === '**粗体**' &&
    outgoingOptions[0]?.messageReference?.message_id === 'REFIDX-test',
);
await bot.replyText(
  { scope: 'group', targetId: 'GROUP' },
  '你好 <qqbot-at-user id="OPENID" />',
  { messageReference: 'REFIDX-mention' },
);
check(
  'QQ 提及强制使用 Markdown 并保留引用',
  outgoingOptions[1]?.msgType === MsgType.MARKDOWN &&
    outgoingOptions[1]?.markdown?.content ===
      '你好 <qqbot-at-user id="OPENID" />' &&
    outgoingOptions[1]?.messageReference?.message_id === 'REFIDX-mention',
);
await bot.replyText({ scope: 'group', targetId: 'GROUP' }, '普通文本');
check(
  '普通正文使用 msg_type=0',
  outgoingOptions[2]?.msgType === MsgType.TEXT &&
    outgoingOptions[2]?.content === '普通文本' &&
    outgoingOptions[2]?.markdown === undefined,
);

// ---------------------------------------------------------------------------
section('聊天记录落盘');

const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const mediaServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(pngBytes.length) });
  res.end(pngBytes);
});
await new Promise<void>((resolve) => mediaServer.listen(0, '127.0.0.1', resolve));
const mediaAddress = mediaServer.address();
const mediaPort = mediaAddress !== null && typeof mediaAddress === 'object' ? mediaAddress.port : 0;
const imageUrl = `http://127.0.0.1:${mediaPort}/a.png`;

const dataDir = mkdtempSync(join(tmpdir(), 'al1s-data-'));
try {
  const store = new ChatStore({ root: dataDir, saveMedia: true, maxMediaBytes: 1024 * 1024 });

  const groupMessage: QQBotInboundMessage = {
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    kind: 'group',
    senderId: 'MEMBER',
    senderName: '小明',
    content: 'hello',
    messageId: 'MSG-1',
    timestamp: '2026-07-21T10:00:00+08:00',
    groupOpenid: 'GROUP1',
    attachments: [{ content_type: 'image/png', url: imageUrl, filename: 'a.png', size: pngBytes.length }],
    replyTarget: { scope: 'group', targetId: 'GROUP1', msgId: 'MSG-1' },
    raw: {
      id: 'MSG-1',
      content: 'hello',
      timestamp: '2026-07-21T10:00:00+08:00',
      author: { member_openid: 'MEMBER', username: '小明', bot: false },
      group_openid: 'GROUP1',
    },
  };

  await store.record(groupMessage);
  await store.flush();

  const groupJsonl = join(dataDir, 'chats/group/GROUP1/messages.jsonl');
  const pngHash = createHash('sha256').update(pngBytes).digest('hex');
  const groupMedia = join(dataDir, 'media-cache', pngHash);
  check('按群目标分目录', existsSync(groupJsonl));
  check('媒体文件已下载', existsSync(groupMedia));
  check('媒体内容一致', existsSync(groupMedia) && statSync(groupMedia).size === pngBytes.length);

  const lines = readFileSync(groupJsonl, 'utf8').trim().split('\n');
  check('JSONL 仅一行', lines.length === 1);
  const record = JSON.parse(lines[0] ?? '{}') as {
    messageId?: string;
    content?: string;
    attachments?: Array<{ localPath?: string; sha256?: string }>;
  };
  check('记录包含 messageId', record.messageId === 'MSG-1');
  check('记录包含正文', record.content === 'hello');
  check(
    '记录包含内容寻址媒体路径',
    record.attachments?.[0]?.localPath === `media-cache/${pngHash}` &&
      record.attachments[0]?.sha256 === pngHash,
  );

  // 重复推送同一 messageId 应去重。
  await store.record(groupMessage);
  await store.flush();
  check('重复 messageId 去重', readFileSync(groupJsonl, 'utf8').trim().split('\n').length === 1);

  // 不同 messageId 携带相同内容时只保留一份媒体。
  await store.record({ ...groupMessage, messageId: 'MSG-1-DUPLICATE' });
  await store.flush();
  const duplicateLines = readFileSync(groupJsonl, 'utf8').trim().split('\n');
  const duplicateRecord = JSON.parse(duplicateLines[1] ?? '{}') as {
    attachments?: Array<{ localPath?: string }>;
  };
  check(
    '不同消息的相同媒体指向同一文件',
    duplicateLines.length === 2 &&
      duplicateRecord.attachments?.[0]?.localPath === `media-cache/${pngHash}`,
  );
  check('媒体缓存只有一个内容文件', readdirSync(join(dataDir, 'media-cache')).length === 1);

  // 单聊目标分目录。
  const c2cMessage: QQBotInboundMessage = {
    rawEventType: 'C2C_MESSAGE_CREATE',
    kind: 'c2c',
    senderId: 'USER1',
    content: 'hi',
    messageId: 'MSG-2',
    timestamp: '2026-07-21T10:01:00+08:00',
    replyTarget: { scope: 'c2c', targetId: 'USER1', msgId: 'MSG-2' },
    raw: {
      id: 'MSG-2',
      content: 'hi',
      timestamp: '2026-07-21T10:01:00+08:00',
      author: { user_openid: 'USER1' },
    },
  };
  await store.record(c2cMessage);
  await store.flush();
  check('按单聊目标分目录', existsSync(join(dataDir, 'chats/c2c/USER1/messages.jsonl')));

  // 超过大小上限的媒体应跳过并记错误。
  const tinyStore = new ChatStore({ root: dataDir, saveMedia: true, maxMediaBytes: 2 });
  const bigMessage: QQBotInboundMessage = {
    ...groupMessage,
    messageId: 'MSG-3',
    attachments: [{ content_type: 'image/png', url: imageUrl, filename: 'big.png' }],
  };
  await tinyStore.record(bigMessage);
  await tinyStore.flush();
  check('超限媒体不写内容缓存', readdirSync(join(dataDir, 'media-cache')).length === 1);
  check('超限媒体写错误日志', existsSync(join(dataDir, 'chats/group/GROUP1/media/download-errors.log')));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  mediaServer.close();
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n协议自检失败：${failures} 项`);
  process.exit(1);
}
console.log('\n协议自检通过');
