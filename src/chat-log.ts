/**
 * 聊天记录持久化。
 *
 * 目录结构（root 默认为 ./data）：
 *
 * ```text
 * data/chats/
 *   group/<group_openid>/messages.jsonl
 *   c2c/<user_openid>/messages.jsonl
 *   guild/<guildId>/<channelId>/messages.jsonl
 *   dm/<user_openid>/messages.jsonl
 * data/media-cache/<sha256>
 * ```
 *
 * 设计要点：
 *   - 每行一条 JSON（JSONL），追加写，便于 grep / tail / 逐行解析；
 *   - 同一 messageId 重复推送会去重，不重复记录、不重复下载；
 *   - 媒体异步下载，不阻塞消息回复；
 *   - 媒体按 SHA-256 全局去重，文件路径只取决于内容；
 *   - 下载失败写 `<dir>/media/download-errors.log`，不影响主流程；
 *   - 路径段与文件名做净化，防止目录穿越。
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { InboundAttachment } from '@tencent-connect/qqbot-nodejs/protocol';
import type { AppLogger } from './logger.js';

export interface ChatStoreOptions {
  /** 数据根目录，例如 ./data。 */
  root: string;
  /** 是否下载并保存媒体附件，默认 true。 */
  saveMedia?: boolean;
  /** 单个媒体文件大小上限（字节），默认 50MB。 */
  maxMediaBytes?: number;
  /** 可注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch;
  logger?: AppLogger;
}

export interface ChatAttachmentRecord {
  contentType: string;
  url: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
  voiceWavUrl?: string;
  asrReferText?: string;
  /** 相对 data 根目录的内容寻址路径（图片/视频/语音/文件）。 */
  localPath?: string;
  /** 本地媒体文件的 SHA-256。 */
  sha256?: string;
  /** 语音转码后的 WAV 本地路径（如有）。 */
  localWavPath?: string;
}

export interface ChatRecord {
  /** 写入时间（本地 ISO）。 */
  recordedAt: string;
  /** 消息发送时间（平台 timestamp）。 */
  timestamp: string;
  rawEventType: string;
  kind: QQBotInboundMessage['kind'];
  messageId: string;
  senderId: string;
  senderName?: string;
  senderIsBot?: boolean;
  content: string;
  msgType?: number;
  groupOpenid?: string;
  guildId?: string;
  channelId?: string;
  refMsgIdx?: string;
  msgIdx?: string;
  mentions?: unknown;
  messageScene?: unknown;
  attachments: ChatAttachmentRecord[];
}

interface StoredMedia {
  absolutePath: string;
  sha256: string;
}

interface DownloadTask {
  url: string;
  label: string;
  apply: (media: StoredMedia) => void;
}

const DEFAULT_MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const SEEN_LIMIT = 20_000;

/** 净化单个路径段，防止目录穿越。 */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    return 'unknown';
  }
  return cleaned;
}

export class ChatStore {
  private readonly root: string;
  private readonly saveMedia: boolean;
  private readonly maxMediaBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: AppLogger;
  private readonly seen = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly downloadsByUrl = new Map<string, Promise<StoredMedia | undefined>>();
  private readonly writesByHash = new Map<string, Promise<StoredMedia>>();
  private disabled = false;

  constructor(options: ChatStoreOptions) {
    this.root = options.root;
    this.saveMedia = options.saveMedia ?? true;
    this.maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    try {
      mkdirSync(join(this.root, 'chats'), { recursive: true });
      mkdirSync(join(this.root, 'media-cache'), { recursive: true });
    } catch (error) {
      // 目录不可写（如权限问题）时禁用落盘，不影响机器人运行。
      this.disabled = true;
      this.logger?.error('聊天记录目录不可写，已禁用聊天记录保存', {
        root: this.root,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 记录一条消息；媒体下载异步进行，不阻塞调用方。 */
  async record(message: QQBotInboundMessage): Promise<void> {
    if (this.disabled || this.isDuplicate(message.messageId)) {
      return;
    }

    const dir = this.targetDir(message);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      this.disabled = true;
      this.logger?.error('创建聊天记录目录失败，已禁用聊天记录保存', {
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const tasks: DownloadTask[] = [];
    const attachments = this.buildAttachments(message, tasks);
    const record: ChatRecord = {
      recordedAt: new Date().toISOString(),
      timestamp: message.timestamp,
      rawEventType: message.rawEventType,
      kind: message.kind,
      messageId: message.messageId,
      senderId: message.senderId,
      senderName: message.senderName,
      senderIsBot: message.senderIsBot,
      content: message.content,
      msgType: message.msgType,
      groupOpenid: message.groupOpenid,
      guildId: message.guildId,
      channelId: message.channelId,
      refMsgIdx: message.refMsgIdx,
      msgIdx: message.msgIdx,
      mentions: message.mentions,
      messageScene: message.messageScene,
      attachments,
    };
    const jsonlPath = join(dir, 'messages.jsonl');

    if (this.saveMedia && tasks.length > 0) {
      this.track(this.persistWithMedia(record, jsonlPath, join(dir, 'media'), tasks));
      return;
    }
    this.appendRecord(jsonlPath, record);
  }

  /** 等待所有进行中的媒体下载完成（用于优雅退出 / 测试）。 */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /** 目标目录（绝对路径）。 */
  targetDir(message: QQBotInboundMessage): string {
    const base = join(this.root, 'chats');
    switch (message.kind) {
      case 'group':
        return join(base, 'group', safeSegment(message.groupOpenid ?? message.senderId));
      case 'c2c':
        return join(base, 'c2c', safeSegment(message.senderId));
      case 'guild':
        return join(base, 'guild', safeSegment(message.guildId ?? 'unknown'), safeSegment(message.channelId ?? 'unknown'));
      case 'dm':
        return join(base, 'dm', safeSegment(message.senderId));
    }
  }

  private isDuplicate(messageId: string): boolean {
    if (this.seen.has(messageId)) {
      return true;
    }
    this.seen.add(messageId);
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    return false;
  }

  private buildAttachments(
    message: QQBotInboundMessage,
    tasks: DownloadTask[],
  ): ChatAttachmentRecord[] {
    return (message.attachments ?? []).map((attachment, index) => {
      const record: ChatAttachmentRecord = {
        contentType: attachment.content_type,
        url: attachment.url,
        filename: attachment.filename,
        size: attachment.size,
        width: attachment.width,
        height: attachment.height,
        voiceWavUrl: attachment.voice_wav_url,
        asrReferText: attachment.asr_refer_text,
      };
      tasks.push({
        url: attachment.url,
        label: `attachment#${index}`,
        apply: (media) => {
          record.localPath = relative(this.root, media.absolutePath);
          record.sha256 = media.sha256;
        },
      });

      if (attachment.voice_wav_url !== undefined && attachment.voice_wav_url !== '') {
        tasks.push({
          url: attachment.voice_wav_url,
          label: `attachment#${index}-wav`,
          apply: (media) => {
            record.localWavPath = relative(this.root, media.absolutePath);
          },
        });
      }
      return record;
    });
  }

  private track(task: Promise<void>): void {
    this.pending.add(task);
    void task.finally(() => {
      this.pending.delete(task);
    });
  }

  private async persistWithMedia(
    record: ChatRecord,
    jsonlPath: string,
    mediaDir: string,
    tasks: DownloadTask[],
  ): Promise<void> {
    await Promise.all(tasks.map((task) => this.download(task, mediaDir)));
    this.appendRecord(jsonlPath, record);
  }

  private appendRecord(jsonlPath: string, record: ChatRecord): void {
    try {
      appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      this.logger?.error('写入聊天记录失败', {
        file: relative(this.root, jsonlPath),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async download(task: DownloadTask, mediaDir: string): Promise<void> {
    let pending = this.downloadsByUrl.get(task.url);
    if (pending === undefined) {
      pending = this.downloadUncached(task.url, mediaDir);
      this.downloadsByUrl.set(task.url, pending);
      void pending.finally(() => {
        if (this.downloadsByUrl.get(task.url) === pending) {
          this.downloadsByUrl.delete(task.url);
        }
      });
    }
    const media = await pending;
    if (media !== undefined) {
      task.apply(media);
    }
  }

  private async downloadUncached(
    url: string,
    mediaDir: string,
  ): Promise<StoredMedia | undefined> {
    try {
      const response = await this.fetchImpl(url, { redirect: 'follow' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const lengthHeader = response.headers.get('content-length');
      if (lengthHeader !== null && Number(lengthHeader) > this.maxMediaBytes) {
        throw new Error(`文件 ${lengthHeader} 字节，超过上限 ${this.maxMediaBytes}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > this.maxMediaBytes) {
        throw new Error(`文件 ${buffer.byteLength} 字节，超过上限 ${this.maxMediaBytes}`);
      }
      return await this.storeBuffer(buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn('媒体下载失败', { url, error: message });
      try {
        mkdirSync(mediaDir, { recursive: true });
        appendFileSync(
          join(mediaDir, 'download-errors.log'),
          `${JSON.stringify({ at: new Date().toISOString(), url, error: message })}\n`,
          'utf8',
        );
      } catch {
        // 忽略错误日志本身的写入失败。
      }
      return undefined;
    }
  }

  private async storeBuffer(buffer: Buffer): Promise<StoredMedia> {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const absolutePath = join(this.root, 'media-cache', sha256);
    const existing = this.writesByHash.get(sha256);
    if (existing !== undefined) {
      return existing;
    }

    const write = (async (): Promise<StoredMedia> => {
      if (!existsSync(absolutePath)) {
        try {
          await writeFile(absolutePath, buffer, { flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
          }
        }
      }
      this.logger?.debug('媒体已保存', {
        file: relative(this.root, absolutePath),
        bytes: buffer.byteLength,
        sha256,
      });
      return { absolutePath, sha256 };
    })();

    this.writesByHash.set(sha256, write);
    try {
      return await write;
    } finally {
      if (this.writesByHash.get(sha256) === write) {
        this.writesByHash.delete(sha256);
      }
    }
  }
}

export type { InboundAttachment };
