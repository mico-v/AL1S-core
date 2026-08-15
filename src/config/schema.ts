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
  {
    key: 'course',
    label: '课程表插件',
    description: '数据文件、群文件目录与字体',
    fields: [
      { key: 'env.COURSE_DATA_FILE', label: '数据文件路径', type: 'string', group: 'course', requiresRestart: true },
      { key: 'env.COURSE_ICS_FOLDER', label: '群文件课表目录', type: 'string', group: 'course', requiresRestart: true },
      { key: 'env.COURSE_FONT_PATH', label: '中文字体路径', type: 'string', group: 'course', hint: '留空则自动查找' },
    ],
  },
  {
    key: 'xxt',
    label: 'XXT 课堂提醒',
    description: '上课时段与提醒参数',
    fields: [
      { key: 'env.XXT_CLASS_PERIODS', label: '上课时段', type: 'string', group: 'xxt', hint: '逗号分隔："08:30-10:00:课程名"' },
      { key: 'env.XXT_CLASS_WARNING_COOLDOWN_SECONDS', label: '发言提醒冷却(秒)', type: 'number', group: 'xxt', min: 0 },
      { key: 'env.XXT_CLASS_REPLY_TIMEOUT_SECONDS', label: '@ 未回复超时(秒)', type: 'number', group: 'xxt', min: 0 },
    ],
  },
];

/** 字段索引：key → 元数据 */
export const CONFIG_FIELD_MAP: Record<string, ConfigFieldMeta> = {};
for (const group of CONFIG_GROUPS) {
  for (const field of group.fields) CONFIG_FIELD_MAP[field.key] = field;
}

/** 分组索引 */
export const CONFIG_GROUP_MAP: Record<string, ConfigGroupMeta> = {};
for (const group of CONFIG_GROUPS) CONFIG_GROUP_MAP[group.key] = group;

/** 判断字段是否访问环境变量 */
export function isEnvField(key: string): boolean {
  return key.startsWith('env.');
}

/** 判断字段是否需要重启生效 */
export function fieldRequiresRestart(key: string): boolean {
  return Boolean(CONFIG_FIELD_MAP[key]?.requiresRestart);
}
