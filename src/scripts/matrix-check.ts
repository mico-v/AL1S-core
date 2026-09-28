/**
 * QQ Matrix bridge 离线自检：不连接 QQ、Tuwunel 或公网。
 *
 * 运行：pnpm matrix:check
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect as connectSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApiError,
  MediaFileType,
  type MessageResponse,
  type QQBotInboundMessage,
  type UploadMediaResponse,
} from '@tencent-connect/qqbot-nodejs';
import {
  QqMatrixBridge,
  conversationKey,
  deriveGhostLocalpart,
  type QqBotPort,
} from '../bridge/bridge.js';
import { BridgeStore, type ConversationTarget } from '../bridge/store.js';
import {
  ConfigError,
  loadConfig,
  loadMatrixBridgeConfig,
  type MatrixBridgeConfig,
} from '../config.js';
import {
  RegistrationParseError,
  parseAppserviceRegistration,
  validateDeploymentConfig,
} from '../deploy/preflight.js';
import type { AppLogger } from '../logger.js';
import {
  MatrixAdminArgumentError,
  runMatrixAdmin,
  runMatrixAdminCommand,
} from '../matrix/admin.js';
import { MatrixAppserviceServer, type MatrixEvent } from '../matrix/appservice.js';
import { MatrixClient } from '../matrix/client.js';
import { BridgeMetrics } from '../matrix/metrics.js';

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

const silentLogger: AppLogger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

const validEnv: NodeJS.ProcessEnv = {
  QQBOT_APP_ID: '10000',
  QQBOT_APP_SECRET: 'test-secret',
  CHAT_LOG_ENABLED: 'false',
  LOG_FILE: 'off',
  MATRIX_BRIDGE_ENABLED: 'true',
  MATRIX_BRIDGE_ID: 'al1s-test',
  MATRIX_BRIDGE_HOMESERVER_URL: 'http://matrix.test',
  MATRIX_BRIDGE_DOMAIN: 'matrix.test',
  MATRIX_BRIDGE_AS_TOKEN: 'as-token',
  MATRIX_BRIDGE_HS_TOKEN: 'hs-token',
  MATRIX_BRIDGE_SENDER_LOCALPART: '_al1s_qq',
  MATRIX_BRIDGE_IDENTITY_SECRET: '0123456789abcdef',
  MATRIX_BRIDGE_ALLOWED_SENDERS:
    '@alice:matrix.test,@bob:matrix.test,@carol:matrix.test,@dave:matrix.test',
  MATRIX_BRIDGE_MIN_POWER_LEVEL: '10',
  MATRIX_BRIDGE_LISTEN_HOST: '127.0.0.1',
  MATRIX_BRIDGE_PORT: '29328',
};

function captureConfigError(env: NodeJS.ProcessEnv): boolean {
  try {
    loadConfig(env);
    return false;
  } catch (error) {
    return error instanceof ConfigError;
  }
}

function deploymentRegistrationYaml(options: {
  id?: string;
  url?: string;
  domain?: string;
  asToken?: string;
  hsToken?: string;
  senderLocalpart?: string;
  receiveEphemeral?: boolean;
  userPrefix?: string;
  aliasPrefix?: string;
  userRegex?: string;
  aliasRegex?: string;
}): string {
  const id = options.id ?? 'al1s-deploy-check';
  const url = options.url ?? 'http://bridge:29328';
  const domain = options.domain ?? 'matrix.test';
  const asToken = options.asToken ?? `as_${'a'.repeat(40)}`;
  const hsToken = options.hsToken ?? `hs_${'b'.repeat(40)}`;
  const senderLocalpart = options.senderLocalpart ?? '_al1s_qq';
  const userPrefix = options.userPrefix ?? '_qq_';
  const aliasPrefix = options.aliasPrefix ?? '_qq_';
  const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const userRegex = options.userRegex ?? `^@${userPrefix}[0-9a-f]{64}:${escapedDomain}$`;
  const aliasRegex = options.aliasRegex ?? `^#${aliasPrefix}[0-9a-f]{64}:${escapedDomain}$`;
  return [
    `id: ${id}`,
    `url: ${url}`,
    `as_token: ${asToken}`,
    `hs_token: ${hsToken}`,
    `sender_localpart: ${senderLocalpart}`,
    `receive_ephemeral: ${String(options.receiveEphemeral ?? false)}`,
    '',
    'namespaces:',
    '  users:',
    '    - exclusive: true',
    `      regex: '${userRegex}'`,
    '  aliases:',
    '    - exclusive: true',
    `      regex: '${aliasRegex}'`,
    '  rooms: []',
    '',
  ].join('\n');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): URL {
  if (typeof input === 'string') {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function requestBody(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

interface CapturedRequest {
  method: string;
  url: URL;
  body: unknown;
}

interface MockMatrixState {
  requests: CapturedRequest[];
  createRooms: unknown[];
  sentEvents: unknown[];
  uploads: unknown[];
  roomMembers: Map<string, string>;
  powerLevels: {
    users_default: number;
    users: Record<string, number>;
  };
}

function roomMemberKey(roomId: string, userId: string): string {
  return `${roomId}\0${userId}`;
}

function createMockMatrixFetch(state: MockMatrixState): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = requestBody(init);
    state.requests.push({ method, url, body });

    if (url.hostname === 'qq.test') {
      const body =
        url.pathname === '/image.png' || url.pathname === '/same-image.png'
          ? Uint8Array.from([1, 2, 3, 4])
          : Uint8Array.from(
              createHash('sha256').update(url.pathname).digest().subarray(0, 8),
            );
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    if (url.hostname !== 'matrix.test') {
      throw new Error(`unexpected request host: ${url.hostname}`);
    }

    if (method === 'PUT' && url.pathname.includes('/profile/')) {
      return jsonResponse({});
    }
    if (method === 'GET' && url.pathname.startsWith('/_matrix/client/v3/directory/room/')) {
      return jsonResponse({ errcode: 'M_NOT_FOUND', error: 'not found' }, 404);
    }
    const memberMatch =
      method === 'GET'
        ? /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/m\.room\.member\/([^/]+)$/.exec(
            url.pathname,
          )
        : null;
    if (memberMatch !== null) {
      const roomId = decodeURIComponent(memberMatch[1] ?? '');
      const userId = decodeURIComponent(memberMatch[2] ?? '');
      const membership = state.roomMembers.get(roomMemberKey(roomId, userId));
      return membership === undefined
        ? jsonResponse({ errcode: 'M_NOT_FOUND', error: 'member state not found' }, 404)
        : jsonResponse({ membership });
    }
    const powerMatch =
      method === 'GET'
        ? /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/m\.room\.power_levels$/.exec(
            url.pathname,
          )
        : null;
    if (powerMatch !== null) {
      return jsonResponse(state.powerLevels);
    }
    if (method === 'POST' && url.pathname === '/_matrix/client/v3/createRoom') {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      state.createRooms.push(body);
      const roomNumber = state.createRooms.length;
      const roomId =
        roomNumber === 1
          ? '!qq-room:matrix.test'
          : `!qq-room-${String(roomNumber)}:matrix.test`;
      return jsonResponse({ room_id: roomId, room_alias: '#_qq_test:matrix.test' });
    }
    if (method === 'POST' && url.pathname.startsWith('/_matrix/client/v3/join/')) {
      return jsonResponse({ room_id: '!qq-room:matrix.test' });
    }
    if (method === 'POST' && url.pathname.endsWith('/invite')) {
      return jsonResponse({});
    }
    if (method === 'POST' && url.pathname.endsWith('/kick')) {
      return jsonResponse({});
    }
    if (method === 'PUT' && url.pathname.includes('/send/')) {
      state.sentEvents.push({ body, url });
      return jsonResponse({ event_id: `$event-${String(state.sentEvents.length)}` });
    }
    if (method === 'POST' && url.pathname === '/_matrix/media/v3/upload') {
      state.uploads.push({ url });
      return jsonResponse({
        content_uri: `mxc://matrix.test/uploaded-${String(state.uploads.length)}`,
      });
    }
    if (method === 'GET' && url.pathname.startsWith('/_matrix/client/v1/media/download/')) {
      return new Response(Uint8Array.from([9, 8, 7]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    throw new Error(`unhandled Matrix request: ${method} ${url.pathname}`);
  };
}

function groupMessage(
  messageId: string,
  senderId: string,
  content: string,
  attachments?: QQBotInboundMessage['attachments'],
  groupOpenid = 'GROUP-OPENID',
): QQBotInboundMessage {
  return {
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    kind: 'group',
    senderId,
    senderName: '测试用户',
    content,
    messageId,
    timestamp: '2026-09-27T10:00:00+08:00',
    groupOpenid,
    ...(attachments !== undefined ? { attachments } : {}),
    replyTarget: { scope: 'group', targetId: groupOpenid, msgId: messageId },
    raw: {
      id: messageId,
      content,
      timestamp: '2026-09-27T10:00:00+08:00',
      author: { member_openid: senderId, username: '测试用户', bot: false },
      group_openid: groupOpenid,
    },
  };
}

function c2cMessage(
  messageId: string,
  senderId: string,
  content: string,
  rawUsername?: string,
): QQBotInboundMessage {
  return {
    rawEventType: 'C2C_MESSAGE_CREATE',
    kind: 'c2c',
    senderId,
    content,
    messageId,
    timestamp: '2026-09-27T10:00:00+08:00',
    replyTarget: { scope: 'c2c', targetId: senderId, msgId: messageId },
    raw: {
      id: messageId,
      content,
      timestamp: '2026-09-27T10:00:00+08:00',
      author: {
        user_openid: senderId,
        ...(rawUsername === undefined ? {} : { username: rawUsername }),
      },
    } as unknown as QQBotInboundMessage['raw'],
  };
}

function guildMessage(
  messageId: string,
  senderId: string,
  content: string,
  guildId = 'GUILD',
  channelId = 'CHANNEL',
): QQBotInboundMessage {
  return {
    rawEventType: 'AT_MESSAGE_CREATE',
    kind: 'guild',
    senderId,
    senderName: '频道用户',
    content,
    messageId,
    timestamp: '2026-09-27T10:00:00+08:00',
    guildId,
    channelId,
    replyTarget: { scope: 'guild', targetId: channelId, msgId: messageId },
    raw: {
      id: messageId,
      content,
      timestamp: '2026-09-27T10:00:00+08:00',
      author: { id: senderId, username: '频道用户', bot: false },
      guild_id: guildId,
      channel_id: channelId,
    },
  };
}

function dmMessage(
  messageId: string,
  senderId: string,
  content: string,
  guildId = 'DM-GUILD',
): QQBotInboundMessage {
  return {
    rawEventType: 'DIRECT_MESSAGE_CREATE',
    kind: 'dm',
    senderId,
    senderName: '私信用户',
    content,
    messageId,
    timestamp: '2026-09-27T10:00:00+08:00',
    guildId,
    channelId: 'DM-CHANNEL',
    replyTarget: { scope: 'dm', targetId: guildId, msgId: messageId },
    raw: {
      id: messageId,
      content,
      timestamp: '2026-09-27T10:00:00+08:00',
      author: { id: senderId, username: '私信用户', bot: false },
      guild_id: guildId,
      channel_id: 'DM-CHANNEL',
    },
  };
}

/**
 * 构造带 `message_type`、`msg_elements`、`ark_data` 等原始字段的群消息。
 *
 * SDK 的 `InboundMsgElement` 未声明嵌套字段，这里通过 `raw` 透传完整平台
 * 事件，模拟真实推送结构。
 */
function structuredGroupMessage(
  messageId: string,
  senderId: string,
  content: string,
  rawExtra: Record<string, unknown>,
  groupOpenid = 'GROUP-STRUCTURED',
): QQBotInboundMessage {
  const base = groupMessage(messageId, senderId, content, undefined, groupOpenid);
  const msgElements = rawExtra['msg_elements'];
  const messageType = rawExtra['message_type'];
  return {
    ...base,
    ...(typeof messageType === 'number' ? { msgType: messageType } : {}),
    ...(Array.isArray(msgElements)
      ? { msgElements: msgElements as NonNullable<QQBotInboundMessage['msgElements']> }
      : {}),
    raw: {
      ...(base.raw as unknown as Record<string, unknown>),
      ...rawExtra,
    } as unknown as QQBotInboundMessage['raw'],
  };
}

function qqApiError(code: number): ApiError {
  return new ApiError(`QQ API error ${String(code)}`, 400, '/v2/messages', code);
}

// ---------------------------------------------------------------------------
section('配置解析');

check('默认不启用 Matrix bridge', loadConfig({ QQBOT_APP_ID: '1', QQBOT_APP_SECRET: 'x' }).matrixBridge === undefined);
check('启用后解析 Matrix 配置', loadConfig(validEnv).matrixBridge?.domain === 'matrix.test');
const matrixOnlyEnv = { ...validEnv };
delete matrixOnlyEnv.QQBOT_APP_ID;
delete matrixOnlyEnv.QQBOT_APP_SECRET;
check(
  'Matrix 管理配置不依赖 QQ 凭据',
  loadMatrixBridgeConfig(matrixOnlyEnv)?.domain === 'matrix.test',
);

const missingTokenEnv = { ...validEnv };
delete missingTokenEnv.MATRIX_BRIDGE_HS_TOKEN;
check('缺少 hs_token 时拒绝启动', captureConfigError(missingTokenEnv));

const shortSecretEnv = { ...validEnv, MATRIX_BRIDGE_IDENTITY_SECRET: 'short' };
check('拒绝过短的 identity secret', captureConfigError(shortSecretEnv));

const invalidUrlEnv = { ...validEnv, MATRIX_BRIDGE_HOMESERVER_URL: 'ftp://matrix.test' };
check('拒绝非 HTTP(S) homeserver URL', captureConfigError(invalidUrlEnv));

const invalidPrefixEnv = { ...validEnv, MATRIX_BRIDGE_USER_PREFIX: '@bad' };
check('拒绝非法 localpart 前缀', captureConfigError(invalidPrefixEnv));

const emptyAllowedEnv = { ...validEnv, MATRIX_BRIDGE_ALLOWED_SENDERS: '' };
check(
  '未配置 Matrix 发送者时默认拒绝',
  loadConfig(emptyAllowedEnv).matrixBridge?.allowedSenders.length === 0,
);

const wildcardAllowedEnv = { ...validEnv, MATRIX_BRIDGE_ALLOWED_SENDERS: '*' };
check(
  '支持显式允许所有 Matrix 发送者',
  loadConfig(wildcardAllowedEnv).matrixBridge?.allowedSenders[0] === '*',
);

const invalidAllowedEnv = { ...validEnv, MATRIX_BRIDGE_ALLOWED_SENDERS: 'alice' };
check('拒绝非法 Matrix 发送者', captureConfigError(invalidAllowedEnv));

const invalidPowerLevelEnv = { ...validEnv, MATRIX_BRIDGE_MIN_POWER_LEVEL: '-1' };
check('拒绝非法 Matrix power level', captureConfigError(invalidPowerLevelEnv));

const referenceConfigEnv = {
  ...validEnv,
  MATRIX_BRIDGE_REFERENCE_TTL_DAYS: '7',
  MATRIX_BRIDGE_REFERENCE_MAX_ENTRIES: '123',
};
const referenceConfig = loadConfig(referenceConfigEnv).matrixBridge;
check(
  '解析引用映射保留策略',
  referenceConfig?.referenceTtlMs === 7 * 24 * 60 * 60 * 1000 &&
    referenceConfig.maxReferences === 123,
);

const invalidReferenceTtlEnv = {
  ...validEnv,
  MATRIX_BRIDGE_REFERENCE_TTL_DAYS: '-1',
};
check('拒绝非法引用映射保留天数', captureConfigError(invalidReferenceTtlEnv));

const queueConfigEnv = {
  ...validEnv,
  MATRIX_BRIDGE_QQ_RETRY_BASE_MS: '123',
  MATRIX_BRIDGE_QQ_RETRY_MAX_MS: '456',
  MATRIX_BRIDGE_QQ_RETRY_INTERVAL_MS: '789',
  MATRIX_BRIDGE_QQ_QUEUE_MAX_ENTRIES: '321',
};
const queueConfig = loadConfig(queueConfigEnv).matrixBridge;
check(
  '解析 QQ 入站重试与队列配置',
  queueConfig?.qqInboundRetryBaseMs === 123 &&
    queueConfig.qqInboundRetryMaxMs === 456 &&
    queueConfig.qqInboundReplayIntervalMs === 789 &&
    queueConfig.qqInboundQueueMaxEntries === 321,
);

const bridgeConfig = loadConfig(validEnv).matrixBridge as MatrixBridgeConfig;

// ---------------------------------------------------------------------------
section('部署前配置检查');

const deploymentEnv: NodeJS.ProcessEnv = {
  ...validEnv,
  MATRIX_BRIDGE_ID: 'al1s-deploy-check',
  MATRIX_BRIDGE_AS_TOKEN: `as_${'a'.repeat(40)}`,
  MATRIX_BRIDGE_HS_TOKEN: `hs_${'b'.repeat(40)}`,
  MATRIX_BRIDGE_IDENTITY_SECRET: `identity_${'c'.repeat(40)}`,
  MATRIX_BRIDGE_ALLOWED_SENDERS: '@alice:matrix.test',
};
const deploymentConfig = loadConfig(deploymentEnv).matrixBridge as MatrixBridgeConfig;
const deploymentRegistration = parseAppserviceRegistration(deploymentRegistrationYaml({}));
const deploymentResult = validateDeploymentConfig({
  config: deploymentConfig,
  registration: deploymentRegistration,
  expectedBridgeUrl: 'http://bridge:29328',
});
check(
  '部署前检查接受匹配的 registration 与 .env',
  deploymentResult.errors.length === 0 &&
    deploymentResult.warnings.length === 0 &&
    deploymentRegistration.users[0]?.exclusive === true,
  JSON.stringify(deploymentResult),
);

const mismatchedTokenRegistration = parseAppserviceRegistration(
  deploymentRegistrationYaml({ hsToken: `hs_${'d'.repeat(40)}` }),
);
check(
  '部署前检查拒绝 token 不一致',
  validateDeploymentConfig({
    config: deploymentConfig,
    registration: mismatchedTokenRegistration,
    expectedBridgeUrl: 'http://bridge:29328',
  }).errors.some((error) => error.includes('hs_token')),
);

const mismatchedNamespaceRegistration = parseAppserviceRegistration(
  deploymentRegistrationYaml({ userPrefix: '_other_' }),
);
check(
  '部署前检查拒绝 namespace 不匹配',
  validateDeploymentConfig({
    config: deploymentConfig,
    registration: mismatchedNamespaceRegistration,
    expectedBridgeUrl: 'http://bridge:29328',
  }).errors.some((error) => error.includes('users namespace')),
);

const hostRegistration = parseAppserviceRegistration(
  deploymentRegistrationYaml({ url: 'http://127.0.0.1:29328' }),
);
check(
  '部署前检查拒绝错误的部署模式 URL',
  validateDeploymentConfig({
    config: deploymentConfig,
    registration: hostRegistration,
    expectedBridgeUrl: 'http://bridge:29328',
  }).errors.some((error) => error.includes('registration url')),
);

const weakToken = `replace-${'e'.repeat(40)}`;
const weakTokenEnv = {
  ...deploymentEnv,
  MATRIX_BRIDGE_AS_TOKEN: weakToken,
};
const weakTokenConfig = loadConfig(weakTokenEnv).matrixBridge as MatrixBridgeConfig;
check(
  '部署前检查拒绝模板 token',
  validateDeploymentConfig({
    config: weakTokenConfig,
    registration: parseAppserviceRegistration(
      deploymentRegistrationYaml({ asToken: weakToken }),
    ),
    expectedBridgeUrl: 'http://bridge:29328',
  }).errors.some((error) => error.includes('MATRIX_BRIDGE_AS_TOKEN')),
);

let malformedRegistrationRejected = false;
try {
  parseAppserviceRegistration(
    deploymentRegistrationYaml({}).replace('      regex: ', '      invalid: '),
  );
} catch (error) {
  malformedRegistrationRejected = error instanceof RegistrationParseError;
}
check('部署前检查拒绝缺少 namespace regex 的 registration', malformedRegistrationRejected);

// ---------------------------------------------------------------------------
section('桥接映射与幂等');

const dataDir = mkdtempSync(join(tmpdir(), 'al1s-matrix-'));
const storeFile = join(dataDir, 'state.json');
const metrics = new BridgeMetrics();
const store = new BridgeStore({
  file: storeFile,
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
  metrics,
});
const matrixState: MockMatrixState = {
  requests: [],
  createRooms: [],
  sentEvents: [],
  uploads: [],
  roomMembers: new Map([
    [roomMemberKey('!qq-room:matrix.test', '@alice:matrix.test'), 'join'],
    [roomMemberKey('!qq-room:matrix.test', '@bob:matrix.test'), 'join'],
    [roomMemberKey('!qq-room:matrix.test', '@carol:matrix.test'), 'join'],
  ]),
  powerLevels: {
    users_default: 0,
    users: {
      '@alice:matrix.test': 50,
      '@bob:matrix.test': 10,
      '@carol:matrix.test': 0,
    },
  },
};
const mockFetch = createMockMatrixFetch(matrixState);
const matrix = new MatrixClient(
  {
    homeserverUrl: bridgeConfig.homeserverUrl,
    accessToken: bridgeConfig.asToken,
    fetchImpl: mockFetch,
    log: silentLogger,
  },
  bridgeConfig.userId,
);

// ---------------------------------------------------------------------------
section('Matrix 房间成员管理');

const adminStatus = await runMatrixAdmin(matrix, bridgeConfig, {
  action: 'status',
  room: '!qq-room:matrix.test',
  user: '@alice:matrix.test',
});
check(
  '管理状态汇总成员资格、power level 与转发准入',
  adminStatus.action === 'status' &&
    adminStatus.membership === 'join' &&
    adminStatus.powerLevel === 50 &&
    adminStatus.minimumPowerLevel === 10 &&
    adminStatus.globallyAllowed &&
    adminStatus.canForward,
);

const adminRequestStart = matrixState.requests.length;
const inviteResult = await runMatrixAdminCommand(
  [
    'invite',
    '--room',
    '!qq-room:matrix.test',
    '--user',
    '@bob:matrix.test',
    '--actor',
    '@alice:matrix.test',
  ],
  matrix,
  bridgeConfig,
);
const inviteRequest = matrixState.requests[adminRequestStart];
check(
  '管理 CLI 使用 actor 身份邀请成员',
  inviteResult.action === 'invite' &&
    inviteRequest?.method === 'POST' &&
    decodeURIComponent(inviteRequest.url.pathname) ===
      '/_matrix/client/v3/rooms/!qq-room:matrix.test/invite' &&
    inviteRequest.url.searchParams.get('user_id') === '@alice:matrix.test' &&
    JSON.stringify(inviteRequest.body) === '{"user_id":"@bob:matrix.test"}',
);

const kickStart = matrixState.requests.length;
const kickResult = await runMatrixAdminCommand(
  [
    'kick',
    '--room',
    '!qq-room',
    '--user',
    '@bob:matrix.test',
    '--actor',
    '@alice:matrix.test',
    '--reason',
    'policy review',
  ],
  matrix,
  bridgeConfig,
);
const kickRequest = matrixState.requests[kickStart];
check(
  '管理 CLI 使用 actor 身份踢出成员并传递原因',
    kickResult.action === 'kick' &&
    kickRequest?.method === 'POST' &&
    decodeURIComponent(kickRequest.url.pathname) ===
      '/_matrix/client/v3/rooms/!qq-room/kick' &&
    kickRequest.url.searchParams.get('user_id') === '@alice:matrix.test' &&
    JSON.stringify(kickRequest.body) ===
      '{"user_id":"@bob:matrix.test","reason":"policy review"}',
);

const invalidRequestStart = matrixState.requests.length;
let invalidAdminRejected = false;
try {
  await runMatrixAdminCommand(
    ['invite', '--room', '!qq-room:matrix.test', '--user', '@bob:matrix.test'],
    matrix,
    bridgeConfig,
  );
} catch (error) {
  invalidAdminRejected = error instanceof MatrixAdminArgumentError;
}
check(
  '无效管理参数在发起请求前被拒绝',
  invalidAdminRejected && matrixState.requests.length === invalidRequestStart,
);

const replies: Array<{
  target: Parameters<QqBotPort['replyText']>[0];
  content: string;
  messageReference?: string;
}> = [];
const replyAttempts: typeof replies = [];
const replyFailures: unknown[] = [];
const media: Array<Parameters<QqBotPort['sendMedia']>[0]> = [];
const recalls: Array<{
  target: Parameters<QqBotPort['recall']>[0];
  messageId: string;
}> = [];
const messageResponse: MessageResponse = { id: 'qq-reply', timestamp: 1 };
const uploadResponse: UploadMediaResponse = {
  file_uuid: 'file-uuid',
  file_info: 'file-info',
  ttl: 3600,
};
const fakeBot: QqBotPort = {
  replyText: async (target, content, options) => {
    replyAttempts.push({
      target,
      content,
      ...(options?.messageReference !== undefined
        ? { messageReference: options.messageReference }
        : {}),
    });
    if (replyFailures.length > 0) {
      throw replyFailures.shift();
    }
    replySequence += 1;
    replies.push({
      target,
      content,
      ...(options?.messageReference !== undefined
        ? { messageReference: options.messageReference }
        : {}),
    });
    return {
      ...messageResponse,
      ext_info: { ref_idx: `REFIDX-qq-${String(replySequence)}` },
    };
  },
  sendMedia: async (options) => {
    media.push(options);
    replySequence += 1;
    return {
      upload: uploadResponse,
      message: {
        ...messageResponse,
        ext_info: { ref_idx: `REFIDX-qq-${String(replySequence)}` },
      },
    };
  },
  recall: async (target, messageId) => {
    recalls.push({ target, messageId });
  },
};

let replySequence = 0;
const retryDelays: number[] = [];
const bridge = new QqMatrixBridge({
  bot: fakeBot,
  matrix,
  store,
  config: bridgeConfig,
  logger: silentLogger,
  metrics,
  fetchImpl: mockFetch,
  maxMediaBytes: 1024 * 1024,
  qqRetryBaseDelayMs: 0,
  sleepImpl: async (delayMs) => {
    retryDelays.push(delayMs);
  },
});

const existingMappedRoomId = '!existing-mapped-room:matrix.test';
await store.setRoom({
  key: 'group:EXISTING-MAPPED-GROUP',
  kind: 'group',
  targetId: 'EXISTING-MAPPED-GROUP',
  roomId: existingMappedRoomId,
  alias: '#_qq_existing:matrix.test',
  createdAt: new Date().toISOString(),
});
matrixState.roomMembers.set(
  roomMemberKey(existingMappedRoomId, '@alice:matrix.test'),
  'join',
);
matrixState.roomMembers.set(
  roomMemberKey(existingMappedRoomId, '@bob:matrix.test'),
  'invite',
);
const reconcileRequestStart = matrixState.requests.length;
await bridge.start();
await bridge.stop();
const reconciledInvites = matrixState.requests
  .slice(reconcileRequestStart)
  .filter(
    (request) =>
      request.method === 'POST' &&
      decodeURIComponent(request.url.pathname) ===
        `/_matrix/client/v3/rooms/${existingMappedRoomId}/invite`,
  );
const reconciledInviteUsers = reconciledInvites.map((request) =>
  typeof request.body === 'object' && request.body !== null
    ? (request.body as Record<string, unknown>)['user_id']
    : undefined,
);
check(
  '启动时为已有映射房间邀请缺失的显式用户',
  reconciledInviteUsers.includes('@carol:matrix.test') &&
    reconciledInviteUsers.includes('@dave:matrix.test') &&
    !reconciledInviteUsers.includes('@alice:matrix.test') &&
    !reconciledInviteUsers.includes('@bob:matrix.test') &&
    reconciledInvites.every(
      (request) => request.url.searchParams.get('user_id') === bridgeConfig.userId,
    ),
);

const firstMessage = {
  ...groupMessage('qq-message-1', 'QQ-SENDER-1', 'hello matrix'),
  msgIdx: 'REFIDX-qq-user-1',
};
await bridge.handleQqMessage(firstMessage);

const expectedGhost = `@${deriveGhostLocalpart(
  bridgeConfig.identitySecret,
  'QQ-SENDER-1',
  bridgeConfig.userPrefix,
)}:${bridgeConfig.domain}`;
const firstSend = matrixState.sentEvents[0] as
  | { body?: { msgtype?: string; body?: string }; url?: URL }
  | undefined;
const firstRoomBody = matrixState.createRooms[0] as { invite?: string[] } | undefined;
check('QQ 群聊创建 Matrix room', matrixState.createRooms.length === 1);
check(
  '新 Matrix room 邀请 bridge 与显式允许的用户',
  firstRoomBody?.invite?.includes(bridgeConfig.userId) === true &&
    firstRoomBody.invite.includes('@alice:matrix.test') &&
    firstRoomBody.invite.includes('@bob:matrix.test') &&
    firstRoomBody.invite.includes('@carol:matrix.test') &&
    firstRoomBody.invite.includes('@dave:matrix.test') &&
    !firstRoomBody.invite.includes('*'),
);
check('QQ 文本发送为 m.text', firstSend?.body?.msgtype === 'm.text' && firstSend.body.body === 'hello matrix');
check('Matrix ghost 身份不可逆', firstSend?.url?.searchParams.get('user_id') === expectedGhost);
check('room alias 使用配置前缀', JSON.stringify(matrixState.createRooms[0]).includes('_qq_'));
const firstDisplayNameRequest = matrixState.requests.find(
  (request) =>
    request.method === 'PUT' &&
    request.url.pathname.includes('/profile/') &&
    request.url.searchParams.get('user_id') === expectedGhost,
);
check(
  'QQ 消息更新 Matrix ghost 显示名',
  JSON.stringify(firstDisplayNameRequest?.body) === '{"displayname":"测试用户"}',
);

await bridge.handleQqMessage({
  ...groupMessage('qq-message-quote', 'QQ-SENDER-2', 'quoted reply'),
  refMsgIdx: 'REFIDX-qq-user-1',
  msgElements: [{ msg_idx: 'REFIDX-qq-user-1', content: 'hello matrix' }],
});
const quotedSend = matrixState.sentEvents[1] as
  | { body?: { body?: string; 'm.relates_to'?: { event_id?: string } } }
  | undefined;
check(
  'QQ 引用映射到对应 Matrix 事件',
  quotedSend?.body?.['m.relates_to']?.event_id === '$event-1',
);
check(
  '已知 QQ 引用不再重复写入 Matrix fallback 正文',
  quotedSend?.body?.body === 'quoted reply',
);

const persistedState = JSON.parse(readFileSync(storeFile, 'utf8')) as Record<string, unknown>;
const persistedText = JSON.stringify(persistedState);
check(
  '状态 schema 为 v7 且不含旧 users 映射',
  persistedState.version === 7 &&
    typeof persistedState.pendingQqMessages === 'object' &&
    typeof persistedState.matrixMedia === 'object' &&
    !('users' in persistedState),
);
check(
  '状态文件不包含 QQ openid 或 message ID',
  !persistedText.includes('GROUP-OPENID') &&
    !persistedText.includes('QQ-SENDER-1') &&
    !persistedText.includes('qq-message-1'),
);

const sentBeforeDuplicate = matrixState.sentEvents.length;
await bridge.handleQqMessage(firstMessage);
check('重复 QQ message ID 不重复发送', matrixState.sentEvents.length === sentBeforeDuplicate);

const expectedSecondGhost = `@${deriveGhostLocalpart(
  bridgeConfig.identitySecret,
  'QQ-SENDER-2',
  bridgeConfig.userPrefix,
)}:${bridgeConfig.domain}`;
const displayNameRequestsBeforeSecond = matrixState.requests.filter(
  (request) =>
    request.method === 'PUT' &&
    request.url.pathname.includes('/profile/') &&
    request.url.searchParams.get('user_id') === expectedSecondGhost,
).length;
await bridge.handleQqMessage(groupMessage('qq-message-2', 'QQ-SENDER-2', 'second user'));
const displayNameRequestsAfterSecond = matrixState.requests.filter(
  (request) =>
    request.method === 'PUT' &&
    request.url.pathname.includes('/profile/') &&
    request.url.searchParams.get('user_id') === expectedSecondGhost,
).length;
check('同群复用 Matrix room', matrixState.createRooms.length === 1);
check(
  '已有 room 的后续 QQ 消息继续刷新 ghost 显示名',
  displayNameRequestsAfterSecond === displayNameRequestsBeforeSecond + 1,
);
check(
  '不同 QQ 用户使用不同 ghost',
  JSON.stringify(matrixState.sentEvents.at(-1)).includes('user_id') &&
    !JSON.stringify(matrixState.sentEvents.at(-1)).includes(expectedGhost),
);

await Promise.all([
  bridge.handleQqMessage(
    groupMessage('qq-message-3', 'QQ-SENDER-1', '', [
      { content_type: 'image/png', url: 'http://qq.test/image.png', filename: 'image.png' },
    ]),
  ),
  bridge.handleQqMessage(
    groupMessage('qq-message-4', 'QQ-SENDER-1', '', [
      { content_type: 'image/png', url: 'http://qq.test/same-image.png', filename: 'same-image.png' },
    ]),
  ),
]);
check('QQ 图片上传到 Matrix', matrixState.uploads.length === 1);
const imageEventUrls = matrixState.sentEvents
  .map((event) =>
    event !== null && typeof event === 'object'
      ? (event as { body?: { msgtype?: string; url?: string } }).body
      : undefined,
  )
  .filter((body) => body?.msgtype === 'm.image')
  .map((body) => body?.url);
check(
  '相同 QQ 图片的两个事件复用 mxc URI',
  imageEventUrls.length === 2 &&
    imageEventUrls[0] === 'mxc://matrix.test/uploaded-1' &&
    imageEventUrls[1] === imageEventUrls[0],
);
check(
  '相同 QQ 图片并发转发只上传一次',
  JSON.stringify(matrixState.sentEvents.at(-1)).includes('"msgtype":"m.image"') &&
    JSON.stringify(matrixState.sentEvents.at(-1)).includes('mxc://matrix.test/uploaded-1'),
);
const bridgeMetrics = metrics.render();
check(
  '指标导出 QQ 消息与媒体计数',
  bridgeMetrics.includes(
    'al1s_matrix_bridge_qq_messages_total{kind="group",result="forwarded"} 5',
  ) &&
    bridgeMetrics.includes(
      'al1s_matrix_bridge_qq_messages_total{kind="group",result="duplicate"} 1',
    ) &&
    bridgeMetrics.includes(
      'al1s_matrix_bridge_media_bytes_total{direction="qq_to_matrix"} 8',
    ),
);
check(
  '指标不包含 QQ 身份或会话标识',
  !bridgeMetrics.includes('QQ-SENDER-1') &&
    !bridgeMetrics.includes('GROUP-OPENID') &&
    !bridgeMetrics.includes('qq-message-1'),
);
check(
  '指标记录成功状态写入',
  bridgeMetrics.includes('al1s_matrix_bridge_state_writes_total{result="success"}') &&
    /al1s_matrix_bridge_last_successful_state_write_timestamp_seconds [1-9]\d*(?:\.\d+)?\n/.test(
      bridgeMetrics,
  ),
);
await bridge.handleQqMessage(
  groupMessage('qq-passive-window', 'QQ-SENDER-1', 'refresh passive reply window'),
);

// ---------------------------------------------------------------------------
section('Guild / DM 桥接');

await bridge.handleQqMessage(
  guildMessage('qq-guild-a', 'GUILD-SENDER-A', 'guild a', 'GUILD-A', 'CHANNEL-SHARED'),
);
await bridge.handleQqMessage(
  guildMessage('qq-guild-b', 'GUILD-SENDER-B', 'guild b', 'GUILD-B', 'CHANNEL-SHARED'),
);
await bridge.handleQqMessage(
  dmMessage('qq-dm-a', 'DM-SENDER-A', 'dm a', 'DM-GUILD'),
);

const guildRoomA = store.getRoom(conversationKey('guild', 'GUILD-A/CHANNEL-SHARED'));
const guildRoomB = store.getRoom(conversationKey('guild', 'GUILD-B/CHANNEL-SHARED'));
const dmRoom = store.getRoom(conversationKey('dm', 'DM-GUILD'));
check(
  '同 channel ID、不同 guild 创建不同 Matrix room',
  guildRoomA !== undefined &&
    guildRoomB !== undefined &&
    guildRoomA.roomId !== guildRoomB.roomId,
);
check(
  'guild room 出站目标保留 channel ID',
  guildRoomA?.targetId === 'CHANNEL-SHARED' && guildRoomA.kind === 'guild',
);
check(
  'DM room 出站目标使用 guild ID',
  dmRoom?.targetId === 'DM-GUILD' && dmRoom.kind === 'dm',
);

const guildRoomBody = matrixState.createRooms[1] as
  | { name?: string; is_direct?: boolean }
  | undefined;
const dmRoomBody = matrixState.createRooms[3] as
  | { name?: string; is_direct?: boolean }
  | undefined;
check(
  'guild room 标记为非 direct',
  guildRoomBody?.name === 'QQ 频道' && guildRoomBody.is_direct === false,
);
check(
  'DM room 标记为 direct',
  dmRoomBody?.name === 'QQ 频道私信' && dmRoomBody.is_direct === true,
);

const c2cNamedGhost = `@${deriveGhostLocalpart(
  bridgeConfig.identitySecret,
  'QQ-C2C-NAMED',
  bridgeConfig.userPrefix,
)}:${bridgeConfig.domain}`;
await bridge.handleQqMessage(
  c2cMessage('qq-c2c-named', 'QQ-C2C-NAMED', 'named c2c user', '单聊用户名'),
);
const c2cRoomBody = matrixState.createRooms.at(-1) as
  | { invite?: string[]; is_direct?: boolean; name?: string }
  | undefined;
const c2cNamedDisplayNameRequest = [...matrixState.requests].reverse().find(
  (request) =>
    request.method === 'PUT' &&
    request.url.pathname.includes('/profile/') &&
    request.url.searchParams.get('user_id') === c2cNamedGhost,
);
check(
  'C2C 新 room 邀请显式允许用户且不包含通配符',
  c2cRoomBody?.is_direct === true &&
    c2cRoomBody.invite?.includes('@alice:matrix.test') === true &&
    c2cRoomBody.invite.includes('@dave:matrix.test') &&
    !c2cRoomBody.invite.includes('*'),
);
check(
  'C2C 缺少 senderName 时回退到 raw author.username',
  JSON.stringify(c2cNamedDisplayNameRequest?.body) ===
    '{"displayname":"单聊用户名"}',
);

const c2cFallbackGhost = `@${deriveGhostLocalpart(
  bridgeConfig.identitySecret,
  'QQ-C2C-FALLBACK',
  bridgeConfig.userPrefix,
)}:${bridgeConfig.domain}`;
await bridge.handleQqMessage(
  c2cMessage('qq-c2c-fallback', 'QQ-C2C-FALLBACK', 'anonymous c2c user'),
);
const c2cFallbackDisplayNameRequest = [...matrixState.requests].reverse().find(
  (request) =>
    request.method === 'PUT' &&
    request.url.pathname.includes('/profile/') &&
    request.url.searchParams.get('user_id') === c2cFallbackGhost,
);
const c2cFallbackDisplayName =
  typeof c2cFallbackDisplayNameRequest?.body === 'object' &&
  c2cFallbackDisplayNameRequest.body !== null
    ? (c2cFallbackDisplayNameRequest.body as Record<string, unknown>)['displayname']
    : undefined;
check(
  'C2C 无用户名时使用稳定短标识而不是 ghost localpart',
  typeof c2cFallbackDisplayName === 'string' &&
    /^QQ 用户 [0-9a-f]{8}$/.test(c2cFallbackDisplayName) &&
    !c2cFallbackDisplayName.includes('QQ-C2C-FALLBACK'),
);

if (guildRoomA === undefined || guildRoomB === undefined || dmRoom === undefined) {
  throw new Error('缺少 guild/DM room 映射');
}
matrixState.roomMembers.set(roomMemberKey(guildRoomA.roomId, '@alice:matrix.test'), 'join');
matrixState.roomMembers.set(roomMemberKey(dmRoom.roomId, '@alice:matrix.test'), 'join');

await bridge.handleTransaction('txn-guild-text', {
  events: [
    {
      type: 'm.room.message',
      room_id: guildRoomA.roomId,
      sender: '@alice:matrix.test',
      event_id: '$matrix-guild-text',
      content: { msgtype: 'm.text', body: 'hello guild' },
    },
  ],
});
check(
  'Matrix guild room 文本路由到 channel',
  replies.at(-1)?.target.scope === 'guild' &&
    replies.at(-1)?.target.targetId === 'CHANNEL-SHARED' &&
    replies.at(-1)?.target.msgId === 'qq-guild-a',
);

await bridge.handleTransaction('txn-dm-text', {
  events: [
    {
      type: 'm.room.message',
      room_id: dmRoom.roomId,
      sender: '@alice:matrix.test',
      event_id: '$matrix-dm-text',
      content: { msgtype: 'm.text', body: 'hello dm' },
    },
  ],
});
check(
  'Matrix DM room 文本路由到 guild DM',
  replies.at(-1)?.target.scope === 'dm' &&
    replies.at(-1)?.target.targetId === 'DM-GUILD' &&
    replies.at(-1)?.target.msgId === 'qq-dm-a',
);

const guildDmMediaBefore = media.length;
await bridge.handleTransaction('txn-guild-dm-media', {
  events: [
    {
      type: 'm.room.message',
      room_id: guildRoomA.roomId,
      sender: '@alice:matrix.test',
      event_id: '$matrix-guild-media',
      content: {
        msgtype: 'm.image',
        body: 'guild.png',
        url: 'mxc://matrix.test/guild-media',
      },
    },
    {
      type: 'm.room.message',
      room_id: dmRoom.roomId,
      sender: '@alice:matrix.test',
      event_id: '$matrix-dm-media',
      content: {
        msgtype: 'm.image',
        body: 'dm.png',
        url: 'mxc://matrix.test/dm-media',
      },
    },
  ],
});
check(
  'guild/DM Matrix 媒体被忽略且 transaction 正常确认',
  media.length === guildDmMediaBefore &&
    store.hasMatrixEvent('$matrix-guild-media') &&
    store.hasMatrixEvent('$matrix-dm-media'),
);

const guildDmMetrics = metrics.render();
check(
  '指标区分 guild 与 DM 入站消息',
  guildDmMetrics.includes(
    'al1s_matrix_bridge_qq_messages_total{kind="guild",result="forwarded"} 2',
  ) &&
    guildDmMetrics.includes(
      'al1s_matrix_bridge_qq_messages_total{kind="dm",result="forwarded"} 1',
    ),
);
const matrixToQqReplyBase = replies.length;

// ---------------------------------------------------------------------------
section('QQ 结构化消息');

const lastSentBody = (): Record<string, unknown> | undefined => {
  const event = matrixState.sentEvents.at(-1) as { body?: Record<string, unknown> } | undefined;
  return event?.body;
};
const bodyTextOf = (body: Record<string, unknown> | undefined): string =>
  typeof body?.['body'] === 'string' ? body['body'] : '';

const cardBefore = matrixState.sentEvents.length;
await bridge.handleQqMessage(
  structuredGroupMessage('qq-card-1', 'QQ-SENDER-1', '', {
    message_type: 3,
    ark_data: {
      ark_name: '图文 H5',
      ark_type: 'tuwen',
      prompt: '看看这个分享',
      fields: {
        title: '今日风景',
        desc: '来自群相册',
        source: 'QQ空间',
        jump_url: 'https://example.invalid/card',
      },
    },
  }),
);
const cardBody = bodyTextOf(lastSentBody());
check(
  'QQ ARK 卡片转换为可读文本回退',
  matrixState.sentEvents.length === cardBefore + 1 &&
    lastSentBody()?.['msgtype'] === 'm.text' &&
    cardBody.includes('[QQ 卡片: 图文 H5]') &&
    cardBody.includes('看看这个分享') &&
    cardBody.includes('title: 今日风景') &&
    cardBody.includes('desc: 来自群相册'),
  `body=${cardBody}`,
);
check(
  'QQ ARK 卡片回退忽略链接与原始 JSON',
  !cardBody.includes('jump_url') &&
    !cardBody.includes('{') &&
    !cardBody.includes('example.invalid'),
);

await bridge.handleQqMessage(
  structuredGroupMessage('qq-card-2', 'QQ-SENDER-1', '分享给你', {
    message_type: 3,
    ark_data: { ark_name: '小程序', ark_type: 'miniapp', fields: { title: '小程序标题' } },
  }),
);
const cardWithTextBody = bodyTextOf(lastSentBody());
check(
  'QQ ARK 卡片正文与卡片字段同时保留',
  cardWithTextBody === '分享给你\n[QQ 卡片: 小程序]\ntitle: 小程序标题',
  `body=${cardWithTextBody}`,
);

await bridge.handleQqMessage(
  structuredGroupMessage('qq-parallel-1', 'QQ-SENDER-2', '', {
    message_type: 101,
    msg_elements: [
      { message_type: 0, content: '第一条并行消息' },
      { message_type: 0, content: '第二条并行消息' },
    ],
  }),
);
const parallelBody = bodyTextOf(lastSentBody());
check(
  'QQ 并行消息合并全部元素文本',
  parallelBody === '第一条并行消息\n第二条并行消息',
  `body=${parallelBody}`,
);

await bridge.handleQqMessage(
  structuredGroupMessage('qq-history-1', 'QQ-SENDER-2', '', {
    message_type: 102,
    msg_elements: [
      {
        message_type: 102,
        content: '=== 聊天记录 ===',
        msg_elements: [{ message_type: 0, content: '嵌套的消息正文' }],
      },
    ],
  }),
);
const historyBody = bodyTextOf(lastSentBody());
check(
  'QQ 聊天记录递归提取嵌套元素',
  historyBody === '=== 聊天记录 ===\n嵌套的消息正文',
  `body=${historyBody}`,
);

const namedFaceTag = '<faceType=3,faceId="495",ext="eyJ0ZXh0Ijoi5YWU5p2lIn0=">';
await bridge.handleQqMessage(
  structuredGroupMessage('qq-face-name', 'QQ-SENDER-2', namedFaceTag, { message_type: 0 }),
);
check(
  'QQ face 标签解码为可读表情名',
  bodyTextOf(lastSentBody()) === '【表情: 兔来】',
  `body=${bodyTextOf(lastSentBody())}`,
);

await bridge.handleQqMessage(
  structuredGroupMessage(
    'qq-face-malformed',
    'QQ-SENDER-2',
    '前 <faceType=1,faceId="1",ext="not-base64"> 中 <unknownType="debug"> 后',
    { message_type: 0 },
  ),
);
const malformedFaceBody = bodyTextOf(lastSentBody());
check(
  '无效 face 与未知结构化标签不会泄漏原始参数',
  malformedFaceBody === '前  中  后' && !malformedFaceBody.includes('Type='),
  `body=${malformedFaceBody}`,
);

const imagePlaceholderFaceTag = '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">';
const faceImageEventsBefore = matrixState.sentEvents.length;
await bridge.handleQqMessage({
  ...structuredGroupMessage(
    'qq-face-image',
    'QQ-SENDER-2',
    imagePlaceholderFaceTag,
    { message_type: 0 },
    'GROUP-FACE',
  ),
  attachments: [
    {
      content_type: 'image/jpeg',
      url: 'http://qq.test/face-image.jpg',
      filename: 'face-image.jpg',
    },
  ],
  msgIdx: 'REFIDX-face-image',
});
const faceImageEvents = matrixState.sentEvents.slice(faceImageEventsBefore);
const faceImageEventId = store.getReference('REFIDX-face-image')?.matrixEventId;
check(
  '空 face 占位符加图片时只发送 Matrix 图片事件',
  faceImageEvents.length === 1 &&
    JSON.stringify(faceImageEvents[0]).includes('"msgtype":"m.image"') &&
    faceImageEventId === `$event-${String(faceImageEventsBefore + 1)}`,
  `events=${String(faceImageEvents.length)}`,
);

const attachmentTypeTag =
  '<attachmentType="image/jpeg",attachmentIndex=0,description="eyJ0ZXh0Ijoi5Y+R6YCB5LqG5LiA5byg5Zu-54mHIn0=">';
const attachmentTypeEventsBefore = matrixState.sentEvents.length;
await bridge.handleQqMessage({
  ...structuredGroupMessage(
    'qq-attachment-type',
    'QQ-SENDER-2',
    attachmentTypeTag,
    { message_type: 0 },
    'GROUP-ATTACHMENT',
  ),
  attachments: [
    {
      content_type: 'image/jpeg',
      url: 'http://qq.test/attachment-type.jpg',
      filename: 'attachment-type.jpg',
    },
  ],
  msgIdx: 'REFIDX-attachment-type',
});
const attachmentTypeEvents = matrixState.sentEvents.slice(attachmentTypeEventsBefore);
check(
  'QQ attachmentType 标签与真实附件合并为单条图片事件',
  attachmentTypeEvents.length === 1 &&
    JSON.stringify(attachmentTypeEvents[0]).includes('"msgtype":"m.image"') &&
    !JSON.stringify(attachmentTypeEvents).includes('attachmentType='),
  `events=${String(attachmentTypeEvents.length)}`,
);

await bridge.handleQqMessage({
  ...groupMessage(
    'qq-structured-target',
    'QQ-SENDER-2',
    '被引用的原文',
    undefined,
    'GROUP-STRUCTURED',
  ),
  msgIdx: 'REFIDX-structured-target',
});
const structuredTargetEventId = store.getReference('REFIDX-structured-target')?.matrixEventId;
await bridge.handleQqMessage({
  ...structuredGroupMessage('qq-quote-103', 'QQ-SENDER-1', '这是新的回复', {
    message_type: 103,
    msg_elements: [{ message_type: 0, content: '被引用的原文' }],
    message_scene: { source: 'default', ext: ['ref_msg_idx=REFIDX-structured-target'] },
  }),
  refMsgIdx: 'REFIDX-structured-target',
});
const quote103Body = bodyTextOf(lastSentBody());
const quote103Event = matrixState.sentEvents.at(-1) as
  | { body?: { 'm.relates_to'?: { event_id?: string } } }
  | undefined;
check(
  'QQ 103 引用映射到 Matrix 事件且正文不重复引用内容',
  quote103Event?.body?.['m.relates_to']?.event_id === structuredTargetEventId &&
    quote103Body === '这是新的回复',
  `body=${quote103Body}`,
);

await bridge.handleQqMessage({
  ...structuredGroupMessage('qq-quote-unknown', 'QQ-SENDER-1', '未知引用回复', {
    message_type: 103,
    msg_elements: [
      {
        message_type: 0,
        author: { username: '引用原作者' },
        content: '没有映射的引用内容',
      },
    ],
  }),
  refMsgIdx: 'REFIDX-unknown-quote',
});
const unknownQuoteBody = bodyTextOf(lastSentBody());
check(
  '未知 QQ 引用保留原作者文本 fallback 且无 relates_to',
  unknownQuoteBody === '> 引用原作者\n> 没有映射的引用内容\n\n未知引用回复' &&
    !JSON.stringify(matrixState.sentEvents.at(-1)).includes('m.relates_to'),
  `body=${unknownQuoteBody}`,
);

const quoteFaceUploadsBefore = matrixState.uploads.length;
const quoteFaceEventsBefore = matrixState.sentEvents.length;
await bridge.handleQqMessage({
  ...structuredGroupMessage(
    'qq-quote-face-image',
    'QQ-SENDER-1',
    '引用这个表情',
    {
      message_type: 103,
      msg_elements: [
        {
          msg_idx: 'REFIDX-face-image',
          message_type: 0,
          content: imagePlaceholderFaceTag,
          attachments: [
            {
              content_type: 'image/jpeg',
              url: 'http://qq.test/quoted-face.jpg',
              filename: 'quoted-face.jpg',
            },
          ],
        },
      ],
    },
    'GROUP-FACE',
  ),
  refMsgIdx: 'REFIDX-face-image',
});
const faceQuoteEvent = matrixState.sentEvents.at(-1) as
  | { body?: { 'm.relates_to'?: { event_id?: string } } }
  | undefined;
const faceQuoteBody = bodyTextOf(lastSentBody());
check(
  '引用 QQ 表情图片时指向原 Matrix 图片事件',
  matrixState.uploads.length === quoteFaceUploadsBefore &&
    matrixState.sentEvents.length === quoteFaceEventsBefore + 1 &&
    faceQuoteEvent?.body?.['m.relates_to']?.event_id === faceImageEventId &&
    faceQuoteBody === '引用这个表情',
  `body=${faceQuoteBody}`,
);

const quoteMediaUploads = matrixState.uploads.length;
await bridge.handleQqMessage({
  ...structuredGroupMessage('qq-quote-media', 'QQ-SENDER-1', '引用图片', {
    message_type: 103,
    msg_elements: [
      {
        message_type: 0,
        content: '被引用的图片',
        attachments: [
          { content_type: 'image/png', url: 'http://qq.test/quoted.png', filename: 'quoted.png' },
        ],
      },
    ],
  }),
  refMsgIdx: 'REFIDX-unknown-media',
});
check(
  '引用元素附件不重复转发',
  matrixState.uploads.length === quoteMediaUploads &&
    bodyTextOf(lastSentBody()).includes('被引用的图片'),
);

const nestedUploadsBefore = matrixState.uploads.length;
const nestedEventsBefore = matrixState.sentEvents.length;
await bridge.handleQqMessage(
  structuredGroupMessage('qq-nested-media', 'QQ-SENDER-2', '', {
    message_type: 101,
    msg_elements: [
      {
        message_type: 0,
        content: '看这张图',
        attachments: [
          { content_type: 'image/png', url: 'http://qq.test/nested.png', filename: 'nested.png' },
        ],
      },
    ],
  }),
);
check(
  'QQ 嵌套元素附件转发到 Matrix',
  matrixState.uploads.length === nestedUploadsBefore + 1 &&
    matrixState.sentEvents.length === nestedEventsBefore + 2 &&
    JSON.stringify(matrixState.sentEvents.at(-1)).includes('"msgtype":"m.image"'),
);

const dedupeUploadsBefore = matrixState.uploads.length;
const dedupeEventsBefore = matrixState.sentEvents.length;
await bridge.handleQqMessage({
  ...groupMessage(
    'qq-dedupe-media',
    'QQ-SENDER-2',
    '重复附件',
    [{ content_type: 'image/png', url: 'http://qq.test/dedupe.png', filename: 'dedupe.png' }],
    'GROUP-STRUCTURED',
  ),
  msgType: 101,
  msgElements: [
    {
      msg_idx: 'REFIDX-dedupe',
      content: '重复附件',
      attachments: [
        { content_type: 'image/png', url: 'http://qq.test/dedupe.png', filename: 'dedupe.png' },
      ],
    },
  ],
});
const dedupeTextEvent = matrixState.sentEvents[dedupeEventsBefore] as
  | { body?: Record<string, unknown> }
  | undefined;
check(
  '顶层与元素重复附件只上传一次且正文去重',
  matrixState.uploads.length === dedupeUploadsBefore + 1 &&
    bodyTextOf(dedupeTextEvent?.body) === '重复附件',
  `uploads=${String(matrixState.uploads.length - dedupeUploadsBefore)}`,
);

const capUploadsBefore = matrixState.uploads.length;
const manyAttachments = Array.from({ length: 20 }, (_unused, index) => ({
  content_type: 'image/png',
  url: `http://qq.test/cap-${String(index)}.png`,
  filename: `cap-${String(index)}.png`,
}));
await bridge.handleQqMessage(
  structuredGroupMessage('qq-attachment-cap', 'QQ-SENDER-2', '附件很多', {
    message_type: 101,
    msg_elements: [{ message_type: 0, content: '附件很多', attachments: manyAttachments }],
  }),
);
check(
  'QQ 结构化附件超过上限时只转发前 16 个',
  matrixState.uploads.length === capUploadsBefore + 16,
  `actual=${String(matrixState.uploads.length - capUploadsBefore)}`,
);

const nestedStructuredElement = (depth: number): Record<string, unknown> => {
  let node: Record<string, unknown> = {
    message_type: 0,
    content: `深度 ${String(depth)} 的文本`,
  };
  for (let level = depth - 1; level >= 0; level -= 1) {
    node = {
      message_type: 102,
      content: `深度 ${String(level)} 的文本`,
      msg_elements: [node],
    };
  }
  return node;
};
await bridge.handleQqMessage(
  structuredGroupMessage('qq-depth-limit', 'QQ-SENDER-2', '', {
    message_type: 102,
    msg_elements: [nestedStructuredElement(6)],
  }),
);
const depthBody = bodyTextOf(lastSentBody());
check(
  'QQ 结构化消息超过递归深度时截断',
  depthBody.includes('深度 4 的文本') &&
    !depthBody.includes('深度 5 的文本') &&
    !depthBody.includes('深度 6 的文本'),
  `body=${depthBody}`,
);

await bridge.handleQqMessage(
  structuredGroupMessage('qq-element-limit', 'QQ-SENDER-2', '', {
    message_type: 101,
    msg_elements: Array.from({ length: 70 }, (_unused, index) => ({
      message_type: 0,
      content: `元素 ${String(index)}`,
    })),
  }),
);
const elementBody = bodyTextOf(lastSentBody());
check(
  'QQ 结构化消息超过元素上限时截断',
  elementBody.includes('元素 63') && !elementBody.includes('元素 64'),
);

await bridge.handleQqMessage(
  structuredGroupMessage('qq-text-limit', 'QQ-SENDER-2', '', {
    message_type: 102,
    msg_elements: [{ message_type: 0, content: 'A'.repeat(5000) }],
  }),
);
const longBody = bodyTextOf(lastSentBody());
check(
  'QQ 结构化文本超长时截断并标记',
  longBody.length <= 4096 && longBody.endsWith('[消息过长，已截断]'),
  `length=${String(longBody.length)}`,
);

const concurrentRoomCount = matrixState.createRooms.length;
const concurrentSendCount = matrixState.sentEvents.length;
await Promise.all([
  bridge.handleQqMessage(
    groupMessage('qq-concurrent-1', 'QQ-SENDER-1', 'first concurrent message', undefined, 'GROUP-CONCURRENT'),
  ),
  bridge.handleQqMessage(
    groupMessage('qq-concurrent-2', 'QQ-SENDER-2', 'second concurrent message', undefined, 'GROUP-CONCURRENT'),
  ),
]);
check(
  '同一 QQ 会话首次并发消息只创建一个 Matrix room',
  matrixState.createRooms.length === concurrentRoomCount + 1,
  `actual=${String(matrixState.createRooms.length - concurrentRoomCount)}`,
);
check(
  '同一 QQ 会话并发消息复用同一 Matrix room',
  matrixState.sentEvents.length === concurrentSendCount + 2,
);

// ---------------------------------------------------------------------------
section('Matrix 到 QQ 与回环防护');

await bridge.handleTransaction('txn-untrusted', {
  events: [
    {
      type: 'm.room.message',
      room_id: '!qq-room:matrix.test',
      sender: '@mallory:matrix.test',
      event_id: '$matrix-untrusted',
      content: { msgtype: 'm.text', body: 'not allowed' },
    },
  ],
});
check('忽略未授权的 Matrix 发送者', replies.length === matrixToQqReplyBase);

await bridge.handleTransaction('txn-not-room-member', {
  events: [
    {
      type: 'm.room.message',
      room_id: '!qq-room:matrix.test',
      sender: '@dave:matrix.test',
      event_id: '$matrix-not-room-member',
      content: { msgtype: 'm.text', body: 'not a room member' },
    },
  ],
});
check('全局允许但未加入目标房间的用户被拒绝', replies.length === matrixToQqReplyBase);

await bridge.handleTransaction('txn-insufficient-power', {
  events: [
    {
      type: 'm.room.message',
      room_id: '!qq-room:matrix.test',
      sender: '@carol:matrix.test',
      event_id: '$matrix-insufficient-power',
      content: { msgtype: 'm.text', body: 'insufficient power' },
    },
  ],
});
check('目标房间内权限不足的成员被拒绝', replies.length === matrixToQqReplyBase);

await store.setRoom({
  key: 'group:OTHER-GROUP',
  kind: 'group',
  targetId: 'OTHER-GROUP',
  roomId: '!other-room:matrix.test',
  alias: '#_qq_other:matrix.test',
  createdAt: new Date().toISOString(),
});
await bridge.handleTransaction('txn-cross-room', {
  events: [
    {
      type: 'm.room.message',
      room_id: '!other-room:matrix.test',
      sender: '@alice:matrix.test',
      event_id: '$matrix-cross-room',
      content: { msgtype: 'm.text', body: 'not a member here' },
    },
  ],
});
check('授权不会跨 Matrix 房间复用', replies.length === matrixToQqReplyBase);

const matrixTextEvent: MatrixEvent = {
  type: 'm.room.message',
  room_id: '!qq-room:matrix.test',
  sender: '@alice:matrix.test',
  event_id: '$matrix-text',
  content: { msgtype: 'm.text', body: 'hello QQ' },
};
await bridge.handleTransaction('txn-1', { events: [matrixTextEvent] });
check(
  'Matrix 文本发送到 QQ',
  replies.length === matrixToQqReplyBase + 1 &&
    replies[matrixToQqReplyBase]?.content === 'hello QQ',
);
check(
  'Matrix 消息使用 QQ 被动回复窗口',
  replies[matrixToQqReplyBase]?.target.msgId === 'qq-passive-window',
  `actual=${replies[matrixToQqReplyBase]?.target.msgId ?? 'none'}`,
);
check('记录 Matrix 事件到 QQ 消息的映射', store.getOutboundMessage('$matrix-text')?.qqMessageId === 'qq-reply');
const matrixTextQqReference = store.getOutboundMessage('$matrix-text')?.qqReference;
check(
  '记录 QQ 回复引用索引',
  matrixTextQqReference?.startsWith('REFIDX-qq-') === true,
  matrixTextQqReference ?? 'missing',
);

await bridge.handleTransaction('txn-matrix-reply', {
  events: [
    {
      type: 'm.room.message',
      room_id: '!qq-room:matrix.test',
      sender: '@alice:matrix.test',
      event_id: '$matrix-reply',
      content: {
        msgtype: 'm.text',
        body: 'matrix reply',
        'm.relates_to': { rel_type: 'm.in_reply_to', event_id: '$matrix-text' },
      },
    },
  ],
});
check(
  'Matrix 引用映射为 QQ message_reference',
  replies[matrixToQqReplyBase + 1]?.messageReference === matrixTextQqReference,
);
const matrixReplyQqReference = store.getQqReference('$matrix-reply');

await bridge.handleQqMessage({
  ...groupMessage('qq-message-quote-bot', 'QQ-SENDER-2', 'reply to bot'),
  refMsgIdx: matrixTextQqReference,
  msgElements: [{ msg_idx: matrixTextQqReference, content: 'hello QQ' }],
});
check(
  'QQ 引用机器人消息映射回原 Matrix 事件',
  JSON.stringify(matrixState.sentEvents.at(-1)).includes('"event_id":"$matrix-text"'),
);

await bridge.handleTransaction('txn-1', { events: [matrixTextEvent] });
await bridge.handleTransaction('txn-2', { events: [matrixTextEvent] });
check('transaction 和 event ID 双重去重', replies.length === matrixToQqReplyBase + 2);

await bridge.handleTransaction('txn-edit', {
  events: [
    {
      type: 'm.room.message',
      room_id: '!qq-room:matrix.test',
      sender: '@alice:matrix.test',
      event_id: '$matrix-edit',
      content: {
        msgtype: 'm.text',
        body: '* edited',
        'm.relates_to': { rel_type: 'm.replace', event_id: '$matrix-text' },
      },
    },
  ],
});
check('忽略 Matrix 编辑，避免重复发送 QQ 消息', replies.length === matrixToQqReplyBase + 2);

await bridge.handleTransaction('txn-redact', {
  events: [
    {
      type: 'm.room.redaction',
      room_id: '!qq-room:matrix.test',
      sender: '@alice:matrix.test',
      event_id: '$matrix-redaction',
      redacts: '$matrix-text',
      content: {},
    },
  ],
});
check(
  'Matrix redaction 撤回对应 QQ 消息',
  recalls.length === 1 &&
    recalls[0]?.messageId === 'qq-reply' &&
    recalls[0].target.scope === 'group' &&
    recalls[0].target.targetId === 'GROUP-OPENID',
);
check('撤回后删除 QQ 消息映射', store.getOutboundMessage('$matrix-text') === undefined);

await bridge.handleTransaction('txn-3', {
  events: [
    {
      type: 'm.room.message',
      room_id: '!qq-room:matrix.test',
      sender: expectedGhost,
      event_id: '$ghost-loop',
      content: { msgtype: 'm.text', body: 'loop' },
    },
  ],
});
check('忽略 ghost 用户事件，防止回环', replies.length === matrixToQqReplyBase + 2);

await bridge.handleTransaction('txn-4', {
  events: [
    {
      type: 'm.room.message',
      room_id: '!qq-room:matrix.test',
      sender: '@bob:matrix.test',
      event_id: '$matrix-image',
      content: {
        msgtype: 'm.image',
        body: 'photo.png',
        url: 'mxc://matrix.test/photo',
      },
    },
  ],
});
check('Matrix 图片下载并发送到 QQ', media.length === 1);
check(
  'Matrix 媒体类型正确且不附加发送者标签',
  media[0]?.fileType === MediaFileType.IMAGE && media[0].content === undefined,
);

matrixState.powerLevels.users['@carol:matrix.test'] = 10;
await bridge.handleTransaction('txn-approved-member', {
  events: [
    {
      type: 'm.room.message',
      room_id: '!qq-room:matrix.test',
      sender: '@carol:matrix.test',
      event_id: '$matrix-approved-member',
      content: { msgtype: 'm.text', body: 'approved member' },
    },
  ],
});
check(
  '房间提升 power level 后批准成员可转发',
  replies.at(-1)?.content === 'approved member',
);

const originalSendEvent = matrix.sendEvent;
let markFlushSendStarted: () => void = () => {};
let releaseFlushSend: () => void = () => {};
const flushSendStarted = new Promise<void>((resolve) => {
  markFlushSendStarted = resolve;
});
const flushSendGate = new Promise<void>((resolve) => {
  releaseFlushSend = resolve;
});
matrix.sendEvent = async (...args) => {
  markFlushSendStarted();
  await flushSendGate;
  return originalSendEvent.apply(matrix, args);
};

const flushMessageTask = bridge.handleQqMessage(
  groupMessage('qq-flush-pending', 'QQ-SENDER-FLUSH', 'pending flush'),
);
await flushSendStarted;
const bridgeFlushTask = bridge.flush();
let bridgeFlushed = false;
void bridgeFlushTask.then(() => {
  bridgeFlushed = true;
});
await new Promise<void>((resolve) => {
  setTimeout(resolve, 0);
});
check('bridge.flush 等待在途 QQ 消息', !bridgeFlushed);
releaseFlushSend();
await flushMessageTask;
await bridgeFlushTask;
check('bridge.flush 在在途消息完成后返回', bridgeFlushed);
matrix.sendEvent = originalSendEvent;

// ---------------------------------------------------------------------------
section('QQ 出站频控与恢复');

const recoveryTarget: ConversationTarget = {
  key: 'group:GROUP-OPENID',
  kind: 'group',
  targetId: 'GROUP-OPENID',
};

await bridge.handleQqMessage(
  groupMessage('qq-message-recovery-expired', 'QQ-SENDER-1', 'reset expired window'),
);
replyFailures.push(qqApiError(40034005));
await bridge.handleTransaction('txn-qq-expired', {
  events: [
    {
      type: 'm.room.message',
      room_id: '!qq-room:matrix.test',
      sender: '@alice:matrix.test',
      event_id: '$matrix-qq-expired',
      content: { msgtype: 'm.text', body: 'recover expired passive reply' },
    },
  ],
});
check(
  'QQ msg_id 过期后降级为主动消息',
  replyAttempts.at(-2)?.target.msgId === 'qq-message-recovery-expired' &&
    replyAttempts.at(-1)?.target.msgId === undefined,
);
check(
  'QQ msg_id 过期后清除被动回复窗口',
  (await store.consumeReply(recoveryTarget)).msgId === undefined,
);

await bridge.handleQqMessage(
  groupMessage('qq-message-recovery-limit', 'QQ-SENDER-1', 'reset limited window'),
);
replyFailures.push(qqApiError(40034128));
await bridge.handleTransaction('txn-qq-passive-limit', {
  events: [
    {
      type: 'm.room.message',
      room_id: '!qq-room:matrix.test',
      sender: '@alice:matrix.test',
      event_id: '$matrix-qq-passive-limit',
      content: { msgtype: 'm.text', body: 'recover passive reply limit' },
    },
  ],
});
check(
  'QQ 被动回复次数超限后降级为主动消息',
  replyAttempts.at(-2)?.target.msgId === 'qq-message-recovery-limit' &&
    replyAttempts.at(-1)?.target.msgId === undefined,
);

await bridge.handleQqMessage(
  groupMessage('qq-message-recovery-rate', 'QQ-SENDER-1', 'route to active message'),
);
await store.invalidateReplyWindow(recoveryTarget);
const activeAttemptStart = replyAttempts.length;
replyFailures.push(qqApiError(40034100));
await bridge.handleTransaction('txn-qq-active-limit', {
  events: [
    {
      type: 'm.room.message',
      room_id: '!qq-room:matrix.test',
      sender: '@alice:matrix.test',
      event_id: '$matrix-qq-active-limit',
      content: { msgtype: 'm.text', body: 'retry active message' },
    },
  ],
});
check(
  'QQ 主动消息频控后指数退避重试',
  replyAttempts.length === activeAttemptStart + 2 &&
    replyAttempts.at(-2)?.target.msgId === undefined &&
    replyAttempts.at(-1)?.target.msgId === undefined &&
    retryDelays.at(-1) === 0,
);

await store.invalidateReplyWindow(recoveryTarget);
const rejectedAttemptStart = replyAttempts.length;
for (let index = 0; index < 4; index += 1) {
  replyFailures.push(qqApiError(40034100));
}
let rateLimitRejected = false;
try {
  await bridge.handleTransaction('txn-qq-rate-limit-exhausted', {
    events: [
      {
        type: 'm.room.message',
        room_id: '!qq-room:matrix.test',
        sender: '@alice:matrix.test',
        event_id: '$matrix-qq-rate-limit-exhausted',
        content: { msgtype: 'm.text', body: 'rate limit exhausted' },
      },
    ],
  });
} catch (error) {
  rateLimitRejected = error instanceof ApiError && error.bizCode === 40034100;
}
check(
  'QQ 频控重试耗尽后交给 transaction 重试',
  rateLimitRejected &&
    replyAttempts.length === rejectedAttemptStart + 4 &&
    !store.hasMatrixEvent('$matrix-qq-rate-limit-exhausted'),
);

// ---------------------------------------------------------------------------
section('持久化与被动回复窗口');

const reloaded = new BridgeStore({
  file: storeFile,
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
});
check('重启后恢复 room 映射', reloaded.getRoomByRoomId('!qq-room:matrix.test')?.targetId === 'GROUP-OPENID');
check('重启后保留 QQ message 去重记录', reloaded.hasQqMessage('qq-message-1'));
check('重启后保留 Matrix event 去重记录', reloaded.hasMatrixEvent('$matrix-text'));
check('重启后保留 transaction 去重记录', reloaded.hasTransaction('txn-1'));
check(
  '重启后保留 Matrix 媒体映射',
  reloaded
    .getMatrixMedia(createHash('sha256').update(Uint8Array.from([1, 2, 3, 4])).digest('hex'))
    ?.contentUri === 'mxc://matrix.test/uploaded-1',
);
check('重启后保留 QQ 出站消息映射', reloaded.getOutboundMessage('$matrix-image')?.qqMessageId === 'qq-reply');
check(
  '重启后保留 QQ/Matrix 引用映射',
  reloaded.getReference('REFIDX-qq-user-1')?.matrixEventId === '$event-1' &&
    matrixReplyQqReference !== undefined &&
    reloaded.getQqReference('$matrix-reply') === matrixReplyQqReference,
);

const blockedStateParent = join(dataDir, 'not-a-directory');
writeFileSync(blockedStateParent, 'blocked', 'utf8');
const failingStore = new BridgeStore({
  file: join(blockedStateParent, 'state.json'),
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
  metrics,
});
let stateWriteFailed = false;
try {
  await failingStore.rememberTransaction('state-write-error');
} catch {
  stateWriteFailed = true;
}
check(
  '状态写入失败被指标记录',
  stateWriteFailed &&
    metrics.render().includes(
      'al1s_matrix_bridge_state_writes_total{result="error"} 1',
    ),
);
rmSync(blockedStateParent, { force: true });
mkdirSync(blockedStateParent, { recursive: true });
await failingStore.flush();
const recoveredStore = new BridgeStore({
  file: join(blockedStateParent, 'state.json'),
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
});
check(
  '状态写入失败后 flush 会重试并落盘',
  recoveredStore.hasTransaction('state-write-error'),
);
const recoveredStateFile = join(blockedStateParent, 'state.json');
check(
  '状态文件权限仅所有者可访问',
  process.platform === 'win32' ||
    (statSync(recoveredStateFile).mode & 0o777) === 0o600,
);

const privateStateDir = join(dataDir, 'private-state');
const privateStateFile = join(privateStateDir, 'state.json');
const privateStateStore = new BridgeStore({
  file: privateStateFile,
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
});
await privateStateStore.rememberTransaction('private-state');
check(
  '新建状态目录权限仅所有者可访问',
  process.platform === 'win32' ||
    (statSync(privateStateDir).mode & 0o777) === 0o700,
);

const v2File = join(dataDir, 'v2-state.json');
writeFileSync(
  v2File,
  JSON.stringify({
    version: 2,
    rooms: {},
    transactions: [],
    matrixEvents: [],
    qqMessages: [],
    passiveReplies: {},
  }),
  'utf8',
);
const migratedStore = new BridgeStore({
  file: v2File,
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
});
await migratedStore.rememberTransaction('v2-migrated');
const migratedState = JSON.parse(readFileSync(v2File, 'utf8')) as Record<string, unknown>;
check(
  'v2 状态平滑迁移为 v7',
  migratedState.version === 7 &&
    typeof migratedState.outboundMessages === 'object' &&
    typeof migratedState.references === 'object' &&
    typeof migratedState.matrixReferences === 'object' &&
    typeof migratedState.pendingQqMessages === 'object' &&
    typeof migratedState.matrixMedia === 'object' &&
    Array.isArray(migratedState.transactions),
);

const v3File = join(dataDir, 'v3-state.json');
writeFileSync(
  v3File,
  JSON.stringify({
    version: 3,
    rooms: {},
    transactions: [],
    matrixEvents: [],
    qqMessages: [],
    passiveReplies: {},
    outboundMessages: {},
  }),
  'utf8',
);
const v3MigratedStore = new BridgeStore({
  file: v3File,
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
});
await v3MigratedStore.rememberTransaction('v3-migrated');
const v3MigratedState = JSON.parse(readFileSync(v3File, 'utf8')) as Record<string, unknown>;
check(
  'v3 状态平滑迁移为 v7',
  v3MigratedState.version === 7 &&
    typeof v3MigratedState.references === 'object' &&
    typeof v3MigratedState.matrixReferences === 'object' &&
    typeof v3MigratedState.pendingQqMessages === 'object' &&
    typeof v3MigratedState.matrixMedia === 'object',
);

const v4File = join(dataDir, 'v4-state.json');
writeFileSync(
  v4File,
  JSON.stringify({
    version: 4,
    rooms: {},
    transactions: [],
    matrixEvents: [],
    qqMessages: [],
    passiveReplies: {},
    outboundMessages: {},
    references: {},
    matrixReferences: {},
  }),
  'utf8',
);
const v4MigratedStore = new BridgeStore({
  file: v4File,
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
});
await v4MigratedStore.rememberTransaction('v4-migrated');
const v4MigratedState = JSON.parse(readFileSync(v4File, 'utf8')) as Record<string, unknown>;
check(
  'v4 状态平滑迁移为 v7',
  v4MigratedState.version === 7 &&
    Array.isArray(v4MigratedState.transactions) &&
    typeof v4MigratedState.references === 'object' &&
    typeof v4MigratedState.pendingQqMessages === 'object' &&
    typeof v4MigratedState.matrixMedia === 'object',
);

const v5File = join(dataDir, 'v5-state.json');
writeFileSync(
  v5File,
  JSON.stringify({
    version: 5,
    rooms: {},
    transactions: [],
    matrixEvents: [],
    qqMessages: [],
    passiveReplies: {},
    outboundMessages: {},
    references: {},
    matrixReferences: {},
  }),
  'utf8',
);
const v5MigratedStore = new BridgeStore({
  file: v5File,
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
});
await v5MigratedStore.rememberTransaction('v5-migrated');
const v5MigratedState = JSON.parse(readFileSync(v5File, 'utf8')) as Record<string, unknown>;
check(
  'v5 状态平滑迁移为 v7',
  v5MigratedState.version === 7 &&
    typeof v5MigratedState.pendingQqMessages === 'object' &&
    typeof v5MigratedState.matrixMedia === 'object' &&
    Array.isArray(v5MigratedState.transactions),
);

const v6File = join(dataDir, 'v6-state.json');
writeFileSync(
  v6File,
  JSON.stringify({
    version: 6,
    rooms: {},
    transactions: [],
    matrixEvents: [],
    qqMessages: [],
    passiveReplies: {},
    outboundMessages: {},
    references: {},
    matrixReferences: {},
    pendingQqMessages: {},
  }),
  'utf8',
);
const v6MigratedStore = new BridgeStore({
  file: v6File,
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
});
await v6MigratedStore.rememberTransaction('v6-migrated');
const v6MigratedState = JSON.parse(readFileSync(v6File, 'utf8')) as Record<string, unknown>;
check(
  'v6 状态平滑迁移为 v7',
  v6MigratedState.version === 7 &&
    typeof v6MigratedState.matrixMedia === 'object' &&
    Array.isArray(v6MigratedState.transactions),
);

const limitStore = new BridgeStore({
  file: join(dataDir, 'limit.json'),
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
});
const limitTarget: ConversationTarget = { key: 'group:limit', kind: 'group', targetId: 'LIMIT' };
await limitStore.recordInbound(limitTarget, 'qq-limit');
let passiveAllowed = 0;
for (let index = 0; index < 6; index += 1) {
  const hint = await limitStore.consumeReply(limitTarget);
  if (hint.msgId === 'qq-limit') {
    passiveAllowed += 1;
  }
}
check('群聊被动回复限制为 5/5 分钟', passiveAllowed === 5, `actual=${String(passiveAllowed)}`);

await limitStore.recordInbound(limitTarget, 'qq-limit-next');
const nextMessageHint = await limitStore.consumeReply(limitTarget);
check(
  '新入站消息重置独立被动回复窗口',
  nextMessageHint.msgId === 'qq-limit-next',
  `actual=${nextMessageHint.msgId ?? 'none'}`,
);

let guildDmWindowNow = Date.parse('2026-09-27T00:00:00.000Z');
const guildDmLimitStore = new BridgeStore({
  file: join(dataDir, 'guild-dm-limit.json'),
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
  now: () => guildDmWindowNow,
});
const guildWindowTarget: ConversationTarget = {
  key: 'guild:GUILD/WINDOW',
  kind: 'guild',
  targetId: 'WINDOW',
};
const dmWindowTarget: ConversationTarget = {
  key: 'dm:DM-WINDOW',
  kind: 'dm',
  targetId: 'DM-WINDOW',
};
await guildDmLimitStore.recordInbound(guildWindowTarget, 'qq-guild-window');
await guildDmLimitStore.recordInbound(dmWindowTarget, 'qq-dm-window');
let guildPassiveAllowed = 0;
let dmPassiveAllowed = 0;
for (let index = 0; index < 12; index += 1) {
  if ((await guildDmLimitStore.consumeReply(guildWindowTarget)).msgId === 'qq-guild-window') {
    guildPassiveAllowed += 1;
  }
  if ((await guildDmLimitStore.consumeReply(dmWindowTarget)).msgId === 'qq-dm-window') {
    dmPassiveAllowed += 1;
  }
}
check(
  'guild/DM 被动回复窗口无条数上限',
  guildPassiveAllowed === 12 && dmPassiveAllowed === 12,
  `guild=${String(guildPassiveAllowed)}, dm=${String(dmPassiveAllowed)}`,
);
guildDmWindowNow += 5 * 60 * 1000 + 1;
check(
  'guild/DM 被动回复窗口 5 分钟后失效',
  (await guildDmLimitStore.consumeReply(guildWindowTarget)).msgId === undefined &&
    (await guildDmLimitStore.consumeReply(dmWindowTarget)).msgId === undefined,
);

// ---------------------------------------------------------------------------
section('引用映射历史清理');

let historyNow = Date.parse('2026-09-27T00:00:00.000Z');
const historyFile = join(dataDir, 'history.json');
const historyStore = new BridgeStore({
  file: historyFile,
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
  referenceTtlMs: 1_000,
  maxReferences: 2,
  now: () => historyNow,
});
await historyStore.rememberReference({
  qqReference: 'REF-HISTORY-A',
  matrixEventId: '$history-a',
  sender: '@alice:matrix.test',
  excerpt: 'a',
});
historyNow += 1;
await historyStore.rememberReference({
  qqReference: 'REF-HISTORY-B',
  matrixEventId: '$history-b',
  sender: '@alice:matrix.test',
  excerpt: 'b',
});
historyNow += 1;
await historyStore.rememberReference({
  qqReference: 'REF-HISTORY-C',
  matrixEventId: '$history-c',
  sender: '@alice:matrix.test',
  excerpt: 'c',
});
check(
  '引用映射超过容量后删除最旧记录',
  historyStore.getReference('REF-HISTORY-A') === undefined &&
    historyStore.getQqReference('$history-a') === undefined &&
    historyStore.getReference('REF-HISTORY-B')?.matrixEventId === '$history-b' &&
    historyStore.getReference('REF-HISTORY-C')?.matrixEventId === '$history-c',
);

historyNow += 1_001;
check(
  '过期引用映射正反向查询均失效',
  historyStore.getReference('REF-HISTORY-B') === undefined &&
    historyStore.getQqReference('$history-b') === undefined,
);
await historyStore.flush();
const historyReloaded = new BridgeStore({
  file: historyFile,
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
  referenceTtlMs: 1_000,
  maxReferences: 2,
  now: () => historyNow,
});
await historyReloaded.flush();
const historyState = JSON.parse(readFileSync(historyFile, 'utf8')) as {
  references: Record<string, unknown>;
  matrixReferences: Record<string, unknown>;
};
check(
  '重启后持久化清理过期引用映射',
  Object.keys(historyState.references).length === 0 &&
    Object.keys(historyState.matrixReferences).length === 0,
);

// ---------------------------------------------------------------------------
section('QQ 入站持久化重试');

let queueNow = Date.parse('2026-09-27T00:00:00.000Z');
const queueFile = join(dataDir, 'queue-state.json');
const queueMessage = groupMessage(
  'qq-queue-1',
  'QQ-QUEUE-SENDER',
  'queue payload',
  undefined,
  'GROUP-QUEUE',
);
const queueStore = new BridgeStore({
  file: queueFile,
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
  maxPendingQqMessages: 2,
  now: () => queueNow,
});
check(
  'QQ 入站消息可持久化入队',
  (await queueStore.enqueueQqMessage(queueMessage)) === 'enqueued' &&
    queueStore.getPendingQqMessageCount() === 1,
);
const queueStateText = readFileSync(queueFile, 'utf8');
check(
  'QQ 入站队列不落盘明文身份或正文',
  !queueStateText.includes('qq-queue-1') &&
    !queueStateText.includes('QQ-QUEUE-SENDER') &&
    !queueStateText.includes('queue payload'),
);

const queueReloaded = new BridgeStore({
  file: queueFile,
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
  maxPendingQqMessages: 2,
  now: () => queueNow,
});
check(
  'QQ 入站队列重启后可恢复',
  queueReloaded.getDueQqMessages(queueNow).length === 1 &&
    queueReloaded.getDueQqMessages(queueNow)[0]?.message.content === 'queue payload',
);

const originalQueueSendEvent = matrix.sendEvent;
matrix.sendEvent = async () => {
  throw new Error('synthetic Matrix failure');
};
const retryingQueueBridge = new QqMatrixBridge({
  bot: fakeBot,
  matrix,
  store: queueReloaded,
  config: bridgeConfig,
  logger: silentLogger,
  metrics,
  fetchImpl: mockFetch,
  qqInboundRetryBaseMs: 100,
  qqInboundRetryMaxMs: 400,
  qqInboundReplayIntervalMs: 10,
  now: () => queueNow,
});
await retryingQueueBridge.start();
await retryingQueueBridge.stop();
let queueState = JSON.parse(readFileSync(queueFile, 'utf8')) as {
  pendingQqMessages: Record<string, { attempts: number; nextAttemptAt: number }>;
};
let queueEntry = Object.values(queueState.pendingQqMessages)[0];
check(
  'QQ 入站失败后按首次退避重试',
  queueEntry?.attempts === 1 && queueEntry?.nextAttemptAt === queueNow + 100,
);

queueNow += 100;
matrix.sendEvent = async () => {
  throw new Error('synthetic Matrix failure');
};
await retryingQueueBridge.start();
await retryingQueueBridge.stop();
matrix.sendEvent = originalQueueSendEvent;
queueState = JSON.parse(readFileSync(queueFile, 'utf8')) as typeof queueState;
queueEntry = Object.values(queueState.pendingQqMessages)[0];
check(
  'QQ 入站连续失败后指数退避',
  queueEntry?.attempts === 2 && queueEntry?.nextAttemptAt === queueNow + 200,
);

queueNow += 200;
const queueRestarted = new BridgeStore({
  file: queueFile,
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
  maxPendingQqMessages: 2,
  now: () => queueNow,
});
const replayingQueueBridge = new QqMatrixBridge({
  bot: fakeBot,
  matrix,
  store: queueRestarted,
  config: bridgeConfig,
  logger: silentLogger,
  metrics,
  fetchImpl: mockFetch,
  qqInboundRetryBaseMs: 100,
  qqInboundRetryMaxMs: 400,
  qqInboundReplayIntervalMs: 10,
  now: () => queueNow,
});
await replayingQueueBridge.start();
await replayingQueueBridge.stop();
const isQueueMessage = (event: unknown): boolean =>
  JSON.stringify((event as { body?: unknown }).body).includes(
    '"org.al1s.qq.message_id":"qq-queue-1"',
  );
const queueSentCount = matrixState.sentEvents.filter(isQueueMessage).length;
check(
  'QQ 入站重启重放成功并删除待处理项',
  queueSentCount === 1 &&
    queueRestarted.getPendingQqMessageCount() === 0 &&
    queueRestarted.hasQqMessage('qq-queue-1'),
);

await replayingQueueBridge.handleQqMessage(queueMessage);
check(
  'QQ 入站完成后重复消息不再发送',
  matrixState.sentEvents.filter(isQueueMessage).length === 1,
);

const capacityStore = new BridgeStore({
  file: join(dataDir, 'queue-capacity.json'),
  secret: bridgeConfig.identitySecret,
  logger: silentLogger,
  maxPendingQqMessages: 1,
});
check(
  'QQ 入站队列达到容量上限后拒绝新消息',
  (await capacityStore.enqueueQqMessage(
    groupMessage('qq-queue-capacity-1', 'QQ-QUEUE-SENDER', 'first'),
  )) === 'enqueued' &&
    (await capacityStore.enqueueQqMessage(
      groupMessage('qq-queue-capacity-2', 'QQ-QUEUE-SENDER', 'second'),
    )) === 'full' &&
    capacityStore.getPendingQqMessageCount() === 1,
);

// ---------------------------------------------------------------------------
section('Appservice HTTP 鉴权');

let transactions = 0;
const sensitiveAppserviceError = 'sensitive-appservice-secret';
const appservice = new MatrixAppserviceServer({
  host: '127.0.0.1',
  port: 0,
  hsToken: bridgeConfig.hsToken,
  maxBodyBytes: 64,
  shutdownTimeoutMs: 100,
  log: silentLogger,
  metrics,
  onTransaction: async (transactionId) => {
    if (transactionId === 'explode') {
      throw new Error(sensitiveAppserviceError);
    }
    transactions += 1;
  },
});
const address = await appservice.start();
const baseUrl = `http://${address.host}:${String(address.port)}`;
try {
  const health = await fetch(`${baseUrl}/health`);
  check('健康检查无需鉴权', health.status === 200);

  const metricsResponse = await fetch(`${baseUrl}/metrics`);
  const metricsBody = await metricsResponse.text();
  check(
    'Prometheus 指标无需鉴权且使用文本格式',
    metricsResponse.status === 200 &&
      metricsResponse.headers.get('content-type')?.startsWith('text/plain') === true &&
      metricsBody.includes('al1s_matrix_bridge_up 1') &&
      metricsBody.includes('al1s_matrix_bridge_uptime_seconds '),
  );

  const denied = await fetch(`${baseUrl}/_matrix/app/v1/transactions/bad`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [] }),
  });
  check('拒绝错误 hs_token', denied.status === 401);

  const accepted = await fetch(`${baseUrl}/_matrix/app/v1/transactions/good`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${bridgeConfig.hsToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ events: [] }),
  });
  check('Bearer hs_token 返回 ACK', accepted.status === 200 && transactions === 1);

  const queryAccepted = await fetch(
    `${baseUrl}/_matrix/app/v1/transactions/query?access_token=${encodeURIComponent(bridgeConfig.hsToken)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    },
  );
  check('query access_token 兼容 Tuwunel', queryAccepted.status === 200 && transactions === 2);

  const invalidJson = await fetch(`${baseUrl}/_matrix/app/v1/transactions/invalid-json`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${bridgeConfig.hsToken}`,
      'content-type': 'application/json',
    },
    body: '{',
  });
  check('非法 transaction JSON 返回 400', invalidJson.status === 400 && transactions === 2);

  const tooLarge = await fetch(`${baseUrl}/_matrix/app/v1/transactions/too-large`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${bridgeConfig.hsToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ padding: 'x'.repeat(128) }),
  });
  check('超限 transaction 请求体返回 413', tooLarge.status === 413 && transactions === 2);

  const failed = await fetch(`${baseUrl}/_matrix/app/v1/transactions/explode`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${bridgeConfig.hsToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ events: [] }),
  });
  const failedBody = await failed.text();
  check(
    '内部处理失败返回脱敏 500',
    failed.status === 500 &&
      failedBody.includes('M_UNKNOWN') &&
      !failedBody.includes(sensitiveAppserviceError) &&
      transactions === 2,
  );

  const requestMetrics = await (await fetch(`${baseUrl}/metrics`)).text();
  check(
    '指标记录 appservice 请求结果',
    requestMetrics.includes(
      'al1s_matrix_bridge_appservice_requests_total{result="unauthorized",route="transactions"} 1',
    ) &&
      requestMetrics.includes(
        'al1s_matrix_bridge_appservice_requests_total{result="success",route="transactions"} 2',
      ) &&
      requestMetrics.includes(
        'al1s_matrix_bridge_appservice_requests_total{result="invalid",route="transactions"} 2',
      ) &&
      requestMetrics.includes(
        'al1s_matrix_bridge_appservice_requests_total{result="error",route="transactions"} 1',
      ) &&
      requestMetrics.includes(
        'al1s_matrix_bridge_appservice_transactions_total{result="error"} 1',
      ) &&
      /al1s_matrix_bridge_last_successful_transaction_timestamp_seconds [1-9]\d*(?:\.\d+)?\n/.test(
        requestMetrics,
      ),
  );

  const stalled = connectSocket({ host: address.host, port: address.port });
  await new Promise<void>((resolve, reject) => {
    stalled.once('connect', resolve);
    stalled.once('error', reject);
  });
  stalled.on('error', () => undefined);
  stalled.write(
    [
      'PUT /_matrix/app/v1/transactions/stalled HTTP/1.1',
      `Host: ${address.host}:${String(address.port)}`,
      `Authorization: Bearer ${bridgeConfig.hsToken}`,
      'Content-Type: application/json',
      'Content-Length: 100',
      '',
      '{',
    ].join('\r\n'),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  const stopStartedAt = Date.now();
  await appservice.stop();
  const stopElapsedMs = Date.now() - stopStartedAt;
  stalled.destroy();
  check(
    'appservice.stop 在超时后强制关闭滞留请求',
    stopElapsedMs >= 75 && stopElapsedMs < 1_000,
    `elapsed=${String(stopElapsedMs)}ms`,
  );
} finally {
  await appservice.stop();
  rmSync(dataDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\nMatrix bridge 自检失败：${failures} 项`);
  process.exit(1);
}
console.log('\nMatrix bridge 自检通过');
