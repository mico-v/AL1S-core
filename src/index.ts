/**
 * 入口：加载配置 → 创建 Bot → 注册事件 → 启动。
 *
 * 当前只实现最小 QQ 协议框架与回显示例；后续业务（LLM、指令、插件）
 * 在 `bot.onMessage` 之上叠加，不修改这里的连接层。
 */

import { Bot } from './bot.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';

let bot: Bot;

try {
  const config = loadConfig();
  const log = createLogger(config.logging);
  bot = new Bot(config, log);

  log.info('配置已加载', {
    appId: config.appId,
    accountId: config.accountId,
    transport: config.transport,
    webhook: config.transport === 'webhook' ? config.webhook : undefined,
    markdownSupport: config.markdownSupport,
    tokenPrefetch: config.tokenPrefetch,
    logFile: config.logging.file,
    chatLog: config.chatLog.enabled ? config.chatLog.root : false,
    saveMedia: config.chatLog.enabled ? config.chatLog.saveMedia : false,
  });

  // 进程级兜底：未捕获异常与未处理拒绝都落盘，避免静默崩溃。
  process.on('uncaughtException', (error) => {
    log.error('未捕获异常', { error });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝', { reason });
  });

  bot.onMessage(async (message, b) => {
    const text = message.content.trim();
    log.info('收到消息', {
      kind: message.kind,
      sender: message.senderName ?? message.senderId,
      senderId: message.senderId,
      groupOpenid: message.groupOpenid,
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.messageId,
      msgType: message.msgType,
      attachmentCount: message.attachments?.length ?? 0,
      text,
    });

    if (text === '/ping') {
      await b.replyText(message.replyTarget, 'pong');
      return;
    }
    if (text === '/help') {
      await b.replyText(message.replyTarget, '可用指令：/ping');
      return;
    }

    // 示例回显，后续替换为业务逻辑。
    await b.replyText(message.replyTarget, `收到：${message.content}`);
    log.debug('已回复', { messageId: message.messageId });
  });

  bot.onInteraction(async (event, _ctx, b) => {
    log.info('收到互动事件', {
      type: event.type,
      scene: event.scene,
      groupOpenid: event.group_openid,
      userOpenid: event.user_openid,
      buttonId: event.data.resolved.button_id,
      buttonData: event.data.resolved.button_data,
    });
    // 点击按钮必须回应，否则客户端一直 loading。
    await b.acknowledgeInteraction(event.id, 0);
  });

  bot.onRawEvent((ctx) => {
    log.debug('原始事件', { type: ctx.eventType, data: ctx.data });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info('收到退出信号，正在关闭', { signal });
    await bot.flush();
    bot.stop();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.start();
  log.info('QQ 机器人已停止');
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`配置错误：${error.message}`);
  } else {
    console.error('启动失败：', error);
  }
  process.exit(1);
}
