#!/usr/bin/env bash
# 解析运行时路径（被其他脚本 source）
#
# node / python3 可能不在 PATH 上，或者 PATH 上的版本缺依赖
# （典型：系统 python3 没装 Pillow，而 DSH 内置运行时装了）。
# 所以这里不是「找到就算」，而是**挑一个真正能用的**：
#   node   → 优先 PATH，但必须有 node >= 18
#   python → 优先能 `import PIL` 的解释器（预览渲染器需要）
#
# 可用环境变量覆盖： NODE_BIN / PY_BIN / DSH_RUNTIME_ROOT
#
# 供其他脚本使用：$NODE  $PY  $REPO_ROOT

DSH_RUNTIME_ROOT="${DSH_RUNTIME_ROOT:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies}"
DSH_NODE="$DSH_RUNTIME_ROOT/node/bin/node"
DSH_PY="$DSH_RUNTIME_ROOT/python/bin/python3"

# ---- node：需要 >= 18 ----
_node_ok() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null
}

resolve_node() {
  local c
  for c in "${NODE_BIN:-}" "$(command -v node 2>/dev/null || true)" "$DSH_NODE"; do
    if _node_ok "$c"; then echo "$c"; return 0; fi
  done
  echo "✖ 找不到可用的 node（需要 >= 18）。" >&2
  echo "  安装 Node.js，或设置 NODE_BIN=/path/to/node" >&2
  return 1
}

# ---- python：需要 Pillow ----
_py_ok() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  "$1" -c 'import PIL' 2>/dev/null
}

resolve_python() {
  local c fallback
  for c in "${PY_BIN:-}" "$(command -v python3 2>/dev/null || true)" "$DSH_PY"; do
    if _py_ok "$c"; then echo "$c"; return 0; fi
  done
  fallback="${PY_BIN:-$(command -v python3 2>/dev/null || echo "$DSH_PY")}"
  echo "✖ 找不到装了 Pillow 的 python3（本地预览渲染器需要它）。" >&2
  echo "  尝试： $fallback -m pip install Pillow" >&2
  echo "  或设置 PY_BIN=/path/to/python3" >&2
  echo "  注：DSH 内置运行时的 python 已自带 Pillow： $DSH_PY" >&2
  return 1
}

NODE="$(resolve_node)" || exit 1
PY="$(resolve_python)" || exit 1
export NODE PY

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export REPO_ROOT
