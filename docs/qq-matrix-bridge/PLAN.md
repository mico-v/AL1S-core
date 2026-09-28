# QQ 官方机器人接入 Matrix 开发计划

## 目标

在 AL1S-core 中实现独立桥接服务，连接 QQ 开放平台官方机器人与
Tuwunel homeserver。QQ 用户以 Matrix ghost 表示，Matrix 用户消息由 QQ
机器人代理发送到群聊、单聊、频道或频道私信。

首期仅支持未加密房间。QQ 官方机器人不能冒充普通 QQ 用户发送消息，
因此 Matrix 出站到 QQ 时必须保留“机器人代理发送”的语义。

## 持续开发与追踪

`PLAN.md` 记录目标、架构、约束、阶段和验收标准，`STATUS.md` 记录当前状态、
实施日志、证据和阻塞原因。两者是持续开发的事实来源，不以对话记录代替。

每次代码或行为变更必须同时完成：

1. 更新 `PLAN.md` 中受影响的设计、阶段或验收标准。
2. 在 `STATUS.md` 更新对应状态，并写明验证命令、结果和剩余限制。
3. 新增或修改可重复执行的检查，避免只依赖一次人工观察。
4. 运行 `pnpm integration:check` 和 `git diff --check`；修改协议或部署行为
   时还需运行 `pnpm tuwunel:check`。需要 QQ 真机时，必须明确区分离线证据、
   真实联调证据和未执行项。

状态只使用 `TODO`、`DOING`、`BLOCKED`、`DONE`。`BLOCKED` 必须写明外部
依赖和解除条件；恢复开发后先重新验证阻塞条件，再继续实现。

## 可行性结论

可以使用 Tuwunel，且无需修改 Tuwunel Rust 核心。Tuwunel 原生支持
Application Service registration、transaction push、`hs_token` 鉴权和
`user_id` masquerade，本项目以独立 Node.js bridge 接入即可。已使用
Tuwunel 1.9.3 验证 registration 加载、ping、创建房间、ghost 发事件和
transaction 回推。

## 架构

```text
QQ 开放平台
  ↕ @tencent-connect/qqbot-nodejs
AL1S Bot
  ↕ QqMatrixBridge
  ├─ Matrix Application Service transaction HTTP 服务
  └─ Matrix Client-Server API client
       ↕
    Tuwunel
```

代码边界：

| 路径 | 职责 |
| --- | --- |
| `src/matrix/client.ts` | Matrix Client-Server API、媒体上传与下载 |
| `src/matrix/appservice.ts` | 接收 Tuwunel transaction、校验 `hs_token`、幂等 |
| `src/bridge/store.ts` | QQ/Matrix 房间、用户、事件、被动回复窗口与入站队列持久化 |
| `src/bridge/bridge.ts` | 双向消息转换、路由、回环防护与入站可靠重放 |
| `src/deploy/preflight.ts` | registration、`.env`、namespace 与部署 URL 一致性校验 |
| `src/matrix/metrics.ts` | 固定标签的 Prometheus 指标 |
| `src/matrix-bridge.ts` | QQ Bot、Matrix bridge 与 HTTP 服务装配入口 |
| `src/scripts/matrix-check.ts` | 不依赖 Tuwunel 和 QQ 凭据的离线检查 |
| `src/scripts/tuwunel-check.ts` | 自动启动临时 Tuwunel，以假 QQ 端口完成双向集成检查 |
| `src/matrix/admin.ts` | 房间成员状态、邀请和踢出的可复用管理逻辑 |
| `src/scripts/matrix-admin.ts` | 面向运维的房间成员管理 CLI |
| `src/scripts/deploy-check.ts` | 生产启动前检查 registration、`.env` 和文件权限 |
| `deploy/deploy-server.sh` | 本地构建运行包并同步到服务器重启服务 |
| `deploy/systemd/*.service` | Tuwunel 与 bridge 的原生 systemd 单元 |
| `deploy/tuwunel.toml.example` | Tuwunel 原生配置模板 |
| `.github/workflows/ci.yml` | 在 push/PR 上运行与本地一致的完整 CI 门禁 |

Tuwunel 使用 appservice registration YAML 接入。`url` 指向本服务，
`hs_token` 用于验证 Tuwunel 推送，`as_token` 用于调用 Matrix API。
`users` 与 `aliases` namespace 分别独占 ghost 用户和桥接房间别名。
生产拓扑、持久卷、备份、密钥和升级流程见 `DEPLOYMENT.md`。

## Tuwunel 联调基线

推荐先运行自动检查。检查需要一个本机 Tuwunel 1.9.3 可执行文件，通过
`TUWUNEL_BIN` 指向它，或设置 `TUWUNEL_SOURCE_DIR` 指向源码仓库的
`target/release/tuwunel`。检查使用临时数据库目录和随机端口，断言服务端
版本，结束后自动清理，不依赖任何容器运行时：

```bash
TUWUNEL_BIN=/path/to/tuwunel pnpm tuwunel:check
```

该命令验证 registration 加载与 ping、QQ 到 Matrix 的 room/ghost 投递
（含结构化消息合并正文和媒体上传后下载比对）、Tuwunel 重启后的 alias
与持久化、Matrix transaction 回推、群聊/单聊文本和媒体到 QQ 的发送调用，
以及 guild/DM 文本路由和媒体忽略语义。检查还会编译并启动
`dist/matrix-bridge.js` 生产入口，以假 QQ Webhook 凭据验证 appservice
健康检查、Tuwunel ping、QQ 事件入站、优雅退出和端口释放。它不连接 QQ
开放平台，也不替代真实 QQ 凭据联调。

手工流程用于需要观察生产式端口和配置的场景，使用 `matrix.test`、端口
`18008` 和独立数据目录做本地验证。替换 YAML 与 `.env` 中的 token、domain
和 namespace 正则时必须保持一致。

1. 准备 registration。可从 `deploy/appservice.example.yaml` 复制，并将
   `url`、tokens、domain 和 64 位 hex namespace 改成实际值。
2. 启动仅用于联调的 Tuwunel 本机进程，配置指向临时数据库与 registration：

```bash
mkdir -p /tmp/al1s-tuwunel/appservices /tmp/al1s-tuwunel/data
cp docs/qq-matrix-bridge/appservice.yaml /tmp/al1s-tuwunel/appservices/al1s-qq-bridge.yaml
cat > /tmp/al1s-tuwunel/tuwunel.toml <<'TOML'
[global]
server_name = "matrix.test"
database_path = "/tmp/al1s-tuwunel/data"
address = ["127.0.0.1"]
port = 18008
allow_registration = false
allow_federation = false
appservice_dir = "/tmp/al1s-tuwunel/appservices"
TOML
tuwunel -c /tmp/al1s-tuwunel/tuwunel.toml
```

Tuwunel 与 bridge 都监听回环地址时，registration 的 `url` 使用
`http://127.0.0.1:29328`，`.env` 中的
`MATRIX_BRIDGE_HOMESERVER_URL` 使用 `http://127.0.0.1:18008`。

3. 配置 `.env` 并启动 bridge：

```bash
MATRIX_BRIDGE_ENABLED=true
MATRIX_BRIDGE_HOMESERVER_URL=http://127.0.0.1:18008
MATRIX_BRIDGE_DOMAIN=matrix.test
MATRIX_BRIDGE_AS_TOKEN=<registration-as-token>
MATRIX_BRIDGE_HS_TOKEN=<registration-hs-token>
MATRIX_BRIDGE_IDENTITY_SECRET=<至少 16 字符的长期随机密钥>
MATRIX_BRIDGE_ALLOWED_SENDERS=@alice:matrix.test,@bob:matrix.test
MATRIX_BRIDGE_MIN_POWER_LEVEL=10
MATRIX_BRIDGE_REFERENCE_TTL_DAYS=30
MATRIX_BRIDGE_REFERENCE_MAX_ENTRIES=10000
MATRIX_BRIDGE_LISTEN_HOST=127.0.0.1
MATRIX_BRIDGE_PORT=29328
pnpm bridge
```

4. 验证注册、鉴权与推送。下列 ping 由 Tuwunel 发起，成功时 bridge
   返回 200；Tuwunel 会同时发送 Bearer 和 `access_token` query：

```bash
curl -fsS http://127.0.0.1:18008/_tuwunel/server_version
curl -i -X POST \
  http://127.0.0.1:18008/_matrix/client/v1/appservice/al1s-qq-bridge/ping \
  -H "Authorization: Bearer $MATRIX_BRIDGE_AS_TOKEN" \
  -H 'Content-Type: application/json' --data '{}'
```

5. 使用 `as_token` 和 `user_id` masquerade 创建房间、让 appservice bot
   加入，再以 64 位 hex ghost 身份发送 `m.room.message`。bridge 应收到
   `PUT /_matrix/app/v1/transactions/{txnId}`，其事件包含对应 `room_id`、
   ghost `sender` 和 `event_id`。

## 映射规则

- `group/<group_openid>` 映射到一个 Matrix room。
- `c2c/<user_openid>` 映射到一个 Matrix direct room。
- `guild/<guild_id>/<channel_id>` 映射到一个 Matrix room，出站目标使用
  `channel_id`。
- `dm/<guild_id>` 映射到一个 Matrix direct room，出站目标使用
  `guild_id`。
- WebSocket 模式默认使用 SDK `FULL_INTENTS`。若自定义 `QQBOT_INTENTS`，
  guild 必须包含 `PUBLIC_GUILD_MESSAGES`（`1 << 30`），DM 必须包含
  `DIRECT_MESSAGE`（`1 << 12`）；QQ 平台未授权对应 intent 时网关会拒绝连接。
- QQ openid 通过 `HMAC-SHA256` 生成 `@_qq_<digest>:<domain>`，不直接暴露。
- QQ 正文与 `mentions` 中的 `<@OPENID>` 转为可读 `@昵称`，并生成
  `formatted_body`、`https://matrix.to/#/...` 链接和 `m.mentions.user_ids`。
  `@room` 写入 `m.mentions.room`。无法取得 QQ 昵称时使用稳定的
  `QQ用户_<8 位 HMAC>`，不能回退为原始 openid 或 `<@...>` 调试文本。
- QQ 文本转换为 `m.room.message`/`m.text`。
- QQ 媒体先下载并上传 Matrix，再转换为对应的 `m.image`、`m.audio`、
  `m.video` 或 `m.file`。
- QQ 媒体按下载字节的 SHA-256 内容寻址：聊天记录复用
  `data/media-cache/<sha256>`，bridge 在 schema v7 状态中保存内容哈希到
  Matrix `mxc://` 的映射，并合并同哈希并发上传。相同图片、表情包或文件不
  重复落盘和上传；引用元素附件也走同一去重路径。
- Matrix 媒体下载使用已鉴权端点
  `/_matrix/client/v1/media/download/{serverName}/{mediaId}`。Tuwunel
  1.9.3 默认关闭旧版 `/_matrix/media/v3/download` 未鉴权访问，不能依赖
  兼容路径。
- QQ `message_type=3` 卡片消息从 `ark_data` 生成可读回退文本：保留
  `ark_name`/`prompt` 和 `fields` 中的 title/desc/tag/source/nickname/address，
  忽略 `jump_url`、`preview` 等链接或图片字段，不写入原始 JSON。
- QQ `message_type=101/102/103` 的 `msg_elements` 按文档顺序递归合并进正文；
  `message_type=103` 的顶层元素是被引用内容，只进入引用 fallback，不重复
  写入正文。元素附件按顺序转发，按 URL 去重，引用元素附件不重复转发。
- QQ 结构化文本标签统一清洗：`faceType.ext.text` 解码为可读表情名，
  `attachmentType` 及未知 `*Type=` 调试标签直接移除，避免同一媒体被文本
  标签和附件事件重复发送。
- 结构化解析全部有界：递归深度 4 层、最多 64 个元素、16 个附件、正文
  4096 字符、引用摘录 500 字符；超限时截断并追加 `[消息过长，已截断]`。
- Matrix 文本按原正文发送到 QQ，不额外增加发送者标签；媒体消息也不把
  发送者标签作为 caption。
- Matrix 出站优先使用最近 QQ 入站消息的被动回复窗口，无窗口时转为主动消息。
- 每条 QQ 入站消息拥有独立配额；收到新消息时，后续 Matrix 出站切换到
  该消息的被动回复窗口。
- QQ 出站命中 `40034005` 或 `40034128` 时清除失效的被动窗口并降级为主动
  消息；命中 `40034100` 时按 2/4/8 秒退避重试，耗尽后交由 Appservice
  transaction 重试。仅对平台明确拒绝的错误重试，网络超时不自动重发。
- QQ 引用从 `refMsgIdx`、原始 `ref_msg_idx`/`refMsgIdx`/`ref_idx` 等字段、
  `message_scene.ext` 和嵌套 `msg_elements[].msg_idx` 收集候选索引；当前
  消息的全部可用索引别名都会持久化，已有历史记录继续兼容。
- `TMP_*` 索引无法直接命中时，只在目标房间、发送者和引用摘录唯一匹配时
  回退；重复或短摘录不建立错误关联。命中后发送 Matrix `m.in_reply_to`，
  正文只包含回复内容；未知引用使用不含尖括号的可读文本 fallback。
- Matrix 引用在存在 QQ `ref_idx` 映射时转换为 `message_reference`。
- Matrix `m.replace` 编辑当前忽略，避免把编辑后的正文重复发送到 QQ；
  Matrix redaction 会映射为 QQ 撤回并删除出站映射。
- Matrix 消息仅在发送者位于 `MATRIX_BRIDGE_ALLOWED_SENDERS`、属于消息所在
  QQ 映射房间的 `join` 成员，且 power level 不低于
  `MATRIX_BRIDGE_MIN_POWER_LEVEL` 时转发。未配置全局名单时默认拒绝；
  `*` 表示允许任意已获批的房间成员。
- 房间成员资格和权限按 room ID 独立校验，不缓存、不跨房间复用。邀请用户
  加入对应房间即为房间级批准；踢出成员或降低 power level 会立即撤销转发
  权限，无需重启 bridge。
- `pnpm matrix:admin` 提供 `status`、`invite`、`kick`。邀请和踢出必须显式
  指定本 homeserver 的 `--actor`，由 Tuwunel 校验其房间权限；无效参数在
  任何 HTTP 请求前拒绝。
- 同一 QQ 会话的首次并发消息共享一次 Matrix room 创建过程，后续消息等待
  同一 Promise；不会因 alias 竞争创建多个房间或丢失其中一条消息。
- QQ/Matrix 引用映射默认保留 30 天，最多 10,000 条；超限时删除最旧记录，
  过期或残缺的正反向索引在查询、写入或重启时同步清理。可通过
  `MATRIX_BRIDGE_REFERENCE_TTL_DAYS=0` 关闭时间过期。
- transaction ID、Matrix event ID 和 QQ message ID 均需去重。
- QQ 入站消息先加密写入状态队列，再创建房间或向 Matrix 发送事件。bridge
  启动时立即重放到期项，运行期间默认每 5 秒检查一次；失败按 5 秒起步、
  最大 5 分钟指数退避。成功后在同一原子状态写入中删除待处理项并记录
  message ID 去重键。
- 入站队列默认最多 10,000 条，可通过
  `MATRIX_BRIDGE_QQ_QUEUE_MAX_ENTRIES` 调整。达到上限后新消息记录错误并
  丢弃，避免无界占用磁盘。媒体重放优先复用内容哈希映射；仅当 Matrix 已
  接收上传但 bridge 尚未来得及持久化映射时崩溃，才可能留下孤立上传对象，
  确定性 Matrix transaction ID 仍会避免重复事件。

## 开发阶段

### 阶段 1：文本 MVP

- 解析 Matrix bridge 配置并校验密钥。
- 实现 appservice transaction 服务、`hs_token` 校验和 transaction 幂等。
- 实现 Matrix room 创建、alias 解析、ghost 加入和文本发送。
- 实现 QQ 群聊/单聊/guild/DM 文本入站到 Matrix。
- 实现 Matrix 文本原样出站到 QQ，包含 guild/DM 路由和被动回复窗口。
- 提供离线检查和 Tuwunel registration 示例。

### 阶段 2：媒体与消息语义

- QQ 图片、语音、视频、文件上传到 Matrix；已由 `tuwunel:check` 在真实
  Tuwunel 上验证上传、mxc URI 和下载内容一致性。
- 相同媒体字节按 SHA-256 去重并复用 Matrix 上传，`matrix:check` 与
  `tuwunel:check` 均覆盖重复图片不增加上传次数、事件复用同一 mxc URI。
- Matrix 图片、语音、视频、文件下载并发送到 QQ；已由 `tuwunel:check`
  验证媒体事件经 Tuwunel 回推后，下载字节和类型正确到达 QQ 端口。
- 支持 QQ/Matrix 引用映射和 Matrix redaction 到 QQ 撤回。`tuwunel:check`
  已在真实 Tuwunel 上验证：QQ `msg_idx`/`ref_msg_idx` 映射为 Matrix
  `m.in_reply_to`，Matrix 引用映射回 QQ `message_reference`，Matrix
  redaction 回推后映射为 QQ recall；未知引用保留 fallback。
- Matrix 编辑明确忽略；QQ 官方仅提供撤回能力，不提供编辑消息接口。
- QQ 结构化消息已完成：`message_type=3/101/102/103` 的卡片、并行消息、
  聊天记录与引用消息转换为有界文本，并递归转发元素内附件。
- QQ 提及已完成：群聊/单聊正文中的 `<@OPENID>` 转为 Matrix 可读提及、
  HTML 链接和 `m.mentions`，支持 `@room`；未知昵称使用稳定摘要身份。
- 对 QQ 限流、重试和不可恢复错误建立明确状态，已覆盖被动窗口失效、
  主动消息频控退避和 transaction 最终重试。
- QQ 群聊/单聊反向撤回暂不可实现：官方 `GROUP_AND_C2C_EVENT` 清单没有
  用户撤回事件，只能继续引用历史的跨进程治理。

### 阶段 3：生产化

- guild/DM 文本桥接已完成：通过 `pnpm-workspace.yaml` 对固定版本
  `@tencent-connect/qqbot-nodejs@1.0.4` 应用
  `patches/@tencent-connect__qqbot-nodejs@1.0.4.patch`，补齐
  `AT_MESSAGE_CREATE`/`DIRECT_MESSAGE_CREATE` 的 `ReplyTarget`、文本发送和
  撤回路由。`matrix:check` 与 `tuwunel:check` 覆盖房间隔离、direct 标记、
  出站目标、5 分钟被动窗口和真实 Tuwunel transaction。
- Matrix 到 guild/DM 的媒体发送仍受限：QQ channel/DM 接口当前没有对应媒体
  上传/发送能力，SDK patch 明确拒绝该操作。bridge 会记录警告并忽略媒体，
  但仍确认 transaction，避免无解重试；群聊/单聊媒体不受影响。
- typing、receipt 和在线状态当前明确不桥接：Tuwunel registration 保持
  `receive_ephemeral: false`，避免接收无法可靠映射到 QQ 官方 API 的噪声；
  后续只有在 QQ 提供稳定事件和发送接口后再单独设计。
- 房间级成员审批与授权管理已完成：采用全局名单 + 房间成员 + power level
  三重校验，并提供 `matrix:admin` 的 `status`/`invite`/`kick` 工具。真实
  Tuwunel 已验证权限不足时拒绝转发、提升 power level 后放行、踢出后无法
  继续发送且不调用 QQ、重新邀请并加入后恢复转发。
- 引用映射历史治理已完成：支持 TTL、容量上限、正反索引联动删除和重启
  清理。
- 健康检查、Prometheus 指标与部署/备份文档已完成；已提供 scrape 和告警
  规则示例，实际 Alertmanager 接入仍按运行环境配置。
- 已完成可重复的 Tuwunel 单实例与持久卷重启检查；生产反向代理、监控和
  实际存储参数仍需按目标环境验证。
- 已提供原生部署资产：`deploy/systemd/*.service`、
  `deploy/tuwunel.toml.example` 和 `deploy/deploy-server.sh`；服务器只
  运行 Node 与 Tuwunel 二进制，不公开 appservice 端口。
- `deploy/deploy-server.sh` 在打包生产依赖前复制 `pnpm-workspace.yaml` 和
  `patches/`，确保锁文件声明的 QQ SDK patch 与运行包一致；服务器不编译
  TypeScript。
- 提供 `pnpm ci:check`（等同 `pnpm integration:check`），执行离线检查与
  编译；GitHub Actions 在 push/PR 上调用同一命令，避免本地与远端门禁漂移。
- 已提供 `pnpm deploy:check`：在启动前校验 registration、`.env`、
  namespace、共享 token、部署 URL 和敏感文件权限，避免配置漂移。
- 已完成生产入口生命周期检查：`pnpm tuwunel:check` 会停止测试内嵌
  appservice，编译并启动真实入口 `dist/matrix-bridge.js`，通过带合法
  Ed25519 签名的假 QQ Webhook 事件写入 Tuwunel，并验证 `SIGTERM` 正常
  退出及监听端口释放。
- Appservice 关闭使用可配置超时：先停止接受请求并关闭空闲连接，超时后
  强制关闭滞留连接，避免 keep-alive 或未完成请求使进程永久无法退出。
  关闭流程会依次尝试 appservice、bridge 在途任务、状态文件和 Bot 清理；
  单一步骤失败不会跳过剩余步骤。状态写入失败会保留 dirty 标记，使
  `flush()` 能重试失败落盘。
- 状态文件采用同目录临时文件、`fsync`、原子重命名和目录 `fsync`，降低
  进程崩溃或主机断电造成状态损坏/丢失的风险；写入失败会清理临时文件并
  保留 dirty 状态供 `flush()` 重试。新建状态目录使用 `0700`，状态文件
  使用 `0600`，避免映射和去重状态被其他本机用户读取。
- QQ 入站可靠重放已完成：待处理正文和身份字段加密落盘，启动及定时重放、
  指数退避、成功去重和容量上限均有 `matrix:check` 覆盖。

## 验收标准

1. `pnpm typecheck`、`pnpm qq:check`、`pnpm matrix:check` 和
   `pnpm integration:check` 全部离线通过。
2. `pnpm tuwunel:check` 能自动启动真实 Tuwunel，持久加载 appservice，
   并在重启后继续推送 transaction。
3. QQ 群聊、单聊、guild 和 DM 文本可双向往返，重复 transaction 不产生
   重复 QQ 消息；guild 出站目标为 channel ID，DM 出站目标为 guild ID。
4. ghost 用户、房间 alias 和 QQ 会话映射在 bridge 重启后保持。
5. 群聊/单聊媒体可以上传到 Matrix 并发送到 QQ；相同内容按 SHA-256 只保存
   一份本地文件并复用 Matrix 上传，`tuwunel:check` 使用真实 Tuwunel 验证
   媒体上传、已鉴权下载和双向投递。Matrix 到 guild/DM 的媒体明确忽略并
   正常 ACK transaction。
6. 日志、状态文件和文档中不出现 token、AppSecret 或完整 openid。
7. 文档记录每阶段实现、验证命令、已知限制和剩余工作。
8. QQ 引用与 Matrix 引用可在对应事件已知时双向关联；候选索引覆盖
   `refMsgIdx`、原始字段、`message_scene.ext` 和嵌套 `msg_elements`，
   `TMP_*` 只能通过同房间/发送者/摘录唯一匹配回退；未知引用使用可读
   fallback，不阻断正文转发，也不输出 `> <...>` 调试文本。
9. 全局名单用户只有在目标房间成员资格有效且 power level 达标时才能触发
   QQ 发送；未加入、已离开或权限不足时均默认拒绝。`tuwunel:check` 在真实
   Tuwunel 上验证权限不足不触发 QQ、更新房间 power level 后放行。
10. 引用映射超过 TTL 或容量上限后不可再查询，清理结果可在 bridge 重启后
    保持。
11. `/metrics` 只包含固定标签，不出现用户、房间、消息或凭据标识；生产环境
    只在 Tuwunel 可达的内网暴露。
12. 同一 QQ 会话首次并发到达多条消息时，只创建一个 Matrix room，且每条
    可转发消息都使用该 room 完成投递。
13. 临时 Tuwunel 在持久卷重启后保留 registration、room alias 与映射，
    且 Matrix 到 QQ 的 transaction 仍可完成。
14. `pnpm build` 生成可执行的 `dist/matrix-bridge.js`；
    `deploy/deploy-server.sh` 能打包生产依赖并应用锁文件声明的 SDK patch。
15. 生产文件准备完成后，`pnpm deploy:check` 能在不连接 QQ/Tuwunel 的情况下
    发现 registration、`.env`、namespace、URL 或文件权限不一致。
16. QQ `message_type=3/101/102/103` 结构化消息转换为有界文本并转发嵌套
    附件；深度、元素数、附件数和长度超限时截断且不中断转发。
    `matrix:check` 覆盖全部边界，`tuwunel:check` 覆盖合并正文进入真实
    Tuwunel。
17. `pnpm matrix:admin` 可查询、邀请和踢出指定 Matrix 房间成员；无效参数
    不发起请求。`tuwunel:check` 验证被踢成员无法继续发送、重新邀请并加入
    后可恢复转发。
18. SDK patch 与精确版本 `1.0.4` 保持一致；升级 SDK 时，guild/DM 文本、
    撤回和媒体拒绝行为仍由离线与真实 Tuwunel 检查覆盖。
19. `pnpm tuwunel:check` 能启动编译后的 `dist/matrix-bridge.js`，在临时
    Tuwunel 上完成健康检查、registration ping、假 QQ Webhook 入站、
    ghost 事件写入、`SIGTERM` 优雅退出和监听端口释放。
20. `.github/workflows/ci.yml` 在 push 和 pull request 上使用固定 Node/pnpm
    版本运行 `pnpm ci:check`，覆盖离线检查与编译。
21. Appservice 对超限请求体返回 `413`，对非法 JSON、transaction 类型或
    transaction ID 编码返回 `400`，内部处理失败仍返回 `500`；生产入口的
    `uncaughtException` 和 `unhandledRejection` 会进入同一优雅关闭流程，
    等待 bridge 在途 QQ 任务、flush 持久化状态并以非零退出码结束，避免
    进程保留不确定状态。`tuwunel:check` 直接触发这两种异常，验证进程完成
    清理后以非零退出码结束并释放 appservice 监听端口。
22. `MATRIX_BRIDGE_SHUTDOWN_TIMEOUT_MS` 控制 appservice 等待活跃连接的
    上限；超时后强制关闭连接。关闭任一步骤失败时仍继续尝试其余清理，
    状态写入失败后 `flush()` 会重试并可由新实例读回。生产入口在滞留
    appservice 请求存在时收到 `SIGTERM`，仍须在关闭预算内退出并释放端口。
23. 状态写入通过同目录临时文件完成，临时文件和最终文件权限为 `0600`，
    新建状态目录为 `0700`；临时文件在写入和 `fsync` 完成后原子替换，
    随后同步目录。写入失败不破坏旧状态，清理临时文件后仍可由 `flush()`
    重试。
24. QQ 入站消息在 Matrix 投递前持久化入队；bridge 重启后能恢复到期消息，
    失败按配置指数退避，成功消息不会重复发送。队列满时记录错误并丢弃新
    消息，状态文件不包含明文 QQ 身份或正文。
25. `TUWUNEL_BIN` 或 `TUWUNEL_SOURCE_DIR` 能启动本机 Tuwunel，不依赖
    容器运行时；临时数据库、registration、重启持久化、双向 transaction
    和清理行为保持一致。
26. QQ 正文中的 `<@OPENID>` 转为可读 Matrix 提及、`matrix.to` HTML 链接和
    `m.mentions`，`@room` 正确映射；未知用户使用稳定摘要身份，正文、HTML、
    状态和日志均不泄漏原始 openid。
27. 媒体以 SHA-256 内容地址去重，重复图片、表情包、文件和引用附件复用
    本地文件及 Matrix `mxc://`；并发上传合并为一次，重启后仍可复用映射。

## 风险评估

- 初期不支持 Matrix E2EE，不能处理 `m.room.encrypted`。
- Appservice namespace 不等于房间成员资格，bridge 或 ghost 必须实际加入。
- QQ 被动回复窗口有限，高频 Matrix 消息可能失败或转为主动消息。
- Tuwunel 不支持水平扩展，bridge 状态也不应按多实例并行写入设计。
- QQ 出站身份固定为机器人，产品界面和用户说明不能宣称等同真人发送。
- 授权模型要求全局发送者名单、目标房间 `join` 成员资格和最低 power level
  同时成立。全局名单只是部署基线，不替代房间级批准；生产环境应限制谁有权
  执行 `matrix:admin`、邀请成员和修改 room state。`--actor` 会被
  appservice token 冒充，必须使用最小权限且妥善保护 `.env`。
- bridge 状态当前为 schema v7，字段使用 AES-256-GCM 加密，索引使用
  HMAC；支持 v2-v6 平滑迁移到 v7。v7 增加内容哈希到 Matrix 上传的映射。
  v1 或未知版本仍会被拒绝；若已有状态文件，升级前必须停止 bridge 并单独
  备份。
- Webhook transport 在校验签名后立即向 QQ 平台返回 ACK，再异步处理事件。
  “平台 ACK 后、bridge 持久化入队前”的极小崩溃窗口无法由 bridge 消除；
  平台重投和上层可用性要求必须覆盖该窗口。
- 引用映射的 TTL 和容量只在 bridge 进程内执行，不依赖外部定时任务；
  运维时应保留状态文件写入权限并监控磁盘空间。
- 联调基线固定为 Tuwunel 1.9.3。升级时必须先阅读上游迁移说明、备份数据库
  和 bridge 状态，再更新版本断言和验证证据。
- 部署使用上游预编译的 Tuwunel 二进制；更换 CPU 架构时必须改用对应架构的
  发布产物，不能假设 x86_64-v1 的二进制在其他架构上可用。
- `/health` 和 `/metrics` 当前不鉴权，必须只监听内网或置于受控反向代理后；
  不要把 appservice 监听端口直接暴露到公网。
- `MATRIX_BRIDGE_IDENTITY_SECRET` 同时是稳定 ghost 身份和状态解密密钥。
  丢失或轮换会使旧状态不可恢复，生产环境必须固定保存并纳入密钥备份。
- QQ 群聊/单聊没有公开的撤回事件。除非开放平台后续补充事件或实测确认
  等价推送，否则不能让 QQ 撤回同步为 Matrix redaction。
- `@tencent-connect/qqbot-nodejs` 依赖精确版本和本地 patch；直接升级、删除
  patch 或使用未应用 patch 的安装树会重新阻塞 guild/DM 文本事件与发送。
- Matrix 到 guild/DM 的媒体不能静默宣称成功；当前策略是记录警告、忽略并
  ACK，产品侧必须明确说明该限制。
- bridge 关闭了 `ChatStore` 额外聊天落盘并摘要化自身身份日志，但 QQ SDK
  的内部日志仍可能包含平台返回的标识；部署时应限制日志访问与保留时间。
