/**
 * Bot 类：持有 WebSocket 客户端、会话管理、skill 注册中心与 LLM provider。
 * 负责注册插件、绑定消息事件、获取登录昵称（写入 pipeline）、优雅关闭。
 */
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import type { BotConfig } from './config';
import { logger } from './logging/logger';
import { OpenAIProvider } from './llm/openai';
import { SessionManager } from './session/manager';
import { SkillRegistry } from './skills/registry';
import { registerPlugins } from './skills/plugins';
import { Pipeline } from './pipeline/pipeline';

const log = logger.child('bot');

export class Bot {
  private readonly client: SnowLumaWebSocketClient;
  private readonly registry: SkillRegistry;
  private readonly pipeline: Pipeline;

  constructor(config: BotConfig) {
    this.client = new SnowLumaWebSocketClient({
      url: config.wsUrl,
      accessToken: config.accessToken,
      reconnect: true,
    });
    this.registry = new SkillRegistry();
    const sessions = new SessionManager({
      tokenBudget: config.contextTokenBudget,
      maxSessions: config.maxSessions,
    });
    // apiKey 缺失时也构造 provider：运行时请求会以 done.error 返回（llm-check 已提示）
    const provider = new OpenAIProvider({
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
    });
    this.pipeline = new Pipeline({ config, provider, sessions, registry: this.registry });
  }

  async start(): Promise<void> {
    // 注册插件（skill 与命令）
    registerPlugins(this.registry);

    // 绑定消息事件
    this.client.onGroupMessage((event, ctx) => this.pipeline.handleGroupMessage(event, ctx));
    this.client.onPrivateMessage((event, ctx) => this.pipeline.handlePrivateMessage(event, ctx));

    // 连接状态日志
    this.client.on('open', () => log.info('已连接', { url: this.client.url }));
    this.client.on('close', (info) => log.warn('连接关闭', { code: info?.code ?? '', reason: info?.reason ?? '' }));
    this.client.on('error', (err) => log.error('连接错误', { err }));

    // 取登录昵称写入 pipeline（request 内部会自动发起连接，与下方 connect 幂等）
    try {
      const login = await this.client.getLoginInfo();
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

  /** 优雅关闭：关闭 WebSocket 并退出 */
  stop(): void {
    log.info('正在关闭……');
    this.client.close(1000, 'bye');
    process.exit(0);
  }
}
