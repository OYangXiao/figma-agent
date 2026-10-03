# 已知问题与后续方向

## A. 真机验证 ✅（v1.2.0 已完成）

**全部指令已在真实 Figma 上跑通**（文件 `Untitled`，页面 `DSH Prototype`，5 屏 1413 节点）。

| 指令 | 真机结果 |
|---|---|
| `ping` / `status` | ✅ 版本 1.2.0，读到文件与页面列表 |
| `stats` | ✅ 自动命中当前页，5 顶层 Frame / 1413 节点 |
| `list` | ✅ 79 行树状大纲，含 id |
| `dump` | ✅ 按 name / id / selection 读取；字段与 SPEC_DSL 一致 |
| `patch --dry` | ✅ 逐节点「改前 → 改后」审计 |
| `patch`（真写） | ✅ 见下方往返证据 |
| `insert` | ✅ 新节点 `2:1416` 插入 `01 行情`，`fill`/`radius` 读回一致 |
| `rm --dry` / `rm` | ✅ 按图层名命中并删除，画布回到 1413 节点 |
| `sel`（读 + 写选区） | ✅ `--ids` 设置选区后能读回完整属性 |
| `export` | ✅ 5 张截图落盘到 `out/real_*.png` |
| `styles` | ✅ 列出本地样式（该文件目前 0 个） |
| `component` / `instance` | ✅ Frame → COMPONENT；放置实例（`--count`/`--x --y`），`mainComponent` 异步解析正确 |
| `swap` / `detach` | ✅ 换主组件（读回确认）；实例 → FRAME |
| `link` / `reactions` | ✅ click/hover/timeout、NAVIGATE/OVERLAY、URL、`--append`/`--clear` 全部真机通过 |
| `move` | ✅ 同容器改序（index 0/末尾）+ 跨容器搬移 + 拦住移进自身子树 |
| `dup` | ✅ 复制子树、`count`、`dx/dy` 偏移、数量上限护栏 |
| `group` / `ungroup` | ✅ 成组 → 解组往返，子节点不丢 |
| `within` 范围选择器 | ✅ `patch --within` 只命中范围内节点；`--type RECT` 别名等价 `RECTANGLE` |
| 图片填充 | ✅ base64 写入 → dump 读回 imageHash → 按 hash 复用到另一节点（同一 hash） |

**往返证据（`patch` 真写）**

以文本节点 `2:6`（状态栏 `9:41`）为例，用 **dump 输出的字段名**回写：

```
dump 原值:      size=15  autoResize=WIDTH_AND_HEIGHT  h=21
patch set:      { "size": 17, "autoResize": "HEIGHT" }
读回:           size=17  autoResize=HEIGHT  h=24      ← h 真的重排了
改回后读回:     size=15  autoResize=WIDTH_AND_HEIGHT  h=21
```

`h` 从 21 → 24 是关键证据：Figma 真的重新排版了，不是只设了个属性值。
这一条同时验证了 `figma.getNodeByIdAsync`、字体加载（`PingFang SC`）、
`figma.commitUndo()`、以及 P21 的字段别名层。

**仍未覆盖的边界**（真机没遇到，桩也测不到）：

1. **混合字体**（`fontName === figma.mixed`）改文案 —— `ensureFontsLoaded()` 逐字符扫描可能偏慢
2. **INSTANCE 节点**的 patch 行为（改实例覆盖 vs 改主组件）—— 当前画布都是扁平 FRAME，没有实例
3. **渐变读取**：`transform` 矩阵无法还原成角度，只能原样保留
4. **`patch` 改 `w`/`h`** 与 auto-layout 的深层相互作用（只测了文本自动高度这一种）

### A1. 历史遗留：真实截图 vs 本地预览 ✅ 已结

「导出截图 → 与本地预览比对」这一步终于做了。结论：**两者高度一致**。

- 结构、层级、配色、数据、圆角、图标全部对应
- 差异只在**字形宽度导致的行高**：真机 PingFang SC 略宽，行高比预览稍大
- `specs/preview.py` 作为**快速近似器**是可信的 —— 它 0.5 秒出图，
  用来发现"布局算错/文字截断"这类结构性问题完全够用

对比图：`out/real_01_行情.png`（真机，2×）vs `out/preview-01_行情.png`（本地）。

**结论**：本地预览可以作为日常迭代的第一道验证，不必每次都往返 Figma。

---

## A2. 已在真机上暴露并修掉的缺陷（v1.2.0 / v1.3.0）

八条都是**桩测试全绿**时存在的。P19–P21 是第一次连真机跑出来的，
P22 是插件掉线时暴露的，P23 是加新布局语义时"预览器没跟上"，
P24 是桩比真机宽容，P25 是两层名字系统没归一，P26 是 dynamic-page 下用同步 getter。详见 `PITFALLS.md`。

| # | 缺陷 | 影响 |
|---|---|---|
| P19 | `FIMG Prototype` 硬编码在 4 个文件里 | `stats` 第一条命令就报「未找到页面」；`render` 会凭空新建空页 |
| P20 | `patch` 的 op 漏写选择器 → 命中整页 | 一个笔误改花整页稿子 |
| P21 | `dump` 与 `patch` 字段名不对称 | 文档承诺的"dump 直接回写"静默失效 |
| P22 | 插件掉线后在途指令不失败 | 白等 120–300s（现在 45s 内明确报错并清理） |
| P23 | 预览器不支持绝对定位 | 本地"验证通过"其实是巧合，滚区尺寸差 28px |
| P24 | `ungroup` 后读被销毁的节点 | 操作**成功**却报错，容易被误判成失败而重试 |
| P25 | `type` 选择器名字对不上 / 同名图层命中一片 | `--type RECT` 静默匹配 0 个；写操作误伤一大片 |
| P26 | dynamic-page 下用同步 getter 读 `mainComponent` | 审计写成 `null → 新组件`，`safeCall` 把"读失败"吞成"没有值" |

**教训**：能连真机时，**先跑最平凡的路径**（`stats` → `dump` → `patch --dry`），
不要等做完整套桩测试再连——桩不会告诉你"用户的页面叫什么名字"。

---

## B. 已知视觉问题

### B1. 详情页底部滚动区最后 1–2 行被裁掉 ✅ 已修（v1.3.0）

**现象**：屏 04（资金流向）的「行业资金排名」最后一行、屏 05（财务指标）的
「行业估值对比」最后一行被底部操作栏切掉。

**✅ 真机确认**（v1.2.0）：`out/real_04_个股详情·资金流向.png` 里可见
「白酒 −3.21亿 −12.40%」之后，下一行被操作栏从**中间切断**，只露出半个胶囊。

**实测数据**：四个详情页的滚区**全部溢出**，且裁切线落在行中间：

| 屏 | 滚区视口 | 内容高 | 溢出 | 裁在哪 |
|---|---|---|---|---|
| 02 分时盘口 | 191 | 397.5 | 206.5 | `RecentTrades` 第 1 行（1px） |
| 03 日K | 191 | 397.5 | 206.5 | 同上 |
| 04 资金流向 | 487 | 590 | 103 | `SectorRank` 第 2 行（9px） |
| 05 财务指标 | 487 | 548 | 61 | `PeerCompare` 中部 |

**修法：底部渐变遮罩**（用第 2 方案，不动内容）

滚区内容本该延续到屏幕外，所以问题不是"溢出"，而是"切得生硬"。
在滚区底部叠一层 `#FFFFFF00 → #FFFFFFFF` 的渐变，把硬裁切换成"下面还有"。

关键实现点：

- 遮罩是**绝对定位**的子节点（`positioning:"ABSOLUTE"`），否则会被当成内容滚走
- `y = H − ACTION_BAR_H − FADE_H = 844 − 76.5 − 28 = 739.5`
  —— 滚区底边 = 屏幕底 − 操作栏高，**与 header 多高无关**，所以四屏同一个式子
- 高度取 **28**：`h=40` 会把完整的最后一行也淡掉，`h=20` 又看不出暗示
- 淡出到 `#FFFFFF` 是因为滚区底部的内容块底色都是白色

**顺带补的能力**（为了做这个遮罩，见 `PITFALLS.md` P21/P23）：
`positioning` 可读可写、`preview.py` 支持绝对定位与渐变、`validate-spec.mjs` 同步。

**证据**：`out/fixed_*.png`（真机）vs `out/preview-*.png`（本地，现在完全一致）。

### B2. 底部 TabBar 图标是基础图元拼的

**现状**：`tabIcon()` 用 `RECT`/`ELLIPSE` 拼出 星/柱状图/钱包/文档/人形。

**问题**：细节精度有限，与真实 App 的图标质感有差距。

**改进方向**：
- 引入真实矢量图标 —— 但 Plugin API 的 `VectorNode` 需要用
  `figma.createVector()` + `vectorPaths`（SVG path 数据）设置，需要把图标转成 path
- 或继续用图元逼近（成本低，可控）

### B3. 分时图的走势是构造数据

`deviation()` 用均值回复（OU 过程）生成，比纯随机游走自然，但仍是示意数据。
若要更真实，可以接入真实行情数据源。

---

## C. 尚未实现的能力

| 能力 | 说明 | 难度 |
|---|---|---|
| ~~**Component / Instance**~~ | ✅ 已完成（v1.5.0）：`component` / `instance` / `swap` / `detach`，dump 读 `mainComponent` + `componentProperties` | — |
| ~~**原型连线**~~ | ✅ 已完成（v1.5.0）：`link` / `reactions`，支持 click/hover/timeout/drag、NAVIGATE/OVERLAY/SWAP/SCROLL_TO、URL 动作、过渡；dump→patch 对称 | — |
| ~~**图片填充**~~ | ✅ 已完成（v1.3.0）：base64/dataURI 写入 + `imageHash` 复用 + 预览器渲染 | — |
| ~~**`export --page`**~~ | ✅ 已完成（v1.5.1）：CLI 与桥透传 `pageName` | — |
| ~~**`insert --dry`**~~ | ✅ 已完成（v1.5.1）：只校验不 build，节点数不变 | — |
| ~~**`easing` 白名单**~~ | ✅ 已完成（v1.5.1）：与 `trigger`/`nav`/`transition` 同级校验 | — |
| **Figma Variables** | 把设计 token 做成变量。⚠️ **用户的 Figma 是免费版，Variables 需要付费计划**，做之前必须确认 | 中 |
| **Auto Layout 的 `minWidth`/`maxWidth`** | 未暴露。可用于更健壮的响应式 | 低 |
| **增量更新** | `render` 已默认不清空（追加），但**迭代主路径是 `patch`**，所以「按 name 做 diff 重渲」的必要性下降。屏幕数很多、又必须重渲时再做 | 高 |
| **多页面/多设备尺寸** | `W`/`H` 硬编码在 `build-stock-spec.mjs` 顶部（390×844）。可参数化支持 iPad / Android | 低 |
| **撤销分组** | 一次渲染产生上千次变更，Figma 的 undo 栈里是一大坨。可用 `figma.commitUndo()` 合并 | 低 |

---

## D. 健壮性改进

| 项 | 说明 |
|---|---|
| **渲染失败不留残骸** | 现在 `render` 默认**追加**，不会再「先清空再渲染」，残骸风险已大幅下降；但 `--clear` 仍会在中途失败时留下半成品。可改为先在临时区渲染完、成功后再替换 |
| **`/render` 支持增量返回** | 现在要等全部节点建完才返回。可改为流式返回进度（`/progress` 已有基础） |
| **规格体积** | 5 屏 300KB。屏幕更多时可考虑 gzip 或二进制编码（`MAX_BODY` 已是 80MB，暂时不是瓶颈） |
| **`pluginOnline` 误判** | 心跳 TTL 40s。长渲染期间插件不轮询，`pluginSeenAgo` 会持续增长 —— 已用 `progress` 补偿，但 `pluginOnline` 仍会短暂变 false |
| **在途指令不随插件掉线而失败** | ✅ 已修（v1.2.0）：桥加离线看门狗，插件离线且指令等待超过 `DSH_OFFLINE_FAIL_MS`（默认 45s）即立刻失败并清理队列残留。见 `PITFALLS.md` P22 |
| **`export` 的内存** | 大节点 `exportAsync` 的 base64 会占用内存。已设 `MAX_BODY` 80MB 保护 |

---

## E. 可移植性

| 项 | 现状 | 建议 |
|---|---|---|
| 字体回退链 | 硬编码 `['PingFang SC','Inter','Helvetica Neue','Arial','Roboto']`（macOS 视角） | 按 `figma.listAvailableFontsAsync()` 动态探测，或在 manifest 里做成配置 |
| 预览器字体 | 硬编码 `/System/Library/Fonts/Hiragino Sans GB.ttc` | 启动时探测可用 CJK 字体（`TROUBLESHOOTING.md` §11 有脚本） |
| Node/Python 路径 | 文档里写的是 DSH 内置运行时路径 | 一般环境直接用 `node` / `python3` 即可 |
| 端口 | 固定 8787（可用 `DSH_FIGMA_PORT` 覆盖） | manifest 的 `allowedDomains` 也写死了 8787，改端口需同步改 manifest 并重新导入 |
| 目标页面 | ✅ 已不硬编码（v1.2.0）：默认当前页，`--page` / `DSH_FIGMA_PAGE` 指定 | — |

---

## F. 建议的下一步（按优先级）

1. **组件属性的读写** —— `componentProperties` 目前只能读。
   `addComponentProperty` / `editComponentProperty` 可以让实例真正参数化（难度中）
2. **从设计稿里批量建组件** —— 例如"把所有同名 Frame 收成一个组件再替换成实例"（难度中）
3. **SPEC_DSL 侧的组件支持** —— `render` 时直接产出 `COMPONENT` / `INSTANCE`。
   需要同步 `preview.py`（P23 的教训），属于"从零生成"模式（难度中）
4. 桥的 `/render` 流式返回进度（D 节）—— 屏幕数大幅增加时才有必要
5. 增量更新（C 节）—— 只有当"必须重渲"且屏幕数很多时才有必要

> A 节（真机验证）、读写对称、B1、图片填充、组件/实例、原型连线**都已完成**。
> 剩下的都是锦上添花，不是缺口。

---

## G. 不要做的事

- ❌ **不要把页名写回代码里** —— 见 `PITFALLS.md` P19
- ❌ **不要让 `patch`/`remove` 接受无选择器的 op** —— 见 P20
- ❌ **不要在 `applySet` 里删掉字段别名归一** —— 见 P21
- ❌ **不要在没有本地预览的情况下直接改设计再推 Figma** —— 会浪费大量往返
- ❌ **不要用容器 `opacity` 做淡色底** —— 见 P4
- ❌ **不要把 IP 写进 `allowedDomains`** —— 见 P1
- ❌ **不要在 `plugin/ui.html` 的 `run()` 里去掉超时** —— 见 P3
- ❌ **不要给用户的免费版 Figma 用 Variables API** —— 会失败
