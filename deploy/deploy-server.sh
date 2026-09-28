#!/usr/bin/env bash
#
# 本地构建 + 打包生产运行产物，推送到服务器并重启 systemd 服务。
# 服务器只运行 Node，不编译 TypeScript，也不使用任何容器运行时。
#
# 运行：pnpm deploy:server
#
# 可用环境变量覆盖：
#   AL1S_REMOTE        SSH 主机别名，默认 as
#   AL1S_REMOTE_DIR    服务器部署目录，默认 /opt/al1s
#   AL1S_SERVICE       systemd 服务名，默认 al1s-bridge
set -euo pipefail

REMOTE="${AL1S_REMOTE:-as}"
REMOTE_DIR="${AL1S_REMOTE_DIR:-/opt/al1s}"
SERVICE="${AL1S_SERVICE:-al1s-bridge}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[deploy] 本地构建 TypeScript"
pnpm build

echo "[deploy] 生成仅含生产依赖的运行包"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
chmod 0755 "$STAGE"
cp -r dist "$STAGE/dist"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc "$STAGE/"
cp -r patches "$STAGE/patches"
( cd "$STAGE" && pnpm install --prod --frozen-lockfile --ignore-scripts >/dev/null )

# 运行包在服务器上以普通服务用户只读访问，需去掉 mktemp 的 700 权限与本地 uid。
echo "[deploy] 同步到 ${REMOTE}:${REMOTE_DIR}/app"
tar czf - -C "$STAGE" . | ssh "$REMOTE" \
  "rm -rf '${REMOTE_DIR}/app' && mkdir -p '${REMOTE_DIR}/app' && tar xzf - -C '${REMOTE_DIR}/app' && chown -R root:root '${REMOTE_DIR}/app' && chmod -R a+rX '${REMOTE_DIR}/app'"

if [ -f deploy/appservice.yaml ]; then
  REG_ID="$(sed -n 's/^id:[[:space:]]*//p' deploy/appservice.yaml | head -1)"
  if [ -n "$REG_ID" ]; then
    echo "[deploy] 同步 registration ${REG_ID} 并重载 Tuwunel"
    scp -q deploy/appservice.yaml "$REMOTE:${REMOTE_DIR}/tuwunel/appservices/${REG_ID}.yaml.new"
    ssh "$REMOTE" "mv '${REMOTE_DIR}/tuwunel/appservices/${REG_ID}.yaml.new' '${REMOTE_DIR}/tuwunel/appservices/${REG_ID}.yaml' && chown tuwunel:tuwunel '${REMOTE_DIR}/tuwunel/appservices/${REG_ID}.yaml' && chmod 600 '${REMOTE_DIR}/tuwunel/appservices/${REG_ID}.yaml' && systemctl restart tuwunel.service"
  fi
fi

echo "[deploy] 重启 ${SERVICE}"
ssh "$REMOTE" "systemctl restart '${SERVICE}' && sleep 2 && systemctl --no-pager --lines=5 status '${SERVICE}' | head -15"

echo "[deploy] 完成"
