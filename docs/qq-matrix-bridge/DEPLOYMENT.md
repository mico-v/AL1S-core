# QQ Matrix Bridge 生产部署

## 部署边界

当前设计按单实例运行：一个 QQ 机器人账号、一个 bridge 状态文件和一个
Tuwunel homeserver。bridge 与 Tuwunel 不应水平扩容或并行共享状态文件。
首期只支持未加密房间，不支持 Matrix E2EE。
消息场景支持 QQ 群聊、单聊、频道和频道私信的双向文本。受 QQ
channel/DM API 限制，Matrix 到 guild/DM 的媒体发送当前会被明确忽略。
registration 保持 `receive_ephemeral: false`；typing、receipt 和在线状态
当前不映射到 QQ。

推荐拓扑（原生进程，无容器运行时）：

```text
QQ 开放平台
  ↕ WebSocket
AL1S bridge（systemd: al1s-bridge，Node）
  ↕ 仅回环 HTTP
Tuwunel（systemd: tuwunel）
  ↕ TLS
Caddy → Matrix 客户端
```

当前生产实例：

- SSH 别名为 `as`，源码检出位于 `/opt/al1s`，运行包位于 `/opt/al1s/app`；
  状态和 Tuwunel 数据位于 `/opt/al1s/data`。
- systemd 单元为 `al1s-bridge.service` 与 `tuwunel.service`；运行包目前对应
  `909eac0`，两者均为 active，`http://127.0.0.1:29328/health` 返回 `{}`。
- `git push as main` 只更新 `/opt/al1s` 源码检出，不会替换正在运行的
  `/opt/al1s/app` 或重启服务。让新代码生效必须在本地运行 `pnpm deploy:server`。

Appservice transaction 地址只需让 Tuwunel 访问，禁止直接暴露公网；同一
宿主机部署时监听 `127.0.0.1:29328`，Tuwunel 反向访问 `127.0.0.1:8008`。

## 源码构建与部署

服务器只运行编译产物，不编译 TypeScript，也不安装 pnpm。先在本地构建
仅含生产依赖的运行包，再由脚本同步到服务器并重启服务：

```bash
pnpm install
cp .env.example .env
cp deploy/appservice.example.yaml deploy/appservice.yaml
# 编辑两个文件中的 domain、tokens 与 MATRIX_BRIDGE_* 配置
chmod 600 .env deploy/appservice.yaml
pnpm deploy:check
pnpm deploy:server            # 本地 pnpm build → 打包 dist/ 与生产依赖 → ssh 同步 → 重启服务
```

`git push as main` 可同步源码检出，但部署运行版本以 `pnpm deploy:server`
为准。脚本会重新编译、安装生产依赖、覆盖 `/opt/al1s/app`，若本地存在
`deploy/appservice.yaml` 还会原子替换 registration 并重启 Tuwunel，最后
重启 bridge。

`deploy/deploy-server.sh` 使用 `AL1S_REMOTE`（默认 `as`）、
`AL1S_REMOTE_DIR`（默认 `/opt/al1s`）和 `AL1S_SERVICE`（默认
`al1s-bridge`）三个环境变量覆盖默认值。它把运行包同步到
`/opt/al1s/app`，其中包含 `dist/`、`package.json` 和生产 `node_modules`，
服务器直接以 `node dist/matrix-bridge.js` 启动。

## 首次配置服务器

目录与用户（root 执行一次）：

```bash
useradd --system --no-create-home --shell /sbin/nologin tuwunel
useradd --system --no-create-home --shell /sbin/nologin al1s
mkdir -p /opt/al1s/{bin,tuwunel/appservices,data/tuwunel,data/matrix-bridge,app,logs}
```

### Tuwunel

使用上游预编译二进制，避免在服务器编译 Rust（WASM 之外的 Cargo 构建在
弱 CPU 上非常慢）：

```bash
# 本地下载 v1.9.3 x86_64-v1 linux-gnu 的 .deb 或 .zst，取出 /usr/sbin/tuwunel
# 之后拷贝到服务器
scp tuwunel as:/opt/al1s/bin/tuwunel
ssh as 'chmod 0755 /opt/al1s/bin/tuwunel && /opt/al1s/bin/tuwunel --version'
```

配置模板见 [`../../deploy/tuwunel.toml.example`](../../deploy/tuwunel.toml.example)，
复制到 `/opt/al1s/tuwunel/tuwunel.toml` 并修改 `server_name`、
`database_path`、`appservice_dir` 与 `[global.well_known] client`。
registration 复制到 `/opt/al1s/tuwunel/appservices/<id>.yaml`，权限 `600`、
属主 `tuwunel`。`server_name` 必须与 `MATRIX_BRIDGE_DOMAIN`、registration
namespace 以及反向代理域名一致。

### systemd 单元

仓库提供两个单元模板：

- [`../../deploy/systemd/tuwunel.service`](../../deploy/systemd/tuwunel.service)
- [`../../deploy/systemd/al1s-bridge.service`](../../deploy/systemd/al1s-bridge.service)

复制到 `/etc/systemd/system/`，然后：

```bash
systemctl daemon-reload
systemctl enable --now tuwunel.service
systemctl enable --now al1s-bridge.service
```

两个单元都使用 `ProtectSystem=strict`，只把数据目录设为可写；`.env` 与
registration 以 `600` 权限由各自的运行用户持有。bridge 的
`EnvironmentFile` 从 `/opt/al1s/.env` 读取 QQ 凭据与 `MATRIX_BRIDGE_*`，
并以 `Environment=` 覆盖为回环地址与状态文件路径。

## 反向代理

Tuwunel 只监听 `127.0.0.1:8008`，由反向代理终止 TLS。Caddy 示例：

```caddy
matrix.st.mioc.cc {
	log {
		output file /var/log/caddy/matrix_access.log {
			roll_size 20MiB
			roll_keep 5
		}
		format json
	}
	encode zstd gzip
	reverse_proxy 127.0.0.1:8008
}
```

`matrix.st.mioc.cc` 必须解析到该服务器并开放 80/443。Tuwunel 的
`[global.well_known] client` 指向同一地址后，`/.well-known/matrix/client`
会自动使客户端发现 homeserver。

## 创建首个 Matrix 用户与授权

`allow_registration = false` 时服务端不开放自助注册。首次需要人工创建账号
时，临时把 `tuwunel.toml` 的 `allow_registration` 设为 `true`，重启
Tuwunel，用客户端或 CS API 注册，然后改回 `false` 并再次重启：

```bash
systemctl stop tuwunel
sed -i 's/^allow_registration = false/allow_registration = true/' /opt/al1s/tuwunel/tuwunel.toml
systemctl start tuwunel
# 在客户端（homeserver: https://matrix.st.mioc.cc）注册，或调用
# POST /_matrix/client/v3/register
systemctl stop tuwunel
sed -i 's/^allow_registration = true/allow_registration = false/' /opt/al1s/tuwunel/tuwunel.toml
systemctl start tuwunel
```

创建账号后，把用户 ID 写入 `.env` 的 `MATRIX_BRIDGE_ALLOWED_SENDERS`
（逗号分隔，`*` 表示显式允许所有用户），再重启 `al1s-bridge`。发送者仍需
是目标 QQ 映射房间的已加入成员并达到 `MATRIX_BRIDGE_MIN_POWER_LEVEL`；
默认空名单下 Matrix 到 QQ 会全部拒绝。

## 部署前检查

`pnpm deploy:check` 默认读取 `.env` 和 `deploy/appservice.yaml`，按宿主机
部署模式校验，验证：

- 两个文件均只允许所有者访问；
- registration ID、`as_token`、`hs_token` 和 sender localpart 与 `.env` 一致；
- `receive_ephemeral` 为 `false`，且 token 不为模板值或重复使用；
- users/aliases namespace 能匹配 bridge 实际生成的 ghost 用户和房间别名；
- registration URL 为 `http://127.0.0.1:29328`。

Tuwunel 与 bridge 不同主机时，用 `--bridge-url http://<host>:29328` 覆盖
预期地址。自定义文件路径可传 `--env` 和 `--registration`。真实
registration 已被 `.gitignore` 排除；不要将其中 token 提交到仓库。

## 密钥与配置

- 从 `appservice.example.yaml` 生成 registration，替换全部 token、域名和
  namespace 正则；`as_token` 与 `hs_token` 必须不同、至少 32 字符且使用
  高熵随机值。
- `.env` 权限设为 `600`，不要进入日志、备份仓库或任何构建产物。
- `MATRIX_BRIDGE_IDENTITY_SECRET` 同时决定 ghost 身份和状态解密，必须长期
  保存且不可轮换。丢失后旧状态无法解密，QQ 用户也会映射为新 ghost。
- 可轮换 `as_token` / `hs_token`，但必须原子更新 Tuwunel registration 与
  bridge 配置并重启服务。
- `MATRIX_BRIDGE_ALLOWED_SENDERS` 是部署级基线；实际发送者还必须加入目标
  Matrix room，并达到 `MATRIX_BRIDGE_MIN_POWER_LEVEL`。

## 持久化与备份

Tuwunel 数据库（`database_path`）和 `MATRIX_BRIDGE_DATA_FILE` 必须位于持久
磁盘。状态文件已用 AES-256-GCM 加密字段、HMAC 隐藏索引，但仍应按敏感数据
保护。bridge 会以 `0700` 创建缺失的状态目录，并以 `0600` 写入状态文件。
每次保存先写入同目录临时文件，完成 `fsync` 后原子替换，再同步目录；不要把
状态文件放在不支持原子重命名或持久化的临时文件系统中。

QQ 入站消息会先写入该状态文件的加密待处理队列，再执行 Matrix 投递。
bridge 启动时立即重放到期消息，运行期间每 5 秒检查一次；失败按默认 5 秒
起步、最大 5 分钟指数退避。可调整：

```bash
MATRIX_BRIDGE_QQ_RETRY_BASE_MS=5000
MATRIX_BRIDGE_QQ_RETRY_MAX_MS=300000
MATRIX_BRIDGE_QQ_RETRY_INTERVAL_MS=5000
MATRIX_BRIDGE_QQ_QUEUE_MAX_ENTRIES=10000
```

队列达到上限后，新消息会记录错误并丢弃，不会继续无界占用磁盘。重放媒体
可能重复上传临时 Matrix 对象，但确定性 transaction ID 会避免重复 Matrix
事件。

备份顺序：

1. 停止 bridge，确保 `flush()` 完成。
2. 备份状态文件和 Tuwunel 数据库，或使用同一时点的存储快照。
3. 单独备份 `.env` 和 appservice registration。
4. 恢复后先检查 `/health`、appservice ping 和一条测试消息。

不要在 bridge 运行时直接覆盖状态文件。引用映射默认保留 30 天、最多
10,000 条；调整 TTL 或容量前先备份。

## 启动与检查

```bash
pnpm install --frozen-lockfile
pnpm integration:check   # typecheck + build + 全部离线检查
TUWUNEL_BIN=/path/to/tuwunel pnpm tuwunel:check   # 本机 Tuwunel 双向集成检查
```

`pnpm integration:check` 依次执行类型检查、编译、配置/协议/Matrix/webhook
离线检查。CI 工作流位于 `.github/workflows/ci.yml`，在 push 和 pull request
上使用相同的 Node、pnpm 与命令，避免本地通过而远端门禁遗漏。
`pnpm tuwunel:check` 直接启动本机 Tuwunel 二进制，不依赖任何容器运行时，
也不连接 QQ 开放平台。

QQ 到 Matrix 的消息语义当前包括：`<@OPENID>` 转可读提及、HTML 链接和
`m.mentions`，引用索引变体与 `TMP_*` 唯一匹配回退，`faceType` 表情名解码，
内部 `attachmentType`/`*Type=` 标签清理，以及 SHA-256 媒体去重和 Matrix
上传复用。部署后应分别用群聊、单聊、提及、引用、表情包和图片各发一条测试
消息，确认 Matrix 事件正文和媒体 URI。

Matrix 到 QQ 当前会把已映射 ghost 的 `m.mentions.user_ids` 转为
官方 `<qqbot-at-user id="..." />`，并使用 schema v8 的加密反向映射支持重启
恢复。QQ 只在 Markdown 消息中解析提及，因此含标签的正文会强制使用
`msg_type=2`，部署时必须设置 `QQBOT_MARKDOWN_SUPPORT=true`。普通正文仍使用
`msg_type=0`；含高置信度 Markdown 语法但不含提及的正文同样需要该开关才能
使用 Markdown。
部署验收应额外覆盖 Matrix 侧 @ QQ 用户、Markdown 标题/列表/代码和带引用的
Markdown 消息。

`MATRIX_BRIDGE_SHUTDOWN_TIMEOUT_MS` 默认 30 秒，控制关闭时等待 appservice
活跃请求的上限；超时后会强制关闭滞留连接，由 Tuwunel 重试未确认的
transaction。该值应覆盖在途 Matrix 请求时间，并小于 systemd 的
`TimeoutStopSec`（`al1s-bridge.service` 为 45 秒）。

QQ SDK 基线固定为 `@tencent-connect/qqbot-nodejs@1.0.4`，并通过
`patches/@tencent-connect__qqbot-nodejs@1.0.4.patch` 增加 guild/DM 文本与
撤回路由。`pnpm install --frozen-lockfile` 会应用该 patch；不要单独升级
SDK，升级时必须同步适配 patch 并重新运行 `pnpm integration:check` 与
`pnpm tuwunel:check`。

`deploy/deploy-server.sh` 在打包生产依赖前复制 `pnpm-workspace.yaml` 和
`patches/`，使运行包内 `patchedDependencies` 与 `pnpm-lock.yaml` 保持一致。
不要移除这两个输入，否则 `pnpm install --frozen-lockfile` 会以
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` 失败。

WebSocket 模式默认使用 SDK `FULL_INTENTS`，其中包含
`PUBLIC_GUILD_MESSAGES`（`1 << 30`）和 `DIRECT_MESSAGE`（`1 << 12`）。若
设置 `QQBOT_INTENTS`，必须保留所需位；QQ 平台未授予对应权限时，网关会
拒绝连接而不是仅丢失事件。

上线后检查：

```bash
curl -fsS http://127.0.0.1:29328/health
curl -fsS http://127.0.0.1:29328/metrics | head
journalctl -u tuwunel --no-pager -n 100
journalctl -u al1s-bridge --no-pager -n 100
```

QQ 到 Matrix 的入站不经过 `MATRIX_BRIDGE_ALLOWED_SENDERS`；该名单只限制
Matrix 到 QQ。若群聊有消息但单聊没有，先确认 QQ 平台已给机器人开放单聊
消息权限，并检查自定义 `QQBOT_INTENTS` 是否包含 `GROUP_AND_C2C`（`1<<25`）
或等价的单聊 intent。随后查看 bridge 日志中是否收到对应 QQ 事件；只有
Matrix 房间缺少成员并不代表 QQ 消息没有到达。

确认 Tuwunel 能加载 appservice、ping 返回 200、appservice bot 仍为每个映射
房间的 `join` 成员。bot 被踢出或房间状态查询失败时，bridge 会按失败关闭
处理，Matrix 到 QQ 的 transaction 将重试而不是绕过授权。

## 房间成员运维

使用 `pnpm matrix:admin` 查询成员资格、power level 和转发准入：

```bash
pnpm matrix:admin status --room '!room-id' --user '@alice:example.org'
pnpm matrix:admin invite --room '!room-id' --user '@alice:example.org' \
  --actor '@_qq_<digest>:example.org'
pnpm matrix:admin kick --room '!room-id' --user '@alice:example.org' \
  --actor '@_qq_<digest>:example.org' --reason 'policy review'
```

`invite` 和 `kick` 的 `--actor` 必须是本 homeserver 用户，并由 Tuwunel
检查其房间权限。通常使用创建映射房间的 ghost，或另一个 power level 足够
的管理员。命令会以该用户身份通过 appservice token 执行，因此 `.env`
只应交给受信任的运维人员。

踢出成员会立即撤销转发资格，无需重启 bridge；重新邀请并让用户接受加入后
自动恢复。`status` 同时显示全局名单、成员资格、power level 和最终是否可
转发，排障时应先运行它确认拒绝原因。

## 指标与告警

`/metrics` 是 Prometheus 文本格式，且与 `/health` 一样不鉴权，只应通过
内网地址或受控反向代理访问。默认监听 `127.0.0.1`，不要让该端口直接暴露
到公网。

示例文件：

- `prometheus.example.yml`：抓取 `al1s-matrix-bridge` job；Prometheus 不在
  同一主机时，把 target 改为 bridge 的内网地址。
- `alerts.example.yml`：覆盖 bridge 宕机、transaction 失败、状态写入失败、
  QQ 恢复持续触发和 transaction 长时间无成功 ACK。

指标只使用固定枚举标签，不包含用户、房间、消息或凭据标识。状态写入失败
会触发 critical 告警；应先检查磁盘容量、挂载和权限，再决定是否重启。

## 运维与限制

- 监控 bridge 进程、Tuwunel、状态文件空间、transaction 失败日志和 QQ 频控
  告警；将示例规则接入实际 Prometheus/Alertmanager。
- 升级前停止服务并备份；升级后运行 `pnpm integration:check`，再用
  `pnpm deploy:server` 同步运行包。
- 每个 QQ 会话只映射一个 Matrix room；不要把 room alias 当作授权凭证。
- QQ 主动消息受平台频控，被动回复窗口过期后会降级；网络超时不会自动重发。
- QQ 群聊/单聊没有公开的撤回事件，因此暂不支持 QQ 撤回同步为 Matrix
  redaction。
- QQ guild/DM 文本使用 channel/DM API 路由；Matrix 到 guild/DM 的媒体没有
  对应官方发送能力，bridge 会忽略该媒体并确认 transaction。
- Webhook transport 在完成验签后立即向 QQ 平台返回 ACK，随后才异步处理
  并持久化消息；“平台 ACK 后、bridge 入队前”的极小崩溃窗口无法由 bridge
  消除，需要平台重投或上层补偿策略覆盖。
