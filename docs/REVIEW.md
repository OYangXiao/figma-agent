# 审查指南

> 这份文档是给**做代码审查的 AI / 开发者**看的。目标不是"介绍项目"，
> 而是让你**尽快找到真正的问题**：代码在哪、什么已验证、哪里最可疑、怎么复现。
>
> 能力与用法见 [`CAPABILITIES.md`](CAPABILITIES.md)；交接须知见 [`../AGENTS.md`](../AGENTS.md)。

---

## 0. 三十秒进入状态

```bash
./fimg doctor      # 17 项自检，逐层。哪层断就先看哪层
./fimg test        # 93 个单元测试，秒级，不需要 Figma
./scripts/dev.sh   # 规格 → 校验 → 本地预览出图，不需要 Figma
```

**当前状态**：`doctor` 17 通过 / 0 失败 / 0 警告；单测 93/93；插件 v1.5.0 在线；
画布 1417 节点（页面 `DSH Prototype`）。

**审查时不需要连 Figma** —— 上面三条覆盖了绝大部分逻辑。
只有验证"真机行为"才需要（见 §6）。

---

## 1. 系统地图

```
┌──────────────┐  HTTP   ┌────────────────────┐  长轮询   ┌───────────────────────┐
│ Agent / CLI  │ ──────▶ │ bridge/server.mjs  │ ────────▶ │ plugin/ui.html (iframe)│
│ tools/figma  │         │ localhost:8787     │           │  轮询 + 超时 + 兜底     │
└──────────────┘ ◀────── └────────────────────┘ ◀──────── └───────────┬───────────┘
                         POST /result                         postMessage │
                                                                          ▼
                                                          plugin/code.js（主线程）
                                                          渲染引擎 + 读取/修改引擎
```

| 层 | 文件 | 行数 | 职责 |
|---|---|---|---|
| CLI | `tools/figma.mjs` | 630 | 参数解析、拼选择器、调桥、打印审计 |
| 桥 | `bridge/server.mjs` | 379 | 长轮询、队列 TTL、**离线看门狗**、CORS、把导出的 PNG 落盘 |
| 插件 UI | `plugin/ui.html` | 193 | 长轮询客户端（**带超时**）、`postMessage` 转接、离线兜底 |
| 插件主线程 | `plugin/code.js` | **1928** | **全部实际逻辑**：渲染、dump、patch、结构、组件、交互 |
| 桩 | `test/figma-stub.mjs` | 382 | Figma API 近似（**刻意模拟销毁语义**） |
| 测试 | `test/plugin.test.mjs` | 1275 | 93 个用例，跑真实 `plugin/code.js` |
| 本地预览 | `specs/preview.py` | 672 | **另一套独立布局实现**，0.5 秒出图 |
| 规格校验 | `specs/validate-spec.mjs` | 99 | 静态校验 |

> ⚠️ **两套独立的布局实现**：`plugin/code.js`（真机）与 `specs/preview.py`（本地）。
> 任何布局语义都必须**成对添加**，否则本地预览会悄悄失去可信度（`PITFALLS.md` P23）。

---

## 2. 代码索引

### 2.1 `plugin/code.js` —— 按能力定位

| 能力 | 函数 | 行 |
|---|---|---|
| 建节点（SPEC_DSL） | `createNodeInner` | 361 |
| 画布状态 | `cmdRender` / `cmdStats` / `cmdExport` / `cmdClear` / `cmdFocus` / `cmdPing` | 509 / 543 / 565 / 593 / 603 / 622 |
| 读（dump） | `cmdDump` / `dumpNode` | 1154 / 719 |
| 大纲 | `cmdList` | 1214 |
| 改属性 | `cmdPatch` / `applySet` | 1237 / 948 |
| 插入 / 删除 | `cmdInsert` / `cmdRemove` | 1304 / 1344 |
| 结构 | `cmdMove` / `cmdDup` / `cmdGroup` / `cmdUngroup` | 1399 / 1457 / 1501 / 1537 |
| 组件 | `resolveComponent` / `cmdComponent` / `cmdInstance` / `cmdSwap` / `cmdDetach` | 1595 / 1613 / 1646 / 1691 / 1722 |
| 交互 | `pick` / `cmdReactions` / `cmdLink` | 1751 / 1760 / 1791 |
| 样式 | `styleCache` / `cmdStyles` | 199 / 1576 |
| 选区 | `cmdSelection` | 1852 |
| 目标解析 | `resolveTargets` / `hasSelector` / `matchName` | 870 / 1290 / 695 |
| 类型归一 | `normType` / `TYPE_ALIASES` | 858 / 839 |
| 页面解析 | `resolvePage` / `getPage` | 479 / 491 |
| 颜色 / 填充 | `hexToRgba` / `toPaint` / `paints` / `paintsToSpec` | 68 / 88 / 135 / 679 |
| 效果 | `toEffects` | 155 |
| 布局子节点 | `applyLayoutChild` | 301 |
| 安全调用 | `safeCall` / `safeCallAsync` | 645 / 650 |
| 指令注册表 | `HANDLERS` | 1852 之后 |

### 2.2 其他关键位置

| 内容 | 位置 |
|---|---|
| 桥的离线看门狗 | `bridge/server.mjs:155` `failInflightWhenOffline` |
| 桥的队列 TTL | `bridge/server.mjs:132` `purgeStaleQueue` |
| 桥的指令分发 / 超时 | `bridge/server.mjs:114` `dispatch` |
| UI 的轮询循环 + 超时 | `plugin/ui.html` `run()` / `loop()` |
| 预览器的绝对定位 | `specs/preview.py` `is_absolute` / `measure` / `allocate` |
| 预览器的渐变与图片 | `specs/preview.py` `gradient_image` / `image_paint` |
| 规格校验规则 | `specs/validate-spec.mjs` |
| 型号生成器（示例设计） | `specs/build-stock-spec.mjs` |

---

## 3. 已验证 vs 未验证

### 3.1 真机已验证（v1.5.0，画布 `DSH Prototype`）

| 能力 | 证据 |
|---|---|
| 全部 23 个命令的**首次连通** | `stats` 命中当前页 1417 节点；`list` 79 行 |
| `dump` 按 name / id / within / type 读 | 字段与 SPEC_DSL 一致 |
| `patch` 真写往返 | 文本 `2:6`：`size 15→17→15`，`h` 跟随重排 21→24→**21**（证明真的重排了） |
| 布局切换 / 覆盖层 | `layout V→H→NONE`；`positioning:ABSOLUTE` + `x/y` 生效 |
| 效果 / 样式 / 图片 | 阴影颜色 `#11223380` 精确往返；图片 base64 → `imageHash` → 按 hash 复用（同一张） |
| 结构操作 | `move`（index 0 / 末尾 / 跨容器）、`dup`（count / 偏移）、`group`↔`ungroup` |
| 组件 / 实例 | `FRAME→COMPONENT`；实例 `mainComponent` 异步解析；`swap` 读回确认；`detach→FRAME` |
| 原型交互 | click / hover / timeout / URL / OVERLAY / `--append` / `--clear`；`dump→patch` 原样写回 |
| `export` | 5 张截图落盘；与本地预览逐屏比对一致 |

### 3.2 真机未验证（**建议优先试这些**）

| # | 未验证项 | 为什么可疑 |
|---|---|---|
| 1 | **改实例内部的子节点** | 会产生 override 还是改到主组件？没实测。真实设计系统里这是高频操作 |
| 2 | **混合字体**（`fontName === figma.mixed`）改文案 | `ensureFontsLoaded()` 逐字符扫描，可能慢；且逐段 `loadFontAsync` 的失败被静默忽略 |
| 3 | **渐变读取闭环** | Figma 存的是 `gradientTransform` 矩阵，`dump` 无法还原成 `angle` → 渐变**写得出、读不回**（只能保留 `transform`） |
| 4 | **组件属性** | `componentProperties` 只读；实例无法参数化 |
| 5 | **大文件 / 深层树** | `dump` 默认 4000 节点上限，从未在远超此规模的文件上跑过 |
| 6 | **`INSTANCE` 的 `w`/`h` patch** | 实例尺寸受主组件约束，行为未验证 |
| 7 | **并发 / 中断恢复** | 渲染中途关插件、桥重启、多次重连 —— 只测过"掉线即失败"，没测"恢复后继续" |
| 8 | **`npm` 环境** | 一直在无 npm 环境跑，`package.json` 的 scripts 未验证 |

### 3.3 只有桩测试覆盖（**真机可能不同**）

这些逻辑在桩上全绿，但桩是近似（见 §4.1）：

- 各类选择器组合（`within` + 正则 + `type` 别名）
- 边界与错误路径（找不到目标、类型不符、上限触发）
- `dry-run` 不写入（8 个用例）
- 交互取值校验（非法 `nav`/`trigger`/`transition` 报错）

---

## 4. 高风险区域（建议重点看）

### 4.1 桩是近似 —— "桩绿真机红"已经发生 8 次

`PITFALLS.md` 的 P19–P26 **全部**是"93 个测试全绿"时存在的。典型模式：

| 类型 | 例子 |
|---|---|
| 桩**不知道**的信息 | P19 硬编码页名（桩不知道用户的页面叫什么） |
| 桩**比真机宽容** | P24 `ungroup` 后节点没销毁，`n.name` 照样读得到 |
| 桩**没有异步语义** | P26 `mainComponent` 同步 getter 在真机会抛错 |
| 两份实现不同步 | P23 预览器不支持绝对定位，本地"验证通过"是巧合 |

**已经做的加固**：桩现在会模拟销毁（`ungroup` / `createComponentFromNode` 之后读属性会抛错）。
**建议继续查**：还有哪些真机语义桩没模拟？

- `figma.mixed`（桩里是个 Symbol，真机是特殊值）—— 混合字体路径完全没被桩覆盖
- 节点的 `layoutSizingHorizontal` 联动（桩里是普通属性，真机改一个会影响另一个）
- `resize()` 在 auto-layout 下的行为（桩直接赋值宽高）
- `figma.group()` 的索引语义与包围盒（桩是简化实现）
- **`loadFontAsync` 失败**（桩支持 `missingFonts`，但没人用）

### 4.2 两份布局实现必须手工保持一致（P23）

`plugin/code.js` 与 `specs/preview.py` 是**独立实现**。目前一致的部分：
横向 fill 均分、两趟重排、绝对定位、渐变、图片。

**建议**：写一个"布局一致性"测试 —— 同一份 spec，一边跑 `preview.py` 拿
`_w/_h/_x/_y`，一边跑桩拿 `dump`，**逐节点对比**。现在只靠人工核对过一次。

### 4.3 `safeCall` 会把"读失败"吞成"空值"（P26）

```js
function safeCall(fn, fallback = null) { try { return fn(); } catch { return fallback; } }
```

这个模式在 `plugin/code.js` 里用了 **17 处**（另有 4 处异步版 `safeCallAsync`）。
每一处都在把异常变成"没有值"。P26 就是这么来的
（`mainComponent` 读失败 → 审计写成 `null → 新组件`）。

> 数字别记错：`grep -o "safeCall(" plugin/code.js | wc -l` → 17（含 1 处定义），
> `grep -o "safeCallAsync(" | wc -l` → 4。

**建议**：逐个检查这 21 处，判断"读失败"和"确实是空"是否需要区分。
至少**审计输出**里不该混淆 —— 因为审计是给人（和 Agent）读的唯一结果。

### 4.4 参数命名冲突与同名不同义

| 位置 | 冲突 |
|---|---|
| `p.name` | 在 `applySet` 里是**改图层名**；在选择器里是**筛选条件**。`cmdDup`/`cmdGroup` 里已改用 `p.rename`（曾因此写出 bug） |
| `--to` | `link`/`swap` = "连到哪个节点 / 换成哪个组件"；`move`/`dup`/`instance` = "放进哪个容器" |
| `--id` vs `--ids` | CLI 层都收敛成 `payload.ids`；插件层 `op.id`（单个）与 `op.ids`（数组）是两条分支 |

**建议**：查一遍还有没有别的字段被赋予了两种语义。

### 4.5 `applySet` 的字段顺序有隐式依赖

`applySet` 里几个分支**顺序敏感**：

1. 别名归一必须在最前
2. `positioning` 必须在 `x`/`y` 之前（否则误报"x/y 会被忽略"）
3. `layout` 模式切换必须在 `gap`/`pad`/`main`/`cross` 之前（后者只在非 NONE 时存在）
4. `w`/`h` 的 `resize` 与 auto-layout 的相互作用（只测了文本自动高度）

**建议**：这些顺序约束只在注释里，没有测试保护。考虑加断言或用显式阶段划分。

### 4.6 交互（reactions）的正确性只靠"原样往返"

`link` 构造的 Reaction 结构是我**推断**的（`setReactionsAsync` 没查官方文档逐字段核对）。
真机上能写能读，但：

- `--append` 是把旧 reactions 和新的拼起来 —— **没有去重**，重复点击会产生多条相同交互
- `easing` 只做了 `toUpperCase()`，没有白名单校验（`pick` 只用于 `trigger`/`nav`/`transition`）
- `preserveScrollPosition` 硬编码 `false`
- 没有支持 `SCROLL_TO` 需要的额外字段（`destinationId` 之外的锚点）

**建议**：查官方文档核对 `Trigger` / `Action` / `Transition` 的完整字段，
特别是 `SCROLL_TO` 与 `CHANGE_TO` 这两个我从没在真机上跑过的取值。

### 4.7 桥的状态机

`deliver` / `dispatch` / `purgeStaleQueue` / `failInflightWhenOffline` 四个函数共同维护
`queue` + `inflight` + `waiter` 三个状态。已经修过两个 bug（P17 幽灵操作、P22 不失败）。

**建议**：检查这几个不变式是否成立 ——

- 每个 `inflight` 条目最终**一定**会 resolve（成功 / 超时 / 看门狗 / 重连清空）
- `queue` 里的每条指令要么被执行、要么因 TTL 过期被丢弃、要么被看门狗清理
- `waiter` 在客户端断开时一定被清空（否则后续指令"投递到虚空"）

### 4.8 插件主线程的让出（P5）

长任务必须每 80 个节点 `await` 一次让出事件循环，否则**整个 Figma 冻住**。
目前只有 `cmdRender` 和 `cmdInsert` 的 `tick()` 做了这件事。

**但新加的命令没有分片**：

- `cmdDup`（`--count 20` × 多节点）—— 每个 `clone()` 都是同步的
- `cmdComponent` / `cmdSwap` / `cmdDetach` 的批量循环
- `applySet` 对大量节点的循环（`cmdPatch` 匹配几百个节点时）

**建议**：评估这些命令在"匹配数百个节点"时会不会冻住 Figma。
若会，需要同样的 `tick()` 机制。

### 4.9 错误信息的诚实性

已经修过两处（`patch` 匹配 0 个时不再说"已应用"；`swap` 的 `null → 新组件`）。
**已经修过的两处**（都值得作为范例）：

- `patch` 匹配 0 个节点时不再说"已应用"
- `swap` 的 `null → 新组件`（P26）
- `dup --dry` 曾把**源节点 id** 印成副本 id —— 看起来像"副本已建好"

**建议继续检查**：

- `move` 报的是**实际**索引（已处理，但同容器内移动时索引会偏移，值得复核）
- `group` / `ungroup` 的 `released` 计数在**部分失败**时准不准？
- `link` 的 `before`/`after` 在 `--append` 中途失败时会不会误导？
- **dry-run 的输出**：其它命令有没有类似 `dup` 那样"伪造出并不存在的产物"？

---

## 5. 已知问题清单（按严重度）

| # | 问题 | 严重度 | 状态 |
|---|---|---|---|
| 1 | ~~`export` 无法指定页面（CLI + 桥没透传 `pageName`）~~ | 低 | **已修**（v1.5.1） |
| 2 | `link --append` 不去重，可能产生多条相同交互 | 低 | 待确认是否算问题 |
| 3 | ~~`easing` 无白名单校验~~ | 低 | **已修**（v1.5.1） |
| 4 | 改实例内部节点未验证 | 中 | 待验证 |
| 5 | 新命令（dup/component/swap/detach）未做分片让出 | 中 | 待评估 |
| 6 | `safeCall` 混淆"读失败"与"空值"（17 处 + 4 处异步版） | 中 | 部分已修（P26） |
| 7 | 渐变写得出、读不回（无 `angle`） | 低 | 设计限制，已文档化 |
| 8 | 组件属性只读 | 中 | 未实现 |
| 9 | 两份布局实现靠人工同步 | 中 | 建议加一致性测试 |
| 10 | ~~`--dry` 广告了却照写不误~~ | **高** | **已修**（P27）。发现于本文档编写过程中；建议复核其余命令有无同类模式 |
| 11 | ~~`insert` 没有 `--dry`~~ | 中 | **已修**（v1.5.1）：`insert --dry` 只校验父容器与 spec，不 build |

---

## 6. 如何自己复现验证

### 6.1 不需要 Figma（秒级）

```bash
./fimg doctor                 # 17 项，逐层
./fimg test                   # 93 个用例
./scripts/dev.sh              # 规格 → 校验 → 预览出图
./fimg check                  # 规格静态校验（含新加的类型/填充规则）
```

### 6.2 需要 Figma

```bash
./fimg bridge &                       # 起桥
# 在 Figma 里运行插件（Plugins → Development → FIMG Agent Plugin），保持面板开着
./fimg status                         # 确认 ● 插件在线

# 只读验证（安全）
./fimg stats
./fimg list --depth 2
./fimg dump --name "01 行情" --depth 3 --out dumps/x.json
./fimg reactions --within <某个屏幕的 id>

# 写入验证（建议先复制一份页面！）
./fimg patch --ops ops.json --dry     # 所有结构性命令也支持 --dry
./fimg export --all                   # 导出核对
```

**两条纪律**：

1. **动用户画布前先在 Figma 里复制一份页面** —— 这是插件管不了的最后一道保险
2. **所有写操作先 `--dry`** —— `patch`/`rm`/`move`/`dup`/`group`/`ungroup`/
   `component`/`instance`/`swap`/`detach`/`link` 都支持，且**真的不写入**（有 8 个回归测试守着）

### 6.3 造一个安全的试验场

画布上的 `FIMG Prototype` 页面是**真实设计**，别直接试新东西。
推荐做法（本次审查前就是这么做的）：

```jsonc
// 一个画面外的绝对定位容器，被屏幕裁剪掉，看不见
{ "root": { "type": "FRAME", "name": "FIMG·试验场", "w": 400, "h": 300,
  "positioning": "ABSOLUTE", "x": 2000, "y": 0, "layout": "V",
  "children": [ /* 你的测试节点 */ ] } }
```

```bash
./fimg insert dumps/sandbox.json --parent <某个屏幕Frame的id>
# …在这里随便试…
./fimg rm --name "FIMG·试验场" --within <同一个屏幕id>   # 用完删掉
```

---

## 7. 建议的审查清单（按风险从高到低）

- [ ] **桩的保真度**：还有哪些真机语义桩没模拟？（§4.1 列了 5 个候选）
- [ ] **两份布局实现的一致性**：能不能写个自动对比测试？（§4.2）
- [ ] **`safeCall` 的 17 + 4 处使用**：哪些该区分"失败"与"空值"？（§4.3）
- [ ] **`applySet` 的顺序依赖**：有没有测试保护？（§4.5）
- [ ] **Reaction 结构核对官方文档**：特别是 `SCROLL_TO` / `CHANGE_TO` / `easing`（§4.6）
- [ ] **长任务分片**：新命令会不会冻住 Figma？（§4.8）
- [ ] **桥的状态不变式**：每个 inflight 一定会 resolve 吗？（§4.7）
- [ ] **选择器的边界**：正则注入、超长通配、`within` 指向自己
- [ ] **`dump` 的截断语义**：`truncated` / `childCount` 是否总是一致的
- [ ] **`insert` 的 SPEC_DSL 与 `dump` 输出是否真能互转**（往返回归）
- [ ] **审计输出的诚实性**：有没有"说成功但没做"/"说没做但做了"的地方？（§4.9）
- [ ] ~~**`export` 的 pageName 缺口**修掉（§5 #1）~~ ✅ 已修（v1.5.1）

---

## 8. 已经权衡过的设计决策（**不要重复建议**）

这些是**有意为之**的，提出来会被驳回 —— 除非你有新证据：

| 决策 | 原因 |
|---|---|
| **不用 npm，统一入口是 `./fimg`** | 本机 Node 是独立运行时，`npm` 可能不存在（见 `AGENTS.md` 开头） |
| **不用 WebSocket，用 HTTP 长轮询** | 插件 UI 是 null-origin iframe，`ws` 握手在 CORS 下脆弱 |
| **不用 Figma REST API** | 对设计内容只能读；写必须走 Plugin API |
| **`render` 默认不清空页面** | 在现有稿上迭代时误清空代价太大 |
| **写操作必须带选择器（`all:true` 才放行）** | 漏写选择器会命中整页，几乎总是笔误 |
| **`name` 与 `text` 是两个选择器** | Figma 的文本图层名常是无意义的 `Text`，混用必错 |
| **容器 `opacity` 做淡色底是错的** | Figma 的 `opacity` 会继承给子节点，文字会跟着透明 |
| **页名默认跟随"当前页"** | 硬编码页名会让读操作凭空建页（P19） |
| **SPEC_DSL 不建组件 / 交互** | 组件是"从真实稿子里长出来"的，命令式更贴合迭代模式 |
| **`dump` 输出 `imageHash` 而不是图片字节** | 内嵌字节会让 dump 体积爆炸；搬图用 hash 足够 |
| **`reactions` 原样输出原样写回** | 不解释、不裁剪字段，Figma 加新字段也不会丢 |
| **本地预览是独立的 Python 实现** | 0.5 秒出图，换取"改设计不浪费 Figma 往返" |

---

## 9. 命名与约定速查

| 概念 | 叫法 |
|---|---|
| DSL 里的矩形类型 | `RECT`（Figma 里是 `RECTANGLE`，已做归一） |
| 用户面命令入口 | `./fimg <cmd>` |
| 桥端口 | 8787 |
| 复合选择器 | `within`（范围）/ `all`（全量开关）/ `rename`（改名，区别于选择器的 `name`） |
| dump 的"信息字段" | `abs` `mainComponent` `componentProperties` `isComponent` `childCount` `truncated` |
| 前缀 | `FIMG·` 开头的是本项目试验用节点（用完应删除） |
