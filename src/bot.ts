/**
 * Bot：`@tencent-connect/qqbot-nodejs` 的薄封装。
 *
 * 只负责：
 *   - 生命周期（start / stop）；
 *   - 事件分发（message / interaction / rawEvent）；
 *   - 聊天记录落盘（可选，见 chat-log.ts）；
 *   - 常用回复方法的转发。
 *
 * 协议细节（鉴权、WebSocket 心跳、RESUME、Webhook 验签、重试）全部
 * 由连接器实现；这里不重新造轮子，也不引入插件 / 路由 / 沙箱等上层设计。
 */

import {
  MsgType,
  QQBot,
  type InlineKeyboard,
  type InteractionContext,
  type InteractionEvent,
  type MessageResponse,
  type QQBotInboundMessage,
  type RawEventContext,
  type ReplyTarget,
  type SendMessageOptions,
  type UploadMediaResponse,
} from '@tencent-connect/qqbot-nodejs';
import { createHash } from 'node:crypto';
import { ChatStore } from './chat-log.js';
import type { BotConfig } from './config.js';
import { createLogger, type AppLogger } from './logger.js';

export type MessageHandler = (message: QQBotInboundMessage, bot: Bot) => unknown | Promise<unknown>;
export type InteractionHandler = (
  event: InteractionEvent,
  ctx: InteractionContext,
  bot: Bot,
) => unknown | Promise<unknown>;
export type RawEventHandler = (ctx: RawEventContext, bot: Bot) => unknown | Promise<unknown>;

export interface BotRuntimeOptions {
  /** 覆盖聊天记录配置；bridge 模式会关闭额外的明文聊天落盘。 */
  chatLogEnabled?: boolean;
  /** 调试日志仅记录身份字段的稳定短摘要。 */
  redactMessageIdentifiers?: boolean;
}

export interface QqReplyOptions {
  /** QQ 消息索引，存在时以引用消息形式回复。 */
  messageReference?: string;
}

const QQ_MARKDOWN_PATTERNS = [
  /^ {0,3}```/m,
  /^ {0,3}#{1,6}[ \t]+\S/m,
  /^ {0,3}>[ \t]+\S/m,
  /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+\S/m,
  /\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)/,
  /\*\*[^*\n]+\*\*/,
  /__[^_\n]+__/,
  /~~[^~\n]+~~/,
  /`[^`\n]+`/,
] as const;

const QQ_MENTION_MARKUP_PATTERN = /<@!?[^>\s]+>|<qqbot-at-user\s+[^>]*\/?>/i;

/** 只在高置信度 Markdown 语法出现时切换 QQ `msg_type=2`。 */
export function looksLikeQqMarkdown(content: string): boolean {
  return QQ_MARKDOWN_PATTERNS.some((pattern) => pattern.test(content));
}

/** QQ 只在 Markdown 消息中解析原生提及标签。 */
export function requiresQqMarkdown(content: string): boolean {
  return QQ_MENTION_MARKUP_PATTERN.test(content);
}

export class Bot {
  readonly client: QQBot;
  readonly config: BotConfig;
  private readonly log: AppLogger;
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly interactionHandlers: InteractionHandler[] = [];
  private readonly rawEventHandlers: RawEventHandler[] = [];
  private readonly chatStore?: ChatStore;
  private readonly redactMessageIdentifiers: boolean;
  private started = false;

  constructor(config: BotConfig, log?: AppLogger, options: BotRuntimeOptions = {}) {
    this.config = config;
    this.log = log ?? createLogger(config.logging);
    this.redactMessageIdentifiers = options.redactMessageIdentifiers ?? false;

    if (options.chatLogEnabled ?? config.chatLog.enabled) {
      this.chatStore = new ChatStore({
        root: config.chatLog.root,
        saveMedia: config.chatLog.saveMedia,
        maxMediaBytes: config.chatLog.maxMediaBytes,
        logger: this.log,
      });
    }

    this.client = new QQBot({
      appId: config.appId,
      appSecret: config.appSecret,
      accountId: config.accountId,
      transport: config.transport,
      markdownSupport: config.markdownSupport,
      tokenPrefetch: config.tokenPrefetch,
      logger: this.log,
      ...(config.intents !== undefined ? { intents: config.intents } : {}),
      ...(config.apiBaseUrl !== undefined ? { baseUrl: config.apiBaseUrl } : {}),
      ...(config.tokenBaseUrl !== undefined ? { tokenBaseUrl: config.tokenBaseUrl } : {}),
      ...(config.transport === 'webhook'
        ? { webhook: { port: config.webhook.port, path: config.webhook.path } }
        : {}),
    });

    this.client.on('ready', (data) => {
      this.log.info('网关已就绪', { transport: config.transport, data });
    });
    this.client.on('resumed', (data) => {
      this.log.info('会话已恢复', { data });
    });
    this.client.on('error', (error) => {
      this.log.error('QQ 客户端错误', { message: error.message });
    });
    this.client.on('message', async (ctx, message) => {
      await this.dispatchMessage(message, ctx.signal);
    });
    this.client.on('interaction', async (ctx, event) => {
      await this.dispatchInteraction(event, ctx);
    });
    this.client.on('rawEvent', async (ctx) => {
      await this.dispatchRawEvent(ctx);
    });
  }

  /** 注册消息处理器，按注册顺序依次执行。 */
  onMessage(handler: MessageHandler): this {
    this.messageHandlers.push(handler);
    return this;
  }

  /** 注册互动事件处理器。 */
  onInteraction(handler: InteractionHandler): this {
    this.interactionHandlers.push(handler);
    return this;
  }

  /** 注册原始事件处理器，用于 SDK 未归一化的事件类型。 */
  onRawEvent(handler: RawEventHandler): this {
    this.rawEventHandlers.push(handler);
    return this;
  }

  /** 启动收发。WebSocket 模式下会阻塞到 stop() 或进程退出。 */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.log.info('启动 QQ 机器人', {
      appId: this.config.appId,
      transport: this.config.transport,
      markdownSupport: this.config.markdownSupport,
    });
    await this.client.start();
  }

  /** 等待聊天记录里进行中的媒体下载完成（用于优雅退出 / 测试）。 */
  async flush(): Promise<void> {
    await this.chatStore?.flush();
  }

  /** 停止收发并释放资源。 */
  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.log.info('停止 QQ 机器人');
    this.client.stop();
  }

  /** 回复文本（有 msgId 时为被动回复，否则为主动推送）。 */
  replyText(
    target: ReplyTarget,
    content: string,
    options: QqReplyOptions = {},
  ): Promise<MessageResponse> {
    const messageReference =
      options.messageReference === undefined
        ? {}
        : { messageReference: { message_id: options.messageReference } };
    if (
      this.config.markdownSupport &&
      (looksLikeQqMarkdown(content) || requiresQqMarkdown(content))
    ) {
      return this.client.send({
        target,
        msgType: MsgType.MARKDOWN,
        markdown: { content },
        ...messageReference,
      });
    }
    return this.client.send({
      target,
      msgType: MsgType.TEXT,
      content,
      ...messageReference,
    });
  }

  /** 回复 Markdown。 */
  replyMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: InlineKeyboard }): Promise<MessageResponse> {
    return this.client.sendMarkdown(target, content, opts);
  }

  /** 通用发送，支持全部 msg_type。 */
  send(opts: SendMessageOptions): Promise<MessageResponse> {
    return this.client.send(opts);
  }

  /** 上传并发送富媒体。 */
  sendMedia(opts: Parameters<QQBot['sendMedia']>[0]): Promise<{
    upload: UploadMediaResponse;
    message: MessageResponse | undefined;
  }> {
    return this.client.sendMedia(opts);
  }

  /** 撤回消息。 */
  recall(target: ReplyTarget, messageId: string): Promise<void> {
    return this.client.recallMessage(target, messageId);
  }

  /** 回应互动事件，避免客户端一直 loading。 */
  acknowledgeInteraction(interactionId: string, code = 0): Promise<void> {
    return this.client.acknowledgeInteraction(interactionId, code);
  }

  private async dispatchMessage(message: QQBotInboundMessage, _signal: AbortSignal): Promise<void> {
    this.log.debug(
      '收到消息事件',
      this.redactMessageIdentifiers
        ? {
            kind: message.kind,
            senderRef: identifierRef(message.senderId),
            groupRef: identifierRef(message.groupOpenid),
            messageRef: identifierRef(message.messageId),
          }
        : {
            kind: message.kind,
            senderId: message.senderId,
            groupOpenid: message.groupOpenid,
            messageId: message.messageId,
          },
    );

    if (this.chatStore !== undefined) {
      try {
        await this.chatStore.record(message);
      } catch (error) {
        this.log.error('保存聊天记录失败', { error, messageId: message.messageId });
      }
    }

    for (const handler of this.messageHandlers) {
      try {
        await handler(message, this);
      } catch (error) {
        this.log.error('消息处理器异常', { error: describeError(error) });
      }
    }
  }

  private async dispatchInteraction(event: InteractionEvent, ctx: InteractionContext): Promise<void> {
    this.log.debug('收到互动事件', { type: event.type, scene: event.scene });
    for (const handler of this.interactionHandlers) {
      try {
        await handler(event, ctx, this);
      } catch (error) {
        this.log.error('互动处理器异常', { error: describeError(error) });
      }
    }
  }

  private async dispatchRawEvent(ctx: RawEventContext): Promise<void> {
    for (const handler of this.rawEventHandlers) {
      try {
        await handler(ctx, this);
      } catch (error) {
        this.log.error('原始事件处理器异常', { error: describeError(error), type: ctx.eventType });
      }
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function identifierRef(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}
