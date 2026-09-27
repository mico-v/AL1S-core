/**
 * 聊天记录持久化。
 *
 * 目录结构（root 默认为 ./data）：
 *
 * ```text
 * data/chats/
 *   group/<group_openid>/messages.jsonl
 *   group/<group_openid>/media/<messageId>-<index>.<ext>
 *   c2c/<user_openid>/messages.jsonl
 *   c2c/<user_openid>/media/...
 *   guild/<guildId>/<channelId>/messages.jsonl
 *   dm/<user_openid>/messages.jsonl
 * ```
 *
 * 设计要点：
 *   - 每行一条 JSON（JSONL），追加写，便于 grep / tail / 逐行解析；
 *   - 同一 messageId 重复推送会去重，不重复记录、不重复下载；
 *   - 媒体在记录写入后异步下载，不阻塞消息回复；
 *   - 文件名由 messageId + 序号推导，天然幂等；已存在则跳过；
 *   - 下载失败写 `<dir>/media/download-errors.log`，不影响主流程；
 *   - 路径段与文件名做净化，防止目录穿越。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
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
  /** 相对 data 根目录的本地路径（图片/视频/语音/文件）。 */
  localPath?: string;
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

const DEFAULT_MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const SEEN_LIMIT = 20_000;

const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/amr': '.amr',
  voice: '.silk',
};

/** 净化单个路径段，防止目录穿越。 */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    return 'unknown';
  }
  return cleaned;
}

function safeId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48);
  return cleaned === '' ? String(Date.now()) : cleaned;
}

function guessExtension(contentType: string, filename?: string): string {
  if (filename !== undefined) {
    const ext = extname(filename).toLowerCase();
    if (/^\.[a-z0-9]{1,8}$/.test(ext)) {
      return ext;
    }
  }
  const mapped = MIME_EXTENSION[contentType.toLowerCase()];
  if (mapped !== undefined) {
    return mapped;
  }
  const slash = contentType.indexOf('/');
  if (slash >= 0) {
    const subtype = contentType
      .slice(slash + 1)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    if (subtype !== '') {
      return `.${subtype.slice(0, 8)}`;
    }
  }
  return '.bin';
}

interface DownloadTask {
  url: string;
  absolutePath: string;
  label: string;
}

export class ChatStore {
  private readonly root: string;
  private readonly saveMedia: boolean;
  private readonly maxMediaBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: AppLogger;
  private readonly seen = new Set<string>();
  private pending = new Set<Promise<void>>();
  private disabled = false;

  constructor(options: ChatStoreOptions) {
    this.root = options.root;
    this.saveMedia = options.saveMedia ?? true;
    this.maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    try {
      mkdirSync(join(this.root, 'chats'), { recursive: true });
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

    const mediaDir = join(dir, 'media');
    const tasks: DownloadTask[] = [];
    const attachments = this.buildAttachments(message, mediaDir, tasks);
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

    appendFileSync(join(dir, 'messages.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');

    if (this.saveMedia && tasks.length > 0) {
      mkdirSync(mediaDir, { recursive: true });
      for (const task of tasks) {
        this.track(this.download(task, mediaDir));
      }
    }
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
    mediaDir: string,
    tasks: DownloadTask[],
  ): ChatAttachmentRecord[] {
    const list = message.attachments ?? [];
    const id = safeId(message.messageId);
    return list.map((attachment, index) => {
      const extension = guessExtension(attachment.content_type, attachment.filename);
      const absolutePath = join(mediaDir, `${id}-${index}${extension}`);
      tasks.push({ url: attachment.url, absolutePath, label: `attachment#${index}` });

      let localWavPath: string | undefined;
      if (attachment.voice_wav_url !== undefined && attachment.voice_wav_url !== '') {
        const wavAbsolute = join(mediaDir, `${id}-${index}-wav.wav`);
        tasks.push({ url: attachment.voice_wav_url, absolutePath: wavAbsolute, label: `attachment#${index}-wav` });
        localWavPath = relative(this.root, wavAbsolute);
      }

      return {
        contentType: attachment.content_type,
        url: attachment.url,
        filename: attachment.filename,
        size: attachment.size,
        width: attachment.width,
        height: attachment.height,
        voiceWavUrl: attachment.voice_wav_url,
        asrReferText: attachment.asr_refer_text,
        localPath: relative(this.root, absolutePath),
        localWavPath,
      };
    });
  }

  private track(task: Promise<void>): void {
    this.pending.add(task);
    void task.finally(() => {
      this.pending.delete(task);
    });
  }

  private async download(task: DownloadTask, mediaDir: string): Promise<void> {
    if (existsSync(task.absolutePath)) {
      return;
    }
    try {
      const response = await this.fetchImpl(task.url, { redirect: 'follow' });
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
      await writeFile(task.absolutePath, buffer);
      this.logger?.debug('媒体已保存', { file: relative(this.root, task.absolutePath), bytes: buffer.byteLength });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn('媒体下载失败', { label: task.label, url: task.url, error: message });
      try {
        appendFileSync(
          join(mediaDir, 'download-errors.log'),
          `${JSON.stringify({ at: new Date().toISOString(), label: task.label, url: task.url, error: message })}\n`,
          'utf8',
        );
      } catch {
        // 忽略错误日志本身的写入失败。
      }
    }
  }
}

export type { InboundAttachment };
