# AL1S-core Docker 部署指南

本仓库已提供 `Dockerfile`、`docker-compose.yml`、`.dockerignore`、`deploy/healthcheck.mjs`。
多阶段构建：管理前端 Vite 构建 → 运行时（tsx + Python 3 + 中文字体 + 原生依赖）。容器启动时默认跳过嵌套 sandbox 镜像构建（`MSP_SANDBOX_BOOTSTRAP=false`），避免网络超时阻塞 Bot；需要构建时可显式设为 `true`。缺失或构建失败的 sandbox 始终报告不可用并拒绝执行，不会伪装成已隔离。
容器 entrypoint 只以 root 修正宿主 `data/` 对 uid 10001 的访问权限，随后降权运行 Bot；broker socket 位于临时 `/run/al1s`，不写入持久化 data。
本部署使用 bridge 网络，Bot 不依赖 `network_mode: host`，也不把容器内 `127.0.0.1` 当作宿主机 SnowLuma。`SNOWLUMA_WS_URL`（以及可选的 `SNOWLUMA_HTTP_URL`）由部署目录 `.env` 注入，必须填写 Bot 容器可访问的远端或宿主地址。管理后台在容器内绑定 `0.0.0.0`，仅通过宿主 `127.0.0.1:6185` 发布。

## Python CLI

运行时镜像内提供 `python` 和 `python3`，并启用非缓冲输出。命令文本完整交给 bash，因此 heredoc、管道和重定向均可使用。聊天 `$` 命令和 Agent `exec_command` 都经过同一个 `SessionCommandRunner`，不会直接调用宿主 shell。

## 执行隔离与持久工作区

生产默认 `MSP_RUNTIME_MODE=podman`，要求 rootless Podman 可用；每个 `chatId` 使用 `data/msp-workspace/sessions/<hash>` 独立持久目录。Podman 命令固定使用 `--network=none`、只读 rootfs、`--cap-drop=ALL`、`no-new-privileges`、pids/memory/cpu 限额和受限 `/tmp`。不挂载宿主 Docker/Podman socket，不接受任意 host path、`privileged` 或 host network。

如果当前机器没有 Podman，服务必须明确报告“sandbox 不可用”，不能假装 local-bash 已隔离。离线开发检查可显式使用 `MSP_RUNTIME_MODE=local-bash` 与 `MSP_ALLOW_LOCAL_BASH_FALLBACK=true`，该模式只用于测试。

插件 CLI 的 stdout、stderr、exitCode 与 OneBot effects 分离；xxt/course 的宿主状态只能经认证 broker capability 调用。容器 sandbox 只挂载固定路径 `/run/al1s/command.sock` 的受限应用 broker，绝不挂载 Docker/Podman socket、宿主根目录或任意用户指定 socket。

---

## 1. 安装 Docker

### 你的本地开发机（WSL2 + Arch Linux）

```bash
# 1) 更新 + 安装 docker（Arch 的 docker 包自带 compose v2 插件）
sudo pacman -Syu
sudo pacman -S docker

# 2) 启动 docker 守护进程
#    如果你的 WSL2 开了 systemd：
sudo systemctl enable --now docker
#    如果没开 systemd，用 service 方式：
#    sudo service docker start

# 3) 把当前用户加入 docker 组（免 sudo 使用 docker），然后重新登录终端
sudo usermod -aG docker $USER
#    或临时生效：newgrp docker

# 4) 验证
docker version
docker run --rm hello-world   # 能打印 Hello from Docker! 即成功
```

> 注意：Arch 不要装旧版 `docker-compose`（Python v1 已废弃）；
> 用 `docker compose`（v2 插件）即可。WSL2 内存不足时可在 `.wslconfig` 调大
> `memory=`（构建前端 Vite 需要几百 MB）。

### 服务器（Ubuntu / Debian 系，最常见）

```bash
# 1) 安装（docker.io 含 compose v2；Ubuntu 24.04 装 docker-compose-v2）
sudo apt update
sudo apt install -y docker.io docker-compose-v2

# 2) 开机自启 + 启动
sudo systemctl enable --now docker

# 3) 加入 docker 组，重新登录后免 sudo
sudo usermod -aG docker $USER
# 重新 ssh 登录一次再执行后续命令

# 4) 验证
docker version && docker compose version
```

> 若服务器是 CentOS/Rocky：`sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin`（需先配 docker-ce 源）。
> 若你在云服务器上跑，务必确认安全组/防火墙：**不要**对公网开放 6185 端口。

---

## 2. 构建镜像

在源码目录先运行离线集成检查：

```bash
npm run integration:check
```

该检查会真实执行 bash 管道、重定向、插件 wrapper、broker capability 和会话工作区持久化；`sandbox:check` 还会先验证生产 Podman 后端不可用时不会回退成“已隔离”。

```bash
cd /path/to/AL1S-core
# 构建（.dockerignore 已排除 .env / data / node_modules / ref，密钥不会进镜像）
docker compose build

# 验证镜像内容安全（应看不到密钥文件）
docker run --rm --entrypoint sh al1s-bot:latest -c "ls /app && echo '---' && ls /app/data 2>&1 || true"
```

## 3. 推送到服务器（二选一）

### 方式 A：镜像仓库（推荐，多台服务器/后续升级方便）

```bash
# 推到 Docker Hub / GHCR / 自建 Harbor 等
docker tag al1s-bot:latest <registry>/<namespace>/al1s-bot:latest
docker login <registry>        # 输入账号密码/Token
docker push <registry>/<namespace>/al1s-bot:latest
```

### 方式 B：单台服务器，直接传 tar 包

```bash
# 本地
docker save al1s-bot:latest | gzip > al1s-bot.tar.gz
scp al1s-bot.tar.gz user@server:/tmp/

# 服务器上
docker load < /tmp/al1s-bot.tar.gz
```

---

## 4. 在服务器上部署

```bash
# 1) 把仓库放到服务器（只含源码，.env/data 不会带过去）
git clone <你的仓库地址> AL1S-core && cd AL1S-core
# （没有 git 仓库的话 scp 源码目录即可，记得排除 .env、data）

# 2) 准备 .env —— 关键必改项！
cp .env.example .env
vim .env
```

`.env` 里这几项**必须确认**：

| 变量 | 部署要求 |
|---|---|
| `SNOWLUMA_WS_URL` | 使用 bot 容器可访问的 SnowLuma 地址（不要依赖 host network 的 127.0.0.1）|
| `MSP_RUNTIME_MODE` | **`podman`**（生产默认；没有 rootless Podman 时拒绝启动执行）|
| `MSP_ALLOW_LOCAL_BASH_FALLBACK` | **`false`**；仅离线开发临时设为 `true` |
| `MSP_CONTAINER_IMAGE` | sandbox 镜像名，默认 `al1s-sandbox:latest`；启用引导时由 entrypoint 尝试构建 |
| `SNOWLUMA_TOKEN` | 与 SnowLuma OneBot 配置一致 |
| `LLM_API_KEY` | 填服务器用的密钥 |
| `ADMIN_TOKEN` | **必填**（不填管理后台不启动）|
| `SHELL_ENABLED` | **`false`**（`$` 与 Agent 共用 sandbox runner）|
| `LOG_FILE` | 留空（日志走 stdout → `docker logs` 收集）|
| `TZ=Asia/Shanghai` | compose 里已注入，课表/课堂提醒依赖本地时区 |

```bash
# 3) 拉镜像（方式A：同文件往 compose 的 image 名改成你的仓库 tag 后 pull）
docker compose pull

# 默认启动：不构建 sandbox，Bot 会持续运行并继续尝试连接 SnowLuma
docker compose up -d

# 可选：确认网络与 rootless Podman 均可用后，显式构建缺失 sandbox（构建失败仍不影响 Bot 启动）
MSP_SANDBOX_BOOTSTRAP=true docker compose up -d

# 5) 看日志，确认「就绪，等待事件……」
docker compose logs -f
```

## 5. 访问管理后台

管理后台只监听服务器本机 127.0.0.1，用它时从你电脑建 SSH 隧道：

```bash
ssh -L 6185:127.0.0.1:6185 user@server
# 然后浏览器打开 http://127.0.0.1:6185 ，登录 Token 就是 .env 里的 ADMIN_TOKEN
```

## 6. 日常运维

```bash
docker compose ps                 # 状态 + health 健康检查
docker compose logs -f --tail=200 # 看日志
docker compose restart            # 重启
docker compose down               # 停止并删除容器（data/ 卷保留，数据不丢）

# 升级：拉新代码 → 重建 → 滚动重启
git pull
docker compose up -d --build
```

备份数据 = 备份服务器上的 `data/` 目录（包含会话历史、设置覆盖层、课程表、插件开关）。

## 7. 常见坑

- **SnowLuma 未就绪时不会让 Bot 退出**：首次连接失败由应用按退避策略持续重试；已建立连接后的断线由 SDK 自动重连。日志会记录连接阶段、脱敏后的 endpoint 和下一次重试时间。
- **容器里日志文件路径是容器内路径**：`LOG_FILE` 若要开，写 `/tmp/bot.log` 这类即可
  （或干脆不开，用 `docker logs`）。
- **改 `.env` 后要 `docker compose up -d`（重建容器）才生效**——因为启动时读取环境变量；
  运行时改设置请用管理后台（写 `data/settings.json`，热生效）。
- **ssh 隧道掉了管理后台就连不上**：重连隧道即可，bot 不受影响。