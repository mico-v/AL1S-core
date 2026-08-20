# AL1S-core 多阶段构建：管理前端 + 非 root 运行时
FROM node:24-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

FROM node:24-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fonts-noto-cjk python3 python3-pip python-is-python3 podman uidmap slirp4netns fuse-overlayfs \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 --shell /bin/bash al1s \
 && printf '10001:100000:65536\n' > /etc/subuid \
 && printf '10001:100000:65536\n' > /etc/subgid \
 && mkdir -p /app/data /app/data/msp-workspace \
 && chown -R al1s:al1s /app

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
COPY --from=frontend /build/dist frontend/dist
COPY deploy/entrypoint.sh /usr/local/bin/al1s-entrypoint
RUN chmod 755 /usr/local/bin/al1s-entrypoint && chown -R al1s:al1s /app

ENV HOME=/home/al1s \
    XDG_RUNTIME_DIR=/run/user/10001 \
    CONTAINERS_STORAGE_CONF=/home/al1s/.config/containers/storage.conf \
    MSP_RUNTIME_MODE=podman \
    MSP_ALLOW_LOCAL_BASH_FALLBACK=false \
    MSP_SANDBOX_BOOTSTRAP=false \
    MSP_SANDBOX_FAIL_FAST=false
# 为 rootless Podman 预建运行时目录、配置与存储目录。vfs 不依赖容器内 /dev/fuse，
# 因而在 Docker/WSL2 的嵌套 rootless 场景中失败时只会使 sandbox 不可用，不会影响 Bot 启动。
RUN mkdir -p /run/user/10001 /run/al1s \
    /home/al1s/.config/containers /home/al1s/.config/cni \
    /home/al1s/.local/share/containers /home/al1s/.local/share/podman \
    /home/al1s/.cache \
 && printf '[storage]\ndriver = "vfs"\nrunroot = "/run/user/10001/containers"\ngraphroot = "/home/al1s/.local/share/containers/storage"\n' > /home/al1s/.config/containers/storage.conf \
 && chown -R al1s:al1s /run/user/10001 /run/al1s /home/al1s/.config /home/al1s/.local /home/al1s/.cache \
 && chmod 700 /run/user/10001 /run/al1s
VOLUME ["/app/data"]
# entrypoint 以 root 修正 bind mount 权限后，通过 su 降权到 al1s。
ENTRYPOINT ["/usr/local/bin/al1s-entrypoint"]
