/**
 * QQ 官方机器人 <-> Matrix Application Service 双向桥接。
 *
 * QQ 用户映射为 Matrix ghost 用户；Matrix 出站消息由 QQ 机器人代发，
 * 因为 QQ 官方平台不允许第三方机器人冒充普通 QQ 用户。
 */

import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ApiError,
  MediaFileType,
  type QQBotInboundMessage,
  type ReplyTarget,
} from '@tencent-connect/qqbot-nodejs';
import type { Bot, QqReplyOptions } from '../bot.js';
import type { MatrixBridgeConfig } from '../config.js';
import type { AppLogger } from '../logger.js';
import type { MatrixEvent, MatrixTransaction } from '../matrix/appservice.js';
import {
  MatrixApiError,
  type JsonObject,
  type MatrixClient,
} from '../matrix/client.js';
import {
  type BridgeMetrics,
  type QqMessageKind,
} from '../matrix/metrics.js';
import {
  BridgeStore,
  type BridgeRoomRecord,
  type ConversationKind,
  type ConversationTarget,
} from './store.js';

export type QqBotPort = {
  replyText: (
    target: ReplyTarget,
    content: string,
    options?: QqReplyOptions,
  ) => ReturnType<Bot['replyText']>;
  sendMedia: Bot['sendMedia'];
  recall: Bot['recall'];
};

export interface QqMatrixBridgeOptions {
  bot: QqBotPort;
  matrix: MatrixClient;
  store: BridgeStore;
  config: MatrixBridgeConfig;
  logger: AppLogger;
  metrics?: BridgeMetrics;
  fetchImpl?: typeof fetch;
  maxMediaBytes?: number;
  /** 主动消息命中频控后的最大重试次数。 */
  qqRateLimitRetries?: number;
  /** 首次频控重试前的等待时间，后续按指数退避。 */
  qqRetryBaseDelayMs?: number;
  /** 测试可替换的等待实现。 */
  sleepImpl?: (delayMs: number) => Promise<void>;
  /** QQ 入站持久化队列首次重试延迟。 */
  qqInboundRetryBaseMs?: number;
  /** QQ 入站持久化队列最大重试延迟。 */
  qqInboundRetryMaxMs?: number;
  /** QQ 入站持久化队列重放检查间隔。 */
  qqInboundReplayIntervalMs?: number;
  /** 测试可替换的当前时间实现。 */
  now?: () => number;
}

interface DownloadedMedia {
  data: Buffer;
  contentType: string;
}

type QqAttachment = NonNullable<QQBotInboundMessage['attachments']>[number];

interface StructuredMessageContent {
  /** 顶层正文与结构化元素合并后的文本。 */
  text: string;
  /** 引用元素提取的摘录，用于回复 fallback 正文。 */
  quoteExcerpt?: string;
  /** 引用元素携带的原发送者显示名。 */
  quoteSender?: string;
  /** 去重、限量后的可转发附件，不含引用元素附件。 */
  attachments: QqAttachment[];
  /** 是否命中深度、元素、附件或长度限制。 */
  truncated: boolean;
}

const DEFAULT_MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const DEFAULT_QQ_RATE_LIMIT_RETRIES = 3;
const DEFAULT_QQ_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_QQ_INBOUND_RETRY_BASE_MS = 5_000;
const DEFAULT_QQ_INBOUND_RETRY_MAX_MS = 5 * 60_000;
const DEFAULT_QQ_INBOUND_REPLAY_INTERVAL_MS = 5_000;
const PASSIVE_REPLY_UNAVAILABLE_CODES = new Set([40034005, 40034128]);
const ACTIVE_MESSAGE_RATE_LIMIT_CODES = new Set([40034100]);
const STRUCTURED_MAX_DEPTH = 4;
const STRUCTURED_MAX_ELEMENTS = 64;
const STRUCTURED_MAX_ATTACHMENTS = 16;
const STRUCTURED_MAX_TEXT_LENGTH = 4096;
const STRUCTURED_MAX_EXCERPT_LENGTH = 500;
const MAX_QQ_FACE_EXT_BYTES = 64 * 1024;
const STRUCTURED_TRUNCATION_MARKER = '\n[消息过长，已截断]';
const QQ_FACE_TAG_PATTERN = /<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g;
const ARK_FIELD_KEYS = ['title', 'desc', 'tag', 'tags', 'source', 'nickname', 'address'] as const;

function digest(secret: string, value: string, length = 64): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex').slice(0, length);
}

export function conversationKey(kind: ConversationKind, targetId: string): string {
  return `${kind}:${targetId}`;
}

export function deriveGhostLocalpart(secret: string, qqUserId: string, prefix = '_qq_'): string {
  return `${prefix}${digest(secret, qqUserId)}`;
}

function normalizeContentType(value: string | null): string {
  const contentType = value?.split(';', 1)[0]?.trim().toLowerCase();
  return contentType === undefined || contentType === '' ? 'application/octet-stream' : contentType;
}

function mediaKind(contentType: string, msgType: unknown): MediaFileType {
  if (msgType === 'm.image' || contentType.startsWith('image/')) {
    return MediaFileType.IMAGE;
  }
  if (msgType === 'm.video' || contentType.startsWith('video/')) {
    return MediaFileType.VIDEO;
  }
  if (msgType === 'm.audio' || contentType.startsWith('audio/')) {
    return MediaFileType.VOICE;
  }
  return MediaFileType.FILE;
}

function matrixMediaType(contentType: string): 'm.image' | 'm.video' | 'm.audio' | 'm.file' {
  if (contentType.startsWith('image/')) return 'm.image';
  if (contentType.startsWith('video/')) return 'm.video';
  if (contentType.startsWith('audio/')) return 'm.audio';
  return 'm.file';
}

function stringField(content: JsonObject, key: string): string | undefined {
  const value = content[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function decodeQqFaceName(ext: string): string | undefined {
  const padding = ext.endsWith('==') ? 2 : ext.endsWith('=') ? 1 : 0;
  if (Math.ceil((ext.length * 3) / 4) - padding > MAX_QQ_FACE_EXT_BYTES) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(ext, 'base64').toString('utf8'));
    return isRecord(parsed) ? nonEmptyString(parsed['text'])?.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 将 QQ face 标签转换为可读文本。
 *
 * 图片消息常携带 `faceType=6,faceId="0",ext={"text":""}` 占位符；
 * 空名称必须渲染为空，避免在真实图片前多发一条无意义文本。
 */
function renderQqContent(value: string): string {
  return value
    .replace(QQ_FACE_TAG_PATTERN, (_tag: string, ext: string): string => {
      const name = decodeQqFaceName(ext);
      return name === undefined ? '' : `【表情: ${name}】`;
    })
    .trim();
}

function truncateStructuredText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  const head = value.slice(0, Math.max(0, limit - STRUCTURED_TRUNCATION_MARKER.length));
  return `${head}${STRUCTURED_TRUNCATION_MARKER}`;
}

function arkFieldText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() === '' ? undefined : value;
  }
  if (Array.isArray(value)) {
    const parts = value.filter(
      (item): item is string => typeof item === 'string' && item.trim() !== '',
    );
    return parts.length === 0 ? undefined : parts.join(' ');
  }
  return undefined;
}

function structuredElementSender(node: Record<string, unknown>): string | undefined {
  const author = node['author'];
  if (!isRecord(author)) {
    return undefined;
  }
  return nonEmptyString(author['username']) ?? nonEmptyString(author['nickname']);
}

/**
 * 将 `message_type=3` 的 ARK 卡片压缩为可读文本。
 *
 * 只保留常见展示字段，忽略 `jump_url`、`preview` 等链接或图片键，避免把
 * 原始 JSON 或不可点击的 URL 直接写进 Matrix 正文。
 */
function arkFallbackText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const segments: string[] = [];
  const arkName = nonEmptyString(value['ark_name']) ?? nonEmptyString(value['ark_type']);
  if (arkName !== undefined) {
    segments.push(`[QQ 卡片: ${arkName.trim()}]`);
  }
  const prompt = nonEmptyString(value['prompt']);
  if (prompt !== undefined) {
    segments.push(prompt.trim());
  }
  const fields = value['fields'];
  if (isRecord(fields)) {
    for (const key of ARK_FIELD_KEYS) {
      const text = arkFieldText(fields[key]);
      if (text !== undefined) {
        segments.push(`${key}: ${text.trim()}`);
      }
    }
  }
  return segments.length === 0 ? undefined : segments.join('\n');
}

function normalizeAttachment(value: unknown): QqAttachment | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const url = nonEmptyString(value['url']);
  if (url === undefined) {
    return undefined;
  }
  const attachment: QqAttachment = {
    content_type: nonEmptyString(value['content_type']) ?? 'application/octet-stream',
    url,
  };
  const filename = nonEmptyString(value['filename']);
  if (filename !== undefined) {
    attachment.filename = filename;
  }
  const voiceWavUrl = nonEmptyString(value['voice_wav_url']);
  if (voiceWavUrl !== undefined) {
    attachment.voice_wav_url = voiceWavUrl;
  }
  const asrReferText = nonEmptyString(value['asr_refer_text']);
  if (asrReferText !== undefined) {
    attachment.asr_refer_text = asrReferText;
  }
  for (const key of ['width', 'height', 'size'] as const) {
    const size = value[key];
    if (typeof size === 'number' && Number.isFinite(size)) {
      attachment[key] = size;
    }
  }
  return attachment;
}

function normalizeAttachments(value: unknown): QqAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const attachments: QqAttachment[] = [];
  for (const item of value) {
    const attachment = normalizeAttachment(item);
    if (attachment !== undefined) {
      attachments.push(attachment);
    }
  }
  return attachments;
}

function structuredElements(message: QQBotInboundMessage): unknown[] {
  if (Array.isArray(message.msgElements) && message.msgElements.length > 0) {
    return message.msgElements;
  }
  const raw: Record<string, unknown> = isRecord(message.raw) ? message.raw : {};
  const rawElements = raw['msg_elements'];
  return Array.isArray(rawElements) ? rawElements : [];
}

/**
 * 把 QQ 结构化消息（`message_type=3/101/102/103`）压缩为有界文本与附件。
 *
 * `msg_elements` 是递归结构，`message_type=103` 时顶层元素是被引用内容，
 * 只进入引用 fallback，不重复写入正文；其余元素按文档顺序合并进正文。
 * 所有遍历都受深度、元素数、附件数和文本长度限制，超限时截断并标记。
 */
function extractStructuredMessage(message: QQBotInboundMessage): StructuredMessageContent {
  const elements = structuredElements(message);
  const refIndex = message.refMsgIdx;
  const raw: Record<string, unknown> = isRecord(message.raw) ? message.raw : {};
  const messageType =
    typeof message.msgType === 'number'
      ? message.msgType
      : typeof raw['message_type'] === 'number'
        ? raw['message_type']
        : undefined;
  const hasIndexedQuote =
    refIndex !== undefined &&
    elements.some(
      (element) => isRecord(element) && nonEmptyString(element['msg_idx']) === refIndex,
    );
  const quoteAsWhole = refIndex !== undefined && (messageType === 103 || !hasIndexedQuote);

  const bodyParts: string[] = [];
  const quoteParts: string[] = [];
  const attachments: QqAttachment[] = [];
  const seenAttachments = new Set<string>();
  let quoteAttachment: QqAttachment | undefined;
  let quoteSender: string | undefined;
  let visited = 0;
  let truncated = false;

  const pushText = (parts: string[], value: string): void => {
    const text = value.trim();
    if (text === '' || parts.includes(text)) {
      return;
    }
    parts.push(text);
  };

  const addAttachment = (attachment: QqAttachment): void => {
    const key = attachment.voice_wav_url ?? attachment.url;
    if (seenAttachments.has(key)) {
      return;
    }
    if (attachments.length >= STRUCTURED_MAX_ATTACHMENTS) {
      truncated = true;
      return;
    }
    seenAttachments.add(key);
    attachments.push(attachment);
  };

  const topContent = nonEmptyString(message.content);
  if (topContent !== undefined) {
    pushText(bodyParts, renderQqContent(topContent));
  }
  const arkText = arkFallbackText(raw['ark_data']);
  if (arkText !== undefined) {
    pushText(bodyParts, arkText);
  }
  for (const attachment of normalizeAttachments(message.attachments)) {
    addAttachment(attachment);
  }

  const walk = (nodes: unknown, depth: number, mode: 'body' | 'quote'): void => {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return;
    }
    if (depth > STRUCTURED_MAX_DEPTH) {
      truncated = true;
      return;
    }
    for (const node of nodes) {
      if (visited >= STRUCTURED_MAX_ELEMENTS) {
        truncated = true;
        return;
      }
      if (!isRecord(node)) {
        continue;
      }
      visited += 1;
      const quoted =
        mode === 'quote' ||
        (quoteAsWhole && depth === 0) ||
        (refIndex !== undefined && nonEmptyString(node['msg_idx']) === refIndex);
      const target = quoted ? 'quote' : 'body';
      const targetParts = target === 'quote' ? quoteParts : bodyParts;
      const content = nonEmptyString(node['content']);
      if (content !== undefined) {
        pushText(targetParts, renderQqContent(content));
      } else {
        const arkText = arkFallbackText(node['ark_data']);
        if (arkText !== undefined) {
          pushText(targetParts, arkText);
        }
      }
      if (target === 'quote') {
        quoteSender ??= structuredElementSender(node);
      }
      for (const attachment of normalizeAttachments(node['attachments'])) {
        if (target === 'quote') {
          quoteAttachment ??= attachment;
        } else {
          addAttachment(attachment);
        }
      }
      walk(node['msg_elements'], depth + 1, target);
    }
  };

  walk(elements, 0, 'body');

  const bodyText = bodyParts.join('\n');
  if (bodyText.length > STRUCTURED_MAX_TEXT_LENGTH) {
    truncated = true;
  }
  let quoteExcerpt = quoteParts.length === 0 ? undefined : quoteParts.join('\n');
  if (quoteExcerpt !== undefined && quoteExcerpt.length > STRUCTURED_MAX_EXCERPT_LENGTH) {
    quoteExcerpt = truncateStructuredText(quoteExcerpt, STRUCTURED_MAX_EXCERPT_LENGTH);
  }
  if (quoteExcerpt === undefined && quoteAttachment !== undefined) {
    quoteExcerpt =
      quoteAttachment.filename === undefined
        ? `[${quoteAttachment.content_type}]`
        : `[${quoteAttachment.content_type}: ${quoteAttachment.filename}]`;
  }

  return {
    text: truncateStructuredText(bodyText, STRUCTURED_MAX_TEXT_LENGTH),
    ...(quoteExcerpt === undefined ? {} : { quoteExcerpt }),
    ...(quoteSender === undefined ? {} : { quoteSender }),
    attachments,
    truncated,
  };
}

function isMatrixEdit(content: JsonObject): boolean {
  const relation = content['m.relates_to'];
  return (
    relation !== null &&
    typeof relation === 'object' &&
    !Array.isArray(relation) &&
    relation.rel_type === 'm.replace'
  );
}

function matrixReplyEventId(content: JsonObject): string | undefined {
  const relation = content['m.relates_to'];
  if (relation === null || typeof relation !== 'object' || Array.isArray(relation)) {
    return undefined;
  }
  if (relation.rel_type !== 'm.in_reply_to') {
    return undefined;
  }
  return typeof relation.event_id === 'string' ? relation.event_id : undefined;
}

function quoteFallback(sender: string, excerpt: string): string {
  const lines = excerpt
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `> ${line}`);
  return [`> <${sender}>`, ...lines].join('\n');
}

function isTerminalRecallError(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return false;
  }
  return [40061001, 40061002, 40062003, 40064004, 306009].includes(error.bizCode ?? -1);
}

function isPassiveReplyUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    PASSIVE_REPLY_UNAVAILABLE_CODES.has(error.bizCode ?? -1)
  );
}

function isActiveMessageRateLimited(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.httpStatus === 429 || ACTIVE_MESSAGE_RATE_LIMIT_CODES.has(error.bizCode ?? -1))
  );
}

function metricKind(kind: QQBotInboundMessage['kind']): QqMessageKind {
  return kind === 'group' || kind === 'c2c' || kind === 'guild' || kind === 'dm'
    ? kind
    : 'other';
}

function isDirectConversation(kind: ConversationKind): boolean {
  return kind === 'c2c' || kind === 'dm';
}

function roomName(kind: ConversationKind): string {
  switch (kind) {
    case 'group':
      return 'QQ 群聊';
    case 'c2c':
      return 'QQ 单聊';
    case 'guild':
      return 'QQ 频道';
    case 'dm':
      return 'QQ 频道私信';
  }
}

function conversationTarget(message: QQBotInboundMessage): ConversationTarget | undefined {
  if (message.kind === 'group') {
    const targetId = message.groupOpenid;
    return targetId === undefined || targetId === ''
      ? undefined
      : { key: conversationKey('group', targetId), kind: 'group', targetId };
  }
  if (message.kind === 'c2c') {
    const targetId = message.senderId;
    return targetId === ''
      ? undefined
      : { key: conversationKey('c2c', targetId), kind: 'c2c', targetId };
  }
  if (message.kind === 'guild') {
    const guildId = message.guildId;
    const channelId = message.channelId;
    return guildId === undefined ||
      guildId === '' ||
      channelId === undefined ||
      channelId === ''
      ? undefined
      : {
          key: conversationKey('guild', `${guildId}/${channelId}`),
          kind: 'guild',
          targetId: channelId,
        };
  }
  const guildId = message.guildId;
  return guildId === undefined || guildId === ''
    ? undefined
    : { key: conversationKey('dm', guildId), kind: 'dm', targetId: guildId };
}

export class QqMatrixBridge {
  private readonly bot: QqBotPort;
  private readonly matrix: MatrixClient;
  private readonly store: BridgeStore;
  private readonly config: MatrixBridgeConfig;
  private readonly logger: AppLogger;
  private readonly metrics?: BridgeMetrics;
  private readonly fetchImpl: typeof fetch;
  private readonly maxMediaBytes: number;
  private readonly qqRateLimitRetries: number;
  private readonly qqRetryBaseDelayMs: number;
  private readonly qqInboundRetryBaseMs: number;
  private readonly qqInboundRetryMaxMs: number;
  private readonly qqInboundReplayIntervalMs: number;
  private readonly now: () => number;
  private readonly sleepImpl: (delayMs: number) => Promise<void>;
  private readonly qqMessagesInFlight = new Set<string>();
  private readonly qqMessageTasks = new Set<Promise<void>>();
  private readonly roomEnsuring = new Map<string, Promise<BridgeRoomRecord>>();
  private replayTimer?: NodeJS.Timeout;
  private replayTask?: Promise<void>;
  private replayStarted = false;

  constructor(options: QqMatrixBridgeOptions) {
    this.bot = options.bot;
    this.matrix = options.matrix;
    this.store = options.store;
    this.config = options.config;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
    this.qqRateLimitRetries = Math.max(
      0,
      options.qqRateLimitRetries ?? DEFAULT_QQ_RATE_LIMIT_RETRIES,
    );
    this.qqRetryBaseDelayMs = Math.max(
      0,
      options.qqRetryBaseDelayMs ?? DEFAULT_QQ_RETRY_BASE_DELAY_MS,
    );
    this.qqInboundRetryBaseMs = Math.max(
      0,
      options.qqInboundRetryBaseMs ??
        options.config.qqInboundRetryBaseMs ??
        DEFAULT_QQ_INBOUND_RETRY_BASE_MS,
    );
    this.qqInboundRetryMaxMs = Math.max(
      this.qqInboundRetryBaseMs,
      options.qqInboundRetryMaxMs ??
        options.config.qqInboundRetryMaxMs ??
        DEFAULT_QQ_INBOUND_RETRY_MAX_MS,
    );
    this.qqInboundReplayIntervalMs = Math.max(
      1,
      options.qqInboundReplayIntervalMs ??
        options.config.qqInboundReplayIntervalMs ??
        DEFAULT_QQ_INBOUND_REPLAY_INTERVAL_MS,
    );
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleepImpl ?? sleep;
  }

  handleQqMessage(message: QQBotInboundMessage): Promise<void> {
    const task = this.acceptQqMessage(message);
    this.qqMessageTasks.add(task);
    void task.then(
      () => {
        this.qqMessageTasks.delete(task);
      },
      () => {
        this.qqMessageTasks.delete(task);
      },
    );
    return task;
  }

  /** 启动持久化 QQ 入站消息的定时重放。 */
  async start(): Promise<void> {
    if (this.replayStarted) {
      return;
    }
    this.replayStarted = true;
    try {
      await this.reconcileMappedRooms();
      await this.replayDueQqMessages();
      this.replayTimer = setInterval(() => {
        void this.replayDueQqMessages().catch((error: unknown) => {
          this.metrics?.recordError();
          this.logger.error('重放 QQ 入站消息失败', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, this.qqInboundReplayIntervalMs);
      this.replayTimer.unref();
      this.logger.info('QQ 入站消息重放器已启动', {
        intervalMs: this.qqInboundReplayIntervalMs,
        retryBaseMs: this.qqInboundRetryBaseMs,
        retryMaxMs: this.qqInboundRetryMaxMs,
      });
    } catch (error) {
      this.replayStarted = false;
      throw error;
    }
  }

  /** 停止重放器；调用方应随后执行 flush() 等待在途任务。 */
  async stop(): Promise<void> {
    this.replayStarted = false;
    if (this.replayTimer !== undefined) {
      clearInterval(this.replayTimer);
      this.replayTimer = undefined;
    }
    if (this.replayTask !== undefined) {
      await this.replayTask;
    }
  }

  /** 等待已接收的 QQ 消息处理完毕，供优雅关闭使用。 */
  async flush(): Promise<void> {
    for (;;) {
      const tasks = [...this.qqMessageTasks];
      if (this.replayTask !== undefined) {
        tasks.push(this.replayTask);
      }
      if (tasks.length === 0) {
        return;
      }
      await Promise.allSettled(tasks);
    }
  }

  private async acceptQqMessage(message: QQBotInboundMessage): Promise<void> {
    if (message.senderIsBot === true || message.messageId === '') {
      this.metrics?.recordQqMessage(message.kind, 'ignored');
      return;
    }
    if (this.qqMessagesInFlight.has(message.messageId)) {
      this.metrics?.recordQqMessage(message.kind, 'duplicate');
      this.logger.debug('忽略处理中重复 QQ 消息', { kind: message.kind });
      return;
    }

    const enqueueResult = await this.store.enqueueQqMessage(message);
    if (enqueueResult === 'duplicate') {
      this.metrics?.recordQqMessage(message.kind, 'duplicate');
      this.logger.debug('忽略重复 QQ 消息', { kind: message.kind });
      return;
    }
    if (enqueueResult === 'full') {
      this.metrics?.recordQqMessage(message.kind, 'error');
      this.metrics?.recordError();
      this.logger.error('QQ 入站持久化队列已满，消息未保存', { kind: message.kind });
      return;
    }

    await this.processQueuedQqMessage(message, 0);
  }

  private replayDueQqMessages(): Promise<void> {
    if (!this.replayStarted) {
      return Promise.resolve();
    }
    if (this.replayTask !== undefined) {
      return this.replayTask;
    }
    const task = this.runDueQqMessages();
    this.replayTask = task;
    const clear = (): void => {
      if (this.replayTask === task) {
        this.replayTask = undefined;
      }
    };
    void task.then(clear, clear);
    return task;
  }

  private async runDueQqMessages(): Promise<void> {
    const pendingMessages = this.store.getDueQqMessages(this.now());
    for (const pending of pendingMessages) {
      if (!this.replayStarted) {
        return;
      }
      if (!this.store.hasPendingQqMessage(pending.message.messageId)) {
        continue;
      }
      await this.processQueuedQqMessage(pending.message, pending.attempts);
    }
  }

  private async processQueuedQqMessage(
    message: QQBotInboundMessage,
    attempts: number,
  ): Promise<void> {
    if (this.qqMessagesInFlight.has(message.messageId)) {
      return;
    }
    this.qqMessagesInFlight.add(message.messageId);
    try {
      await this.processQqMessage(message);
    } catch (error) {
      const delayMs = Math.min(
        this.qqInboundRetryMaxMs,
        this.qqInboundRetryBaseMs * 2 ** Math.min(attempts, 30),
      );
      const nextAttemptAt = this.now() + delayMs;
      try {
        await this.store.deferQqMessage(message.messageId, nextAttemptAt);
      } catch (deferError) {
        this.metrics?.recordQqMessage(message.kind, 'error');
        this.metrics?.recordError();
        this.logger.error('保存 QQ 入站消息重试状态失败', {
          kind: message.kind,
          error: deferError instanceof Error ? deferError.message : String(deferError),
        });
        throw deferError;
      }
      this.metrics?.recordQqMessage(message.kind, 'error');
      this.metrics?.recordError();
      this.logger.warn('QQ 入站消息处理失败，已安排重试', {
        kind: message.kind,
        attempt: attempts + 1,
        delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    } finally {
      this.qqMessagesInFlight.delete(message.messageId);
    }

    await this.store.completeQqMessage(message.messageId);
  }

  private async processQqMessage(message: QQBotInboundMessage): Promise<void> {
    const target = conversationTarget(message);
    if (target === undefined) {
      this.metrics?.recordQqMessage(message.kind, 'ignored');
      this.logger.warn('QQ 消息缺少会话目标，已忽略', { kind: message.kind });
      return;
    }

    await this.store.recordInbound(target, message.messageId);
    const ghostUserId = `@${deriveGhostLocalpart(
      this.config.identitySecret,
      message.senderId,
      this.config.userPrefix,
    )}:${this.config.domain}`;
    const senderDisplayName = this.qqSenderDisplayName(message);
    await this.refreshGhostDisplayName(ghostUserId, senderDisplayName);
    const room = await this.ensureRoom(target, ghostUserId);
    // 群聊中每个 QQ 用户都是独立 ghost；房间已存在时新 ghost 仍未加入，
    // 发送前必须确保其 membership 为 join，否则 homeserver 会拒绝事件。
    await this.ensureGhostJoined(room.roomId, ghostUserId);

    const structured = extractStructuredMessage(message);
    if (structured.truncated) {
      this.logger.debug('QQ 结构化消息超出限制，已截断', {
        kind: message.kind,
        msgType: message.msgType ?? null,
      });
    }
    const quoted = message.refMsgIdx === undefined
      ? undefined
      : this.store.getReference(message.refMsgIdx);
    const replyContent: JsonObject =
      quoted === undefined
        ? {}
        : { 'm.relates_to': { rel_type: 'm.in_reply_to', event_id: quoted.matrixEventId } };
    const quotedSender = quoted?.sender ?? structured.quoteSender ?? senderDisplayName;
    const body =
      structured.quoteExcerpt === undefined
        ? structured.text
        : `${quoteFallback(quotedSender, structured.quoteExcerpt)}\n\n${structured.text}`;

    let sent = false;
    let firstMatrixEventId: string | undefined;
    if (structured.text.trim() !== '') {
      const response = await this.matrix.sendEvent(
        room.roomId,
        'm.room.message',
        {
          msgtype: 'm.text',
          body,
          'org.al1s.qq.sender': senderDisplayName,
          'org.al1s.qq.message_id': message.messageId,
          ...replyContent,
        },
        `qq-${digest(this.config.identitySecret, message.messageId)}`,
        ghostUserId,
      );
      firstMatrixEventId = response.event_id;
      sent = true;
    }

    for (const [index, attachment] of structured.attachments.entries()) {
      try {
        const eventId = await this.forwardQqAttachment(
          room,
          ghostUserId,
          message,
          attachment,
          index,
          replyContent,
        );
        firstMatrixEventId ??= eventId;
        sent = true;
      } catch (error) {
        this.logger.warn('转发 QQ 媒体到 Matrix 失败', {
          kind: message.kind,
          index,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!sent) {
      this.metrics?.recordQqMessage(message.kind, 'ignored');
      this.logger.debug('QQ 消息没有可转发内容', { kind: message.kind });
    } else if (message.msgIdx !== undefined && firstMatrixEventId !== undefined) {
      await this.store.rememberReference({
        qqReference: message.msgIdx,
        matrixEventId: firstMatrixEventId,
        sender: senderDisplayName,
        excerpt: (structured.text.trim() || structured.quoteExcerpt || '').slice(0, 500),
      });
    }
    if (sent) {
      this.metrics?.recordQqMessage(message.kind, 'forwarded');
    }
  }

  async handleTransaction(transactionId: string, transaction: MatrixTransaction): Promise<void> {
    if (this.store.hasTransaction(transactionId)) {
      this.metrics?.recordTransaction('duplicate');
      this.logger.debug('忽略重复 Matrix transaction');
      return;
    }

    try {
      for (const event of transaction.events ?? []) {
        if (this.store.hasMatrixEvent(event.event_id)) {
          this.metrics?.recordMatrixEvent('duplicate');
          continue;
        }
        try {
          await this.handleMatrixEvent(event);
          await this.store.rememberMatrixEvent(event.event_id);
          this.metrics?.recordMatrixEvent('processed');
        } catch (error) {
          this.metrics?.recordMatrixEvent('error');
          throw error;
        }
      }
      await this.store.rememberTransaction(transactionId);
      this.metrics?.recordTransaction('success');
    } catch (error) {
      this.metrics?.recordTransaction('error');
      this.metrics?.recordError();
      throw error;
    }
  }

  private async ensureRoom(
    target: ConversationTarget,
    ghostUserId: string,
  ): Promise<BridgeRoomRecord> {
    const existing = this.store.getRoom(target.key);
    if (existing !== undefined) {
      return existing;
    }

    const pending = this.roomEnsuring.get(target.key);
    if (pending !== undefined) {
      return pending;
    }

    const task = this.createRoom(target, ghostUserId);
    this.roomEnsuring.set(target.key, task);
    try {
      return await task;
    } finally {
      if (this.roomEnsuring.get(target.key) === task) {
        this.roomEnsuring.delete(target.key);
      }
    }
  }

  private async createRoom(
    target: ConversationTarget,
    ghostUserId: string,
  ): Promise<BridgeRoomRecord> {
    const aliasLocalpart = `${this.config.aliasPrefix}${digest(this.config.identitySecret, target.key)}`;
    const alias = `#${aliasLocalpart}:${this.config.domain}`;
    let roomId: string;
    try {
      ({ room_id: roomId } = await this.matrix.resolveAlias(alias));
    } catch (error) {
      if (!(error instanceof MatrixApiError) || error.status !== 404) {
        throw error;
      }
      const created = await this.matrix.createRoom(
        {
          name: roomName(target.kind),
          topic: '由 AL1S QQ Matrix bridge 维护',
          roomAliasName: aliasLocalpart,
          preset: 'private_chat',
          visibility: 'private',
          invite: [this.matrix.userId, ...this.explicitAllowedSenders()],
          isDirect: isDirectConversation(target.kind),
        },
        ghostUserId,
      );
      roomId = created.room_id;
    }

    await this.ensureBotCanJoin(roomId, ghostUserId);
    const room: BridgeRoomRecord = {
      ...target,
      roomId,
      alias,
      createdAt: new Date().toISOString(),
    };
    await this.store.setRoom(room);
    this.logger.info('已建立 QQ/Matrix 房间映射', { kind: target.kind, roomId });
    return room;
  }

  private qqSenderDisplayName(message: QQBotInboundMessage): string {
    const senderName = nonEmptyString(message.senderName);
    if (senderName !== undefined) {
      return senderName.trim();
    }
    const raw = isRecord(message.raw) ? message.raw : undefined;
    const author = raw === undefined ? undefined : raw['author'];
    const authorRecord = isRecord(author) ? (author as Record<string, unknown>) : undefined;
    const username =
      authorRecord === undefined ? undefined : nonEmptyString(authorRecord['username']);
    if (username !== undefined) {
      return username.trim();
    }
    return `QQ 用户 ${digest(this.config.identitySecret, message.senderId, 8)}`;
  }

  private async refreshGhostDisplayName(
    ghostUserId: string,
    displayName: string,
  ): Promise<void> {
    try {
      await this.matrix.setDisplayName(ghostUserId, displayName, ghostUserId);
    } catch (error) {
      this.logger.debug('设置 Matrix ghost 显示名失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private explicitAllowedSenders(): string[] {
    return this.config.allowedSenders.filter(
      (userId) => userId !== '*' && !this.isBridgeUser(userId),
    );
  }

  private async reconcileMappedRooms(): Promise<void> {
    for (const room of this.store.listRooms()) {
      await this.ensureAllowedUsersInvited(room.roomId);
    }
  }

  private async ensureAllowedUsersInvited(roomId: string): Promise<void> {
    for (const userId of this.explicitAllowedSenders()) {
      try {
        const member = await this.matrix.getRoomMember(roomId, userId);
        if (member?.membership === 'join' || member?.membership === 'invite') {
          continue;
        }
        await this.matrix.inviteUser(roomId, userId, this.matrix.userId);
        this.logger.info('已邀请 Matrix 用户加入 QQ 映射房间', { roomId, userId });
      } catch (error) {
        this.logger.warn('邀请 Matrix 用户加入 QQ 映射房间失败', {
          roomId,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async ensureBotCanJoin(roomId: string, ghostUserId: string): Promise<void> {
    try {
      await this.matrix.joinRoom(roomId);
      return;
    } catch (firstError) {
      this.logger.debug('bridge 用户直接加入房间失败，尝试由 ghost 邀请', {
        error: firstError instanceof Error ? firstError.message : String(firstError),
      });
    }

    try {
      await this.matrix.inviteUser(roomId, this.matrix.userId, ghostUserId);
      await this.matrix.joinRoom(roomId);
    } catch (error) {
      this.logger.warn('bridge 用户未能加入房间，不影响 ghost 消息转发', {
        roomId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureGhostJoined(roomId: string, ghostUserId: string): Promise<void> {
    const member = await this.matrix.getRoomMember(roomId, ghostUserId);
    if (member?.membership === 'join') {
      return;
    }
    // 映射房间为 private，非成员无法直接 join；先由已加入的 appservice bot
    // 邀请该 ghost，再以 ghost 身份加入。
    try {
      await this.matrix.inviteUser(roomId, ghostUserId, this.matrix.userId);
    } catch (error) {
      this.logger.debug('邀请 ghost 加入房间失败，尝试直接加入', {
        roomId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await this.matrix.joinRoom(roomId, ghostUserId);
  }

  private async forwardQqAttachment(
    room: BridgeRoomRecord,
    ghostUserId: string,
    message: QQBotInboundMessage,
    attachment: QqAttachment,
    index: number,
    replyContent: JsonObject,
  ): Promise<string> {
    const sourceUrl = attachment.voice_wav_url ?? attachment.url;
    const downloaded = await this.downloadMedia(sourceUrl, attachment.content_type);
    this.metrics?.addMediaBytes('qq_to_matrix', downloaded.data.byteLength);
    const contentType = downloaded.contentType;
    const filename = attachment.filename ?? `qq-${String(index + 1)}`;
    const contentUri = await this.matrix.uploadMedia(
      downloaded.data,
      contentType,
      filename,
      ghostUserId,
    );
    const msgtype = matrixMediaType(contentType);
    const content: JsonObject = {
      msgtype,
      body: filename,
      url: contentUri,
      info: {
        mimetype: contentType,
        size: downloaded.data.byteLength,
      },
      ...replyContent,
    };
    const response = await this.matrix.sendEvent(
      room.roomId,
      'm.room.message',
      content,
      `qq-media-${digest(this.config.identitySecret, `${message.messageId}:${String(index)}`)}`,
      ghostUserId,
    );
    return response.event_id;
  }

  private async handleMatrixEvent(event: MatrixEvent): Promise<void> {
    if (this.isBridgeUser(event.sender)) {
      return;
    }

    const room = this.store.getRoomByRoomId(event.room_id);
    if (room === undefined) {
      this.logger.debug('忽略未绑定的 Matrix 房间消息', { roomId: event.room_id });
      return;
    }
    if (!(await this.isMatrixSenderAuthorized(event.sender, room.roomId))) {
      return;
    }

    if (event.type === 'm.room.redaction') {
      await this.handleMatrixRedaction(event, room);
      return;
    }
    if (event.type !== 'm.room.message' || event.state_key !== undefined) {
      return;
    }
    if (isMatrixEdit(event.content)) {
      this.logger.debug('忽略暂不支持的 Matrix 编辑事件', {
        roomId: event.room_id,
        eventId: event.event_id,
      });
      return;
    }

    const msgtype = stringField(event.content, 'msgtype');
    const body = stringField(event.content, 'body') ?? '';

    if (msgtype === 'm.text' || msgtype === 'm.notice') {
      if (body === '') {
        return;
      }
      const target = await this.qqTarget(room);
      const replyEventId = matrixReplyEventId(event.content);
      const messageReference =
        replyEventId === undefined ? undefined : this.store.getQqReference(replyEventId);
      const response = await this.sendQqWithRecovery(room, target, (currentTarget) =>
        this.bot.replyText(
          currentTarget,
          body,
          messageReference === undefined ? undefined : { messageReference },
        ),
      );
      await this.rememberQqReference(event, body, response.ext_info?.ref_idx);
      await this.store.rememberOutboundMessage(event.event_id, {
        roomKey: room.key,
        qqMessageId: response.id,
        ...(response.ext_info?.ref_idx !== undefined
          ? { qqReference: response.ext_info.ref_idx }
          : {}),
      });
      return;
    }

    const mediaUrl = stringField(event.content, 'url');
    if (
      mediaUrl !== undefined &&
      (msgtype === 'm.image' || msgtype === 'm.video' || msgtype === 'm.audio' || msgtype === 'm.file')
    ) {
      if (room.kind === 'guild' || room.kind === 'dm') {
        this.logger.warn('QQ guild/DM 暂不支持 Matrix 媒体出站，已忽略', {
          roomId: room.roomId,
          kind: room.kind,
          msgtype,
        });
        return;
      }
      const downloaded = await this.matrix.downloadMedia(mediaUrl, this.maxMediaBytes);
      this.metrics?.addMediaBytes('matrix_to_qq', downloaded.data.byteLength);
      const target = await this.qqTarget(room);
      const response = await this.sendQqWithRecovery(room, target, (currentTarget) =>
        this.bot.sendMedia({
          target: currentTarget,
          fileType: mediaKind(downloaded.contentType, msgtype),
          buffer: downloaded.data,
          fileName: body || 'matrix-media',
        }),
      );
      if (response.message !== undefined) {
        await this.rememberQqReference(
          event,
          body,
          response.message.ext_info?.ref_idx,
        );
        await this.store.rememberOutboundMessage(event.event_id, {
          roomKey: room.key,
          qqMessageId: response.message.id,
          ...(response.message.ext_info?.ref_idx !== undefined
            ? { qqReference: response.message.ext_info.ref_idx }
            : {}),
        });
      }
      return;
    }

    this.logger.debug('忽略暂不支持的 Matrix 消息类型', {
      roomId: event.room_id,
      msgtype: msgtype ?? 'missing',
    });
  }

  private async sendQqWithRecovery<T>(
    room: BridgeRoomRecord,
    initialTarget: ReplyTarget,
    operation: (target: ReplyTarget) => Promise<T>,
  ): Promise<T> {
    let target = initialTarget;
    let passiveFallbackUsed = false;
    let rateLimitRetries = 0;

    for (;;) {
      try {
        const result = await operation(target);
        this.metrics?.recordQqSend(room.kind, 'success');
        return result;
      } catch (error) {
        if (
          !passiveFallbackUsed &&
          target.msgId !== undefined &&
          isPassiveReplyUnavailable(error)
        ) {
          await this.store.invalidateReplyWindow(room);
          target = { scope: target.scope, targetId: target.targetId };
          passiveFallbackUsed = true;
          this.metrics?.recordQqRecovery(room.kind, 'passive_unavailable');
          this.logger.warn('QQ 被动回复窗口不可用，降级为主动消息', {
            kind: room.kind,
            bizCode: error instanceof ApiError ? error.bizCode : undefined,
          });
          continue;
        }

        if (isActiveMessageRateLimited(error) && rateLimitRetries < this.qqRateLimitRetries) {
          const delayMs = this.qqRetryBaseDelayMs * 2 ** rateLimitRetries;
          rateLimitRetries += 1;
          this.metrics?.recordQqRecovery(room.kind, 'rate_limited');
          this.logger.warn('QQ 主动消息触发频控，退避重试', {
            kind: room.kind,
            attempt: rateLimitRetries,
            delayMs,
          });
          await this.sleepImpl(delayMs);
          continue;
        }

        this.metrics?.recordQqSend(room.kind, 'error');
        this.metrics?.recordError();
        throw error;
      }
    }
  }

  private async rememberQqReference(
    event: MatrixEvent,
    excerpt: string,
    qqReference: string | undefined,
  ): Promise<void> {
    if (qqReference === undefined) {
      return;
    }
    await this.store.rememberReference({
      qqReference,
      matrixEventId: event.event_id,
      sender: event.sender,
      excerpt: excerpt.slice(0, 500),
    });
  }

  private async handleMatrixRedaction(
    event: MatrixEvent,
    room: BridgeRoomRecord,
  ): Promise<void> {
    const redacts = event.redacts ?? stringField(event.content, 'redacts');
    if (redacts === undefined || redacts === '') {
      return;
    }
    const outbound = this.store.getOutboundMessage(redacts);
    if (outbound === undefined) {
      this.logger.debug('Matrix 撤回事件没有对应的 QQ 出站消息');
      return;
    }
    if (outbound.roomKey !== room.key) {
      this.logger.warn('拒绝跨房间的 Matrix 撤回映射');
      return;
    }

    try {
      await this.bot.recall(
        { scope: room.kind, targetId: room.targetId },
        outbound.qqMessageId,
      );
    } catch (error) {
      if (!isTerminalRecallError(error)) {
        throw error;
      }
      this.logger.warn('QQ 消息无法撤回，已跳过该 Matrix redaction', {
        roomId: room.roomId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await this.store.forgetOutboundMessage(redacts);
  }

  private async qqTarget(room: BridgeRoomRecord): Promise<ReplyTarget> {
    const hint = await this.store.consumeReply(room);
    return {
      scope: room.kind,
      targetId: room.targetId,
      ...(hint.msgId !== undefined ? { msgId: hint.msgId } : {}),
    };
  }

  private isBridgeUser(userId: string): boolean {
    if (userId === this.matrix.userId) {
      return true;
    }
    const prefix = `@${this.config.userPrefix}`.toLowerCase();
    const suffix = `:${this.config.domain}`.toLowerCase();
    const normalized = userId.toLowerCase();
    return normalized.startsWith(prefix) && normalized.endsWith(suffix);
  }

  private isSenderAllowed(userId: string): boolean {
    return (
      this.config.allowedSenders.includes('*') ||
      this.config.allowedSenders.includes(userId)
    );
  }

  private async isMatrixSenderAuthorized(userId: string, roomId: string): Promise<boolean> {
    if (!this.isSenderAllowed(userId)) {
      this.logger.debug('忽略未授权的 Matrix 发送者', {
        roomId,
        sender: userId,
        allowAll: this.config.allowedSenders.includes('*'),
      });
      return false;
    }

    const member = await this.matrix.getRoomMember(roomId, userId);
    if (member?.membership !== 'join') {
      this.logger.debug('忽略未加入目标 Matrix 房间的发送者', {
        roomId,
        sender: userId,
        membership: member?.membership ?? 'none',
      });
      return false;
    }

    const levels = await this.matrix.getRoomPowerLevels(roomId);
    const explicitLevel = levels?.users?.[userId];
    const powerLevel =
      typeof explicitLevel === 'number'
        ? explicitLevel
        : typeof levels?.users_default === 'number'
          ? levels.users_default
          : 0;
    if (powerLevel < this.config.minPowerLevel) {
      this.logger.debug('忽略 Matrix 房间权限不足的发送者', {
        roomId,
        sender: userId,
        powerLevel,
        minPowerLevel: this.config.minPowerLevel,
      });
      return false;
    }

    return true;
  }

  private async downloadMedia(url: string, fallbackContentType?: string): Promise<DownloadedMedia> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`不支持的媒体 URL 协议：${parsed.protocol}`);
    }
    const response = await this.fetchImpl(parsed, {
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`下载媒体失败：HTTP ${response.status}`);
    }
    const length = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > this.maxMediaBytes) {
      throw new Error(`媒体超过大小上限：${length}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > this.maxMediaBytes) {
      throw new Error(`媒体超过大小上限：${data.byteLength}`);
    }
    return {
      data,
      contentType: normalizeContentType(response.headers.get('content-type') ?? fallbackContentType ?? null),
    };
  }
}
