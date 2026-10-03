# 架构与协议

## 1. 数据流

```
┌───────────────┐  POST /render   ┌──────────────────┐   GET /next (长轮询 25s)  ┌────────────────────┐
│ Agent  / CLI  │ ──────────────▶ │  bridge :8787    │ ────────────────────────▶ │  Figma 插件 UI      │
│ tools/figma.mjs│                │  server.mjs      │ ◀──────────────────────── │  (ui.html, iframe) │
└───────────────┘ ◀────────────── └──────────────────┘   {id, cmd, payload}      └─────────┬──────────┘
                    结果 / PNG                                            postMessage │ ▲ postMessage
                                                               ┌─────────────────────▼─┴──────────┐
                                                               │  Figma 插件主线程 (code.js)        │
                                                               │  · 渲染引擎：JSON → Figma 节点     │
                                                               │  · 导出：node.exportAsync → base64 │
                                                               └───────────────────────────────────┘
```

一次 `render` 的完整时序：

```
CLI                bridge                    UI(iframe)              主线程(code.js)
 │  POST /render     │                            │                        │
 │ ─────────────────▶│  入队 {id:c3,cmd:render}    │                        │
 │                   │ ◀── GET /next ──────────────│  (阻塞等待，最多 25s)   │
 │                   │ ──── {id:c3,cmd,payload} ──▶│                        │
 │                   │                            │ ── postMessage ───────▶│
 │                   │                            │                        │ 建 1413 个节点
 │                   │ ◀── POST /progress ─────────│ ◀── progress ──────────│ (每 80 个节点)
 │                   │                            │ ◀── {id:c3,ok,data} ───│
 │                   │ ◀── POST /result ───────────│                        │
 │ ◀── HTTP 200 ─────│  (兑现挂起的 promise)        │                        │
```

**关键点**：UI 在等待主线程执行期间**不轮询** `/next`。所以桥看到的
`pluginSeenAgo` 会在长渲染期间持续增长，这**是正常的**，不代表插件掉线。
判断长任务是否在推进，要看 `/status` 的 `progress` 字段。

---

## 2. 为什么这样设计

### 2.1 为什么不用 Figma REST API

Figma REST API 对设计内容**只能读**。写操作仅限 Variables（企业版）、评论、dev resources 等
少数端点。要创建 Frame / 文本 / Auto Layout，**只能用 Plugin API**，而 Plugin API 只能运行在
Figma 内部（沙箱，无 DOM、无 `fetch`）。

### 2.2 为什么不用 WebSocket

插件 UI 是 **null-origin iframe**。在 CORS 下：

- `ws://` 握手行为不稳定，且 Figma 的 `networkAccess` 对 `ws`/`wss` 的放行规则另有差异
- HTTP 长轮询在任何情况下都只是普通请求，`Access-Control-Allow-Origin: *` 即可

副产品：**整条链路零 npm 依赖**（只用 `node:http` / `node:fs` / `node:path`），
不需要 `npm install`，也不怕依赖腐化。

长轮询的延迟代价是 0：桥把请求**挂起** 25 秒，指令一到立刻返回，不会忙等。

### 2.3 为什么插件要自带「自检回路」

Agent 无法「看见」画布。所以插件实现了 `export` 指令：把节点 `exportAsync` 成 PNG、
base64 回传，桥落盘到 `out/`，Agent 再用图像读取能力核对。**这是整个系统的可信度基础** ——
没有它，Agent 只能宣称"我画好了"，无法验证。

### 2.4 为什么还要一个本地预览渲染器

Figma 往返一次要几分钟（导入插件、渲染、导出、人工确认），而本地预览 **0.5 秒**。
`specs/preview.py` 用 Pillow 复刻了插件的布局语义，让绝大多数布局/视觉 bug 在
推到 Figma **之前**就被发现。

代价：它是**近似**。真实字体行高、Figma auto-layout 的边界行为可能与预览有偏差，
所以关键改动仍必须用 Figma 真实截图确认。

---

## 3. 桥的 HTTP 协议

基址 `http://localhost:8787`，全部响应带 `Access-Control-Allow-Origin: *`。

### 插件侧（内部使用）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/next` | 长轮询取指令。有指令立刻返回 `{id,cmd,payload}`；无指令挂起 25s 后返回 `204` |
| `POST` | `/result` | 回报执行结果 `{id, ok, data?, error?}` |
| `POST` | `/progress` | 长任务进度 `{cmd, done}`，写入 `state.progress` |
| `POST` | `/hello` | 插件启动时注册自身信息 `{info}`，避免 `/status` 显示过期数据 |

### Agent / CLI 侧

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/status` | `{pluginOnline, pluginSeenAgo, pluginInfo, progress, queue, inflight, port}` |
| `GET` | `/events` | 最近 80 条桥日志 |
| `GET` | `/health` | 存活探测 |
| `GET` | `/` | HTML 调试页（状态 + 日志） |
| `POST` | `/render` | `{spec, clear?, pageName?, timeoutMs?}` → 阻塞直到渲染完成 |
| `POST` | `/export` | `{names?, all?, scale?, prefix?}` → 导出 PNG 并**落盘**，返回文件路径 |
| `POST` | `/clear` | `{pageName?}` → 清空页面 |
| `POST` | `/cmd` | `{cmd, payload, timeoutMs?}` → 万能逃生舱，直接下发任意指令 |

### 常量

| 常量 | 值 | 位置 |
|---|---|---|
| 端口 | `8787`（`DSH_FIGMA_PORT` 可覆盖） | `server.mjs` |
| 长轮询挂起 | 25 s | `POLL_TIMEOUT_MS` |
| 插件心跳 TTL | 40 s | `PLUGIN_TTL_MS` |
| 请求体上限 | 80 MB | `MAX_BODY` |
| 指令默认超时 | 180 s | `dispatch()` |
| UI 等待主线程超时 | 600 s | `ui.html` 的 `run()` |

> 心跳 TTL(40s) > 长轮询挂起(25s)，所以在线插件的心跳永远新鲜。
> 若把 TTL 调到 25s 以下，空闲插件会被误判为离线。

---

## 4. 插件侧架构

### 4.1 manifest 要点

```json
{
  "documentAccess": "dynamic-page",          // 必填；不预加载所有页面
  "networkAccess": {
    "allowedDomains": ["http://localhost:8787"],
    "devAllowedDomains": ["http://localhost:8787"],
    "reasoning": "..."                        // 含本地服务时必填
  }
}
```

⚠️ `allowedDomains` **只接受域名模式，不接受 IP 字面量**。
`http://127.0.0.1:8787` 会被拒绝并报 `must be a valid url`。

### 4.2 主线程（`code.js`）

沙箱环境：**无 DOM、无 `fetch`、无 `XMLHttpRequest`**。只能通过
`figma.ui.postMessage` 与 UI 通信，所有网络都在 UI 侧。

```
HANDLERS = { ping, stats, render, export, clear, focus }
```

| 指令 | 作用 |
|---|---|
| `ping` | 返回版本、文件名、当前页、页面列表 |
| `stats` | 返回目标页的顶层 Frame 列表与**节点总数**（用于查证渲染完整性） |
| `render` | 把规格渲染成节点；带分片让出与进度上报 |
| `export` | 导出节点为 PNG（`SCALE` 约束），base64 回传 |
| `clear` | 清空指定页面的所有子节点 |
| `focus` | 选中并缩放到指定节点（会先切到该节点所在页） |

**渲染流程**（`build()` 的递归顺序很关键）：

```
build(spec, parent):
  1. createNode(spec)          ← 创建并按 spec 设置属性（尺寸/填充/字体）
  2. parent.appendChild(node)
  3. applyLayoutChild(node)    ← 依赖父容器：fill/hug/grow/stretch、绝对定位 x/y
  4. 递归 build 每个子节点
  5. finalizeAuto(node)        ← 子节点都进去之后，才能定自身的 HUG/FIXED
```

顺序不能换：auto-layout 容器只有在子节点全部挂载后，才知道自己该多大。

**分片让出**：主线程是单线程的，长时间不让出会冻住整个 Figma。
`cmdRender` 每创建 80 个节点就 `await new Promise(r => setTimeout(r, 0))` 一次，
并用 `figma.ui.postMessage({type:'progress', done})` 上报进度。

**字体解析**：`resolveFont(family, weight, italic)` 按
`['PingFang SC','Inter','Helvetica Neue','Arial','Roboto']` 依次尝试，
权重映射到样式名（400→Regular、500→Medium、600→Semibold、700→Bold…），
并尝试 `SemiBold`/`Semi Bold` 两种写法。成功缓存进 `fontCache`，失败记入 `fontMiss`
避免重复尝试。**必须先 `loadFontAsync` 再设 `characters`**。

### 4.3 UI 侧（`ui.html`）

- 启动时 `ping` 握手 → `POST /hello` 注册
- 进入 `while(true)` 长轮询循环：`GET /next` → `run(cmd)` → `POST /result`
- **`run()` 必须带超时**（见 `docs/PITFALLS.md` P3）
- 转交主线程的进度消息到 `POST /progress`
- 兜底：一个文本框可粘贴规格 JSON 直接本地渲染，用于桥不可用时

---

## 5. CLI（`tools/figma.mjs`）

对桥的薄封装，`requirePlugin()` 会先查 `/status` 再做一次**真实 ping 往返**确认在线
（因为心跳可能刚过期，只看心跳会误判）。

`render` 会把整个规格 JSON 一次性 POST 给桥，桥再转给插件。
规格 130KB 时端到端往返实测 **94ms**（不含插件建节点的时间）。

---

## 6. 数据量参考

| 指标 | 值 |
|---|---|
| 5 屏炒股 App 规格 | 1413 节点 / ~300 KB JSON |
| 规格中 auto-layout 容器 | 311 个 |
| 最大嵌套深度 | 6 层 |
| 桥传输往返 | 94 ms |
| 本地预览渲染 | 0.5 s |
| Figma 实际建节点 | 数十秒量级（取决于机器） |
