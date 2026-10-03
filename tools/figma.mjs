#!/usr/bin/env node
/* =============================================================================
 * figma — 桥的命令行客户端
 * -----------------------------------------------------------------------------
 *   node tools/figma.mjs status
 *   node tools/figma.mjs render [specs/stock-app.json]
 *   node tools/figma.mjs export --all
 *   node tools/figma.mjs export --names "01 行情"
 *   node tools/figma.mjs clear
 *   node tools/figma.mjs ping
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BRIDGE = process.env.BRIDGE || 'http://localhost:8787';

const [, , cmd = 'status', ...rest] = process.argv;
const flag = (name, def = null) => {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = rest[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

/**
 * 目标页面。
 *   --page 名称  >  环境变量 DSH_FIGMA_PAGE  >  undefined（交给插件：跟随当前页）
 *
 * 刻意**没有默认页名**。以前硬编码 "FIMG Prototype"，结果页面一改名，
 * stats 就报「未找到页面」，render 还会凭空新建一个空页——而用户以为
 * 画在了自己的稿子上。读操作更是绝不该创建页面。
 */
const pageFlag = () => {
  const v = flag('page', undefined);
  if (v === true) return undefined;              // 只写了 --page，没跟值
  return v || process.env.DSH_FIGMA_PAGE || undefined;
};

/**
 * 把 --id / --ids / --name / --text / --type / --layout / --within 收成一个选择器。
 * rm / move / dup / group / ungroup / dump 共用，避免每个 case 抄一遍。
 */
function selectorPayload() {
  const p = {};
  if (flag('id')) p.ids = [String(flag('id'))];
  if (flag('ids')) p.ids = String(flag('ids')).split(',').map((s) => s.trim());
  if (flag('name')) p.name = String(flag('name'));
  if (flag('text')) p.text = String(flag('text'));
  if (flag('type')) p.type = String(flag('type'));
  if (flag('layout')) p.layout = String(flag('layout'));
  if (flag('within')) p.within = String(flag('within'));
  const page = pageFlag();
  if (page) p.pageName = page;
  return p;
}

/** 选择器里有没有真正的筛选条件（within/pageName 只是范围，不算条件） */
const hasSelectorFlag = (p) => !!(p.ids || p.name != null || p.text != null || p.type != null || p.layout != null);

/** 目标父容器：--to <id> / --parent-name <名称> */
function parentPayload() {
  const p = {};
  if (flag('to')) p.parentId = String(flag('to'));
  if (flag('parent')) p.parentId = String(flag('parent'));
  if (flag('parent-name')) p.parentName = String(flag('parent-name'));
  if (p.parentId && p.parentName != null) delete p.parentName;
  return p;
}

const SELECTOR_HINT = '请指定要操作的节点：--id / --ids / --name / --text / --type / --layout'
  + '（同名图层很多时加 --within <容器id> 限定范围）';

async function api(route, body, timeoutMs = 300_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  } catch (e) {
    // 不要抛出未捕获的 AbortError 堆栈——给出可操作的提示
    if (e.name === 'AbortError') {
      return { status: 0, json: { ok: false, unreachable: true,
        error: `请求超时（${Math.round(timeoutMs / 1000)}s）。插件可能没在运行，或在 Figma 里需要重新运行。` } };
    }
    return { status: 0, json: { ok: false, unreachable: true,
      error: `连不上桥 ${BRIDGE} —— ${e.message}。先执行 ./scripts/start-bridge.sh` } };
  } finally {
    clearTimeout(timer);
  }
}

function die(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

async function requirePlugin() {
  const { json: st } = await api('/status', null, 5_000);
  if (st.unreachable) die(st.error);
  if (!st.pluginOnline) {
    die('Figma 插件未连接。请在 Figma 中运行 Plugins → Development → FIMG Agent Plugin。');
  }
  // 心跳可能刚过期，做一次真实往返确认在线
  const { json } = await api('/cmd', { cmd: 'ping' }, 30_000);
  if (!json.ok) die(`插件无响应：${json.error}`);
  return json.data;
}

const specArg = rest.find((a) => !a.startsWith('--') && a.endsWith('.json'));
const specFile = specArg || path.join(ROOT, 'specs', 'stock-app.json');

switch (cmd) {
  case 'status': {
    const { json } = await api('/status', null, 5_000);
    if (json.unreachable) die(json.error);
    console.log(json.pluginOnline
      ? `● 插件在线（${Math.round(json.pluginSeenAgo / 1000)}s 前有心跳）`
      : '○ 插件离线（在 Figma 里运行 Plugins → Development → FIMG Agent Plugin）');
    if (json.pluginInfo) console.log('  ', JSON.stringify(json.pluginInfo));
    if (json.progress) console.log(`   进度 ${json.progress.cmd}: 已创建 ${json.progress.done} 节点`);
    console.log(`   队列 ${json.queue} / 在途 ${json.inflight} / 端口 ${json.port}`);
    break;
  }

  case 'ping': {
    const { json } = await api('/cmd', { cmd: 'ping' }, 20_000);
    if (!json.ok) die(json.unreachable ? json.error : `插件无响应：${json.error}`);
    console.log('● 插件握手成功');
    console.log(JSON.stringify(json.data, null, 2));
    break;
  }

  case 'stats': {
    await requirePlugin();
    const { json, status } = await api('/cmd', { cmd: 'stats', payload: { pageName: pageFlag() } }, 60_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    const d = json.data;
    console.log(`当前页: ${d.currentPage}`);
    console.log(`页面列表: ${d.pages.join(', ')}`);
    if (d.target) {
      console.log(`「${d.target.page}」顶层 Frame (${d.target.topLevel.length}):`);
      d.target.topLevel.forEach((n) => console.log(`   · ${n}`));
      console.log(`   合计节点数: ${d.target.totalNodes}`);
    } else {
      console.log(`✖ ${d.note || '未找到目标页面'}`);
      console.log('  不指定 --page 时统计的是「当前页」；要指定用 --page 名称');
    }
    break;
  }

  case 'render': {
    await requirePlugin();
    if (!fs.existsSync(specFile)) die(`规格文件不存在: ${specFile}`);
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    const total = JSON.stringify(spec).length;
    process.stdout.write(`… 下发 ${path.basename(specFile)}（${(total / 1024).toFixed(0)} KB）`);
    const t0 = Date.now();
    const { json, status } = await api('/render', {
      spec,
      // 默认不清空；要清空必须显式 --clear
      clear: flag('clear') === true,
      // 不传 pageName 时由插件决定：渲染到 Figma 的当前页，绝不新建页面
      pageName: pageFlag(),
    });
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    console.log(`\r✔ 渲染完成，用时 ${Date.now() - t0}ms`);
    console.log(`   页面「${json.data.page}」共 ${json.data.total} 个顶层 Frame`);
    json.data.frames.forEach((f) => console.log(`   · ${f}`));
    break;
  }

  case 'export': {
    await requirePlugin();
    const namesRaw = flag('names');
    const body = {
      all: flag('all') === true || !namesRaw,
      names: namesRaw && namesRaw !== true ? String(namesRaw).split(',').map((s) => s.trim()) : [],
      scale: Number(flag('scale', 2)),
      prefix: flag('prefix', ''),
      // 不传则由插件导出「当前页」；--page 指定则跨页导出
      pageName: pageFlag(),
    };
    const { json, status } = await api('/export', body);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    console.log(`✔ 导出 ${json.saved.length} 张截图`);
    json.saved.forEach((p) => console.log(`   · ${path.relative(ROOT, p)}`));
    break;
  }

  case 'clear': {
    await requirePlugin();
    if (flag('yes') !== true) {
      die('clear 会删光目标页面的节点。确认请加 --yes');
    }
    const { json, status } = await api('/clear', { pageName: pageFlag() });
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    if (json.data.note) die(`${json.data.note}（什么也没删）`);
    console.log(`✔ 已清空页面「${json.data.page}」，移除 ${json.data.removed} 个节点`);
    break;
  }

  /* ============ 读取与就地修改（在现有设计稿上迭代） ============ */

  case 'list': {
    await requirePlugin();
    const { json, status } = await api('/cmd', {
      cmd: 'list',
      payload: { pageName: pageFlag(), maxDepth: Number(flag('depth', 6)) },
    }, 120_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    console.log(`页面「${json.data.page}」大纲（${json.data.lines} 行${json.data.truncated ? '，已截断' : ''}）：`);
    console.log(json.data.outline);
    break;
  }

  case 'dump': {
    await requirePlugin();
    const payload = { maxDepth: Number(flag('depth', 8)), maxNodes: Number(flag('max', 4000)) };
    const page = pageFlag();
    if (page) payload.pageName = page;
    if (flag('within')) payload.within = String(flag('within'));
    if (flag('id')) payload.ids = [String(flag('id'))];
    if (flag('ids')) payload.ids = String(flag('ids')).split(',').map((s) => s.trim());
    if (flag('name')) payload.name = String(flag('name'));
    if (flag('text')) payload.text = String(flag('text'));
    if (flag('type')) payload.type = String(flag('type'));
    if (flag('sel') === true) payload.selection = true;   // 明确按当前选区；默认也会优先用选区
    const { json, status } = await api('/cmd', { cmd: 'dump', payload }, 180_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    const out = flag('out') && flag('out') !== true
      ? String(flag('out'))
      : path.join(ROOT, 'dumps', `dump-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(json.data, null, 1));
    console.log(`✔ 读取 ${json.data.rootCount} 个根节点 / ${json.data.nodeCount} 个节点（scope=${json.data.scope}, page=${json.data.page}）`);
    if (json.data.truncated) console.log('   ⚠ 已达深度或数量上限，结果被截断');
    if (flag('within')) console.log(`   范围：${String(flag('within'))} 的子树`);
    console.log(`   → ${path.relative(ROOT, out)}`);
    break;
  }

  case 'patch': {
    await requirePlugin();
    const opsFile = flag('ops') && flag('ops') !== true ? String(flag('ops')) : null;
    if (!opsFile) die('需要 --ops <ops.json>（内容形如 {"ops":[…]})');
    const parsed = JSON.parse(fs.readFileSync(opsFile, 'utf8'));
    const ops = Array.isArray(parsed) ? parsed : parsed.ops;
    if (!ops) die('ops 文件里没有 ops 数组');
    // --within 作为整批的默认作用域，注入到每个没自己写 within 的 op。
    // 真实稿子里同名图层遍地都是，没有这个范围很容易误伤。
    const within = flag('within');
    if (within) {
      for (const op of ops) if (op.within == null) op.within = String(within);
    }
    const { json, status } = await api('/cmd', {
      cmd: 'patch',
      payload: { ops, dryRun: flag('dry') === true },
    }, 300_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    const matched = json.data.totalMatched;
    // 匹配 0 个节点时不要说「已应用」——那会让人以为改成功了。
    // 被护栏拒绝的 op 正好走这条路径（P20）。
    const head = json.data.dryRun
      ? '（dry-run，未写入）'
      : (matched ? '✔ 已应用' : '✖ 未修改任何节点');
    console.log(`${head} 共匹配 ${matched} 个节点`);
    for (const r of json.data.results) {
      if (r.error) { console.log(`  ✖ ${r.selector} → ${r.error}`); continue; }
      console.log(`  · ${r.selector} → 匹配 ${r.matched} 个`);
      for (const a of r.applied.slice(0, 12)) {
        if (a.error) { console.log(`      ✖ ${a.name}: ${a.error}`); continue; }
        const keys = Object.keys(a.changes || {});
        const detail = keys.map((k) => {
          const c = a.changes[k];
          if (c && c.error) return `${k}:✖${c.error}`;
          if (c && c.warning) return `${k}:⚠${c.warning}`;
          return `${k}: ${JSON.stringify(c?.from)} → ${JSON.stringify(c?.to)}`;
        }).join('; ');
        console.log(`      #${a.id} ${a.name}  ${detail}`);
      }
      if (r.applied.length > 12) console.log(`      … 还有 ${r.applied.length - 12} 个`);
    }
    break;
  }

  case 'insert': {
    await requirePlugin();
    if (!fs.existsSync(specFile)) die(`规格文件不存在: ${specFile}`);
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    const specs = flag('frame')
      ? spec.frames.filter((f) => matchAny(f.name, String(flag('frame'))))
      : (spec.frames || [spec.root].filter(Boolean));
    if (!specs.length) die('没有可插入的 spec（用 --frame 指定名称）');
    const payload = { specs, dryRun: flag('dry') === true };
    if (flag('parent')) payload.parentId = String(flag('parent'));
    if (flag('parent-name')) payload.parentName = String(flag('parent-name'));
    if (flag('index')) payload.index = Number(flag('index'));
    const { json, status } = await api('/cmd', { cmd: 'insert', payload }, 300_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    console.log(`${payload.dryRun ? '（dry-run，未插入）将插入到' : '✔ 已插入到'}「${json.data.parent.name}」(${json.data.parent.id})，共 ${json.data.created.length} 个节点`);
    json.data.created.forEach((n) => console.log(`   · ${n.name}${n.id ? '  #' + n.id : '  （未创建）'}`));
    break;
  }

  /* ============ 组件 / 实例 / 原型交互 ============ */

  case 'component': {
    await requirePlugin();
    const payload = { ...selectorPayload(), dryRun: flag('dry') === true };
    if (flag('rename')) payload.rename = String(flag('rename'));
    if (!hasSelectorFlag(payload)) die(SELECTOR_HINT);
    const { json, status } = await api('/cmd', { cmd: 'component', payload }, 180_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    console.log(`${payload.dryRun ? '（dry-run，未转换）' : '✔ 处理'} ${json.data.count} 个节点`);
    for (const c of json.data.created) {
      if (c.error) { console.log(`   ✖ ${c.name}: ${c.error}`); continue; }
      if (c.note) { console.log(`   · ${c.name}  (${c.note})`); continue; }
      console.log(`   · ${c.from} ${c.name} → COMPONENT  #${c.id}  (${c.w}×${c.h})`);
    }
    break;
  }

  case 'instance': {
    await requirePlugin();
    const payload = { ...parentPayload(), dryRun: flag('dry') === true };
    if (flag('of')) payload.of = String(flag('of'));
    if (flag('of-name')) payload.ofName = String(flag('of-name'));
    if (flag('count')) payload.count = Number(flag('count'));
    if (flag('index')) payload.index = Number(flag('index'));
    if (flag('x')) payload.x = Number(flag('x'));
    if (flag('y')) payload.y = Number(flag('y'));
    if (flag('rename')) payload.rename = String(flag('rename'));
    const instPage = pageFlag();
    if (instPage) payload.pageName = instPage;
    if (!payload.of && payload.ofName == null) die('要实例化哪个组件？给 --of <组件id> 或 --of-name <组件名>');
    const { json, status } = await api('/cmd', { cmd: 'instance', payload }, 180_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    console.log(`${payload.dryRun ? '（dry-run，未创建）' : '✔'} 放置 ${json.data.count} 个实例（来自组件「${json.data.component.name}」）`);
    if (json.data.ambiguous) {
      console.log(`   ⚠ 有 ${json.data.ambiguous} 个同名组件，用的是 #${json.data.component.id}；建议改用 --of <id>`);
    }
    json.data.created.forEach((n) => {
      if (n.error) return console.log(`   ✖ ${n.error}`);
      console.log(`   · ${n.type} ${n.name}  #${n.id}`);
    });
    break;
  }

  case 'swap': {
    await requirePlugin();
    const payload = { ...selectorPayload(), dryRun: flag('dry') === true };
    if (flag('to')) payload.to = String(flag('to'));
    if (flag('to-name')) payload.toName = String(flag('to-name'));
    if (!hasSelectorFlag(payload)) die(SELECTOR_HINT);
    if (!payload.to && payload.toName == null) die('换成哪个组件？给 --to <组件id> 或 --to-name <组件名>');
    const { json, status } = await api('/cmd', { cmd: 'swap', payload }, 180_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    if (payload.dryRun) console.log('（dry-run，未替换）');
    if (json.data.ambiguous) console.log(`   ⚠ 有 ${json.data.ambiguous} 个同名组件，用的是匹配到的第一个`);
    console.log(`✔ 处理 ${json.data.count} 个实例`);
    for (const s of json.data.swapped) {
      if (s.error) { console.log(`   ✖ ${s.name}: ${s.error}`); continue; }
      console.log(`   · ${s.name}  ${s.from} → ${s.to}`);
    }
    break;
  }

  case 'detach': {
    await requirePlugin();
    const payload = { ...selectorPayload(), dryRun: flag('dry') === true };
    if (!hasSelectorFlag(payload)) die(SELECTOR_HINT);
    const { json, status } = await api('/cmd', { cmd: 'detach', payload }, 180_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    console.log(`${json.data.dryRun ? '（dry-run）' : '✔'} 处理 ${json.data.count} 个实例`);
    for (const d of json.data.detached) {
      if (d.error) { console.log(`   ✖ ${d.name}: ${d.error}`); continue; }
      console.log(`   · ${d.name}  → ${d.detachedTo.type}  #${d.detachedTo.id}`);
    }
    break;
  }

  case 'reactions': {
    await requirePlugin();
    const payload = selectorPayload();
    if (!hasSelectorFlag(payload)) die(SELECTOR_HINT);
    const { json, status } = await api('/cmd', { cmd: 'reactions', payload }, 180_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    if (!json.data.count) { console.log('（这些节点上没有原型交互）'); break; }
    console.log(`✔ ${json.data.count} 个节点有交互：`);
    for (const n of json.data.nodes) {
      console.log(`   · ${n.type} ${n.name}  #${n.id}`);
      for (const r of n.reactions) {
        for (const a of r.actions) {
          const dest = a.destination
            ? (a.destination.missing ? `✖ 目标已丢失(${a.destination.id})` : `→「${a.destination.name}」`)
            : '';
          const url = a.url ? `→ ${a.url}` : '';
          const tr = a.transition ? `  [${a.transition.type}]` : '';
          console.log(`       ${r.trigger.type}  ${a.navigation || a.type} ${dest}${url}${tr}`);
        }
      }
    }
    break;
  }

  case 'link': {
    await requirePlugin();
    const payload = { ...selectorPayload(), dryRun: flag('dry') === true };
    if (flag('to')) payload.to = String(flag('to'));
    if (flag('to-name')) payload.toName = String(flag('to-name'));
    if (flag('url')) payload.url = String(flag('url'));
    if (flag('trigger')) payload.trigger = String(flag('trigger'));
    if (flag('timeout')) payload.timeout = Number(flag('timeout'));
    if (flag('nav')) payload.nav = String(flag('nav'));
    const tr = flag('transition');
    if (tr !== true && tr !== null) payload.transition = String(tr);
    if (flag('no-transition') === true) payload.transition = false;
    if (flag('easing')) payload.easing = String(flag('easing'));
    if (flag('duration')) payload.duration = Number(flag('duration'));
    if (flag('append') === true) payload.append = true;
    if (flag('clear') === true) payload.clear = true;
    if (!hasSelectorFlag(payload)) die(SELECTOR_HINT);
    if (!payload.clear && !payload.to && payload.toName == null && !payload.url) {
      die('要连到哪里？给 --to <节点id> / --to-name <名称> / --url <网址>，或 --clear 清空交互');
    }
    const { json, status } = await api('/cmd', { cmd: 'link', payload }, 180_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    const verb = payload.clear ? '清空' : (payload.append ? '追加' : '设置');
    console.log(`${json.data.dryRun ? '（dry-run）' : '✔'} ${verb}交互：${json.data.count} 个节点`);
    for (const n of json.data.nodes) {
      if (n.error) { console.log(`   ✖ ${n.name}: ${n.error}`); continue; }
      console.log(`   · ${n.name}  ${n.before} → ${n.after} 条交互`);
    }
    break;
  }

  case 'styles': {
    await requirePlugin();
    const { json, status } = await api('/cmd', { cmd: 'styles' }, 60_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    const d = json.data;
    const show = (title, items) => {
      console.log(`${title}（${items.length}）`);
      items.forEach((s) => console.log(`   · ${s.name}   ${s.id}`));
    };
    console.log(`文件「${d.file}」的本地样式：`);
    show('  文本样式', d.text);
    show('  颜色样式', d.paint);
    show('  效果样式', d.effect);
    console.log(`  ${d.note}`);
    break;
  }

  case 'rm': {
    await requirePlugin();
    const payload = { ...selectorPayload(), dryRun: flag('dry') === true };
    if (!hasSelectorFlag(payload)) die(SELECTOR_HINT);
    const { json, status } = await api('/cmd', { cmd: 'remove', payload }, 180_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    console.log(`${json.data.dryRun ? '（dry-run，未删除）将删除' : '✔ 已删除'} ${json.data.count} 个节点`);
    json.data.removed.slice(0, 20).forEach((n) => console.log(`   · ${n.type} ${n.name}  #${n.id}`));
    if (json.data.removed.length > 20) console.log(`   … 还有 ${json.data.removed.length - 20} 个`);
    break;
  }

  /* ============ 结构操作：顺序 / 复制 / 成组 ============ */

  case 'move': {
    await requirePlugin();
    const payload = { ...selectorPayload(), ...parentPayload(), dryRun: flag('dry') === true };
    if (flag('index')) payload.index = Number(flag('index'));
    if (!hasSelectorFlag(payload)) die(SELECTOR_HINT);
    if (payload.parentId == null && payload.parentName == null && payload.index == null) {
      die('请指定目标位置：--to <父容器id> 或 --index <序号>（0 = 最前/最底层）');
    }
    const { json, status } = await api('/cmd', { cmd: 'move', payload }, 180_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    console.log(`${payload.dryRun ? '（dry-run，未移动）' : '✔ 已处理'} ${json.data.count} 个节点`);
    for (const m of json.data.moved) {
      if (m.error) { console.log(`   ✖ ${m.name}: ${m.error}`); continue; }
      const from = m.from ? `「${m.from.name}」[${m.fromIndex}]` : '?';
      console.log(`   · ${m.type} ${m.name}  ${from} → 「${m.to.name}」[${m.index}]`);
    }
    break;
  }

  case 'dup': {
    await requirePlugin();
    const payload = { ...selectorPayload(), ...parentPayload(), dryRun: flag('dry') === true };
    if (flag('count')) payload.count = Number(flag('count'));
    if (flag('index')) payload.index = Number(flag('index'));
    if (flag('dx')) payload.dx = Number(flag('dx'));
    if (flag('dy')) payload.dy = Number(flag('dy'));
    // 注意：--name 是「选择谁」，给副本改名用的是 --rename（两个不同的键）
    if (flag('rename')) payload.rename = String(flag('rename'));
    if (!hasSelectorFlag(payload)) die(SELECTOR_HINT);
    const { json, status } = await api('/cmd', { cmd: 'dup', payload }, 180_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    console.log(`${payload.dryRun ? '（dry-run，未复制）' : '✔ 已复制'} ${json.data.count} 个节点`);
    json.data.created.slice(0, 20).forEach((n) => {
      if (n.error) return console.log(`   ✖ ${n.name}: ${n.error}`);
      // dry-run 时没有新 id，只有源 id —— 不要伪造成副本 id
      if (n.note) return console.log(`   · ${n.type} ${n.name}  （复制自 ${n.of}，源 #${n.sourceId}）`);
      console.log(`   · ${n.type} ${n.name}  #${n.id}  （复制自 ${n.of}）`);
    });
    if (json.data.created.length > 20) console.log(`   … 还有 ${json.data.created.length - 20} 个`);
    break;
  }

  case 'group': {
    await requirePlugin();
    const payload = { ...selectorPayload(), dryRun: flag('dry') === true };
    if (flag('index')) payload.index = Number(flag('index'));
    if (flag('rename')) payload.rename = String(flag('rename'));
    if (!hasSelectorFlag(payload)) die(SELECTOR_HINT);
    const { json, status } = await api('/cmd', { cmd: 'group', payload }, 180_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    console.log(`${payload.dryRun ? '（dry-run，未成组）' : '✔'} 已把 ${json.data.count} 个节点收进「${json.data.group.name}」`
      + `  #${json.data.group.id}  (${json.data.group.w}×${json.data.group.h})`);
    break;
  }

  case 'ungroup': {
    await requirePlugin();
    const payload = { ...selectorPayload(), dryRun: flag('dry') === true };
    if (!hasSelectorFlag(payload)) die(SELECTOR_HINT);
    const { json, status } = await api('/cmd', { cmd: 'ungroup', payload }, 180_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    console.log(`✔ 已处理 ${json.data.count} 个节点`);
    for (const g of json.data.groups) {
      if (g.error) { console.log(`   ✖ ${g.name}: ${g.error}`); continue; }
      console.log(`   · ${g.type} ${g.name}  → 释放 ${g.released} 个子节点`);
      (g.children || []).slice(0, 10).forEach((c) => console.log(`       · ${c.type} ${c.name}  #${c.id}`));
    }
    break;
  }

  case 'sel': {
    await requirePlugin();
    const payload = {};
    if (flag('ids')) payload.ids = String(flag('ids')).split(',').map((s) => s.trim());
    if (flag('id')) payload.ids = [String(flag('id'))];
    const { json, status } = await api('/cmd', { cmd: 'selection', payload }, 180_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    if (json.data.action === 'set') {
      console.log(`✔ 已选中 ${json.data.selected.length} 个节点`);
      json.data.selected.forEach((n) => console.log(`   · ${n.type} ${n.name}  #${n.id}`));
    } else {
      console.log(`当前选中 ${json.data.count} 个节点（页面「${json.data.page}」）：`);
      console.log(JSON.stringify(json.data.nodes, null, 1));
    }
    break;
  }

  case 'page': {
    await requirePlugin();
    // 位置参数：第一个非 --flag 的 token 就是 action
    const action = rest.find((a) => !a.startsWith('--')) || 'list';
    const payload = { action };
    if (flag('name')) payload.name = String(flag('name'));
    if (flag('to')) payload.to = String(flag('to'));
    if (flag('copy') || flag('copy-from')) payload.copyFrom = String(flag('copy') || flag('copy-from'));
    if (flag('force') === true) payload.force = true;
    if (flag('confirm') === true) payload.confirm = true;
    if (flag('no-top') === true) payload.top = false;
    const { json, status } = await api('/cmd', { cmd: 'page', payload }, 60_000);
    if (status !== 200 || !json.ok) die(json.error || `HTTP ${status}`);
    const d = json.data;
    if (action === 'list') {
      console.log(`当前页: ${d.current}`);
      d.pages.forEach((p) => {
        const tag = p.kind === 'beta' ? `  [beta.${p.rev}]` : '  [release]';
        console.log(`  ${String(p.index).padStart(2)}. ${p.name}${tag}  ${p.nodes} 个顶层节点`);
      });
    } else if (action === 'create') {
      console.log(`✔ 已创建页面「${d.name}」（index ${d.index}${d.copiedFrom ? `，内容复制自「${d.copiedFrom}」` : ''}）`);
    } else if (action === 'rename') {
      console.log(`✔ 已重命名: 「${d.from}」 → 「${d.to}」`);
    } else if (action === 'delete') {
      console.log(d.deleted ? `✔ 已删除页面「${d.name}」（${d.removedNodes} 个顶层节点）` : `· ${d.note}`);
    } else if (action === 'promote') {
      console.log(`✔ 已发布: 「${d.from}」 → 「${d.to}」`);
    }
    break;
  }

  default:
    console.log(`用法: node tools/figma.mjs <命令> [选项]

目标页面（所有读写命令通用）
  --page 名称            指定页面；不指定则用 Figma 的「当前页」
  DSH_FIGMA_PAGE=名称    等价于一直带 --page
  ⚠ 读操作（stats/list/dump）绝不会新建页面；render 只在显式给页名时才新建。

读取与定位
  status                 桥与插件状态（含渲染进度）
  ping                   与插件握手
  page   list | create --name X [--copy 源页] [--no-top] [--force]
         | rename --name X --to Y | delete --name X --confirm
         | promote --name X [--to 发布名] [--force]
                        页面管理（迭代工作流，见 docs/WORKFLOW.md）
                        命名规范: release=YYYY-MM-DD-主题  beta=YYYY-MM-DD-主题-beta.N
                        新页面默认插到文档最上方
  stats   [--page 名称]  顶层 Frame 与节点总数（默认统计当前页）
  list   --depth 6       树状大纲（快速定位）
  sel    [--ids a,b]     读当前选区；给了 --ids 则改为设置选区
  styles                 列出本文件的本地样式（文本/颜色/效果），用于按名字应用
  dump   [--id X | --ids a,b | --name 通配 | --text 文案 | --type FRAME | --sel]
         --depth 8 --max 4000 --out dumps/x.json
                        把节点树读成 SPEC_DSL 同构的 JSON（带 id，可直接构造 patch）
  patch  --ops ops.json [--dry] [--within 容器id]
                        按 id/name/text/type 批量改属性；--within 给整批加默认范围
         ⚠ op 必须带选择器；要全量修改需在 op 里显式写 "all": true
  move   <选择器> --to <父容器id> [--index n] [--dry]  改顺序 / 跨容器搬移
         --index 0 = 最前（auto-layout）/ 最底层（普通容器）；不给则放末尾
  dup    <选择器> [--count n] [--to id] [--index n] [--dx d --dy d] [--rename 名称] [--dry]
                        复制节点（含整棵子树）
  group  <选择器> [--rename 名称] [--index n] [--dry]   收进一个 GROUP（须同父容器）
  ungroup <选择器> [--dry]                        解组，子节点原地保留

组件与实例
  component <选择器> [--rename 名称] [--dry]      把 FRAME/GROUP 原地转成 COMPONENT
  instance  --of <组件id> | --of-name <组件名> [--parent <id>] [--count n]
            [--index n] [--x n --y n] [--rename 名称] [--dry]
                                                  放置组件实例（非 auto-layout 容器里可定位）
  swap   <选择器> --to <组件id> | --to-name <组件名>     换实例的主组件
  detach <选择器> [--dry]                         脱离组件（实例 → 普通 FRAME）

原型交互
  reactions <选择器>                读交互（目标解析成名字）
  link      <选择器> --to <节点id> | --to-name <名称> | --url <网址>
            [--trigger ON_CLICK|ON_HOVER|ON_PRESS|ON_DRAG|AFTER_TIMEOUT|MOUSE_ENTER|…]
            [--nav NAVIGATE|SWAP|OVERLAY|SCROLL_TO|CHANGE_TO]
            [--transition SMART_ANIMATE|DISSOLVE|INSTANT|MOVE_IN|MOVE_OUT|PUSH|SLIDE_IN|SLIDE_OUT]
            [--duration 秒] [--easing EASE_OUT] [--timeout 秒]
            [--append] [--clear] [--dry]
                                  建 / 追加 / 清空交互（默认替换该节点原有交互）
         ⚠ 这里的 --to 是「连到哪个节点」；move/dup/instance 的 --to 是「放进哪个容器」
  insert [spec.json] [--frame 名称] --parent <id> | --parent-name <名称> [--index n] [--dry]
                                    往现有容器里插入新节点；--dry 只报计划不创建
  rm     --id X | --ids a,b | --name 通配 | --text 文案 | --type FRAME  [--dry]
                                    删除节点（超过 200 个需 force）
         --type 同时认 DSL 名与 Figma 名（RECT 与 RECTANGLE 等价）
         --within <容器id>  把搜索限定在该容器子树内（同名图层多时必用）

渲染与导出
  render [spec.json] [--clear] [--page 名称]
                        渲染规格；**默认不清空页面**，--clear 才清空
                        默认渲染到当前页；--page 指定的页面不存在时才新建
  export --all | --names "A,B" [--scale 2] [--prefix shot] [--page 名称]
                        导出当前页（或 --page 指定页）的顶层 Frame 截图
  clear  [--page 名称] --yes        清空页面（危险，必须 --yes）`);
}

/** insert --frame 用的简单通配匹配 */
function matchAny(name, pattern) {
  if (pattern.includes('*')) {
    const rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return rx.test(name);
  }
  return name === pattern;
}
