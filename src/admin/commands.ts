import type { ConfigStore } from '../config/store';
import type { BotConfig } from '../config';
import type { SessionManager } from '../session/manager';
import type { SkillRegistry } from '../skills/registry';

export interface AdminCommandContext {
  chatId: string;
  senderId?: number;
  senderName: string;
  reply(text: string): Promise<void>;
}

/** 面向 QQ 消息的内置管理命令，不注册到普通插件命令表。 */
export class BuiltinCommandDispatcher {
  private readonly registry: SkillRegistry;
  private readonly sessions: SessionManager;
  private readonly config: BotConfig;

  constructor(registry: SkillRegistry, sessions: SessionManager, config: BotConfig) {
    this.registry = registry;
    this.sessions = sessions;
    this.config = config;
  }

  async dispatch(raw: string, context: AdminCommandContext): Promise<boolean> {
    const tokens = raw.trim().split(/\s+/);
    const name = tokens[0];
    if (name !== '/help' && name !== '/reset' && name !== '/persona') return false;

    const rest = raw.trim().slice(name.length).trim();
    switch (name) {
      case '/help':
        await context.reply(this.helpText());
        return true;
      case '/reset':
        this.sessions.clear(context.chatId);
        await context.reply('已清空本群/本会话上下文。');
        return true;
      case '/persona': {
        const session = this.sessions.get(context.chatId);
        if (!rest) {
          await context.reply(`当前人设：${session.personaOverride ?? this.config.persona}`);
        } else {
          session.setPersonaOverride(rest);
          await context.reply('已更新本会话人设。');
        }
        return true;
      }
      default:
        return false;
    }
  }

  private helpText(): string {
    const lines = [
      '—— 管理命令 ——',
      '/help：显示帮助',
      '/reset：清空本群/本会话上下文',
      '/persona：查看或修改人设，/persona 新的人设内容',
      '/llm：管理员 LLM 服务管理',
      '',
      '—— 插件命令（$command） ——',
    ];
    for (const command of this.registry.getAllPluginCommands()) {
      if (!command.enabled) continue;
      lines.push(`$${command.name}${command.aliases.length ? `（${command.aliases.join('、')}）` : ''}：${command.description}`);
    }
    lines.push('', '—— 内置管理命令 ——');
    lines.push('/help、/reset、/persona、/llm');
    return lines.join('\n');
  }
}

export class LlmAdminService {
  private readonly store: ConfigStore;

  constructor(store: ConfigStore) {
    this.store = store;
  }

  isAdmin(senderId: number | undefined): boolean {
    return senderId !== undefined && this.store.config.adminIds.length > 0 && this.store.config.adminIds.includes(senderId);
  }

  status(): string {
    const cfg = this.store.config;
    return [`模型：${cfg.llm.model}`, `Base URL：${cfg.llm.baseUrl}`, `最大 tokens：${cfg.llm.maxTokens}`, `待重启：${this.store.restartRequired ? '是' : '否'}`].join('\n');
  }

  updateModel(model: string): string {
    const value = model.trim();
    if (!value || value.length > 200) return '模型名不能为空或过长。';
    const result = this.store.updateValues({ 'llm.model': value });
    return result.applied.includes('llm.model') ? `已切换模型：${value}` : '模型切换失败。';
  }

  updateTemperature(value: string): string {
    const temperature = Number(value);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) return 'temperature 必须是 0 到 2 之间的数字。';
    const result = this.store.updateValues({ 'llm.temperature': temperature });
    return result.applied.includes('llm.temperature') ? `已设置 temperature：${temperature}` : 'temperature 设置失败。';
  }

  updateMaxTokens(value: string): string {
    const maxTokens = Number(value);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 1_000_000) return 'max-tokens 必须是 1 到 1000000 之间的整数。';
    const result = this.store.updateValues({ 'llm.maxTokens': maxTokens });
    return result.applied.includes('llm.maxTokens') ? `已设置最大 tokens：${maxTokens}` : '最大 tokens 设置失败。';
  }

  restartStatus(): string {
    return this.store.restartRequired ? '当前有配置修改需要重启后生效。' : '当前没有待重启配置。';
  }
}

/** 管理命令总分发器：/llm 与 builtin 管理命令均不经过普通插件 CLI。 */
export class AdminCommandDispatcher {
  private readonly service: LlmAdminService;
  private readonly builtin?: BuiltinCommandDispatcher;

  constructor(service: LlmAdminService, builtin?: BuiltinCommandDispatcher) {
    this.service = service;
    this.builtin = builtin;
  }

  async dispatch(raw: string, context: AdminCommandContext): Promise<boolean> {
    if (this.builtin && await this.builtin.dispatch(raw, context)) return true;

    const tokens = raw.trim().split(/\s+/);
    if (tokens[0] !== '/llm') return false;
    if (!this.service.isAdmin(context.senderId)) {
      await context.reply('该管理命令仅允许 Bot 全局管理员使用。');
      return true;
    }
    const action = tokens[1] ?? 'status';
    let output: string;
    switch (action) {
      case 'status': output = this.service.status(); break;
      case 'model': output = this.service.updateModel(tokens.slice(2).join(' ')); break;
      case 'temperature': output = this.service.updateTemperature(tokens[2] ?? ''); break;
      case 'max-tokens': output = this.service.updateMaxTokens(tokens[2] ?? ''); break;
      case 'restart-status': output = this.service.restartStatus(); break;
      default: output = '用法：/llm status|model <name>|temperature <0..2>|max-tokens <整数>|restart-status';
    }
    await context.reply(output);
    return true;
  }
}
