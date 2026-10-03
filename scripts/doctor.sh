#!/usr/bin/env bash
# =============================================================================
# 一键自检 —— 确认这个包在当前机器上能正常工作
#
#   ./scripts/doctor.sh
#
# 检查项按「从底向上」排列：运行时 → 文件完整 → 代码语法 → 逻辑测试 →
# 规格链路 → 桥 → 插件。哪一层断了，后面就不用看了。
# =============================================================================
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/.." && pwd)"
cd "$REPO"

if [ -t 1 ]; then CG=$'\033[32m'; CR=$'\033[31m'; CY=$'\033[33m'; CB=$'\033[1m'; CN=$'\033[0m'
else CG=''; CR=''; CY=''; CB=''; CN=''; fi

PASS=0; FAIL=0; WARN=0
ok()   { printf "  ${CG}✓${CN} %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  ${CR}✖${CN} %s\n" "$1"; FAIL=$((FAIL+1)); [ -n "${2:-}" ] && printf "      ${CR}%s${CN}\n" "$2"; }
warn() { printf "  ${CY}!${CN} %s\n" "$1"; WARN=$((WARN+1)); [ -n "${2:-}" ] && printf "      ${CY}%s${CN}\n" "$2"; }
# 注意：不要把这个函数叫 head —— 会覆盖系统的 head 命令，后面 `| head -1` 就炸了
section() { printf "\n${CB}%s${CN}\n" "$1"; }

printf "${CB}fimg-agent-plugin 自检${CN}  (%s)\n" "$REPO"

# ---------------------------------------------------------------- 1. 运行时
section "1. 运行时"
if . "$DIR/runtime.sh" 2>/dev/null; then
  ok "node   $NODE"
  ok "python $PY"
else
  bad "运行时解析失败" "见上方提示；可设置 NODE_BIN / PY_BIN / DSH_RUNTIME_ROOT"
  printf "\n${CR}运行时不可用，后续检查无法进行。${CN}\n"
  exit 1
fi

# ---------------------------------------------------------------- 2. 文件完整
section "2. 文件完整性"
MISSING=0
for f in AGENTS.md README.md package.json \
         plugin/manifest.json plugin/code.js plugin/ui.html \
         bridge/server.mjs tools/figma.mjs \
         specs/build-stock-spec.mjs specs/validate-spec.mjs specs/preview.py \
         test/figma-stub.mjs test/plugin.test.mjs test/fake-plugin.mjs \
         scripts/runtime.sh scripts/start-bridge.sh scripts/dev.sh scripts/doctor.sh \
         docs/CAPABILITIES.md docs/REVIEW.md docs/ITERATING.md docs/ARCHITECTURE.md \
         docs/SPEC_DSL.md docs/PITFALLS.md docs/TROUBLESHOOTING.md docs/ROADMAP.md; do
  [ -f "$f" ] || { bad "缺少 $f"; MISSING=$((MISSING+1)); }
done
[ "$MISSING" -eq 0 ] && ok "26 个必需文件齐全"

NONEXEC=0
for f in scripts/*.sh; do [ -x "$f" ] || NONEXEC=$((NONEXEC+1)); done
[ "$NONEXEC" -eq 0 ] && ok "脚本都有可执行权限" || warn "$NONEXEC 个脚本没有可执行权限" "修： chmod +x scripts/*.sh"

# ---------------------------------------------------------------- 3. 语法
section "3. 代码语法"
SYN=0
for f in plugin/code.js bridge/server.mjs tools/figma.mjs test/figma-stub.mjs \
         test/plugin.test.mjs test/fake-plugin.mjs specs/build-stock-spec.mjs specs/validate-spec.mjs; do
  if "$NODE" --check "$f" 2>/dev/null; then :; else bad "$f 语法错误"; SYN=$((SYN+1)); fi
done
[ "$SYN" -eq 0 ] && ok "8 个 JS 文件语法正确"

if "$PY" -c 'import ast,sys; ast.parse(open("specs/preview.py").read())' 2>/dev/null; then
  ok "specs/preview.py 语法正确"
else
  bad "specs/preview.py 语法错误"
fi

JSONOK=0
for f in package.json plugin/manifest.json specs/stock-app.json; do
  [ -f "$f" ] || { warn "$f 不存在"; continue; }
  "$NODE" -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" 2>/dev/null \
    && JSONOK=$((JSONOK+1)) || bad "$f 不是合法 JSON"
done
[ "$JSONOK" -gt 0 ] && ok "$JSONOK 个 JSON 文件合法"

# ---------------------------------------------------------------- 4. 清单关键字段
section "4. 插件清单关键字段"
MANIFEST_OK=$("$NODE" -e "
const m=JSON.parse(require('fs').readFileSync('plugin/manifest.json','utf8'));
const p=[];
if(!m.name) p.push('缺 name');
if(!m.id) p.push('缺 id');
if(m.documentAccess!=='dynamic-page') p.push('documentAccess 应为 dynamic-page');
const d=(m.networkAccess&&m.networkAccess.allowedDomains)||[];
if(!d.length) p.push('缺 allowedDomains');
for(const x of d){ if(/^\d+\.\d+\.\d+\.\d+|:\\d+\$/.test(x.replace(/^https?:\\/\\//,''))&&/^\d/.test(x.replace(/^https?:\\/\\//,''))) p.push('allowedDomains 含 IP 字面量（Figma 会拒绝）: '+x); }
if(d.includes('*')&&!(m.networkAccess&&m.networkAccess.reasoning)) p.push('用 * 通配时 reasoning 必填');
if(d.some(x=>/localhost/.test(x))&&!(m.networkAccess&&m.networkAccess.reasoning)) p.push('含 localhost 时 reasoning 必填');
if(!m.main||!m.ui) p.push('缺 main/ui');
console.log(p.length?('ERR '+p.join('; ')):'OK');
" 2>&1)
case "$MANIFEST_OK" in
  OK) ok "name / id / documentAccess / networkAccess 均合规" ;;
  *)  bad "清单有问题" "$MANIFEST_OK" ;;
esac

# 端口一致性：manifest 里的端口 vs 桥默认端口
MPORT=$(grep -o 'localhost:[0-9]*' plugin/manifest.json | head -1 | cut -d: -f2)
BPORT=$(grep -o "DSH_FIGMA_PORT || [0-9]*" bridge/server.mjs | grep -o '[0-9]*$')
if [ -n "$MPORT" ] && [ "$MPORT" = "$BPORT" ]; then
  ok "端口一致（manifest=$MPORT, bridge=$BPORT）"
else
  warn "端口可能不一致（manifest=$MPORT, bridge=$BPORT）" "改端口需同步改 manifest 并重新导入插件"
fi

# 页名策略：不应再硬编码页名。
# 硬编码会让 stats 在页面改名后报「未找到页面」，让 render 凭空新建一个空页。
D1=$(grep -c "PAGE_NAME_DEFAULT = null" plugin/code.js)
D2=$(grep -c "^const PAGE_NAME = '" tools/figma.mjs)
D3=$(grep -c '"page": "' specs/stock-app.json 2>/dev/null)
D4=$(grep -c "pageName: body.pageName || undefined" bridge/server.mjs)
if [ "$D1" -ge 1 ] && [ "$D2" -eq 0 ] && [ "$D3" -eq 0 ] && [ "$D4" -ge 1 ]; then
  ok "页名策略一致（默认跟随当前页，无硬编码）"
else
  warn "页名策略可能回退了（code.js默认null=$D1 CLI硬编码=$D2 规格硬编码=$D3 桥透传=$D4）" \
       "期望：code.js null / CLI 无 / 规格 无 / 桥透传。见 docs/PITFALLS.md P19"
fi

# 布局语义三处同步（P23：预览器漏了新语义 → 本地"验证通过"是巧合）
A1=$(grep -c "function applyLayoutChild" plugin/code.js)
A2=$(grep -c "def is_absolute" specs/preview.py)
A3=$(grep -c "positioning" specs/validate-spec.mjs)
A4=$(grep -c "positioning" specs/build-stock-spec.mjs)
if [ "$A1" -ge 1 ] && [ "$A2" -ge 1 ] && [ "$A3" -ge 1 ] && [ "$A4" -ge 1 ]; then
  ok "布局语义三处同步（插件/预览器/校验器都认 ABSOLUTE）"
else
  warn "布局语义可能不同步（插件=$A1 预览器=$A2 校验器=$A3 规格=$A4）" \
       "预览器漏了新语义会让本地验证变成巧合。见 docs/PITFALLS.md P23"
fi

# ---------------------------------------------------------------- 5. 逻辑测试
section "5. 插件逻辑测试（Figma API 桩）"
TEST_OUT=$("$NODE" test/plugin.test.mjs 2>&1)
TEST_LINE=$(printf '%s' "$TEST_OUT" | grep -o '[0-9]* 通过, [0-9]* 失败')
if printf '%s' "$TEST_OUT" | grep -q '0 失败'; then
  ok "单元测试全部通过（$TEST_LINE）"
else
  bad "单元测试有失败（$TEST_LINE）" "运行 $NODE test/plugin.test.mjs 看详情"
  printf '%s\n' "$TEST_OUT" | grep '✖' | sed 's/^/      /'
fi

# ---------------------------------------------------------------- 6. 规格链路
section "6. 规格链路（从零生成模式）"
if VAL=$("$NODE" specs/validate-spec.mjs 2>&1) && printf '%s' "$VAL" | grep -q '问题数: 0'; then
  ok "规格静态校验 0 问题"
else
  bad "规格校验未通过" "$(printf '%s' "$VAL" | tail -3)"
fi

if PREV=$("$PY" specs/preview.py 2>&1); then
  NIMG=$(printf '%s' "$PREV" | grep -c '✔ .*preview-.*png')
  [ "$NIMG" -gt 0 ] && ok "本地预览渲染出 $NIMG 张图 → out/" || bad "预览未产出图片"
else
  bad "本地预览渲染失败" "$(printf '%s' "$PREV" | tail -3)"
fi

# ---------------------------------------------------------------- 7. 桥
section "7. 本地桥"
PORT="${DSH_FIGMA_PORT:-8787}"
STATUS=$(curl -s --max-time 3 "http://localhost:$PORT/status" 2>/dev/null || true)
if [ -n "$STATUS" ]; then
  ok "桥在运行（端口 $PORT）"
  ONLINE=$(printf '%s' "$STATUS" | "$NODE" -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).pluginOnline)}catch(e){console.log('?')}})" 2>/dev/null)
  if [ "$ONLINE" = "true" ]; then
    ok "Figma 插件已连接"
  else
    warn "Figma 插件未连接" "在 Figma 里运行 Plugins → Development → FIMG Agent Plugin"
  fi
else
  warn "桥没在运行" "启动： ./scripts/start-bridge.sh   （新会话里必须先启动它）"
fi

# ---------------------------------------------------------------- 8. 历史遗留
section "8. 环境提示"
if [ -d "$HOME/Documents/deepseek-harness/default-workspace/figma-stock-app" ]; then
  warn "存在旧的重复副本： ~/Documents/deepseek-harness/default-workspace/figma-stock-app" \
       "它是本次导出的前身，已被本目录取代。留着会造成两份分叉。"
fi
if [ -n "${DSH_FIGMA_PORT:-}" ]; then
  warn "设置了 DSH_FIGMA_PORT=$DSH_FIGMA_PORT" "manifest 里写死的端口可能对不上"
fi
ok "检查完毕"

# ---------------------------------------------------------------- 汇总
printf "\n${CB}汇总${CN}: ${CG}%d 通过${CN}, ${CR}%d 失败${CN}, ${CY}%d 警告${CN}\n" "$PASS" "$FAIL" "$WARN"
if [ "$FAIL" -gt 0 ]; then
  printf "\n${CR}有失败项。修好后再继续——否则迭代一定会在某一步断掉。${CN}\n"
  exit 1
fi
printf "\n${CG}基础链路完好。${CN}"
printf "接着按 ${CB}AGENTS.md${CN} 第 3 节走开发回路。\n"
exit 0
