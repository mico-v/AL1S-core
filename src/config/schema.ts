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
      { key: 'wsUrl', label: 'SnowLuma WS 地址', type: 'string', group: 'general', requiresRestart: true },
      { key: 'accessToken', label: 'OneBot accessToken', type: 'password', group: 'general', requiresRestart: true },
      { key: 'env.LOG_LEVEL', label: '日志级别', type: 'string', group: 'general', hint: 'debug|info|warn|error' },
      { key: 'env.LOG_FILE', label: '日志文件路径', type: 'string', group: 'general', hint: '留空=仅终端', requiresRestart: true },
      { key: 'env.LOG_MAX_SIZE_MB', label: '日志轮转阈值(MB)', type: 'number', group: 'general', min: 1, requiresRestart: true },
    ],
  },
  {
    key: 'llm',
    label: 'LLM',
    description: 'OpenAI 兼容接口',
    fields: [
      { key: 'llm.baseUrl', label: 'Base URL', type: 'string', group: 'llm', requiresRestart: true },
      { key: 'llm.apiKey', label: 'API Key', type: 'password', group: 'llm', requiresRestart: true },
      { key: 'llm.model', label: '模型', type: 'string', group: 'llm' },
      { key: 'llm.temperature', label: '温度', type: 'number', group: 'llm', min: 0, max: 2, step: 0.1 },
      { key: 'llm.maxTokens', label: '最大 tokens', type: 'number', group: 'llm', min: 1 },
    ],
  },
  {
    key: 'al1sFormat',
    label: 'AL1S 格式化',
    description: 'LLM 回复的 Markdown 清理与分段发送（可开关）',
    fields: [
      { key: 'al1sFormat.enabled', label: '启用格式化', type: 'boolean', group: 'al1sFormat', hint: '开启后 LLM 输出先清理 Markdown' },
      { key: 'al1sFormat.globalMarkdownKiller', label: '全局 Markdown 清理', type: 'boolean', group: 'al1sFormat', hint: '含命令文本回复' },
      { key: 'al1sFormat.lineSplit', label: '按结构分段发送', type: 'boolean', group: 'al1sFormat' },
      { key: 'al1sFormat.charsPerSecond', label: '分段字数/秒', type: 'number', group: 'al1sFormat', hint: '越小间隔越长', min: 1 },
      { key: 'al1sFormat.minDelay', label: '单段最小延时(秒)', type: 'number', group: 'al1sFormat', min: 0 },
      { key: 'al1sFormat.maxDelay', label: '单段最大延时(秒)', type: 'number', group: 'al1sFormat', min: 0 },
    ],
  },
  // 注意：课程表 / XXT 的设置项由各插件模块自己声明（skills/xxt、skills/courseSchedule），
  // 经下方 registerConfigFields 并入 CONFIG_FIELD_MAP，不进 CONFIG_GROUPS（全局"设置"页不显示插件分组）。
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
