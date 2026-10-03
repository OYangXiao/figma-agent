#!/usr/bin/env bash
# 启动本地桥（常驻）。Ctrl-C 停止。
#
#   ./scripts/start-bridge.sh              # 默认 8787
#   DSH_FIGMA_PORT=9000 ./scripts/start-bridge.sh
#
# 注意：端口写死在 plugin/manifest.json 的 allowedDomains 里，
# 改端口需要同步改 manifest 并重新导入插件。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/runtime.sh"

cd "$REPO_ROOT"

PORT="${DSH_FIGMA_PORT:-8787}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✖ 端口 $PORT 已被占用："
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN
  echo "  先结束占用进程，或设置 DSH_FIGMA_PORT 换端口。"
  exit 1
fi

echo "启动桥： http://localhost:$PORT  (node: $NODE)"
echo "在 Figma 里运行插件： Plugins → Development → FIMG Agent Plugin"
echo "状态查询： curl -s localhost:$PORT/status"
echo
exec "$NODE" bridge/server.mjs
