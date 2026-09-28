/**
 * QQ 官方机器人 -> Tuwunel Matrix Application Service 独立入口。
 *
 * 与 `src/index.ts` 的纯 QQ echo 示例分离，只有启用
 * `MATRIX_BRIDGE_ENABLED=true` 时才启动。
 */

import { Bot } from './bot.js';
import { QqMatrixBridge } from './bridge/bridge.js';
import { BridgeStore } from './bridge/store.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { MatrixAppserviceServer } from './matrix/appservice.js';
import { MatrixClient } from './matrix/client.js';
import { BridgeMetrics } from './matrix/metrics.js';

try {
  const config = loadConfig();
  if (config.matrixBridge === undefined) {
    throw new ConfigError('缺少 Matrix bridge 配置：请设置 MATRIX_BRIDGE_ENABLED=true');
  }

  const bridgeConfig = config.matrixBridge;
  const log = createLogger(config.logging);
  const metrics = new BridgeMetrics();
  const bot = new Bot(config, log, {
    chatLogEnabled: false,
    redactMessageIdentifiers: true,
  });
  const matrix = new MatrixClient(
    {
      homeserverUrl: bridgeConfig.homeserverUrl,
      accessToken: bridgeConfig.asToken,
      timeoutMs: bridgeConfig.requestTimeoutMs,
      log,
    },
    bridgeConfig.userId,
  );
  const store = new BridgeStore({
    file: bridgeConfig.dataFile,
    secret: bridgeConfig.identitySecret,
    logger: log,
    metrics,
    referenceTtlMs: bridgeConfig.referenceTtlMs,
    maxReferences: bridgeConfig.maxReferences,
    maxPendingQqMessages: bridgeConfig.qqInboundQueueMaxEntries,
  });
  const bridge = new QqMatrixBridge({
    bot,
    matrix,
    store,
    config: bridgeConfig,
    logger: log,
    metrics,
    maxMediaBytes: bridgeConfig.maxMediaBytes,
  });
  const appservice = new MatrixAppserviceServer({
    host: bridgeConfig.listenHost,
    port: bridgeConfig.listenPort,
    hsToken: bridgeConfig.hsToken,
    log,
    metrics,
    shutdownTimeoutMs: bridgeConfig.shutdownTimeoutMs,
    onTransaction: (transactionId, transaction) =>
      bridge.handleTransaction(transactionId, transaction),
  });

  bot.onMessage((message) => bridge.handleQqMessage(message));

  log.info('Matrix bridge 配置已加载', {
    id: bridgeConfig.id,
    homeserverUrl: bridgeConfig.homeserverUrl,
    domain: bridgeConfig.domain,
    appserviceUser: bridgeConfig.userId,
    listen: `${bridgeConfig.listenHost}:${bridgeConfig.listenPort}`,
    dataFile: bridgeConfig.dataFile,
    encryption: false,
  });

  let shutdownTask: Promise<void> | undefined;
  const shutdown = (reason: string, exitCode = 0): Promise<void> => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    if (shutdownTask !== undefined) {
      return shutdownTask;
    }
    log.info('正在关闭 Matrix bridge', { reason, exitCode });
    shutdownTask = (async () => {
      const failures: unknown[] = [];
      const attempt = async (step: string, action: () => Promise<void> | void): Promise<void> => {
        try {
          await action();
        } catch (error) {
          failures.push(error);
          log.error('关闭步骤失败，继续执行剩余清理', {
            step,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      try {
        await attempt('bot-stop', () => bot.stop());
        await attempt('appservice-stop', () => appservice.stop());
        await attempt('bridge-stop', () => bridge.stop());
        await attempt('bridge-flush', () => bridge.flush());
        await attempt('store-flush', () => store.flush());
        await attempt('bot-flush', () => bot.flush());
      } finally {
        await attempt('bot-final-stop', () => bot.stop());
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Matrix bridge 关闭未完全成功');
      }
    })();
    return shutdownTask;
  };

  process.on('uncaughtException', (error) => {
    log.error('未捕获异常，正在关闭 Matrix bridge', { error });
    void shutdown('uncaughtException', 1).catch((shutdownError: unknown) => {
      log.error('异常关闭失败', { error: shutdownError });
      process.exitCode = 1;
    });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝，正在关闭 Matrix bridge', { reason });
    void shutdown('unhandledRejection', 1).catch((shutdownError: unknown) => {
      log.error('异常关闭失败', { error: shutdownError });
      process.exitCode = 1;
    });
  });
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await appservice.start();
  await bridge.start();
  await bot.start();
  await shutdown('transport-stopped');
  log.info('Matrix bridge 已停止');
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`配置错误：${error.message}`);
  } else {
    console.error('Matrix bridge 启动失败：', error);
  }
  process.exit(1);
}
