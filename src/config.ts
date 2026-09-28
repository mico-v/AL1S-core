/**
 * 运行时配置：只从环境变量读取，保持最小。
 *
 * 连接相关的凭据与参数全部交给 `@tencent-connect/qqbot-nodejs`，
 * 这里只做解析、校验和默认值，不实现协议细节。
 */

import { parseLogLevel, type LogLevel, type LoggerOptions } from './logger.js';
import { join } from 'node:path';

export type TransportMode = 'websocket' | 'webhook';
export type TokenPrefetch = 'sync' | 'async';

export interface WebhookConfig {
  /** Webhook 监听端口，官方只允许 80 / 443 / 8080 / 8443 对外。 */
  port: number;
  /** Webhook 监听路径。 */
  path: string;
}

export interface ChatLogConfig {
  /** 是否启用聊天记录持久化。 */
  enabled: boolean;
  /** 数据根目录，默认 ./data。 */
  root: string;
  /** 是否下载并保存图片/语音/视频/文件。 */
  saveMedia: boolean;
  /** 单个媒体文件大小上限（字节）。 */
  maxMediaBytes: number;
}

export interface MatrixBridgeConfig {
  /** Appservice registration ID。 */
  id: string;
  /** Tuwunel Client-Server API 基址。 */
  homeserverUrl: string;
  /** Matrix server name，也是 ghost 用户与房间别名的域名。 */
  domain: string;
  /** Appservice 调用 Tuwunel 时使用的 token。 */
  asToken: string;
  /** Tuwunel 推送 transaction 时使用的 token。 */
  hsToken: string;
  /** Appservice bot 的 localpart。 */
  senderLocalpart: string;
  /** Appservice bot 的完整用户 ID。 */
  userId: string;
  /** Appservice HTTP 服务监听地址。 */
  listenHost: string;
  /** Appservice HTTP 服务监听端口。 */
  listenPort: number;
  /** 可与 Tuwunel 共享的持久化状态文件。 */
  dataFile: string;
  /** QQ ghost 用户 localpart 前缀。 */
  userPrefix: string;
  /** QQ room alias localpart 前缀。 */
  aliasPrefix: string;
  /** 生成不可逆 QQ 用户标识的 HMAC 密钥。 */
  identitySecret: string;
  /** 允许触发 Matrix 到 QQ 转发的用户；`*` 表示显式允许所有用户。 */
  allowedSenders: string[];
  /** 房间内允许转发的最低 Matrix power level。 */
  minPowerLevel: number;
  /** QQ/Matrix 引用映射保留时长；0 表示不按时间过期。 */
  referenceTtlMs: number;
  /** QQ/Matrix 引用映射最大条数。 */
  maxReferences: number;
  /** QQ 入站消息首次重试前的等待时间。 */
  qqInboundRetryBaseMs: number;
  /** QQ 入站消息指数退避的最大等待时间。 */
  qqInboundRetryMaxMs: number;
  /** QQ 入站持久化队列的重放检查间隔。 */
  qqInboundReplayIntervalMs: number;
  /** QQ 入站持久化队列最大条数。 */
  qqInboundQueueMaxEntries: number;
  /** Matrix HTTP 请求超时时间。 */
  requestTimeoutMs: number;
  /** 优雅关闭等待 appservice 活跃连接的最长时间。 */
  shutdownTimeoutMs: number;
  /** 单个 QQ/Matrix 媒体转发大小上限（字节）。 */
  maxMediaBytes: number;
}

export interface BotConfig {
  appId: string;
  appSecret: string;
  /** 账号标识，用于日志与会话持久化；默认等于 appId。 */
  accountId: string;
  transport: TransportMode;
  webhook: WebhookConfig;
  /** 自定义 intents 位掩码；不填则使用 SDK 的完整默认集合。 */
  intents?: number;
  /** 机器人是否拥有 Markdown 权限，影响 sendText 的 msg_type。 */
  markdownSupport: boolean;
  tokenPrefetch: TokenPrefetch;
  /** 日志配置。 */
  logging: LoggerOptions;
  /** 聊天记录配置。 */
  chatLog: ChatLogConfig;
  /** 可选 Matrix bridge 配置；未启用时为 undefined。 */
  matrixBridge?: MatrixBridgeConfig;
  /** 覆盖 OpenAPI 基址（自建代理 / 测试用）。 */
  apiBaseUrl?: string;
  /** 覆盖 token 基址（自建代理 / 测试用）。 */
  tokenBaseUrl?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function pick(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') {
      return value.trim();
    }
  }
  return undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, key: string): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new ConfigError(`${key} 必须是非负整数：${value}`);
  }
  return Number.parseInt(normalized, 10);
}

function requireEnv(env: NodeJS.ProcessEnv, key: string, label: string): string {
  const value = pick(env, key);
  if (value === undefined) {
    throw new ConfigError(`启用 Matrix bridge 时缺少 ${key}：${label}`);
  }
  return value;
}

function validateLocalpart(value: string, key: string): string {
  if (!/^[0-9a-z._=/+-]+$/i.test(value)) {
    throw new ConfigError(`${key} 不是合法的 Matrix localpart：${value}`);
  }
  return value;
}

function validateServerName(value: string, key: string): string {
  if (value.includes('/') || value.includes('\\') || /\s/.test(value)) {
    throw new ConfigError(`${key} 不是合法的 Matrix server name：${value}`);
  }
  return value;
}

function validateHttpUrl(value: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${key} 不是合法 URL：${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`${key} 仅支持 http/https：${value}`);
  }
  return value;
}

function parseAllowedSenders(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }
  const entries = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  for (const entry of entries) {
    if (entry === '*') {
      continue;
    }
    const separator = entry.indexOf(':', 1);
    if (
      !entry.startsWith('@') ||
      separator <= 1 ||
      separator === entry.length - 1 ||
      /\s|[/\\]/.test(entry)
    ) {
      throw new ConfigError(`MATRIX_BRIDGE_ALLOWED_SENDERS 包含非法 Matrix 用户 ID：${entry}`);
    }
  }
  return [...new Set(entries)];
}

export function loadMatrixBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaultDataFile = join(
    pick(env, 'CHAT_DATA_DIR') ?? 'data',
    'matrix-bridge',
    'state.json',
  ),
): MatrixBridgeConfig | undefined {
  if (!parseBoolean(pick(env, 'MATRIX_BRIDGE_ENABLED'), false)) {
    return undefined;
  }

  const domain = validateServerName(
    requireEnv(env, 'MATRIX_BRIDGE_DOMAIN', 'Matrix server_name'),
    'MATRIX_BRIDGE_DOMAIN',
  );
  const senderLocalpart = validateLocalpart(
    pick(env, 'MATRIX_BRIDGE_SENDER_LOCALPART') ?? '_al1s_qq',
    'MATRIX_BRIDGE_SENDER_LOCALPART',
  );
  const userPrefix = validateLocalpart(
    pick(env, 'MATRIX_BRIDGE_USER_PREFIX') ?? '_qq_',
    'MATRIX_BRIDGE_USER_PREFIX',
  );
  const aliasPrefix = validateLocalpart(
    pick(env, 'MATRIX_BRIDGE_ALIAS_PREFIX') ?? '_qq_',
    'MATRIX_BRIDGE_ALIAS_PREFIX',
  );
  const identitySecret = requireEnv(env, 'MATRIX_BRIDGE_IDENTITY_SECRET', 'QQ openid HMAC 密钥');
  if (identitySecret.length < 16) {
    throw new ConfigError('MATRIX_BRIDGE_IDENTITY_SECRET 至少需要 16 个字符');
  }

  return {
    id: pick(env, 'MATRIX_BRIDGE_ID') ?? 'al1s-qq-bridge',
    homeserverUrl: validateHttpUrl(
      requireEnv(env, 'MATRIX_BRIDGE_HOMESERVER_URL', 'Tuwunel Client-Server API 地址'),
      'MATRIX_BRIDGE_HOMESERVER_URL',
    ),
    domain,
    asToken: requireEnv(env, 'MATRIX_BRIDGE_AS_TOKEN', 'appservice as_token'),
    hsToken: requireEnv(env, 'MATRIX_BRIDGE_HS_TOKEN', 'appservice hs_token'),
    senderLocalpart,
    userId: `@${senderLocalpart}:${domain}`,
    listenHost: pick(env, 'MATRIX_BRIDGE_LISTEN_HOST') ?? '127.0.0.1',
    listenPort: parsePositiveInt(pick(env, 'MATRIX_BRIDGE_PORT'), 29328),
    dataFile: pick(env, 'MATRIX_BRIDGE_DATA_FILE') ?? defaultDataFile,
    userPrefix,
    aliasPrefix,
    identitySecret,
    allowedSenders: parseAllowedSenders(pick(env, 'MATRIX_BRIDGE_ALLOWED_SENDERS')),
    minPowerLevel: parseNonNegativeInt(
      pick(env, 'MATRIX_BRIDGE_MIN_POWER_LEVEL'),
      0,
      'MATRIX_BRIDGE_MIN_POWER_LEVEL',
    ),
    referenceTtlMs:
      parseNonNegativeInt(
        pick(env, 'MATRIX_BRIDGE_REFERENCE_TTL_DAYS'),
        30,
        'MATRIX_BRIDGE_REFERENCE_TTL_DAYS',
      ) * DAY_MS,
    maxReferences: parsePositiveInt(
      pick(env, 'MATRIX_BRIDGE_REFERENCE_MAX_ENTRIES'),
      10_000,
    ),
    qqInboundRetryBaseMs: parsePositiveInt(
      pick(env, 'MATRIX_BRIDGE_QQ_RETRY_BASE_MS'),
      5_000,
    ),
    qqInboundRetryMaxMs: parsePositiveInt(
      pick(env, 'MATRIX_BRIDGE_QQ_RETRY_MAX_MS'),
      5 * 60_000,
    ),
    qqInboundReplayIntervalMs: parsePositiveInt(
      pick(env, 'MATRIX_BRIDGE_QQ_RETRY_INTERVAL_MS'),
      5_000,
    ),
    qqInboundQueueMaxEntries: parsePositiveInt(
      pick(env, 'MATRIX_BRIDGE_QQ_QUEUE_MAX_ENTRIES'),
      10_000,
    ),
    requestTimeoutMs: parsePositiveInt(pick(env, 'MATRIX_BRIDGE_REQUEST_TIMEOUT_MS'), 15_000),
    shutdownTimeoutMs: parsePositiveInt(
      pick(env, 'MATRIX_BRIDGE_SHUTDOWN_TIMEOUT_MS'),
      30_000,
    ),
    maxMediaBytes: parsePositiveInt(pick(env, 'MATRIX_BRIDGE_MEDIA_MAX_MB'), 50) * 1024 * 1024,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const appId = pick(env, 'QQBOT_APP_ID', 'QQ_APP_ID');
  const appSecret = pick(env, 'QQBOT_APP_SECRET', 'QQ_APP_SECRET');

  if (appId === undefined) {
    throw new ConfigError('缺少 QQBOT_APP_ID：请在 .env 中配置 QQ 机器人的 AppID');
  }
  if (appSecret === undefined) {
    throw new ConfigError('缺少 QQBOT_APP_SECRET：请在 .env 中配置 QQ 机器人的 AppSecret');
  }

  const transportRaw = pick(env, 'QQBOT_TRANSPORT')?.toLowerCase();
  const transport: TransportMode = transportRaw === 'webhook' ? 'webhook' : 'websocket';

  const intentsRaw = pick(env, 'QQBOT_INTENTS');
  let intents: number | undefined;
  if (intentsRaw !== undefined) {
    const parsed = Number.parseInt(intentsRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new ConfigError(`QQBOT_INTENTS 不是合法整数：${intentsRaw}`);
    }
    intents = parsed;
  }

  const tokenPrefetchRaw = pick(env, 'QQBOT_TOKEN_PREFETCH')?.toLowerCase();
  const tokenPrefetch: TokenPrefetch = tokenPrefetchRaw === 'async' ? 'async' : 'sync';

  const logFileRaw = pick(env, 'LOG_FILE');
  const logFileDisabled =
    logFileRaw !== undefined && ['off', 'none', 'false', '0'].includes(logFileRaw.toLowerCase());
  const logging: LoggerOptions = {
    level: parseLogLevel(pick(env, 'LOG_LEVEL')),
    console: parseBoolean(pick(env, 'LOG_CONSOLE'), true),
    file: logFileDisabled ? null : (logFileRaw ?? 'logs/bot.log'),
    maxSizeBytes: parsePositiveInt(pick(env, 'LOG_MAX_SIZE_MB'), 10) * 1024 * 1024,
    maxFiles: Math.max(2, parsePositiveInt(pick(env, 'LOG_MAX_FILES'), 5)),
  };

  const chatLog: ChatLogConfig = {
    enabled: parseBoolean(pick(env, 'CHAT_LOG_ENABLED'), true),
    root: pick(env, 'CHAT_DATA_DIR') ?? 'data',
    saveMedia: parseBoolean(pick(env, 'CHAT_SAVE_MEDIA'), true),
    maxMediaBytes: parsePositiveInt(pick(env, 'CHAT_MEDIA_MAX_MB'), 50) * 1024 * 1024,
  };

  const matrixBridge = loadMatrixBridgeConfig(
    env,
    join(chatLog.root, 'matrix-bridge', 'state.json'),
  );

  return {
    appId,
    appSecret,
    accountId: pick(env, 'QQBOT_ACCOUNT_ID') ?? appId,
    transport,
    webhook: {
      port: parsePositiveInt(pick(env, 'QQBOT_WEBHOOK_PORT'), 8080),
      path: pick(env, 'QQBOT_WEBHOOK_PATH') ?? '/',
    },
    intents,
    markdownSupport: parseBoolean(pick(env, 'QQBOT_MARKDOWN_SUPPORT'), false),
    tokenPrefetch,
    logging,
    chatLog,
    ...(matrixBridge !== undefined ? { matrixBridge } : {}),
    apiBaseUrl: pick(env, 'QQBOT_API_BASE_URL'),
    tokenBaseUrl: pick(env, 'QQBOT_TOKEN_BASE_URL'),
  };
}
