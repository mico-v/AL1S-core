# CLAUDE.md

本文件为在此仓库工作的 AI 助手提供项目约定。

## 项目定位

这是一个基于 **QQ 开放平台官方协议** 的 TypeScript / ESM 项目，通过
`@tencent-connect/qqbot-nodejs` 接入 QQ。仓库同时包含独立机器人入口和
QQ/Tuwunel Matrix Application Service bridge。

当前主线是完善 QQ/Matrix 消息语义与生产运行：QQ ghost 映射、提及、引用、
媒体、双向路由、持久化与运维。项目已从旧的 OneBot / SnowLuma + MSP
沙箱架构**推倒重做**，不要再引入插件注册表、命令 broker、会话沙箱、
管理后台等旧设计。

两个入口是：

```text
src/index.ts         → loadConfig() → new Bot(config) → bot.start()
src/matrix-bridge.ts → loadConfig() → QqMatrixBridge + appservice HTTP 服务
```

代码与用户可见文本以中文为主，新注释和消息保持中文。

## 常用命令

根目录执行（使用 pnpm）：

```bash
pnpm install
cp .env.example .env
pnpm qq:login           # 扫码绑定机器人，自动把 AppID / AppSecret 写入 .env
pnpm dev                # tsx watch，加载 .env
pnpm start              # 正常运行
pnpm bridge             # 启动 QQ/Tuwunel bridge
pnpm bridge:dev         # bridge watch 模式
pnpm typecheck          # TypeScript 检查
pnpm build              # 编译到 dist/
pnpm qq:check           # 离线协议自检：配置 / 日志 / Ed25519 / 事件解码 / Bot 组装
pnpm matrix:check       # Matrix bridge 离线检查
pnpm matrix:admin       # Matrix 房间成员状态、邀请与踢出 CLI
pnpm tuwunel:check      # 本机 Tuwunel 双向集成检查
pnpm webhook:check      # 本地起 webhook 服务，端到端验证收消息
pnpm integration:check  # typecheck + build + qq:check + matrix:check + webhook:check
pnpm ci:check           # 与 GitHub Actions 相同的完整门禁
pnpm deploy:check       # 生产 registration / .env / 权限预检
pnpm deploy:server      # 本地构建运行包并同步到服务器重启服务
```

`qq:check` 不联网、不需要凭据，改协议相关代码后必须运行。
不要用 plain `node` 直接跑 `.ts` 源码，统一用 `tsx`（脚本已在 package.json 中）。

日志默认落盘到 `logs/bot.log`（已 gitignore），按 `LOG_MAX_SIZE_MB` 轮转、
`LOG_MAX_FILES` 控制保留数量；`LOG_FILE=off` 可关闭落盘。
改日志逻辑时在 `qq-check.ts` 补充落盘 / 轮转 / 脱敏断言。

聊天记录默认写入 `data/chats/<scope>/<target>/`（已 gitignore）：`messages.jsonl`
每行一条完整消息，媒体存到同目录 `media/`。`CHAT_LOG_ENABLED=false` 可关闭。
同一 `messageId` 去重；媒体异步下载、不阻塞回复；超 `CHAT_MEDIA_MAX_MB` 跳过并
写 `download-errors.log`。改这块时在 `qq-check.ts` 的「聊天记录落盘」段补充断言。
注意 `data/` 是运行时目录，不要在 `src/` 里硬编码路径，统一走 `config.chatLog.root`。

## 高层架构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 入口：装配 Bot、注册事件、信号处理 |
| `src/config.ts` | 只从环境变量读取配置；校验必填项；不实现协议 |
| `src/logger.ts` | 分级日志：控制台 + 自动落盘（按大小轮转）、密钥脱敏、Error 展开 |
| `src/bot.ts` | 连接器薄封装：`start`/`stop`、事件分发、聊天记录落盘、回复转发 |
| `src/chat-log.ts` | 聊天记录持久化：按目标分目录 JSONL + 媒体异步下载 |
| `src/matrix-bridge.ts` | QQ/Tuwunel bridge 生产入口与生命周期 |
| `src/matrix/client.ts` | Matrix Client-Server API、媒体上传与下载 |
| `src/matrix/appservice.ts` | Appservice transaction HTTP 服务与鉴权 |
| `src/bridge/bridge.ts` | 双向消息转换、路由、提及/引用/媒体与回放 |
| `src/bridge/store.ts` | schema v8 加密状态、引用、入站队列、媒体与 QQ ghost 反向映射 |
| `src/matrix/admin.ts` | 房间成员状态、邀请与踢出的管理逻辑 |
| `src/scripts/qq-login.ts` | 扫码换取 AppID / AppSecret 并写入 `.env` |
| `src/scripts/qq-check.ts` | 离线自检 |
| `src/scripts/matrix-check.ts` | 不依赖 QQ/Tuwunel 的 bridge 离线自检 |
| `src/scripts/matrix-admin.ts` | Matrix 房间成员管理 CLI |
| `src/scripts/tuwunel-check.ts` | 本机 Tuwunel 双向集成检查 |
| `src/scripts/deploy-check.ts` | 生产部署配置预检 |
| `src/scripts/webhook-check.ts` | 本地 webhook 端到端自检 |

### 两个官方包的职责

- `@tencent-connect/qqbot-connector`：**只负责扫码换取凭据**（向 `q.qq.com`
  的 `create_bind_task` / `poll_bind_result` 发 HTTPS 轮询，本地 AES-256-GCM 解密
  secret）。它**不接收消息**，也不要把它当成消息通道。
- `@tencent-connect/qqbot-nodejs`：协议层，负责连接、收消息、发消息。

不要把扫码逻辑放进 `src/bot.ts`；它只是获取凭据的一次性工具脚本。

事件流：

```text
QQ 平台
  → 连接器（WebSocket 网关或 Webhook）
  → 鉴权 / 心跳 / RESUME / 验签
  → 归一化事件（message / interaction / rawEvent）
  → Bot.dispatch*
  → 已注册的处理器
  → bot.replyText / replyMarkdown / send / sendMedia
```

### 协议细节归属连接器

以下能力**已由 `@tencent-connect/qqbot-nodejs` 实现，不要重复造轮子**：

- Access Token 获取、缓存与自动刷新；
- WebSocket 连接、心跳、`RESUME`、重连、分片；
- Webhook 模式的 Ed25519 验签与 `op=13` 回调验证回包；
- 文本 / Markdown / Ark / Embed / 富媒体 / 流式消息发送；
- 限流、重试与结构化 `ApiError`。

`src/bot.ts` 只应做转发与错误隔离。新增能力时优先看连接器是否已提供，
再从 `@tencent-connect/qqbot-nodejs` 或 `/protocol` 子导出引入。

### QQ/Tuwunel bridge 约定

- 修改 bridge 前先阅读 `docs/qq-matrix-bridge/PLAN.md`、`STATUS.md` 和
  `DEPLOYMENT.md`；代码行为变化必须同步三者中受影响的部分。
- QQ `<@OPENID>` 必须转成可读 `body`、Matrix HTML、`m.mentions` 和稳定的
  ghost 用户，不得把原始 openid 或 `<@...>` 直接暴露给 Matrix。
- Matrix `m.mentions.user_ids` 只对已持久化的 QQ ghost 反向映射生成
  `<qqbot-at-user id="..." />`；原生 Matrix 用户保持普通文本。
- 含高置信度 Markdown 语法的 Matrix 正文只有在
  `QQBOT_MARKDOWN_SUPPORT=true` 时使用 `msg_type=2`，普通正文保持
  `msg_type=0`，引用消息必须同时保留 `message_reference`。
- 引用索引要兼容 `refMsgIdx`、原始 snake_case 字段、`message_scene.ext` 和
  嵌套 `msg_elements`。`TMP_*` 只能在房间、发送者与摘录唯一匹配时回退。
- 媒体按 SHA-256 内容寻址；相同字节必须复用本地文件和 Matrix `mxc://`，
  并合并同哈希并发上传。修改时在 `matrix-check.ts` 增加重复内容断言。
- 状态文件当前为 schema v8，必须保留 v2-v7 迁移；敏感字段加密、索引
  使用 HMAC。不要直接改状态 JSON，也不要提交 `data/`、`.env` 或 registration。

### 事件处理器约定

`Bot.onMessage` / `onInteraction` / `onRawEvent` 按注册顺序串行执行，
单个处理器抛错会被捕获并记录，不影响后续处理器。
`onInteraction` 中若要响应按钮，必须调用 `bot.acknowledgeInteraction`，
否则客户端一直 loading。

## 配置与接入陷阱

- `QQBOT_APP_ID` / `QQBOT_APP_SECRET` 必填，缺失时启动即抛 `ConfigError`。
- `QQBOT_TRANSPORT=websocket`（默认）：机器人主动连网关，适合本地 / 无公网。
- `QQBOT_TRANSPORT=webhook`：需要公网 HTTPS，端口只能是 80 / 443 / 8080 / 8443；
  保存回调配置时平台会立即发 `op=13` 验证请求，服务必须已在线。
- Intents 决定能收到哪些事件。默认覆盖群 + 单聊（`1<<25`）与互动（`1<<26`）；
  群成员、入群申请等需要 `GROUP_MEMBER_EVENT`（`1<<24`），按需用 `QQBOT_INTENTS` 覆盖。
- 被动回复有次数与时效限制（群消息 5 分钟内最多 5 次，单聊 60 分钟内最多 4 次），
  超过后需要转为主动消息。
- 不要把 AppSecret 写入日志；`logger.ts` 会对 `secret`/`token` 类字段脱敏。

## 官方文档快照

`docs/qq-api/` 是 QQ 开放平台 API v2 的离线文档快照，包含：

- `autogen/event/`：各事件结构与示例；
- `autogen/api/`：各 REST 接口；
- `dev-prepare/`：opcode、payload、WebSocket / Webhook 接入与签名；
- `server-inter/message/`：消息类型、富媒体、文本交互；
- `openapi/`、`gateway/`：网关与错误码。

改协议相关逻辑前，先在该目录检索对应文档，不要凭记忆猜测字段。
`INDEX.md` 是完整索引。

## 检查分层

- 只改 QQ 机器人普通逻辑：`pnpm typecheck` + `pnpm qq:check`。
- 改 bridge、Matrix 转换或状态：补 `matrix-check.ts` 断言并运行
  `pnpm matrix:check`；涉及真实 homeserver 行为时再运行 `pnpm tuwunel:check`。
- 改配置解析：在 `qq-check.ts` 补充对应断言。
- 改协议相关行为（事件解码、验签、发送）：同样补充离线断言，避免依赖真实网络。
- 需要真实凭据的联调（实际收发消息）不属于离线检查，需在配置了 `.env` 后 `pnpm dev` 手动验证，
  不能宣称已在 CI 中验证。
- 提交前至少运行 `pnpm integration:check` 和 `git diff --check`；协议或部署改动
  还应运行 `pnpm tuwunel:check`。

## TypeScript 约束

`tsconfig.json` 开启严格检查：

- `verbatimModuleSyntax`：类型导入必须用 `import type` 或 `import { type X }`；
- `erasableSyntaxOnly`：禁止 `enum`、`namespace`、构造器参数属性；
- `noUncheckedIndexedAccess`：数组 / 对象索引结果可能为 `undefined`，必须显式处理；
- `moduleResolution: bundler`：支持包 `exports` 子路径（如 `/protocol`）。

## 规则文件

`AGENTS.md` 是通用贡献指南；本文件补充 AI 助手的仓库约定。
`package.json`、`tsconfig.json`、`docs/qq-matrix-bridge/` 是项目操作依据，
`docs/qq-api/` 是只读的 QQ 官方协议快照；不要修改上游快照来记录本项目进度。
