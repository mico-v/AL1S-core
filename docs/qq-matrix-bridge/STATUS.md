# QQ Matrix Bridge 开发追踪

## 状态说明

- `TODO`：尚未开始。
- `DOING`：正在实现，尚不能用于验收。
- `BLOCKED`：需要外部状态或用户输入，必须记录阻塞原因。
- `DONE`：实现、文档和离线验证均已完成。

## 当前迭代

- 目标：完善 QQ/Matrix 双向提及、引用、Markdown 与媒体语义，并在
  `as:/opt/al1s` 的原生 systemd 环境持续做真实 QQ 联调。
- 状态：DOING。
- 已完成：双向提及映射、引用、`TMP_*` 唯一回退、结构化标签清理、Markdown
  出站选择、媒体 SHA-256 去重与 Matrix 上传复用均通过离线检查。
- 剩余：部署后在生产环境逐项确认 QQ 单聊、群聊提及、引用、Markdown、表情包
  和图片，并记录真实 QQ 平台与本地假端口之间的行为差异。

## 当前状态

| 项目 | 状态 | 证据 / 验收 |
| --- | --- | --- |
| 可行性评估 | DONE | `PLAN.md` 记录 Tuwunel appservice 方案与限制 |
| 配置与密钥模型 | DONE | `matrix:check` 覆盖解析和缺失必填项 |
| Appservice transaction 服务 | DONE | `matrix:check` 覆盖鉴权、ACK、并发与幂等 |
| Matrix API client | DONE | 创建、加入、发送、上传、下载通过 mock 检查；下载改用已鉴权媒体端点并通过真实 Tuwunel 验证 |
| QQ 到 Matrix 文本 | DONE | 群聊、单聊、guild、DM 进入隔离 room，ghost 身份与会话键正确 |
| Matrix 到 QQ 文本 | DONE | 原正文转发、被动回复窗口、回环防护及 guild/DM 出站目标正确 |
| Matrix 提及映射到 QQ | DONE | `m.mentions.user_ids` 只对持久化 QQ ghost 还原 openid 并生成 `<qqbot-at-user>`；原生 Matrix 用户保持文本，真实 Tuwunel 验证 appservice 回推后输出 QQ 标签，重启后映射仍可查询 |
| QQ Markdown 出站 | DONE | 高置信度 Markdown 语法在 `QQBOT_MARKDOWN_SUPPORT=true` 时使用 `msg_type=2`；普通正文使用 `msg_type=0`，两种类型均保留 `message_reference` |
| 会话级并发控制 | DONE | 同一 QQ 会话并发首条消息只创建一个 Matrix room，且两条消息均投递成功 |
| QQ 到 Matrix 媒体 | DONE | 离线检查覆盖图片上传与事件内容；真实 Tuwunel 验证上传、mxc 下载及字节一致性 |
| Matrix 到 QQ 媒体 | DONE | 群聊/单聊覆盖 mxc 下载、类型和发送参数，真实 Tuwunel 验证回推后字节到达 QQ 端口；guild/DM 明确忽略并 ACK |
| Matrix 全局发送者基线 | DONE | 默认拒绝、精确用户名单、显式通配符及非法配置均通过检查 |
| 房间级成员授权 | DONE | 全局名单 + 目标房间成员 + 最低 power level；离线覆盖未入房、跨房间隔离和批准后放行，真实 Tuwunel 验证权限不足不调用 QQ、升级后放行 |
| 房间成员运维工具 | DONE | `matrix:admin` 提供 `status`/`invite`/`kick`；离线覆盖请求路径、body 与无效参数零请求，真实 Tuwunel 验证踢出撤权及重新加入恢复 |
| 持久化与恢复 | DONE | schema v8、v2-v7 平滑迁移、重启恢复和加密检查通过；v8 增加 QQ ghost 到 openid 的加密反向映射 |
| QQ 入站可靠重放 | DONE | 入站消息加密入队；启动/定时重放、指数退避、成功去重、重启恢复和容量上限均有 `matrix:check` 覆盖 |
| 状态文件原子持久化 | DONE | 同目录临时文件、文件/目录 `fsync`、原子替换和失败重试通过；新建目录/文件权限分别为 `0700`/`0600` |
| Matrix 撤回映射 | DONE | 离线检查覆盖清理映射；真实 Tuwunel 验证 redaction 回推后映射为 QQ recall |
| Matrix 编辑处理 | DONE | 当前策略为忽略 `m.replace`，避免重复发送 QQ 消息 |
| QQ 提及映射 | DONE | `<@OPENID>` 转为可读 `@昵称`、Matrix HTML、`m.mentions` 和 `matrix.to` 链接；`@room`、未知昵称稳定摘要及 openid 不泄漏均有离线与真实 Tuwunel 断言 |
| QQ/Matrix 引用映射 | DONE | 从 `refMsgIdx`、原始字段、`message_scene.ext` 和嵌套 `msg_elements` 收集索引；`TMP_*` 仅按同房间/发送者/摘录唯一回退；已知引用只发送 `m.in_reply_to` 与回复正文，旧引用记录仍兼容 |
| QQ 结构化消息 | DONE | `message_type=3/101/102/103` 卡片、并行、聊天记录与引用消息转为有界文本；嵌套附件去重转发，`faceType` 解码、`attachmentType` 等 `*Type=` 标签过滤，深度/元素/附件/长度上限均覆盖检查 |
| QQ 媒体内容去重 | DONE | 聊天记录按 SHA-256 写入 `media-cache/<sha256>`，bridge 持久化内容哈希到 `mxc://` 映射并合并并发上传；重复图片、表情包和引用附件不重复落盘/上传，真实 Tuwunel 验证重复事件复用同一 mxc URI |
| QQ 出站频控与重试 | DONE | `40034005`/`40034128` 降级主动消息，`40034100` 指数退避后交由 transaction 重试 |
| QQ 反向撤回映射 | BLOCKED | 官方群聊/单聊事件清单未提供撤回事件，需平台新增推送或实测发现等价事件 |
| 引用映射历史清理 | DONE | 默认 30 天 TTL、10,000 条上限、正反索引联动清理及重启持久化检查通过 |
| 生产部署文档 | DONE | `DEPLOYMENT.md` 覆盖单实例边界、网络、密钥、持久卷、备份、升级与健康检查 |
| Prometheus 指标 | DONE | `/metrics` 暴露固定标签指标；`matrix:check` 覆盖格式、计数和敏感标识缺失 |
| 告警规则模板 | DONE | 提供 `prometheus.example.yml` 与 `alerts.example.yml`，覆盖宕机、transaction、状态写入和 QQ 恢复异常 |
| Guild/DM 文本场景 | DONE | 精确版本 `qqbot-nodejs@1.0.4` 加受控 patch 后，guild/DM 文本、撤回、direct room 与出站目标通过离线及真实 Tuwunel 检查 |
| Guild/DM 媒体出站 | BLOCKED | QQ channel/DM API 无对应媒体上传/发送能力；解除条件为官方提供接口，当前 bridge 记录警告、忽略媒体并 ACK |
| typing/receipt/presence | DONE | 明确不桥接，registration 设置 `receive_ephemeral: false`，避免无对称语义的噪声 |
| Tuwunel 协议联调 | DONE | Tuwunel 1.9.3 原生宿主二进制实际加载 registration、ping、创建 room、ghost 发事件并回推 transaction |
| 可重复 Tuwunel 集成检查 | DONE | `pnpm tuwunel:check` 通过 `TUWUNEL_BIN` 或 `TUWUNEL_SOURCE_DIR` 启动本机二进制并断言 1.9.3；假 QQ 端口覆盖群聊/单聊/guild/DM 文本、提及、引用、撤回、结构化消息、媒体去重、房间授权、transaction 与重启持久化 |
| 原生宿主联调 | DONE | Tuwunel 1.9.3 本机 release 二进制完整通过 `pnpm tuwunel:check`，覆盖双向 transaction、媒体、重启持久化和生产入口生命周期 |
| 生产部署资产 | DONE | `deploy/systemd/*.service`、`deploy/tuwunel.toml.example` 与 `deploy/deploy-server.sh`；服务器只运行 Node 与 Tuwunel 二进制，本地构建后同步运行包 |
| 部署前配置检查 | DONE | `pnpm deploy:check` 校验 registration/.env token、ID、namespace、URL 与文件权限；离线检查覆盖接受和拒绝路径 |
| 生产入口生命周期 | DONE | `pnpm tuwunel:check` 编译并启动 `dist/matrix-bridge.js`，用假 QQ Webhook 验证 health、registration ping、QQ 入站写入 Tuwunel；滞留 appservice 请求存在时 `SIGTERM` 仍按关闭预算退出并释放端口 |
| 故障关闭与 HTTP 错误分类 | DONE | `matrix:check` 覆盖非法 JSON `400`、超限请求体 `413`、脱敏 `500`、指标分类、bridge 在途任务等待、状态写入失败重试和 appservice 滞留连接超时关闭；`tuwunel:check` 直接注入未捕获异常/未处理拒绝，验证统一优雅关闭、非零退出码和端口释放 |
| 持续集成门禁 | DONE | `pnpm ci:check` 已完整通过；`.github/workflows/ci.yml` 在 push/PR 上复用同一命令，首次远端运行需推送后确认 |
| 真实 QQ 联调 | DOING | 生产 QQ bot 已连接并出现群聊映射；单聊、提及、引用、表情包和媒体仍需按生产日志逐项验收，不能以离线检查代替 |
| 生产环境验证 | DONE | `as:/opt/al1s` 原生 systemd 部署已上线，`al1s-bridge.service` 与 `tuwunel.service` 均为 active，`/health` 返回 `{}`；当前运行包对应 `ccd8825`，状态已从 v7 迁移到 v8 |

## 实施日志

### 2026-09-29

- 增加 Matrix 到 QQ 的完整提及映射：QQ 用户首次出现或其 openid 出现在
  提及中时，持久化 Matrix ghost 到 QQ openid 的加密反向映射；Matrix
  `m.mentions.user_ids` 命中后生成 `<qqbot-at-user id="..." />`，原生
  Matrix 用户和未知用户不会被伪装成 QQ 提及。
- 状态升级为 schema v8，新增 HMAC 索引、AES-256-GCM 加密的 `qqUsers`
  映射，并覆盖 v2-v7 平滑迁移和重启恢复。
- QQ 出站增加高置信度 Markdown 选择：标题、列表、引用、代码、链接和强调
  语法在机器人配置 `QQBOT_MARKDOWN_SUPPORT=true` 时使用 `msg_type=2` 和
  `markdown.content`；普通正文显式使用 `msg_type=0`。引用回复在两种类型下
  都保留 `message_reference`。
- 离线检查新增 Matrix ghost 提及、原生 Matrix 用户透传、Markdown 语法识别、
  `msg_type` 选择、引用保留、schema v8 迁移与重启映射断言。
- 真实 Tuwunel 检查新增 Matrix ghost 提及经 appservice transaction 回推后
  生成 `<qqbot-at-user id="..."/>` 的端到端断言。
- 生产部署更新到 `ccd8825`，服务器 `.env` 已启用 `QQBOT_MARKDOWN_SUPPORT=true`；
  启动日志确认状态从 v7 迁移为 v8，QQ 网关已就绪，bridge 与 Tuwunel 均为
  active，`/health` 返回 `{}`。

### 2026-09-28

- 完成 QQ 提及到 Matrix 的完整映射：`<@OPENID>` 输出可读 `@昵称`、
  `org.matrix.custom.html` 与 `https://matrix.to/#/...` 链接，并写入
  `m.mentions.user_ids`；`@room` 写入 room 提及。未知昵称使用稳定的
  `QQ用户_<8 位 HMAC>`，不暴露原始 openid。真实 Tuwunel 检查已断言 HTML
  链接和提及元数据。
- 扩展 QQ 引用候选索引：兼容 `refMsgIdx`、`ref_msg_idx`/`refMsgIdx`/
  `ref_idx` 等原始字段、`message_scene.ext` 和嵌套 `msg_elements[].msg_idx`；
  当前消息保存全部可用索引别名。`TMP_*` 无法直接命中时，只在同房间、
  同发送者和引用摘录唯一匹配时回退，旧持久化引用记录仍可匹配。
- 引用命中后不再把引用正文或 `> <...>` 调试标签重复写入 Matrix 正文；
  未知引用使用清理后的可读文本 fallback。`faceType.ext.text` 保留表情名，
  `attachmentType` 等内部 `*Type=` 标签移除，真实附件只发送媒体事件。
- 媒体改为内容寻址去重：下载后计算 SHA-256，聊天记录共用
  `data/media-cache/<sha256>`；bridge 在 schema v7 状态中保存内容哈希到
  Matrix `mxc://` 的映射，并用同哈希在途 Promise 合并并发上传。重复图片、
  表情包及引用附件复用同一本地文件和 Matrix 上传。
- 离线与真实 Tuwunel 检查已覆盖提及 HTML/`m.mentions`、引用索引变体、
  `TMP_*` 唯一回退、旧引用兼容、重复媒体上传复用和结构化标签清理。
- 生产 `as:/opt/al1s` 已同步到 `ed28674`，`al1s-bridge.service` 与
  `tuwunel.service` 均为 active；`curl http://127.0.0.1:29328/health`
  返回 `{}`。真实 QQ 单聊、提及、引用和媒体仍需在生产日志中逐项确认。
- 本轮验证：`pnpm integration:check`、`pnpm matrix:check`、
  `TUWUNEL_BIN=/home/x/github.com/matrix-construct/tuwunel/target/release/tuwunel pnpm tuwunel:check`
  和 `git diff --check` 通过。
- 修正 QQ 结构化标签与引用正文：`faceType.ext.text` 保留可读表情名，
  `attachmentType` 及未知 `*Type=` 标签统一移除，真实附件只发送对应 Matrix
  媒体事件；已有 Matrix event 映射的 QQ 引用不再重复写入 `> <...>` fallback
  正文，未知引用改为不含尖括号的可读文本回退。
- 本轮验证：`pnpm integration:check`、
  `TUWUNEL_BIN=/home/x/github.com/matrix-construct/tuwunel/target/release/tuwunel pnpm tuwunel:check`
  与 `git diff --check` 通过。
- 增加 `pnpm tuwunel:check:host`（历史命令，现统一为 `pnpm tuwunel:check`），
  支持通过 `TUWUNEL_BIN` 或
  `TUWUNEL_SOURCE_DIR` 启动本机 Tuwunel，并继续使用临时数据库、
  registration 和随机端口；检查结束会停止进程并清理临时目录。
- 从源码 `7801b8ec6` 构建 Tuwunel 1.9.3 release 二进制，并执行
  `TUWUNEL_BIN=/home/x/github.com/matrix-construct/tuwunel/target/release/tuwunel pnpm tuwunel:check:host`。
  检查完整通过，覆盖 registration/ping、QQ 到 Matrix 文本/引用/结构化
  消息/媒体、Tuwunel 重启持久化、Matrix 到 QQ 文本/引用/撤回/媒体、
  房间成员管理、guild/DM 路由、生产入口启动与关闭及故障退出。
- 状态升级为 schema v6，新增 QQ 入站待处理队列；消息正文与身份字段使用
  AES-256-GCM 加密，索引使用 HMAC，保留 v2/v3/v4/v5 平滑迁移。
- 入站消息在 Matrix 投递前先落盘，失败按默认 5 秒起步、最大 5 分钟指数
  退避；bridge 启动时立即重放，运行期间默认每 5 秒检查一次。成功后删除
  待处理项并写入 message ID 去重键。
- 增加队列容量配置，默认 10,000 条；达到上限后记录错误并丢弃新消息，避免
  无界占用磁盘。
- Appservice 内部异常继续返回固定 `500 M_UNKNOWN`，原始异常只写日志；
  `matrix:check` 增加响应脱敏和错误指标断言。
- 本轮验证：`pnpm integration:check`（含 `typecheck`、`build`、`qq:check`、
  `matrix:check`、`webhook:check`）和 `git diff --check` 通过；按要求未运行
  `pnpm ci:check` 或 `pnpm tuwunel:check`。

### 2026-09-27

- 完成 Tuwunel appservice 能力评估，确认无需修改 Tuwunel 核心。
- 建立 `PLAN.md`，确定独立 bridge、ghost 映射、文本优先和分阶段交付。
- 完成可配置 appservice、Matrix CS API client、双向文本/媒体、持久化、
  回环保护、幂等和被动回复窗口。
- 修正 QQ 被动回复配额语义：每条新入站消息独立开启窗口；补充对应回归
  检查并重新通过完整离线集成验证。
- 增加 Matrix 到 QQ 发送者准入：默认拒绝，支持精确用户 ID 名单及显式
  `*` 通配符，避免未授权用户在已绑定房间内触发 QQ 发送。
- 状态先升级为 schema v4：QQ target/message ID 和引用索引使用 HMAC，敏感
  状态字段使用 AES-256-GCM；支持 v2/v3 平滑迁移。bridge 模式关闭额外聊天
  落盘并摘要化身份日志。
- 完成 QQ/Matrix 双向引用映射：QQ `msg_idx`/`ref_msg_idx` 转为 Matrix
  `m.in_reply_to`，Matrix 引用转换为 QQ `message_reference`，未知引用保留
  fallback 正文。
- Matrix redaction 映射为 QQ 撤回并清理出站映射；Matrix `m.replace` 当前
  明确忽略，避免编辑事件重复发送 QQ 消息。
- 增加 QQ 出站恢复状态机：被动回复窗口失效时清除状态并降级主动消息；
  主动消息频控按 2/4/8 秒退避，重试耗尽后抛错交给 transaction 重试。
- `pnpm integration:check` 全部通过，覆盖 `typecheck`、QQ、Matrix bridge 和
  webhook 检查；`git diff --check` 通过。
- 增加房间级成员授权：全局名单用户还必须是目标 QQ 映射房间的 `join`
  成员，并达到 `MATRIX_BRIDGE_MIN_POWER_LEVEL`；权限按 room ID 查询，
  已验证未入房、权限不足、跨房间复用和提升权限后放行。
- 增加引用映射历史治理：默认 30 天 TTL、10,000 条容量上限，删除记录时
  同步清理正反向索引，并在查询、写入和重启时清理过期或残缺状态。
- 增加生产部署文档，明确单实例状态边界、内网 appservice 暴露方式、密钥
  轮换限制、持久卷、备份/恢复、升级和故障关闭语义。
- 使用 Tuwunel 1.9.3 和临时 listener 完成真实协议冒烟：加载 registration
  后，ping 以 Bearer + query `hs_token` 返回 200；`as_token` 成功创建 room、
  加入 appservice bot，并以 64 位 hex ghost `user_id` 发送 `m.room.message`；
  Tuwunel 随后向 `PUT /_matrix/app/v1/transactions/{txnId}` 推送了包含正文、
  `room_id`、`sender` 和 `event_id` 的事件。
- 在 Tuwunel 1.9.3 复核房间级授权所需接口：appservice bot 成功加入房间，
  并以 `as_token` 读取 `m.room.member`（返回 `join`）和
  `m.room.power_levels`（包含 `users_default` 与 `users`）。
- 增加零依赖 Prometheus 指标端点和固定标签指标，覆盖 appservice 请求、
  transaction、Matrix 事件、QQ 收发、恢复动作、媒体字节、状态写入和最近
  错误；离线检查确认指标不包含 QQ/Matrix 用户、房间或消息标识。
- 增加 Prometheus scrape 与告警规则示例，覆盖 bridge 宕机、transaction
  失败、状态写入失败、QQ 恢复持续触发和 transaction 长时间无成功 ACK。
- `pnpm integration:check`、两个 YAML 示例的语法解析和 `git diff --check`
  均通过；指标离线检查包含固定格式、状态写入成功/失败和敏感标识缺失。
- 初版复核发现 `qqbot-nodejs` 会在公开 `message` 事件前丢弃无
  `ReplyTarget` 的 guild/DM 事件。后续固定 SDK `1.0.4` 并加入受控 patch，
  补齐事件归一化、channel/DM 文本发送与撤回路由，同时显式拒绝不支持的
  guild/DM 媒体上传。
- 修复同一 QQ 会话首次并发消息可能重复创建 Matrix room 的竞态：按
  `target.key` 合并进行中的创建 Promise，新增并发回归检查并验证两条消息
  使用同一 room 投递。
- 增加 `pnpm tuwunel:check`：用 `TUWUNEL_BIN` 启动临时 Tuwunel 本机进程，
  生成随机 registration/token/identity secret，并通过假 QQ 端口
  驱动 `QqMatrixBridge`。检查覆盖 appservice ping、QQ 到 Matrix 的 room 与
  ghost 事件、appservice bot 入房、持久数据目录重启后的 registration 和
  alias、Matrix transaction 回推及 Matrix 到 QQ 的发送调用；结束后删除
  临时进程和临时状态。
- `TUWUNEL_CHECK_VERSION` 断言测试基线为 Tuwunel 1.9.3；升级基线时同步
  更新版本断言和验证证据。
- 增加 `pnpm build`、`tsconfig.build.json` 和 `deploy/deploy-server.sh`。
  运行包先由本地编译 TypeScript，再裁剪开发依赖，通过 ssh 同步到服务器
  `/opt/al1s/app`；Tuwunel 与 bridge 由 systemd 管理，appservice 端口只
  监听回环地址。
- 增加 `pnpm deploy:check` 和零依赖预检模块：严格解析 registration 模板所需
  YAML 子集，检查 token/ID/sender/namespace/URL 一致性、模板或弱 token、
  `receive_ephemeral`、`.env`/registration 权限和宿主机部署模式；
  真实 `deploy/appservice.yaml` 已加入 `.gitignore`。`matrix:check` 覆盖
  匹配、token 不一致、namespace 不匹配、错误 URL、模板 token 和缺字段。
- 部署使用上游预编译的 Tuwunel 二进制；更换 CPU 架构时需改用对应架构的
  发布产物。
- 本轮验证：`pnpm typecheck`、`pnpm matrix:check`、`pnpm integration:check`
  和 `git diff --check` 通过；`pnpm tuwunel:check` 在 Tuwunel 1.9.3 上通过。
  真实 QQ 与生产环境联调仍受凭据和部署环境阻塞。
- 本轮补充验证：`pnpm integration:check`（现含 `pnpm build`）、
  `pnpm tuwunel:check` 和 `node dist/scripts/matrix-check.js` 均通过。
- 宿主机部署模式复核：使用临时 `.env` 与 registration（权限均为 `600`）
  运行 `pnpm deploy:check -- --mode host`，身份、token、namespace 与
  `http://127.0.0.1:29328` URL 校验全部通过。
- 完成 QQ 结构化消息处理：`message_type=3` 从 `ark_data` 生成可读回退文本
  （保留 ark_name/prompt 与 title/desc/tag/source/nickname/address，忽略
  `jump_url` 等链接字段）；`101/102/103` 递归合并 `msg_elements` 正文，
  103 的顶层元素只进入引用 fallback，不重复写入正文。元素附件按文档顺序
  转发、按 URL 去重、跳过引用元素附件，并限制递归深度 4 层、64 个元素、
  16 个附件、正文 4096 字符与引用摘录 500 字符；超限截断并追加
  `[消息过长，已截断]`，结构化输入不会再被静默丢弃。
- 在 `matrix-check.ts` 新增“QQ 结构化消息”小节，覆盖 ARK 卡片回退与
  链接字段剔除、卡片与正文并存、101 并行消息合并、102 聊天记录递归、
  103 引用映射与正文去重、未知引用 fallback、嵌套附件转发、重复附件
  去重、附件/深度/元素/长度上限截断。
- `pnpm tuwunel:check` 增加 `message_type=101` 结构化消息用例：假 QQ 端口
  推送嵌套 `msg_elements`，断言合并正文经真实 Tuwunel 回推的 transaction
  与顶层文本一致。
- 本轮验证：`pnpm integration:check`（含 `typecheck`、`build`、`qq:check`、
  `matrix:check`、`webhook:check`）、`pnpm tuwunel:check`（Tuwunel 1.9.3）
  与 `git diff --check` 通过；真实 QQ 凭据与生产环境联调仍受外部条件阻塞。
- 扩展 `pnpm tuwunel:check` 的真实媒体链路：QQ 假端口提供 PNG，bridge
  上传到 Tuwunel 后断言 mxc 事件、下载字节与 MIME 一致；Matrix 媒体上传
  并回推 transaction 后，断言 bridge 下载原始字节并交给 QQ 媒体端口。
- 真实媒体检查发现 Tuwunel 1.9.3 默认拒绝旧版
  `/_matrix/media/v3/download` 未鉴权请求，`MatrixClient` 已改用
  `/_matrix/client/v1/media/download`；离线 mock 同步收紧，避免回归。
- 媒体扩展后重新验证：`pnpm typecheck`、`pnpm matrix:check`、
  `pnpm tuwunel:check` 与 `git diff --check` 全部通过。
- 扩展 `pnpm tuwunel:check` 的真实引用链：假 QQ 端口先写入带 `msg_idx` 的
  目标消息，再写入带 `ref_msg_idx` 的回复，断言 Tuwunel transaction 中的
  `m.in_reply_to` 指向目标 event；随后从 Matrix 发送引用事件，断言 bridge
  回传对应 QQ `message_reference`。
- 扩展 `pnpm tuwunel:check` 的真实撤回链：Matrix 用户撤回已映射的 QQ 出站
  消息，断言 Tuwunel 回推 `m.room.redaction` 后 bridge 调用 QQ recall。
- 扩展 `pnpm tuwunel:check` 的真实房间授权链：全局名单内的 Matrix 用户在
  power level 不足时发送消息，断言不调用 QQ；随后更新
  `m.room.power_levels`，断言同一用户消息经 Tuwunel 回推后成功交给 QQ。
- 增加 `pnpm matrix:admin`：`status` 汇总全局名单、房间成员资格、power
  level 与最终转发准入；`invite`/`kick` 要求显式本域 `--actor`，并兼容
  Tuwunel 返回的无 domain 本地 room ID。参数校验全部发生在解析 alias 或
  发起 HTTP 请求之前。
- 扩展 `pnpm tuwunel:check` 的真实成员生命周期：以房间 ghost 为 actor
  踢出已批准用户，断言其后续发送被 Tuwunel 拒绝且未调用 QQ；重新邀请并
  加入后，管理状态与 Matrix 到 QQ 转发均恢复。
- 状态升级为 schema v5：保留 v2/v3/v4 平滑迁移；guild 会话使用
  `guild/<guildId>/<channelId>`，出站目标为 channel ID；DM 使用
  `dm/<guildId>`，出站目标为 guild ID。guild/DM 均创建 direct 语义正确的
  room，并使用 5 分钟、无条数上限的被动回复窗口。
- `matrix-check.ts` 增加 guild/DM 回归：房间隔离、direct 字段、文本路由、
  媒体忽略、指标和窗口边界。`tuwunel-check.ts` 增加真实 Tuwunel 链路：
  QQ guild/DM 入站、Matrix 文本出站目标、媒体忽略并 ACK transaction。
- 本轮验证：`pnpm typecheck`、`pnpm matrix:check`、`pnpm integration:check`
  和 `pnpm tuwunel:check`（Tuwunel 1.9.3 固定 digest）通过；真实 QQ
  guild/DM 联调仍需有效凭据与可接消息环境。
- 扩展 `pnpm tuwunel:check` 的生产入口检查：先编译 TypeScript，再停止
  测试内嵌 appservice，以同一 registration、token、状态文件和监听端口
  启动 `dist/matrix-bridge.js`。检查通过 Ed25519 签名的假 QQ Webhook
  事件触发 QQ 入站，确认 room 与 ghost 消息已写入 Tuwunel，并验证
  `SIGTERM` 正常退出、退出后不再监听 appservice 端口。
- 本轮验证：`pnpm typecheck` 与 `pnpm tuwunel:check`（Tuwunel 1.9.3
  固定 digest）通过；真实 QQ 凭据与生产环境联调仍受外部条件阻塞。
- 修复打包运行包未复制 `pnpm-workspace.yaml` 与 `patches/` 导致的
  `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`。`pnpm build` 与运行包内
  `node dist/scripts/matrix-check.js` 均已通过；离线检查确认生产依赖完整。
- 增加 `pnpm ci:check` 和 GitHub Actions push/PR 门禁。该命令执行
  `pnpm integration:check`（含编译与全部离线检查）；本地完整运行通过，
  workflow YAML 语法解析通过。
- Appservice HTTP 错误按输入类型分类：超限请求体返回 `413 M_TOO_LARGE`，
  非法 JSON、transaction 类型和 transaction ID 编码返回 `400`，内部处理
  失败保留 `500`。`matrix-check` 断言客户端错误不会调用 transaction
  handler，并计入固定 `invalid` 指标。
- 生产入口将 `uncaughtException`、`unhandledRejection` 与信号退出统一到
  同一个关闭 Promise：先停止 Bot 与 appservice 接收端，等待 bridge 在途
  QQ 任务，再 flush store 和 Bot；严重异常立即设置非零 `process.exitCode`，
  避免进程继续运行在可能已损坏的状态。SIGTERM 正常退出码仍由生产入口
  检查覆盖。
- 本轮验证：`pnpm ci:check` 完整通过，覆盖离线检查、真实 Tuwunel 1.9.3
  生命周期和运行包内 `matrix-check`；新增的 `400`/`413` 分类与
  `bridge.flush` 在途任务等待均通过。
  `git diff --check` 通过。
- Appservice 关闭增加 `MATRIX_BRIDGE_SHUTDOWN_TIMEOUT_MS`：停止监听和
  空闲连接后，超时强制关闭滞留请求，避免慢客户端阻塞进程退出。关闭编排
  会在任一步失败后继续尝试 bridge、store 和 Bot 清理。`BridgeStore`
  写入失败后保留 dirty 状态，`flush()` 可重试并恢复落盘。
- `matrix-check` 新增滞留 HTTP 请求关闭测试和状态写入失败后恢复测试；
  `al1s-bridge.service` 设置 `TimeoutStopSec=45`，为默认 30 秒关闭预算
  留出退出余量。
- `tuwunel-check` 的生产入口场景新增滞留 appservice 请求：保持未完成
  transaction 请求后发送 `SIGTERM`，断言编译入口按 250ms 测试预算退出、
  返回正常退出码并释放监听端口。
- 状态文件保存增加 `fsync` 和目录同步：数据先写入同目录 `0600` 临时文件，
  同步后原子替换，最后同步父目录；失败时清理临时文件并保留 dirty 状态。
  新建状态目录使用 `0700`。`matrix-check` 断言恢复写入后的文件权限、新建
  目录权限以及失败后 `flush()` 可重试落盘。
- `tuwunel:check` 新增生产入口故障夹具：分别向编译入口注入
  `uncaughtException` 和 `unhandledRejection`，验证统一关闭路径、非零退出码
  和 appservice 端口释放。
- 文献源：Tuwunel `docs/appservices.md`、`src/service/appservice/request.rs`、
  `ping.rs`、`append.rs` 与 `src/api/router/auth/appservice.rs`。
