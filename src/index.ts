/**
 * 入口：加载配置 → 创建 Bot → 注册事件 → 启动。
 *
 * 当前只实现最小 QQ 协议框架与回显示例；后续业务（LLM、指令、插件）
 * 在 `bot.onMessage` 之上叠加，不修改这里的连接层。
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { ChatAgent, readAgentConfig } from './agent/index.js';
import { configureTelemetry } from './agent/telemetry.js';
import { learnAllGroups, learnGroup } from './agent/updater.js';
import { Bot } from './bot.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';

let bot: Bot;
let agent: ChatAgent;

try {
  const config = loadConfig();
  const log = createLogger(config.logging);
  bot = new Bot(config, log);

  const agentConfig = readAgentConfig(process.env);
  configureTelemetry({
    enabled: agentConfig.callLog.enabled,
    dir: agentConfig.callLog.dir,
    contextWindow: agentConfig.callLog.contextWindow,
    log,
  });
  agent = new ChatAgent(agentConfig, log, undefined, undefined, {
    // 归档时发现值得长期记住的事 → 顺手更新这个群的成员档案
    onMemoryWorthy: (chatId) => {
      void learnGroup({ dataRoot: agentConfig.dataRoot, llm: agentConfig.llm }, chatId, log)
        .then((result) => {
          if (result.written > 0) {
            log.info('归档触发档案更新', { chatId, written: result.written });
          }
        })
        .catch((error: unknown) => log.warn('归档触发档案更新失败', { chatId, error }));
    },
  });
  log.info('聊天 agent', {
    enabled: agentConfig.enabled,
    model: agentConfig.llm.model,
    apiBase: agentConfig.llm.baseUrl,
    botOpenids: agentConfig.botOpenids.length,
    botUsernames: agentConfig.botUsernames,
    groups: agentConfig.groupAllowlist.length || 'all',
    contextSize: agentConfig.contextSize,
  });

  if (agentConfig.enabled && !agentConfig.llm.apiKey) {
    log.warn('AGENT_API_KEY 为空：能连上 QQ，但不会回复任何消息');
  }

  // 档案归纳是后台任务，不参与实时回复，慢一点无所谓。
  if (agentConfig.enabled) {
    const learnEveryMs = Number(process.env.AGENT_LEARN_INTERVAL_MS ?? 30 * 60 * 1000);
    if (learnEveryMs > 0) {
      const timer = setInterval(() => {
        void learnAllGroups({ dataRoot: agentConfig.dataRoot, llm: agentConfig.llm }, log)
          .then((result) => {
            if (result.written > 0) {
              log.info('定时归纳完成', result);
            }
          })
          .catch((error: unknown) => log.warn('定时归纳失败', { error }));
      }, learnEveryMs);
      timer.unref();
      log.info('已开启档案定时归纳', { intervalMs: learnEveryMs });
    }
  }

  // 群里安静下来、没到阈值时兜底归档一次
  if (agentConfig.enabled && agentConfig.digestThreshold > 0) {
    const sweepMs = Number(process.env.AGENT_DIGEST_SWEEP_MS ?? 10 * 60 * 1000);
    if (sweepMs > 0) {
      const timer = setInterval(() => {
        void (async () => {
          try {
            let groups = agentConfig.groupAllowlist;
            if (groups.length === 0) {
              const dir = path.join(agentConfig.dataRoot, 'memory');
              groups = await readdir(dir).catch(() => [] as string[]);
            }
            const done = await agent.runDigestSweep(groups);
            if (done > 0) {
              log.info('摘要巡检完成', { digested: done });
            }
          } catch (error) {
            log.warn('摘要巡检失败', { error });
          }
        })();
      }, sweepMs);
      timer.unref();
      log.info('已开启对话归档巡检', { intervalMs: sweepMs, threshold: agentConfig.digestThreshold });
    }
  }

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

    // 交给聊天 agent：@ 才进模型，其余只进滚动缓冲。
    await agent.handle(message, b);
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
