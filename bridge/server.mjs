#!/usr/bin/env node
/**
 * DSH <-> Figma Prototype Bridge
 * ---------------------------------
 * 零依赖 HTTP 长轮询桥。
 *
 *   Figma 插件 UI  ──GET /next──▶  (挂起等待指令)
 *                  ◀──{id,cmd}──
 *                  ──POST /result─▶  回传执行结果
 *
 *   DSH (我)       ──POST /render──▶  下发渲染指令，阻塞直到插件执行完毕
 *
 * 之所以不用 WebSocket：Figma 插件 UI 是 null-origin iframe，
 * 长轮询在 CORS 下比 ws 握手稳得多，且完全不需要 npm 依赖。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const OUT_DIR = path.join(PROJECT, 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PORT = Number(process.env.DSH_FIGMA_PORT || 8787);
// 不指定 host 时 Node 会绑定到 :: （dual-stack），
// 这样 localhost 无论解析到 ::1(IPv6) 还是 127.0.0.1(IPv4) 都能连上。
// Figma 的 networkAccess 只允许域名模式，所以我们只能用 http://localhost:PORT。
const HOST = process.env.DSH_FIGMA_HOST || null;
const POLL_TIMEOUT_MS = 25_000;
// 排队指令的存活时间：超过就丢弃，避免「幽灵操作」在插件稍后连接时被执行
const QUEUE_TTL_MS = Number(process.env.DSH_QUEUE_TTL_MS || 60_000);
const MAX_BODY = 80 * 1024 * 1024;

const state = {
  pluginSeenAt: 0,
  pluginInfo: null,
  queue: [],        // 待插件取走的指令
  waiter: null,     // 正在挂起的 /next 请求
  inflight: new Map(),
  seq: 0,
  progress: null,
  events: [],       // 最近事件日志
};

const PLUGIN_TTL_MS = 40_000;
const pluginOnline = () => Date.now() - state.pluginSeenAt < PLUGIN_TTL_MS;

function log(...args) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${args.join(' ')}`;
  console.log(line);
  state.events.push(line);
  if (state.events.length > 300) state.events.splice(0, state.events.length - 300);
}

/* ---------------------------------------------------------------- HTTP utils */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function send(res, code, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { ...CORS, 'Content-Type': `${type}; charset=utf-8` });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`bad JSON: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------ command plumbing */

function deliver(envelope) {
  if (state.waiter) {
    const { res, timer } = state.waiter;
    state.waiter = null;
    clearTimeout(timer);
    send(res, 200, envelope);
    log(`→ 下发 ${envelope.cmd} (${envelope.id})`);
    return;
  }
  state.queue.push(envelope);
  log(`→ 入队 ${envelope.cmd} (${envelope.id})，插件离线中，队列=${state.queue.length}`);
}

/** 下发指令并等待插件执行完毕 */
function dispatch(cmd, payload = {}, timeoutMs = 180_000) {
  const id = `c${++state.seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.inflight.delete(id);
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms — 插件未响应（Figma 里插件是否在运行？）` });
    }, timeoutMs);
    // ts 供离线看门狗判断「这条等了多久」
    state.inflight.set(id, { resolve, timer, ts: Date.now(), cmd });
    deliver({ id, cmd, payload, ts: Date.now() });
  });
}

/**
 * 丢弃过期队列指令。
 * 若一条几分钟前下发的 patch/remove 在插件稍后连接时才执行，
 * 就变成了「幽灵操作」——改到的东西可能早已不是当初的目标。
 */
function purgeStaleQueue() {
  if (!state.queue.length) return 0;
  const now = Date.now();
  const before = state.queue.length;
  state.queue = state.queue.filter((e) => now - (e.ts || 0) < QUEUE_TTL_MS);
  const dropped = before - state.queue.length;
  if (dropped) log(`⚠ 丢弃 ${dropped} 条过期队列指令（超过 ${QUEUE_TTL_MS / 1000}s 未被执行）`);
  return dropped;
}

/**
 * 离线看门狗：插件已经掉线、且这条指令等了足够久 → 立刻失败。
 *
 * 为什么需要它：插件（Figma 里的插件面板被关掉、或 Figma 失去焦点被挂起）
 * 一旦停止轮询，`dispatch` 只能等自己的超时（默认 120–300s）才 resolve。
 * 调用方就这么干等着，`/status` 里还挂着 `inflight: N`，看起来像"卡住了"。
 * 实际上连接早就断了——只是没人告诉它。
 *
 * 判据刻意保守：必须是「插件当前不在线」**且**「这条指令已等待超过阈值」。
 * 长时间渲染不会误伤——渲染期间每 80 个节点发一次 /progress，心跳是新鲜的。
 */
const OFFLINE_FAIL_MS = Number(process.env.DSH_OFFLINE_FAIL_MS || 45_000);

function failInflightWhenOffline() {
  if (!state.inflight.size) return;
  if (pluginOnline()) return;
  const now = Date.now();
  const dead = [];
  for (const [id, entry] of state.inflight) {
    if (now - entry.ts >= OFFLINE_FAIL_MS) dead.push([id, entry]);
  }
  if (!dead.length) return;
  for (const [id, entry] of dead) {
    clearTimeout(entry.timer);
    state.inflight.delete(id);
    entry.resolve({
      ok: false,
      offline: true,
      error: `插件已离线（等待 ${Math.round((now - entry.ts) / 1000)}s 无响应）。`
        + '请在 Figma 里重新运行插件 —— Plugins → Development → FIMG Agent Plugin。',
    });
  }
  const seen = state.pluginSeenAt ? `${Math.round((now - state.pluginSeenAt) / 1000)}s 前` : '从未';
  // 顺手清掉这些指令在队列里的残留：调用方已经放弃了，留着只会让 /status 的
  // queue 数字虚高（真正的清理要等下一次 /next，插件不来就永远等不到）。
  if (state.queue.length) {
    const before = state.queue.length;
    state.queue = state.queue.filter((e) => state.inflight.has(e.id));
    if (state.queue.length !== before) {
      log(`  同时清理 ${before - state.queue.length} 条已放弃的队列指令`);
    }
  }
  log(`⚠ 插件离线（最后心跳 ${seen}），中止 ${dead.length} 条在途指令：${dead.map(([id, e]) => `${e.cmd}(${id})`).join(', ')}`);
}

// 每 2s 检查一次。unref 保证它不会拖住进程退出。
setInterval(failInflightWhenOffline, 2_000).unref();

/* ------------------------------------------------------------------ endpoints */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  try {
    switch (route) {
      /* ---- 插件侧 ---- */
      case 'GET /next': {
        state.pluginSeenAt = Date.now();
        purgeStaleQueue();
        if (state.queue.length) {
          const env = state.queue.shift();
          log(`→ 下发(排队) ${env.cmd} (${env.id})`);
          return send(res, 200, env);
        }
        if (state.waiter) {
          const { res: old, timer } = state.waiter;
          state.waiter = null;
          clearTimeout(timer);
          send(old, 204, '');
        }
        const timer = setTimeout(() => {
          if (state.waiter && state.waiter.res === res) state.waiter = null;
          send(res, 204, '');
        }, POLL_TIMEOUT_MS);
        state.waiter = { res, timer };
        // 客户端（插件 UI）中断长轮询时必须清掉挂起项，
        // 否则后续指令会被「投递到虚空」——表现为命令发出去了却永远没执行。
        req.on('close', () => {
          if (state.waiter && state.waiter.res === res) {
            clearTimeout(state.waiter.timer);
            state.waiter = null;
            log('插件轮询连接中断，已取消挂起');
          }
        });
        return;
      }

      case 'POST /result': {
        const body = await readBody(req);
        state.pluginSeenAt = Date.now();
        const entry = state.inflight.get(body.id);
        if (!entry) return send(res, 200, { ok: true, note: 'no inflight (probably timed out)' });
        state.inflight.delete(body.id);
        clearTimeout(entry.timer);
        log(body.ok ? `← 完成 ${body.id}` : `← 失败 ${body.id}: ${body.error}`);
        entry.resolve(body);
        return send(res, 200, { ok: true });
      }

      /* 渲染进度（长任务可观测） */
      case 'POST /progress': {
        const body = await readBody(req);
        state.pluginSeenAt = Date.now();
        state.progress = { done: body.done, cmd: body.cmd, at: Date.now() };
        return send(res, 200, { ok: true });
      }

      /* 插件启动时上报自身信息，避免 /status 显示过期数据 */
      case 'POST /hello': {
        const body = await readBody(req);
        state.pluginSeenAt = Date.now();
        state.pluginInfo = { ...(body.info || {}), connectedAt: new Date().toISOString() };

        // 插件重连意味着上一轮会话结束。必须清掉遗留指令，避免「幽灵操作」：
        // 一条几分钟前下发的 patch/remove 若在此时才执行，会改到不该改的东西。
        const droppedQueue = state.queue.length;
        state.queue = [];
        let droppedInflight = 0;
        for (const [, entry] of state.inflight) {
          clearTimeout(entry.timer);
          entry.resolve({ ok: false, error: '插件重连，指令已丢弃（避免过期操作被延迟执行）' });
          droppedInflight++;
        }
        state.inflight.clear();
        if (droppedQueue || droppedInflight) {
          log(`⚠ 插件重连：丢弃 ${droppedQueue} 条排队指令、${droppedInflight} 条在途指令`);
        }

        log(`● 插件已连接: ${JSON.stringify(body.info || {})}`);
        return send(res, 200, { ok: true, droppedQueue, droppedInflight });
      }

      /* ---- DSH 侧 ---- */
      case 'GET /status': {
        return send(res, 200, {
          pluginOnline: pluginOnline(),
          pluginSeenAgo: state.pluginSeenAt ? Date.now() - state.pluginSeenAt : null,
          pluginInfo: state.pluginInfo,
          progress: state.progress,
          queue: state.queue.length,
          inflight: state.inflight.size,
          port: PORT,
        });
      }

      case 'GET /health':
        return send(res, 200, { ok: true });

      case 'GET /events':
        return send(res, 200, { events: state.events.slice(-80) });

      case 'POST /render': {
        const body = await readBody(req);
        if (!body.spec) return send(res, 400, { ok: false, error: 'missing "spec"' });
        const result = await dispatch('render', {
          spec: body.spec,
          // 默认不清空页面（在现有设计稿上迭代时误清空代价太大）
          clear: body.clear === true,
          // 不兜底页名：undefined 交给插件解释为「当前页」。
          // 以前兜底 'FIMG Prototype'，导致页面改名后凭空新建一个空页。
          pageName: body.pageName || undefined,
        }, body.timeoutMs || 180_000);
        return send(res, result.ok ? 200 : 500, result);
      }

      case 'POST /export': {
        const body = await readBody(req);
        const result = await dispatch('export', {
          names: body.names || [],
          scale: body.scale || 2,
          all: !!body.all,
          // 不兜底页名：undefined 交给插件解释为「当前页」
          pageName: body.pageName || undefined,
        }, body.timeoutMs || 120_000);
        if (!result.ok) return send(res, 500, result);

        // 把 base64 落到磁盘，方便我直接读图看效果
        const saved = [];
        for (const f of result.data?.files || []) {
          const safe = String(f.name).replace(/[^\w\u4e00-\u9fa5·.\-]+/g, '_');
          const file = path.join(OUT_DIR, `${body.prefix ? body.prefix + '_' : ''}${safe}.png`);
          fs.writeFileSync(file, Buffer.from(f.base64, 'base64'));
          saved.push(file);
          log(`💾 ${file}`);
        }
        return send(res, 200, { ok: true, saved, savedNames: (result.data?.files || []).map((f) => f.name) });
      }

      case 'POST /clear': {
        const body = await readBody(req);
        // 同样不兜底页名：默认清空「当前页」。插件侧对找不到的页名会返回
        // note 且什么都不删，CLI 会把它当成错误报出来。
        const result = await dispatch('clear', { pageName: body.pageName || undefined });
        return send(res, result.ok ? 200 : 500, result);
      }

      /** 万能逃生舱：直接下发任意指令给插件 */
      case 'POST /cmd': {
        const body = await readBody(req);
        const result = await dispatch(body.cmd, body.payload || {}, body.timeoutMs || 120_000);
        if (body.cmd === 'ping' && result.ok) state.pluginInfo = result.data;
        return send(res, result.ok ? 200 : 500, result);
      }

      case 'GET /': {
        const s = {
          pluginOnline: pluginOnline(),
          pluginSeenAgoMs: state.pluginSeenAt ? Date.now() - state.pluginSeenAt : null,
          pluginInfo: state.pluginInfo,
          queue: state.queue.length,
          inflight: state.inflight.size,
          outDir: OUT_DIR,
        };
        return send(res, 200, `<pre>${JSON.stringify(s, null, 2)}\n\n${state.events.slice(-25).join('\n')}</pre>`, 'text/html');
      }

      default:
        return send(res, 404, { ok: false, error: `no route: ${route}` });
    }
  } catch (err) {
    return send(res, 500, { ok: false, error: String(err?.message || err) });
  }
});

function onListen() {
  const shown = HOST || 'localhost (dual-stack IPv4+IPv6)';
  log(`bridge listening on http://${shown}:${PORT}`);
  log(`out dir: ${OUT_DIR}`);
}
if (HOST) server.listen(PORT, HOST, onListen);
else server.listen(PORT, onListen);

process.on('SIGTERM', () => { log('shutdown'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { log('shutdown'); server.close(() => process.exit(0)); });
