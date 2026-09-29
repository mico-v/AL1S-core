# AL1S-core

基于 [QQ 开放平台](https://bot.q.qq.com/wiki/develop/api-v2/) 官方协议的 QQ 机器人框架
（TypeScript / ESM）。使用两个官方包：

- [`@tencent-connect/qqbot-connector`](https://www.npmjs.com/package/@tencent-connect/qqbot-connector)：
  扫码绑定机器人，换取 `AppID` / `AppSecret`（**只拿凭据，不收消息**）；
- [`@tencent-connect/qqbot-nodejs`](https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs)：
  协议层，负责连接与收发消息。

仓库包含 QQ 官方协议框架，以及可选的 QQ/Tuwunel Matrix Application
Service bridge。bridge 以 ghost 用户呈现 QQ 用户，并由 QQ 机器人代理
Matrix 出站消息；不包含 OneBot、LLM、插件和沙箱等上层设计。
`@tencent-connect/qqbot-nodejs` 固定为 `1.0.4`，并通过
`pnpm-workspace.yaml` 加载本地 patch；该 patch 为 guild/DM 文本与撤回补充
channel/DM 路由。升级 SDK 时必须同步审查或重做 patch。

## 架构

```text
src/index.ts      入口：加载配置 → 创建 Bot → 注册事件 → start
src/config.ts     环境变量解析与校验
src/logger.ts     分级日志（兼容连接器 Logger 接口，密钥脱敏）
src/bot.ts        对协议层的薄封装：生命周期 / 事件分发 / 回复转发
src/matrix-bridge.ts  QQ / Tuwunel bridge 独立入口
src/matrix/        Matrix CS API、appservice transaction 服务与指标
src/matrix/admin.ts  房间成员状态、邀请与踢出的管理逻辑
src/bridge/        双向路由、媒体转换与加密持久化
src/deploy/        部署前 registration / .env 一致性校验
src/scripts/qq-login.ts   扫码获取凭据并写入 .env
src/scripts/qq-check.ts   离线协议自检
src/scripts/matrix-check.ts  Matrix bridge 离线自检
src/scripts/matrix-admin.ts  Matrix 房间成员管理 CLI
src/scripts/tuwunel-check.ts  临时 Tuwunel 双向集成检查
src/scripts/deploy-check.ts   生产部署前配置检查
src/scripts/webhook-check.ts  webhook 端到端自检
```

协议细节由 `qqbot-nodejs` 负责：

- Access Token 获取与自动刷新；
- WebSocket 网关连接、心跳、`RESUME`、重连、分片；
- Webhook 模式下的 Ed25519 验签与 `op=13` 回包；
- 消息 / 富媒体 / 流式发送，限流与重试。

我们的代码只做组装与业务，不重新实现协议。

## 要求

- Node.js ≥ 22（推荐 24，`.node-version` 为 24.13.0）
- pnpm

```bash
pnpm install
cp .env.example .env
```

## 获取凭据（扫码）

不需要手动去开放平台复制凭据，用官方扫码连接器一步拿到：

```bash
pnpm qq:login
```

终端会打印二维码 → 手机 QQ 扫码完成机器人绑定 → 自动把
`QQBOT_APP_ID` / `QQBOT_APP_SECRET` 写回 `.env`。

> `@tencent-connect/qqbot-connector` 只负责**扫码换取凭据**（HTTPS 轮询
> `q.qq.com`，本地 AES-256-GCM 解密 secret），它**不接收消息**。
> 收发消息由 `@tencent-connect/qqbot-nodejs` 协议层负责。
> 也可以跳过这步，手动在 `.env` 填入平台上的 AppID / AppSecret。

## 运行

```bash
pnpm dev         # 开发模式（文件变更自动重启）
pnpm start       # 正常运行
pnpm typecheck   # 类型检查
pnpm build       # 编译到 dist/，供部署脚本打包
pnpm qq:login    # 扫码获取 AppID / AppSecret 并写入 .env
pnpm qq:check    # 离线协议自检（不联网）
pnpm matrix:check   # Matrix bridge 离线自检
pnpm matrix:admin   # 查询、邀请或踢出 Matrix 房间成员
pnpm tuwunel:check  # 用 TUWUNEL_BIN 的本机 Tuwunel 检查双向桥接与生产入口生命周期
pnpm deploy:check   # 校验生产 registration、.env、权限与部署 URL
pnpm deploy:server  # 本地构建运行包并同步到服务器重启服务
pnpm bridge       # 启动独立 QQ / Tuwunel bridge
pnpm bridge:dev   # 以 watch 模式启动 bridge
pnpm webhook:check  # 本地起 webhook 服务，端到端验证收消息
pnpm integration:check  # typecheck + build + qq:check + matrix:check + webhook:check
pnpm ci:check      # 与 GitHub Actions 相同的完整门禁
```

## 配置

见 `.env.example`。关键项：

| 变量 | 说明 |
| --- | --- |
| `QQBOT_APP_ID` / `QQBOT_APP_SECRET` | QQ 开放平台机器人凭据（必填） |
| `QQBOT_TRANSPORT` | `websocket`（默认）或 `webhook` |
| `QQBOT_WEBHOOK_PORT` / `QQBOT_WEBHOOK_PATH` | 仅 webhook 模式使用 |
| `QQBOT_INTENTS` | 自定义 intents 位掩码；默认使用 SDK 完整集合，含 guild、DM、群聊、单聊与互动 |
| `QQBOT_MARKDOWN_SUPPORT` | 机器人是否有 Markdown 权限；为 `true` 时，检测到 Markdown 语法的正文使用 `msg_type=2` |
| `QQBOT_TOKEN_PREFETCH` | `sync`（默认，凭据错误立即暴露）或 `async` |
| `QQBOT_API_BASE_URL` / `QQBOT_TOKEN_BASE_URL` | 可选，覆盖 OpenAPI / token 基址（自建代理或测试） |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `LOG_CONSOLE` | 是否输出到控制台，默认 `true` |
| `LOG_FILE` | 落盘文件，默认 `logs/bot.log`；`off` 关闭落盘 |
| `LOG_MAX_SIZE_MB` | 单文件大小上限，默认 10，超过自动轮转 |
| `LOG_MAX_FILES` | 保留的日志文件总数（含当前），默认 5 |
| `CHAT_LOG_ENABLED` | 是否保存聊天记录，默认 `true` |
| `CHAT_DATA_DIR` | 数据根目录，默认 `./data` |
| `CHAT_SAVE_MEDIA` | 是否下载图片/语音/视频/文件，默认 `true` |
| `CHAT_MEDIA_MAX_MB` | 单个媒体大小上限，默认 50 |
| `MATRIX_BRIDGE_*` | Tuwunel appservice、身份密钥、状态文件与发送者授权配置；详见 `.env.example` |

启用 Matrix bridge 时，除全局发送者名单外，发送者还必须是目标 QQ 映射
房间的已加入成员，并达到 `MATRIX_BRIDGE_MIN_POWER_LEVEL`。完整架构、
映射规则、Tuwunel 联调步骤和限制见
[`docs/qq-matrix-bridge/PLAN.md`](docs/qq-matrix-bridge/PLAN.md)；生产部署、
备份、密钥操作及 Prometheus 告警示例见
[`docs/qq-matrix-bridge/DEPLOYMENT.md`](docs/qq-matrix-bridge/DEPLOYMENT.md)。
当前实现状态、实施日志、验证证据和阻塞项见
[`docs/qq-matrix-bridge/STATUS.md`](docs/qq-matrix-bridge/STATUS.md)。
原生部署资产位于 [`deploy/`](deploy)：systemd 单元、Tuwunel 配置模板与
`deploy-server.sh`（本地构建后同步到服务器）。
`/health` 与 `/metrics` 不鉴权，只应暴露在 Tuwunel 可达的内网。
QQ 侧已支持文本、媒体、引用与结构化消息（`message_type=3/101/102/103`
卡片、并行消息、聊天记录、引用），结构化内容合并为有界文本并递归转发
元素内附件，超限时截断标记。
消息正文中的 `<@OPENID>` 会映射为可读的 `@昵称`，并生成
`formatted_body`、`https://matrix.to/#/...` 链接和 `m.mentions`；无法取得
昵称时使用稳定的 `QQ用户_<8 位摘要>`，不会暴露 openid。`@room` 也会映射为
Matrix room 提及。
QQ 引用会从 `refMsgIdx`、原始字段、`message_scene.ext` 和嵌套
`msg_elements` 中收集索引；`TMP_*` 索引无法直接命中时，仅在目标房间、
发送者和引用正文唯一匹配时回退关联。命中后只保留 Matrix `m.in_reply_to`
和回复正文，不再输出 `> <...>` 调试文本。
媒体按 SHA-256 内容哈希去重：聊天记录共用 `data/media-cache/<sha256>`，
bridge 复用已上传的 Matrix `mxc://`，同一图片、表情包或文件不会重复落盘，
也不会因同一批消息并发上传多次。
消息桥接覆盖 QQ 群聊、单聊、频道和频道私信。guild/DM 已支持双向文本与
撤回；受 QQ channel/DM API 限制，Matrix 到 guild/DM 的媒体发送当前会
记录警告并忽略，但不会阻塞 transaction ACK。
bridge 不枚举 QQ 群成员名单，ghost 在收到该用户消息后创建；QQ 未提供昵称时
才会显示 `QQ用户_<8 位摘要>`，这不是硬编码用户列表。
Matrix 发出的 `m.mentions.user_ids` 会在已持久化的 QQ ghost 映射中解析为
QQ openid，并转换为当前 QQ 群聊客户端可解析的 `<@openid>`；官方文档虽已
推荐 `<qqbot-at-user id="..." />`，但客户端仍可能把新标签显示为普通文字。
普通 Matrix 用户不会被伪装成 QQ 用户。状态文件使用 schema v8 保存加密的
ghost 反向映射，并支持 v2-v7 平滑迁移。
Matrix 正文命中标题、列表、引用、代码、链接或强调语法时，在
`QQBOT_MARKDOWN_SUPPORT=true` 且机器人有平台 Markdown 权限的前提下改用
QQ `msg_type=2`；普通正文仍使用 `msg_type=0`。引用消息的
`message_reference` 在两种类型下都会保留。
QQ 入站消息会先加密写入持久化队列，bridge 重启后自动重放；失败按指数
退避，队列容量和重试间隔可通过 `MATRIX_BRIDGE_QQ_*` 调整。

房间成员可通过管理 CLI 查询和调整。`invite` 与 `kick` 必须显式指定具备
对应权限的 `--actor`；踢出后 bridge 会在下一条消息时立即拒绝该成员，
无需重启：

```bash
pnpm matrix:admin status --room '!room-id' --user '@alice:example.org'
pnpm matrix:admin invite --room '!room-id' --user '@alice:example.org' \
  --actor '@_qq_<digest>:example.org'
pnpm matrix:admin kick --room '!room-id' --user '@alice:example.org' \
  --actor '@_qq_<digest>:example.org' --reason 'policy review'
```

## 日志

- 四级：`debug` / `info` / `warn` / `error`，按 `LOG_LEVEL` 过滤；
- 同时输出控制台与文件，文件按大小自动轮转为 `bot.log.1` / `bot.log.2`…；
- 每行格式：`[ISO 时间] [级别] 消息 {结构化 meta}`；
- `Error` 对象自动展开 `name` / `message` / `stack`；
- `appSecret` / `accessToken` / `authorization` 等密钥字段自动脱敏；
- 未捕获异常与未处理的 Promise 拒绝也会落盘；
- 落盘失败（磁盘满等）只告警一次并降级为仅控制台，不影响机器人运行。

```bash
tail -f logs/bot.log        # 实时看日志
LOG_LEVEL=debug pnpm start  # 调试模式
```

## 聊天记录

按聊天目标分目录，消息以 JSONL 追加保存，媒体附件自动下载：

```text
data/chats/
  group/<group_openid>/
    messages.jsonl          # 每行一条完整消息记录
    media/
      <messageId>-0.png     # 图片/视频/语音/文件
      <messageId>-0-wav.wav # 语音的 WAV 版本（如有）
      download-errors.log   # 下载失败记录（超限/网络错误）
  c2c/<user_openid>/...
  guild/<guildId>/<channelId>/...
  dm/<user_openid>/...
```

每条记录包含：记录时间、消息时间、发送者 openid/昵称、正文、`msgType`、
群/频道标识、@ 列表、消息场景、附件元信息及**本地路径**。

行为说明：

- 同一 `messageId` 重复推送会去重（不重复记录、不重复下载）；
- 媒体在写入记录后**异步下载**，不阻塞消息回复；
- 文件名由 `messageId + 序号` 推导，已存在则跳过，天然幂等；
- 超过 `CHAT_MEDIA_MAX_MB` 的媒体跳过并写入 `download-errors.log`；
- 优雅退出（SIGINT/SIGTERM）会等待进行中的下载完成。

## 官方文档快照

`docs/qq-api/` 是 QQ 开放平台 API v2 的官方文档离线快照，含事件、OpenAPI、
网关、错误码与消息类型，供开发时直接检索，不需要联网。

## 接入方式

- **WebSocket（推荐）**：本地或无公网时使用。机器人主动连接 QQ 网关。
- **Webhook**：需要公网 HTTPS 回调地址，端口只能是 80 / 443 / 8080 / 8443；
  保存回调配置时平台会立即发 `op=13` 验证请求，服务必须已在线。
