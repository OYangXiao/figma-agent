# 排错手册

症状 → 诊断 → 修复。诊断命令默认在仓库根执行。

---

## 0. 快速体检

```bash
curl -s localhost:8787/status        # 桥 + 插件 + 进度
curl -s localhost:8787/events        # 桥最近日志
node tools/figma.mjs stats           # 画布现状（顶层 Frame + 节点总数）
```

`/status` 字段含义：

| 字段 | 含义 |
|---|---|
| `pluginOnline` | 40 秒内有过心跳即为 true |
| `pluginSeenAgo` | 距上次心跳的毫秒数 |
| `pluginInfo` | 插件上报的版本/文件名/页面列表（`null` = 从未上报） |
| `progress` | 最近一次进度上报 `{cmd, done}`，长任务用来看是否在推进 |
| `queue` | 排队待取的指令数（>0 说明插件没在轮询） |
| `inflight` | 已下发但未回报的指令数（长时间 >0 说明卡住了） |

---

## 1. 插件面板一直显示「等待本地桥…」

**诊断**

```bash
curl -s localhost:8787/status     # 桥活着吗？
lsof -nP -iTCP:8787               # 端口在监听吗？
```

**可能原因与修复**

| 原因 | 修复 |
|---|---|
| 桥没启动 | `node bridge/server.mjs` |
| 端口被占 | `lsof -ti :8787 \| xargs kill`，或换 `DSH_FIGMA_PORT` |
| `localhost` 走 IPv6 但桥只监听 IPv4 | 桥必须**不指定 host** 启动（见 `PITFALLS.md` P6）。确认监听显示为 `TCP *:8787` 而非 `127.0.0.1:8787` |
| manifest 的 `allowedDomains` 写成了 IP | 改为 `http://localhost:8787`（见 P1） |
| 插件是旧代码 | **重新运行插件**（Figma 不会热更新已打开的实例） |

---

## 2. `pluginOnline: false`，但插件面板开着

**原因**：插件 UI 的轮询循环卡死了。最常见的是 `run()` 没有超时
（见 `PITFALLS.md` P3）。

**诊断**：看 `/status` 的 `queue` 和 `inflight`。

- `queue > 0` + `inflight > 0` → 指令已下发但没回报，UI 卡住了

**修复**

1. **重新运行插件**（立刻恢复）
2. 确认 `plugin/ui.html` 里的 `run()` 仍带 `timeoutMs`：

```bash
grep -n "timeoutMs = " plugin/ui.html     # 应有 600000
```

---

## 3. 渲染很久不返回

**正常情况**：1413 个节点需要数十秒。UI 在此期间**不轮询**（一次只执行一条指令），
所以 `pluginSeenAgo` 会持续增长 —— **这不代表掉线**。

**看进度**：

```bash
watch -n2 'curl -s localhost:8787/status | python3 -m json.tool'
# 关注 progress.done 是否在增长
```

- `progress.done` 在涨 → 正在推进，等着
- `progress.done` 长时间不动 + `inflight` 一直 >0 → 主线程可能出错，看第 2 节

**预防**：大规格用后台方式跑，不要阻塞在前台命令里。

---

## 4. 画布上的节点数不对 / 渲染不完整

```bash
node tools/figma.mjs stats                                  # 画布实际节点数
python3 -c "
import json; s=json.load(open('specs/stock-app.json'))
c=lambda n:1+sum(c(x) for x in n.get('children',[]))
print('规格节点数:', sum(c(f) for f in s['frames']))"
```

两者应该一致。不一致的常见原因：

| 差异 | 原因 |
|---|---|
| 画布更少 | 渲染中途失败 → 重新渲染 |
| 画布更多 | 上一次渲染的残留 → `node tools/figma.mjs clear` 后重渲 |
| 少了整整一屏 | 某一屏的 `build()` 抛错 → 看 Figma 插件面板的错误提示 |

---

## 5. 布局错位 / 文字被截断 / 元素重叠

**第一步永远是本地复现**（0.5 秒，不需要 Figma）：

```bash
python3 specs/preview.py
# 看 out/preview-*.png 和末尾的「布局诊断」
```

- **预览也错** → 是规格/布局语义问题，改 `specs/build-stock-spec.mjs`
  或 `specs/preview.py`（参考 `PITFALLS.md` P7–P9）
- **预览正常但 Figma 错** → 是插件与 Figma 的语义差异，看 `plugin/code.js`
  的 `applyLayoutChild()` / `finalizeAuto()`

**常见具体症状**

| 症状 | 可能原因 |
|---|---|
| 子节点全叠在左上角 | 父容器是绝对定位（无 `layout`）但子节点没有 `x`/`y`。`validate-spec.mjs` 会报这个 |
| 该撑满的容器只有一点点宽 | 用了 `"60%"` 这种百分比字符串 —— **不支持**，会被当成无法识别的值退化为 HUG。改用 `grow`（见 `SPEC_DSL.md` §6） |
| 中间区域没吃满高度 | 需要 `h: "fill"` + `clip: true` |
| 文本没有换行 | 必须给 `w`（数字或 `"fill"`） |
| 颜色变成实心色块 | 用了容器 `opacity` 而非 `tint()`（见 P4） |

---

## 6. 某个颜色/胶囊/文字看不见

**首先怀疑容器 `opacity` 继承**（`PITFALLS.md` P4）。

```bash
# 找出所有给「带 children 的 FRAME」加了 opacity 的地方
grep -n "opacity" specs/build-stock-spec.mjs
```

规则：`opacity` 只能用在**叶子节点**上。容器要淡色底就用 `tint(color, alpha)`。

---

## 7. Figma 界面卡死无响应

**原因**：插件主线程长时间没让出事件循环（`PITFALLS.md` P5）。

**修复**：确认 `cmdRender` 里的 `tick` 仍在：

```bash
grep -n "setTimeout(r, 0)" plugin/code.js
```

**应急**：在 Figma 里按 `Esc`，或强制退出 Figma 重开。

---

## 8. 插件报「未知指令」

桥下发的 `cmd` 在 `code.js` 的 `HANDLERS` 里没有。

```bash
grep -n "^  [a-z]*: cmd" plugin/code.js      # 已注册的指令
```

用 `POST /cmd {cmd, payload}` 时，`cmd` 必须在这个列表里。
注意：**改了 `code.js` 必须重新运行插件**才会生效。

---

## 9. 导出截图失败

```bash
node tools/figma.mjs export --all
```

| 报错 | 原因 |
|---|---|
| `未找到可导出的节点（页面「…」）` | 页面名不对，或页面上没有顶层 Frame。先 `node tools/figma.mjs stats` |
| `找不到节点 X` | `--names` 里的名字与图层名不完全一致（**区分中英文标点、空格、`·`**） |
| 图片是空的/全透明 | 节点尺寸为 0，或内容全被 `clip` 裁掉 |

截图落在仓库根的 `out/`。

---

## 10. 改了 `plugin/` 下的文件但没生效

**Figma 不会热更新已打开的插件实例。** 必须：

1. 关闭插件面板
2. `Plugins` → `Development` → 重新运行 **FIMG Agent Plugin**

改了 `manifest.json` 则需要**重新导入**（`Import plugin from manifest…`）。

---

## 11. 换了机器后预览器报字体错误

`specs/preview.py` 顶部写死了字体路径：

```python
FONT_PATH = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FONT_IDX_REGULAR = 0   # W3
FONT_IDX_BOLD    = 2   # W6
```

macOS 上 PingFang 通常是 `/System/Library/Fonts/PingFang.ttc`，
但部分系统版本路径不同。列出可用中文字体：

```bash
python3 -c "
from PIL import ImageFont
for p in ['/System/Library/Fonts/Hiragino Sans GB.ttc','/System/Library/Fonts/STHeiti Light.ttc','/System/Library/Fonts/PingFang.ttc']:
    try:
        for i in range(6):
            print(p, i, ImageFont.truetype(p, 20, index=i).getname())
    except Exception as e: print(p, 'ERR')
"
```

把找到的路径与 index 填回 `FONT_PATH` / `FONT_IDX_*`。

> 预览字体的差异**只影响预览精度**，不影响 Figma 里的真实渲染
> （插件有自己的字体回退链）。

---

## 12. 想彻底从零验证链路（不需要 Figma）

用假插件替代真实插件：

```bash
node bridge/server.mjs &                 # 终端 A
node test/fake-plugin.mjs &              # 终端 B（假插件）
node tools/figma.mjs ping                # 应返回 fake-1.0
node tools/figma.mjs render              # 应返回 5 个 frame 名
```

这能确认桥、协议、CLI 都正常，把问题范围缩小到插件或 Figma 侧。

⚠️ **假插件会抢走真插件的指令** —— 验证完记得关掉它。
