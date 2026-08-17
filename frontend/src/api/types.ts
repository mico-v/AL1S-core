// API 契约数据类型 —— 严格对照 frontend/API.md

/** 统一响应包裹：ok=false 时读 error 展示 */
export interface ApiResponse<T> {
  ok: boolean
  data?: T
  error?: string
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  time: string // "YYYY-MM-DD HH:mm:ss.mmm"
  level: LogLevel
  tag: string // 如 "pipeline" / "bot.registry"
  msg: string
  fields?: Record<string, string>
}

export interface StatusMetrics {
  messagesReceived: number
  messagesSent: number
  toolCalls: number
  errors: number
}

export interface StatusData {
  connected: boolean
  login?: { user_id: number; nickname: string }
  botNickname?: string
  uptimeSeconds: number
  sessionCount: number
  metrics: StatusMetrics
  version: string // package version
  restartRequired?: boolean // 存在未生效的"需重启"配置
}

export type ConfigFieldType =
  | 'string'
  | 'password'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'string-list'
  | 'number-list'

export interface ConfigField {
  key: string // 点路径 或 env.XXX
  label: string
  type: ConfigFieldType
  hint?: string
  placeholder?: string
  requiresRestart?: boolean
  min?: number
  max?: number
  step?: number
}

export interface ConfigGroup {
  key: string
  label: string
  description?: string
  fields: ConfigField[]
}

export interface CommandItem {
  name: string
  description: string
  enabled: boolean
}

export interface SkillItem {
  name: string
  description: string
  enabled: boolean
}

export interface PluginItem {
  name: string // 插件标识（如 xxt / course-schedule）
  displayName: string // 中文显示名（侧栏/卡片/页头）
  description: string
  hasSettings: boolean // 是否声明了设置项
  commands: CommandItem[] // 该插件注册的命令（含启停）
  skills: SkillItem[] // 该插件注册的工具（含启停）
}

export interface SessionSummary {
  chatId: string // "g:123" / "p:456"
  messageCount: number
  lastActivity: number // epoch ms
  isGenerating: boolean
  personaOverride?: string
}

export interface SessionMessage {
  role: 'user' | 'assistant'
  senderName?: string
  text: string
  atBot?: boolean
  time: number // epoch 秒
}

export interface ConfigValues {
  values: Record<string, unknown>
}

export interface ConfigSchema {
  groups: ConfigGroup[]
}

export interface PluginsData {
  plugins: PluginItem[]
}

export interface PluginConfig {
  group: ConfigGroup | null // 无设置项的插件为 null
  values: Record<string, unknown> // fieldKey（env.*）→ 当前生效值
}

export interface ConfigSaveResult {
  applied: string[] // 已即时生效的字段 key
  pendingRestart: string[] // 需重启的字段 key
}

export interface SessionsData {
  sessions: SessionSummary[]
}

export interface SessionDetail {
  chatId: string
  messages: SessionMessage[]
}

export interface LogsData {
  logs: LogRecord[]
}
