# 规格 DSL 参考

规格是一个 JSON 对象，插件把它渲染成真实的 Figma 节点树。

```jsonc
{
  // 可选。给了名字才会切到/创建该页面；省略则渲染到 Figma 的「当前页」。
  // 推荐省略，把目标页交给调用方：`./fimg render --page "草稿"` 或 DSH_FIGMA_PAGE=草稿。
  // 注意：规格里钉死页名，页面一旦改名就会凭空新建一个空页（见 PITFALLS.md P19）。
  "page": "草稿",
  "frames": [ /* 顶层节点数组 */ ]
}
```

每个节点：

```jsonc
{ "type": "FRAME", "name": "卡片", "w": 358, "h": 200, "children": [ /* … */ ] }
```

`type` 取 `FRAME`（默认） / `RECT` / `ELLIPSE` / `TEXT` / `LINE`。

---

## 1. 所有节点通用

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `type` | string | `FRAME` | 节点类型 |
| `name` | string | 类型名 | Figma 图层名 |
| `x` `y` | number | `0` | **仅当父容器不是 auto-layout 时有效**；在 auto-layout 里会被忽略（除非设了 `positioning`） |
| `w` `h` | number \| `"fill"` \| `"hug"` | 见各类型 | 尺寸。在 auto-layout 子节点上 `fill`/`hug` 有特殊含义（见 §6） |
| `positioning` | `"ABSOLUTE"` | — | 脱离 auto-layout 布局流，按 `x`/`y` 叠在父容器上（见 §6.1） |
| `rotate` | number | `0` | **顺时针**角度（插件内部取负后赋给 `node.rotation`） |
| `opacity` | number 0–1 | `1` | ⚠️ **会继承给子节点**，不要用它做容器淡色底，见 `docs/PITFALLS.md` P4 |
| `fill` | 颜色值 \| `null` | 见各类型 | `null` = 无填充 |
| `radius` | number \| `[tl,tr,br,bl]` | `0` | 圆角 |
| `stroke` | 颜色值 | — | 描边 |
| `strokeWeight` | number | `1` | 描边宽度 |
| `strokeAlign` | `"INSIDE"` \| `"OUTSIDE"` \| `"CENTER"` | `INSIDE` | 描边对齐 |
| `dash` | number[] | — | 虚线模式，如 `[3, 3]` |
| `shadow` | `true` \| 对象 | — | 投影。对象字段：`color` `x` `y` `blur` `spread`。默认 `{color:'#0000001A', x:0, y:4, blur:12}` |

### 颜色值格式

| 写法 | 结果 |
|---|---|
| `"#RRGGBB"` | 实色 |
| `"#RRGGBBAA"` | 带透明度（`#00000000` = 完全透明） |
| `"#RGB"` | 简写展开 |
| `null` | 无填充 |
| `"#FFF"` 数组 | 数组会**展平**为多重填充 |
| `{ "color": "#FFF" }` | 等价于 `"#FFF"` |
| `{ "gradient": true, "stops": [[0,"#FFF"],[1,"#000"]], "angle": 180 }` | 线性渐变。`angle` 单位为度 |
| `{ "image": "<base64 或 dataURI>", "scaleMode": "FILL" }` | 图片填充。`scaleMode`：`FILL` / `FIT` / `TILE` / `CROP` |
| `{ "imageHash": "…" }` | 复用画布上已有的图片（`dump` 读出来的就是这个形态，可原样回写） |

`angle` 决定 `stops[0]` 落在哪一侧（**反直觉，用之前先看这张表**）：

| `angle` | 方向 | `stops[0]` 在 |
|---|---|---|
| `0` | 左 → 右 | 左 |
| `90` | 上 → 下 | 上 |
| `180`（默认） | 右 → 左 | 右 |
| `270` | 下 → 上 | 下 |

例：底部淡出遮罩用 `angle: 90` + `stops: [[0,"#FFFFFF00"], [1,"#FFFFFFFF"]]`
（顶部透明 → 底部不透明白）。

---

## 2. `FRAME`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `layout` | `"V"` \| `"H"` \| 省略 | 省略 | 省略 = **绝对定位**（子节点用 `x`/`y`）。也接受 `VERTICAL`/`COLUMN`/`COL`/`ROW`/`HORIZONTAL`/`NONE` |
| `w` `h` | number \| `"fill"` \| `"hug"` | `"hug"` | **auto-layout 时省略 `w` 会默认 HUG**（包裹内容） |
| `pad` / `padding` | number \| `[v,h]` \| `[t,r,b,l]` \| `{t,r,b,l,x,y}` | `0` | 内边距 |
| `gap` | number | `0` | 主轴间距（`wrap` 时也是行间距） |
| `main` | `"MIN"`\|`"CENTER"`\|`"MAX"`\|`"SPACE_BETWEEN"` | `MIN` | 主轴对齐 |
| `cross` | `"MIN"`\|`"CENTER"`\|`"MAX"` | `MIN` | 交叉轴对齐 |
| `wrap` | boolean | `false` | 开启换行（`layoutWrap:'WRAP'`） |
| `clip` | boolean | `true` | 是否裁剪超出内容 |
| `fill` / `bg` | 颜色值 | `"#FFFFFF"` | 背景。`fill: null` 为无背景 |

```jsonc
{ "type": "FRAME", "layout": "H", "w": "fill", "h": 62, "pad": [0, 14],
  "gap": 8, "main": "SPACE_BETWEEN", "cross": "CENTER",
  "fill": "#FFFFFF", "radius": 10, "children": [ /* … */ ] }
```

---

## 3. `TEXT`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `text` / `characters` | string | `""` | 文本内容 |
| `size` / `fontSize` | number | `14` | 字号 |
| `font` | string | 自动回退链 | 字体族 |
| `weight` / `fontWeight` | number \| string | `400` | 字重，映射到样式名 |
| `italic` | boolean | `false` | 斜体 |
| `color` / `fill` | 颜色值 | `"#111111"` | 文字颜色 |
| `align` | `"LEFT"`\|`"CENTER"`\|`"RIGHT"` | `LEFT` | 水平对齐（**在自身盒宽内**） |
| `valign` | `"TOP"`\|`"CENTER"`\|`"BOTTOM"` | `TOP` | 垂直对齐 |
| `lineHeight` | number \| 对象 | 字体默认 | number = 像素；或 `{unit:"PIXELS"\|"PERCENT", value}` |
| `letterSpacing` | number \| 对象 | — | number = 像素；或 `{unit:"PIXELS"\|"PERCENT", value}` |

尺寸行为（决定 `textAutoResize`）：

| `w` | `h` | textAutoResize | 效果 |
|---|---|---|---|
| 有 | 有 | `NONE` | 固定盒，文本可溢出/裁切 |
| 有 | 无 | `HEIGHT` | 固定宽、高度自适应换行 |
| 无 | 有 | `NONE` | 高度固定，宽度取自然宽 |
| 无 | 无 | `WIDTH_AND_HEIGHT` | 完全自适应单行 |

> 想让文本换行，必须给 `w`（数字或 `"fill"`）。

---

## 4. `RECT` / `ELLIPSE`

| 字段 | 默认 |
|---|---|
| `w` `h` | `100` |
| `fill` | `"#D9D9D9"`（`null` = 无填充，配合 `stroke` 画空心图形） |
| `radius` | `0`（`ELLIPSE` 忽略） |

`RECT` 是本项目的主力图元 —— 折线、蜡烛图、图标、分隔线都由它拼出。

---

## 5. `LINE`

| 字段 | 默认 |
|---|---|
| `w` | 长度，默认 `100` |
| `stroke` / `fill` | `"#E5E5E5"` |
| `strokeWeight` | `1` |

---

## 6. auto-layout 子节点的尺寸语义

当父容器有 `layout` 时，子节点的 `w`/`h` 被解释为**布局意图**而非固定值：

| 值 | 映射 | 含义 |
|---|---|---|
| number | `layoutSizing* = 'FIXED'` + resize | 固定尺寸 |
| `"fill"` | `layoutSizing* = 'FILL'` | 吃满父容器剩余空间 |
| `"hug"` | `layoutSizing* = 'HUG'` | 包裹自身内容 |
| `grow` | `layoutGrow = n` | 按比例分配剩余空间 |
| `stretch` | `layoutAlign = 'STRETCH'` | 交叉轴拉伸 |

`w` 和 `h` 分别对应水平/垂直，**与主轴方向无关**。

### 6.1 覆盖层：`positioning: "ABSOLUTE"`

默认情况下 auto-layout 的子节点全部参与布局流。加 `positioning: "ABSOLUTE"` 让它脱离流，
`x`/`y` 变成相对父容器左上角的**真实坐标**：

```jsonc
// 叠在滚区底部的渐变遮罩：不参与布局，也不会被当成内容滚走
{ "type": "RECT", "name": "ScrollFade", "w": 390, "h": 28,
  "positioning": "ABSOLUTE", "x": 0, "y": 739.5,
  "fill": { "gradient": "linear", "angle": 90, "stops": [[0, "#FFFFFF00"], [1, "#FFFFFFFF"]] } }
```

- 不参与 `fill`/`grow` 的空间分配，也不计入父容器的 HUG 尺寸
- 尺寸由自己的 `w`/`h` 决定
- 在兄弟节点里**画在最上层**（等于 Figma 的最后绘制）
- 适用范围：底部渐变遮罩、角标、浮动按钮

### ⚠️ 没有「百分比宽度」

```jsonc
// ❌ 不支持：会被当成无法识别的字符串，退化为 HUG
{ "type": "FRAME", "w": "60%" }

// ✅ 用两个 grow 兄弟节点按比例分配
{ "type": "FRAME", "layout": "H", "w": "fill", "h": 6, "gap": 0, "radius": 3,
  "clip": true, "fill": "#EDEFF3", "children": [
    { "type": "FRAME", "grow": 60, "h": 6, "fill": "#E8453C" },
    { "type": "FRAME", "grow": 40, "h": 6, "fill": "#00000000" }
  ] }
```

---

## 7. 实用技巧

### 折线 —— 用带旋转的细矩形拼

Plugin API 里没有便捷的折线图元，所以 `specs/build-stock-spec.mjs` 的 `polyline()`
把每段折线转成一个「长 = 段长、高 = 线宽、rotate = 段角度」的 `RECT`。
Figma 的 `rotation` 正值是逆时针，而屏幕坐标 y 向下，所以规格里的 `rotate`
定义为**顺时针**更直觉。

```js
// 段中点定位 + 顺时针角度
out.push(R({ w: len, h: weight, radius: weight/2, fill: color,
             x: midX - len/2, y: midY - weight/2, rotate: angleDeg }));
```

### 蜡烛图 —— 纯 `RECT`，无需旋转

实体（阳线透明填充 + 描边，阴线实心）+ 1px 影线。

### 让中间区域吃满剩余高度

给中间容器 `h: "fill"` + `clip: true`，底部栏就永远贴底，不必手算像素。

```jsonc
{ "type": "FRAME", "layout": "V", "w": 390, "h": 844, "children": [
  { "type": "FRAME", "h": "hug" /* 头部，自然高度 */ },
  { "type": "FRAME", "h": "fill", "clip": true /* 中间滚动区 */ },
  { "type": "FRAME", "h": "hug"  /* 底部固定栏 */ }
] }
```

### 换行网格

```jsonc
{ "type": "FRAME", "layout": "H", "wrap": true, "gap": 12, "w": "fill",
  "children": [ /* 每个子项 w:104，自动每行 3 个 */ ] }
```

---

## 8. 校验与预览

```bash
node specs/validate-spec.mjs    # 静态校验：类型/尺寸字段/圆心角/x-y 缺失等
python3 specs/preview.py        # 本地渲染成 PNG，并输出布局诊断
```

`validate-spec.mjs` 会检查：

- `type` 是否在允许集合内
- `w`/`h` 是否是 number / `"fill"` / `"hug"`
- `TEXT` 是否缺 `text`
- `layout` 值是否合法
- 绝对定位容器是否有多个子节点缺少 `x`（会全部叠在 0,0）
- auto-layout 子节点是否带了会被忽略的 `x`/`y`
- `radius` 是否超过短边一半

`preview.py` 会输出「布局诊断」，包括文本溢出与换行行数 —— 这些是纯静态校验发现不了的。
