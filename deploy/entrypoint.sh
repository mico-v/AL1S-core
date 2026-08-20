#!/bin/sh
# 容器以 root 进入这里只为修正 bind mount 权限，Bot 与 rootless Podman 始终以 uid 10001 运行。
# sandbox 引导默认跳过；即使显式构建失败，也不会伪装成已隔离，运行时会 fail-closed。
set -u

warn() { printf '%s\n' "[entrypoint] 警告: $*" >&2; }
fail_or_warn() {
  reason="$1"
  if [ "${MSP_SANDBOX_FAIL_FAST:-false}" = "true" ] || [ "${MSP_SANDBOX_FAIL_FAST:-false}" = "1" ]; then
    printf '%s\n' "[entrypoint] sandbox 引导失败且 MSP_SANDBOX_FAIL_FAST=true: $reason" >&2
    exit 1
  fi
  warn "$reason；不影响 Bot 启动，生产执行将 fail-closed（sandbox 不可用时拒绝执行）"
}

# bind mount 可能来自宿主且权限为 0700/UID 1000。root 只修正应用需要的持久化目录，
# 然后立刻降权；不改变容器内 Bot 的实际运行 UID。
if [ "$(id -u)" -eq 0 ]; then
  if ! mkdir -p /app/data /app/data/msp-workspace /run/al1s; then
    warn "无法创建数据或 broker 目录，继续启动并由应用报告具体不可用功能"
  fi
  if ! chown -R 10001:10001 /app/data 2>/dev/null; then
    warn "无法将 /app/data 交给 uid 10001，继续启动；持久化功能可能不可用"
  fi
  if ! chown 10001:10001 /run/al1s 2>/dev/null; then
    warn "无法设置 /run/al1s 权限，继续启动；broker 可能不可用"
  fi
  exec su -s /bin/sh al1s -c 'exec /usr/local/bin/al1s-entrypoint'
fi

image="${MSP_CONTAINER_IMAGE:-al1s-sandbox:latest}"
bootstrap="${MSP_SANDBOX_BOOTSTRAP:-false}"

# Docker 的 named volume/tmpfs 会覆盖镜像内目录，因此启动时再次确保 rootless
# runtime 与 vfs storage 配置可写。失败也不能阻断 Bot 主进程。
if ! mkdir -p "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" "$HOME/.config/containers" "$HOME/.local/share/containers" "$HOME/.cache"; then
  fail_or_warn "无法创建 rootless Podman 运行时目录"
else
  chmod 700 "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" 2>/dev/null || true
  storage_conf="$HOME/.config/containers/storage.conf"
  if [ ! -s "$storage_conf" ] && ! printf '%s\n' '[storage]' 'driver = "vfs"' "runroot = \"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/containers\"" "graphroot = \"$HOME/.local/share/containers/storage\"" > "$storage_conf"; then
    fail_or_warn "无法写入 rootless Podman storage.conf"
  fi
fi

if [ "$bootstrap" = "true" ] || [ "$bootstrap" = "1" ]; then
  # 仅显式开启时构建。默认跳过可避免网络超时阻塞 Bot 启动；缺失镜像不会被报告为可用。
  if podman image exists "$image" >/dev/null 2>&1; then
    printf '%s\n' "[entrypoint] 使用现有 sandbox 镜像: $image"
  elif podman info >/dev/null 2>&1; then
    printf '%s\n' "[entrypoint] sandbox 镜像缺失，尝试构建: $image ..."
    if ! podman build --pull=missing --security-opt=label=disable -f /app/Dockerfile.sandbox -t "$image" /app; then
      fail_or_warn "sandbox 镜像构建失败: $image"
    fi
  else
    fail_or_warn "rootless Podman 不可用"
  fi
else
  printf '%s\n' "[entrypoint] 已跳过 sandbox 镜像引导（MSP_SANDBOX_BOOTSTRAP=$bootstrap）；缺失时保持 fail-closed"
fi

if [ -f /app/.env ]; then
  exec node node_modules/tsx/dist/cli.mjs --env-file=.env src/index.ts
fi
exec node node_modules/tsx/dist/cli.mjs src/index.ts
