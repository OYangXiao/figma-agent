# 在现有设计稿上迭代

这是本项目当前的主要工作模式：**读你画布上已有的设计 → 就地修改 → 不回退你的图层结构**。

与「从零生成」是两条不同的路径：

| | 从零生成 | 在现有稿上迭代（本文） |
|---|---|---|
| 输入 | 我写的 SPEC_DSL | 你画布上已有的节点 |
| 写方式 | `render` 创建新节点 | `patch` / `insert` / `rm` 就地改 |
| 是否清空页面 | 可选 | **绝不清空**（`render` 默认已不清空） |
| 保留图层名/结构 | 不适用 | ✅ 保留 |
| 关键能力 | 渲染引擎 | `dump` 读取 + `patch` 精确修改 |

---

## 1. 三步循环

```bash
./fimg ping                    # 0. 确认插件在线
./fimg list                    # 1. 看结构（树状大纲，快速定位）
./fimg dump --name "卡片"    # 2. 读细节（→ dumps/*.json）
./fimg patch --ops ops.json --dry   # 3. 先 dry-run 看会改什么
./fimg patch --ops ops.json         #    确认后真改
```

改完直接 `./fimg export` 导出截图核对——**读-改-看**闭环。

### 目标页面：默认就是你正在看的那一页

所有读写命令都**默认作用于 Figma 的「当前页」**，这是迭代模式下唯一正确的目标。

```bash
./fimg stats                            # 统计当前页
./fimg dump --name "卡片" --page "草稿"  # 读指定页
DSH_FIGMA_PAGE=草稿 ./fimg list          # 整轮会话固定用某页
```

| 命令 | 不给 `--page` 时 |
|---|---|
| `stats` / `list` / `dump` | 当前页，**绝不新建页面** |
| `clear` | 当前页，**绝不新建页面**（页名拼错就什么都不删并报错） |
| `render` | 当前页；只有 `--page 名称` 指向一个**不存在的页**时才新建 |

> 以前这里硬编码了 `FIMG Prototype`。页面一改名，`stats` 就报「未找到页面」，
> `render` 还会凭空新建一个空页——而你以为画在了自己的稿上。见 `PITFALLS.md` P19。

---

## 2. 选择器（给谁改）

`patch` 的每个 op、以及 `rm` / `move` / `dup` / `group` / `ungroup`，
都靠选择器定位节点。多个条件是与关系。

| 选择器 | 说明 | 例子 |
|---|---|---|
| `id` | 精确命中一个节点（最稳） | `{"id":"12:345"}` |
| `ids` | 一批 id | `{"ids":["12:345","12:346"]}` |
| `selection` | 你当前选中的节点 | `{"selection":true}` |
| `name` | **图层名**。支持精确 / `*` `?` 通配 / `/正则/` | `{"name":"Row·*"}`、`{"name":"/^Index·/"}` |
| `text` | **文本内容**（仅 TEXT 节点）。同样支持通配与正则 | `{"text":"提交订单"}`、`{"text":"买入*"}` |
| `type` | 节点类型。**DSL 名与 Figma 名都认**（`RECT` = `RECTANGLE`） | `{"type":"TEXT"}` |
| `layout` | 布局方向 `V` / `H` | `{"layout":"H"}` |
| `within` | **范围修饰**：只在某个容器的子树里找 | `{"name":"Row","within":"12:400"}` |

> ⚠️ **`name` 匹配的是图层名，不是文案内容。**
> Figma 里文本节点的图层名常常是无意义的 `Text`，所以想按"写着什么"来找，
> **必须用 `text`**。

### ⚠️ 同名图层遍地时，一定要用 `within`

真实设计稿里 `Frame` / `Text` / `Row` 这种名字会出现几十次。不给范围的话
一个 `{"name":"Row"}` 会命中**整个页面**的 Row：

```bash
# ❌ 可能在几十个 Row 上生效
./fimg patch --ops ops.json

# ✅ 限定在「列表容器」这棵子树里
./fimg patch --ops ops.json --within 12:400
```

`within` 是**范围**不是条件——只写 `within` 不写别的，等于"这个容器的整个子树"：

```bash
./fimg dump --within 12:400 --depth 2      # 读这个容器的子树（保留层级）
./fimg dup  --type RECT --within 12:400 --count 3
```

单个 op 也可以自己带 `within`（CLI 的 `--within` 会注入到没写 `within` 的 op）。

### 怎么拿到 id

```bash
./fimg list                              # 大纲里每行末尾都有 #id
./fimg dump --name "卡片" --out x.json  # dump 出来的每个节点都带 id
```

或者你在 Figma 里选中节点，然后：

```bash
./fimg sel                               # 读当前选区（含 id 与完整属性）
```

---

## 3. 可改的属性

`ops[].set` 里能写的字段：

| 分类 | 字段 |
|---|---|
| 基础 | `name` `visible` `opacity` `clipsContent` `rotation` `blendMode` |
| 填充描边 | `fill` `stroke` `strokeWeight` `strokeAlign` |
| 效果 | `effects`（阴影 / 模糊数组，dump 读出来什么样就能写回什么样） |
| 样式引用 | `textStyle` `fillStyle` `strokeStyle` `effectStyle`（本地样式，按 id 或名字） |
| 图片 | `fill` 写 `{"image":"<base64>"}` 新建，或 `{"imageHash":"…"}` 复用已有图片 |
| 圆角 | `radius`（数字，或 `[左上,右上,右下,左下]`） |
| 几何 | `w` `h` `x` `y` |
| auto-layout | `layout`（切换 `V`/`H`/`NONE`） `wrap` `gap` `pad` `main` `cross` `layoutSizingHorizontal` `layoutSizingVertical` `layoutGrow` `positioning` |
| 文本 | `text` `font` `fontStyle` `fontSize` `lineHeight` `letterSpacing` `align` `valign` `textAutoResize` |

### 覆盖层：`positioning: "ABSOLUTE"`

auto-layout 的子节点默认参与布局流，`x`/`y` 会被忽略（插件会明确报错）。
要做**叠在容器上的覆盖层**（底部渐变遮罩、角标、浮动按钮），把它切成绝对定位：

```jsonc
{ "id": "2:1417", "set": { "positioning": "ABSOLUTE", "x": 0, "y": 739.5 } }
```

同一个 op 里写 `positioning` 和 `x`/`y` **有顺序保证**：插件先切模式再落坐标，
所以不会误报「x/y 会被忽略」。改回 `"AUTO"` 就重新参与布局。

`insert` 的 SPEC_DSL 也支持它（字段名相同）：

```jsonc
{ "type": "RECT", "name": "ScrollFade", "w": 390, "h": 28,
  "positioning": "ABSOLUTE", "x": 0, "y": 739.5,
  "fill": { "gradient": "linear", "angle": 90, "stops": [[0, "#FFFFFF00"], [1, "#FFFFFFFF"]] } }
```

> 为什么需要它：详情页滚区底部的渐变遮罩就是靠这个叠上去的。
> 没有它，加进滚区的节点会被当成内容一起滚走。

### dump 出来的字段可以直接回写

`dump` 为了贴近 SPEC_DSL 用了短名，`set` 为了贴近 Figma API 用了规范名。
两套名字**都接受**，所以你可以把 dump 的节点直接当 `set` 用（规范名优先）：

| dump 输出 | 等价于 `set` 里的 |
|---|---|
| `size` | `fontSize` |
| `clip` | `clipsContent` |
| `autoResize` | `textAutoResize` |
| `sizing: { h, v }` | `layoutSizingHorizontal` / `layoutSizingVertical` |

> 这层别名是后补的：在它存在之前，上面四个字段回写会**静默无效**。
> 见 `PITFALLS.md` P21。

### 样式引用：按名字或 id 应用本地样式

先用 `styles` 看这个文件里有哪些样式，再把名字写进 `set`：

```bash
./fimg styles
#   文件「Untitled」的本地样式：
#     文本样式（2）
#        · 标题/H1   S:text1
#        · 正文/Body S:text2
```

```jsonc
{ "ops": [
    { "id": "12:345", "set": { "textStyle": "标题/H1" } },     // 按名字
    { "id": "12:346", "set": { "fillStyle": "S:paint1" } },    // 按 id
    { "id": "12:347", "set": { "textStyle": null } }           // 解除引用（保留当前外观值）
] }
```

名字写错会明确报错并列出可选项，不会静默失效：

```
✖ name=Card → 找不到本地样式「标题/H2」（可选：标题/H1, 正文/Body）
```

> ⚠️ 只认**本地样式**。从团队库同步下来的远程样式不在其中
> （那种要用 `importStyleByKeyAsync`，目前没做）。

### 图片填充

两种写法：

```jsonc
// ① 塞一张新图（base64 或 dataURI）
{ "id": "12:345", "set": { "fill": { "image": "<base64>", "scaleMode": "FILL" } } }

// ② 复用画布上已有的图片 —— dump 读出来的就是这个形态，可以原样回写
{ "id": "12:346", "set": { "fill": { "image": true, "imageHash": "94e301f8…", "scaleMode": "FILL" } } }
```

`scaleMode` 取 `FILL`（默认，铺满并裁剪）/ `FIT`（完整放入并留边）/ `TILE` / `CROP`。

> `dump` 只回传 `imageHash`（不回传字节），所以**换图**要自己给 base64，
> **搬图**（把同一张图用到别处）直接用 `imageHash` 就行。

### 两个重要限制

**① auto-layout 子节点的 `x`/`y` 会被忽略。**
插件会明确回报警告，而不是静默无效：

```json
{ "position": { "error": "父容器是 auto-layout，x/y 会被忽略；请改布局属性（gap/pad/顺序），或先设 \"positioning\":\"ABSOLUTE\" 转为覆盖层" } }
```

要调整位置，请改父容器的 `gap`/`pad`/`main`/`cross`，或调整子节点顺序；
要做覆盖层就设 `positioning: "ABSOLUTE"`。

**② `w`/`h` 在 auto-layout 父容器里可能被布局覆盖。** 同样会回报警告（绝对定位的子节点例外）。

### effects 的写法

`dump` 读出来的 `effects` 数组可以直接原样写回。手写的话：

```jsonc
{ "effects": [
    { "type": "DROP_SHADOW", "radius": 12, "spread": 0,
      "offset": { "x": 0, "y": 4 }, "color": "#00000040" },
    { "type": "LAYER_BLUR", "radius": 6 }
] }
```

支持的 `type`：`DROP_SHADOW` / `INNER_SHADOW`（用 `color`/`offset`/`radius`/`spread`）、
`LAYER_BLUR` / `BACKGROUND_BLUR`（只用 `radius`）。写成 `[]` 表示清空效果。
颜色是 8 位 hex，末两位是 alpha —— 和 `fill` 的写法一致。

---

## 4. ops 文件格式

```jsonc
{
  "ops": [
    // 改品牌色：按图层名通配
    { "name": "Btn/Primary", "set": { "fill": "#2B6DE5" } },

    // 改文案：按内容选（最常用）
    { "text": "提交订单", "set": { "text": "确认支付" } },

    // 改字体
    { "text": "标题*", "set": { "font": "PingFang SC", "fontStyle": "Semibold", "fontSize": 20 } },

    // 改圆角与内边距
    { "name": "Card", "set": { "radius": 16 } },
    { "name": "Card/Inner", "set": { "pad": [16, 20, 16, 20], "gap": 12 } },

    // 按 id 精确改
    { "id": "12:345", "set": { "visible": false } },

    // 正则匹配一批
    { "name": "/^Icon\\//", "set": { "opacity": 0.6 } }
  ]
}
```

颜色写法与 SPEC_DSL 一致：`#RRGGBB` / `#RRGGBBAA` / `null`（去填充）/ 渐变对象 / 数组（多填充）。

### ⚠ 每个 op 必须带选择器

漏写选择器的 op 会匹配**整个页面**。这在改稿时几乎总是笔误（漏了 `id`、
或把字段名写成了 `nodeId`），代价却是整页被改花。所以插件会**拒绝执行**它：

```
✖ (无选择器) → 该 op 没有选择器，会匹配整个页面。确认要全量修改请显式写 "all": true
```

真要全量改（例如统一字体），把意图显式写出来：

```jsonc
{ "ops": [ { "all": true, "type": "TEXT", "set": { "font": "PingFang SC" } } ] }
```

`rm` 也是同样的规则，并且额外保留「超过 200 个节点需要 `force`」这道防线。
见 `PITFALLS.md` P20。

### 先看再改

```bash
./fimg patch --ops ops.json --dry
```

输出会逐节点列出**改前 → 改后**：

```
（dry-run，未写入） 共匹配 3 个节点
  · text=提交订单 → 匹配 1 个
      #12:345 Text  text: "提交订单" → "确认支付"
  · name=Card → 匹配 2 个
      #12:400 Card  radius: 8 → 16
      #12:410 Card  radius: 8 → 16
```

确认无误后去掉 `--dry`。每次真实写入后会调用 `figma.commitUndo()`，
所以你在 Figma 里 `⌘Z` 可以整批撤销。

---

## 5. 增删改结构

### 往现有容器里插东西

```bash
# 插到选中的容器里（先在 Figma 里选中一个 Frame）
./fimg insert specs/stock-app.json --frame "01 行情"

# 或指定父容器
./fimg insert --parent 12:345
./fimg insert --parent-name "内容区" --index 0
```

`insert` 用的是与 `render` **同一套 SPEC_DSL**，所以你可以先从 `dump` 里抄一段结构改改再插回去。

### 删除（危险，默认 dry-run 友好）

```bash
./fimg rm --name "旧卡片" --dry     # 先看会删什么
./fimg rm --text "已废弃*"          # 按文案删
```

超过 200 个节点会拒绝执行，需要显式 `force`。这个上限是防止一个手滑的通配符删掉整页。

---

## 5.1 移动 / 复制 / 成组

这三类是改稿时最频繁的动作，都支持完整选择器 + `--within`。

### `move` —— 改顺序，或搬到别的容器

```bash
# 把某个 Row 挪到列表最前面（auto-layout 里 index 0 = 最前）
./fimg move --name "Row·贵州茅台" --within 12:400 --to 12:400 --index 0

# 搬到另一个容器（不给 --index 就放末尾）
./fimg move --id 12:345 --to 12:900
```

`--index` 的含义跟随 Figma：

| 父容器 | index 0 是 |
|---|---|
| auto-layout | 布局顺序的**第一个**（最上/最左） |
| 普通容器 | **z 序最底层** |

> 审计里报的是**实际落到哪个 index**，不是你请求的那个 ——
> 在同一个容器里移动时，移除动作会让索引偏移，报实际值才不会误导。

### `dup` —— 复制（含整棵子树）

```bash
./fimg dup --id 12:345                       # 原地复制一份
./fimg dup --name "Card" --within 12:400 --count 3     # 复制 3 份
./fimg dup --id 12:345 --to 12:900 --dx 20 --dy 20     # 复制到别处并偏移
./fimg dup --id 12:345 --rename "Card·副本"
```

- `--count` 最多 20；匹配节点数超过 200 需要 `force`（和 `rm` 同一套护栏）
- `--dx/--dy` 只对**非 auto-layout** 父容器有意义（auto-layout 里位置由布局决定）
- ⚠️ `--name` 是"选择谁复制"，给副本改名要用 **`--rename`**

### `group` / `ungroup`

```bash
./fimg group   --ids 12:345,12:346 --rename "一组"
./fimg ungroup --id 12:400
```

- `group` 要求所有节点**同一个父容器**（不满足会直接报错，提示你先用 `move` 搬到一起）
- `ungroup` 会释放子节点并原地保留；如果子节点本来在 auto-layout 里，
  解组后它们会回到父容器的布局流中

## 5.2 组件与实例

有设计系统之后，搭页面就是"摆实例 + 改文案"。这四个命令都只作用于**画布上的现有节点**
（SPEC_DSL 不建组件，因为组件是"从真实稿子里长出来"的，见 §5.3）。

```bash
# 把画好的 Frame 变成组件（原地替换，图层结构全保留）
./fimg component --name "卡片" --within 12:400 --rename "卡片/基础"

# 摆实例（有多个同名组件时会提示歧义，建议用 --of <id>）
./fimg instance --of 12:900 --parent 12:401 --count 3 --x 16 --y 80

# 换实例的主组件
./fimg swap --name "卡片/基础" --within 12:401 --to-name "卡片/高价"

# 脱离组件（之后可以随便改，不再受主组件约束）
./fimg detach --ids 12:950,12:951
```

读回来：

```bash
./fimg dump --type INSTANCE --depth 0
#   mainComponent: { id, name }        ← 主组件
#   componentProperties: {...}         ← 可覆盖的属性（只读信息）
./fimg dump --type COMPONENT --depth 1
#   isComponent: true
```

> **`component` 会替换原节点**，旧 id 立刻失效 —— 命令返回的是**新组件**的 id。
> 这一点和 `ungroup` 一样，见 `PITFALLS.md` P24。

### 组件相关的审计字段

| 字段 | 含义 |
|---|---|
| `mainComponent` | 实例的主组件（id + 名字）。dynamic-page 下是**异步**读出来的，见 P26 |
| `componentProperties` | 这个实例能覆盖哪些属性（只读；没定义属性时不出现在 dump 里） |
| `isComponent` | 这个节点本身是组件 |

## 5.3 原型交互（连线）

```bash
# 点击「买入」按钮 → 跳到「03 详情」页
./fimg link --name "买入" --within 12:400 --to-name "03 详情"

# 悬停 → 覆盖层，用溶解过渡
./fimg link --id 12:345 --to 12:900 --trigger ON_HOVER --nav OVERLAY --transition DISSOLVE

# 2 秒后自动跳转
./fimg link --id 12:345 --to-name "首页" --trigger AFTER_TIMEOUT --timeout 2

# 点击打开网址
./fimg link --id 12:345 --url "https://example.com"

# 读回来（目标会解析成名字）
./fimg reactions --within 12:400

# 追加一条 / 清空全部
./fimg link --id 12:345 --to-name "首页" --append
./fimg link --id 12:345 --clear
```

**取值**（写错会直接报错，不会静默用默认值）：

| 参数 | 可选值 |
|---|---|
| `--trigger` | `ON_CLICK`（默认）`ON_HOVER` `ON_PRESS` `ON_DRAG` `AFTER_TIMEOUT` `MOUSE_ENTER` `MOUSE_LEAVE` `MOUSE_UP` `MOUSE_DOWN` |
| `--nav` | `NAVIGATE`（默认）`SWAP` `OVERLAY` `SCROLL_TO` `CHANGE_TO` |
| `--transition` | `SMART_ANIMATE`（默认）`INSTANT` `DISSOLVE` `MOVE_IN` `MOVE_OUT` `PUSH` `SLIDE_IN` `SLIDE_OUT` |
| `--timeout` | 秒（仅 `AFTER_TIMEOUT`） |
| `--duration` / `--easing` | 过渡时长与缓动 |

默认是**替换**该节点上的全部交互；`--append` 追加，`--clear` 清空。

> ⚠️ **`link`/`swap` 的 `--to` 是"连到哪个节点"**，
> 而 `move`/`dup`/`instance` 的 `--to` 是"放进哪个容器"。同名不同义，用错会报错（不会静默）。

### 交互也满足读写对称

`dump` 会原样输出 `reactions`（含 Figma 自己的字段），`patch` 能原样写回：

```bash
./fimg dump --id 12:345 --out dumps/btn.json     # 含 reactions
# 改完再写回，交互一个字段都不丢
```

> 为什么不做"只在 DSL 里建组件"：组件是**从真实稿子里长出来的**。
> 在现有稿上迭代时，你要的是"把这张卡片变成组件、再摆五个实例"，
> 而不是重新声明一棵组件树。真要那么做，属于"从零生成"模式的扩展，
> 见 `ROADMAP.md` C 节。

---

## 6. 常见任务配方

**换品牌色**

```bash
# 1. 先看现在的颜色分布
./fimg dump --type RECT --depth 3 --out dumps/rects.json
# 2. 按颜色找？—— 用 grep 在 dump 里筛
python3 -c "
import json;d=json.load(open('dumps/rects.json'))
def w(n):
    if n.get('fill')=='#E8453C': print(n['id'], n['name'])
    for c in n.get('children',[]): w(c)
for n in d['nodes']: w(n)"
```

**统一字体**

```json
{ "ops": [ { "type": "TEXT", "set": { "font": "PingFang SC", "fontStyle": "Regular" } } ] }
```

**把某个组件实例全部放大 1.1 倍**

先 `dump` 拿到 id 列表，再生成 ops：

```bash
node -e "
const d=require('./dumps/x.json');
const ops=[];
const w=(n)=>{ if(n.name && n.name.startsWith('Card')) ops.push({id:n.id,set:{w:Math.round(n.w*1.1),h:Math.round(n.h*1.1)}});
  (n.children||[]).forEach(w); };
d.nodes.forEach(w);
require('fs').writeFileSync('ops.json',JSON.stringify({ops},null,1));
"
```

---

## 7. 安全约定

| 约定 | 原因 |
|---|---|
| `render` **默认不清空**页面 | 在现有稿上工作时，误清空的代价太大。要清空必须显式 `--clear` |
| 所有命令默认只作用于**当前页** | 不再硬编码页名；读操作绝不新建页面（P19） |
| `clear` 必须加 `--yes` | 会删光目标页面；页名不存在时什么都不删并报错 |
| `patch`/`rm` 的 op 必须带选择器 | 漏写会命中整页；全量修改要显式写 `"all": true`（P20） |
| `rm` 默认建议先 `--dry`，超过 200 个需 `force` | 防止通配符手滑 |
| `patch` 有 `--dry` | 先看"改前 → 改后"再落地 |
| 每次写入调用 `figma.commitUndo()` | 你在 Figma 里可以整批 `⌘Z` 撤销 |
| **建议先复制一份页面再大改** | 最后一道保险，插件管不了 |

---

## 8. 测试

读取/修改逻辑有单元测试，**不需要 Figma**：

```bash
./fimg test
```

它用一个 Figma API 桩（`test/figma-stub.mjs`）执行**真实的** `plugin/code.js`，
通过真实的 `figma.ui` 消息通道下发指令，覆盖 42 个用例：
渲染、dump 往返、颜色 hex 往返、**dump→patch 字段别名往返**、各种选择器、
dryRun 不写入、**无选择器护栏**、auto-layout 警告、**页名解析（读操作不建页）**、
insert/remove/selection 边界等。

> ⚠️ 桩是**近似**，不是 Figma 模拟器。它能抓住逻辑错误、字段写错、分支漏掉，
> 但保证不了 Figma 的真实行为。关键改动仍需在 Figma 里用 `export` 核对。
>
> 尤其注意：桩不知道用户的页面叫什么名字，也不会抱怨"改了个不存在的字段"——
> P19（硬编码页名）和 P21（字段名不对称）就是**桩测试全绿**却真实存在的缺陷。

**改 `plugin/code.js` 后先跑 `./fimg test`**，再去 Figma 里试——Figma 往返贵得多。
