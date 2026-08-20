/**
 * skill 注册中心：管理两类扩展——
 * - 工具 skill：供 LLM function calling 调用（模型自动触发）
 * - 斜杠命令：供群成员显式触发（/help、/reset 等）
 * 插件（Plugin）是 skill + 命令的打包单元，经 register 挂载到注册中心。
 * 另提供消息/撤回通知钩子与 OneBot api 通道，供插件做后台监听（如防撤回、课堂提醒）。
 */
import type {
  OneBotMessageEvent,
  OneBotNoticeEvent,
  OutgoingMessage,
  SnowLumaApiClient,
  SnowLumaEventContext,
} from '@snowluma/sdk';
import type { SessionManager } from '../session/manager';
import type { BotConfig } from '../config';
import type { ConfigGroupMeta } from '../config/schema';
import type { MspRuntime } from '../msp/protocol/types';
import type { PluginCliRegistry } from '../msp/plugin-cli-registry';
import { logger } from '../logging/logger';
import { getToolName } from '../agent/tool-names';
import { sendLogged } from '../logging/send-log';

const log = logger.child('registry');

export interface MessageHookResult {
  handled?: boolean;
}

/** 后台消息/通知钩子的返回类型（同步或异步均可） */
export type MaybePromise<T = void> = T | Promise<T>;

/** 工具执行上下文：本次调用对应的会话与消息来源 */
export interface SkillRunContext {
  chatId: string;
  groupId?: number;
  senderId?: number;
  senderName: string;
  signal?: AbortSignal;
  config?: BotConfig;
}

/** 工具 skill：模型通过 function calling 调用，返回文本结果 */
export interface Skill {
  /** canonical/CLI 名称；显示和路由仍使用此字段 */
  name: string;
  /** 发给 OpenAI function calling 的稳定 ASCII 名称 */
  toolName?: string;
  /** 注册所属模块，供工具 schema 错误审计使用 */
  module?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: SkillRunContext): Promise<string>;
}

/** 命令上下文：命令可访问回复通道、OneBot api、会话管理与配置 */
export interface CommandContext {
  chatId: string;
  groupId?: number; // 群聊命令时的群号
  senderId?: number;
  senderName?: string;
  rest: string;
  input?: Record<string, unknown>;
  reply(text: string): Promise<void>;
  send(message: OutgoingMessage): Promise<unknown>; // 富文本/图片/at 等消息段回复
  api: SnowLumaApiClient; // 任意 OneBot action（发图、上传群文件、拉成员列表等）
  sessions: SessionManager;
  config: BotConfig;
}

/** 后台消息钩子：每条群/私聊消息都触发（含命令与未触发消息） */
export type MessageHook = (event: OneBotMessageEvent, ctx: SnowLumaEventContext) => MaybePromise<MessageHookResult | void>;

/** 后台通知钩子：每条 OneBot notice（如 group_recall 撤回）都触发 */
export type NoticeHook = (event: OneBotNoticeEvent, ctx: SnowLumaEventContext) => MaybePromise<void>;

export interface CommandCliBinding {
  plugin: string;
  command: string;
  aliases?: string[];
  entrypoint?: string;
  execution?: 'runtime-cli' | 'host-effect';
  risk?: 'low' | 'medium' | 'high';
  supportsChat?: boolean;
  supportsAgent?: boolean;
}

export interface PluginCommandInfo {
  id: string;
  plugin: string;
  name: string;
  description: string;
  kind: 'command' | 'skill';
  aliases: string[];
  inputSchema?: Record<string, unknown>;
  entrypoint?: string;
  execution: 'runtime-cli' | 'host-effect';
  risk?: 'low' | 'medium' | 'high';
  supportsChat: boolean;
  supportsAgent: boolean;
  enabled: boolean;
}

/** 斜杠命令（迁移期保留类型；普通插件命令统一通过 $/Agent 调用） */
export interface Command {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  aliases?: string[];
  /** 普通插件命令的 CLI 映射；内置管理命令不设置此字段。 */
  cli?: CommandCliBinding;
  handler(ctx: CommandContext): Promise<void>;
}

/** 插件元数据（管理后台据此渲染插件卡片与详情页） */
export interface PluginMeta {
  name: string;
  displayName: string;
  description: string;
  settings?: ConfigGroupMeta; // 插件设置 schema；无设置项则省略
}

/** 插件：一组 skill 与命令的打包单元，注册入口 */
export interface Plugin {
  name: string;
  displayName?: string; // 侧栏/页头显示名；缺省用 name
  description: string;
  settings?: ConfigGroupMeta; // 插件声明设置（模块顶层需先 registerConfigFields 并入字段索引）
  register(registry: SkillRegistry): void;
  dispose?: () => void | Promise<void>;
}

/** skill 注册中心 */
export class SkillRegistry {
  private skills: Skill[] = [];
  private commands: Command[] = [];
  private commandEnabled = new Map<string, boolean>();
  private skillEnabled = new Map<string, boolean>();
  private api?: SnowLumaApiClient;
  private runtimeConfig?: BotConfig;
  private sessionManager?: SessionManager;
  private commandRouter?: import('../pipeline/command-router').PluginCommandRouter;
  private sessionCommandRunner?: import('../msp/session-command-runner').SessionCommandRunner;
  private mspRuntime?: MspRuntime;
  private cliRegistry?: PluginCliRegistry;
  private messageHooks: MessageHook[] = [];
  private noticeHooks: NoticeHook[] = [];
  // 插件元数据 + 命令/skill 归属（管理后台按插件分组展示用）
  private pluginMetas: PluginMeta[] = [];
  private currentPluginName: string | undefined;
  private commandPlugins = new Map<string, string>();
  private skillPlugins = new Map<string, string>();
  private readonly pluginInstances = new Map<string, Plugin>();
  private readonly pluginEnabled = new Map<string, boolean>();
  private readonly hookPlugins = new Map<MessageHook | NoticeHook, string>();
  private readonly pluginRuntime = new Map<string, { dispose?: () => void | Promise<void>; reloadFromConfig?: () => void }>();

  /** 注册插件元数据并执行插件注册；期间 registerCommand/registerSkill 自动归属该插件 */
  registerPlugin(plugin: Plugin): void {
    this.pluginMetas.push({
      name: plugin.name,
      displayName: plugin.displayName ?? plugin.name,
      description: plugin.description,
      settings: plugin.settings,
    });
    this.pluginInstances.set(plugin.name, plugin);
    if (!this.pluginEnabled.has(plugin.name)) this.pluginEnabled.set(plugin.name, true);
    const prev = this.currentPluginName;
    this.currentPluginName = plugin.name;
    try {
      plugin.register(this);
    } finally {
      this.currentPluginName = prev;
    }
  }

  registerPluginInstance(name: string, runtime: { dispose?: () => void | Promise<void>; reloadFromConfig?: () => void }): void {
    this.pluginRuntime.set(name, runtime);
  }

  reloadPlugin(name: string): void {
    this.pluginRuntime.get(name)?.reloadFromConfig?.();
  }


  getPluginMetas(): PluginMeta[] {
    return [...this.pluginMetas];
  }

  /** 按名称查插件元数据 */
  getPluginMeta(name: string): PluginMeta | undefined {
    return this.pluginMetas.find((p) => p.name === name);
  }

  /** 某插件注册的全部命令 */
  getCommandsByPlugin(name: string): Command[] {
    return this.commands.filter((c) => this.commandPlugins.get(c.name) === name);
  }

  /** 某插件注册的全部工具 skill */
  getSkillsByPlugin(name: string): Skill[] {
    return this.skills.filter((s) => this.skillPlugins.get(s.name) === name);
  }

  getPluginCommands(name: string): PluginCommandInfo[] {
    const commands: PluginCommandInfo[] = [];
    for (const command of this.getCommandsByPlugin(name)) {
      const binding = command.cli;
      commands.push({
        id: `${name}:command:${command.name}`,
        plugin: name,
        name: command.name,
        description: command.description,
        kind: 'command',
        aliases: command.aliases ?? binding?.aliases ?? [],
        inputSchema: command.inputSchema,
        entrypoint: binding?.entrypoint,
        execution: binding?.execution === 'runtime-cli' ? 'runtime-cli' : 'host-effect',
        risk: binding?.risk,
        supportsChat: binding?.supportsChat ?? true,
        supportsAgent: binding?.supportsAgent ?? false,
        enabled: this.isCommandEnabled(command.name),
      });
    }
    for (const skill of this.getSkillsByPlugin(name)) {
      commands.push({
        id: `${name}:skill:${skill.name}`,
        plugin: name,
        name: skill.name,
        description: skill.description,
        kind: 'skill',
        aliases: [],
        inputSchema: skill.inputSchema,
        entrypoint: 'internal:skill',
        execution: 'host-effect',
        supportsChat: false,
        supportsAgent: true,
        enabled: this.isSkillEnabled(skill.name),
      });
    }
    const cliCommands = this.cliRegistry?.list().filter((command) => command.plugin === name) ?? [];
    for (const cli of cliCommands) {
      const info: PluginCommandInfo = {
        id: cli.id,
        plugin: name,
        name: cli.name,
        description: cli.summary ?? cli.name,
        kind: 'command',
        aliases: cli.aliases ?? cli.lookupPaths ?? [],
        inputSchema: cli.inputSchema,
        entrypoint: cli.executable,
        execution: cli.execution === 'runtime-cli' || cli.execution === 'runtime' ? 'runtime-cli' : 'host-effect',
        supportsChat: cli.supportsChat,
        supportsAgent: cli.supportsAgent,
        enabled: cli.enabled,
      };
      const index = commands.findIndex((command) => command.name === info.name || command.aliases.includes(info.name));
      if (index >= 0) commands[index] = info;
      else commands.push(info);
    }
    return commands;
  }

  getAllPluginCommands(): PluginCommandInfo[] {
    const commands = this.pluginMetas.flatMap((meta) => this.getPluginCommands(meta.name));
    const cliCommands = this.cliRegistry?.list() ?? [];
    for (const cli of cliCommands) {
      if (commands.some((command) => command.id === cli.id)) continue;
      commands.push({
        id: cli.id,
        plugin: cli.plugin ?? 'unknown',
        name: cli.name,
        description: cli.summary ?? cli.name,
        kind: 'command',
        aliases: cli.aliases ?? cli.lookupPaths ?? [],
        inputSchema: cli.inputSchema,
        entrypoint: cli.executable,
        execution: cli.execution === 'runtime-cli' || cli.execution === 'runtime' ? 'runtime-cli' : 'host-effect',
        supportsChat: cli.supportsChat,
        supportsAgent: cli.supportsAgent,
        enabled: cli.enabled,
      });
    }
    return commands;
  }

  findPluginCommand(name: string): PluginCommandInfo | undefined {
    return this.getAllPluginCommands().find((command) => command.name === name || command.aliases.includes(name));
  }

  /** 注册一个工具 skill（默认启用；保留已持久化的禁用状态） */
  registerSkill(skill: Skill): void {
    if (!skill.toolName) skill.toolName = getToolName(skill.name, this.currentPluginName);
    if (!skill.module) skill.module = this.currentPluginName ?? 'unknown';
    this.skills.push(skill);
    if (this.currentPluginName !== undefined) this.skillPlugins.set(skill.name, this.currentPluginName);
    if (!this.skillEnabled.has(skill.name)) this.skillEnabled.set(skill.name, true);
  }

  /** 注册一个斜杠命令（默认启用；保留已持久化的禁用状态） */
  registerCommand(command: Command): void {
    this.commands.push(command);
    if (this.currentPluginName !== undefined) this.commandPlugins.set(command.name, this.currentPluginName);
    if (!this.commandEnabled.has(command.name)) this.commandEnabled.set(command.name, true);
  }

  setPluginEnabled(name: string, enabled: boolean): boolean {
    if (!this.pluginInstances.has(name)) return false;
    this.pluginEnabled.set(name, enabled);
    this.cliRegistry?.setPluginEnabled(name, enabled);
    return true;
  }

  isPluginEnabled(name: string): boolean {
    return this.pluginEnabled.get(name) ?? true;
  }

  async disposePlugins(): Promise<void> {
    for (const plugin of this.pluginInstances.values()) {
      try { await plugin.dispose?.(); } catch (err) { log.error('插件清理失败', { module: 'src/skills/registry.ts', plugin: plugin.name, reason: err instanceof Error ? err.message : String(err) }); }
    }
    for (const runtime of this.pluginRuntime.values()) {
      try { await runtime.dispose?.(); } catch (err) { log.error('插件 runtime 清理失败', { module: 'src/skills/registry.ts', reason: err instanceof Error ? err.message : String(err) }); }
    }
  }


  setEnabled(kind: 'command' | 'skill', name: string, enabled: boolean): boolean {
    const owner = kind === 'command' ? this.commandPlugins.get(name) : this.skillPlugins.get(name);
    const exists = kind === 'command' ? this.commands.some((c) => c.name === name) : this.skills.some((s) => s.name === name);
    if (!exists) return false;
    const map = kind === 'command' ? this.commandEnabled : this.skillEnabled;
    map.set(name, enabled);
    if (kind === 'command') this.cliRegistry?.setEnabled(name, enabled);
    return true;
  }

  setCommandEnabledById(id: string, enabled: boolean): boolean {
    const match = /^([^:]+):(command|skill):(.+)$/.exec(id);
    if (!match) return false;
    const kind = match[2] === 'skill' ? 'skill' : 'command';
    return this.setEnabled(kind, match[3]!, enabled);
  }

  isCommandEnabled(name: string): boolean {
    return this.commandEnabled.get(name) ?? true;
  }

  isSkillEnabled(name: string): boolean {
    return this.skillEnabled.get(name) ?? true;
  }

  /** 启用的命令（/help、命令分发用） */
  getEnabledCommands(): Command[] {
    return this.commands.filter((c) => this.isCommandEnabled(c.name) && this.isPluginEnabled(this.commandPlugins.get(c.name) ?? ''));
  }

  /** 启用的工具（agent 工具列表用） */
  getEnabledSkills(): Skill[] {
    return this.skills.filter((s) => this.isSkillEnabled(s.name) && this.isPluginEnabled(this.skillPlugins.get(s.name) ?? ''));
  }

  serializeEnabled(): { plugins: Record<string, boolean>; commands: Record<string, boolean>; skills: Record<string, boolean> } {
    const plugins: Record<string, boolean> = {};
    const commands: Record<string, boolean> = {};
    const skills: Record<string, boolean> = {};
    for (const meta of this.pluginMetas) plugins[meta.name] = this.isPluginEnabled(meta.name);
    for (const c of this.commands) commands[c.name] = this.isCommandEnabled(c.name);
    for (const s of this.skills) skills[s.name] = this.isSkillEnabled(s.name);
    return { plugins, commands, skills };
  }

  restoreEnabled(data: { plugins?: Record<string, boolean>; commands?: Record<string, boolean>; skills?: Record<string, boolean> } | null | undefined): void {
    if (data?.plugins) {
      for (const [name, enabled] of Object.entries(data.plugins)) this.pluginEnabled.set(name, enabled);
    }
    if (data?.commands) {
      for (const [name, enabled] of Object.entries(data.commands)) {
        this.commandEnabled.set(name, enabled);
        this.cliRegistry?.setEnabled(name, enabled);
      }
    }
    if (data?.skills) {
      for (const [name, enabled] of Object.entries(data.skills)) this.skillEnabled.set(name, enabled);
    }
  }

  /** 注入 OneBot api 通道（bot.ts 在 start 时调用），后台钩子/定时器据此取 api */
  setApi(client: SnowLumaApiClient): void {
    this.api = client;
  }

  setConfig(config: BotConfig): void {
    this.runtimeConfig = config;
  }

  setSessionManager(sessions: SessionManager): void {
    this.sessionManager = sessions;
  }

  setMspRuntime(runtime: MspRuntime | undefined): void {
    this.mspRuntime = runtime;
  }

  setCliRegistry(registry: PluginCliRegistry | undefined): void {
    this.cliRegistry = registry;
  }

  getCliRegistry(): PluginCliRegistry | undefined {
    return this.cliRegistry;
  }

  getSessionManager(): SessionManager | undefined {
    return this.sessionManager;
  }

  setSessionCommandRunner(runner: import('../msp/session-command-runner').SessionCommandRunner): void {
    this.sessionCommandRunner = runner;
  }

  getSessionCommandRunner(): import('../msp/session-command-runner').SessionCommandRunner | undefined {
    return this.sessionCommandRunner;
  }

  setCommandRouter(router: import('../pipeline/command-router').PluginCommandRouter): void {
    this.commandRouter = router;
  }

  getCommandRouter(): import('../pipeline/command-router').PluginCommandRouter | undefined {
    return this.commandRouter;
  }

  getMspRuntime(): MspRuntime | undefined {
    return this.mspRuntime;
  }

  getConfig(): BotConfig | undefined {
    return this.runtimeConfig;
  }

  /** 取 OneBot api 通道（未注入时为 undefined） */
  getApi(): SnowLumaApiClient | undefined {
    return this.api;
  }

  /** 注册后台消息钩子（每条消息触发一次） */
  addMessageHook(hook: MessageHook): void {
    this.messageHooks.push(hook);
    if (this.currentPluginName) this.hookPlugins.set(hook, this.currentPluginName);
  }

  /** 注册后台通知钩子（每条 notice 触发一次） */
  addNoticeHook(hook: NoticeHook): void {
    this.noticeHooks.push(hook);
    if (this.currentPluginName) this.hookPlugins.set(hook, this.currentPluginName);
  }

  /** 顺序执行全部消息钩子；单个钩子抛错只记日志，不中断后续 */
  async runMessageHooks(event: OneBotMessageEvent, ctx: SnowLumaEventContext): Promise<boolean> {
    let handled = false;
    for (const hook of [...this.messageHooks]) {
      const owner = this.hookPlugins.get(hook);
      if (owner && this.pluginEnabled.get(owner) === false) continue;
      try {
        const result = await hook(event, ctx);
        if (result?.handled) handled = true;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const eventRecord = event as OneBotMessageEvent & { group_id?: number; user_id?: number };
        const groupId = typeof eventRecord.group_id === 'number' ? eventRecord.group_id : undefined;
        const senderId = typeof eventRecord.user_id === 'number' ? eventRecord.user_id : undefined;
        const chatId = groupId === undefined ? `p:${senderId ?? ''}` : `g:${groupId}`;
        log.error('消息钩子失败，已消费消息', {
          module: 'src/skills/registry.ts',
          command: 'message-hook',
          chatId,
          groupId,
          senderId,
          reason,
        });
        // 钩子失败也必须消费本条消息，避免异常后继续进入 Agent 产生误回复。
        handled = true;
        try {
          const message = '消息钩子执行失败（模块：src/skills/registry.ts），已停止后续处理。';
          await sendLogged((out) => ctx.reply(out as never), { module: 'src/skills/registry.ts', command: 'message-hook', chatId, groupId, senderId, messageType: 'text' }, message);
        } catch (replyError) {
          log.error('消息钩子错误提示发送失败', {
            module: 'src/skills/registry.ts',
            command: 'message-hook',
            chatId,
            groupId,
            senderId,
            reason: replyError instanceof Error ? replyError.message : String(replyError),
          });
        }
      }
    }
    return handled;
  }

  /** 顺序执行全部通知钩子；单个钩子抛错只记日志，不中断后续 */
  async runNoticeHooks(event: OneBotNoticeEvent, ctx: SnowLumaEventContext): Promise<void> {
    for (const hook of [...this.noticeHooks]) {
      const owner = this.hookPlugins.get(hook);
      if (owner && this.pluginEnabled.get(owner) === false) continue;
      try {
        await hook(event, ctx);
      } catch (err) {
        log.error('通知钩子出错', { module: 'src/skills/registry.ts', hook: 'notice-hook', reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** 当前全部 skill（工具清单） */
  getSkills(): Skill[] {
    return this.getEnabledSkills();
  }

  /** 当前全部命令 */
  getCommands(): Command[] {
    return this.getEnabledCommands();
  }

  /** 按名称查找 skill */
  findSkill(name: string): Skill | undefined {
    const skill = this.skills.find((s) => s.name === name);
    if (!skill || !this.isSkillEnabled(name) || !this.isPluginEnabled(this.skillPlugins.get(name) ?? '')) return undefined;
    return skill;
  }

  /** 按名称查找命令 */
  findCommand(name: string): Command | undefined {
    const command = this.commands.find((c) => c.name === name);
    if (!command || !this.isCommandEnabled(name) || !this.isPluginEnabled(this.commandPlugins.get(name) ?? '')) return undefined;
    return command;
  }
}

// --- 极简 JSON-Schema 参数校验（子集实现，不依赖外部库） ---

/** 属性字段 schema */
interface FieldSchema {
  type?: string;
  default?: unknown;
  enum?: unknown[];
}

/** 顶层 object schema（支持子集） */
interface ObjectSchema {
  type?: string;
  properties?: Record<string, FieldSchema>;
  required?: string[];
}

/** 校验单个字段类型，不匹配则抛错 */
function assertType(name: string, value: unknown, type: string | undefined): void {
  if (!type) return; // 未声明类型不拦截
  let ok: boolean;
  switch (type) {
    case 'string':
      ok = typeof value === 'string';
      break;
    case 'integer':
      ok = typeof value === 'number' && Number.isInteger(value);
      break;
    case 'number':
      ok = typeof value === 'number';
      break;
    case 'boolean':
      ok = typeof value === 'boolean';
      break;
    case 'array':
      ok = Array.isArray(value);
      break;
    case 'object':
      ok = typeof value === 'object' && value !== null && !Array.isArray(value);
      break;
    default:
      ok = true; // 未知类型放行
  }
  if (!ok) throw new Error(`参数 ${name} 类型应为 ${type}`);
}

/**
 * 按 inputSchema 校验并清洗参数：
 * - 必填缺失且无默认值 → 抛「缺少参数 xxx」
 * - 类型不匹配 → 抛「参数 xxx 类型应为 yyy」
 * - 缺失但有默认值 → 填默认值
 * - 未声明的字段直接忽略
 */
export function validateArgs(inputSchema: Record<string, unknown> | undefined, args: unknown): Record<string, unknown> {
  const schema = (inputSchema ?? {}) as ObjectSchema;
  const raw = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const result: Record<string, unknown> = {};

  // 必填校验：缺失且无默认值 → 抛错
  for (const name of required) {
    if (!(name in raw) && properties[name]?.default === undefined) {
      throw new Error(`缺少参数 ${name}`);
    }
  }

  // 已传入字段：校验枚举与类型；未声明的字段忽略
  for (const [name, value] of Object.entries(raw)) {
    const field = properties[name];
    if (field === undefined) continue;
    if (field.enum !== undefined && !field.enum.includes(value)) {
      throw new Error(`参数 ${name} 取值不在允许范围内`);
    }
    assertType(name, value, field.type);
    result[name] = value;
  }

  // 缺失但有默认值 → 填默认值
  for (const [name, field] of Object.entries(properties)) {
    if (!(name in result) && field.default !== undefined) {
      result[name] = field.default;
    }
  }

  return result;
}
