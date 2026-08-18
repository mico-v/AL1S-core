# ============================================================
# AL1S-core 群聊机器人 —— 多阶段构建
# 阶段一：构建管理前端（Vue3 + Vite → frontend/dist）
# 阶段二：运行时（tsx 启动，含原生依赖与中文字体）
# 用法：docker compose build（配置见 docker-compose.yml）
# ============================================================

# ---------- 阶段一：前端构建 ----------
FROM node:24-slim AS frontend
WORKDIR /build
# 先拷锁文件装依赖（利用层缓存，源码改动不重装依赖）
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# ---------- 阶段二：运行时 ----------
FROM node:24-slim AS runtime

# 课程表图片渲染需要中文字体：
# render.ts 恰好会探测 /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
# （Debian 安装 fonts-noto-cjk 后正好落在该路径）
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./

# npm ci 完整安装（tsx 是 devDependencies，运行时必须保留；
# @napi-rs/canvas 平台二进制随 optionalDependencies 以预编译包形式带入）
RUN npm ci

COPY . .
# 从阶段一拿构建好的管理前端
COPY --from=frontend /build/dist frontend/dist

# 运行时数据：会话持久化 / 课程表 / 设置覆盖层 / 插件开关
VOLUME ["/app/data"]

# 注意：不用 --env-file（镜像内无 .env），
# 环境变量由 docker-compose.yml 的 env_file / environment 注入
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]