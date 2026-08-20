# AL1S-core Admin Frontend —— API 契约（实现依据）

> 供 `frontend/` Vue 工程实现时对照。后端由 bot 进程内嵌 AdminServer 提供，同源。

## 通用约定
- **Base**：同源。开发期 Vite 代理 `/api` → `http://127.0.0.1:6185`；生产由后端托管 dist。
- **鉴权**：所有 `/api/*` 需 `Authorization: Bearer <ADMIN_TOKEN>`。后端未配置 `ADMIN_TOKEN` 则不开服务；收到 401 时前端应跳登录页。
- **响应包裹**：`{ ok: boolean, data?: unknown, error?: string }`。`ok=false` 时读 `error` 展示。
- **登录**：后端不提供密码登录；登录页输入 `ADMIN_TOKEN`（用户自行填入环境变量里的值），前端存 `localStorage['admin_token']`，后续请求带上。用 `GET /api/status` 验证 token 有效性。

## 数据类型
```ts
type LogRecord = {
  time: string;          // "YYYY-MM-DD HH:mm:ss.mmm"
  level: 'debug' | 'info' | 'warn' | 'error';
  tag: string;           // 如 "pipeline" / "bot.registry"
  msg: string;
  fields?: Record<string, string>;
};

type ConfigGroup = {
  key: string;
  label: string;
  description?: string;
  fields: ConfigField[];
};
type ConfigField = {
  key: string;            // 点路径 或 env.XXX
  label: string;
  type: 'string' | 'password' | 'textarea' | 'number' | 'boolean' | 'string-list' | 'number-list';
  hint?: string;
  placeholder?: string;
  requiresRestart?: boolean;
  min?: number; max?: number; step?: number;
};

type PluginCommandItem = {
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
};
type PluginItem = {
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
  hasSettings: boolean;
  commands: PluginCommandItem[];
};

type SessionSummary = {
  chatId: string;          // "g:123" / "p:456"
  messageCount: number;
  lastActivity: number;    // epoch ms
  isGenerating: boolean;
  personaOverride?: string;
};
type SessionMessage = {
  role: 'user' | 'assistant';
  senderName?: string;
  text: string;
  atBot?: boolean;
  time: number;            // epoch 秒
};
```

## 接口清单

### `GET /api/status`
返回：
```ts
{
  connected: boolean;
  login?: { user_id: number; nickname: string };
  botNickname?: string;
  uptimeSeconds: number;
  sessionCount: number;
  metrics: { messagesReceived: number; messagesSent: number; toolCalls: number; errors: number };
  version: string;          // package version
  restartRequired?: boolean; // 存在未生效的"需重启"配置
}
```

### `GET /api/config`
返回 `{ values: Record<string, unknown> }` —— fieldKey → 当前生效值。数组类字段是数组（不是逗号字符串）。

### `PUT /api/config`
Body：`{ values: Record<string, unknown> }`（部分提交即可）。后端热应用 + 持久化到 `data/settings.json`。
返回 `{ applied: string[], pendingRestart: string[] }` —— 已即时生效 / 需重启的字段 key 列表。

### `GET /api/config/schema`
返回 `{ groups: ConfigGroup[] }`。

### `GET /api/plugins`
返回 `{ plugins: PluginItem[] }` —— 每个插件包含统一的 `commands` 数组；原有 Skill/命令均作为 command item 展示，含 aliases、参数 schema、执行方式和启停状态。

### `GET /api/plugins/:name/config`（URL 编码）
返回 `{ group: ConfigGroup | null, values: Record<string, unknown> }`。
- `group`：该插件声明的设置 schema（无设置项的插件为 `null`）；
- `values`：fieldKey（`env.*`）→ 当前生效值（`env.*` 读回为字符串）。

### `PUT /api/plugins/:name/config`
Body：`{ values: Record<string, unknown> }`（部分提交）。热应用 + 持久化（复用全局 settings.json 覆盖层）。
返回 `{ applied: string[], pendingRestart: string[] }`。无设置项的插件返回 400；未知插件返回 404。

### `PUT /api/plugins/enabled`
Body：`{ kind: 'plugin' | 'command' | 'skill', name: string, enabled: boolean }`。前端主路径使用 `plugin` 或 `command`；`skill` 仅为迁移兼容。`enabled` 必须是 boolean。

### `GET /api/sessions`
返回 `{ sessions: SessionSummary[] }`，按 lastActivity 降序。

### `GET /api/sessions/:chatId`（URL 编码）
返回 `{ chatId: string, messages: SessionMessage[] }`。

### `DELETE /api/sessions/:chatId`
清空该会话（等价 `/reset`）。返回 `{ ok: true }`。

### `GET /api/logs?level=&tag=&limit=`
返回 `{ logs: LogRecord[] }`（后端环形缓冲最近记录；level/tag 可选过滤）。

### `GET /api/logs/stream`（SSE）
`text/event-stream`。事件：
- `event: snapshot` —— `data: LogRecord[]`（连接时的历史缓冲，随后开始 live）
- `event: log` —— `data: LogRecord`（每条新日志）
支持 `Last-Event-ID`（值为某条日志 time，断线后从此继续）。

### `POST /api/system/restart`
干净退出进程（由外部 supervisor 拉起）。返回 `{ ok: true, message }` 后进程退出。

## 前端要求（Vuetify 3）
1. **登录**：token 输入 + 保存；验证后进入。
2. **仪表盘 / Dashboard**：状态卡（连接/登录名/在线时长/会话数）、指标卡（收/发/工具/错误）、最近日志流小窗（只读，级别色标）。
3. **设置 / Settings**：schema 驱动表单 —— 按 `groups` 渲染折叠分区卡片；每字段按 `type` 选控件（string→文本、password→密码、textarea→多行、number→数字、boolean→开关、string-list/number-list→多选 chips 输入）；**改动防抖 500ms 自动保存**（调 `PUT /api/config`），保存后提示 `applied`/`pendingRestart`；`requiresRestart` 字段加"重启后生效"徽标并禁用即时保存提示。配置变化即时反映（后端已热应用，保存后可重新 `GET /api/config` 对账）。插件分组（课程表/XXT）已不在全局 schema 里，各自进插件详情页。
4. **插件 / Plugins**：AstrBot 式**卡片网格**（图标/displayName/描述/hasSettings 徽标/命令与工具数），点击卡片进入 `#/plugins/:name` 详情页。
5. **插件详情 / PluginDetail**：返回箭头 + 插件名；有设置项则渲染设置表单（同 Settings 的 schema 驱动控件，调 `GET/PUT /api/plugins/:name/config`）；下方为该插件命令/工具开关表（乐观更新 + 失败回滚，调 `PUT /api/plugins/enabled`）。
6. **会话 / Sessions**：表格（chatId/消息数/最近活跃/生成中），点行打开日志抽屉（`GET /api/sessions/:id`），抽屉内"清空"按钮（`DELETE`）。
7. **日志 / Logs**：SSE 实时流（`EventSource`），级别过滤 chips、tag 过滤、暂停/继续、自动滚动开关、清空视图；断线自动重连（Last-Event-ID 续传）。后端会为**每条 WS 收到的聊天消息**记 `tag='receive'` 的 info 日志（`收到群消息`/`收到私聊消息`），可借此按 tag 过滤聊天记录。

## 工程约定
- 技术栈：Vue 3（`<script setup>`）+ Vite + TypeScript + Vuetify 3 + Pinia + vue-router（hash）+ vue-i18n。
- 目录建议：`frontend/src/{api,components,pages,stores,router,i18n,App.vue,main.ts}`；Vite 配置 `server.proxy` 将 `/api` 代理到 `http://127.0.0.1:6185`。
- 构建产物输出到 `frontend/dist`（后端将托管该目录）。
- `package.json` scripts：`dev` / `build` / `typecheck`（`vue-tsc --noEmit`）。
