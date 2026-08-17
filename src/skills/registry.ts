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
import { logger } from '../logging/logger';

const log = logger.child('registry');

/** 后台消息/通知钩子的返回类型（同步或异步均可） */
export type MaybePromise<T = void> = T | Promise<T>;

/** 工具执行上下文：本次调用对应的会话与消息来源 */
export interface SkillRunContext {
  chatId: string;
  senderId?: number;
  senderName: string;
}

/** 工具 skill：模型通过 function calling 调用，返回文本结果 */
export interface Skill {
  name: string;
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
  reply(text: string): Promise<void>; // 纯文本回复
  send(message: OutgoingMessage): Promise<unknown>; // 富文本/图片/at 等消息段回复
  api: SnowLumaApiClient; // 任意 OneBot action（发图、上传群文件、拉成员列表等）
  sessions: SessionManager;
  config: BotConfig;
}

/** 后台消息钩子：每条群/私聊消息都触发（含命令与未触发消息） */
export type MessageHook = (event: OneBotMessageEvent, ctx: SnowLumaEventContext) => MaybePromise<void>;

/** 后台通知钩子：每条 OneBot notice（如 group_recall 撤回）都触发 */
export type NoticeHook = (event: OneBotNoticeEvent, ctx: SnowLumaEventContext) => MaybePromise<void>;

/** 斜杠命令 */
export interface Command {
  name: string;
  description: string;
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
}

/** skill 注册中心 */
export class SkillRegistry {
  private skills: Skill[] = [];
  private commands: Command[] = [];
  private commandEnabled = new Map<string, boolean>();
  private skillEnabled = new Map<string, boolean>();
  private api?: SnowLumaApiClient;
  private messageHooks: MessageHook[] = [];
  private noticeHooks: NoticeHook[] = [];
  // 插件元数据 + 命令/skill 归属（管理后台按插件分组展示用）
  private pluginMetas: PluginMeta[] = [];
  private currentPluginName: string | undefined;
  private commandPlugins = new Map<string, string>();
  private skillPlugins = new Map<string, string>();

  /** 注册插件元数据并执行插件注册；期间 registerCommand/registerSkill 自动归属该插件 */
  registerPlugin(plugin: Plugin): void {
    this.pluginMetas.push({
      name: plugin.name,
      displayName: plugin.displayName ?? plugin.name,
      description: plugin.description,
      settings: plugin.settings,
    });
    const prev = this.currentPluginName;
    this.currentPluginName = plugin.name;
    try {
      plugin.register(this);
    } finally {
      this.currentPluginName = prev;
    }
  }

  /** 全部插件元数据（注册顺序） */
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

  /** 注册一个工具 skill（默认启用；保留已持久化的禁用状态） */
  registerSkill(skill: Skill): void {
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

  /** 运行时启停某个命令/skill（热生效：注册表常驻 + 分发过滤） */
  setEnabled(kind: 'command' | 'skill', name: string, enabled: boolean): boolean {
    const exists = kind === 'command' ? this.commands.some((c) => c.name === name) : this.skills.some((s) => s.name === name);
    if (!exists) return false;
    const map = kind === 'command' ? this.commandEnabled : this.skillEnabled;
    map.set(name, enabled);
    return true;
  }

  isCommandEnabled(name: string): boolean {
    return this.commandEnabled.get(name) ?? true;
  }

  isSkillEnabled(name: string): boolean {
    return this.skillEnabled.get(name) ?? true;
  }

  /** 启用的命令（/help、命令分发用） */
  getEnabledCommands(): Command[] {
    return this.commands.filter((c) => this.isCommandEnabled(c.name));
  }

  /** 启用的工具（agent 工具列表用） */
  getEnabledSkills(): Skill[] {
    return this.skills.filter((s) => this.isSkillEnabled(s.name));
  }

  /** 序列化启停状态（供持久化） */
  serializeEnabled(): { commands: Record<string, boolean>; skills: Record<string, boolean> } {
    const commands: Record<string, boolean> = {};
    const skills: Record<string, boolean> = {};
    for (const c of this.commands) commands[c.name] = this.isCommandEnabled(c.name);
    for (const s of this.skills) skills[s.name] = this.isSkillEnabled(s.name);
    return { commands, skills };
  }

  /** 从持久化恢复启停状态 */
  restoreEnabled(data: { commands?: Record<string, boolean>; skills?: Record<string, boolean> } | null | undefined): void {
    if (data?.commands) {
      for (const [name, enabled] of Object.entries(data.commands)) this.commandEnabled.set(name, enabled);
    }
    if (data?.skills) {
      for (const [name, enabled] of Object.entries(data.skills)) this.skillEnabled.set(name, enabled);
    }
  }

  /** 注入 OneBot api 通道（bot.ts 在 start 时调用），后台钩子/定时器据此取 api */
  setApi(client: SnowLumaApiClient): void {
    this.api = client;
  }

  /** 取 OneBot api 通道（未注入时为 undefined） */
  getApi(): SnowLumaApiClient | undefined {
    return this.api;
  }

  /** 注册后台消息钩子（每条消息触发一次） */
  addMessageHook(hook: MessageHook): void {
    this.messageHooks.push(hook);
  }

  /** 注册后台通知钩子（每条 notice 触发一次） */
  addNoticeHook(hook: NoticeHook): void {
    this.noticeHooks.push(hook);
  }

  /** 顺序执行全部消息钩子；单个钩子抛错只记日志，不中断后续 */
  async runMessageHooks(event: OneBotMessageEvent, ctx: SnowLumaEventContext): Promise<void> {
    for (const hook of [...this.messageHooks]) {
      try {
        await hook(event, ctx);
      } catch (err) {
        log.error('消息钩子出错', { err: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** 顺序执行全部通知钩子；单个钩子抛错只记日志，不中断后续 */
  async runNoticeHooks(event: OneBotNoticeEvent, ctx: SnowLumaEventContext): Promise<void> {
    for (const hook of [...this.noticeHooks]) {
      try {
        await hook(event, ctx);
      } catch (err) {
        log.error('通知钩子出错', { err: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** 当前全部 skill（工具清单） */
  getSkills(): Skill[] {
    return this.skills;
  }

  /** 当前全部命令 */
  getCommands(): Command[] {
    return this.commands;
  }

  /** 按名称查找 skill */
  findSkill(name: string): Skill | undefined {
    return this.skills.find((s) => s.name === name);
  }

  /** 按名称查找命令 */
  findCommand(name: string): Command | undefined {
    return this.commands.find((c) => c.name === name);
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
