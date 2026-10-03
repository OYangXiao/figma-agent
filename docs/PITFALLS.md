# 已踩过的坑

> 这份文档是本项目最有价值的资产。**每一条都是真实发生过、花时间定位过的。**
> 改动相关代码前请先读对应条目，否则会重复踩。

---

## P1 · Figma 拒绝 `allowedDomains` 里的 IP 字面量

**现象**

导入插件时 Figma 弹错，插件根本无法加载：

```
manifest error: invalid value for alloweddomains:
'http://127.0.0.1:8787' must be a valid url
```

**根因**

Figma 的 `networkAccess.allowedDomains` 是**域名匹配模式**列表，不接受 IP 字面量。
[官方文档](https://developers.figma.com/docs/plugins/manifest/)列出的合法本地写法只有：

```
["http://localhost", "https://localhost", "http://localhost:3000", "http://localhost:8081"]
```

且文档明确：**若 `allowedDomains` 含本地/开发服务器，`reasoning` 字段必填。**

**修法**

```diff
  "networkAccess": {
-   "allowedDomains": ["http://localhost:8787", "http://127.0.0.1:8787"],
+   "allowedDomains": ["http://localhost:8787"],
+   "devAllowedDomains": ["http://localhost:8787"],
    "reasoning": "本插件只连接本机开发服务器…"
  }
```

**有用的线索**：错误只点了 IP 那条，说明同列表里的 `http://localhost:8787` **已通过校验** ——
这直接缩小了修改范围，不用盲试。

---

## P2 · dynamic-page 模式下不能直接注册 `documentchange`

**现象**

插件一运行就弹：

```
Plugin error: in on: Cannot register documentchange handler in incremental
mode without calling figma.loadAllPagesAsync first.
```

**根因**

`manifest.json` 里 `documentAccess: "dynamic-page"` 时，Figma **不预加载所有页面**。
注册 `documentchange` 监听会让它必须监控整个文档，所以要求先显式
`await figma.loadAllPagesAsync()`。

我原来在 `code.js` 末尾留了一行毫无用处的占位代码：

```js
figma.on('documentchange', () => {});   // ← 罪魁祸首
```

**修法**

**直接删掉**，而不是补一句 `loadAllPagesAsync` —— 本插件不需要监听文档变化，
所有操作都是显式指令驱动的。

**连带规则**：访问 `figma.root.children` 之前必须 `await figma.loadAllPagesAsync()`。
本项目的所有指令（`getPage` / `cmdExport` / `cmdClear` / `cmdFocus` / `cmdPing`）
都已遵守。

**同类隐患（已修）**：`cmdFocus` 会在目标页上设 `selection`，
但如果该页不是当前页，dynamic-page 下同样会抛错。已改成先 `setCurrentPageAsync(page)` 再选中。

---

## P3 · UI 的 `run()` 没有超时，会让整条链路永久挂死

**现象**（本项目最严重的一次故障）

Agent 下发 `render`，设计稿**在画布上画出来了**，但：

```
18:34:30  → 下发 render (c3)
18:34:30  ← 完成 c2            ← 回来的只有 ping
（之后没有任何 "← 完成 c3"）
pluginSeenAgo: 155053ms       ← 插件 155 秒没再轮询
inflight: 1                   ← c3 永久挂在桥上
```

插件面板不再更新，后续任何指令都收不到。**只能重新运行插件才能恢复。**

**根因**

`ui.html` 的 `run()` 返回的 promise 只由主线程的 `postMessage` 兑现：

```js
function run(cmd, payload) {
  return new Promise((resolve) => {
    const id = …;
    waiters.set(id, resolve);              // ← 只有这一条兑现路径
    parent.postMessage({ pluginMessage: { id, cmd, payload } }, '*');
  });
}
```

主线程只要因**任何**原因没回消息（渲染过慢、抛了 catch 不到的错误、被 Figma 中断、
用户中途关闭面板），这个 promise 永不 settle，于是 `loop()` 永久停在

```js
const out = await run(env.cmd, env.payload);   // ← 卡死在这里
```

既不再取指令，也不上报结果。

**修法**

```js
function run(cmd, payload, timeoutMs = 600000) {
  return new Promise((resolve) => {
    const id = 'ui' + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      waiters.delete(id);
      log(`✖ ${cmd} 主线程 ${timeoutMs/1000}s 未响应，放弃等待`);
      resolve({ ok: false, error: `主线程 ${timeoutMs/1000}s 未响应` });
    }, timeoutMs);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    parent.postMessage({ pluginMessage: { id, cmd, payload } }, '*');
  });
}
```

**教训（可推广）**

> 任何「等待另一个执行上下文回消息」的 promise 都必须有超时或取消路径。
> 没有超时的跨上下文 RPC，等于给整个循环埋了一个单点故障。

---

## P4 · 容器 `opacity` 会继承给子节点 —— 淡色胶囊里的文字变成透明

**现象**

「涨跌幅胶囊」（浅红底 + 红字）在渲染出来是**空的** —— 只能看到浅色底，文字不见了。

**根因**

我为了让胶囊有个 10% 的淡色底，给容器加了 `opacity`：

```js
F({ name:'chip', fill: color, opacity: 0.10,   // ← 10% 透明度
    children: [ T('+1.24%', { color }) ] })    // ← 文字也被继承成 10% 透明
```

**Figma 的 `opacity` 是子树整体透明度，会继承给所有子节点。**

**为什么难发现**：代码在语义上完全合理（"胶囊整体半透明"），
只有渲染出来才知道文字跟着没了。

**修法**：预先算出实色淡底，不要用容器 `opacity`。

```js
/** 把颜色按比例混到背景上，得到实色淡底 */
function tint(hex, alpha, bg = '#FFFFFF') {
  const parse = (h) => { const s = h.replace('#','');
    return [0,2,4].map(i => parseInt(s.slice(i,i+2), 16)); };
  const a = parse(hex), b = parse(bg);
  const mix = a.map((v,i) => Math.round(v*alpha + b[i]*(1-alpha)));
  return '#' + mix.map(v => v.toString(16).padStart(2,'0')).join('').toUpperCase();
}

F({ name:'chip', fill: tint(color, 0.10), children: [ T('+1.24%', { color }) ] })
```

**规则**：`opacity` 只用在**叶子节点**（`RECT`/`ELLIPSE`/图片）上。
任何带 `children` 的容器都不要用 `opacity` 做视觉淡色。

---

## P5 · 插件主线程长时间不让出事件循环会冻住整个 Figma

**现象**

渲染 1413 个节点时，Figma 界面完全无响应，转圈，像卡死。

**根因**

Figma 插件主线程是**单线程**的。`cmdRender` 是连续的 `await` 循环，
每个 `await` 都在同一个微任务队列里推进，**不会让出宏任务**，
于是 Figma 的 UI 线程拿不到执行机会。

**修法**

每 N 个节点主动让出一次宏任务，同时上报进度：

```js
let done = 0;
const tick = async () => {
  done++;
  if (done % 80 === 0) {
    figma.ui.postMessage({ type: 'progress', cmd: 'render', done });
    await new Promise((r) => setTimeout(r, 0));   // ← 让出
  }
};
```

`tick` 一路穿过 `build()` → `createNode()`。

**副产品**：进度经 UI 转发到桥的 `/progress`，写入 `/status.progress`。
这样长任务变成**可观测**的 —— Agent 能看到「已创建 N 个节点」，而不是黑盒等待。

---

## P6 · `localhost` 解析到 IPv6，而桥只监听 IPv4

**现象**

插件导入成功、桥也在跑，但插件面板一直显示「等待本地桥…」，一个请求都连不上。

**根因**

macOS 上 `localhost` 通常**优先解析到 IPv6 的 `::1`**，
而桥写死了 `server.listen(PORT, '127.0.0.1')` —— 只监听 IPv4。两者擦肩而过。

由于 P1，我们又**只能用 `http://localhost:PORT`** 这种域名写法，
没法改成 `127.0.0.1` 绕过去。

**修法**

不指定 host，让 Node 绑定到 `::`（dual-stack，同时接受 IPv4/IPv6）：

```js
if (HOST) server.listen(PORT, HOST, onListen);
else server.listen(PORT, onListen);      // HOST 默认 null
```

实测三种写法均可达：

```
=== localhost ===  {"pluginOnline":false,…,"port":8787}  ✓
=== 127.0.0.1 ===  {"pluginOnline":false,…,"port":8787}  ✓
=== [::1]     ===  {"pluginOnline":false,…,"port":8787}  ✓
```

监听显示为 `TCP *:8787 (LISTEN)`。

---

## P7 · 预览器：`fill` 子节点被按「整个父容器宽度」测量

**现象**

盘口（五档）两列错位：价格文字被截断成 `1,68`，成交量整列消失，
右列内容紧贴着左列被截断的位置。

**根因**（在 `specs/preview.py` 里）

盘口结构是「一行内两个 `w:'fill'` 的列 + 中间一条分隔线」。
横向容器的内容宽 358，两个 `fill` 子列各应得 ~178.75。

但测量阶段我把**整个容器宽度 358** 传给了 `fill` 子节点：

```python
for k in kids:
    measure(k, cw, ch, …)     # cw = 358，于是每列内部都按 358 排版
```

之后 `allocate()` 才把它们的 `_w` 改成 178.75 —— 但**子树早已按 358 排完了版**，
不会自己重排。于是文字跑到列外被裁掉。

**修法（两处）**

1. 测量阶段按均分份额给 `fill`/`grow` 子节点可用宽度：

```python
if axis == "H":
    fixed = sum((k["w"] if num(k.get("w")) else 0) for k in kids
                if k.get("w") != "fill" and not k.get("grow"))
    nfill = sum(1 for k in kids if k.get("w") == "fill" or k.get("grow"))
    share = max(1.0, (cw - fixed - gap * max(0, len(kids)-1)) / nfill) if nfill else cw
```

2. 增加**第二趟**：尺寸被父容器改写的子节点，用最终尺寸重排子树。

---

## P8 · 预览器：第二趟重排把 `grow` 分配的宽度重置为 0

**现象**

加了第二趟重排后，资金流向的「占比条」填充色**整个消失**，
只剩浅灰轨道。而此前它只是"太窄"。

**根因**

占比条用两个 `grow` 兄弟节点按比例分配宽度：

```js
row({ w:'fill', h:6, children: [
  F({ grow: p,     h: 6, fill: color }),
  F({ grow: 100-p, h: 6, fill: TR }),
] })
```

这两个子节点**没有 `w` 也没有 `children`**，所以它们的固有宽度是 `0`。
第二趟重排无条件地重测所有尺寸变化过的子节点：

```python
measure(k, k['_w'], k['_h'])   # 父容器刚把 _w 设成 280
                               # 重测时 wspec 为空 → _w = max(children) = 0  ✗
```

宽度被打回 0。

**修法**

第二趟**只对 auto-layout 容器做** —— 只有它们的子树布局依赖父容器最终尺寸，
叶子/绝对定位容器的尺寸可能合法地来自父容器的 `grow`/`fill` 分配：

```python
for k, pw, ph in before:
    if layout_axis(k) is None:      # ← 关键
        continue
    if abs(k["_w"] - pw) > 0.01 or abs(k["_h"] - ph) > 0.01:
        measure(k, max(1.0, k["_w"]), max(1.0, k["_h"]), …)
```

---

## P9 · 预览器：重排发生在定位之后，把子节点全推回左上角

**现象**

加了第二趟重排后（P8 之前），整个屏幕错乱：
头部消失，盘口跑到最上面，图表跑到中间，底部大片留白 —— 所有内容像被重新排过。

**根因**

`measure()` 开头会重置坐标：

```python
n["_x"] = n.get("x", 0) or 0
n["_y"] = n.get("y", 0) or 0
```

而我把第二趟重排放到了**定位循环之后**：

```python
# 先定位（父容器刚给子节点赋好 _x/_y）
k["_x"], k["_y"] = cur, …
# 再重排 → 立刻把 _x/_y 重置回规格里的 0
measure(k, …)
```

于是所有被重排的子节点全部回到 `(0,0)`，互相覆盖。

**修法**

**重排必须在定位之前**：先定尺寸 → 重排子树 → 再统一位置。
（重排不会改变子节点自身被父容器赋予的尺寸，所以提前是安全的。）

---

## P10 · 预览器：`RECT`/`ELLIPSE` 的 `opacity` 没落到 alpha 通道

**现象**

第一版预览里，指数卡的迷你走势面积、分时图的面积填充、量能柱、
涨跌幅胶囊**全部是实心色块**，整屏看起来像廉价海报。

**根因**

`draw_node()` 只对 `FRAME` 应用了 `opacity`；`draw_shape()` 完全没处理。

```python
def draw_shape(n):
    …
    return base      # ← opacity 丢了
```

这是**预览器的 bug，不是设计的 bug** —— 插件侧由 Figma 正确处理。
但它的危害很大：**它会掩盖真实的视觉问题**，也会让你误判设计已经对了。
（P4 那个真实 bug 就是修好这个之后才暴露出来的。）

**修法**

```python
op = n.get("opacity")
if num(op) and op < 1:
    base.putalpha(base.getchannel("A").point(lambda v: int(v * op)))
```

---

## P11 · 图表坐标轴标签被折线压住

**现象**

分时图右上角的 `1683.35 / +1.23%` 与价格线重叠，几乎读不出来。

**根因**

绘图区宽度直接用了整个卡片宽度，而右侧还叠着价格轴标签：

```js
const pw = CHART_W - 16;                       // 绘图区延伸到 350
T(hi, { x: CHART_W - 46, w: 46, align: 'RIGHT' })  // 标签占 312..358 → 重叠
```

**修法**

为标签预留横向空间，绘图区收窄到标签左侧：

```js
const pw = CHART_W - 56;          // 分时图；留 56px 给标签
const pw = CHART_W - 58;          // 日K
```

同时把网格线宽度也改成 `px0 + pw`，保持一致。

---

## P12 · 占比条按原始百分比绘制导致几乎看不见

**现象**

资金流向的「超大单 −1.12亿」等四行，进度条几乎是一条空轨道，看不出比例。

**根因**

数据是「占成交额的百分比」，量级只有 **6.8% ~ 11.8%**。
直接按百分比画，填充只占轨道的十分之一：

```js
const p = Math.min(100, Math.abs(pct));   // 9.1 → 9.1% 宽度
```

**修法**

按**本组最大值**归一化，并给可见下限，让相对关系清晰又不失真
（数值本身仍然标在旁边）：

```js
const p = Math.max(5, Math.min(100, (Math.abs(pct) / scale) * 100));
```

调用处传入 `maxPct = Math.max(...recs.map(r => Math.abs(r[2])))`。
修后：超大单 96%、大单 100%、中单 58%、小单 83%。

---

## P13 · `fontName` 必须在 `characters` 之前设置

**现象**（预防性规则，非实际故障）

**根因**

Figma 的文本节点在设置 `characters` 时会用当前字体的字形去解析，
若字体尚未加载会抛错。

**正确顺序**

```js
const t = figma.createText();
const font = await resolveFont(spec.font, spec.weight, spec.italic);
t.fontName = font;              // ← 先
t.characters = String(spec.text); // ← 后
t.fontSize = …;
```

**另外**：`fontName` 赋值前必须 `await figma.loadFontAsync(font)`（已在 `resolveFont` 内处理）。

---

## P14 · 渲染文本时 `textAutoResize` 语义容易设错

**现象**（预防性规则）

**根因**

`resize()` 与 `textAutoResize` 互相制约：
在 `textAutoResize:'HEIGHT'` 下**高度不可设**；在 `'WIDTH_AND_HEIGHT'` 下宽高都不可设。

**正确映射**

| `w` | `h` | 设置 |
|---|---|---|
| 有 | 有 | `textAutoResize='NONE'` → `resize(w, h)` |
| 有 | 无 | `textAutoResize='HEIGHT'` → `resize(w, currentHeight)` |
| 无 | 有 | `textAutoResize='NONE'` → `resize(currentWidth, h)` |
| 无 | 无 | `textAutoResize='WIDTH_AND_HEIGHT'` |

---

## P15 · `render` 默认清空页面 —— 在迭代场景下是危险的设计

**现象**（设计缺陷，尚未造成事故就被改掉）

原实现：

```js
if (p.clear !== false) {            // ← 默认就是 true
  for (const child of [...page.children]) child.remove();
}
```

即「渲染 = 先清空整页再画」。这在**从零生成**的模式下是合理的。

**为什么危险**

当工作模式转为「**在用户的现有设计稿上迭代**」后，这个默认值变成了地雷：

- 用户的图层命名、分组、组件实例关系**全部被抹掉**
- 没有任何撤销提示（虽然可以 `⌘Z`）
- 一次误调用 = 用户几个小时的整理工作白费

**修法**

默认改为**不清空**，清空必须显式请求：

```js
if (p.clear === true) { ... }        // 插件侧
clear: body.clear === true           // 桥侧
--clear                              // CLI 侧（原先是 --keep 反向开关）
```

同时给 `clear` 指令加了 `--yes` 门槛，`rm` 加了数量上限。

**教训（可推广）**

> **默认值要服务于当前的主要工作模式。**
> 同一个默认值在「新建」场景下方便，在「修改」场景下就是破坏性的。
> 工作模式变化时，要回头审查所有破坏性操作的默认值。

---

## P16 · 用图层名去找文案，永远找不到

**现象**

写测试时想「找到那个写着『插入的测试文本』的节点并删掉」：

```js
await send(figma, 'remove', { name: '插入的测试文本' });   // ✗ 未匹配到要删除的节点
```

**根因**

`name` 匹配的是 **Figma 图层名**，不是文案内容。
而我插入那个文本时没给 `name`，所以它的图层名是默认的 `Text`。

这在真实设计稿里是**常态**——设计师不会把每个文本图层改名成它的内容。

**修法**

在 `resolveTargets()` 里加了独立的 `text` 选择器（匹配 `node.characters`），
两类选择器语义分离、互不干扰：

```js
if (op.name != null && !matchName(n.name, op.name)) continue;          // 图层名
if (op.text != null) {                                                  // 文案内容
  if (n.type !== 'TEXT' || !matchName(n.characters || '', op.text)) continue;
}
```

CLI 上 `--name` 与 `--text` 并存。

**教训**

> 当一件事有**两个不同但都叫「名字」的概念**时，不要用一个参数含糊地表达。
> 而且**测试数据要贴近真实场景**——我最初的测试用了个"图层名恰好等于内容"的假数据，
> 差一点就把这个缺口掩盖过去。

---

## P17 · 插件的长轮询中断后没清理挂起项，指令被「投递到虚空」

**现象**

桥日志显示某条指令「已下发」，但插件**从未收到**，也不回报结果：

```
→ 下发 patch (c3)          ← 显示已下发
（之后没有任何 "← 完成 c3"）
```

而实际上下发那一刻**根本没有任何插件在轮询**。

**根因**

长轮询的挂起项 `state.waiter` 只在**超时**或**被新轮询替换**时清理。
如果客户端（插件 UI）主动断开连接 —— curl 的 `-m 2` 超时、用户关闭 Figma 面板、
网络抖动 —— `state.waiter` 仍然指向那个已经死掉的 `res`。

之后 `deliver()` 看到 `state.waiter` 非空，就把指令「投递」给了那个死连接：

```js
function deliver(envelope) {
  if (state.waiter) {          // ← 这个 waiter 早已断开
    send(state.waiter.res, 200, envelope);   // 写进虚空
    return;
  }
  state.queue.push(envelope);  // ← 本该走这里
}
```

**为什么难查**：所有日志看起来都正常（"已下发"），指令也确实发出去过，
只是没人收到。表现为「命令发出去了却永远没执行」。

**修法**

监听请求的 `close` 事件，断开时清掉挂起项：

```js
state.waiter = { res, timer };
req.on('close', () => {
  if (state.waiter && state.waiter.res === res) {
    clearTimeout(state.waiter.timer);
    state.waiter = null;
    log('插件轮询连接中断，已取消挂起');
  }
});
```

**验证**：断开长轮询后下发指令，现在会正确入队（`queue=1`），
插件连上后能取到并执行。

**教训**

> 长连接/长轮询的**所有**终止路径都要处理：正常响应、超时、**以及对端主动断开**。
> 只处理前两种，就会留下「看起来还活着、实际已经死了」的状态。

---

## P18 · 过期指令在插件重连时被执行 —— 「幽灵操作」

**现象**（设计缺陷，在自检时发现）

桥的 `/status` 显示 `queue: 1 / inflight: 1` —— 队列里积压着**几分钟前**的指令。

如果那条指令是 `remove` 或 `patch`，它会在插件下次连接时**被执行**，
而它针对的目标可能早已不是当初的样子。这就是「幽灵操作」。

**根因**

`deliver()` 在插件离线时把指令压入 `state.queue`，**队列没有过期机制**。
指令会一直躺着，直到某个插件连上来把它取走。

会话结束、插件关闭、用户去泡了杯咖啡 —— 只要指令还在队列里，它就还"活着"。

**修法（两层防护）**

1. **队列 TTL**：取指令时丢弃超过 60 秒的条目

   ```js
   const QUEUE_TTL_MS = Number(process.env.DSH_QUEUE_TTL_MS || 60_000);
   function purgeStaleQueue() { /* 过滤过期条目并记日志 */ }
   ```

2. **重连即清空**：插件启动上报 `/hello` 时，清空队列并让所有在途指令立刻失败

   ```js
   const droppedQueue = state.queue.length;
   state.queue = [];
   for (const [, entry] of state.inflight) {
     clearTimeout(entry.timer);
     entry.resolve({ ok: false, error: '插件重连，指令已丢弃（避免过期操作被延迟执行）' });
   }
   state.inflight.clear();
   ```

   插件重连 = 上一轮会话结束，旧的未执行指令**不应该**跨越会话边界生效。

**验证**：入队 2 条后等过 TTL，日志出现 `⚠ 丢弃 2 条过期队列指令`；
重连时出现 `⚠ 插件重连：丢弃 3 条在途指令`。

**教训**

> **写操作的队列必须有生命周期。**
> 一条「删除」指令在队列里多躺一分钟，语义就可能完全不同。
> 宁可**明确失败**让 Agent 重试，也不要**延迟执行**一个可能已经错误的目标。

---

## P19 · 硬编码页名 —— 读操作凭空新建页面，render 画到别处

**现象**

用户在 Figma 里的页面叫 `DSH Prototype`，代码里写的是 `FIMG Prototype`。于是：

```bash
$ ./fimg stats
当前页: DSH Prototype
页面列表: Page 1, DSH Prototype
未找到页面「FIMG Prototype」        ← 明明画布上有一整套设计
```

更糟的是 `render`：`getPage()` 找不到就 `figma.createPage()`，
于是**凭空多出一个空页**，设计被渲染到那里。用户以为画在了自己的稿子上。

**根因**

同一个页名被硬编码在**四个地方**，任何一处改名都会全盘错位：

| 文件 | 原值 |
|---|---|
| `plugin/code.js` | `PAGE_NAME_DEFAULT = 'FIMG Prototype'` |
| `tools/figma.mjs` | `const PAGE_NAME = 'FIMG Prototype'` |
| `bridge/server.mjs` | `body.pageName \|\| 'FIMG Prototype'`（两处） |
| `plugin/ui.html` | `pageName: 'FIMG Prototype'`（两处） |

而且 `specs/stock-app.json` 里还带一个 `page` 字段，`cmdRender` 用
`p.pageName || spec.page || PAGE_NAME_DEFAULT` 解析 —— 就算 CLI 不传，规格也会兜底钉死页名。

**修法：默认跟随「当前页」，且读操作永不建页**

```js
const PAGE_NAME_DEFAULT = null;      // null = 当前页

async function resolvePage(name, { create = false } = {}) {
  await figma.loadAllPagesAsync();
  if (!name) return figma.currentPage;                 // 不指定 → 当前页
  const found = figma.root.children.find((p) => p.name === name);
  if (found) return found;
  if (!create) return null;                            // 读操作到此为止，绝不新建
  const page = figma.createPage(); page.name = name; return page;
}
```

- `stats` / `list` / `dump` / `clear` 一律 `create: false`
- `render` 只在**显式给了页名**时才允许新建
- 显式指定页面的唯一入口是 `--page 名称` 或 `DSH_FIGMA_PAGE=名称`
- 规格生成器不再输出 `page` 字段（页面由调用方决定）

**顺带修掉的一个连带风险**

`ui.html` 的「本地渲染」按钮原本是 `{ clear: true, pageName: 'FIMG Prototype' }` ——
目标页是临时页，清空无所谓。改成「当前页」语义后，这个按钮会**清空用户正在看的稿子**。
所以它现在不传 `clear`（追加），「清空页面」按钮加了 `confirm()` 二次确认。

**教训**

> **任何「目标」都不该硬编码，尤其是用户拥有的东西。**
> 页名、端口、文件路径这类东西，硬编码的代价不是"报个错"，而是**静默地操作了错误的对象**。
> 宁可让调用方显式指定，也不要替用户猜一个默认值。

---

## P20 · patch 的 op 漏写选择器，静默命中整个页面

**现象**（设计缺陷，未造成实际损失）

```json
{ "ops": [ { "set": { "fill": "#FF0000" } } ] }
```

这个 op 忘了写 `id`（或字段名打错成 `nodeId`）。`resolveTargets({})` 返回
**当前页所有后代节点**，于是整页被刷成红色。审计输出还显示
`selector: (全部) → 匹配 1432 个`，看起来像"成功"。

**根因**

选择器是可选参数，而"没有条件"在 `resolveTargets` 里被解释成"匹配全部"。
对**读**操作（dump 整页）这是合理语义，对**写**操作（patch/remove）则是灾难：

| 操作 | 无选择器 | 后果 |
|---|---|---|
| `dump` | 读整页 | ✅ 合理，就是要看全貌 |
| `list` | 列整页 | ✅ 合理 |
| `patch` | 改整页 | ❌ 几乎总是笔误 |
| `remove` | 删整页 | ❌ 更糟（幸好有 200 个上限兜底） |

**修法：写操作必须显式 opt-in**

```js
function hasSelector(op) {
  return !!(op.id || (Array.isArray(op.ids) && op.ids.length) || op.selection
    || op.name != null || op.text != null || op.type != null
    || op.layout != null || op.fontSize != null);
}

if (!hasSelector(op) && op.all !== true) {
  results.push({ selector: '(无选择器)', matched: 0,
    error: '该 op 没有选择器，会匹配整个页面。确认要全量修改请显式写 "all": true' });
  continue;
}
```

真要全量改（比如统一字体）就写 `"all": true` —— 让"我要动整页"成为一个
**必须主动打出来的字**，而不是省略一个字段的副作用。

**与 `remove` 的关系**：`rm` 保留了原有的 200 个上限作为第二道防线
（`all: true` 也不豁免），因为它是最不可逆的操作。

**教训**

> **危险的默认值应该反过来：省略 = 拒绝，而不是省略 = 全部。**
> 尤其是当"全部"在一次误操作里就能毁掉用户几小时的稿子时。

---

## P21 · `dump` 的字段名和 `patch` 的字段名对不上 —— 「回写」是假的

**现象**

文档里写着「dump 输出的字段与 SPEC_DSL 对齐，便于直接回写」，`ITERATING.md` 也说
「dump 出来的每个节点都带 id，可直接构造 patch」。但实际回写会**静默无效**：

| dump 输出 | `applySet` 只认 | 结果 |
|---|---|---|
| `size`（字号） | `fontSize` | 不生效，无报错 |
| `clip` | `clipsContent` | 不生效，无报错 |
| `autoResize` | `textAutoResize` | 不生效，无报错 |
| `sizing: { h, v }` | `layoutSizingHorizontal` / `layoutSizingVertical` | 不生效，无报错 |

**根因**

读写两套代码是分别写的：`dumpNode()` 为了贴近 SPEC_DSL 用了短名，
`applySet()` 为了贴近 Figma API 用了规范名。两边各自都"对"，
但**没有任何测试跨过这条缝**——往返测试只覆盖了颜色。

**修法：在 `applySet` 入口做别名归一（规范名优先）**

```js
if (set.size !== undefined && set.fontSize === undefined) set = { ...set, fontSize: set.size };
if (set.clip !== undefined && set.clipsContent === undefined) set = { ...set, clipsContent: set.clip };
if (set.autoResize !== undefined && set.textAutoResize === undefined) set = { ...set, textAutoResize: set.autoResize };
if (set.sizing) {
  if (set.layoutSizingHorizontal === undefined) set = { ...set, layoutSizingHorizontal: set.sizing.h };
  if (set.layoutSizingVertical === undefined) set = { ...set, layoutSizingVertical: set.sizing.v };
}
```

显式写规范名时不覆盖（测试 `规范名优先于别名` 守住这条）。

**后续（v1.3.0 已补齐）**

同一类不对称还有一批字段，当时只有「读」没有「写」。现在全部补齐了：
`layout`（切换 `V`/`H`/`NONE`）、`wrap`、`blendMode`、`effects`（阴影/模糊）、
`strokeAlign`、`positioning`（绝对定位）。每个都配了往返测试。

> 加新可读字段时**顺手问一句：它能写回去吗？** 不能的话要么补上，
> 要么在 `dumpNode()` 里别输出它——半截对称比不对称更危险。

**教训**

> **"能读回来"和"能写回去"是两件事，必须各测一遍。**
> 对称性缺陷不会抛错，只会静默地什么都不做 —— 而 Agent 会以为改成功了。

---

## P22 · 插件掉线后，在途指令要干等到超时才失败

**现象**

Figma 里的插件面板被关掉（或 Figma 被挂起）后，插件就不再轮询了。
但桥毫无察觉，于是：

```
$ ./fimg dump --name "01 行情"
✖ 插件无响应：请求超时（30s）     ← 其实连接 2 秒前就断了
```

`curl localhost:8787/status` 里还挂着 `"inflight": 2`，看起来像"卡住了"，
实际上**早就没有任何东西会来回应它了**。调用方白等 30s，桥白等 120–300s。

**根因**

`dispatch()` 只有两个出口：收到 `POST /result`，或**自己的超时到期**。

```js
const timer = setTimeout(() => { /* ... */ resolve({ ok:false, error:'timeout' }); }, timeoutMs);
```

插件掉线不在其中。桥知道 `pluginOnline === false`（心跳 TTL 40s），
但这个信息只用于 `/status` 的显示，**没有参与任何决策**。

**修法：离线看门狗**

```js
const OFFLINE_FAIL_MS = Number(process.env.DSH_OFFLINE_FAIL_MS || 45_000);

function failInflightWhenOffline() {
  if (!state.inflight.size) return;
  if (pluginOnline()) return;                       // 在线就不管
  const now = Date.now();
  for (const [id, entry] of state.inflight) {
    if (now - entry.ts < OFFLINE_FAIL_MS) continue; // 给刚下发的指令一点机会
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, offline: true,
      error: `插件已离线（等待 ${...}s 无响应）。请在 Figma 里重新运行插件。` });
  }
  // 被放弃的指令在队列里的残留也一起清掉
  state.queue = state.queue.filter((e) => state.inflight.has(e.id));
}
setInterval(failInflightWhenOffline, 2_000).unref();
```

判据是**两个条件同时成立**：插件当前不在线 **且** 这条指令已经等了足够久。

为什么必须保守：长渲染期间插件也不轮询，但它每 80 个节点发一次 `/progress`，
心跳是新鲜的 —— 所以 `pluginOnline()` 为 true，看门狗不会误伤。

**验证**（不需要 Figma）

```bash
DSH_OFFLINE_FAIL_MS=3000 node bridge/server.mjs &
curl -s -X POST localhost:8787/cmd -H 'Content-Type: application/json' \
  -d '{"cmd":"ping","timeoutMs":60000}'
# 实测 3.05s 返回：
# {"ok":false,"offline":true,"error":"插件已离线（等待 3s 无响应）。…"}
# 且 /status 的 queue 与 inflight 都已归零
```

**教训**

> **"知道某件事"和"据此做决策"是两回事。**
> 桥一直知道插件离线，却只把它显示在 `/status` 里。
> 系统里每一个"已知状态"都应该问一句：**有没有哪个等待，本该被它打断？**

---

## P23 · 预览器不支持绝对定位 —— 本地"验证通过"其实是假的

**现象**（差点就这么发布出去）

给详情页滚区加底部渐变遮罩时，按 `y = 844 − 76.5 − 28 = 739.5` 把遮罩做成
`positioning:"ABSOLUTE"` 的子节点写进规格，跑本地预览：

**预览看起来完全正确** —— 遮罩正好落在操作栏上方，跟后来真机导出的图几乎一样。

但这是**巧合**。`specs/preview.py` 当时根本不认识 `positioning` 字段
（`grep positioning specs/preview.py` → 无结果），它把所有子节点都塞进布局流。
遮罩之所以"看起来对"，是因为它排在最后、又有固定高度 28，于是
`h:'fill'` 的滚区**恰好少分了 28px**，遮罩**恰好**落在了同一个位置。

把布局数字打出来就露馅了：

```
屏幕                     Scroll h（预览 / 真机）    Fade y（预览 / 真机）
04 个股详情·资金流向        459 / 487   ✗           816   / 739.5  ✗   ← 修好之前
                          487 / 487   ✓           739.5 / 739.5  ✓   ← 修好之后
```

预览里滚区被压矮了 28px（内容多滚了一屏的量），而真机没有。
**位置对，尺寸错** —— 这种偏差最容易骗过眼睛。

**根因**

`preview.py` 和 `plugin/code.js` 是**两套独立的布局实现**，靠人工保持一致。
`plugin/code.js` 的 `applyLayoutChild()` 支持 `positioning:ABSOLUTE`，
`preview.py` 的 `measure()/allocate()` 却完全不知道有这回事。

**修法**

在 `preview.py` 里补上同样的语义，而且**每一处都要对齐**：

```python
def is_absolute(n):
    return str(n.get("positioning") or "").upper() == "ABSOLUTE" or n.get("absolute") is True

# measure(): 绝对定位子节点不贡献 HUG 尺寸；用自身 w/h 测量，不按容器可用空间
# allocate():
#   1) 拆成 flow / absol 两组
#   2) flow 参与交叉轴 fill、主轴弹性分配、gap 计数、对齐
#   3) absol 最后按 x/y 直接落位（不受 padding / 对齐 / gap 影响）
#   4) 绘制顺序 flow + absol —— 绝对定位排最后 = 画在最上层（与 Figma z 序一致）
```

顺手也补了**渐变渲染**（`gradient_image()`）：预览器原本对渐变填充只会返回
`color()→None`，遮罩会整个消失。用「1px 长条 + 放大」实现，避免逐像素计算。

**一个字段要动三个地方**：

| 文件 | 需要同步的东西 |
|---|---|
| `plugin/code.js` | `applyLayoutChild()` 实现 |
| `specs/preview.py` | `is_absolute()` + `measure`/`allocate` 三处 |
| `specs/validate-spec.mjs` | 不能再对 `positioning:ABSOLUTE` 的子节点报「x/y 会被忽略」 |

**教训**

> **预览器和渲染器是同一个规格的两个实现，任何布局语义都必须成对添加。**
> 漏了一边不会报错，只会让本地预览**悄悄失去可信度** ——
> 而"本地先验证"正是这个项目省下 Figma 往返的全部理由。
>
> 更具体的教训：**"看起来对"不等于"算得对"。**
> 位置碰巧一致，尺寸却差了 28px。以后加布局特性，除了看图，
> 还要把关键节点的 `_w/_h/_x/_y` 打出来和真机 `dump` 对一遍。

---

## P24 · `ungroup` 之后还去读被销毁的节点 —— 桩测试抓不到

**现象**

真机上第一次跑 `ungroup`：

```
$ ./fimg ungroup --id 2:1428
✖ in get_name: The node with id "2:1428" does not exist
```

但**解组其实成功了** —— 组已经消失、两个子节点已经回到父容器。
只是我在报告结果时去读了 `n.name`，而那个节点已经被销毁了。

```js
const kids = figma.ungroup(n) || [];
done.push({
  id: n.id, name: n.name, type: n.type,   // ← n 已经不存在了
```

**根因：桩比真机"宽容"**

桩里的 `ungroup` 只是把 `parent` 置空、`children` 清掉，**对象还在**，
所以 `n.name` 照样读得到，测试全绿。真机则把节点直接从文档里删掉。

这就是「**桩测试全绿 ≠ 真机能用**」的第 N 次复现。区别在于：
前几次是桩**不知道**某些信息（用户的页面叫什么、哪些字段名），
这次是桩**比真机更宽容**（该销毁的没销毁）。

**修法（两边都要改）**

1. 插件里**先快照再操作**：

   ```js
   const snap = { id: n.id, name: n.name, type: n.type };
   const kids = figma.ungroup(n) || [];
   done.push({ ...snap, released: kids.length, ... });
   ```

2. **让桩也销毁节点**，把这类 bug 在秒级测试里就拦住：

   ```js
   for (const key of ['name', 'type']) {
     Object.defineProperty(node, key, {
       get() { throw new Error(`The node with id "${node.id}" does not exist`); },
       configurable: true,
     });
   }
   ```

   验证有效：把修复退回后，桩测试立刻变红
   （`✖ group / ungroup 往返：子节点不丢`），不再是"桩绿真机红"。

**教训**

> **桩的宽容度必须对齐真机，尤其是"销毁"这种不可逆语义。**
> 一个 `remove()` / `ungroup()` 之后仍然可读的对象，会掩盖一整类
> use-after-destroy 缺陷 —— 而这类缺陷在真机上表现为"操作成功了但报错"，
> 最容易被误判成"操作失败"而重试，造成重复操作。

---

## P25 · 选择器的两个陷阱：`type` 名字对不上、同名图层命中一大片

**现象 A：`--type RECT` 一个都匹配不到**

SPEC_DSL 里写 `{"type": "RECT"}`，于是很自然地 `./fimg dump --type RECT`。
结果 `rootCount: 0`，**不报错**，只是"没匹配到"。

因为 Figma 的节点类型是 `RECTANGLE`，而 DSL 里叫 `RECT`。
`resolveTargets` 当时直接拿字符串比：

```js
if (wantType && n.type !== wantType) continue;   // 'RECTANGLE' !== 'RECT'
```

**修法**：加一层类型归一，两边都认。

```js
const TYPE_ALIASES = { RECT: 'RECTANGLE', /* …其余同名直通… */ };
const normType = (t) => TYPE_ALIASES[String(t).toUpperCase()] || String(t).toUpperCase();
```

**现象 B：一个 `{"name":"Row"}` 命中整个页面**

真实设计稿里 `Frame` / `Text` / `Row` 这类名字会出现几十次。
用户画布上就有大量 `Frame`。`name` 选择器是**页面级**的，
一个通配符下去很容易误伤一片 —— 而 `patch` 是写操作。

**修法**：加 `within` 范围修饰。

```js
if (op.within) {
  const root = await getNode(String(op.within));
  if (!root) return [];
  for (const n of allDescendants(root)) { if (match(n)) out.push(n); }
  return out;
}
```

CLI 的 `--within` 会注入到每个没自己写 `within` 的 op，所以整批操作只写一次范围。
`dump` 单独给 `within`（不带别的条件）时，语义是「把这个容器的子树读出来」，保留层级。

**教训**

> **两层名字系统之间一定要有归一。** DSL 名和 API 名不一致时，
> "匹配不到"是不会报错的——它看起来就像"这个页面上没有这种东西"。
>
> **写操作的选择器需要"范围"这个维度。** 只按条件筛选，
> 在真实（而不是玩具）设计稿上迟早会误伤。

---

## P26 · dynamic-page 下 `mainComponent` 是异步的 —— 审计里写出了 `null → 新组件`

**现象**

真机跑 `swap`（换实例的主组件）时报了这一行：

```
· 卡片组件  null → 另一个组件
```

换组件本身是成功的，但**换之前是哪个组件**没读出来。用户看到 `null` 会以为
"这个实例原来没有主组件"，而实际上有。

**根因**

`documentAccess: "dynamic-page"` 下，`instance.mainComponent` 这个**同步** getter
会抛错（和 `figma.getNodeByIdAsync` 的情况同源，见 P2 / 规则表）。

而我在审计里用了 `safeCall`：

```js
const before = safeCall(() => (n.mainComponent && n.mainComponent.name) || null);
```

`safeCall` 把异常吞成 `null` —— **看起来"没有值"，实际是"读失败"**。
这比直接抛错更糟：抛错至少会有人去查，`null` 会让人得出错误结论。

**修法**

用异步版，并保留同步版作为旧 API 的回退：

```js
const beforeComp = await safeCallAsync(() => (
  typeof n.getMainComponentAsync === 'function' ? n.getMainComponentAsync() : null));
const before = (beforeComp && beforeComp.name)
  || safeCall(() => (n.mainComponent && n.mainComponent.name) || null);
```

`dump` 里也做了同样的事：因为 `dumpNode()` 是同步的，所以在 `cmdDump`
里**先扫一遍收集 INSTANCE 节点、统一 `await` 解析**，结果放进 `opt.mainComponents`，
`dumpNode` 再查表。

**教训**

> **`safeCall` 会把"读失败"和"确实是空"混为一谈。**
> 凡是 dynamic-page 下可能抛错的属性，要么用异步版正经读，
> 要么至少把失败和空值区分开报出来。
>
> 还要记住：**审计信息本身也是输出**。一个 `null` 足以让人对"操作到底做了什么"
> 得出完全相反的结论 —— 而这次操作其实是成功的。

---

## P27 · `--dry` 广告了却照写不误 —— 安全网本身就是漏洞

**现象**（写审查文档时顺手核对发现，未造成实际损失）

`move` / `dup` / `component` / `swap` / `detach` / `ungroup` 六个命令都提供 `--dry`，
帮助文本里也写着。但实际上：

```js
if (!p.dryRun && typeof figma.commitUndo === 'function') figma.commitUndo();
```

**这是命令里唯一一处 `dryRun` 判断** —— 它只跳过"合并撤销栈"，
而真正的变异（`insertChild` / `clone` / `createComponentFromNode` /
`swapComponent` / `detachInstance` / `figma.ungroup`）**完全没被拦住**。

也就是说 `./fimg ungroup --id 2:1428 --dry` 会**真的把组拆掉**，
而且连 `commitUndo` 都没打，撤销栈里是一堆散点。

**为什么这是最严重的一类**

这个项目的硬性规则里写着：

> **不要在用户原稿上直接试新指令** —— 先让他复制一份页面，或至少先 `--dry`。

`--dry` 是**最后一道人肉防线**。一道"看起来在、实际不在"的防线，
比没有防线更危险：人会因此放心地去试，然后改坏稿子。

**根因**

结构性命令是分两批加的。第一批 `cmdRemove` 老老实实包了 `if (!p.dryRun)`：
```js
if (!p.dryRun) { for (const n of targets) { try { n.remove(); } catch (e) {} } }
```
后面加 `move`/`dup`/`group`/… 时，我把 `dryRun` 从 `remove` **复制**了过来 ——
但只复制了结尾那一行 `commitUndo`，忘了包住中间的变异。复制粘贴的半截修改。

**修法：dry-run 必须是"只计算不写入"**

每个命令改成先把结果算出来、`dryRun` 时直接返回：

```js
// cmdUngroup
if (p.dryRun) {
  done.push({ ...snap, released: n.children.length,
    children: n.children.map((k) => ({ id: k.id, name: k.name, type: k.type })),
    note: 'dry-run：未解组' });
  continue;
}
const kids = figma.ungroup(n) || [];
```

`cmdGroup` 更彻底 —— 它在 `figma.group()` 之前就整段返回：

```js
if (p.dryRun) {
  return { dryRun: true, group: { name: p.rename ?? 'Group', index },
    parent: { id: parent.id, name: parent.name },
    count: targets.length, members: [...], note: 'dry-run：未成组' };
}
```

顺手补上了 `move` / `dup` / `group` / `instance` 缺失的 `--dry`（原本只有四个有）。

**加固：8 个回归测试**

每个命令一个用例，断言**文档真的没变**（不是看返回值，是看节点）：

```js
await test('dup --dry 不创建副本', async () => {
  const { box } = await makeSandbox();
  const before = box.children.length;
  const r = await send(figma, 'dup', { name: 'A', within: box.id, count: 3, dryRun: true });
  assert.equal(r.data.count, 3, '应报出会复制几个');
  assert.equal(box.children.length, before, 'dry-run 绝不能新增节点');
});
```

验证有效：把 `cmdDup` 的 dry-run 分支删掉，测试立刻变红（`6 !== 3` —— 真的多出 3 个副本）。

**教训**

> **安全开关必须有自己的测试，而且测试要断言"世界没变"，不是"函数返回了什么"。**
>
> 一个断言 `r.data.count === 3` 的测试在 bug 版本下**也会通过** ——
> 因为返回值是对的，只是稿子被改了。必须去看节点本身。
>
> 另外：**复制粘贴代码时，边界条件最容易只复制一半。**
> 这次复制的是"结尾的收尾动作"，漏掉的是"包住主体的守卫"。

---

## 附：一条方法论

这 27 条里，**P7–P18 全部是在建立了「本地验证手段」之后才发现的** ——
其中 P7–P14 靠的是 0.5 秒的本地预览渲染器，P15–P18 靠的是单元测试与一键自检。

而 **P4 是一条真实的设计 bug，在没有渲染能力时几乎不可能被发现** ——
因为代码在语义上完全说得通，只有画出来才知道字没了。

**P17 和 P18 更值得注意**：它们不是「写错了」，而是「**没考虑到某条路径**」——
一个是长轮询的第三种终止方式，一个是队列的生命周期。
这类缺陷静态阅读代码几乎发现不了，只有把系统当作会长期运行的东西去推演才会浮现。

**P19–P27 是另一类**：它们全部在**第一次真正连上 Figma** 之后暴露。
P19 让第一条 `stats` 就报错，P21 让文档承诺的"回写"静默失效，P20 则是读代码时
顺手发现的地雷，P22 是插件掉线时白等 30 秒，P23 则是加了新布局语义后
**预览器没跟上**，P24 是桩比真机宽容（该销毁的没销毁），
P25 是两层名字系统没归一，
P26 是 dynamic-page 下用同步 getter 读异步属性（`safeCall` 又把失败吞成了 `null`），
P27 是安全开关本身是假的。共同点是：**桩测试全绿也照样存在**——
因为桩不知道用户的页面叫什么名字，也不会抱怨"改了个不存在的字段"，
更不会告诉你"预览和真机算出来的尺寸不一样"。

> **能看见，才能改对。** 如果一个改动无法验证，先花时间建立验证手段，
> 再动手改设计。本项目里那 0.5 秒的本地预览渲染器，
> 换来的是一次 Figma 往返都没浪费。
>
> 但也要记住上面这条的反面：**桩测试的绿灯只代表"逻辑自洽"，不代表"接上真机还成立"。**
> 能连真机时，先连真机跑一遍最平凡的路径（`stats`、`dump`、`patch --dry`）。
