/**
 * Bridge 持久化状态。
 *
 * QQ 会话 ID、被动回复消息 ID 和去重 message ID 不以明文落盘。写入通过
 * 临时文件替换完成，进程内串行化，避免并发覆盖。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { AppLogger } from '../logger.js';
import type { BridgeMetrics } from '../matrix/metrics.js';

export type ConversationKind = 'group' | 'c2c' | 'guild' | 'dm';

export interface ConversationTarget {
  key: string;
  kind: ConversationKind;
  targetId: string;
}

export interface BridgeRoomRecord extends ConversationTarget {
  roomId: string;
  alias: string;
  createdAt: string;
}

export interface QqReplyHint extends ConversationTarget {
  msgId?: string;
}

interface StoredConversationTarget {
  kind: ConversationKind;
  targetId: string;
}

interface StoredRoomRecord extends StoredConversationTarget {
  key: string;
  roomId: string;
  alias: string;
  createdAt: string;
}

interface StoredPassiveReplyRecord extends StoredConversationTarget {
  msgId: string;
  windowStartedAt: number;
  used: number;
  limit?: number;
  expiresAt: number;
}

interface StoredOutboundMessage {
  roomKey: string;
  qqMessageId: string;
  qqReference?: string;
  createdAt: string;
}

interface PersistedStateV2 {
  version: 2;
  rooms: Record<string, StoredRoomRecord>;
  transactions: string[];
  matrixEvents: string[];
  qqMessages: string[];
  passiveReplies: Record<string, StoredPassiveReplyRecord>;
}

interface PersistedStateV3 extends Omit<PersistedStateV2, 'version'> {
  version: 3;
  outboundMessages: Record<string, StoredOutboundMessage>;
}

interface StoredReference {
  matrixEventId: string;
  sender: string;
  excerpt: string;
  qqReference?: string;
  roomId?: string;
  createdAt: string;
}

interface StoredPendingQqMessage {
  message: string;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
}

interface StoredMatrixMediaUpload {
  contentUri: string;
  contentType: string;
  size: number;
  createdAt: string;
}

interface StoredQqUser {
  qqUserId: string;
  displayName: string;
  updatedAt: string;
}

interface PersistedStateV4 {
  version: 4;
  rooms: Record<string, StoredRoomRecord>;
  transactions: string[];
  matrixEvents: string[];
  qqMessages: string[];
  passiveReplies: Record<string, StoredPassiveReplyRecord>;
  outboundMessages: Record<string, StoredOutboundMessage>;
  references: Record<string, StoredReference>;
  matrixReferences: Record<string, string>;
}

interface PersistedStateV6 {
  version: 6;
  rooms: Record<string, StoredRoomRecord>;
  transactions: string[];
  matrixEvents: string[];
  qqMessages: string[];
  passiveReplies: Record<string, StoredPassiveReplyRecord>;
  outboundMessages: Record<string, StoredOutboundMessage>;
  references: Record<string, StoredReference>;
  matrixReferences: Record<string, string>;
  pendingQqMessages: Record<string, StoredPendingQqMessage>;
}

interface PersistedStateV7 extends Omit<PersistedStateV6, 'version'> {
  version: 7;
  matrixMedia: Record<string, StoredMatrixMediaUpload>;
}

interface PersistedState extends Omit<PersistedStateV7, 'version'> {
  version: 8;
  qqUsers: Record<string, StoredQqUser>;
}

interface PersistedStateV5 {
  version: 5;
  rooms: Record<string, StoredRoomRecord>;
  transactions: string[];
  matrixEvents: string[];
  qqMessages: string[];
  passiveReplies: Record<string, StoredPassiveReplyRecord>;
  outboundMessages: Record<string, StoredOutboundMessage>;
  references: Record<string, StoredReference>;
  matrixReferences: Record<string, string>;
}

export interface OutboundQqMessage {
  roomKey: string;
  qqMessageId: string;
  qqReference?: string;
}

export interface BridgeReference {
  qqReference: string;
  matrixEventId: string;
  sender: string;
  excerpt: string;
  /** 新引用会记录来源房间；旧状态没有该字段时仍可通过精确索引查询。 */
  roomId?: string;
}

/** 摘录回退匹配的计数，用于日志诊断，不包含任何标识或正文。 */
export interface QuoteMatchDiagnostics {
  /** 同房间候选引用总数。 */
  roomReferences: number;
  /** 正文与引用摘录完全一致的候选数。 */
  exactMatches: number;
  /** 正文包含引用摘录的候选数。 */
  containedMatches: number;
  /** 完全一致且发送者也一致的候选数。 */
  senderExactMatches: number;
  /** 引用事件是否带有发送者信息。 */
  senderKnown: boolean;
}

export interface QuoteMatchResult {
  reference?: BridgeReference;
  diagnostics: QuoteMatchDiagnostics;
}

export interface PendingQqMessage {
  message: QQBotInboundMessage;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
}

export interface MatrixMediaUpload {
  contentUri: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface BridgeQqUser {
  matrixUserId: string;
  qqUserId: string;
  displayName: string;
}

export interface BridgeStoreOptions {
  file: string;
  /** 与 QQ openid HMAC 使用相同的长期密钥，用于加密状态字段。 */
  secret: string;
  logger?: AppLogger;
  metrics?: BridgeMetrics;
  maxHistory?: number;
  /** 引用映射保留时长；0 表示不按时间过期。 */
  referenceTtlMs?: number;
  /** 引用映射最大条数。 */
  maxReferences?: number;
  /** 待处理 QQ 入站消息最大条数。 */
  maxPendingQqMessages?: number;
  /** Matrix 媒体映射最大条数。 */
  maxMediaMappings?: number;
  now?: () => number;
}

export type EnqueueQqMessageResult = 'enqueued' | 'duplicate' | 'full';

interface PassiveLimit {
  limit?: number;
  windowMs: number;
}

const STATE_VERSION = 8;
const DEFAULT_REFERENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_REFERENCES = 10_000;
const DEFAULT_MAX_PENDING_QQ_MESSAGES = 10_000;
const DEFAULT_MAX_MEDIA_MAPPINGS = 20_000;
const PASSIVE_LIMITS: Record<ConversationKind, PassiveLimit> = {
  group: { limit: 5, windowMs: 5 * 60 * 1000 },
  c2c: { limit: 4, windowMs: 60 * 60 * 1000 },
  guild: { windowMs: 5 * 60 * 1000 },
  dm: { windowMs: 5 * 60 * 1000 },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isConversationKind(value: unknown): value is ConversationKind {
  return value === 'group' || value === 'c2c' || value === 'guild' || value === 'dm';
}

function isStoredTarget(value: unknown): value is StoredConversationTarget {
  return (
    isObject(value) &&
    isConversationKind(value.kind) &&
    typeof value.targetId === 'string'
  );
}

function isStoredRoom(value: unknown): value is StoredRoomRecord {
  return (
    isObject(value) &&
    isStoredTarget(value) &&
    typeof value.key === 'string' &&
    typeof value.roomId === 'string' &&
    typeof value.alias === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function isStoredPassiveReply(value: unknown): value is StoredPassiveReplyRecord {
  return (
    isObject(value) &&
    isStoredTarget(value) &&
    typeof value.msgId === 'string' &&
    typeof value.windowStartedAt === 'number' &&
    typeof value.used === 'number' &&
    (value.limit === undefined || typeof value.limit === 'number') &&
    typeof value.expiresAt === 'number'
  );
}

function isStoredOutboundMessage(value: unknown): value is StoredOutboundMessage {
  return (
    isObject(value) &&
    typeof value.roomKey === 'string' &&
    typeof value.qqMessageId === 'string' &&
    (value.qqReference === undefined || typeof value.qqReference === 'string') &&
    typeof value.createdAt === 'string'
  );
}

function isStoredReference(value: unknown): value is StoredReference {
  return (
    isObject(value) &&
    typeof value.matrixEventId === 'string' &&
    typeof value.sender === 'string' &&
    typeof value.excerpt === 'string' &&
    (value.qqReference === undefined || typeof value.qqReference === 'string') &&
    (value.roomId === undefined || typeof value.roomId === 'string') &&
    typeof value.createdAt === 'string'
  );
}

function normalizeReferenceText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^>\s?/, '').trim())
    .filter((line) => line !== '')
    .join('\n')
    .replace(/[ \t]+/g, ' ');
}

function normalizeReferenceSender(value: string): string {
  return value.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

function isStoredPendingQqMessage(value: unknown): value is StoredPendingQqMessage {
  return (
    isObject(value) &&
    typeof value.message === 'string' &&
    Number.isInteger(value.attempts) &&
    (value.attempts as number) >= 0 &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.nextAttemptAt === 'number' &&
    Number.isFinite(value.nextAttemptAt)
  );
}

function isStoredMatrixMediaUpload(value: unknown): value is StoredMatrixMediaUpload {
  return (
    isObject(value) &&
    typeof value.contentUri === 'string' &&
    typeof value.contentType === 'string' &&
    typeof value.size === 'number' &&
    Number.isFinite(value.size) &&
    typeof value.createdAt === 'string'
  );
}

function isStoredQqUser(value: unknown): value is StoredQqUser {
  return (
    isObject(value) &&
    typeof value.qqUserId === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function isStoredQqInboundMessage(value: unknown): value is QQBotInboundMessage {
  return (
    isObject(value) &&
    typeof value.rawEventType === 'string' &&
    isConversationKind(value.kind) &&
    typeof value.senderId === 'string' &&
    typeof value.content === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.timestamp === 'string' &&
    isObject(value.replyTarget) &&
    typeof value.replyTarget.scope === 'string' &&
    typeof value.replyTarget.targetId === 'string' &&
    isObject(value.raw)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function hasPersistedBaseFields(value: unknown): boolean {
  if (
    !isObject(value) ||
    !isObject(value.rooms) ||
    !isStringArray(value.transactions) ||
    !isStringArray(value.matrixEvents) ||
    !isStringArray(value.qqMessages) ||
    !isObject(value.passiveReplies)
  ) {
    return false;
  }
  return (
    Object.values(value.rooms).every(isStoredRoom) &&
    Object.values(value.passiveReplies).every(isStoredPassiveReply)
  );
}

function isPersistedStateV2(value: unknown): value is PersistedStateV2 {
  return isObject(value) && value.version === 2 && hasPersistedBaseFields(value);
}

function isPersistedStateV3(value: unknown): value is PersistedStateV3 {
  return (
    isObject(value) &&
    value.version === 3 &&
    hasPersistedBaseFields(value) &&
    isObject(value.outboundMessages) &&
    Object.values(value.outboundMessages).every(isStoredOutboundMessage)
  );
}

function isPersistedStateV4(value: unknown): value is PersistedStateV4 {
  return (
    isObject(value) &&
    value.version === 4 &&
    hasPersistedBaseFields(value) &&
    isObject(value.outboundMessages) &&
    Object.values(value.outboundMessages).every(isStoredOutboundMessage) &&
    isObject(value.references) &&
    Object.values(value.references).every(isStoredReference) &&
    isObject(value.matrixReferences) &&
    Object.values(value.matrixReferences).every((item) => typeof item === 'string')
  );
}

function isPersistedStateV5(value: unknown): value is PersistedStateV5 {
  return (
    isObject(value) &&
    value.version === 5 &&
    hasPersistedBaseFields(value) &&
    isObject(value.outboundMessages) &&
    Object.values(value.outboundMessages).every(isStoredOutboundMessage) &&
    isObject(value.references) &&
    Object.values(value.references).every(isStoredReference) &&
    isObject(value.matrixReferences) &&
    Object.values(value.matrixReferences).every((item) => typeof item === 'string')
  );
}

function isPersistedStateV6(value: unknown): value is PersistedStateV6 {
  return (
    isObject(value) &&
    value.version === 6 &&
    hasPersistedBaseFields(value) &&
    isObject(value.outboundMessages) &&
    Object.values(value.outboundMessages).every(isStoredOutboundMessage) &&
    isObject(value.references) &&
    Object.values(value.references).every(isStoredReference) &&
    isObject(value.matrixReferences) &&
    Object.values(value.matrixReferences).every((item) => typeof item === 'string') &&
    isObject(value.pendingQqMessages) &&
    Object.values(value.pendingQqMessages).every(isStoredPendingQqMessage)
  );
}

function isPersistedStateV7(value: unknown): value is PersistedStateV7 {
  return (
    isObject(value) &&
    value.version === 7 &&
    hasPersistedBaseFields(value) &&
    isObject(value.outboundMessages) &&
    Object.values(value.outboundMessages).every(isStoredOutboundMessage) &&
    isObject(value.references) &&
    Object.values(value.references).every(isStoredReference) &&
    isObject(value.matrixReferences) &&
    Object.values(value.matrixReferences).every((item) => typeof item === 'string') &&
    isObject(value.pendingQqMessages) &&
    Object.values(value.pendingQqMessages).every(isStoredPendingQqMessage) &&
    isObject(value.matrixMedia) &&
    Object.values(value.matrixMedia).every(isStoredMatrixMediaUpload)
  );
}

function isPersistedState(value: unknown): value is PersistedState {
  return (
    isObject(value) &&
    value.version === STATE_VERSION &&
    hasPersistedBaseFields(value) &&
    isObject(value.outboundMessages) &&
    Object.values(value.outboundMessages).every(isStoredOutboundMessage) &&
    isObject(value.references) &&
    Object.values(value.references).every(isStoredReference) &&
    isObject(value.matrixReferences) &&
    Object.values(value.matrixReferences).every((item) => typeof item === 'string') &&
    isObject(value.pendingQqMessages) &&
    Object.values(value.pendingQqMessages).every(isStoredPendingQqMessage) &&
    isObject(value.matrixMedia) &&
    Object.values(value.matrixMedia).every(isStoredMatrixMediaUpload) &&
    isObject(value.qqUsers) &&
    Object.values(value.qqUsers).every(isStoredQqUser)
  );
}

function trimArray(values: string[], maxEntries: number): void {
  if (values.length > maxEntries) {
    values.splice(0, values.length - maxEntries);
  }
}

function trimRecord(values: Record<string, unknown>, maxEntries: number): void {
  const keys = Object.keys(values);
  if (keys.length > maxEntries) {
    for (const key of keys.slice(0, keys.length - maxEntries)) {
      delete values[key];
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EISDIR') {
      throw error;
    }
  }
}

export class BridgeStore {
  private readonly file: string;
  private readonly logger?: AppLogger;
  private readonly metrics?: BridgeMetrics;
  private readonly maxHistory: number;
  private readonly referenceTtlMs: number;
  private readonly maxReferences: number;
  private readonly maxPendingQqMessages: number;
  private readonly maxMediaMappings: number;
  private readonly now: () => number;
  private readonly encryptionKey: Buffer;
  private state: PersistedState;
  private saveChain: Promise<void> = Promise.resolve();
  private pendingSave = false;

  constructor(options: BridgeStoreOptions) {
    if (options.secret.length < 16) {
      throw new Error('BridgeStore secret 至少需要 16 个字符');
    }
    this.file = options.file;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.maxHistory = options.maxHistory ?? 20_000;
    this.referenceTtlMs = Math.max(0, options.referenceTtlMs ?? DEFAULT_REFERENCE_TTL_MS);
    this.maxReferences = Math.max(1, options.maxReferences ?? DEFAULT_MAX_REFERENCES);
    this.maxPendingQqMessages = Math.max(
      1,
      options.maxPendingQqMessages ?? DEFAULT_MAX_PENDING_QQ_MESSAGES,
    );
    this.maxMediaMappings = Math.max(
      1,
      options.maxMediaMappings ?? DEFAULT_MAX_MEDIA_MAPPINGS,
    );
    this.now = options.now ?? Date.now;
    this.encryptionKey = createHash('sha256')
      .update('al1s-matrix-bridge-state-v2\0', 'utf8')
      .update(options.secret, 'utf8')
      .digest();
    this.state = this.load();
    this.pruneReferences();
  }

  getRoom(key: string): BridgeRoomRecord | undefined {
    const stored = this.state.rooms[this.indexKey('room', key)];
    if (stored === undefined) {
      return undefined;
    }
    return {
      key,
      kind: stored.kind,
      targetId: this.decrypt(stored.targetId),
      roomId: stored.roomId,
      alias: stored.alias,
      createdAt: stored.createdAt,
    };
  }

  getRoomByRoomId(roomId: string): BridgeRoomRecord | undefined {
    for (const stored of Object.values(this.state.rooms)) {
      if (stored.roomId === roomId) {
        return {
          key: this.decrypt(stored.key),
          kind: stored.kind,
          targetId: this.decrypt(stored.targetId),
          roomId: stored.roomId,
          alias: stored.alias,
          createdAt: stored.createdAt,
        };
      }
    }
    return undefined;
  }

  listRooms(): BridgeRoomRecord[] {
    return Object.values(this.state.rooms).map((stored) => ({
      key: this.decrypt(stored.key),
      kind: stored.kind,
      targetId: this.decrypt(stored.targetId),
      roomId: stored.roomId,
      alias: stored.alias,
      createdAt: stored.createdAt,
    }));
  }

  async setRoom(room: BridgeRoomRecord): Promise<void> {
    this.state.rooms[this.indexKey('room', room.key)] = {
      key: this.encrypt(room.key),
      kind: room.kind,
      targetId: this.encrypt(room.targetId),
      roomId: room.roomId,
      alias: room.alias,
      createdAt: room.createdAt,
    };
    await this.save();
  }

  hasTransaction(transactionId: string): boolean {
    return this.state.transactions.includes(transactionId);
  }

  async rememberTransaction(transactionId: string): Promise<void> {
    this.state.transactions.push(transactionId);
    trimArray(this.state.transactions, this.maxHistory);
    await this.save();
  }

  hasMatrixEvent(eventId: string): boolean {
    return this.state.matrixEvents.includes(eventId);
  }

  async rememberMatrixEvent(eventId: string): Promise<void> {
    this.state.matrixEvents.push(eventId);
    trimArray(this.state.matrixEvents, this.maxHistory);
    await this.save();
  }

  hasQqMessage(messageId: string): boolean {
    return this.state.qqMessages.includes(this.indexKey('qq-message', messageId));
  }

  hasPendingQqMessage(messageId: string): boolean {
    return this.state.pendingQqMessages[this.indexKey('qq-message', messageId)] !== undefined;
  }

  getPendingQqMessageCount(): number {
    return Object.keys(this.state.pendingQqMessages).length;
  }

  async enqueueQqMessage(message: QQBotInboundMessage): Promise<EnqueueQqMessageResult> {
    const key = this.indexKey('qq-message', message.messageId);
    if (this.state.qqMessages.includes(key) || this.state.pendingQqMessages[key] !== undefined) {
      return 'duplicate';
    }
    if (Object.keys(this.state.pendingQqMessages).length >= this.maxPendingQqMessages) {
      return 'full';
    }
    const now = this.now();
    this.state.pendingQqMessages[key] = {
      message: this.encrypt(JSON.stringify(message)),
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
    };
    await this.save();
    return 'enqueued';
  }

  getDueQqMessages(now = this.now()): PendingQqMessage[] {
    return Object.entries(this.state.pendingQqMessages)
      .filter(([, stored]) => stored.nextAttemptAt <= now)
      .sort((left, right) => left[1].createdAt - right[1].createdAt)
      .map(([, stored]) => {
        let message: unknown;
        try {
          message = JSON.parse(this.decrypt(stored.message)) as unknown;
        } catch (error) {
          throw new Error(
            `待处理 QQ 消息无法解密或解析：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!isStoredQqInboundMessage(message)) {
          throw new Error('待处理 QQ 消息字段无效');
        }
        return {
          message,
          attempts: stored.attempts,
          createdAt: stored.createdAt,
          nextAttemptAt: stored.nextAttemptAt,
        };
      });
  }

  async deferQqMessage(messageId: string, nextAttemptAt: number): Promise<number | undefined> {
    const stored = this.state.pendingQqMessages[this.indexKey('qq-message', messageId)];
    if (stored === undefined) {
      return undefined;
    }
    stored.attempts += 1;
    stored.nextAttemptAt = nextAttemptAt;
    await this.save();
    return stored.attempts;
  }

  async completeQqMessage(messageId: string): Promise<void> {
    const key = this.indexKey('qq-message', messageId);
    delete this.state.pendingQqMessages[key];
    if (!this.state.qqMessages.includes(key)) {
      this.state.qqMessages.push(key);
      trimArray(this.state.qqMessages, this.maxHistory);
    }
    await this.save();
  }

  async rememberQqMessage(messageId: string): Promise<void> {
    const digest = this.indexKey('qq-message', messageId);
    if (!this.state.qqMessages.includes(digest)) {
      this.state.qqMessages.push(digest);
      trimArray(this.state.qqMessages, this.maxHistory);
      await this.save();
    }
  }

  async recordInbound(
    target: ConversationTarget,
    messageId: string,
  ): Promise<void> {
    const now = this.now();
    const limits = PASSIVE_LIMITS[target.kind];
    const keyHash = this.indexKey('reply', target.key);
    this.state.passiveReplies[keyHash] = {
      kind: target.kind,
      targetId: this.encrypt(target.targetId),
      msgId: this.encrypt(messageId),
      windowStartedAt: now,
      used: 0,
      ...(limits.limit === undefined ? {} : { limit: limits.limit }),
      expiresAt: now + limits.windowMs,
    };
    await this.save();
  }

  async consumeReply(target: ConversationTarget): Promise<QqReplyHint> {
    const now = this.now();
    const keyHash = this.indexKey('reply', target.key);
    const current = this.state.passiveReplies[keyHash];
    if (
      current !== undefined &&
      current.kind === target.kind &&
      this.decrypt(current.targetId) === target.targetId &&
      current.expiresAt > now &&
      (current.limit === undefined || current.used < current.limit)
    ) {
      current.used += 1;
      await this.save();
      return { ...target, msgId: this.decrypt(current.msgId) };
    }
    return { ...target };
  }

  async invalidateReplyWindow(target: ConversationTarget): Promise<void> {
    const keyHash = this.indexKey('reply', target.key);
    const current = this.state.passiveReplies[keyHash];
    if (
      current !== undefined &&
      current.kind === target.kind &&
      this.decrypt(current.targetId) === target.targetId
    ) {
      delete this.state.passiveReplies[keyHash];
      await this.save();
    }
  }

  getOutboundMessage(matrixEventId: string): OutboundQqMessage | undefined {
    const stored = this.state.outboundMessages[this.indexKey('matrix-outbound', matrixEventId)];
    if (stored === undefined) {
      return undefined;
    }
    return {
      roomKey: this.decrypt(stored.roomKey),
      qqMessageId: this.decrypt(stored.qqMessageId),
      ...(stored.qqReference !== undefined
        ? { qqReference: this.decrypt(stored.qqReference) }
        : {}),
    };
  }

  async rememberOutboundMessage(matrixEventId: string, message: OutboundQqMessage): Promise<void> {
    const key = this.indexKey('matrix-outbound', matrixEventId);
    this.state.outboundMessages[key] = {
      roomKey: this.encrypt(message.roomKey),
      qqMessageId: this.encrypt(message.qqMessageId),
      ...(message.qqReference !== undefined
        ? { qqReference: this.encrypt(message.qqReference) }
        : {}),
      createdAt: new Date(this.now()).toISOString(),
    };
    trimRecord(this.state.outboundMessages, this.maxHistory);
    await this.save();
  }

  async forgetOutboundMessage(matrixEventId: string): Promise<void> {
    const key = this.indexKey('matrix-outbound', matrixEventId);
    if (delete this.state.outboundMessages[key]) {
      await this.save();
    }
  }

  getMatrixMedia(sha256: string): MatrixMediaUpload | undefined {
    const stored = this.state.matrixMedia[this.indexKey('matrix-media', sha256)];
    if (stored === undefined) {
      return undefined;
    }
    return {
      contentUri: this.decrypt(stored.contentUri),
      contentType: stored.contentType,
      size: stored.size,
      createdAt: stored.createdAt,
    };
  }

  async rememberMatrixMedia(sha256: string, upload: Omit<MatrixMediaUpload, 'createdAt'>): Promise<void> {
    this.state.matrixMedia[this.indexKey('matrix-media', sha256)] = {
      contentUri: this.encrypt(upload.contentUri),
      contentType: upload.contentType,
      size: upload.size,
      createdAt: new Date(this.now()).toISOString(),
    };
    trimRecord(this.state.matrixMedia, this.maxMediaMappings);
    await this.save();
  }

  getQqUser(matrixUserId: string): BridgeQqUser | undefined {
    const stored = this.state.qqUsers[this.indexKey('qq-user', matrixUserId)];
    if (stored === undefined) {
      return undefined;
    }
    return {
      matrixUserId,
      qqUserId: this.decrypt(stored.qqUserId),
      displayName: this.decrypt(stored.displayName),
    };
  }

  async rememberQqUsers(users: BridgeQqUser[]): Promise<void> {
    let changed = false;
    for (const user of users) {
      const key = this.indexKey('qq-user', user.matrixUserId);
      const stored = this.state.qqUsers[key];
      if (
        stored !== undefined &&
        this.decrypt(stored.qqUserId) === user.qqUserId &&
        this.decrypt(stored.displayName) === user.displayName
      ) {
        continue;
      }
      this.state.qqUsers[key] = {
        qqUserId: this.encrypt(user.qqUserId),
        displayName: this.encrypt(user.displayName),
        updatedAt: new Date(this.now()).toISOString(),
      };
      changed = true;
    }
    if (!changed) {
      return;
    }
    trimRecord(this.state.qqUsers, this.maxHistory);
    await this.save();
  }

  getReference(qqReference: string): BridgeReference | undefined {
    const referenceKey = this.indexKey('qq-reference', qqReference);
    const stored = this.state.references[referenceKey];
    if (stored === undefined) {
      return undefined;
    }
    if (this.isReferenceExpired(stored)) {
      this.deleteReference(referenceKey, stored);
      return undefined;
    }
    return {
      qqReference,
      matrixEventId: this.decrypt(stored.matrixEventId),
      sender: this.decrypt(stored.sender),
      excerpt: this.decrypt(stored.excerpt),
      ...(stored.roomId === undefined ? {} : { roomId: this.decrypt(stored.roomId) }),
    };
  }

  /**
   * 按同房间发送者与引用摘录回退匹配。
   *
   * QQ 有时只提供 `TMP_*` 引用索引，而消息正文与引用元素仍包含可信内容。
   * 群聊里同一句常见文本（例如只 @ 某人的消息）会反复出现，因此完全一致
   * 的候选优先按引用发送者过滤，再按最新优先选择；包含关系更弱，只在候选
   * 唯一时建立关联。
   */
  findReferenceByQuote(options: {
    roomId: string;
    sender?: string;
    excerpt: string;
  }): BridgeReference | undefined {
    return this.matchReferenceByQuote(options).reference;
  }

  /** 与 `findReferenceByQuote` 相同，但额外返回脱敏的匹配计数。 */
  matchReferenceByQuote(options: {
    roomId: string;
    sender?: string;
    excerpt: string;
  }): QuoteMatchResult {
    const diagnostics: QuoteMatchDiagnostics = {
      roomReferences: 0,
      exactMatches: 0,
      containedMatches: 0,
      senderExactMatches: 0,
      senderKnown: options.sender !== undefined,
    };
    const excerpt = normalizeReferenceText(options.excerpt);
    if (excerpt === '') {
      return { diagnostics };
    }
    const sender =
      options.sender === undefined ? undefined : normalizeReferenceSender(options.sender);
    const entries = Object.values(this.state.references)
      .filter((stored) => !this.isReferenceExpired(stored))
      .map((stored) => ({
        reference: {
          // 旧状态未持久化原索引；回退调用只需要 Matrix event ID。
          qqReference:
            stored.qqReference === undefined ? '' : this.decrypt(stored.qqReference),
          matrixEventId: this.decrypt(stored.matrixEventId),
          sender: this.decrypt(stored.sender),
          excerpt: this.decrypt(stored.excerpt),
          ...(stored.roomId === undefined ? {} : { roomId: this.decrypt(stored.roomId) }),
        },
        createdAt: this.referenceCreatedAt(stored),
      }))
      .filter(
        ({ reference }) =>
          reference.roomId === undefined || reference.roomId === options.roomId,
      )
      .sort((left, right) => right.createdAt - left.createdAt);
    diagnostics.roomReferences = entries.length;

    const matchesSender = (reference: BridgeReference): boolean =>
      sender === undefined || normalizeReferenceSender(reference.sender) === sender;
    const exact = entries.filter(
      ({ reference }) => normalizeReferenceText(reference.excerpt) === excerpt,
    );
    const contained = entries.filter(({ reference }) => {
      const candidate = normalizeReferenceText(reference.excerpt);
      return (
        candidate.length >= 4 && excerpt.length >= 4 && candidate.includes(excerpt)
      );
    });
    const reverseContained = entries.filter(({ reference }) => {
      const candidate = normalizeReferenceText(reference.excerpt);
      return (
        candidate.length >= 4 && excerpt.length >= 4 && excerpt.includes(candidate)
      );
    });
    diagnostics.exactMatches = exact.length;
    diagnostics.containedMatches = contained.length;
    diagnostics.senderExactMatches = exact.filter(({ reference }) =>
      matchesSender(reference),
    ).length;

    // 候选已按 createdAt 倒序，取第一个即最新一条。
    const newest = (
      candidates: Array<{ reference: BridgeReference }>,
    ): BridgeReference | undefined => candidates[0]?.reference;
    const reference =
      newest(exact.filter(({ reference }) => matchesSender(reference))) ??
      newest(exact) ??
      newest(contained.filter(({ reference }) => matchesSender(reference))) ??
      (contained.length === 1 ? contained[0]?.reference : undefined) ??
      (reverseContained.length === 1 ? reverseContained[0]?.reference : undefined);
    return {
      ...(reference === undefined ? {} : { reference }),
      diagnostics,
    };
  }

  getQqReference(matrixEventId: string): string | undefined {
    const matrixReferenceKey = this.indexKey('matrix-reference', matrixEventId);
    const stored = this.state.matrixReferences[matrixReferenceKey];
    if (stored === undefined) {
      return undefined;
    }
    const qqReference = this.decrypt(stored);
    const referenceKey = this.indexKey('qq-reference', qqReference);
    const reference = this.state.references[referenceKey];
    if (reference === undefined || this.isReferenceExpired(reference)) {
      delete this.state.matrixReferences[matrixReferenceKey];
      if (reference !== undefined) {
        this.deleteReference(referenceKey, reference);
      } else {
        this.pendingSave = true;
      }
      return undefined;
    }
    return qqReference;
  }

  async rememberReference(reference: BridgeReference): Promise<void> {
    await this.rememberReferences([reference]);
  }

  /**
   * 同时保存一条 QQ 消息的全部可查询索引；最后一个索引作为 Matrix 回推时
   * 使用的规范引用。
   */
  async rememberReferences(references: BridgeReference[]): Promise<void> {
    const unique = new Map<string, BridgeReference>();
    for (const reference of references) {
      if (reference.qqReference !== '') {
        unique.set(reference.qqReference, reference);
      }
    }
    if (unique.size === 0) {
      return;
    }
    this.trimReferencesToCapacity(unique.size);
    const createdAt = new Date(this.now()).toISOString();
    for (const reference of unique.values()) {
      const referenceKey = this.indexKey('qq-reference', reference.qqReference);
      this.state.references[referenceKey] = {
        matrixEventId: this.encrypt(reference.matrixEventId),
        sender: this.encrypt(reference.sender),
        excerpt: this.encrypt(reference.excerpt),
        qqReference: this.encrypt(reference.qqReference),
        ...(reference.roomId === undefined ? {} : { roomId: this.encrypt(reference.roomId) }),
        createdAt,
      };
    }
    const canonical = [...unique.values()].at(-1);
    if (canonical !== undefined) {
      this.state.matrixReferences[this.indexKey('matrix-reference', canonical.matrixEventId)] =
        this.encrypt(canonical.qqReference);
    }
    trimRecord(this.state.references, this.maxHistory);
    trimRecord(this.state.matrixReferences, this.maxHistory);
    await this.save();
  }

  async flush(): Promise<void> {
    if (this.pendingSave) {
      await this.save();
    } else {
      await this.saveChain;
    }
  }

  private pruneReferences(): void {
    const retainedMatrixReferences = new Set<string>();
    for (const [referenceKey, reference] of Object.entries(this.state.references)) {
      if (this.isReferenceExpired(reference)) {
        this.deleteReference(referenceKey, reference);
      } else {
        retainedMatrixReferences.add(
          this.indexKey('matrix-reference', this.decrypt(reference.matrixEventId)),
        );
      }
    }
    for (const matrixReferenceKey of Object.keys(this.state.matrixReferences)) {
      if (!retainedMatrixReferences.has(matrixReferenceKey)) {
        delete this.state.matrixReferences[matrixReferenceKey];
        this.pendingSave = true;
      }
    }
    this.trimReferencesToCapacity(0);
  }

  private trimReferencesToCapacity(additionalEntries: number): void {
    const excess =
      Object.keys(this.state.references).length + additionalEntries - this.maxReferences;
    if (excess <= 0) {
      return;
    }
    const oldest = Object.entries(this.state.references)
      .sort((left, right) => this.referenceCreatedAt(left[1]) - this.referenceCreatedAt(right[1]))
      .slice(0, excess);
    for (const [referenceKey, reference] of oldest) {
      this.deleteReference(referenceKey, reference);
    }
  }

  private isReferenceExpired(reference: StoredReference): boolean {
    return (
      this.referenceTtlMs > 0 &&
      this.now() - this.referenceCreatedAt(reference) >= this.referenceTtlMs
    );
  }

  private referenceCreatedAt(reference: StoredReference): number {
    const createdAt = Date.parse(reference.createdAt);
    return Number.isFinite(createdAt) ? createdAt : 0;
  }

  private deleteReference(referenceKey: string, reference: StoredReference): void {
    delete this.state.references[referenceKey];
    const matrixEventId = this.decrypt(reference.matrixEventId);
    const retained = Object.values(this.state.references).some(
      (candidate) => this.decrypt(candidate.matrixEventId) === matrixEventId,
    );
    if (!retained) {
      delete this.state.matrixReferences[this.indexKey('matrix-reference', matrixEventId)];
    }
    this.pendingSave = true;
  }

  private load(): PersistedState {
    if (!existsSync(this.file)) {
      return emptyState();
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (isPersistedState(parsed)) {
        return parsed;
      }
      if (isPersistedStateV7(parsed)) {
        this.logger?.info('Matrix bridge 状态已从 v7 升级为 v8');
        return {
          ...parsed,
          version: STATE_VERSION,
          qqUsers: {},
        };
      }
      if (isPersistedStateV6(parsed)) {
        this.logger?.info('Matrix bridge 状态已从 v6 升级为 v8');
        return {
          ...parsed,
          version: STATE_VERSION,
          matrixMedia: {},
          qqUsers: {},
        };
      }
      if (isPersistedStateV5(parsed)) {
        this.logger?.info('Matrix bridge 状态已从 v5 升级为 v8');
        return {
          ...parsed,
          version: STATE_VERSION,
          pendingQqMessages: {},
          matrixMedia: {},
          qqUsers: {},
        };
      }
      if (isPersistedStateV4(parsed)) {
        this.logger?.info('Matrix bridge 状态已从 v4 升级为 v8');
        return {
          ...parsed,
          version: STATE_VERSION,
          pendingQqMessages: {},
          matrixMedia: {},
          qqUsers: {},
        };
      }
      if (isPersistedStateV3(parsed)) {
        this.logger?.info('Matrix bridge 状态已从 v3 升级为 v8');
        return {
          ...parsed,
          version: STATE_VERSION,
          references: {},
          matrixReferences: {},
          pendingQqMessages: {},
          matrixMedia: {},
          qqUsers: {},
        };
      }
      if (isPersistedStateV2(parsed)) {
        this.logger?.info('Matrix bridge 状态已从 v2 升级为 v8');
        return {
          ...parsed,
          version: STATE_VERSION,
          outboundMessages: {},
          references: {},
          matrixReferences: {},
          pendingQqMessages: {},
          matrixMedia: {},
          qqUsers: {},
        };
      }
      throw new Error(`状态文件版本或字段无效，需要 version ${String(STATE_VERSION)}`);
    } catch (error) {
      throw new Error(
        `无法读取 Matrix bridge 状态文件 ${this.file}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private indexKey(scope: string, value: string): string {
    return createHmac('sha256', this.encryptionKey)
      .update(scope, 'utf8')
      .update('\0', 'utf8')
      .update(value, 'utf8')
      .digest('hex');
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  private decrypt(value: string): string {
    const [version, ivValue, tagValue, ciphertextValue] = value.split('.', 4);
    if (
      version !== 'v1' ||
      ivValue === undefined ||
      tagValue === undefined ||
      ciphertextValue === undefined
    ) {
      throw new Error('状态文件包含无法识别的加密字段');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(ivValue, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private async save(): Promise<void> {
    this.pendingSave = false;
    try {
      try {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      } catch (error) {
        throw new Error(
          `无法创建 Matrix bridge 状态目录：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const snapshot = JSON.stringify(this.state, null, 2);
      const temporary = `${this.file}.${process.pid}.tmp`;
      const task = this.saveChain.then(async () => {
        const handle = await open(temporary, 'w', 0o600);
        try {
          await handle.chmod(0o600);
          await handle.writeFile(snapshot, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, this.file);
        await syncDirectory(dirname(this.file));
      });
      this.saveChain = task.catch(() => undefined);
      try {
        await task;
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      this.metrics?.recordStateWrite('success');
    } catch (error) {
      // 保留 dirty 状态，让后续 flush() 可以重试失败的落盘。
      this.pendingSave = true;
      this.metrics?.recordStateWrite('error');
      this.metrics?.recordError();
      throw error;
    }
  }
}

function emptyState(): PersistedState {
  return {
    version: STATE_VERSION,
    rooms: {},
    transactions: [],
    matrixEvents: [],
    qqMessages: [],
    passiveReplies: {},
    outboundMessages: {},
    references: {},
    matrixReferences: {},
    pendingQqMessages: {},
    matrixMedia: {},
    qqUsers: {},
  };
}
