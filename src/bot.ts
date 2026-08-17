/**
 * Bot 类：持有 WebSocket 客户端、会话管理、skill 注册中心与 LLM provider。
 * 负责注册插件、绑定消息事件、获取登录昵称（写入 pipeline）、优雅关闭。
 * 同时装配管理后台：运行时 ConfigStore、会话持久化、插件启停控制、AdminServer。
 */
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { readFileSync } from 'node:fs';
import type { BotConfig } from './config';
import { ConfigStore } from './config/store';
import { logger } from './logging/logger';
import { OpenAIProvider } from './llm/openai';
import { SessionManager } from './session/manager';
import { SessionPersistence } from './session/persistence';
import { SkillRegistry } from './skills/registry';
import { PluginControl } from './plugins/control';
import { registerPlugins } from './skills/plugins';
import { normalizeMessage } from './pipeline/normalize';
import { Al1sFormatter } from './format/formatter';
import { Pipeline } from './pipeline/pipeline';
import { AdminServer } from './admin/server';
import type { AdminContext } from './admin/router';

const log = logger.child('bot');
const receiveLog = logger.child('receive');

/** 是否记录「收到消息」日志：LOG_RECEIVE='0'|'false'|'off' 时关闭，缺省开启 */
function logReceiveEnabled(): boolean {
  const raw = process.env.LOG_RECEIVE;
  return raw === undefined || !['0', 'false', 'off'].includes(raw.trim().toLowerCase());
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export class Bot {
  private readonly client: SnowLumaWebSocketClient;
  private readonly configStore: ConfigStore;
  private readonly registry: SkillRegistry;
  private readonly pluginControl: PluginControl;
  private readonly pipeline: Pipeline;
  private readonly persistence: SessionPersistence;
  private readonly adminServer?: AdminServer;
  private readonly startedAt = Date.now();
  private botNickname = '';

  constructor(config: BotConfig) {
    // 先建 ConfigStore：加载 settings.json 覆盖层 → 再以可变 config 构造各组件（现读即热）
    this.configStore = new ConfigStore();
    const cfg = this.configStore.config;

    this.client = new SnowLumaWebSocketClient({
      url: cfg.wsUrl,
      accessToken: cfg.accessToken,
      reconnect: true,
    });
    this.registry = new SkillRegistry();
    this.pluginControl = new PluginControl(this.registry);

    const sessions = new SessionManager({
      tokenBudget: cfg.contextTokenBudget,
      maxSessions: cfg.maxSessions,
      getTokenBudget: () => cfg.contextTokenBudget,
      getMaxSessions: () => cfg.maxSessions,
    });
    this.persistence = new SessionPersistence(sessions);
    this.persistence.attach(); // 会话磁盘恢复 + 防抖落盘

    // apiKey 缺失时也构造 provider：运行时请求会以 done.error 返回（llm-check 已提示）
    const provider = new OpenAIProvider({
      baseUrl: cfg.llm.baseUrl,
      apiKey: cfg.llm.apiKey,
      model: cfg.llm.model,
    });
    // 模型切换热更新（apiKey/baseUrl 需重启后由 ConfigStore 重新应用）
    this.configStore.registerApplier((store) => provider.setModel(store.config.llm.model));

    const formatter = new Al1sFormatter(cfg.al1sFormat);
    this.pipeline = new Pipeline({ config: cfg, provider, sessions, registry: this.registry, formatter });

    // 管理后台（未配置 ADMIN_TOKEN 时不启动）
    const adminPort = Number(process.env.ADMIN_PORT ?? 6185);
    if (adminTokenEnabled()) {
      const adminCtx: AdminContext = {
        configStore: this.configStore,
        registry: this.registry,
        pluginControl: this.pluginControl,
        sessions,
        persistence: this.persistence,
        isConnected: () => this.client.isConnected,
        getLogin: async () => {
          try {
            return await this.client.getLoginInfo();
          } catch {
            return undefined;
          }
        },
        getBotNickname: () => this.botNickname,
        startedAt: this.startedAt,
        version: readVersion(),
        shutdown: () => this.stop(),
      };
      this.adminServer = new AdminServer(adminCtx, adminPort);
    }
  }

  async start(): Promise<void> {
    // 注入 api 通道，再注册插件（插件可能在 register 时读取）
    this.registry.setApi(this.client);
    registerPlugins(this.registry);
    // 插件注册后再恢复启停状态（避免被 register 的默认启用覆盖）
    this.pluginControl.attach();

    this.adminServer ? void this.adminServer.start() : undefined;

    // 绑定消息事件：先记「收到消息」日志 + 跑插件后台钩子（防撤回缓存/课堂提醒等），再走主 pipeline
    this.client.onGroupMessage(async (event, ctx) => {
      if (logReceiveEnabled()) {
        const norm = normalizeMessage(event);
        receiveLog.info('收到群消息', {
          chatId: `g:${event.group_id}`,
          group: event.group_id,
          senderId: event.user_id,
          senderName: event.sender.nickname || `用户${event.user_id}`,
          atBot: norm.atBot,
          text: norm.text,
        });
      }
      await this.registry.runMessageHooks(event, ctx);
      await this.pipeline.handleGroupMessage(event, ctx);
    });
    this.client.onPrivateMessage(async (event, ctx) => {
      if (logReceiveEnabled()) {
        const norm = normalizeMessage(event);
        receiveLog.info('收到私聊消息', {
          chatId: `p:${event.user_id}`,
          senderId: event.user_id,
          senderName: event.sender.nickname || `用户${event.user_id}`,
          atBot: norm.atBot,
          text: norm.text,
        });
      }
      await this.registry.runMessageHooks(event, ctx);
      await this.pipeline.handlePrivateMessage(event, ctx);
    });
    // 通知事件（撤回、入群等）→ 插件通知钩子
    this.client.onNotice((event, ctx) => this.registry.runNoticeHooks(event, ctx));

    // 连接状态日志
    this.client.on('open', () => log.info('已连接', { url: this.client.url }));
    this.client.on('close', (info) => log.warn('连接关闭', { code: info?.code ?? '', reason: info?.reason ?? '' }));
    this.client.on('error', (err) => log.error('连接错误', { err }));

    // 取登录昵称写入 pipeline（request 内部会自动发起连接，与下方 connect 幂等）
    try {
      const login = await this.client.getLoginInfo();
      this.botNickname = login.nickname;
      this.pipeline.setBotNickname(login.nickname);
      log.info('登录账号', { userId: login.user_id, nickname: login.nickname });
    } catch (err) {
      log.error('获取登录信息失败', { err });
    }

    await this.client.connect();
    log.info('就绪，等待事件……（Ctrl+C 退出）');

    // 优雅关闭
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  /** 优雅关闭：落盘会话、关闭 WebSocket 并退出 */
  stop(): void {
    log.info('正在关闭……');
    try {
      this.persistence.flushAll();
    } catch (err) {
      log.error('会话落盘失败', { err });
    }
    this.client.close(1000, 'bye');
    process.exit(0);
  }
}

function adminTokenEnabled(): boolean {
  const raw = process.env.ADMIN_TOKEN;
  return raw !== undefined && raw.trim() !== '';
}
