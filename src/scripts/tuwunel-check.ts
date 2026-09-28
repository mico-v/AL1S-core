/**
 * 真实 Tuwunel appservice 集成检查。
 *
 * 启动临时 Tuwunel 本机二进制，并通过假 QQ 端口驱动完整 bridge：
 * registration/ping、QQ -> Matrix（文本、结构化消息、引用与媒体）、
 * transaction 回推、Tuwunel 重启持久化、Matrix -> QQ（文本、引用与媒体）。
 * 检查不需要 QQ 凭据，也不需要容器运行时。
 *
 * 运行（需提供 tuwunel 1.9.3 可执行文件路径）：
 *   TUWUNEL_BIN=/path/to/tuwunel pnpm tuwunel:check
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { connect as connectSocket, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  MediaFileType,
  type QQBotInboundMessage,
  type ReplyTarget,
} from '@tencent-connect/qqbot-nodejs';
import { ed25519Sign } from '@tencent-connect/qqbot-nodejs/protocol';
import {
  QqMatrixBridge,
  conversationKey,
  deriveGhostLocalpart,
  type QqBotPort,
} from '../bridge/bridge.js';
import { BridgeStore } from '../bridge/store.js';
import type { MatrixBridgeConfig } from '../config.js';
import type { AppLogger } from '../logger.js';
import { runMatrixAdmin } from '../matrix/admin.js';
import {
  MatrixAppserviceServer,
  type MatrixEvent,
  type MatrixTransaction,
} from '../matrix/appservice.js';
import { MatrixApiError, MatrixClient } from '../matrix/client.js';

const DOMAIN = 'matrix.test';
const SERVER_NAME = 'matrix.test';
const TUWUNEL_PORT = 8008;
const TUWUNEL_TEST_VERSION = '1.9.3';
const ALLOWED_USER = `@alice:${DOMAIN}`;
const GROUP_OPENID = 'TUWUNEL-CHECK-GROUP';
const QQ_USER_ID = 'TUWUNEL-CHECK-QQ-USER';
const QQ_MESSAGE_ID = 'tuwunel-check-qq-message';
const QQ_BODY = 'QQ -> Matrix integration check';
const STRUCTURED_QQ_MESSAGE_ID = 'tuwunel-check-structured-message';
const STRUCTURED_QQ_BODY = '结构化首条\n结构化嵌套条';
const QQ_MEDIA_MESSAGE_ID = 'tuwunel-check-media-message';
const QQ_MEDIA_BODY = 'QQ media -> Matrix integration check';
const QQ_MEDIA_FILENAME = 'qq-image.png';
const REFERENCE_QQ_MESSAGE_ID = 'tuwunel-check-reference-message';
const REFERENCE_QQ_BODY = 'QQ reference target';
const REFERENCE_INDEX = 'tuwunel-check-msg-idx';
const QUOTED_QQ_MESSAGE_ID = 'tuwunel-check-quoted-message';
const QUOTED_QQ_BODY = 'QQ quoted reply';
const GUILD_ID = 'TUWUNEL-CHECK-GUILD';
const GUILD_CHANNEL_ID = 'TUWUNEL-CHECK-CHANNEL';
const GUILD_MESSAGE_ID = 'tuwunel-check-guild-message';
const GUILD_QQ_BODY = 'QQ guild -> Matrix integration check';
const DM_GUILD_ID = 'TUWUNEL-CHECK-DM-GUILD';
const DM_MESSAGE_ID = 'tuwunel-check-dm-message';
const DM_QQ_BODY = 'QQ DM -> Matrix integration check';
const GUILD_MATRIX_BODY = 'Matrix -> QQ guild integration check';
const DM_MATRIX_BODY = 'Matrix -> QQ DM integration check';
const MATRIX_BODY = 'Matrix -> QQ integration check';
const MATRIX_REPLY_BODY = 'Matrix reply integration check';
const MATRIX_REJOIN_BODY = 'Matrix rejoin integration check';
const MATRIX_MEDIA_BODY = 'matrix-image.png';
const ENTRY_GROUP_OPENID = 'TUWUNEL-CHECK-ENTRY-GROUP';
const ENTRY_QQ_MESSAGE_ID = 'tuwunel-check-entry-message';
const ENTRY_QQ_BODY = 'QQ production entry -> Matrix integration check';
const ENTRY_APP_SECRET = 'tuwunel-entry-secret-32-bytes-long';
const ENTRY_WEBHOOK_PATH = '/qq-webhook';
const MEDIA_CONTENT_TYPE = 'image/png';
const MEDIA_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4AAAAABJRU5ErkJggg==',
  'base64',
);

const silentLogger: AppLogger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CapturedQqReply {
  target: ReplyTarget;
  content: string;
  messageReference?: string;
}

interface RunningEntry {
  process: ChildProcessWithoutNullStreams;
  output: () => string;
  exit: Promise<number | null>;
}

function check(name: string, condition: boolean, detail?: string): void {
  if (!condition) {
    throw new Error(`${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
  console.log(`  ✓ ${name}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${command} 超时（${String(timeoutMs)}ms）`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} ${args.join(' ')} 退出码 ${String(code)}：${stderr.trim() || stdout.trim()}`,
          ),
        );
      }
    });
  });
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  return address.port;
}

async function waitFor<T>(
  description: string,
  operation: () => Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw new Error(
    `${description} 超时：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveTuwunelBinary(): string {
  const candidates = [
    process.env['TUWUNEL_BIN'],
    process.env['TUWUNEL_SOURCE_DIR'] === undefined
      ? undefined
      : join(process.env['TUWUNEL_SOURCE_DIR'], 'target', 'release', 'tuwunel'),
    join(process.cwd(), '..', 'tuwunel', 'target', 'release', 'tuwunel'),
    join(
      process.cwd(),
      '..',
      'matrix-construct',
      'tuwunel',
      'target',
      'release',
      'tuwunel',
    ),
    '/usr/local/bin/tuwunel',
    '/usr/bin/tuwunel',
  ].filter((candidate): candidate is string => candidate !== undefined);
  const pathCandidates = (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter((entry) => entry !== '')
    .map((entry) => join(entry, 'tuwunel'));
  const binary = [...candidates, ...pathCandidates].find(isExecutable);
  if (binary === undefined) {
    throw new Error(
      '未找到可执行的 Tuwunel。请设置 TUWUNEL_BIN，或先构建 ' +
        'tuwunel/target/release/tuwunel 并设置 TUWUNEL_SOURCE_DIR。',
    );
  }
  return resolve(binary);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function relationEventId(value: Record<string, unknown>): string | undefined {
  const relation = value['m.relates_to'];
  if (relation === null || typeof relation !== 'object' || Array.isArray(relation)) {
    return undefined;
  }
  return stringField(relation as Record<string, unknown>, 'event_id');
}

function transactionEvents(transactions: MatrixTransaction[]): MatrixEvent[] {
  return transactions.flatMap((transaction) => transaction.events ?? []);
}

function startCapturedProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): RunningEntry {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  return {
    process: child,
    output: () => `${stdout}${stderr}`.trim(),
    exit,
  };
}

function startBridgeEntry(
  env: NodeJS.ProcessEnv,
  preload?: string,
): RunningEntry {
  const args = preload === undefined
    ? ['dist/matrix-bridge.js']
    : ['--import', pathToFileURL(join(process.cwd(), preload)).href, 'dist/matrix-bridge.js'];
  return startCapturedProcess(process.execPath, args, env, process.cwd());
}

async function stopProcess(
  entry: RunningEntry,
  forceAfterMs = 5_000,
): Promise<number | null> {
  if (entry.process.exitCode !== null || entry.process.signalCode !== null) {
    return entry.process.exitCode;
  }
  entry.process.kill('SIGTERM');
  const forceKill = setTimeout(() => {
    if (entry.process.exitCode === null && entry.process.signalCode === null) {
      entry.process.kill('SIGKILL');
    }
  }, forceAfterMs);
  try {
    return await entry.exit;
  } finally {
    clearTimeout(forceKill);
  }
}

function stopBridgeEntry(entry: RunningEntry): Promise<number | null> {
  return stopProcess(entry);
}

async function waitForBridgeEntryExit(
  entry: RunningEntry,
  timeoutMs = 5_000,
): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      entry.exit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          entry.process.kill('SIGKILL');
          reject(new Error(`生产入口未在 ${String(timeoutMs)}ms 内退出`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function deriveRoomAlias(secret: string, targetKey: string, aliasPrefix: string): string {
  const aliasDigest = createHmac('sha256', secret).update(targetKey, 'utf8').digest('hex');
  return `#${aliasPrefix}${aliasDigest}:${DOMAIN}`;
}

async function fetchRoomMessages(
  baseUrl: string,
  accessToken: string,
  roomId: string,
): Promise<MatrixEvent[]> {
  const url = new URL(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
    baseUrl,
  );
  url.searchParams.set('dir', 'b');
  url.searchParams.set('limit', '50');
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`读取房间消息失败：HTTP ${String(response.status)}`);
  }
  const body = (await response.json()) as { chunk?: MatrixEvent[] };
  return body.chunk ?? [];
}

async function startMediaFixture(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/media.png') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': MEDIA_CONTENT_TYPE,
      'content-length': String(MEDIA_BYTES.byteLength),
    });
    response.end(MEDIA_BYTES);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}/media.png`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}

function groupMessage(): QQBotInboundMessage {
  return {
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    kind: 'group',
    senderId: QQ_USER_ID,
    senderName: 'Tuwunel check user',
    content: QQ_BODY,
    messageId: QQ_MESSAGE_ID,
    timestamp: new Date().toISOString(),
    groupOpenid: GROUP_OPENID,
    replyTarget: {
      scope: 'group',
      targetId: GROUP_OPENID,
      msgId: QQ_MESSAGE_ID,
    },
    raw: {
      id: QQ_MESSAGE_ID,
      content: QQ_BODY,
      timestamp: new Date().toISOString(),
      author: {
        member_openid: QQ_USER_ID,
        username: 'Tuwunel check user',
        bot: false,
      },
      group_openid: GROUP_OPENID,
    },
  };
}

function mediaGroupMessage(url: string): QQBotInboundMessage {
  const timestamp = new Date().toISOString();
  const attachment = {
    content_type: MEDIA_CONTENT_TYPE,
    url,
    filename: QQ_MEDIA_FILENAME,
  };
  return {
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    kind: 'group',
    senderId: QQ_USER_ID,
    senderName: 'Tuwunel check user',
    content: QQ_MEDIA_BODY,
    messageId: QQ_MEDIA_MESSAGE_ID,
    timestamp,
    groupOpenid: GROUP_OPENID,
    attachments: [attachment],
    replyTarget: {
      scope: 'group',
      targetId: GROUP_OPENID,
      msgId: QQ_MEDIA_MESSAGE_ID,
    },
    raw: {
      id: QQ_MEDIA_MESSAGE_ID,
      content: QQ_MEDIA_BODY,
      timestamp,
      author: {
        member_openid: QQ_USER_ID,
        username: 'Tuwunel check user',
        bot: false,
      },
      group_openid: GROUP_OPENID,
      attachments: [attachment],
    },
  };
}

function referencedGroupMessage(): QQBotInboundMessage {
  const timestamp = new Date().toISOString();
  return {
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    kind: 'group',
    senderId: QQ_USER_ID,
    senderName: 'Tuwunel check user',
    content: REFERENCE_QQ_BODY,
    messageId: REFERENCE_QQ_MESSAGE_ID,
    timestamp,
    groupOpenid: GROUP_OPENID,
    msgIdx: REFERENCE_INDEX,
    replyTarget: {
      scope: 'group',
      targetId: GROUP_OPENID,
      msgId: REFERENCE_QQ_MESSAGE_ID,
    },
    raw: {
      id: REFERENCE_QQ_MESSAGE_ID,
      content: REFERENCE_QQ_BODY,
      timestamp,
      author: {
        member_openid: QQ_USER_ID,
        username: 'Tuwunel check user',
        bot: false,
      },
      group_openid: GROUP_OPENID,
      message_scene: { ext: [`msg_idx=${REFERENCE_INDEX}`] },
    },
  };
}

function quotedGroupMessage(): QQBotInboundMessage {
  const timestamp = new Date().toISOString();
  const elements = [
    {
      message_type: 0,
      author: { username: 'Tuwunel check user' },
      content: REFERENCE_QQ_BODY,
    },
  ];
  return {
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    kind: 'group',
    senderId: QQ_USER_ID,
    senderName: 'Tuwunel check user',
    content: QUOTED_QQ_BODY,
    messageId: QUOTED_QQ_MESSAGE_ID,
    timestamp,
    groupOpenid: GROUP_OPENID,
    refMsgIdx: REFERENCE_INDEX,
    msgType: 103,
    msgElements: elements as unknown as NonNullable<QQBotInboundMessage['msgElements']>,
    replyTarget: {
      scope: 'group',
      targetId: GROUP_OPENID,
      msgId: QUOTED_QQ_MESSAGE_ID,
    },
    raw: {
      id: QUOTED_QQ_MESSAGE_ID,
      content: QUOTED_QQ_BODY,
      timestamp,
      author: {
        member_openid: QQ_USER_ID,
        username: 'Tuwunel check user',
        bot: false,
      },
      group_openid: GROUP_OPENID,
      message_type: 103,
      msg_elements: elements,
      message_scene: { ext: [`ref_msg_idx=${REFERENCE_INDEX}`] },
    } as unknown as QQBotInboundMessage['raw'],
  };
}

/** `message_type=101` 并行消息，验证嵌套 `msg_elements` 合并进 Matrix 正文。 */
function structuredGroupMessage(): QQBotInboundMessage {
  const timestamp = new Date().toISOString();
  const elements = [
    {
      message_type: 101,
      content: '结构化首条',
      msg_elements: [{ message_type: 0, content: '结构化嵌套条' }],
    },
  ];
  return {
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    kind: 'group',
    senderId: QQ_USER_ID,
    senderName: 'Tuwunel check user',
    content: '',
    messageId: STRUCTURED_QQ_MESSAGE_ID,
    timestamp,
    groupOpenid: GROUP_OPENID,
    msgType: 101,
    msgElements: elements as unknown as NonNullable<QQBotInboundMessage['msgElements']>,
    replyTarget: {
      scope: 'group',
      targetId: GROUP_OPENID,
      msgId: STRUCTURED_QQ_MESSAGE_ID,
    },
    raw: {
      id: STRUCTURED_QQ_MESSAGE_ID,
      content: '',
      timestamp,
      author: {
        member_openid: QQ_USER_ID,
        username: 'Tuwunel check user',
        bot: false,
      },
      group_openid: GROUP_OPENID,
      message_type: 101,
      msg_elements: elements,
    } as unknown as QQBotInboundMessage['raw'],
  };
}

function guildMessage(): QQBotInboundMessage {
  const timestamp = new Date().toISOString();
  return {
    rawEventType: 'AT_MESSAGE_CREATE',
    kind: 'guild',
    senderId: QQ_USER_ID,
    senderName: 'Tuwunel check user',
    content: GUILD_QQ_BODY,
    messageId: GUILD_MESSAGE_ID,
    timestamp,
    guildId: GUILD_ID,
    channelId: GUILD_CHANNEL_ID,
    replyTarget: {
      scope: 'guild',
      targetId: GUILD_CHANNEL_ID,
      msgId: GUILD_MESSAGE_ID,
    },
    raw: {
      id: GUILD_MESSAGE_ID,
      content: GUILD_QQ_BODY,
      timestamp,
      author: {
        id: QQ_USER_ID,
        username: 'Tuwunel check user',
        bot: false,
      },
      guild_id: GUILD_ID,
      channel_id: GUILD_CHANNEL_ID,
    },
  };
}

function dmMessage(): QQBotInboundMessage {
  const timestamp = new Date().toISOString();
  return {
    rawEventType: 'DIRECT_MESSAGE_CREATE',
    kind: 'dm',
    senderId: QQ_USER_ID,
    senderName: 'Tuwunel check user',
    content: DM_QQ_BODY,
    messageId: DM_MESSAGE_ID,
    timestamp,
    guildId: DM_GUILD_ID,
    channelId: 'TUWUNEL-CHECK-DM-CHANNEL',
    replyTarget: {
      scope: 'dm',
      targetId: DM_GUILD_ID,
      msgId: DM_MESSAGE_ID,
    },
    raw: {
      id: DM_MESSAGE_ID,
      content: DM_QQ_BODY,
      timestamp,
      author: {
        id: QQ_USER_ID,
        username: 'Tuwunel check user',
        bot: false,
      },
      guild_id: DM_GUILD_ID,
      channel_id: 'TUWUNEL-CHECK-DM-CHANNEL',
    },
  };
}

function registrationYaml(options: {
  id: string;
  bridgeUrl: string;
  asToken: string;
  hsToken: string;
  senderLocalpart: string;
  userPrefix: string;
  aliasPrefix: string;
}): string {
  const escapedDomain = DOMAIN.replaceAll('.', '\\.');
  const ghostRegex = `^@${options.userPrefix}[0-9a-f]{64}:${escapedDomain}$`;
  const aliasRegex = `^#${options.aliasPrefix}[0-9a-f]{64}:${escapedDomain}$`;
  return [
    `id: ${options.id}`,
    `url: ${options.bridgeUrl}`,
    `as_token: ${options.asToken}`,
    `hs_token: ${options.hsToken}`,
    `sender_localpart: ${options.senderLocalpart}`,
    'receive_ephemeral: false',
    '',
    'namespaces:',
    '  users:',
    '    - exclusive: true',
    `      regex: '${ghostRegex}'`,
    '    - exclusive: false',
    `      regex: '^@alice:${escapedDomain}$'`,
    '  aliases:',
    '    - exclusive: true',
    `      regex: '${aliasRegex}'`,
    '  rooms: []',
    '',
  ].join('\n');
}

async function fetchTuwunelVersion(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/_tuwunel/server_version`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  const body = (await response.json()) as { version?: string };
  return body.version ?? 'unknown';
}

async function waitForTuwunel(
  baseUrl: string,
  output?: () => string,
): Promise<string> {
  return waitFor(
    'Tuwunel 启动',
    () => fetchTuwunelVersion(baseUrl),
    60_000,
  ).catch((error: unknown) => {
    const detail = output?.();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        detail === undefined || detail === '' ? '' : `\nTuwunel 输出：\n${detail}`
      }`,
    );
  });
}

function hostTuwunelEnvironment(
  databasePath: string,
  appserviceDir: string,
  port: number,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:TUWUNEL|CONDUWUIT|CONDUIT)_/.test(key),
    ),
  );
  return {
    ...inherited,
    TUWUNEL_SERVER_NAME: SERVER_NAME,
    TUWUNEL_DATABASE_PATH: databasePath,
    TUWUNEL_ADDRESS: '127.0.0.1',
    TUWUNEL_PORT: String(port),
    TUWUNEL_APPSERVICE_DIR: appserviceDir,
    TUWUNEL_ALLOW_FEDERATION: 'false',
    TUWUNEL_ALLOW_REGISTRATION: 'false',
  };
}

async function main(): Promise<void> {
  const expectedVersion = process.env['TUWUNEL_CHECK_VERSION'] ?? TUWUNEL_TEST_VERSION;
  const appserviceHost = process.env['TUWUNEL_CHECK_APPSERVICE_HOST'] ?? '127.0.0.1';
  const tempDir = mkdtempSync(join(tmpdir(), 'al1s-tuwunel-check-'));
  const registrationDir = join(tempDir, 'appservices');
  const hostDatabaseDir = join(tempDir, 'tuwunel-data');
  let hostTuwunel: RunningEntry | undefined;
  let hostTuwunelBinary: string | undefined;
  let appservice: MatrixAppserviceServer | undefined;
  let store: BridgeStore | undefined;
  let entryProcess: RunningEntry | undefined;
  let entryStalledSocket: ReturnType<typeof connectSocket> | undefined;
  let mediaFixture:
    | Awaited<ReturnType<typeof startMediaFixture>>
    | undefined;

  try {
    mkdirSync(registrationDir, { recursive: true });
    mediaFixture = await startMediaFixture();

    section('运行环境');
    hostTuwunelBinary = resolveTuwunelBinary();
    check('Tuwunel 本机二进制可用', true, hostTuwunelBinary);

    const hostPort = await getFreePort();
    const baseUrl = `http://127.0.0.1:${String(hostPort)}`;
    const hostEnv = hostTuwunelEnvironment(hostDatabaseDir, registrationDir, hostPort);
    const appserviceId = 'al1s-tuwunel-check';
    const asToken = randomBytes(24).toString('base64url');
    const hsToken = randomBytes(24).toString('base64url');
    const identitySecret = randomBytes(32).toString('hex');
    const senderLocalpart = '_al1s_check';
    const userPrefix = '_qq_';
    const aliasPrefix = '_qq_';
    const transactions: MatrixTransaction[] = [];
    const completedEvents = new Set<string>();
    const qqReplies: CapturedQqReply[] = [];
    const qqRecalls: Array<{
      target: Parameters<QqBotPort['recall']>[0];
      messageId: string;
    }> = [];
    const qqMedia: Array<Parameters<QqBotPort['sendMedia']>[0]> = [];

    const bridgeConfig: MatrixBridgeConfig = {
      id: appserviceId,
      homeserverUrl: baseUrl,
      domain: DOMAIN,
      asToken,
      hsToken,
      senderLocalpart,
      userId: `@${senderLocalpart}:${DOMAIN}`,
      listenHost: '0.0.0.0',
      listenPort: 0,
      dataFile: join(tempDir, 'state.json'),
      userPrefix,
      aliasPrefix,
      identitySecret,
      allowedSenders: [ALLOWED_USER],
      minPowerLevel: 10,
      referenceTtlMs: 30 * 24 * 60 * 60 * 1000,
      maxReferences: 100,
      qqInboundRetryBaseMs: 10,
      qqInboundRetryMaxMs: 100,
      qqInboundReplayIntervalMs: 10,
      qqInboundQueueMaxEntries: 100,
      requestTimeoutMs: 10_000,
      shutdownTimeoutMs: 1_000,
      maxMediaBytes: 1024 * 1024,
    };

    const matrix = new MatrixClient(
      {
        homeserverUrl: baseUrl,
        accessToken: asToken,
        timeoutMs: 10_000,
      },
      bridgeConfig.userId,
    );
    store = new BridgeStore({
      file: bridgeConfig.dataFile,
      secret: identitySecret,
      logger: silentLogger,
      referenceTtlMs: bridgeConfig.referenceTtlMs,
    maxReferences: bridgeConfig.maxReferences,
    maxPendingQqMessages: bridgeConfig.qqInboundQueueMaxEntries,
  });

    const fakeBot: QqBotPort = {
      replyText: async (target, content, options) => {
        qqReplies.push({
          target,
          content,
          messageReference: options?.messageReference,
        });
        return {
          id: `tuwunel-check-reply-${String(qqReplies.length)}`,
          timestamp: Date.now(),
        };
      },
      sendMedia: async (options) => {
        qqMedia.push(options);
        return {
          upload: {
            file_uuid: `tuwunel-check-media-${String(qqMedia.length)}`,
            file_info: `tuwunel-check-file-info-${String(qqMedia.length)}`,
            ttl: 3600,
          },
          message: {
            id: `tuwunel-check-media-reply-${String(qqMedia.length)}`,
            timestamp: Date.now(),
          },
        };
      },
      recall: async (target, messageId) => {
        qqRecalls.push({ target, messageId });
      },
    };
    const bridge = new QqMatrixBridge({
      bot: fakeBot,
      matrix,
      store,
      config: bridgeConfig,
      logger: silentLogger,
    });
    appservice = new MatrixAppserviceServer({
      host: bridgeConfig.listenHost,
      port: 0,
      hsToken,
      log: silentLogger,
      onTransaction: async (transactionId, transaction) => {
        transactions.push(transaction);
        await bridge.handleTransaction(transactionId, transaction);
        for (const event of transaction.events ?? []) {
          completedEvents.add(event.event_id);
        }
      },
    });
    const address = await appservice.start();
    bridgeConfig.listenPort = address.port;

    const bridgeUrl = `http://${appserviceHost}:${String(address.port)}`;
    writeFileSync(
      join(registrationDir, `${appserviceId}.yaml`),
      registrationYaml({
        id: appserviceId,
        bridgeUrl,
        asToken,
        hsToken,
        senderLocalpart,
        userPrefix,
        aliasPrefix,
      }),
      'utf8',
    );

    section('Tuwunel registration');
    const binary = hostTuwunelBinary;
    if (binary === undefined) {
      throw new Error('宿主 Tuwunel 启动参数不完整');
    }
    mkdirSync(hostDatabaseDir, { recursive: true });
    hostTuwunel = startCapturedProcess(binary, [], hostEnv, tempDir);
    const version = await waitForTuwunel(baseUrl, () => hostTuwunel?.output() ?? '');
    check(
      'Tuwunel 已启动',
      version !== 'unknown',
      `${hostTuwunelBinary ?? 'tuwunel'} (${version})`,
    );
    check(
      'Tuwunel 版本符合测试基线',
      version === expectedVersion,
      `期望 ${expectedVersion}，实际 ${version}`,
    );

    const pingResponse = await fetch(
      `${baseUrl}/_matrix/client/v1/appservice/${encodeURIComponent(appserviceId)}/ping`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${asToken}`,
          'content-type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      },
    );
    check('Tuwunel 已加载 appservice 且能调用 bridge', pingResponse.ok, `HTTP ${String(pingResponse.status)}`);

    section('QQ -> Matrix');
    await bridge.handleQqMessage(groupMessage());
    const room = store.getRoom(conversationKey('group', GROUP_OPENID));
    check('QQ 会话已创建 Matrix room', room !== undefined);
    if (room === undefined) {
      throw new Error('缺少 QQ/Matrix room 映射');
    }

    const ghostUserId = `@${deriveGhostLocalpart(
      identitySecret,
      QQ_USER_ID,
      userPrefix,
    )}:${DOMAIN}`;
    const ghostEvent = await waitFor('ghost 消息 transaction', async () => {
      const event = transactionEvents(transactions).find(
        (candidate) =>
          candidate.sender === ghostUserId &&
          candidate.room_id === room.roomId &&
          candidate.type === 'm.room.message' &&
          stringField(candidate.content, 'body') === QQ_BODY,
      );
      if (event === undefined) {
        throw new Error('尚未收到对应事件');
      }
      return event;
    });
    check('ghost 文本已写入 Tuwunel', ghostEvent.event_id !== '');

    await bridge.handleQqMessage(referencedGroupMessage());
    const referenceEvent = await waitFor('QQ 引用目标 transaction', async () => {
      const event = transactionEvents(transactions).find(
        (candidate) =>
          candidate.sender === ghostUserId &&
          candidate.room_id === room.roomId &&
          candidate.type === 'm.room.message' &&
          stringField(candidate.content, 'body') === REFERENCE_QQ_BODY,
      );
      if (event === undefined) {
        throw new Error('尚未收到对应事件');
      }
      return event;
    });
    check('QQ 引用目标已写入 Tuwunel', referenceEvent.event_id !== '');

    await bridge.handleQqMessage(quotedGroupMessage());
    const quotedEvent = await waitFor('QQ 引用回复 transaction', async () => {
      const event = transactionEvents(transactions).find(
        (candidate) =>
          candidate.sender === ghostUserId &&
          candidate.room_id === room.roomId &&
          candidate.type === 'm.room.message' &&
          stringField(candidate.content, 'body') === QUOTED_QQ_BODY,
      );
      if (event === undefined) {
        throw new Error('尚未收到对应事件');
      }
      return event;
    });
    check(
      'QQ 引用映射为 Matrix m.in_reply_to 且不重复 fallback 正文',
      relationEventId(quotedEvent.content) === referenceEvent.event_id &&
        stringField(quotedEvent.content, 'body') === QUOTED_QQ_BODY,
    );

    await bridge.handleQqMessage(structuredGroupMessage());
    const structuredEvent = await waitFor('结构化 ghost 消息 transaction', async () => {
      const event = transactionEvents(transactions).find(
        (candidate) =>
          candidate.sender === ghostUserId &&
          candidate.room_id === room.roomId &&
          candidate.type === 'm.room.message' &&
          stringField(candidate.content, 'body') === STRUCTURED_QQ_BODY,
      );
      if (event === undefined) {
        throw new Error('尚未收到对应事件');
      }
      return event;
    });
    check('结构化 QQ 消息以合并正文写入 Tuwunel', structuredEvent.event_id !== '');

    await bridge.handleQqMessage(mediaGroupMessage(mediaFixture.url));
    const qqMediaEvent = await waitFor('QQ 媒体 transaction', async () => {
      const event = transactionEvents(transactions).find(
        (candidate) =>
          candidate.sender === ghostUserId &&
          candidate.room_id === room.roomId &&
          candidate.type === 'm.room.message' &&
          stringField(candidate.content, 'msgtype') === 'm.image' &&
          stringField(candidate.content, 'body') === QQ_MEDIA_FILENAME,
      );
      if (event === undefined) {
        throw new Error('尚未收到对应事件');
      }
      return event;
    });
    const qqMediaUri = stringField(qqMediaEvent.content, 'url');
    check(
      'QQ 媒体已上传并写入 Tuwunel',
      qqMediaUri?.startsWith('mxc://') === true,
      qqMediaUri ?? 'missing mxc URI',
    );
    if (qqMediaUri === undefined) {
      throw new Error('QQ 媒体事件缺少 mxc URI');
    }
    const downloadedQqMedia = await matrix.downloadMedia(
      qqMediaUri,
      bridgeConfig.maxMediaBytes,
    );
    check(
      'QQ 媒体可从 Tuwunel 下载且内容一致',
      downloadedQqMedia.data.equals(MEDIA_BYTES) &&
        downloadedQqMedia.contentType.startsWith(MEDIA_CONTENT_TYPE),
      `${String(downloadedQqMedia.data.byteLength)} bytes, ${downloadedQqMedia.contentType}`,
    );

    const bridgeMember = await matrix.getRoomMember(room.roomId, bridgeConfig.userId);
    check('appservice bot 已加入映射房间', bridgeMember?.membership === 'join');

    section('Tuwunel 重启与持久化');
    const runningHost = hostTuwunel;
    const restartBinary = hostTuwunelBinary;
    if (runningHost === undefined || restartBinary === undefined) {
      throw new Error('宿主 Tuwunel 重启参数不完整');
    }
    const exitCode = await stopProcess(runningHost, 30_000);
    check('Tuwunel 本机进程已正常停止', exitCode === 0, `exit=${String(exitCode)}`);
    hostTuwunel = startCapturedProcess(restartBinary, [], hostEnv, tempDir);
    const restartedVersion = await waitForTuwunel(
      baseUrl,
      () => hostTuwunel?.output() ?? '',
    );
    check('Tuwunel 重启后恢复服务', restartedVersion !== 'unknown', restartedVersion);
    const resolvedRoom = await matrix.resolveAlias(room.alias);
    check('room alias 与状态在重启后保留', resolvedRoom.room_id === room.roomId);
    const restartedPing = await fetch(
      `${baseUrl}/_matrix/client/v1/appservice/${encodeURIComponent(appserviceId)}/ping`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${asToken}`,
          'content-type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      },
    );
    check('重启后 registration 仍可用', restartedPing.ok, `HTTP ${String(restartedPing.status)}`);

    section('Matrix -> QQ');
    await matrix.inviteUser(room.roomId, ALLOWED_USER, ghostUserId);
    await matrix.joinRoom(room.roomId, ALLOWED_USER);
    const deniedTransactionId = `tuwunel-check-denied-${randomBytes(8).toString('hex')}`;
    const deniedEvent = await matrix.sendEvent(
      room.roomId,
      'm.room.message',
      {
        msgtype: 'm.text',
        body: `${MATRIX_BODY} denied`,
      },
      deniedTransactionId,
      ALLOWED_USER,
    );
    await waitFor('权限不足消息 transaction 处理完成', async () => {
      if (!completedEvents.has(deniedEvent.event_id)) {
        const deliveredTransaction = transactions.find((transaction) =>
          transaction.events?.some((event) => event.event_id === deniedEvent.event_id),
        );
        const eventSummary =
          deliveredTransaction?.events
            ?.map((event) => `${event.type}:${event.sender}`)
            .join(', ') ?? 'missing';
        throw new Error(
          `transaction 尚未处理完成，已收到 ${String(transactions.length)} 个 transaction，事件序列：${eventSummary}`,
        );
      }
    });
    check('权限不足的 Matrix 用户未触发 QQ 发送', qqReplies.length === 0);

    await matrix.sendStateEvent(
      room.roomId,
      'm.room.power_levels',
      '',
      {
        users: {
          [ALLOWED_USER]: 10,
        },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
      ghostUserId,
    );
    const matrixEvent = await matrix.sendEvent(
      room.roomId,
      'm.room.message',
      {
        msgtype: 'm.text',
        body: MATRIX_BODY,
      },
      `tuwunel-check-${randomBytes(8).toString('hex')}`,
      ALLOWED_USER,
    );
    await waitFor('Matrix 消息 transaction 回推', async () => {
      const event = transactionEvents(transactions).find(
        (candidate) => candidate.event_id === matrixEvent.event_id,
      );
      if (event === undefined) {
        throw new Error('尚未收到对应事件');
      }
      return event;
    });
    check('Tuwunel 已回推 Matrix transaction', matrixEvent.event_id !== '');

    const reply = await waitFor('QQ 出站调用', async () => {
      const value = qqReplies.find((candidate) => candidate.content.includes(MATRIX_BODY));
      if (value === undefined) {
        throw new Error('尚未调用 QQ 发送接口');
      }
      return value;
    });
    check(
      'bridge 已将 Matrix 消息交给 QQ 端口',
      reply.content === MATRIX_BODY,
    );

    section('房间成员管理');
    const activeStatus = await runMatrixAdmin(matrix, bridgeConfig, {
      action: 'status',
      room: room.roomId,
      user: ALLOWED_USER,
    });
    check(
      '管理状态确认已批准成员可转发',
      activeStatus.action === 'status' &&
        activeStatus.membership === 'join' &&
        activeStatus.powerLevel === 10 &&
        activeStatus.canForward,
    );

    const qqRepliesBeforeKick = qqReplies.length;
    await runMatrixAdmin(matrix, bridgeConfig, {
      action: 'kick',
      room: room.roomId,
      user: ALLOWED_USER,
      actor: ghostUserId,
      reason: 'tuwunel-check revocation',
    });
    const kickedMember = await matrix.getRoomMember(room.roomId, ALLOWED_USER);
    check('管理 CLI 已踢出房间成员', kickedMember?.membership === 'leave');
    let kickedSendRejected = false;
    let kickedSendStatus = 0;
    try {
      await matrix.sendEvent(
        room.roomId,
        'm.room.message',
        {
          msgtype: 'm.text',
          body: `${MATRIX_REJOIN_BODY} kicked`,
        },
        `tuwunel-check-kicked-${randomBytes(8).toString('hex')}`,
        ALLOWED_USER,
      );
    } catch (error) {
      if (error instanceof MatrixApiError) {
        kickedSendStatus = error.status;
        kickedSendRejected = error.status >= 400 && error.status < 500;
      }
    }
    check(
      '被踢成员无法继续发送 Matrix 消息',
      kickedSendRejected,
      `HTTP ${String(kickedSendStatus)}`,
    );
    check('被踢成员未触发 QQ 发送', qqReplies.length === qqRepliesBeforeKick);
    const kickedStatus = await runMatrixAdmin(matrix, bridgeConfig, {
      action: 'status',
      room: room.roomId,
      user: ALLOWED_USER,
    });
    check(
      '管理状态确认被踢成员不可转发',
      kickedStatus.action === 'status' &&
        kickedStatus.membership === 'leave' &&
        !kickedStatus.canForward,
    );

    await runMatrixAdmin(matrix, bridgeConfig, {
      action: 'invite',
      room: room.roomId,
      user: ALLOWED_USER,
      actor: ghostUserId,
    });
    const invitedMember = await matrix.getRoomMember(room.roomId, ALLOWED_USER);
    check('管理 CLI 已重新邀请成员', invitedMember?.membership === 'invite');
    await matrix.joinRoom(room.roomId, ALLOWED_USER);
    const rejoinedStatus = await runMatrixAdmin(matrix, bridgeConfig, {
      action: 'status',
      room: room.roomId,
      user: ALLOWED_USER,
    });
    check(
      '重新加入后管理状态恢复转发准入',
      rejoinedStatus.action === 'status' &&
        rejoinedStatus.membership === 'join' &&
        rejoinedStatus.canForward,
    );
    const rejoinedEvent = await matrix.sendEvent(
      room.roomId,
      'm.room.message',
      {
        msgtype: 'm.text',
        body: MATRIX_REJOIN_BODY,
      },
      `tuwunel-check-rejoin-${randomBytes(8).toString('hex')}`,
      ALLOWED_USER,
    );
    await waitFor('重新加入后 Matrix transaction 处理完成', async () => {
      if (!completedEvents.has(rejoinedEvent.event_id)) {
        throw new Error('transaction 尚未处理完成');
      }
    });
    const rejoinedReply = await waitFor('重新加入后 QQ 出站调用', async () => {
      const value = qqReplies.find((candidate) =>
        candidate.content.includes(MATRIX_REJOIN_BODY),
      );
      if (value === undefined) {
        throw new Error('尚未调用 QQ 发送接口');
      }
      return value;
    });
    check(
      '重新邀请并加入后恢复 Matrix 到 QQ 转发',
      rejoinedReply.content === MATRIX_REJOIN_BODY,
    );

    const matrixReplyEvent = await matrix.sendEvent(
      room.roomId,
      'm.room.message',
      {
        msgtype: 'm.text',
        body: MATRIX_REPLY_BODY,
        'm.relates_to': {
          rel_type: 'm.in_reply_to',
          event_id: referenceEvent.event_id,
        },
      },
      `tuwunel-check-reply-${randomBytes(8).toString('hex')}`,
      ALLOWED_USER,
    );
    await waitFor('Matrix 引用 transaction 回推', async () => {
      const event = transactionEvents(transactions).find(
        (candidate) => candidate.event_id === matrixReplyEvent.event_id,
      );
      if (event === undefined) {
        throw new Error('尚未收到对应事件');
      }
      return event;
    });
    const matrixReplyIndex = await waitFor('Matrix 引用 QQ 调用', async () => {
      const index = qqReplies.findIndex((candidate) =>
        candidate.content.includes(MATRIX_REPLY_BODY),
      );
      if (index < 0) {
        throw new Error('尚未调用 QQ 回复接口');
      }
      return index;
    });
    check(
      'Matrix 引用映射为 QQ message_reference',
      qqReplies[matrixReplyIndex]?.messageReference === REFERENCE_INDEX,
      qqReplies[matrixReplyIndex]?.messageReference ?? 'missing reference',
    );

    await matrix.redactEvent(
      room.roomId,
      matrixEvent.event_id,
      `tuwunel-check-redact-${randomBytes(8).toString('hex')}`,
      ALLOWED_USER,
    );
    await waitFor('Matrix 撤回 transaction 回推', async () => {
      const event = transactionEvents(transactions).find(
        (candidate) =>
          candidate.type === 'm.room.redaction' &&
          (candidate.redacts ?? stringField(candidate.content, 'redacts')) ===
            matrixEvent.event_id,
      );
      if (event === undefined) {
        throw new Error('尚未收到对应撤回事件');
      }
      return event;
    });
    await waitFor('QQ 撤回调用', async () => {
      const recall = qqRecalls.find(
        (candidate) => candidate.messageId === 'tuwunel-check-reply-1',
      );
      if (recall === undefined) {
        throw new Error('尚未调用 QQ 撤回接口');
      }
      return recall;
    });
    check('Matrix redaction 经 Tuwunel 映射为 QQ 撤回', qqRecalls.length === 1);

    const matrixMediaUri = await matrix.uploadMedia(
      MEDIA_BYTES,
      MEDIA_CONTENT_TYPE,
      MATRIX_MEDIA_BODY,
    );
    const matrixMediaEvent = await matrix.sendEvent(
      room.roomId,
      'm.room.message',
      {
        msgtype: 'm.image',
        body: MATRIX_MEDIA_BODY,
        url: matrixMediaUri,
      },
      `tuwunel-check-media-${randomBytes(8).toString('hex')}`,
      ALLOWED_USER,
    );
    await waitFor('Matrix 媒体 transaction 回推', async () => {
      const event = transactionEvents(transactions).find(
        (candidate) => candidate.event_id === matrixMediaEvent.event_id,
      );
      if (event === undefined) {
        throw new Error('尚未收到对应事件');
      }
      return event;
    });
    const forwardedMedia = await waitFor('QQ 媒体发送调用', async () => {
      const value = qqMedia.find(
        (candidate) =>
          candidate.fileName === MATRIX_MEDIA_BODY &&
          candidate.buffer?.equals(MEDIA_BYTES) === true,
      );
      if (value === undefined) {
        throw new Error('尚未调用 QQ 媒体发送接口');
      }
      return value;
    });
    check(
      'Matrix 媒体经 Tuwunel 下载后交给 QQ 端口',
      forwardedMedia.fileType === MediaFileType.IMAGE &&
        forwardedMedia.content === undefined,
    );

    section('Guild / DM');
    await bridge.handleQqMessage(guildMessage());
    const guildRoom = store.getRoom(
      conversationKey('guild', `${GUILD_ID}/${GUILD_CHANNEL_ID}`),
    );
    check(
      'QQ guild 会话创建 Matrix room 并保留 channel 出站目标',
      guildRoom?.kind === 'guild' && guildRoom.targetId === GUILD_CHANNEL_ID,
    );
    if (guildRoom === undefined) {
      throw new Error('缺少 guild room 映射');
    }
    const guildEvent = await waitFor('guild ghost 消息 transaction', async () => {
      const event = transactionEvents(transactions).find(
        (candidate) =>
          candidate.sender === ghostUserId &&
          candidate.room_id === guildRoom.roomId &&
          candidate.type === 'm.room.message' &&
          stringField(candidate.content, 'body') === GUILD_QQ_BODY,
      );
      if (event === undefined) {
        throw new Error('尚未收到对应事件');
      }
      return event;
    });
    check('QQ guild 文本已写入 Tuwunel', guildEvent.event_id !== '');

    await matrix.inviteUser(guildRoom.roomId, ALLOWED_USER, ghostUserId);
    await matrix.sendStateEvent(
      guildRoom.roomId,
      'm.room.power_levels',
      '',
      {
        users: { [ALLOWED_USER]: 10 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
      ghostUserId,
    );
    await matrix.joinRoom(guildRoom.roomId, ALLOWED_USER);
    const guildMatrixEvent = await matrix.sendEvent(
      guildRoom.roomId,
      'm.room.message',
      {
        msgtype: 'm.text',
        body: GUILD_MATRIX_BODY,
      },
      `tuwunel-check-guild-${randomBytes(8).toString('hex')}`,
      ALLOWED_USER,
    );
    await waitFor('guild Matrix transaction 处理完成', async () => {
      if (!completedEvents.has(guildMatrixEvent.event_id)) {
        throw new Error('transaction 尚未处理完成');
      }
    });
    const guildReply = qqReplies.find((candidate) =>
      candidate.content.includes(GUILD_MATRIX_BODY),
    );
    check(
      'Matrix guild 文本出站目标为 channel ID',
      guildReply?.target.scope === 'guild' &&
        guildReply.target.targetId === GUILD_CHANNEL_ID &&
        guildReply.target.msgId === GUILD_MESSAGE_ID,
    );

    await bridge.handleQqMessage(dmMessage());
    const dmRoom = store.getRoom(conversationKey('dm', DM_GUILD_ID));
    check(
      'QQ DM 会话创建 Matrix room 并保留 guild 出站目标',
      dmRoom?.kind === 'dm' && dmRoom.targetId === DM_GUILD_ID,
    );
    if (dmRoom === undefined) {
      throw new Error('缺少 DM room 映射');
    }
    const dmEvent = await waitFor('DM ghost 消息 transaction', async () => {
      const event = transactionEvents(transactions).find(
        (candidate) =>
          candidate.sender === ghostUserId &&
          candidate.room_id === dmRoom.roomId &&
          candidate.type === 'm.room.message' &&
          stringField(candidate.content, 'body') === DM_QQ_BODY,
      );
      if (event === undefined) {
        throw new Error('尚未收到对应事件');
      }
      return event;
    });
    check('QQ DM 文本已写入 Tuwunel', dmEvent.event_id !== '');

    await matrix.inviteUser(dmRoom.roomId, ALLOWED_USER, ghostUserId);
    await matrix.sendStateEvent(
      dmRoom.roomId,
      'm.room.power_levels',
      '',
      {
        users: { [ALLOWED_USER]: 10 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
      ghostUserId,
    );
    await matrix.joinRoom(dmRoom.roomId, ALLOWED_USER);
    const dmMatrixEvent = await matrix.sendEvent(
      dmRoom.roomId,
      'm.room.message',
      {
        msgtype: 'm.text',
        body: DM_MATRIX_BODY,
      },
      `tuwunel-check-dm-${randomBytes(8).toString('hex')}`,
      ALLOWED_USER,
    );
    await waitFor('DM Matrix transaction 处理完成', async () => {
      if (!completedEvents.has(dmMatrixEvent.event_id)) {
        throw new Error('transaction 尚未处理完成');
      }
    });
    const dmReply = qqReplies.find((candidate) =>
      candidate.content.includes(DM_MATRIX_BODY),
    );
    check(
      'Matrix DM 文本出站目标为 guild ID',
      dmReply?.target.scope === 'dm' &&
        dmReply.target.targetId === DM_GUILD_ID &&
        dmReply.target.msgId === DM_MESSAGE_ID,
    );

    const guildDmMediaBefore = qqMedia.length;
    const guildMediaEvent = await matrix.sendEvent(
      guildRoom.roomId,
      'm.room.message',
      {
        msgtype: 'm.image',
        body: 'guild-image.png',
        url: matrixMediaUri,
      },
      `tuwunel-check-guild-media-${randomBytes(8).toString('hex')}`,
      ALLOWED_USER,
    );
    const dmMediaEvent = await matrix.sendEvent(
      dmRoom.roomId,
      'm.room.message',
      {
        msgtype: 'm.image',
        body: 'dm-image.png',
        url: matrixMediaUri,
      },
      `tuwunel-check-dm-media-${randomBytes(8).toString('hex')}`,
      ALLOWED_USER,
    );
    await waitFor('guild/DM 媒体 transaction 处理完成', async () => {
      if (
        !completedEvents.has(guildMediaEvent.event_id) ||
        !completedEvents.has(dmMediaEvent.event_id)
      ) {
        throw new Error('transaction 尚未处理完成');
      }
    });
    check(
      'guild/DM Matrix 媒体被忽略且 transaction 正常确认',
      qqMedia.length === guildDmMediaBefore &&
        store.hasMatrixEvent(guildMediaEvent.event_id) &&
        store.hasMatrixEvent(dmMediaEvent.event_id),
    );

    section('生产入口');
    await runCommand('pnpm', ['build'], 60_000);
    await appservice.stop();
    appservice = undefined;
    await store.flush();

    const entryWebhookPort = await getFreePort();
    const entryPort = address.port;
    const entryBaseUrl = `http://127.0.0.1:${String(entryPort)}`;
    const entryWebhookUrl = `http://127.0.0.1:${String(entryWebhookPort)}${ENTRY_WEBHOOK_PATH}`;
    const entryEnv: NodeJS.ProcessEnv = {
      ...process.env,
      QQBOT_APP_ID: 'tuwunel-entry-check',
      QQBOT_APP_SECRET: ENTRY_APP_SECRET,
      QQBOT_TRANSPORT: 'webhook',
      QQBOT_WEBHOOK_PORT: String(entryWebhookPort),
      QQBOT_WEBHOOK_PATH: ENTRY_WEBHOOK_PATH,
      QQBOT_TOKEN_PREFETCH: 'async',
      QQBOT_API_BASE_URL: 'http://127.0.0.1:1',
      QQBOT_TOKEN_BASE_URL: 'http://127.0.0.1:1',
      LOG_LEVEL: 'error',
      LOG_CONSOLE: 'false',
      LOG_FILE: 'off',
      CHAT_LOG_ENABLED: 'false',
      MATRIX_BRIDGE_ENABLED: 'true',
      MATRIX_BRIDGE_ID: appserviceId,
      MATRIX_BRIDGE_HOMESERVER_URL: baseUrl,
      MATRIX_BRIDGE_DOMAIN: DOMAIN,
      MATRIX_BRIDGE_AS_TOKEN: asToken,
      MATRIX_BRIDGE_HS_TOKEN: hsToken,
      MATRIX_BRIDGE_SENDER_LOCALPART: senderLocalpart,
      MATRIX_BRIDGE_USER_PREFIX: userPrefix,
      MATRIX_BRIDGE_ALIAS_PREFIX: aliasPrefix,
      MATRIX_BRIDGE_IDENTITY_SECRET: identitySecret,
      MATRIX_BRIDGE_ALLOWED_SENDERS: ALLOWED_USER,
      MATRIX_BRIDGE_MIN_POWER_LEVEL: String(bridgeConfig.minPowerLevel),
      MATRIX_BRIDGE_DATA_FILE: bridgeConfig.dataFile,
      MATRIX_BRIDGE_LISTEN_HOST: bridgeConfig.listenHost,
      MATRIX_BRIDGE_PORT: String(entryPort),
      MATRIX_BRIDGE_SHUTDOWN_TIMEOUT_MS: '250',
    };
    const waitForEntryHealth = async (description: string): Promise<void> => {
      await waitFor(description, async () => {
        const response = await fetch(`${entryBaseUrl}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${String(response.status)}`);
        }
        return response;
      }).catch((error: unknown) => {
        const detail = entryProcess?.output();
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}${
            detail === undefined || detail === '' ? '' : `\n生产入口输出：\n${detail}`
          }`,
        );
      });
    };

    entryProcess = startBridgeEntry(entryEnv);
    await waitForEntryHealth('生产入口健康检查');
    check('编译后的生产入口可以启动 appservice', entryProcess.process.exitCode === null);

    await waitFor('QQ Webhook 已监听', async () => {
      const response = await fetch(entryWebhookUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(2_000),
      });
      return response.status;
    });
    await waitFor('Tuwunel 可访问生产入口', async () => {
      const response = await fetch(
        `${baseUrl}/_matrix/client/v1/appservice/${encodeURIComponent(appserviceId)}/ping`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${asToken}`,
            'content-type': 'application/json',
          },
          body: '{}',
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`);
      }
      return response;
    });

    const webhookTimestamp = String(Math.floor(Date.now() / 1_000));
    const webhookBody = JSON.stringify({
      op: 0,
      id: 'TUWUNEL-CHECK-ENTRY-EVENT',
      s: 1,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: ENTRY_QQ_MESSAGE_ID,
        author: {
          member_openid: QQ_USER_ID,
          username: 'Tuwunel entry check user',
          bot: false,
        },
        content: ENTRY_QQ_BODY,
        group_openid: ENTRY_GROUP_OPENID,
        timestamp: new Date().toISOString(),
        message_type: 0,
      },
    });
    const webhookSignature = ed25519Sign(
      ENTRY_APP_SECRET,
      Buffer.concat([
        Buffer.from(webhookTimestamp, 'utf8'),
        Buffer.from(webhookBody, 'utf8'),
      ]),
    );
    const webhookResponse = await fetch(entryWebhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': webhookSignature,
        'x-signature-timestamp': webhookTimestamp,
      },
      body: webhookBody,
      signal: AbortSignal.timeout(5_000),
    });
    const webhookAck = (await webhookResponse.json()) as { op?: number };
    check(
      '生产入口接受并确认 QQ Webhook',
      webhookResponse.status === 200 && webhookAck.op === 12,
      `HTTP ${String(webhookResponse.status)}, op=${String(webhookAck.op)}`,
    );

    const entryAlias = deriveRoomAlias(
      identitySecret,
      conversationKey('group', ENTRY_GROUP_OPENID),
      aliasPrefix,
    );
    const entryRoom = await waitFor('生产入口创建 Matrix room', async () => {
      try {
        return await matrix.resolveAlias(entryAlias);
      } catch (error) {
        throw new Error(
          `尚未解析 ${entryAlias}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    const entryEvent = await waitFor('生产入口 QQ 事件写入 Tuwunel', async () => {
      const messages = await fetchRoomMessages(baseUrl, asToken, entryRoom.room_id);
      const event = messages.find(
        (candidate) =>
          candidate.sender === ghostUserId &&
          candidate.type === 'm.room.message' &&
          stringField(candidate.content, 'body') === ENTRY_QQ_BODY,
      );
      if (event === undefined) {
        throw new Error('尚未收到对应事件');
      }
      return event;
    });
    check(
      '生产入口将 QQ Webhook 事件经 Tuwunel 写入 Matrix',
      entryEvent.event_id !== '',
    );

    const stalledEntrySocket = connectSocket({ host: '127.0.0.1', port: entryPort });
    entryStalledSocket = stalledEntrySocket;
    await new Promise<void>((resolve, reject) => {
      stalledEntrySocket.once('connect', resolve);
      stalledEntrySocket.once('error', reject);
    });
    stalledEntrySocket.on('error', () => undefined);
    stalledEntrySocket.write(
      [
        'PUT /_matrix/app/v1/transactions/stalled-entry HTTP/1.1',
        `Host: 127.0.0.1:${String(entryPort)}`,
        `Authorization: Bearer ${hsToken}`,
        'Content-Type: application/json',
        'Content-Length: 100',
        '',
        '{',
      ].join('\r\n'),
    );
    await sleep(50);
    const entryStopStartedAt = Date.now();
    const entryExitCode = await stopBridgeEntry(entryProcess);
    entryProcess = undefined;
    const entryStopElapsedMs = Date.now() - entryStopStartedAt;
    entryStalledSocket.destroy();
    entryStalledSocket = undefined;
    check(
      '生产入口收到 SIGTERM 后正常退出',
      entryExitCode === 0,
      `exit=${String(entryExitCode)}`,
    );
    check(
      '生产入口关闭超时后释放滞留请求',
      entryStopElapsedMs >= 150 && entryStopElapsedMs < 4_000,
      `elapsed=${String(entryStopElapsedMs)}ms`,
    );
    let entryPortClosed = false;
    try {
      await fetch(`${entryBaseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
    } catch {
      entryPortClosed = true;
    }
    check('生产入口退出后释放监听端口', entryPortClosed);

    const faultCases = [
      { fault: 'uncaughtException', label: '未捕获异常' },
      { fault: 'unhandledRejection', label: '未处理拒绝' },
    ] as const;
    for (const { fault, label } of faultCases) {
      entryProcess = startBridgeEntry(
        {
          ...entryEnv,
          QQBOT_WEBHOOK_PORT: String(await getFreePort()),
          MATRIX_BRIDGE_TEST_FAULT: fault,
        },
        'dist/scripts/matrix-fault-injection.js',
      );
      await waitForEntryHealth(`生产入口 ${label} 故障夹具启动`);
      entryProcess.process.kill('SIGUSR2');
      const faultExitCode = await waitForBridgeEntryExit(entryProcess);
      entryProcess = undefined;
      check(
        `生产入口 ${label} 以非零退出码结束`,
        faultExitCode !== null && faultExitCode !== 0,
        `exit=${String(faultExitCode)}`,
      );

      let faultPortClosed = false;
      try {
        await fetch(`${entryBaseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      } catch {
        faultPortClosed = true;
      }
      check(`生产入口 ${label} 关闭后释放监听端口`, faultPortClosed);
    }

    console.log('\nTuwunel 集成检查通过。');
  } catch (error) {
    if (hostTuwunel !== undefined) {
      const logs = hostTuwunel.output();
      if (logs !== '') {
        console.error('\nTuwunel 本机进程日志：');
        console.error(logs);
      }
    }
    throw error;
  } finally {
    entryStalledSocket?.destroy();
    if (entryProcess !== undefined) {
      await stopBridgeEntry(entryProcess).catch(() => undefined);
    }
    await appservice?.stop().catch(() => undefined);
    await store?.flush().catch(() => undefined);
    await mediaFixture?.close().catch(() => undefined);
    if (hostTuwunel !== undefined) {
      await stopProcess(hostTuwunel, 30_000).catch(() => undefined);
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `\nTuwunel 集成检查失败：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
