#!/usr/bin/env bash
# 完整开发回路：规格 → 校验 → 本地预览 →（可选）推 Figma → 导出截图
#
#   ./scripts/dev.sh              # 只做本地三步（不需要 Figma，0.5 秒）
#   ./scripts/dev.sh --figma      # 额外推到 Figma 并导出真实截图
#
# 强烈建议每次改设计都先跑不带 --figma 的模式：
# 它能挡住绝大多数布局/视觉 bug，且比 Figma 往返快几个数量级。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/runtime.sh"

cd "$REPO_ROOT"
WITH_FIGMA=0
[ "${1:-}" = "--figma" ] && WITH_FIGMA=1

echo "▶ 1/4  生成规格"
"$NODE" specs/build-stock-spec.mjs

echo
echo "▶ 2/4  静态校验"
"$NODE" specs/validate-spec.mjs

echo
echo "▶ 3/4  本地预览渲染"
"$PY" specs/preview.py

if [ "$WITH_FIGMA" -eq 1 ]; then
  echo
  echo "▶ 4/4  推送到 Figma"
  if ! curl -s --max-time 3 "http://localhost:${DSH_FIGMA_PORT:-8787}/status" >/dev/null 2>&1; then
    echo "✖ 桥没在运行。先执行： ./scripts/start-bridge.sh" >&2
    exit 1
  fi
  "$NODE" tools/figma.mjs stats
  "$NODE" tools/figma.mjs render
  "$NODE" tools/figma.mjs export --all
  echo
  echo "✔ 完成。请逐屏对比 out/preview-*.png（本地近似）与 out/*.png（Figma 真实截图）。"
else
  echo
  echo "✔ 本地三步完成。产物在 out/preview-*.png。"
  echo "  确认无误后推 Figma： ./scripts/dev.sh --figma"
fi
