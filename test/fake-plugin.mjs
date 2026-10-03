/* =============================================================================
 * 假 Figma 插件 —— 用于在没有 Figma 的环境下验证桥的协议是否连通
 * 运行：node test/fake-plugin.mjs
 * ========================================================================== */
const BRIDGE = process.env.BRIDGE || 'http://127.0.0.1:8787';
let alive = true;
let handled = 0;

const t0 = Date.now();
const log = (...a) => console.log(`[fake-plugin +${Date.now() - t0}ms]`, ...a);

async function handle(cmd, payload) {
  switch (cmd) {
    case 'ping':
      return { data: { version: 'fake-1.0', file: 'Fake Design', page: 'Page 1', pages: ['Page 1'] } };
    case 'render': {
      const frames = payload.spec?.frames || [];
      const bytes = JSON.stringify(payload.spec || {}).length;
      return { data: { page: payload.pageName, frames: frames.map((f) => f.name), total: frames.length, receivedBytes: bytes } };
    }
    case 'export':
      // 1x1 透明 PNG
      return { data: { files: [{ name: 'fake', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }] } };
    case 'clear':
      return { data: { page: payload.pageName, removed: 0 } };
    default:
      return { data: { echo: cmd } };
  }
}

async function loop() {
  while (alive) {
    try {
      const res = await fetch(`${BRIDGE}/next`, { cache: 'no-store' });
      if (res.status === 204) continue;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const env = await res.json();
      const out = await handle(env.cmd, env.payload || {});
      await fetch(`${BRIDGE}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: env.id, ok: true, ...out }),
      });
      handled++;
      log(`handled ${env.cmd} (${env.id})  累计 ${handled}`);
    } catch (e) {
      log('loop error:', e.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

process.on('SIGINT', () => { alive = false; log('bye'); process.exit(0); });
process.on('SIGTERM', () => { alive = false; process.exit(0); });
log(`connecting to ${BRIDGE}`);
loop();
