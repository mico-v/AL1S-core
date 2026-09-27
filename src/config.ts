/**
 * 运行时配置：只从环境变量读取，保持最小。
 *
 * 连接相关的凭据与参数全部交给 `@tencent-connect/qqbot-nodejs`，
 * 这里只做解析、校验和默认值，不实现协议细节。
 */

import { parseLogLevel, type LogLevel, type LoggerOptions } from './logger.js';

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

export interface BotConfig {
  appId: string;
  appSecret: string;
  /** 账号标识，用于日志与会话持久化；默认等于 appId。 */
  accountId: string;
  transport: TransportMode;
  webhook: WebhookConfig;
  /** 自定义 intents 位掩码；不填则使用 SDK 默认（群 + 单聊 + 互动）。 */
  intents?: number;
  /** 机器人是否拥有 Markdown 权限，影响 sendText 的 msg_type。 */
  markdownSupport: boolean;
  tokenPrefetch: TokenPrefetch;
  /** 日志配置。 */
  logging: LoggerOptions;
  /** 聊天记录配置。 */
  chatLog: ChatLogConfig;
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
    apiBaseUrl: pick(env, 'QQBOT_API_BASE_URL'),
    tokenBaseUrl: pick(env, 'QQBOT_TOKEN_BASE_URL'),
  };
}
