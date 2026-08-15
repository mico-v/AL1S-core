/**
 * skill 注册中心：管理两类扩展——
 * - 工具 skill：供 LLM function calling 调用（模型自动触发）
 * - 斜杠命令：供群成员显式触发（/help、/reset 等）
 * 插件（Plugin）是 skill + 命令的打包单元，经 register 挂载到注册中心。
 */
import type { SessionManager } from '../session/manager';
import type { BotConfig } from '../config';

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

/** 命令上下文：命令可访问回复通道、会话管理与配置 */
export interface CommandContext {
  chatId: string;
  rest: string;
  reply(text: string): Promise<void>;
  sessions: SessionManager;
  config: BotConfig;
}

/** 斜杠命令 */
export interface Command {
  name: string;
  description: string;
  handler(ctx: CommandContext): Promise<void>;
}

/** 插件：一组 skill 与命令的打包单元，注册入口 */
export interface Plugin {
  name: string;
  description: string;
  register(registry: SkillRegistry): void;
}

/** skill 注册中心 */
export class SkillRegistry {
  private skills: Skill[] = [];
  private commands: Command[] = [];

  /** 注册一个工具 skill */
  registerSkill(skill: Skill): void {
    this.skills.push(skill);
  }

  /** 注册一个斜杠命令 */
  registerCommand(command: Command): void {
    this.commands.push(command);
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
