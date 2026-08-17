/**
 * 配置元数据（仿 AstrBot CONFIG_METADATA）：声明每个设置项的
 * 键/标签/类型/分组/提示/是否需重启，前端据此生成 schema 驱动表单。
 *
 * 键约定：
 * - 点路径（如 `llm.model`、`al1sFormat.enabled`）→ 访问运行时 BotConfig（热生效）
 * - `env.XXX`（如 `env.XXT_CLASS_PERIODS`）→ 访问环境变量（插件配置，持久化到 settings.json 覆盖层）
 */

/** 字段类型（前端据此选择控件） */
export type ConfigFieldType =
  | 'string'
  | 'password'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'string-list'
  | 'number-list';

export interface ConfigFieldMeta {
  key: string;
  label: string;
  type: ConfigFieldType;
  group: string;
  hint?: string;
  placeholder?: string;
  requiresRestart?: boolean; // true → 前端显示"重启后生效"徽标
  applyMode?: 'live' | 'rebuild' | 'restart';
  min?: number;
  max?: number;
  step?: number;
}

export interface ConfigGroupMeta {
  key: string;
  label: string;
  description?: string;
  fields: ConfigFieldMeta[];
}

export const CONFIG_GROUPS: ConfigGroupMeta[] = [
  {
    key: 'general',
    label: '通用',
    description: '人设、触发、冷却与资源限制',
    fields: [
      { key: 'persona', label: '系统人设', type: 'textarea', group: 'general', hint: '影响所有新回复；改后即时生效' },
      { key: 'triggerKeywords', label: '触发关键词', type: 'string-list', group: 'general', hint: '逗号分隔；@ 机器人恒触发' },
      { key: 'replyCooldownSeconds', label: '冷却秒数', type: 'number', group: 'general', hint: '机器人回复后该时长内的触发不重复回复', min: 0 },
      { key: 'contextTokenBudget', label: '上下文 token 预算', type: 'number', group: 'general', min: 0 },
      { key: 'maxToolIterations', label: '工具调用轮数上限', type: 'number', group: 'general', min: 1 },
      { key: 'enabledGroups', label: '群白名单', type: 'number-list', group: 'general', hint: '逗号分隔群号；留空 = 全部群' },
      { key: 'maxSessions', label: '会话数上限（LRU）', type: 'number', group: 'general', min: 1 },
      { key: 'adminIds', label: '管理员 QQ', type: 'number-list', group: 'general', hint: '逗号分隔；留空 = 不限制' },
      { key: 'wsUrl', label: 'SnowLuma WS 地址', type: 'string', group: 'general', applyMode: 'rebuild' },
      { key: 'httpUrl', label: 'SnowLuma HTTP 地址', type: 'string', group: 'general', applyMode: 'rebuild' },
      { key: 'accessToken', label: 'OneBot accessToken', type: 'password', group: 'general', applyMode: 'rebuild' },
      { key: 'env.LOG_LEVEL', label: '日志级别', type: 'string', group: 'general', applyMode: 'live', hint: 'debug|info|warn|error' },
      { key: 'env.LOG_FILE', label: '日志文件路径', type: 'string', group: 'general', applyMode: 'rebuild', hint: '留空=仅终端' },
      { key: 'env.LOG_MAX_SIZE_MB', label: '日志轮转阈值(MB)', type: 'number', group: 'general', applyMode: 'live', min: 1 },
    ],
  },
  {
    key: 'llm',
    label: 'LLM',
    description: 'OpenAI 兼容接口',
    fields: [
      { key: 'llm.baseUrl', label: 'Base URL', type: 'string', group: 'llm', applyMode: 'live' },
      { key: 'llm.apiKey', label: 'API Key', type: 'password', group: 'llm', applyMode: 'live' },
      { key: 'llm.model', label: '模型', type: 'string', group: 'llm', applyMode: 'live' },
      // OpenAI 兼容接口通常由 provider/model 决定采样策略，不再展示温度设置。
      { key: 'llm.maxTokens', label: '最大输出 tokens', type: 'number', group: 'llm', min: 1 },
    ],
  },
  // 课程表 / XXT / Shell 的设置由各自插件声明并显示在插件详情页。
];

/** 字段索引：key → 元数据 */
export const CONFIG_FIELD_MAP: Record<string, ConfigFieldMeta> = {};
for (const group of CONFIG_GROUPS) {
  for (const field of group.fields) CONFIG_FIELD_MAP[field.key] = field;
}

/** 分组索引 */
export const CONFIG_GROUP_MAP: Record<string, ConfigGroupMeta> = {};
for (const group of CONFIG_GROUPS) CONFIG_GROUP_MAP[group.key] = group;

/**
 * 插件声明设置：把插件配置项注册进全局字段索引。
 * - 只并入 CONFIG_FIELD_MAP / CONFIG_GROUP_MAP，不进 CONFIG_GROUPS——全局"设置"页
 *   （渲染 CONFIG_GROUPS）不显示插件分组，插件设置由各自详情页展示。
 * - 必须在 ConfigStore 构造前调用：插件模块在模块顶层调用，bot.ts 的静态 import 链
 *   （bot → plugins.ts → 各插件模块）保证求值顺序先于 new ConfigStore()。
 * - 幂等：同一 group key 重复注册时仅补缺，不覆盖已有字段。
 */
export function registerConfigFields(group: ConfigGroupMeta): void {
  if (CONFIG_GROUP_MAP[group.key]) {
    for (const field of group.fields) CONFIG_FIELD_MAP[field.key] ??= field;
    return;
  }
  CONFIG_GROUP_MAP[group.key] = group;
  for (const field of group.fields) CONFIG_FIELD_MAP[field.key] = field;
}

/** 判断字段是否访问环境变量 */
export function isEnvField(key: string): boolean {
  return key.startsWith('env.');
}

/** 判断字段是否需要重启生效 */
export function fieldRequiresRestart(key: string): boolean {
  return Boolean(CONFIG_FIELD_MAP[key]?.requiresRestart);
}
