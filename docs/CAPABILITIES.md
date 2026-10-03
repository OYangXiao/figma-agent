# 能力与用法总表

> 这是 fimg-agent-plugin 的**完整能力清单**：能做什么、怎么调、边界在哪。
> 面向"想用"和"想审查"两种读者 —— 每个能力都标了**真机验证状态**。
>
> 相关文档见文末「文档索引」。当前插件版本 **v1.5.0**。

---

## 1. 三十秒上手

```bash
# ① 起桥（前台常驻，每次新会话都要起）
./fimg bridge

# ② 在 Figma 里运行插件（这一步只能手动）
#    Plugins → Development → FIMG Agent Plugin
#    ⚠ 面板别关：关掉 = 长轮询断开 = 所有命令失败

# ③ 确认链路
./fimg status          # 看 ● 插件在线
./fimg ping            # 握手，返回文件名与页面列表

# ④ 读 → 改 → 看
./fimg list                              # 树状大纲，每行带 #id
./fimg dump --name "卡片" --out dumps/c.json   # 读细节
./fimg patch --ops ops.json --dry        # 先看会改什么
./fimg patch --ops ops.json              # 再真改
./fimg export --all                      # 导出截图核对
```

**没有 npm。** 本机 Node 是独立运行时，所以统一入口是 `./fimg`（它自己解析运行时）。
`package.json` 里的 npm scripts 保留着，但文档里一律用 `./fimg`。

**改过 `plugin/` 下任何文件后，必须在 Figma 里重新运行插件** —— 已打开的实例不会热更新。

---

## 2. 这个项目是什么

让 Agent / CLI 直接读写真 Figma 画布。链路：

```
Agent / CLI ──HTTP──▶ bridge (localhost:8787) ──长轮询──▶ 插件 UI (iframe)
                          ▲                                   │ postMessage
                          │                                   ▼
                          └──── POST /result ◀── 插件主线程（渲染 + 读取/修改引擎）
```

- **为什么不用 REST API**：Figma REST API 对设计内容只能读。
- **为什么不用 WebSocket**：插件 UI 是 null-origin iframe，长轮询在 CORS 下更稳。
- **整条链路零 npm 依赖**（只用 Node 内置模块）。

### 两种工作模式

| | 从零生成（旧） | **在现有稿上迭代（当前主用）** |
|---|---|---|
| 输入 | 自己写的 SPEC_DSL | 画布上已有的节点 |
| 手段 | `render` 创建 | `dump` 读 → `patch`/`insert`/`move`/`dup`/… 就地改 |
| 是否清空 | 可选 | **绝不清空** |

> 用户的设计稿都在 Figma 里，迭代方式是**直接改画布上的现有节点**。
> 所以**不要建议"重新生成一版"** —— 那会毁掉图层结构与命名。

---

## 3. 选择器（给谁改）

`patch` 的每个 op，以及 `rm` / `move` / `dup` / `group` / `ungroup` /
`component` / `swap` / `detach` / `reactions` / `link` 都用同一套选择器。
多个条件之间是**与**关系。

| 字段 | 说明 | 例子 |
|---|---|---|
| `id` | 精确命中一个节点（最稳） | `{"id":"12:345"}` |
| `ids` | 一批 id | `{"ids":["12:345","12:346"]}` |
| `selection` | 当前选区 | `{"selection":true}` |
| `name` | **图层名**，支持精确 / `*` `?` 通配 / `/正则/` | `{"name":"Row·*"}`、`{"name":"/^Index·/"}` |
| `text` | **文案内容**（仅 TEXT），同样支持通配与正则 | `{"text":"买入*"}` |
| `type` | 节点类型，**DSL 名与 Figma 名都认**（`RECT` = `RECTANGLE`） | `{"type":"TEXT"}` |
| `layout` | 布局方向 | `{"layout":"H"}` |
| `fontSize` | 字号 | `{"fontSize":14}` |
| `within` | **范围修饰**：只在某个容器的子树里找 | `{"name":"Row","within":"12:400"}` |
| `pageName` | 换一页找（等价 CLI 的 `--page`） | `{"pageName":"草稿"}` |

CLI 选项名：`--id` `--ids` `--name` `--text` `--type` `--layout` `--within`。

### 三个必须知道的点

**① `name` 匹配图层名，不是文案。** Figma 里文本图层常叫 `Text`，
想按"写着什么"找**必须用 `text`**。

**② `--type` 做了名字归一。** SPEC_DSL 写 `RECT`，Figma 节点类型是 `RECTANGLE`。
不做归一的话 `--type RECT` 会**静默匹配 0 个**（不报错）。
归一表在 `plugin/code.js` 的 `TYPE_ALIASES`，加新类型要登记。

**③ 同名图层遍地时一定要用 `within`。** 真实稿子里 `Frame` / `Text` 会出现几十次，
`{"name":"Frame"}` 是**页面级**的，写操作很容易误伤一片。

```bash
./fimg patch --ops ops.json --within 12:400      # 只改 12:400 子树里的
./fimg dump --within 12:400 --depth 2            # 只给范围 = 读这个容器的子树
```

`within` 是**范围**不是条件 —— 单个 op 也能带 `within`，CLI 的 `--within`
会注入到每个没自己写 `within` 的 op。

### 怎么拿 id

```bash
./fimg list                       # 大纲每行末尾 #id
./fimg dump --name "卡片" --out dumps/x.json
./fimg sel                        # 在 Figma 里选中后读回（含完整属性）
```

---

## 4. 命令总表（23 个）

### 4.1 只读

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `status` | 桥与插件状态（含渲染进度、队列/在途） | — |
| `ping` | 握手，返回文件名、页面列表、版本 | — |
| `stats` | 目标页的顶层 Frame 与节点总数 | `--page` |
| `styles` | 列出本文件的**本地样式** | — |
| `list` | 树状大纲（快速定位） | `--page --depth` |
| `sel` | 读当前选区（含完整 dump 属性） | `--id --ids`（给了就改为**设置**选区） |
| `dump` | 读成 SPEC_DSL 同构 JSON | 选择器 + `--within --page --depth --max --out --sel` |
| `reactions` | 读原型交互（目标解析成名字） | 选择器 |

**`dump` 的 scope**：`ids` / `query`（有条件）/ `within`（只有范围）/ `selection` / `page`。
都不给时优先用选区，没选区就读整页。

### 4.2 改属性

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `patch` | 批量改属性（核心迭代工具） | `--ops <file>` `--dry` `--within` |

`patch` 的 ops 文件：

```jsonc
{ "ops": [
    { "id": "12:345", "set": { "fill": "#2B6DE5" } },
    { "text": "提交订单", "set": { "text": "确认支付" } },
    { "name": "Row·*", "within": "12:400", "set": { "gap": 12 } },
    { "all": true, "type": "TEXT", "set": { "font": "PingFang SC" } }   // 全量修改要显式 all
] }
```

- **每个 op 必须带选择器**，否则会被拒绝（防止一个笔误改花整页）
- `--dry` **只计算不写入**，逐节点打印「改前 → 改后」
- 真实写入后会调 `figma.commitUndo()`，Figma 里可以整批 `⌘Z`

### 4.3 增删

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `insert` | 往现有容器插入新节点（用 SPEC_DSL） | `[spec.json] --frame` `--parent`/`--parent-name` `--index` `--dry` |
| `rm` | 删除节点 | 选择器 `--dry`（>200 个需 `force`） |

> `insert --dry`（v1.5.1 起）只校验父容器与 spec，不真正创建节点。想先看效果也可以用 `preview`。

### 4.4 结构

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `move` | 改顺序 / 跨容器搬移 | `--to/--parent <父容器>` `--index n` `--dry` |
| `dup` | 复制节点（含整棵子树） | `--count n` `--to <父容器>` `--index n` `--dx/--dy` `--rename` `--dry` |
| `group` | 收进一个 GROUP（须同父容器） | `--rename` `--index` `--dry` |
| `ungroup` | 解组，子节点原地保留 | `--dry` |

**`--index` 语义跟随 Figma**：

| 父容器 | index 0 是 |
|---|---|
| auto-layout | 布局顺序的**第一个**（最上/最左） |
| 普通容器 | **z 序最底层** |

不给 `--index` 就放末尾。审计里报的是**实际落到的位置**（同容器内移动时索引会偏移）。

> ⚠️ `dup` 的 `--name` 是"选择谁复制"，给副本改名要用 **`--rename`**。两者是不同的键。

### 4.5 组件与实例

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `component` | 把 FRAME/GROUP **原地**转成 COMPONENT | 选择器 `--rename` `--dry` |
| `instance` | 放置组件实例 | `--of <组件id>` \| `--of-name <名字>` `--parent` `--count n` `--index` `--x/--y` `--rename` `--dry` |
| `swap` | 换实例的主组件 | 选择器 `--to <组件id>` \| `--to-name <名字>` `--dry` |
| `detach` | 脱离组件（实例 → 普通 FRAME） | 选择器 `--dry` |

- `component` **会替换原节点**，旧 id 立刻失效 —— 返回的是**新组件**的 id
- `--of-name` 遇到多个同名组件会报 `ambiguous`，建议用 `--of <id>`
- `--x/--y` 只在**非 auto-layout** 父容器里有效（auto-layout 里位置由布局决定）

### 4.6 原型交互

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `reactions` | 读交互 | 选择器 |
| `link` | 建 / 追加 / 清空交互 | `--to <节点>` \| `--to-name` \| `--url` `--trigger` `--nav` `--transition` `--duration` `--easing` `--timeout` `--append` `--clear` `--dry` |

```bash
./fimg link --name "买入" --within 12:400 --to-name "03 详情"
./fimg link --id 12:345 --to 12:900 --trigger ON_HOVER --nav OVERLAY --transition DISSOLVE
./fimg link --id 12:345 --to-name "首页" --trigger AFTER_TIMEOUT --timeout 2
./fimg link --id 12:345 --url "https://example.com"
./fimg link --id 12:345 --clear
```

**取值**（写错直接报错，不会静默用默认值）：

| 参数 | 可选值 |
|---|---|
| `--trigger` | `ON_CLICK`（默认）`ON_HOVER` `ON_PRESS` `ON_DRAG` `AFTER_TIMEOUT` `MOUSE_ENTER` `MOUSE_LEAVE` `MOUSE_UP` `MOUSE_DOWN` |
| `--nav` | `NAVIGATE`（默认）`SWAP` `OVERLAY` `SCROLL_TO` `CHANGE_TO` |
| `--transition` | `SMART_ANIMATE`（默认）`INSTANT` `DISSOLVE` `MOVE_IN` `MOVE_OUT` `PUSH` `SLIDE_IN` `SLIDE_OUT` |

默认**替换**该节点的全部交互；`--append` 追加，`--clear` 清空。

> ⚠️ **`link`/`swap` 的 `--to` 是「连到哪个节点 / 换成哪个组件」**，
> 而 `move`/`dup`/`instance` 的 `--to` 是「放进哪个容器」。同名不同义，用错会报错。

### 4.7 渲染与导出

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `render` | 渲染 SPEC_DSL（**默认不清空**） | `[spec.json] --clear --page` |
| `export` | 导出 PNG 到 `out/` | `--all` \| `--names "A,B"` `--scale 2` `--prefix` |
| `clear` | 清空页面（危险） | `--page` `--yes`（必须） |

### 4.8 本地（不连 Figma）

| 命令 | 作用 |
|---|---|
| `doctor` | 一键自检（17 项，逐层） |
| `test` | 单元测试（93 个，桩上跑真实 code.js，秒级） |
| `spec` / `check` / `preview` | 生成规格 → 静态校验 → 本地预览出图 |
| `dev [--figma]` | 上面三步 +（可选）推 Figma 并导出 |

---

## 5. 目标页面

所有读写命令默认作用于 **Figma 的当前页**。

```bash
./fimg stats                            # 当前页
./fimg dump --name "卡片" --page "草稿"  # 指定页
DSH_FIGMA_PAGE=草稿 ./fimg list          # 整轮固定用某页
```

| 命令 | 不给 `--page` 时 |
|---|---|
| `stats` / `list` / `dump` | 当前页，**绝不新建页面** |
| `clear` | 当前页，**绝不新建页面**（页名拼错就什么都不删并报错） |
| `render` | 当前页；只有 `--page 名称` 指向**不存在的页**时才新建 |
| `export` / `sel` | 当前页（`export` 可用 `--page` 指定；`sel` 跟随当前页） |

---

## 6. 可改属性全表（`set` 里能写什么）

| 分类 | 字段 |
|---|---|
| 基础 | `name` `visible` `opacity` `clipsContent` `rotation` `blendMode` |
| 填充描边 | `fill` `stroke` `strokeWeight` `strokeAlign` |
| 效果 | `effects`（阴影 / 模糊数组） |
| 圆角 | `radius`（数字，或 `[左上,右上,右下,左下]`） |
| 几何 | `w` `h` `x` `y` |
| auto-layout | `layout`（切换 `V`/`H`/`NONE`） `wrap` `gap` `pad` `main` `cross` `layoutSizingHorizontal` `layoutSizingVertical` `layoutGrow` `positioning` |
| 文本 | `text` `font` `fontStyle` `fontSize` `lineHeight` `letterSpacing` `align` `valign` `textAutoResize` |
| 样式引用 | `textStyle` `fillStyle` `strokeStyle` `effectStyle`（本地样式，按 id 或名字；`null` 解除） |
| 交互 | `reactions`（原始 Reaction 数组，dump 读出来什么样就写回什么样） |

### 别名：dump 的字段名可以直接回写

`dump` 用短名贴近 SPEC_DSL，`set` 用规范名贴近 Figma API。**两套都接受**（规范名优先）：

| dump 输出 | 等价于 `set` 里 |
|---|---|
| `size` | `fontSize` |
| `clip` | `clipsContent` |
| `autoResize` | `textAutoResize` |
| `sizing: { h, v }` | `layoutSizingHorizontal` / `layoutSizingVertical` |

### 覆盖层：`positioning: "ABSOLUTE"`

auto-layout 的子节点默认参与布局流，`x`/`y` 会被忽略。要叠一层覆盖物
（底部渐变遮罩、角标、浮动按钮）就切成绝对定位：

```jsonc
{ "id": "12:345", "set": { "positioning": "ABSOLUTE", "x": 0, "y": 739.5 } }
```

同一个 op 里写 `positioning` 和 `x`/`y` **有顺序保证**（先切模式再落坐标），
不会误报"x/y 会被忽略"。改回 `"AUTO"` 重新参与布局。

### 效果（`effects`）的写法

```jsonc
{ "effects": [
    { "type": "DROP_SHADOW", "radius": 12, "spread": 0,
      "offset": { "x": 0, "y": 4 }, "color": "#00000040" },
    { "type": "LAYER_BLUR", "radius": 6 }
] }
```

支持 `DROP_SHADOW` / `INNER_SHADOW`（用 `color`/`offset`/`radius`/`spread`）、
`LAYER_BLUR` / `BACKGROUND_BLUR`（只用 `radius`）。`[]` 表示清空。

### 颜色与填充

| 写法 | 结果 |
|---|---|
| `"#RRGGBB"` / `"#RRGGBBAA"` / `"#RGB"` | 实色（末两位是 alpha） |
| `null` | 去填充 |
| 数组 | 展平成多重填充 |
| `{ "gradient": true, "stops": [[0,"#FFF"],[1,"#000"]], "angle": 90 }` | 线性渐变 |
| `{ "image": "<base64 或 dataURI>", "scaleMode": "FILL" }` | 图片填充 |
| `{ "imageHash": "…" }` | 复用画布上已有的图片 |

**渐变 `angle` 是反直觉的，用前先看**：

| `angle` | 方向 | `stops[0]` 在 |
|---|---|---|
| `0` | 左 → 右 | 左 |
| `90` | 上 → 下 | 上 |
| `180`（默认） | 右 → 左 | 右 |
| `270` | 下 → 上 | 下 |

### 两个限制

**① auto-layout 子节点的 `x`/`y` 会被忽略** —— 会明确报错，不会静默无效：

```json
{ "position": { "error": "父容器是 auto-layout，x/y 会被忽略；请改布局属性（gap/pad/顺序），或先设 \"positioning\":\"ABSOLUTE\" 转为覆盖层" } }
```

**② `w`/`h` 在 auto-layout 父容器里可能被布局覆盖** —— 会回报警告（绝对定位的例外）。

---

## 7. `dump` 输出的字段

```
id  type  name  x  y  w  h  abs
fill  stroke  strokeWeight  strokeAlign
radius  opacity  visible  blendMode  effects  rotation
layout  gap  pad  main  cross  wrap
sizing{h,v}  positioning  layoutGrow  clip
text  font  fontStyle  size  align  valign  autoResize  lineHeight  letterSpacing
textStyle{id,name}  fillStyle{...}  strokeStyle{...}  effectStyle{...}
mainComponent{id,name}  componentProperties  isComponent
reactions
children[]  childCount  truncated
```

**哪些是"信息"，哪些能写回**：

| 类别 | 字段 |
|---|---|
| ✅ 能直接写回 | 除下面两类之外的绝大部分（含别名） |
| ℹ️ 只读信息 | `abs` `mainComponent` `componentProperties` `isComponent` `childCount` `truncated` |
| ⚠️ 只有已知写法能写回 | 图片填充：`dump` 只回传 `imageHash`（不回传字节），所以「换图」要自己给 base64，「搬图」用 `imageHash` 即可 |

`reactions` 是**原样输出原样写回**的 —— 连 Figma 自己加的字段都保留，所以将来
Figma 加新字段也不会丢。

---

## 8. 规格 DSL（`insert` / `render` 用）

```jsonc
{
  // 可选。给了名字才会切到/创建该页；省略则渲染到当前页。
  // 推荐省略，把目标页交给 CLI：--page 或 DSH_FIGMA_PAGE。
  "page": "草稿",
  "frames": [ /* 顶层节点数组 */ ]
}
```

节点字段：`type`（`FRAME`/`RECT`/`ELLIPSE`/`TEXT`/`LINE`）、`name`、`x` `y`、
`w` `h`（数字 | `"fill"` | `"hug"`）、`positioning`、`rotate`、`opacity`、`fill`、
`radius`、`stroke`、`strokeWeight`、`strokeAlign`、`dash`、`shadow`、
`layout`、`gap`、`pad`、`main`、`cross`、`wrap`、`clip`、`grow`、`stretch`、
`positioning`、`children`。

> **SPEC_DSL 不建组件/交互。** 组件是"从真实稿子里长出来"的 —— 在现有稿上迭代时，
> 你要的是"把这张卡片变成组件、再摆五个实例"，那用 `component` / `instance` 命令。
> 详见 `docs/SPEC_DSL.md`。

完整参考见 [`SPEC_DSL.md`](SPEC_DSL.md)。

---

## 9. 护栏、上限与超时

### 安全护栏

| 护栏 | 行为 |
|---|---|
| `patch` / `rm` / `move` / `dup` / `group` / `ungroup` / `component` / `swap` / `detach` / `reactions` / `link` **必须带选择器** | 没有选择器会命中整页 → **直接拒绝**；确要全量写 `"all": true` |
| `--dry` | **真的不写入**（只计算并报告会做什么）。v1.5.0 修过一次「广告了却照写」的 bug，见 P27；有 8 个回归测试守着 |
| `rm` 匹配 > 200 个 | 拒绝，需要 `force` |
| `dup` 匹配 > 200 个 | 拒绝，需要 `force` |
| `dup` / `instance` 的 `count` | 上限 20 |
| `render` 默认不清空 | 要清空必须显式 `--clear` |
| `clear` | 必须 `--yes` |
| 页名不存在时 `clear` | 什么都不删并报错 |
| 每次真实写入 | 调 `figma.commitUndo()`，可在 Figma 里整批 `⌘Z` |

### 上限与超时

| 项 | 值 | 位置 |
|---|---|---|
| 桥端口 | 8787（`DSH_FIGMA_PORT` 覆盖） | `bridge/server.mjs` |
| 插件心跳 TTL | 40s | `PLUGIN_TTL_MS` |
| 长轮询挂起 | 25s | `POLL_TIMEOUT_MS` |
| 队列指令存活 | 60s（`DSH_QUEUE_TTL_MS`） | `QUEUE_TTL_MS` |
| **插件离线后中止在途指令** | 45s（`DSH_OFFLINE_FAIL_MS`） | `OFFLINE_FAIL_MS` |
| HTTP body 上限 | 80 MB | `MAX_BODY` |
| CLI 等待 | dump 180s / patch 300s / insert 300s / 其余 60–180s | `tools/figma.mjs` |
| `dump` 深度/节点上限 | `--depth 8` / `--max 4000`（默认） | — |

> 端口写在 `plugin/manifest.json` 的 `allowedDomains` 里，**改端口要同步改 manifest 并重新导入**。
> `allowedDomains` **只能写域名，不能写 IP**（Figma 会拒绝 `http://127.0.0.1:8787`）。

---

## 10. 错误语义与已知缺口

### 报错的三种形态

| 形态 | 什么时候 | CLI 表现 |
|---|---|---|
| **抛错** | 选择器缺失、找不到目标、参数非法（`nav`/`trigger`/`transition` 取值错） | 退出码 1，打印 `✖ …` |
| **逐项 `error`** | 批量操作里个别节点不适用（如对非实例 `swap`、对 RECT `component`） | 打印 `✖ 名字: 原因`，其余继续 |
| **警告** | 操作生效但可能被布局覆盖（auto-layout 子节点改 `w`/`h`） | 在审计里标 `warning` |

**`patch` 的 op 级错误不会让整条命令失败**（HTTP 200 + `results[].error`），
但匹配 0 个节点时 CLI 会打印 `✖ 未修改任何节点`。

### 已知缺口（截至 v1.5.1）

| # | 缺口 | 影响 |
|---|---|---|
| 1 | ~~**`export` 无法指定页面**~~ | ✅ 已修（v1.5.1）：CLI 与桥都透传 `pageName` |
| 2 | **组件属性只读** | `componentProperties` 能读；`addComponentProperty` / `editComponentProperty` 没实现 → 实例无法真正参数化 |
| 3 | **只认本地样式** | 从团队库同步的远程样式不在 `styles` 里（需要 `importStyleByKeyAsync`） |
| 4 | **改实例内部节点未验证** | 会产生 override 还是改到主组件，没实测 |
| 5 | **混合字体改文案未验证** | `fontName === figma.mixed` 时 `ensureFontsLoaded()` 逐字符扫描，可能偏慢 |
| 6 | **渐变角度不可还原** | Figma 存的是变换矩阵，`dump` 只能原样保留 `transform`，无法还原成 `angle` |
| 7 | **SPEC_DSL 不建组件/交互** | 从零生成模式下无法产出 COMPONENT/INSTANCE |
| 8 | **`npm` 环境未测** | `package.json` 里的 scripts 保留着，但本项目一直在无 npm 环境跑 |

完整清单与优先级见 [`ROADMAP.md`](ROADMAP.md)。

---

## 11. 文档索引

| 文档 | 内容 |
|---|---|
| **`CAPABILITIES.md`**（本文） | 能力全表 + 用法 + 边界 |
| [`REVIEW.md`](REVIEW.md) | **审查指南**：代码索引、已验证矩阵、高风险区、如何复现 |
| [`ITERATING.md`](ITERATING.md) | 在现有稿上迭代的完整用法（当前主模式） |
| [`SPEC_DSL.md`](SPEC_DSL.md) | 规格 DSL 完整参考（从零生成模式） |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 数据流、协议、设计决策 |
| [`PITFALLS.md`](PITFALLS.md) | **27 个坑**的现象 / 根因 / 修法 |
| [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) | 症状 → 诊断 → 修复 |
| [`ROADMAP.md`](ROADMAP.md) | 已验证/未验证、已知问题、后续方向 |
| [`../AGENTS.md`](../AGENTS.md) | 开发者交接（先读这份） |
