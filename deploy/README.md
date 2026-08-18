# AL1S-core Docker 部署指南

本仓库已提供 `Dockerfile`、`docker-compose.yml`、`.dockerignore`、`deploy/healthcheck.mjs`。
多阶段构建：镜像内自动完成「管理前端 Vite 构建 → 运行时（tsx + 中文字体 + 原生依赖）」，
**无需在宿主机安装 Node**。

## 0. 部署形态

```
[QQ群] ⇄ SnowLuma 实例(宿主机 127.0.0.1:3000/3001) ⇄ AL1S bot(容器, host 网络)
                     ⇅
            管理后台 127.0.0.1:6185（SSH 隧道访问）
```

- `network_mode: host`：容器直接用宿主机网络，连 `ws://127.0.0.1:3001` 无需改配置；
  管理后台也只监听 127.0.0.1（服务器本机）。
- 密钥（LLM API Key、ADMIN_TOKEN、SnowLuma token）全部走服务器上的 `.env`，**不进镜像**。

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

```bash
cd /path/to/AL1S-core

# 构建（.dockerignore 已排除 .env / data / node_modules / ref，密钥不会进镜像）
docker compose build

# 验证镜像内容安全（应看不到密钥文件）
docker run --rm --entrypoint sh al1s-bot:latest -c "ls /app && echo '---' && ls /app/data 2>&1 || true
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
| `SNOWLUMA_WS_URL` | 保持 `ws://127.0.0.1:3001/`（SnowLuma 与 bot 同机，host 网络直连）|
| `SNOWLUMA_TOKEN` | 与 SnowLuma OneBot 配置一致 |
| `LLM_API_KEY` | 填服务器用的密钥 |
| `ADMIN_TOKEN` | **必填**（不填管理后台不启动）|
| `SHELL_ENABLED` | **`false`**（开发期默认 true，公网绝不能开）|
| `LOG_FILE` | 留空（日志走 stdout → `docker logs` 收集）|
| `TZ=Asia/Shanghai` | compose 里已注入，课表/课堂提醒依赖本地时区 |

```bash
# 3) 拉镜像（方式A：同文件往 compose 的 image 名改成你的仓库 tag 后 pull）
docker compose pull

# 4) 启动
mkdir -p data                      # 数据目录（会话/课表/设置/插件开关落这里）
docker compose up -d

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

- **SnowLuma 未就绪时启动会崩（已知行为）**：SDK 的 `reconnect: true` 只覆盖运行期断线重连，
  启动时连不上 `SNOWLUMA_WS_URL` 会抛未捕获异常直接退出。compose 已配置
  `restart: unless-stopped` + 指数退避自动重启，SnowLuma 起来后第二次启动即可连上；
  建议先启动 SnowLuma 再 `docker compose up -d`。
- **容器里日志文件路径是容器内路径**：`LOG_FILE` 若要开，写 `/tmp/bot.log` 这类即可
  （或干脆不开，用 `docker logs`）。
- **改 `.env` 后要 `docker compose up -d`（重建容器）才生效**——因为启动时读取环境变量；
  运行时改设置请用管理后台（写 `data/settings.json`，热生效）。
- **ssh 隧道掉了管理后台就连不上**：重连隧道即可，bot 不受影响。