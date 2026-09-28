# QQ Matrix Bridge 生产部署

## 部署边界

当前设计按单实例运行：一个 QQ 机器人账号、一个 bridge 状态文件和一个
Tuwunel homeserver。bridge 与 Tuwunel 不应水平扩容或并行共享状态文件。
首期只支持未加密房间，不支持 Matrix E2EE。
消息场景支持 QQ 群聊、单聊、频道和频道私信的双向文本。受 QQ
channel/DM API 限制，Matrix 到 guild/DM 的媒体发送当前会被明确忽略。
registration 保持 `receive_ephemeral: false`；typing、receipt 和在线状态
当前不映射到 QQ。

推荐拓扑：

```text
QQ 开放平台
  ↕ WebSocket
AL1S bridge
  ↕ 仅内网 HTTP
Tuwunel
  ↕ TLS
Matrix 客户端 / 反向代理
```

Appservice transaction 地址只需让 Tuwunel 访问，禁止直接暴露公网。同一
宿主机可监听 `127.0.0.1`；容器部署应使用专用 Docker network，或按
`PLAN.md` 的 `host.docker.internal` 示例配置。

## Compose 部署

`deploy/compose.example.yml` 提供单实例 Tuwunel 与 bridge 模板。先创建并
修改生产配置，再运行部署前检查和 Compose 校验：

```bash
cp deploy/appservice.example.yaml deploy/appservice.yaml
cp .env.example .env
# 编辑两个文件中的 domain、tokens、namespace 与 MATRIX_BRIDGE_* 配置
chmod 600 .env deploy/appservice.yaml
pnpm deploy:check
docker compose --env-file .env -f deploy/compose.example.yml config --quiet
docker compose --env-file .env -f deploy/compose.example.yml up -d --build
docker compose --env-file .env -f deploy/compose.example.yml ps
```

Compose 中 registration 的 `url` 必须是 `http://bridge:29328`，而 `.env`
里的 `MATRIX_BRIDGE_HOMESERVER_URL` 会在容器内覆盖为
`http://tuwunel:6167`。只把 Tuwunel 的 `127.0.0.1:8008` 暴露给反向代理；
bridge 的 `29328` 只在 Compose 内网可达。Tuwunel 与 bridge 各自使用命名
卷，`docker compose down` 默认不会删除数据。

Dockerfile 默认固定 Node 24.13.0 的 `linux/amd64` 已验证 digest。ARM64
构建前先用 `docker buildx imagetools inspect node:24.13.0-bookworm-slim`
确认多架构 index digest，再通过 `NODE_BASE_IMAGE` 覆盖，例如：

```bash
NODE_BASE_IMAGE='node:24.13.0-bookworm-slim@sha256:<verified-index-digest>' \
  docker compose --env-file .env -f deploy/compose.example.yml build
```

## 部署前检查

`pnpm deploy:check` 默认读取 `.env` 和 `deploy/appservice.yaml`，验证：

- 两个文件均只允许所有者访问；
- registration ID、`as_token`、`hs_token` 和 sender localpart 与 `.env` 一致；
- `receive_ephemeral` 为 `false`，且 token 不为模板值或重复使用；
- users/aliases namespace 能匹配 bridge 实际生成的 ghost 用户和房间别名；
- registration URL 符合当前部署模式。

宿主机进程部署使用：

```bash
pnpm deploy:check -- --mode host
```

若 Tuwunel 在容器内而 bridge 在宿主机运行，registration 通常使用
`host.docker.internal`，此时显式传入实际地址：

```bash
pnpm deploy:check -- --bridge-url http://host.docker.internal:29328
```

自定义文件路径可传 `--env` 和 `--registration`。真实 registration 已被
`.gitignore` 排除；不要将其中 token 提交到仓库。

## 密钥与配置

- 从 `appservice.example.yaml` 生成 registration，替换全部 token、域名和
  namespace 正则；`as_token` 与 `hs_token` 必须不同、至少 32 字符且使用
  高熵随机值。
- `.env` 权限设为 `600`，不要进入镜像、日志或备份仓库。
- `MATRIX_BRIDGE_IDENTITY_SECRET` 同时决定 ghost 身份和状态解密，必须长期
  保存且不可轮换。丢失后旧状态无法解密，QQ 用户也会映射为新 ghost。
- 可轮换 `as_token` / `hs_token`，但必须原子更新 Tuwunel registration 与
  bridge 配置并重启服务。
- `MATRIX_BRIDGE_ALLOWED_SENDERS` 是部署级基线；实际发送者还必须加入目标
  Matrix room，并达到 `MATRIX_BRIDGE_MIN_POWER_LEVEL`。

## 持久化与备份

Tuwunel 数据库和 `MATRIX_BRIDGE_DATA_FILE` 必须位于持久卷。状态文件已用
AES-256-GCM 加密字段、HMAC 隐藏索引，但仍应按敏感数据保护。
bridge 会以 `0700` 创建缺失的状态目录，并以 `0600` 写入状态文件。每次
保存先写入同目录临时文件，完成 `fsync` 后原子替换，再同步目录；不要把
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
pnpm ci:check        # 与 GitHub Actions 相同的完整门禁
pnpm bridge
```

`pnpm ci:check` 会依次执行离线检查、真实 Tuwunel 双向检查、Compose 配置
校验、生产镜像构建和镜像内 `matrix-check`。CI 工作流位于
`.github/workflows/ci.yml`，在 push 和 pull request 上使用相同的 Node、
pnpm 与命令，避免本地通过而远端门禁遗漏。

`MATRIX_BRIDGE_SHUTDOWN_TIMEOUT_MS` 默认 30 秒，控制关闭时等待 appservice
活跃请求的上限；超时后会强制关闭滞留连接，由 Tuwunel 重试未确认的
transaction。该值应覆盖在途 Matrix 请求时间，并小于容器的
`stop_grace_period`。Compose 模板为 bridge 设置 45 秒宽限期。

`pnpm tuwunel:check` 使用临时容器、随机端口和一次性 volume，不会连接 QQ
开放平台；它不读取生产 `.env`，也不会修改现有 Tuwunel 数据。检查会编译
并启动真实入口 `dist/matrix-bridge.js`，用带合法 Ed25519 签名的假 QQ
Webhook 事件验证健康检查、registration ping、QQ 到 Tuwunel 入站、SIGTERM
优雅退出和端口释放。

QQ SDK 基线固定为 `@tencent-connect/qqbot-nodejs@1.0.4`，并通过
`patches/@tencent-connect__qqbot-nodejs@1.0.4.patch` 增加 guild/DM 文本与
撤回路由。`pnpm install --frozen-lockfile` 会应用该 patch；不要单独升级
SDK，升级时必须同步适配 patch 并重新运行 `pnpm integration:check` 与
`pnpm tuwunel:check`。

Dockerfile 会在冻结安装前复制 `pnpm-workspace.yaml` 和 `patches/`，使镜像
内 `patchedDependencies` 与 `pnpm-lock.yaml` 保持一致。不要移除这两个构建
输入，否则 `pnpm install --frozen-lockfile` 会以
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` 失败。

WebSocket 模式默认使用 SDK `FULL_INTENTS`，其中包含
`PUBLIC_GUILD_MESSAGES`（`1 << 30`）和 `DIRECT_MESSAGE`（`1 << 12`）。若
设置 `QQBOT_INTENTS`，必须保留所需位；QQ 平台未授予对应权限时，网关会
拒绝连接而不是仅丢失事件。

上线后检查：

```bash
curl -fsS http://127.0.0.1:29328/health
curl -fsS http://127.0.0.1:29328/metrics | head
docker logs --tail 100 <tuwunel-container>
```

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
内网地址或受控反向代理访问。默认监听 `127.0.0.1`；容器部署时使用专用
Docker network，不要让该端口直接暴露到公网。

示例文件：

- `prometheus.example.yml`：抓取 `al1s-matrix-bridge` job；Prometheus 在
  容器内运行时，把 target 改为 bridge 的内网 DNS 名称。
- `alerts.example.yml`：覆盖 bridge 宕机、transaction 失败、状态写入失败、
  QQ 恢复持续触发和 transaction 长时间无成功 ACK。

指标只使用固定枚举标签，不包含用户、房间、消息或凭据标识。状态写入失败
会触发 critical 告警；应先检查持久卷容量、挂载和权限，再决定是否重启。

## 运维与限制

- 监控 bridge 进程、Tuwunel、状态文件空间、transaction 失败日志和 QQ 频控
  告警；将示例规则接入实际 Prometheus/Alertmanager。
- 升级前停止服务并备份；升级后运行 `pnpm integration:check`。
- 每个 QQ 会话只映射一个 Matrix room；不要把 room alias 当作授权凭证。
- QQ 主动消息受平台频控，被动回复窗口过期后会降级；网络超时不会自动重发。
- QQ 群聊/单聊没有公开的撤回事件，因此暂不支持 QQ 撤回同步为 Matrix
  redaction。
- QQ guild/DM 文本使用 channel/DM API 路由；Matrix 到 guild/DM 的媒体没有
  对应官方发送能力，bridge 会忽略该媒体并确认 transaction。
- Webhook transport 在完成验签后立即向 QQ 平台返回 ACK，随后才异步处理
  并持久化消息；“平台 ACK 后、bridge 入队前”的极小崩溃窗口无法由 bridge
  消除，需要平台重投或上层补偿策略覆盖。
