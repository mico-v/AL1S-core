/**
 * 配置：从环境变量解析 BotConfig。
 * 所有数字均为可选，非数字或负数时回退内置默认值。
 */
/** AL1S 格式化功能配置（加在 LLM 回复管线上的可开关格式化层） */
export interface Al1sFormatConfig {
  enabled: boolean; // 总开关
  globalMarkdownKiller: boolean; // 对所有最终文本清理 Markdown
  lineSplit: boolean; // 按空行/结构分段发送
  charsPerSecond: number; // 分段发送的字数/秒，越小间隔越长
  minDelay: number; // 单段最小延时（秒）
  maxDelay: number; // 单段最大延时（秒）
}

export interface BotConfig {
  wsUrl: string;
  accessToken?: string;
  llm: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };
  persona: string;
  triggerKeywords: string[];
  replyCooldownSeconds: number;
  contextTokenBudget: number;
  maxToolIterations: number;
  enabledGroups: number[]; // 空数组 = 全部群
  maxSessions: number;
  adminIds: number[]; // 管理员 QQ 号（BOT_ADMINS），空数组 = 不限制
  al1sFormat: Al1sFormatConfig;
}

/** 默认人设 */
const DEFAULT_PERSONA = '你是一个活泼幽默的群聊 AI 机器人，说话简洁自然，用中文。';

/** 解析数字环境变量：缺失 / 空串 / NaN / 负数时回退默认 */
function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n) || n < 0) return fallback;
  return n;
}

/** 解析逗号分隔的字符串数组，过滤空白项 */
function strList(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key];
  if (raw === undefined || raw === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 解析逗号分隔的群号数组，过滤非法数字 */
function numList(env: NodeJS.ProcessEnv, key: string): number[] {
  return strList(env, key)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

/** 解析布尔环境变量：'true'/'1'/'on'/'yes' 视为真，其余（含缺失）为假 */
function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on' || v === 'yes';
}

/** 从环境变量加载配置（默认读 process.env） */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  return {
    wsUrl: env.SNOWLUMA_WS_URL ?? 'ws://127.0.0.1:3001/',
    accessToken: env.SNOWLUMA_TOKEN || undefined,
    llm: {
      baseUrl: env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
      apiKey: env.LLM_API_KEY || undefined,
      model: env.LLM_MODEL ?? 'deepseek-chat',
      temperature: num(env, 'LLM_TEMPERATURE', 0.7),
      maxTokens: num(env, 'LLM_MAX_TOKENS', 1024),
    },
    persona: env.BOT_PERSONA || DEFAULT_PERSONA,
    triggerKeywords: strList(env, 'TRIGGER_KEYWORDS'),
    replyCooldownSeconds: num(env, 'REPLY_COOLDOWN_SECONDS', 3),
    contextTokenBudget: num(env, 'CONTEXT_TOKEN_BUDGET', 3000),
    maxToolIterations: num(env, 'MAX_TOOL_ITERATIONS', 5),
    enabledGroups: numList(env, 'ENABLED_GROUPS'),
    maxSessions: num(env, 'MAX_SESSIONS', 200),
    adminIds: numList(env, 'BOT_ADMINS'),
    al1sFormat: {
      enabled: bool(env, 'AL1S_FORMAT_ENABLED', false),
      globalMarkdownKiller: bool(env, 'AL1S_GLOBAL_MARKDOWN_KILLER', false),
      lineSplit: bool(env, 'AL1S_LLM_LINE_SPLIT', false),
      charsPerSecond: num(env, 'AL1S_SPLIT_CHARS_PER_SECOND', 80),
      minDelay: num(env, 'AL1S_SPLIT_MIN_SECONDS', 0.5),
      maxDelay: num(env, 'AL1S_SPLIT_MAX_SECONDS', 3.0),
    },
  };
}
