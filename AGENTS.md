# AGENTS.md — 后续模型/开发者的工作交接

> **先读这份。** 它记录了当前真实状态、必须遵守的规则、以及已经踩过的坑。
> 跳过它你会重复我们花了好几轮才定位到的那几个 bug。

> **在 Figma 设计稿上做迭代时，先读 [`docs/WORKFLOW.md`](docs/WORKFLOW.md)。**
> 那里规定了页面命名、beta/release 流程、何时提问、如何标注修改——**强制遵守**。

---

## 第一次接手：先跑自检

```bash
./fimg doctor
```

逐层检查运行时 → 文件完整 → 语法 → 清单合规 → 逻辑测试 → 规格链路 → 桥。
**哪一层断了就先修哪里**，不要在断掉的链路上往下做。

### ⚠️ 两条必须先知道的环境事实

**1. `npm` 可能不存在。** Node 常以独立运行时形式提供（本机内置运行时目录里只有 `node` 二进制）。
所以本项目提供不依赖 npm 的统一入口 **`./fimg`**，**文档里全部用它**：

```bash
./fimg test           # 而不是 npm test
./fimg dump --name X  # 而不是 npm run dump -- --name X
./fimg help           # 看全部子命令
```

`package.json` 里的 npm scripts 保留了，有 npm 时两种写法都行——但**别在文档里写 npm**。

**2. 桥是前台常驻进程，每次开新会话都要重新启动。**

```bash
./fimg bridge     # 常驻；另开终端或放后台
./fimg status     # 确认它在跑
```

桥没起来时，任何 `dump`/`patch`/`render` 都会报「插件未连接」。
**这时先查桥，别去查插件。**

---

## 0. 当前工作模式 ⚠️ 最重要

**主要工作已经转为「在用户现有设计稿上迭代」**，而不是从零生成。

| | 从零生成（旧模式） | **在现有稿上迭代（当前模式）** |
|---|---|---|
| 输入 | 自己写的 SPEC_DSL | 用户 Figma 画布上已有的节点 |
| 手段 | `render` 创建 | `dump` 读取 → `patch` / `insert` / `rm` 就地改 |
| 是否清空 | 可选 | **绝不清空** |
| 核心文档 | `docs/SPEC_DSL.md` | **`docs/ITERATING.md`** |

用户已确认：
- 设计稿**都在 Figma 里** → 可以原生、精确地读取节点（不需要靠图片近似）
- 迭代方式是**直接改他画布上的现有节点** → 必须保留图层结构、命名、组件关系

**这意味着：不要建议「重新生成一版」，要用 `patch` 就地改。**
清空页面重画会毁掉用户的图层结构。

---

## 1. 这个项目是什么

让 **AI Agent 直接读写 Figma 画布**。核心是一条本地双向链路：

```
Agent / CLI  ──HTTP──▶  bridge (localhost:8787)  ──long-poll──▶  Figma 插件 UI (iframe)
                             ▲                                        │ postMessage
                             │                                        ▼
                             └──────── POST /result ◀──────  Figma 插件主线程
                                                              (渲染引擎 + 读取/修改引擎)
```

- **为什么不是 REST API**：Figma REST API 对设计内容**只能读**（写操作仅限 Variables 等少数端点）。
  要读写画布必须用 **Plugin API**，而它只能跑在 Figma 内部。
- **为什么不是 WebSocket**：插件 UI 是 null-origin iframe，`ws` 握手在 CORS 下脆弱；
  HTTP 长轮询更稳，且**整条链路零 npm 依赖**。

---

## 2. 当前状态（以此为准，不要相信旧的叙述）

| 组件 | 状态 |
|---|---|
| `bridge/server.mjs` | ✅ 可用，已验证 ping / 131KB 渲染 / 94ms 往返 |
| `plugin/code.js` **渲染引擎** | ✅ 可用，1413 节点已成功渲染到真实 Figma |
| `plugin/code.js` **读取+修改引擎** | ✅ **全部指令已在真实 Figma 跑通**（含真写往返、布局切换、覆盖层、结构操作、图片填充、组件/实例、原型连线）；93/93 桩测试 |
| `plugin/ui.html` 轮询客户端 | ✅ 可用（含超时保护） |
| 指令集 | status/list/sel/dump/patch/insert/rm/move/dup/group/ungroup/styles/**component/instance/swap/detach/reactions/link**/render/export/clear |
| `specs/preview.py` 本地预览 | ✅ 可用（仅对 SPEC_DSL 渲染有效；对现有设计稿无效） |
| `test/plugin.test.mjs` 单元测试 | ✅ 93/93 通过（Figma API 桩） |

### 页名不再硬编码（v1.2.0 起）

所有读写命令**默认作用于 Figma 的当前页**，读操作**绝不新建页面**。
指定页面用 `--page 名称` 或 `DSH_FIGMA_PAGE=名称`。

⚠️ 以前硬编码的 `FIMG Prototype` 已经移除。**不要再把它加回来**——
用户的实际页面叫 `DSH Prototype`，硬编码会让 `stats` 报错、让 `render` 凭空新建空页。
自检会守住这条（`doctor` 第 4 节）。详见 `docs/PITFALLS.md` P19。

### 真机验证状态（v1.5.0）

全部 23 个子命令**已在真实 Figma 上跑通**，含多次真写往返：

- 文本 `2:6`：`size 15→17→15`，`h` 跟随重排 21→24→21 —— 证明 Figma 真的重排了，不只是设属性
- 图片填充：base64 写入 → dump 读回 `imageHash` → 按 hash 复用（同一张图）
- 组件：`FRAME → COMPONENT`；实例 `mainComponent` 异步解析正确；`swap` 读回确认；`detach → FRAME`
- 交互：click / hover / AFTER_TIMEOUT / URL / OVERLAY / `--append` / `--clear` 全部通过；
  `dump → patch` 原样写回交互，字段一个不丢

完整结果与证据见 `docs/ROADMAP.md` A 节。

**仍未覆盖的边界**（真机没遇到，桩也测不到）：

1. **混合字体**（`fontName === figma.mixed`）时改文案 —— `ensureFontsLoaded()` 的逐字符扫描可能偏慢
2. **改实例内部的节点**（会产生 override 还是改到主组件）—— 只验证了实例的创建/换/脱离，
   没试过 `patch` 实例内部的子节点
3. **渐变读取**：`transform` 矩阵无法还原成角度，只能原样保留
4. **组件属性**：`componentProperties` 只读；`addComponentProperty` 没实现
5. **`patch` 改 `w`/`h`** 与 auto-layout 的深层相互作用（只测了文本自动高度这一种）

> **一条真实教训**：桩测试全绿 ≠ 真机能用。
> P19（硬编码页名）让第一条 `stats` 就报错，P21（字段名不对称）让文档承诺的
> "回写"静默失效，P22（在途指令不随掉线失败）让命令白等 30s，**P23**（预览器跟不上新布局语义）
> 让本地“验证通过”变成巧合，**P24**（解组后读了被销毁的节点）操作成功却报错，
> **P25**（两层名字系统没归一）让 `--type RECT` 静默匹配 0 个，
> **P26**（dynamic-page 下用同步 getter）让审计写成 `null → 新组件`，
> **P27**（`--dry` 广告了却照写不误）让最后一道人肉防线形同虚设 ——
> **九个都是桩测试全绿时存在的。能连真机时，先连真机跑最平凡的路径。**
> 见 `docs/PITFALLS.md`。

### 历史遗留 ✅ 已结

「真实截图 vs 本地预览」的逐屏比对**已做**：两者高度一致，
差异只在真机 PingFang SC 字形更宽导致的行高。`specs/preview.py` 作为
0.5 秒的快速近似器是可信的 —— 日常迭代可以先靠它，不必每次往返 Figma。
证据见 `docs/ROADMAP.md` A1 与 `out/real_*.png`。

---

## 3. 强制开发回路

### 3.1 改 `plugin/code.js` 时 —— **先跑单元测试**

```bash
./fimg test          # 93 个用例，秒级，不需要 Figma
```

**这一步不可跳过。** Figma 往返一次要几分钟，而单元测试是秒级。
改插件逻辑后先在桩上验证，再去 Figma。

测试覆盖了：渲染、dump 往返、颜色 hex 往返、dump→patch 字段别名往返、
各类选择器（含 `within` 范围与 `type` 别名）、dryRun 不写入、无选择器护栏、
页名解析、auto-layout 警告与布局切换、绝对定位覆盖层、效果/样式/图片填充、
`move`/`dup`/`group`/`ungroup` 结构操作、`component`/`instance`/`swap`/`detach`、
`link`/`reactions` 原型交互（含 dump→patch 对称）、insert/remove/selection 边界。

### 3.2 改设计规格（旧模式，仍可用于搭新页面）

```bash
./scripts/dev.sh              # 生成规格 → 静态校验 → 本地预览（不需要 Figma）
./scripts/dev.sh --figma      # 额外推 Figma 并导出截图
```

### 3.3 迭代现有设计稿（**当前主要工作**）

```bash
source scripts/runtime.sh      # 得到 $NODE / $PY（自动挑可用的运行时）

$NODE tools/figma.mjs ping                      # 0. 确认插件在线
$NODE tools/figma.mjs list                      # 1. 看结构
$NODE tools/figma.mjs dump --name "卡片" --out dumps/card.json   # 2. 读细节
$NODE tools/figma.mjs patch --ops ops.json --dry                 # 3. 先看会改什么
$NODE tools/figma.mjs patch --ops ops.json                       # 4. 真改
$NODE tools/figma.mjs export --all                               # 5. 导出核对
```

完整用法见 **`docs/ITERATING.md`**。

---

## 4. 硬性规则（违反会直接出 bug 或搞坏用户的稿子）

### 4.1 绝不做的事

| 规则 | 原因 |
|---|---|
| **不要建议「清空重画」来改现有设计稿** | 会毁掉用户的图层结构、命名、组件关系。要用 `patch` 就地改 |
| **绝不给「有子节点的容器」加 `opacity`** 做淡色底 | Figma 的 `opacity` **会继承给子节点**，文字会跟着变透明。用 `tint()` 预先算实色淡底 |
| **不要用 `name` 选择器去找文案** | `name` 匹配的是**图层名**（常是无意义的 `Text`）。按内容找要用 `text` 选择器 |
| **不要在 auto-layout 子节点上改 `x`/`y`** | 会被布局忽略。要做覆盖层就先设 `positioning:"ABSOLUTE"`，别硬改 |
| **不要在 `plugin/ui.html` 的 `run()` 里去掉超时** | 主线程只要不回消息，整个轮询循环会**永久挂死**。这是真实发生过的故障 |
| **不要在用户原稿上直接试新指令** | 先让他复制一份页面，或至少先 `--dry` |
| **不要相信"加了 dryRun 参数就等于 dry-run"** | 必须真的包住变异语句；且要有断言"节点没变"的测试（见 P27） |
| **不要在 `remove()` / `ungroup()` 之后读那个节点** | 真机会销毁它，属性访问直接抛错；操作其实已成功，很容易误判成失败而重试（见 P24） |

### 4.2 插件 / Figma 侧

| 规则 | 原因 |
|---|---|
| `manifest.json` 的 `allowedDomains` **只能写域名，不能写 IP** | Figma 拒绝 `http://127.0.0.1:8787`（报 "must be a valid url"）。写 `http://localhost:8787` + `reasoning` |
| **不要注册 `figma.on('documentchange', ...)`** | `documentAccess:"dynamic-page"` 下注册前必须先 `await figma.loadAllPagesAsync()`，否则插件一启动就报错 |
| 访问 `figma.root.children` 前必须 `await figma.loadAllPagesAsync()` | 同上 |
| 按 id 取节点要用 `figma.getNodeByIdAsync` | dynamic-page 下同步版本不可用 |
| 读实例的主组件要用 `getMainComponentAsync()` | `instance.mainComponent` 同步 getter 在 dynamic-page 下会抛错；被 `safeCall` 吞掉后会变成 `null`，看起来像"没有主组件"（见 P26）|
| 长任务**必须定期 `await` 让出事件循环** | 主线程单线程，不让出会**冻住整个 Figma**。每 80 个节点让出一次 |
| 改文本前必须先 `loadFontAsync` | 顺序反了会抛错；混合字体时要逐段加载 |

### 4.3 链路侧

| 规则 | 原因 |
|---|---|
| 桥必须**双栈监听**（不指定 host） | macOS 上 `localhost` 优先解析到 IPv6 `::1`，只监听 `127.0.0.1` 会导致"导入成功但连不上" |
| 改 `plugin/` 下任何文件后，**用户需要重新运行插件** | Figma 每次运行开发插件会重读磁盘，但已打开的实例不会热更新 |

### 4.4 预览器（`specs/preview.py`）的三个易错点

已修好，**改动时不要退回去**：

1. 横向容器里 `fill`/`grow` 子节点的可用宽度是**均分份额**，不是整个容器宽度
2. 尺寸被父容器改写的子节点要**重排子树**，但**只对 auto-layout 容器做**——
   `grow` 分配的子节点固有宽度是 0，重排会把它重置掉
3. 重排**必须在定位之前**——`measure()` 会把 `_x/_y` 重置为规格里的值
4. **绝对定位子节点要单独处理**（`is_absolute()`）：不参与弹性分配/计 gap/贡献 HUG，
   最后按 `x`/`y` 落位，并排在绘制顺序最后（= 最上层）。见 `PITFALLS.md` P23

---

## 5. 文件地图

```
fimg-agent-plugin/
├── plugin/
│   ├── manifest.json      Figma 插件清单（networkAccess / documentAccess）
│   ├── code.js            ★ 渲染引擎 + 读取/修改引擎（含 page 管理）
│   └── ui.html            iframe：HTTP 长轮询 + 超时保护 + 离线兜底
├── bridge/server.mjs      零依赖 HTTP 长轮询桥
├── tools/figma.mjs        CLI（读/改/结构/组件/交互/页面 共 24 个子命令，见 `./fimg help`）
├── specs/
│   ├── build-stock-spec.mjs  设计规格生成器（旧模式）
│   ├── validate-spec.mjs     静态校验
│   └── preview.py            本地预览渲染器
├── test/
│   ├── figma-stub.mjs        ★ Figma API 桩
│   ├── plugin.test.mjs       ★ 单元测试（不需要 Figma）
│   └── fake-plugin.mjs       假插件（验证桥协议）
├── examples/screenshots/     参考截图
├── scripts/                  runtime.sh · start-bridge.sh · dev.sh · doctor.sh
└── docs/
    ├── WORKFLOW.md       ★ 迭代工作流（页面命名 / beta→release / 标注）——强制遵守
    ├── CAPABILITIES.md   ★ 能力与用法总表（命令 + 护栏 + 已知缺口）
    ├── REVIEW.md         ★ 审查指南（代码索引、已验证矩阵、高风险区）
    ├── ITERATING.md      ★ 在现有设计稿上迭代（当前主要工作）
    ├── ARCHITECTURE.md     数据流、协议、设计决策
    ├── SPEC_DSL.md         规格 DSL 完整参考
    ├── PITFALLS.md       ★ 27 个坑的现象/根因/修法
    ├── TROUBLESHOOTING.md  症状 → 诊断 → 修复
    └── ROADMAP.md          未验证项、已知问题、扩展方向
```

★ = 你最可能改的。

---

## 6. 出问题时先看哪里

| 症状 | 先看 |
|---|---|
| 改了 code.js，想验证 | `./fimg test`（秒级，不需要 Figma） |
| 插件面板一直「等待本地桥…」 | `curl localhost:8787/status`；桥在跑吗、`pluginOnline` 是否为 true |
| `pluginOnline: false` 但插件开着 | 插件 UI 卡死了 → **重新运行插件**；检查 `run()` 超时还在不在 |
| 命令报「插件已离线（等待 Ns 无响应）」 | 插件面板被关了。重新运行插件；桥的看门狗会立刻中止在途指令，不用干等（见 P22） |
| 渲染/patch 很久不返回 | `curl localhost:8787/status` 看 `progress` |
| 选择器匹配不到节点 | `name` 匹配图层名、`text` 匹配文案——搞混是最常见的原因 |
| `patch` 报「没有选择器 / 会匹配整个页面」 | op 漏写 `id`/`name`/`text`/`type`。补上，或确要全量改就写 `"all": true` |
| `stats` / `dump` 找不到东西，或凭空多出一个空页 | 目标页不对。用 `--page 名称` 指定，或先在 Figma 里切到那一页（见 P19） |
| 回写 `size`/`clip`/`autoResize`/`sizing` 没反应 | 别名层被删了。`applySet` 开头的别名归一必须保留（见 P21） |
| 改了属性但画布没变 | 父容器是 auto-layout？`x`/`y`/`w`/`h` 可能被布局覆盖（会回报警告） |
| 某个颜色变成实心色块 | 用了容器 `opacity` 而非 `tint()` |
| 布局错位/文字截断（旧模式） | 先跑 `specs/preview.py` 本地复现 |
| **预览和真机对不上** | `preview.py` 和 `plugin/code.js` 是两套布局实现，新语义必须成对加（见 P23）|
| `rm`/`move`/`dup` 命中了一大片 | 同名图层很多，加 `--within <容器id>` 限定范围（见 P25）|
| `--type RECT` 匹配 0 个 | 已做别名归一；若又匹配不到，检查是不是新类型没进 `TYPE_ALIASES`（见 P25）|
| `ungroup` 报 "node does not exist" | 操作其实成功了。检查 `cmdUngroup` 是否忘了先快照（见 P24）|
| `swap`/`dump` 里 `mainComponent` 是 `null` | 用了同步 getter。dynamic-page 下要用 `getMainComponentAsync()`（见 P26）|
| `instance --of-name` 放的不是想要的实例 | 有同名组件。命令会报 `ambiguous`，改用 `--of <id>` |
| `--dry` 之后画布却变了 | 致命 bug，回到 P27。检查该命令的变异语句有没有被 `if (p.dryRun) … continue` 包住 |

完整排错手册见 `docs/TROUBLESHOOTING.md`。

---

## 7. 扩展时的建议路径

**加新节点类型**（如 `VECTOR`、图片填充）：
1. `plugin/code.js` 的 `createNodeInner()` 加分支
2. **同步在 `specs/preview.py` 里加实现**（否则失去快速验证能力）
3. `dumpNode()` 里加对应的读取分支——**读写必须对称**，否则 dump 出来的东西插不回去
4. `docs/SPEC_DSL.md` 补文档，`specs/validate-spec.mjs` 的 `TYPES` 登记
5. `test/plugin.test.mjs` 加往返测试

**加新指令**：
1. `plugin/code.js` 写 `cmdXxx()`，注册进 `HANDLERS`
2. 桥一般不用改——用现成的 `POST /cmd {cmd, payload}`
3. `tools/figma.mjs` 加 case（选择器用 `selectorPayload()` / `parentPayload()`，别手抄）
4. `test/plugin.test.mjs` 加用例；`docs/ITERATING.md` / `docs/CAPABILITIES.md` 补文档
5. **是写操作就加 `dryRun` 支持，并配一个"断言节点没变"的测试**（P27）；
   匹配可能很多节点时要加数量上限（照 `rm` 的 200 抄）

**加新的可 patch 属性**：
1. `applySet()` 里加分支（记得写 `note()` 审计 + 支持 `dryRun`）
2. `dumpNode()` 里加**对称的读取分支**
3. 测试两个方向

**加新的布局语义**（如绝对定位、wrap）：
1. `plugin/code.js` 的 `applyLayoutChild()` / `applySet()`
2. **`specs/preview.py` 必须同步**：`measure()` + `allocate()` + 绘制顺序，
   还要把关键节点的 `_w/_h/_x/_y` 和真机 `dump` 对一遍
3. `specs/validate-spec.mjs` 的规则要放行新写法
4. `dumpNode()` 要读得出，否则回写会丢语义
5. `docs/SPEC_DSL.md` + `docs/ITERATING.md` 补文档

> ⚠️ 漏掉第 2 步不会报错，只会让本地预览**悄悄失去可信度**（P23）。

**改 `test/figma-stub.mjs` 时的原则**：桩要比真机**一样严**，不能更宽容。
真机会销毁的节点（`remove` / `ungroup`）、真机会抛错的调用，
桩里也要抛（见 `ungroup` 的实现和 P24）。桩宽容一点，
换来的就是"测试全绿、真机报错"——那比没有测试更浪费时间。

---

## 8. 环境速查

- **运行时解析**：`source scripts/runtime.sh` → `$NODE` `$PY`
  （它会挑一个**真正能用**的：node ≥ 18、python 能 `import PIL`；可用 `NODE_BIN`/`PY_BIN` 覆盖）
- 桥端口 `8787`（`DSH_FIGMA_PORT` 覆盖）。⚠️ 端口写在 manifest 的 `allowedDomains` 里，改端口要同步改并重新导入
- 目标页面：默认跟随 Figma 当前页；`--page 名称` 或 `DSH_FIGMA_PAGE=名称` 指定
- 导出截图 → `out/`；dump 产物 → `dumps/`
- 预览器字体：`/System/Library/Fonts/Hiragino Sans GB.ttc`（0 = W3，2 = W6），换机器需改 `specs/preview.py` 顶部

---

## 9. 与用户协作的注意点

- 用户的 Figma 是**免费版** —— 不能用 Variables API；付费能力要先确认。
- 改 `plugin/` 下文件后**必须提醒用户重新运行插件**。
- **大改前建议他先复制一份页面** —— 这是插件管不了的最后一道保险。
- 报进度要真实：**没在真实 Figma 上验证过的事，不要说成"已完成"**。
  桩测试通过 ≠ Figma 里能用。
- 回复用中文（用户用中文交流）。
