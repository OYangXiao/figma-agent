/* =============================================================================
 * FIMG Agent Plugin — Figma 插件主线程
 * -----------------------------------------------------------------------------
 * 职责：接收声明式 JSON 规格，转换成真实的 Figma 节点树（Frame / Auto Layout /
 *       Text / Rect / Ellipse），并支持把结果导出 PNG 回传给本地桥。
 * 运行环境是 Figma 的插件沙箱（无 DOM、无 fetch），所以网络部分全在 ui.html。
 * ========================================================================== */

const VERSION = '1.5.1';
// 默认页名。null = 跟随 Figma 的「当前页」。
//
// 为什么不再硬编码一个页名：在「在用户现有稿上迭代」模式下，当前页才是唯一
// 正确的目标。硬编码会让 stats 报「未找到页面」，更糟的是让 render 悄悄新建
// 一个空页——用户以为渲染到了自己的稿子上，其实画在了别处。
// 需要固定页面时显式传 pageName（CLI 的 --page / 环境变量 DSH_FIGMA_PAGE）。
const PAGE_NAME_DEFAULT = null;

figma.showUI(__html__, { width: 340, height: 470, themeColors: true });

/* ------------------------------------------------------------------ 字体处理 */

const WEIGHT_STYLE = {
  100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular',
  500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black',
};
const FALLBACK_FAMILIES = ['PingFang SC', 'Inter', 'Helvetica Neue', 'Arial', 'Roboto'];
const fontCache = new Map();
const fontMiss = new Set();

function styleCandidates(weight, italic) {
  const raw = String(weight ?? 400);
  const base = WEIGHT_STYLE[parseInt(raw, 10)] || (WEIGHT_STYLE[raw] || 'Regular');
  const alt = base.replace('SemiBold', 'Semi Bold').replace('ExtraBold', 'Extra Bold')
    .replace('ExtraLight', 'Extra Light');
  const out = italic ? [`${base} Italic`, `${alt} Italic`] : [];
  return [...out, base, alt, 'Regular'].filter((s, i, a) => a.indexOf(s) === i);
}

async function resolveFont(family, weight, italic) {
  const families = family ? [family, ...FALLBACK_FAMILIES] : FALLBACK_FAMILIES;
  for (const fam of families) {
    for (const style of styleCandidates(weight, italic)) {
      const key = `${fam}|${style}`;
      if (fontCache.has(key)) return fontCache.get(key);
      if (fontMiss.has(key)) continue;
      try {
        const font = { family: fam, style };
        await figma.loadFontAsync(font);
        fontCache.set(key, font);
        return font;
      } catch (e) {
        fontMiss.add(key);
      }
    }
  }
  // 最后兜底：Inter Regular 在任何环境都应该存在
  const safe = { family: 'Inter', style: 'Regular' };
  await figma.loadFontAsync(safe);
  return safe;
}

/* ------------------------------------------------------------------ 颜色处理 */

const NAMED = {
  transparent: '#00000000', white: '#FFFFFF', black: '#000000',
};

function hexToRgba(input) {
  let v = String(input).trim();
  if (NAMED[v.toLowerCase()]) v = NAMED[v.toLowerCase()];
  if (v[0] === '#') v = v.slice(1);
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  if (v.length === 4) v = v.split('').map((c) => c + c).join('');
  if (v.length === 6) v += 'FF';
  if (v.length !== 8) return { color: { r: 0, g: 0, b: 0 }, opacity: 1 };
  const n = parseInt(v, 16);
  return {
    color: {
      r: ((n >>> 24) & 255) / 255,
      g: ((n >>> 16) & 255) / 255,
      b: ((n >>> 8) & 255) / 255,
    },
    opacity: (n & 255) / 255,
  };
}

/** 把规格里的 fill/stroke 值转成 Figma Paint */
function toPaint(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const { color, opacity } = hexToRgba(v);
    return { type: 'SOLID', color, opacity };
  }
  if (Array.isArray(v)) return null; // 数组在 paints() 里展开
  // 图片填充，两种写法：
  //   ① 复用画布上已有的图片 —— 正是 dump 读出来的形态，所以能直接回写
  //      { image: true, imageHash: "…", scaleMode: "FILL" }
  //   ② 塞一张新图片（base64 或 dataURI）
  //      { image: "<base64>", scaleMode: "FILL" }
  if (v.imageHash) {
    return { type: 'IMAGE', imageHash: String(v.imageHash), scaleMode: v.scaleMode || 'FILL' };
  }
  if (typeof v.image === 'string') {
    const b64 = v.image.replace(/^data:[^;]*;base64,/, '');
    try {
      const img = figma.createImage(figma.base64Decode(b64));
      return { type: 'IMAGE', imageHash: img.hash, scaleMode: v.scaleMode || 'FILL' };
    } catch (e) {
      return null;   // 图片数据坏了就当没填，别把整个 patch 打断
    }
  }
  if (v.gradient) {
    const stops = (v.stops || []).map(([pos, col]) => {
      const { color, opacity } = hexToRgba(col);
      return { position: pos, color: { ...color, a: opacity } };
    });
    const angle = ((v.angle ?? 180) * Math.PI) / 180;
    const handles = v.handles || [
      { x: 0.5 - Math.cos(angle) / 2, y: 0.5 - Math.sin(angle) / 2 },
      { x: 0.5 + Math.cos(angle) / 2, y: 0.5 + Math.sin(angle) / 2 },
    ];
    return {
      type: 'GRADIENT_LINEAR',
      gradientTransform: [
        [handles[1].x - handles[0].x, handles[1].y - handles[0].y, handles[0].x],
        [-(handles[1].y - handles[0].y), handles[1].x - handles[0].x, handles[0].y],
      ],
      gradientStops: stops,
    };
  }
  if (v.color) return toPaint(v.color);
  return null;
}

function paints(v) {
  if (v == null) return [];
  if (Array.isArray(v)) {
    const out = [];
    for (const item of v) out.push(...paints(item));
    return out;
  }
  const p = toPaint(v);
  return p ? [p] : [];
}

/**
 * dump 读出的 effects 数组 → Figma 的 Effect 对象。
 *
 * 读的时候颜色被转成了 hex（`#RRGGBBAA`），写回来必须能还原，
 * 否则「dump 出来直接回写」对阴影/模糊又是假的（同 P21 那类不对称）。
 *
 * 支持：DROP_SHADOW / INNER_SHADOW（color/offset/radius/spread）、
 *       LAYER_BLUR / BACKGROUND_BLUR（radius）。
 */
function toEffects(v) {
  if (v == null) return [];
  const list = Array.isArray(v) ? v : [v];
  const out = [];
  for (const e of list) {
    if (!e || !e.type) continue;
    const t = String(e.type).toUpperCase();
    if (t === 'LAYER_BLUR' || t === 'BACKGROUND_BLUR') {
      out.push({ type: t, radius: Number(e.radius ?? 8), visible: e.visible !== false });
      continue;
    }
    if (t === 'DROP_SHADOW' || t === 'INNER_SHADOW') {
      const { color, opacity } = hexToRgba(e.color || '#00000040');
      out.push({
        type: t,
        color: { ...color, a: opacity },
        offset: { x: Number(e.offset?.x ?? 0), y: Number(e.offset?.y ?? 4) },
        radius: Number(e.radius ?? 12),
        spread: Number(e.spread ?? 0),
        visible: e.visible !== false,
        blendMode: e.blendMode || 'NORMAL',
      });
    }
  }
  return out;
}

/** effects 的审计摘要：只报类型，避免把整个对象塞进 JSON */
const effectSummary = (arr) => (arr || []).map((e) => e.type).join('+') || '无';

/* ------------------------------------------------------------------ 样式 */

/**
 * 本文件的局部样式缓存。
 *
 * 用途有两个方向，必须成对：
 *   · dump  把节点上的 textStyleId 等翻译成人看得懂的名字
 *   · patch 让人按名字（或 id）把样式应用回去
 *
 * 只认**本地样式**（`getLocal*StylesAsync`）。库里同步下来的远程样式不在其中——
 * 那种要用 `figma.importStyleByKeyAsync`，属于另一个能力，先不做。
 */
let _styleCache = null;

async function styleCache() {
  if (_styleCache) return _styleCache;
  const load = async (fn) => {
    const byId = new Map();     // id → name
    const byName = new Map();   // name → id
    try {
      for (const s of await fn()) { byId.set(s.id, s.name); byName.set(s.name, s.id); }
    } catch (e) { /* 某些环境没有这类样式，忽略 */ }
    return { byId, byName };
  };
  _styleCache = {
    text: await load(() => figma.getLocalTextStylesAsync()),
    paint: await load(() => figma.getLocalPaintStylesAsync()),
    effect: await load(() => figma.getLocalEffectStylesAsync()),
  };
  return _styleCache;
}

/** 让缓存失效（同一会话里新建了样式时要调） */
function invalidateStyleCache() { _styleCache = null; }

/* --------------------------------------------------------------- 通用属性设置 */

function applyCorner(node, r) {
  if (r == null || !('cornerRadius' in node)) return;
  try {
    if (Array.isArray(r)) {
      node.topLeftRadius = r[0] ?? 0;
      node.topRightRadius = r[1] ?? r[0] ?? 0;
      node.bottomRightRadius = r[2] ?? r[0] ?? 0;
      node.bottomLeftRadius = r[3] ?? r[1] ?? r[0] ?? 0;
    } else if (typeof r === 'number') {
      node.cornerRadius = r;
    }
  } catch (e) { /* 某些节点不支持圆角 */ }
}

function applyStroke(node, spec) {
  const stroke = spec.stroke ?? spec.border;
  if (stroke == null) return;
  try {
    node.strokes = paints(stroke);
    node.strokeWeight = spec.strokeWeight ?? spec.borderWidth ?? 1;
    node.strokeAlign = spec.strokeAlign || 'INSIDE';
    if (spec.dash) node.dashPattern = spec.dash;
  } catch (e) { /* ignore */ }
}

function applyEffects(node, spec) {
  const sh = spec.shadow;
  if (!sh || sh === 'none') return;
  const s = sh === true ? {} : sh;
  try {
    node.effects = [{
      type: 'DROP_SHADOW',
      color: { ...hexToRgba(s.color || '#0000001A').color, a: hexToRgba(s.color || '#0000001A').opacity },
      offset: { x: s.x ?? 0, y: s.y ?? 4 },
      radius: s.blur ?? 12,
      spread: s.spread ?? 0,
      visible: true,
      blendMode: 'NORMAL',
    }];
  } catch (e) { /* ignore */ }
}

function normLayout(l) {
  if (l == null || l === false || l === 'NONE') return null;
  const v = String(l).toUpperCase();
  if (v === 'V' || v === 'VERTICAL' || v === 'COLUMN' || v === 'COL') return 'VERTICAL';
  if (v === 'H' || v === 'HORIZONTAL' || v === 'ROW') return 'HORIZONTAL';
  return null;
}

function applyPadding(node, pad) {
  if (pad == null) return;
  if (typeof pad === 'number') {
    node.paddingTop = node.paddingRight = node.paddingBottom = node.paddingLeft = pad;
  } else if (Array.isArray(pad)) {
    if (pad.length === 2) {
      node.paddingTop = node.paddingBottom = pad[0];
      node.paddingLeft = node.paddingRight = pad[1];
    } else if (pad.length === 4) {
      [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft] = pad;
    }
  } else if (typeof pad === 'object') {
    node.paddingTop = pad.t ?? pad.y ?? 0;
    node.paddingRight = pad.r ?? pad.x ?? 0;
    node.paddingBottom = pad.b ?? pad.y ?? 0;
    node.paddingLeft = pad.l ?? pad.x ?? 0;
  }
}

const isAuto = (n) => n && 'layoutMode' in n && n.layoutMode !== 'NONE';

function setSizing(node, axis, mode) {
  try {
    if (axis === 'H') node.layoutSizingHorizontal = mode;
    else node.layoutSizingVertical = mode;
  } catch (e) { /* 非 auto-layout 子节点会抛错 */ }
}

/** 节点挂到父级之后，按父级布局方式决定尺寸行为 */
function applyLayoutChild(node, spec, parent) {
  const absolute = spec.positioning === 'ABSOLUTE' || spec.absolute === true;

  if (!isAuto(parent)) {
    if (typeof spec.x === 'number') node.x = spec.x;
    if (typeof spec.y === 'number') node.y = spec.y;
    return;
  }

  // 绝对定位：脱离 auto-layout 的布局流，用 x/y 把节点**叠**在父容器上。
  // 用途：底部渐变遮罩、角标、浮动按钮这类覆盖层。
  // 注意：绝对定位的子节点不参与 fill/grow 的空间分配，尺寸由 w/h 决定。
  if (absolute) {
    if ('layoutPositioning' in node) {
      try { node.layoutPositioning = 'ABSOLUTE'; } catch (e) { /* 不支持就退化成普通子节点 */ }
    }
    // 转成绝对定位后重新落一次尺寸：appendChild 到 auto-layout 容器时，
    // 子节点的尺寸可能已经被布局改写过了（createNode 里那次 resize 可能不算数）。
    if (typeof spec.w === 'number' && typeof spec.h === 'number' && typeof node.resize === 'function') {
      try { node.resize(spec.w, spec.h); } catch (e) { /* ignore */ }
    }
    if (typeof spec.x === 'number') { try { node.x = spec.x; } catch (e) { /* ignore */ } }
    if (typeof spec.y === 'number') { try { node.y = spec.y; } catch (e) { /* ignore */ } }
    return;
  }

  if (spec.w === 'fill') setSizing(node, 'H', 'FILL');
  else if (spec.w === 'hug') setSizing(node, 'H', 'HUG');
  if (spec.h === 'fill') setSizing(node, 'V', 'FILL');
  else if (spec.h === 'hug') setSizing(node, 'V', 'HUG');
  if (spec.grow) { try { node.layoutGrow = spec.grow; } catch (e) {} }
  if (spec.stretch) { try { node.layoutAlign = 'STRETCH'; } catch (e) {} }
}

/** auto-layout 容器在子节点都进去之后，才能确定自身 HUG/FIXED */
function finalizeAuto(node, spec) {
  if (typeof spec.w === 'number') { setSizing(node, 'H', 'FIXED'); try { node.resize(spec.w, node.height); } catch (e) {} }
  else if (spec.w === 'hug') setSizing(node, 'H', 'HUG');
  else if (spec.w === 'fill') setSizing(node, 'H', 'FILL');
  else setSizing(node, 'H', 'HUG');

  if (typeof spec.h === 'number') { setSizing(node, 'V', 'FIXED'); try { node.resize(node.width, spec.h); } catch (e) {} }
  else if (spec.h === 'hug') setSizing(node, 'V', 'HUG');
  else if (spec.h === 'fill') setSizing(node, 'V', 'FILL');
  else setSizing(node, 'V', 'HUG');
}

/* ------------------------------------------------------------------ 节点创建 */

async function createNode(spec, tick) {
  const node = await createNodeInner(spec);
  // Figma 的 rotation 正值是逆时针，而屏幕坐标 y 向下，
  // 所以规格里用「顺时针角度」更直觉：rotate: 45 => 顺时针 45°。
  if (spec.rotate && 'rotation' in node) {
    try { node.rotation = -spec.rotate; } catch (e) { /* ignore */ }
  }
  if (tick) await tick();
  return node;
}

async function createNodeInner(spec) {
  const type = String(spec.type || 'FRAME').toUpperCase();

  if (type === 'TEXT') {
    const t = figma.createText();
    const font = await resolveFont(spec.font, spec.weight ?? spec.fontWeight, spec.italic);
    t.fontName = font;
    t.characters = String(spec.text ?? spec.characters ?? '');
    t.fontSize = spec.size ?? spec.fontSize ?? 14;
    if (spec.lineHeight != null) {
      t.lineHeight = typeof spec.lineHeight === 'number'
        ? { unit: 'PIXELS', value: spec.lineHeight }
        : spec.lineHeight;
    }
    if (spec.letterSpacing != null) {
      t.letterSpacing = typeof spec.letterSpacing === 'number'
        ? { unit: 'PIXELS', value: spec.letterSpacing }
        : spec.letterSpacing;
    }
    const f = spec.fill ?? spec.color ?? '#111111';
    t.fills = paints(f);
    t.textAlignHorizontal = spec.align || 'LEFT';
    t.textAlignVertical = spec.valign || 'TOP';
    if (spec.name) t.name = spec.name;

    const numW = typeof spec.w === 'number';
    const numH = typeof spec.h === 'number';
    if (numW && numH) {
      t.textAutoResize = 'NONE';
      t.resize(spec.w, spec.h);
    } else if (numW) {
      t.textAutoResize = 'HEIGHT';
      t.resize(spec.w, t.height);
    } else if (numH) {
      t.textAutoResize = 'NONE';
      t.resize(t.width, spec.h);
    } else {
      t.textAutoResize = 'WIDTH_AND_HEIGHT';
    }
    return t;
  }

  if (type === 'RECT' || type === 'ELLIPSE') {
    const n = type === 'RECT' ? figma.createRectangle() : figma.createEllipse();
    n.name = spec.name || type;
    n.fills = spec.fill === null ? [] : paints(spec.fill ?? spec.color ?? '#D9D9D9');
    applyCorner(n, spec.radius);
    applyStroke(n, spec);
    applyEffects(n, spec);
    if (spec.opacity != null) n.opacity = spec.opacity;
    if (typeof spec.w === 'number' && typeof spec.h === 'number') n.resize(spec.w, spec.h);
    else if (typeof spec.w === 'number') n.resize(spec.w, n.height);
    else if (typeof spec.h === 'number') n.resize(n.width, spec.h);
    return n;
  }

  if (type === 'LINE') {
    const n = figma.createLine();
    n.name = spec.name || 'Line';
    n.strokes = paints(spec.stroke ?? spec.fill ?? '#E5E5E5');
    n.strokeWeight = spec.strokeWeight ?? 1;
    const len = typeof spec.w === 'number' ? spec.w : 100;
    n.resize(len, 0);
    return n;
  }

  // 默认 FRAME
  const f = figma.createFrame();
  f.name = spec.name || 'Frame';
  f.clipsContent = spec.clip !== false;
  f.fills = spec.fill === null ? [] : paints(spec.fill ?? spec.bg ?? '#FFFFFF');
  applyCorner(f, spec.radius);
  applyStroke(f, spec);
  applyEffects(f, spec);
  if (spec.opacity != null) f.opacity = spec.opacity;

  const layout = normLayout(spec.layout);
  if (layout) {
    f.layoutMode = layout;
    applyPadding(f, spec.pad ?? spec.padding);
    f.itemSpacing = spec.gap ?? 0;
    f.primaryAxisAlignItems = spec.main || 'MIN';
    f.counterAxisAlignItems = spec.cross || 'MIN';
    if (spec.wrap) {
      try { f.layoutWrap = 'WRAP'; f.counterAxisSpacing = spec.gap ?? 0; } catch (e) {}
    }
  } else if (typeof spec.w === 'number' && typeof spec.h === 'number') {
    f.resize(spec.w, spec.h);
  } else if (typeof spec.w === 'number') {
    f.resize(spec.w, f.height);
  } else if (typeof spec.h === 'number') {
    f.resize(f.width, spec.h);
  }
  return f;
}

/** 递归构建，并保证「挂载 → 子级尺寸 → 自身尺寸」的正确顺序 */
async function build(spec, parent, tick) {
  const node = await createNode(spec, tick);
  if (parent) parent.appendChild(node);
  applyLayoutChild(node, spec, parent);
  for (const child of spec.children || []) {
    await build(child, node, tick);
  }
  if (isAuto(node)) finalizeAuto(node, spec);
  return node;
}

/* --------------------------------------------------------------------- 指令 */

/**
 * 解析目标页面。
 *   · 没给页名 → 当前页（**绝不新建**）
 *   · 给了页名 → 找到就用；找不到时由 create 决定是否新建
 *
 * 读操作（stats / dump / list / clear）一律 create:false，避免「只是想看一眼」
 * 却凭空多出一个页面。只有 render 在显式给了页名时才允许新建。
 */
async function resolvePage(name, { create = false } = {}) {
  await figma.loadAllPagesAsync();
  if (!name) return figma.currentPage;
  const found = figma.root.children.find((p) => p.name === name);
  if (found) return found;
  if (!create) return null;
  const page = figma.createPage();
  page.name = name;
  return page;
}

/** render 用：解析页面并切过去。显式给了页名才允许新建。 */
async function getPage(name) {
  const page = await resolvePage(name, { create: !!name });
  if (!page) throw new Error(`找不到页面「${name}」`);
  if (typeof figma.setCurrentPageAsync === 'function') await figma.setCurrentPageAsync(page);
  else figma.currentPage = page;
  return page;
}

function findByName(root, name) {
  const queue = [...root.children];
  while (queue.length) {
    const n = queue.shift();
    if (n.name === name) return n;
    if ('children' in n) queue.push(...n.children);
  }
  return null;
}

async function cmdRender(p = {}) {
  const spec = p.spec || {};
  const pageName = p.pageName || spec.page || PAGE_NAME_DEFAULT;
  const page = await getPage(pageName);

  // 默认**不清空**：在现有设计稿上迭代时，误清空代价太大。
  // 需要清空必须显式传 clear:true。
  if (p.clear === true) {
    for (const child of [...page.children]) child.remove();
  }

  let done = 0;
  // 插件主线程是单线程的：长时间不让出事件循环会冻住整个 Figma。
  // 每 80 个节点让出一次，并把进度发给 UI 转发到桥。
  const tick = async () => {
    done++;
    if (done % 80 === 0) {
      figma.ui.postMessage({ type: 'progress', cmd: 'render', done });
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  const frames = spec.frames || (spec.root ? [spec.root] : []);
  const created = [];
  for (const frameSpec of frames) {
    const node = await build(frameSpec, page, tick);
    created.push(node.name);
  }

  if (page.children.length) figma.viewport.scrollAndZoomIntoView(page.children);
  return { page: page.name, frames: created, total: page.children.length, nodes: done };
}

/** 画布现状：用来查证渲染到底完成了多少节点 */
async function cmdStats(p = {}) {
  await figma.loadAllPagesAsync();
  const count = (n) => 1 + ('children' in n
    ? n.children.reduce((a, c) => a + count(c), 0) : 0);
  const describe = (page) => ({
    page: page.name,
    topLevel: page.children.map((n) => n.name),
    totalNodes: page.children.reduce((a, c) => a + count(c), 0),
  });
  // 不给页名就报告「当前页」——这正是用户此刻在看的画布。
  const page = p.pageName
    ? figma.root.children.find((x) => x.name === p.pageName) || null
    : figma.currentPage;
  return {
    currentPage: figma.currentPage.name,
    pages: figma.root.children.map((p2) => p2.name),
    pageName: page ? page.name : (p.pageName ?? null),
    target: page ? describe(page) : null,
    note: page ? undefined : `未找到页面「${p.pageName}」`,
  };
}

async function cmdExport(p = {}) {
  await figma.loadAllPagesAsync();
  const page = p.pageName
    ? figma.root.children.find((x) => x.name === p.pageName) || figma.currentPage
    : figma.currentPage;

  let targets = [];
  if (p.all || !(p.names || []).length) {
    targets = page.children.filter((n) => n.type === 'FRAME');
  } else {
    for (const name of p.names) {
      const n = findByName(page, name);
      if (n) targets.push(n);
    }
  }
  if (!targets.length) throw new Error(`未找到可导出的节点（页面「${page.name}」）`);

  const files = [];
  for (const n of targets) {
    const bytes = await n.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: p.scale || 2 },
    });
    files.push({ name: n.name, base64: figma.base64Encode(bytes) });
  }
  return { files, count: files.length };
}

async function cmdClear(p = {}) {
  // 绝不新建页面：清空一个「本来不存在、刚被创建出来的空页」毫无意义，
  // 而如果页名拼错，用户会误以为自己的稿子被清空了。
  const page = await resolvePage(p.pageName, { create: false });
  if (!page) return { page: p.pageName, removed: 0, note: 'page 不存在' };
  const n = page.children.length;
  for (const child of [...page.children]) child.remove();
  return { page: page.name, removed: n };
}

async function cmdFocus(p = {}) {
  await figma.loadAllPagesAsync();
  const page = p.pageName
    ? figma.root.children.find((x) => x.name === p.pageName) || figma.currentPage
    : figma.currentPage;
  // 必须先切到目标页，否则在非当前页的节点上设置 selection 会抛错
  if (typeof figma.setCurrentPageAsync === 'function') await figma.setCurrentPageAsync(page);
  else figma.currentPage = page;
  if (p.name) {
    const n = findByName(page, p.name);
    if (!n) throw new Error(`找不到节点 ${p.name}`);
    figma.currentPage.selection = [n];
    figma.viewport.scrollAndZoomIntoView([n]);
    return { focused: n.name, id: n.id };
  }
  figma.viewport.scrollAndZoomIntoView(page.children);
  return { focused: page.name, count: page.children.length };
}

async function cmdPing() {
  await figma.loadAllPagesAsync();
  return {
    version: VERSION,
    file: figma.root.name,
    page: figma.currentPage.name,
    pages: figma.root.children.map((p) => p.name),
    editorType: figma.editorType,
  };
}

/* ======================================================================
 * 页面管理 —— 迭代工作流的基础能力
 * ----------------------------------------------------------------------
 * 命名规范（docs/WORKFLOW.md）：
 *   release:  YYYY-MM-DD-主题
 *   beta:     YYYY-MM-DD-主题-beta.N
 * 新页面插入到文档最上方；release 由 beta 汇总而来。
 * ==================================================================== */

/** 解析页面名里的阶段：release / beta.N / 普通 */
function parsePageName(name) {
  const beta = /^(.+)-beta\.(\d+)$/.exec(String(name));
  if (beta) return { kind: 'beta', base: beta[1], rev: Number(beta[2]) };
  return { kind: 'release', base: String(name), rev: 0 };
}

async function cmdPage(p = {}) {
  await figma.loadAllPagesAsync();
  const action = p.action || 'list';

  if (action === 'list') {
    return {
      current: figma.currentPage.name,
      pages: figma.root.children.map((pg, i) => ({
        index: i,
        id: pg.id,
        name: pg.name,
        ...parsePageName(pg.name),
        nodes: pg.children.length,
      })),
    };
  }

  if (action === 'create') {
    if (!p.name) throw new Error('缺少 name');
    const exists = figma.root.children.find((x) => x.name === p.name);
    if (exists && !p.force) throw new Error(`页面「${p.name}」已存在。确认覆盖内容请加 force:true`);
    let page = exists;
    if (!page) {
      page = figma.createPage();
      page.name = String(p.name);
    }
    // 新页面插到最上方（迭代页永远在最前，方便对照）
    if (p.top !== false) {
      try { figma.root.insertChild(0, page); } catch (e) { /* 个别宿主不支持则保留在末尾 */ }
    }
    // 从源页面复制内容（beta 从基础稿派生）
    if (p.copyFrom) {
      const src = figma.root.children.find((x) => x.name === p.copyFrom);
      if (!src) throw new Error(`找不到源页面「${p.copyFrom}」`);
      // 先清空目标页（force 覆盖场景）
      for (const c of [...page.children]) c.remove();
      // 迭代 [...src.children] 的快照：clone() 会临时把副本挂到源页上，
      // 直接 for...of src.children 会边迭代边改数组（漏拷贝）。
      for (const child of [...src.children]) {
        const clone = child.clone();
        page.appendChild(clone);
        // 长任务让出，避免冻住 Figma
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return {
      created: true,
      id: page.id,
      name: page.name,
      index: figma.root.children.indexOf(page),
      copiedFrom: p.copyFrom || null,
      nodes: page.children.length,
    };
  }

  if (action === 'rename') {
    const page = figma.root.children.find((x) => x.name === p.name);
    if (!page) throw new Error(`找不到页面「${p.name}」`);
    if (!p.to) throw new Error('缺少 to（新名称）');
    const clash = figma.root.children.find((x) => x.name === p.to && x !== page);
    if (clash) throw new Error(`目标名称「${p.to}」已被占用`);
    const from = page.name;
    page.name = String(p.to);
    return { renamed: true, from, to: page.name };
  }

  if (action === 'delete') {
    const page = figma.root.children.find((x) => x.name === p.name);
    if (!page) return { deleted: 0, note: `页面「${p.name}」不存在` };
    if (!p.confirm) throw new Error('删除页面是危险操作，需要 confirm:true');
    const n = page.children.length;
    page.remove();
    return { deleted: 1, name: p.name, removedNodes: n };
  }

  if (action === 'promote') {
    // 把某个 beta 页汇总成 release：重命名为去掉 -beta.N 的名字
    const page = figma.root.children.find((x) => x.name === p.name);
    if (!page) throw new Error(`找不到页面「${p.name}」`);
    const info = parsePageName(page.name);
    const target = p.to || info.base;
    const clash = figma.root.children.find((x) => x.name === target && x !== page);
    if (clash && !p.force) throw new Error(`release 名称「${target}」已被占用。确认替换请加 force:true`);
    if (clash) {
      // 覆盖旧 release：删掉旧页
      const nodes = clash.children.length;
      clash.remove();
      void nodes;
    }
    const from = page.name;
    page.name = target;
    // release 页插到最上方
    try { figma.root.insertChild(0, page); } catch (e) { /* ignore */ }
    return { promoted: true, from, to: target, id: page.id };
  }

  throw new Error(`未知 page action: ${action}（list / create / rename / delete / promote）`);
}

/* ======================================================================
 * 读取与就地修改 —— 「在现有设计稿上迭代」的基础能力
 * ----------------------------------------------------------------------
 * 设计原则：
 *   · 只读不猜     dump 输出的字段与 SPEC_DSL 对齐，便于直接回写
 *   · 就地修改     patch 只改指定属性，不重建节点，保留原有图层结构与命名
 *   · 可审计       每个操作都回报「匹配到几个节点、每个节点改了什么字段」
 *   · 默认不破坏   render 不再默认清空页面；remove 建议先 dryRun
 * ==================================================================== */

const RN = (n) => Math.round(n * 100) / 100;

function safeCall(fn, fallback = null) {
  try { return fn(); } catch (e) { return fallback; }
}

/** safeCall 的异步版：dynamic-page 下不少 API 只能异步取，抛错也不该炸掉整条指令 */
async function safeCallAsync(fn, fallback = null) {
  try { return await fn(); } catch (e) { return fallback; }
}

/** Figma 的 {r,g,b}(0..1) + opacity → '#RRGGBB' / '#RRGGBBAA' */
function colorToHex(c, opacity) {
  if (!c) return null;
  const h = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  const a = (opacity == null || opacity >= 1) ? '' : h(opacity);
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${a}`.toUpperCase();
}

function paintToSpec(paint) {
  if (!paint || paint.visible === false) return null;
  const t = String(paint.type || '');
  if (t === 'SOLID') return colorToHex(paint.color, paint.opacity);
  if (t.startsWith('GRADIENT_')) {
    return {
      gradient: t.replace('GRADIENT_', '').toLowerCase(),
      stops: (paint.gradientStops || []).map((s) => [RN(s.position), colorToHex(s.color, s.color.a)]),
      // 渐变角度无法简单还原（Figma 存的是变换矩阵），原样保留供参考
      transform: paint.gradientTransform,
    };
  }
  if (t === 'IMAGE') return { image: true, imageHash: paint.imageHash, scaleMode: paint.scaleMode };
  return { paintType: t };
}

/** 返回 undefined 表示「读不到」（figma.mixed）；null 表示「确实没有填充」 */
function paintsToSpec(paints) {
  if (!Array.isArray(paints)) return undefined;
  const out = paints.map(paintToSpec).filter(Boolean);
  if (!out.length) return null;
  return out.length === 1 ? out[0] : out;
}

/** 按 id 取节点（dynamic-page 下必须用 async 版本） */
async function getNode(id) {
  try {
    if (typeof figma.getNodeByIdAsync === 'function') return await figma.getNodeByIdAsync(id);
    return figma.getNodeById(id);
  } catch (e) { return null; }
}

/** 名称匹配：精确 | 含 * ? 的通配 | /正则/ */
function matchName(name, pattern) {
  if (pattern == null) return true;
  const p = String(pattern);
  if (p.length > 2 && p.startsWith('/') && p.lastIndexOf('/') > 0) {
    const end = p.lastIndexOf('/');
    try { return new RegExp(p.slice(1, end), p.slice(end + 1)).test(name); } catch (e) { /* 落到下面 */ }
  }
  if (p.includes('*') || p.includes('?')) {
    const rx = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return rx.test(name);
  }
  return name === p;
}

function allDescendants(root, out = []) {
  out.push(root);
  if ('children' in root) for (const c of root.children) allDescendants(c, out);
  return out;
}

/**
 * 把 Figma 节点序列化成与 SPEC_DSL 同构的 JSON。
 * 带 id，所以可以直接拿来构造 patch。
 */
function dumpNode(node, opt, state, depth) {
  state.count++;
  const o = { id: node.id, type: node.type, name: node.name };

  if (typeof node.x === 'number') { o.x = RN(node.x); o.y = RN(node.y); }
  if (typeof node.width === 'number') { o.w = RN(node.width); o.h = RN(node.height); }
  const bb = safeCall(() => node.absoluteBoundingBox);
  if (bb) o.abs = { x: RN(bb.x), y: RN(bb.y), w: RN(bb.width), h: RN(bb.height) };

  const fill = paintsToSpec(node.fills);
  if (fill !== undefined) o.fill = fill;
  const stroke = paintsToSpec(node.strokes);
  if (stroke) {
    o.stroke = stroke;
    if (node.strokeWeight !== figma.mixed) o.strokeWeight = node.strokeWeight;
    if (node.strokeAlign) o.strokeAlign = node.strokeAlign;
  }
  if (typeof node.cornerRadius === 'number' && node.cornerRadius !== 0) o.radius = node.cornerRadius;
  if (node.opacity !== undefined && node.opacity !== 1) o.opacity = RN(node.opacity);
  if (node.visible === false) o.visible = false;
  if (node.blendMode && node.blendMode !== 'PASS_THROUGH') o.blendMode = node.blendMode;
  if (Array.isArray(node.effects) && node.effects.length) {
    o.effects = node.effects.filter((e) => e.visible !== false).map((e) => ({
      type: e.type,
      radius: e.radius,
      spread: e.spread,
      offset: e.offset ? { x: RN(e.offset.x), y: RN(e.offset.y) } : undefined,
      color: e.color ? colorToHex(e.color, e.color.a) : undefined,
    }));
  }
  // Figma 的 rotation 是逆时针；对外统一成顺时针（与 SPEC_DSL 一致）
  if (typeof node.rotation === 'number' && node.rotation !== 0) o.rotation = RN(-node.rotation);

  if (node.layoutMode && node.layoutMode !== 'NONE') {
    o.layout = node.layoutMode === 'VERTICAL' ? 'V' : 'H';
    o.gap = RN(node.itemSpacing || 0);
    o.pad = [RN(node.paddingTop), RN(node.paddingRight), RN(node.paddingBottom), RN(node.paddingLeft)];
    o.main = node.primaryAxisAlignItems;
    o.cross = node.counterAxisAlignItems;
    if (node.layoutWrap === 'WRAP') o.wrap = true;
  }
  if ('layoutSizingHorizontal' in node) {
    o.sizing = { h: node.layoutSizingHorizontal, v: node.layoutSizingVertical };
  }
  if ('clipsContent' in node && node.clipsContent === false) o.clip = false;
  if ('layoutGrow' in node && node.layoutGrow) o.layoutGrow = node.layoutGrow;
  // 绝对定位的子节点：dump 出来要带上，否则回写/重插会丢掉覆盖层语义
  if ('layoutPositioning' in node && node.layoutPositioning === 'ABSOLUTE') o.positioning = 'ABSOLUTE';

  if (node.type === 'INSTANCE') {
    // dynamic-page 下 mainComponent 是异步的，dump 前已统一解析好放进 opt
    const mc = (opt.mainComponents && opt.mainComponents.get(node.id))
      || safeCall(() => node.mainComponent);
    if (mc) o.mainComponent = { id: mc.id, name: mc.name };
    // 可覆盖的属性（只读信息，方便知道这个实例能改什么）
    const props = safeCall(() => node.componentProperties);
    if (props && typeof props === 'object') {
      const flat = {};
      for (const [k, v] of Object.entries(props)) {
        flat[k] = (v && typeof v === 'object' && 'value' in v) ? v.value : v;
      }
      if (Object.keys(flat).length) o.componentProperties = flat;
    }
  }
  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') o.isComponent = true;

  // 原型交互。原样输出（可 JSON 序列化），所以能直接回写成 patch 的 set.reactions
  const rx = safeCall(() => node.reactions);
  if (Array.isArray(rx) && rx.length) o.reactions = rx;

  // 样式引用：dump 成 {id, name}，回写时按 id 或 name 都认
  if (opt.styles) {
    for (const [key, idKey, kind] of [
      ['textStyle', 'textStyleId', 'text'],
      ['fillStyle', 'fillStyleId', 'paint'],
      ['strokeStyle', 'strokeStyleId', 'paint'],
      ['effectStyle', 'effectStyleId', 'effect'],
    ]) {
      const sid = safeCall(() => node[idKey]);
      if (typeof sid !== 'string' || !sid) continue;
      const name = opt.styles[kind]?.byId.get(sid);
      o[key] = { id: sid, name: name ?? null };
    }
  }

  if (node.type === 'TEXT') {
    o.text = node.characters;
    const fn = node.fontName;
    if (fn && fn !== figma.mixed) { o.font = fn.family; o.fontStyle = fn.style; }
    else { o.font = 'mixed'; o.fontStyle = 'mixed'; }
    o.size = node.fontSize === figma.mixed ? 'mixed' : node.fontSize;
    o.align = node.textAlignHorizontal;
    o.valign = node.textAlignVertical;
    o.autoResize = node.textAutoResize;
    const lh = node.lineHeight;
    if (lh && lh !== figma.mixed && lh.unit !== 'AUTO') o.lineHeight = { unit: lh.unit, value: RN(lh.value) };
    const ls = node.letterSpacing;
    if (ls && ls !== figma.mixed && ls.value) o.letterSpacing = { unit: ls.unit, value: RN(ls.value) };
  }

  const kids = 'children' in node ? node.children : null;
  if (kids && kids.length) {
    if (depth + 1 > opt.maxDepth || state.count >= opt.maxNodes) {
      o.childCount = kids.length;
      o.truncated = true;
      state.truncated = true;
    } else {
      o.children = kids.map((c) => dumpNode(c, opt, state, depth + 1));
    }
  }
  return o;
}

/**
 * 节点类型归一。
 *
 * SPEC_DSL 里写 `RECT`，但 Figma 的节点类型是 `RECTANGLE` ——
 * 用户按 DSL 名字写选择器（`--type RECT`）会一个都匹配不到，
 * 而且不报错、只是"没匹配到"，非常难查。所以两边都认。
 */
const TYPE_ALIASES = {
  RECT: 'RECTANGLE',
  RECTANGLE: 'RECTANGLE',
  ELLIPSE: 'ELLIPSE',
  FRAME: 'FRAME',
  TEXT: 'TEXT',
  LINE: 'LINE',
  GROUP: 'GROUP',
  COMPONENT: 'COMPONENT',
  COMPONENT_SET: 'COMPONENT_SET',
  INSTANCE: 'INSTANCE',
  VECTOR: 'VECTOR',
  STAR: 'STAR',
  POLYGON: 'POLYGON',
  BOOLEAN_OPERATION: 'BOOLEAN_OPERATION',
  SLICE: 'SLICE',
  SECTION: 'SECTION',
};

function normType(t) {
  const v = String(t).toUpperCase();
  return TYPE_ALIASES[v] || v;
}

/**
 * 解析操作目标：id / ids / selection / name / text / type / layout（+ within 限定范围）
 *
 * `within` 把搜索限定在某个容器内。真实设计稿里同名图层遍地都是
 * （一个文件里几十个 `Frame`、`Text`），不给范围的话 name 选择器会命中一大片。
 * 注意：`within` 是**范围修饰**，本身不算选择器 —— 只有它一个条件时等于"整个子树"。
 */
async function resolveTargets(op = {}) {
  await figma.loadAllPagesAsync();
  if (op.id) { const n = await getNode(op.id); return n ? [n] : []; }
  if (Array.isArray(op.ids)) {
    const out = [];
    for (const id of op.ids) { const n = await getNode(id); if (n) out.push(n); }
    return out;
  }
  if (op.selection) return [...figma.currentPage.selection];

  const wantType = op.type ? normType(op.type) : null;
  const wantLayout = op.layout ? String(op.layout).toUpperCase() : null;
  const match = (n) => {
    if (op.name != null && !matchName(n.name, op.name)) return false;
    if (wantType && n.type !== wantType) return false;
    // 按文案内容选（图层名往往是无意义的 "Text"，按内容选才符合迭代直觉）
    if (op.text != null) {
      if (n.type !== 'TEXT' || !matchName(n.characters || '', op.text)) return false;
    }
    if (op.fontSize != null && n.fontSize !== op.fontSize) return false;
    if (wantLayout) {
      const lm = n.layoutMode === 'VERTICAL' ? 'V' : n.layoutMode === 'HORIZONTAL' ? 'H' : null;
      if (lm !== wantLayout) return false;
    }
    return true;
  };

  const out = [];
  if (op.within) {
    const root = await getNode(String(op.within));
    if (!root) return [];
    for (const n of allDescendants(root)) { if (match(n)) out.push(n); }
    return out;
  }

  const page = op.pageName
    ? figma.root.children.find((x) => x.name === op.pageName) || figma.currentPage
    : figma.currentPage;
  for (const root of page.children) {
    for (const n of allDescendants(root)) { if (match(n)) out.push(n); }
  }
  return out;
}

/** 确保节点上的字体都已加载（改文本前必须） */
async function ensureFontsLoaded(node) {
  const fn = node.fontName;
  if (fn !== figma.mixed) { await figma.loadFontAsync(fn); return; }
  const seen = new Set();
  const len = Math.min(node.characters.length, 500);
  for (let i = 0; i < len; i++) {
    const f = safeCall(() => node.getRangeFontName(i, i + 1));
    if (!f) continue;
    const k = `${f.family}|${f.style}`;
    if (seen.has(k)) continue;
    seen.add(k);
    try { await figma.loadFontAsync(f); } catch (e) { /* 忽略个别失败 */ }
  }
}

/** 按精确的 family/style 加载字体（patch 需要指定确切样式，而非字重） */
async function loadFontExact(family, style) {
  const key = `exact|${family}|${style}`;
  if (fontCache.has(key)) return fontCache.get(key);
  const font = { family, style };
  try {
    await figma.loadFontAsync(font);
    fontCache.set(key, font);
    return font;
  } catch (e) {
    return resolveFont(family, 400, /italic/i.test(style));
  }
}

/**
 * 对单个节点应用一组属性修改。
 * 返回「改了什么」的审计记录；dryRun 时只计算不写入。
 */
async function applySet(node, set = {}, dryRun) {
  const changes = {};
  const note = (k, from, to) => { changes[k] = { from, to }; };

  // ---- 别名归一 ----
  // dump 输出的字段名必须能原样回写成 set，否则「dump 出来直接改改再回写」
  // 只是文档里的一句话，实际会静默不生效。历史上两边名字不一致，这里统一接受。
  // 规范名优先：显式写了 fontSize 就不会被 size 覆盖。
  if (set.size !== undefined && set.fontSize === undefined) set = { ...set, fontSize: set.size };
  if (set.clip !== undefined && set.clipsContent === undefined) set = { ...set, clipsContent: set.clip };
  if (set.autoResize !== undefined && set.textAutoResize === undefined) set = { ...set, textAutoResize: set.autoResize };
  // weight / fontWeight（数字或样式名）→ fontStyle。
  // SPEC_DSL 用 weight: 600，dump 输出 fontStyle: "SemiBold"，两边都收。
  if ((set.weight !== undefined || set.fontWeight !== undefined) && set.fontStyle === undefined) {
    const w = set.weight !== undefined ? set.weight : set.fontWeight;
    const style = WEIGHT_STYLE[parseInt(String(w), 10)] || WEIGHT_STYLE[w] || String(w);
    set = { ...set, fontStyle: style };
  }
  if (set.sizing) {
    if (set.layoutSizingHorizontal === undefined) set = { ...set, layoutSizingHorizontal: set.sizing.h };
    if (set.layoutSizingVertical === undefined) set = { ...set, layoutSizingVertical: set.sizing.v };
  }

  if (set.name !== undefined) { note('name', node.name, set.name); if (!dryRun) node.name = String(set.name); }
  if (set.visible !== undefined) { note('visible', node.visible, !!set.visible); if (!dryRun) node.visible = !!set.visible; }
  if (set.opacity !== undefined && 'opacity' in node) { note('opacity', node.opacity, Number(set.opacity)); if (!dryRun) node.opacity = Number(set.opacity); }
  if (set.clipsContent !== undefined && 'clipsContent' in node) { note('clipsContent', node.clipsContent, !!set.clipsContent); if (!dryRun) node.clipsContent = !!set.clipsContent; }
  if (set.rotation !== undefined && 'rotation' in node) { note('rotation', RN(-node.rotation), set.rotation); if (!dryRun) node.rotation = -Number(set.rotation); }
  if (set.blendMode !== undefined && 'blendMode' in node) {
    note('blendMode', node.blendMode, set.blendMode);
    if (!dryRun) { try { node.blendMode = set.blendMode; } catch (e) { changes.blendMode = { error: String(e.message || e) }; } }
  }

  if (set.fill !== undefined) { note('fill', paintsToSpec(node.fills), set.fill); if (!dryRun) node.fills = paints(set.fill); }
  if (set.stroke !== undefined) { note('stroke', paintsToSpec(node.strokes), set.stroke); if (!dryRun) node.strokes = paints(set.stroke); }
  if (set.strokeWeight !== undefined && 'strokeWeight' in node) { note('strokeWeight', node.strokeWeight, set.strokeWeight); if (!dryRun) node.strokeWeight = Number(set.strokeWeight); }
  if (set.strokeAlign !== undefined && 'strokeAlign' in node) { note('strokeAlign', node.strokeAlign, set.strokeAlign); if (!dryRun) node.strokeAlign = set.strokeAlign; }

  if (set.effects !== undefined && 'effects' in node) {
    const want = toEffects(set.effects);
    note('effects', effectSummary(node.effects), effectSummary(want));
    if (!dryRun) { try { node.effects = want; } catch (e) { changes.effects = { error: String(e.message || e) }; } }
  }

  // ---- 原型交互 ----
  // dump 原样输出 reactions，这里原样写回 —— 读写对称，不解释也不丢字段。
  if (set.reactions !== undefined) {
    if (!('reactions' in node) && typeof node.setReactionsAsync !== 'function') {
      changes.reactions = { error: `${node.type} 不支持交互` };
    } else {
      const want = Array.isArray(set.reactions) ? set.reactions : [];
      note('reactions', (safeCall(() => (node.reactions || []).length) ?? 0), want.length);
      if (!dryRun) {
        try {
          if (typeof node.setReactionsAsync === 'function') await node.setReactionsAsync(want);
          else node.reactions = want;
        } catch (e) { changes.reactions = { error: String(e.message || e) }; }
      }
    }
  }

  // ---- 本地样式引用 ----
  // 按 id 或名字都认；null / "" 表示解除样式引用（保留当前外观值）。
  {
    const sc = await styleCache();
    for (const [setKey, idKey, kind] of [
      ['textStyle', 'textStyleId', 'text'],
      ['fillStyle', 'fillStyleId', 'paint'],
      ['strokeStyle', 'strokeStyleId', 'paint'],
      ['effectStyle', 'effectStyleId', 'effect'],
    ]) {
      if (set[setKey] === undefined || !(idKey in node)) continue;
      const want = set[setKey];
      const curId = safeCall(() => node[idKey]);
      if (want === null || want === '' || want === false) {
        note(setKey, sc[kind].byId.get(curId) || curId || null, null);
        if (!dryRun) { try { node[idKey] = ''; } catch (e) { changes[setKey] = { error: String(e.message || e) }; } }
        continue;
      }
      const key = String(want);
      const id = sc[kind].byId.has(key) ? key : sc[kind].byName.get(key);
      if (!id) {
        changes[setKey] = { error: `找不到本地样式「${want}」（可选：${[...sc[kind].byName.keys()].slice(0, 8).join(', ') || '本文件没有这类样式'}）` };
        continue;
      }
      note(setKey, sc[kind].byId.get(curId) || curId || null, sc[kind].byId.get(id));
      if (!dryRun) { try { node[idKey] = id; } catch (e) { changes[setKey] = { error: String(e.message || e) }; } }
    }
  }

  if (set.radius !== undefined && 'cornerRadius' in node) {
    note('radius', node.cornerRadius, set.radius);
    if (!dryRun) {
      try {
        if (Array.isArray(set.radius)) {
          node.topLeftRadius = set.radius[0] ?? 0;
          node.topRightRadius = set.radius[1] ?? set.radius[0] ?? 0;
          node.bottomRightRadius = set.radius[2] ?? set.radius[0] ?? 0;
          node.bottomLeftRadius = set.radius[3] ?? set.radius[1] ?? set.radius[0] ?? 0;
        } else {
          node.cornerRadius = Number(set.radius);
        }
      } catch (e) { changes.radius = { error: String(e.message || e) }; }
    }
  }

  // 绝对定位要先于 x/y/w/h 处理：切成 ABSOLUTE 之后，x/y 和尺寸就不再被布局忽略，
  // 而 AUTO 状态下它们会被 auto-layout 覆盖。顺序反了会误报「x/y 会被忽略」。
  const parentIsAuto = !!(node.parent && node.parent.layoutMode && node.parent.layoutMode !== 'NONE');
  const wasAbsolute = 'layoutPositioning' in node && node.layoutPositioning === 'ABSOLUTE';
  if (set.positioning !== undefined && 'layoutPositioning' in node) {
    const want = String(set.positioning).toUpperCase() === 'ABSOLUTE' ? 'ABSOLUTE' : 'AUTO';
    note('positioning', node.layoutPositioning, want);
    if (!dryRun) { try { node.layoutPositioning = want; } catch (e) { changes.positioning = { error: String(e.message || e) }; } }
  }
  // 本 op 结束后节点是否为绝对定位（决定了后续守卫的判断）
  const isAbsolute = set.positioning !== undefined
    ? String(set.positioning).toUpperCase() === 'ABSOLUTE'
    : wasAbsolute;

  if ((set.w !== undefined || set.h !== undefined) && typeof node.resize === 'function') {
    const w = set.w !== undefined ? Number(set.w) : node.width;
    const h = set.h !== undefined ? Number(set.h) : node.height;
    note('size', `${RN(node.width)}×${RN(node.height)}`, `${w}×${h}`);
    if (parentIsAuto && !isAbsolute) {
      changes.size.warning = '父容器是 auto-layout，宽/高可能被布局覆盖（可加 "positioning":"ABSOLUTE" 摆脱布局）';
    }
    if (!dryRun) { try { node.resize(w, h); } catch (e) { changes.size.error = String(e.message || e); } }
  }

  if ((set.x !== undefined || set.y !== undefined) && typeof node.x === 'number') {
    if (parentIsAuto && !isAbsolute) {
      changes.position = { error: '父容器是 auto-layout，x/y 会被忽略；请改布局属性（gap/pad/顺序），或先设 "positioning":"ABSOLUTE" 转为覆盖层' };
    } else {
      const x = set.x !== undefined ? Number(set.x) : node.x;
      const y = set.y !== undefined ? Number(set.y) : node.y;
      note('position', `${RN(node.x)},${RN(node.y)}`, `${x},${y}`);
      if (!dryRun) { node.x = x; node.y = y; }
    }
  }

  // auto-layout 模式切换。必须排在 gap/pad/main/cross 之前 ——
  // 那些属性只有在 layoutMode !== NONE 时才存在，同一个 op 里「先切模式再设间距」才成立。
  if (set.layout !== undefined && 'layoutMode' in node) {
    const want = normLayout(set.layout);                       // null = NONE
    const cur = node.layoutMode === 'NONE' ? null : node.layoutMode;
    note('layout', cur, want);
    if (!dryRun && want !== cur) {
      try { node.layoutMode = want === null ? 'NONE' : want; }
      catch (e) { changes.layout = { error: String(e.message || e) }; }
    }
  }
  if (set.wrap !== undefined && 'layoutWrap' in node) {
    const want = (set.wrap === true || String(set.wrap).toUpperCase() === 'WRAP') ? 'WRAP' : 'NO_WRAP';
    note('wrap', node.layoutWrap, want);
    if (!dryRun) { try { node.layoutWrap = want; } catch (e) { changes.wrap = { error: String(e.message || e) }; } }
  }

  if (node.layoutMode && node.layoutMode !== 'NONE') {
    if (set.gap !== undefined) { note('gap', node.itemSpacing, Number(set.gap)); if (!dryRun) node.itemSpacing = Number(set.gap); }
    if (set.main !== undefined) { note('main', node.primaryAxisAlignItems, set.main); if (!dryRun) node.primaryAxisAlignItems = set.main; }
    if (set.cross !== undefined) { note('cross', node.counterAxisAlignItems, set.cross); if (!dryRun) node.counterAxisAlignItems = set.cross; }
    if (set.pad !== undefined) {
      note('pad', [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft], set.pad);
      if (!dryRun) applyPadding(node, set.pad);
    }
  }

  if (set.layoutSizingHorizontal !== undefined) { note('sizingH', node.layoutSizingHorizontal, set.layoutSizingHorizontal); if (!dryRun) setSizing(node, 'H', set.layoutSizingHorizontal); }
  if (set.layoutSizingVertical !== undefined) { note('sizingV', node.layoutSizingVertical, set.layoutSizingVertical); if (!dryRun) setSizing(node, 'V', set.layoutSizingVertical); }
  if (set.layoutGrow !== undefined && 'layoutGrow' in node) { note('layoutGrow', node.layoutGrow, Number(set.layoutGrow)); if (!dryRun) node.layoutGrow = Number(set.layoutGrow); }

  if (node.type === 'TEXT') {
    const cur = node.fontName;
    const wantFont = set.font !== undefined || set.fontStyle !== undefined;
    const family = set.font !== undefined ? String(set.font) : (cur !== figma.mixed ? cur.family : 'Inter');
    const style = set.fontStyle !== undefined ? String(set.fontStyle) : (cur !== figma.mixed ? cur.style : 'Regular');
    const touchesText = set.text !== undefined || set.fontSize !== undefined || set.lineHeight !== undefined
      || set.letterSpacing !== undefined || wantFont;
    if (touchesText) {
      if (dryRun) {
        if (wantFont) note('font', cur === figma.mixed ? 'mixed' : `${cur.family} ${cur.style}`, `${family} ${style}`);
      } else if (wantFont) {
        const font = await loadFontExact(family, style);
        note('font', cur === figma.mixed ? 'mixed' : `${cur.family} ${cur.style}`, `${font.family} ${font.style}`);
        try { node.fontName = font; } catch (e) { changes.font.error = String(e.message || e); }
      } else {
        await ensureFontsLoaded(node);
      }
    }
    if (set.text !== undefined) { note('text', node.characters, set.text); if (!dryRun) node.characters = String(set.text); }
    if (set.fontSize !== undefined) { note('fontSize', node.fontSize === figma.mixed ? 'mixed' : node.fontSize, Number(set.fontSize)); if (!dryRun) node.fontSize = Number(set.fontSize); }
    if (set.lineHeight !== undefined) {
      const v = typeof set.lineHeight === 'number' ? { unit: 'PIXELS', value: set.lineHeight } : set.lineHeight;
      note('lineHeight', node.lineHeight === figma.mixed ? 'mixed' : node.lineHeight, v);
      if (!dryRun) node.lineHeight = v;
    }
    if (set.letterSpacing !== undefined) {
      const v = typeof set.letterSpacing === 'number' ? { unit: 'PIXELS', value: set.letterSpacing } : set.letterSpacing;
      note('letterSpacing', node.letterSpacing === figma.mixed ? 'mixed' : node.letterSpacing, v);
      if (!dryRun) node.letterSpacing = v;
    }
    if (set.align !== undefined) { note('align', node.textAlignHorizontal, set.align); if (!dryRun) node.textAlignHorizontal = set.align; }
    if (set.valign !== undefined) { note('valign', node.textAlignVertical, set.valign); if (!dryRun) node.textAlignVertical = set.valign; }
    if (set.textAutoResize !== undefined) { note('textAutoResize', node.textAutoResize, set.textAutoResize); if (!dryRun) node.textAutoResize = set.textAutoResize; }
  }

  return changes;
}

/* ------------------------------------------------------------ 指令实现 */

/** 读取节点树 → 与 SPEC_DSL 同构的 JSON */
async function cmdDump(p = {}) {
  await figma.loadAllPagesAsync();
  const opt = { maxDepth: p.maxDepth ?? 8, maxNodes: p.maxNodes ?? 4000, styles: await styleCache() };
  const state = { count: 0, truncated: false };
  let roots = [];
  let scope = 'page';
  // 只读，永不新建页面
  const page = (p.pageName
    ? figma.root.children.find((x) => x.name === p.pageName)
    : figma.currentPage) || figma.currentPage;

  if (p.ids && p.ids.length) {
    for (const id of p.ids) { const n = await getNode(id); if (n) roots.push(n); }
    scope = 'ids';
  } else if (p.name != null || p.type != null || p.layout != null) {
    roots = await resolveTargets(p);
    scope = 'query';
  } else if (p.within != null) {
    // 只给范围不给条件 = 「把这个容器的子树读出来」，保留层级结构
    const root = await getNode(String(p.within));
    if (!root) throw new Error(`找不到容器 ${p.within}`);
    roots = [root];
    scope = 'within';
  } else if (figma.currentPage.selection.length) {
    roots = [...figma.currentPage.selection];
    scope = 'selection';
  } else {
    roots = [...page.children];
    scope = 'page';
  }

  // INSTANCE 的主组件在 dynamic-page 下只能异步取，而 dumpNode 是同步的。
  // 先扫一遍收集实例，统一解析好塞进 opt，dumpNode 再去查表。
  const insts = [];
  for (const r of roots) {
    for (const n of allDescendants(r)) { if (n.type === 'INSTANCE') insts.push(n); }
  }
  if (insts.length) {
    opt.mainComponents = new Map();
    for (const n of insts) {
      const mc = (await safeCallAsync(() => (typeof n.getMainComponentAsync === 'function'
        ? n.getMainComponentAsync() : null)))
        || safeCall(() => n.mainComponent);
      if (mc) opt.mainComponents.set(n.id, { id: mc.id, name: mc.name });
    }
  }

  const nodes = roots.map((n) => dumpNode(n, opt, state, 0));
  return {
    scope,
    file: figma.root.name,
    page: page.name,
    rootCount: roots.length,
    nodeCount: state.count,
    truncated: state.truncated,
    nodes,
  };
}

/** 轻量树状大纲：用于快速定位，比 dump 便宜得多 */
async function cmdList(p = {}) {
  await figma.loadAllPagesAsync();
  const maxDepth = p.maxDepth ?? 6;
  const cap = p.maxLines ?? 3000;
  const lines = [];
  let cut = false;
  const walk = (n, d) => {
    if (cut || d > maxDepth) return;
    if (lines.length >= cap) { cut = true; return; }
    const size = typeof n.width === 'number' ? `${Math.round(n.width)}×${Math.round(n.height)}` : '';
    const lay = (n.layoutMode && n.layoutMode !== 'NONE') ? ` [${n.layoutMode === 'VERTICAL' ? 'V' : 'H'}]` : '';
    const txt = n.type === 'TEXT' ? ` "${String(n.characters).replace(/\n/g, '⏎').slice(0, 28)}"` : '';
    lines.push(`${'  '.repeat(d)}${n.type} ${n.name}${lay} ${size}${txt}  #${n.id}`);
    if ('children' in n) for (const c of n.children) walk(c, d + 1);
  };
  const page = p.pageName
    ? figma.root.children.find((x) => x.name === p.pageName) || figma.currentPage
    : figma.currentPage;
  for (const n of page.children) walk(n, 0);
  return { page: page.name, lines: lines.length, truncated: cut, outline: lines.join('\n') };
}

/** 就地修改节点属性（核心迭代工具） */
async function cmdPatch(p = {}) {
  await figma.loadAllPagesAsync();
  const ops = p.ops || [];
  if (!ops.length) throw new Error('缺少 ops');
  const dryRun = !!p.dryRun;
  const results = [];

  for (const op of ops) {
    if (!hasSelector(op) && op.all !== true) {
      results.push({ selector: '(无选择器)', matched: 0, error: NO_SELECTOR_HINT });
      continue;
    }
    const targets = await resolveTargets(op);
    if (!targets.length) {
      results.push({ selector: describeSelector(op), matched: 0, error: '未匹配到节点' });
      continue;
    }
    const applied = [];
    for (const node of targets) {
      try {
        const changes = await applySet(node, op.set || {}, dryRun);
        applied.push({ id: node.id, name: node.name, type: node.type, changes });
      } catch (e) {
        applied.push({ id: node.id, name: node.name, error: String(e.message || e) });
      }
    }
    results.push({ selector: describeSelector(op), matched: targets.length, applied });
  }

  const totalMatched = results.reduce((a, r) => a + r.matched, 0);
  if (!dryRun && totalMatched && typeof figma.commitUndo === 'function') figma.commitUndo();
  return { dryRun, totalMatched, results };
}

function describeSelector(op) {
  const parts = [];
  if (op.id) parts.push(`id=${op.id}`);
  if (op.ids) parts.push(`ids=${op.ids.length}个`);
  if (op.selection) parts.push('selection');
  if (op.name != null) parts.push(`name=${op.name}`);
  if (op.text != null) parts.push(`text=${op.text}`);
  if (op.type) parts.push(`type=${op.type}`);
  if (op.layout) parts.push(`layout=${op.layout}`);
  return parts.join(' ') || '(全部)';
}

/**
 * op 是否带了选择器。
 *
 * 没有选择器的写操作会命中**整个页面**。这在迭代场景里几乎总是笔误
 * （漏写 id、选择器字段名打错），代价却是把用户整页稿子改花。
 * 所以必须显式写 "all": true 才放行。
 */
function hasSelector(op) {
  return !!(op.id
    || (Array.isArray(op.ids) && op.ids.length)
    || op.selection
    || op.name != null
    || op.text != null
    || op.type != null
    || op.layout != null
    || op.fontSize != null);
}

const NO_SELECTOR_HINT = '该 op 没有选择器，会匹配整个页面。确认要全量修改请显式写 "all": true';

/** 往现有容器里插入新节点（用同一套 SPEC_DSL） */
async function cmdInsert(p = {}) {
  await figma.loadAllPagesAsync();
  let parent = null;
  if (p.parentId) parent = await getNode(p.parentId);
  else if (p.parentName != null) parent = findByName(figma.currentPage, String(p.parentName));
  else if (figma.currentPage.selection.length === 1) parent = figma.currentPage.selection[0];

  if (!parent) throw new Error('找不到插入目标：请给 parentId / parentName，或先选中一个容器');
  if (!('appendChild' in parent)) throw new Error(`节点「${parent.name}」(${parent.type}) 不能容纳子节点`);

  const specs = p.specs || (p.spec ? [p.spec] : []);
  if (!specs.length) throw new Error('缺少 spec / specs');

  // dry-run：只校验父容器与 spec，不真正 build（P27：dryRun 必须真的包住变异语句）
  if (p.dryRun) {
    const plan = specs.map((s) => ({
      name: s.name ?? null,
      type: s.type ?? null,
      childCount: (s.children || []).length,
    }));
    return {
      dryRun: true,
      parent: { id: parent.id, name: parent.name, type: parent.type },
      created: plan.map((s) => ({ id: null, name: s.name, type: s.type, note: 'dry-run：未创建' })),
      planned: plan,
      nodes: 0,
    };
  }

  let done = 0;
  const tick = async () => {
    done++;
    if (done % 80 === 0) {
      figma.ui.postMessage({ type: 'progress', cmd: 'insert', done });
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  const nodeRefs = [];
  for (const spec of specs) nodeRefs.push(await build(spec, parent, tick));

  if (typeof p.index === 'number' && 'insertChild' in parent) {
    nodeRefs.forEach((n, i) => {
      try { parent.insertChild(Math.max(0, p.index) + i, n); } catch (e) { /* 忽略 */ }
    });
  }
  if (typeof figma.commitUndo === 'function') figma.commitUndo();

  return {
    parent: { id: parent.id, name: parent.name, type: parent.type },
    created: nodeRefs.map((n) => ({ id: n.id, name: n.name, type: n.type })),
    nodes: done,
  };
}

/** 删除节点（默认建议先 dryRun 看会删掉什么） */
async function cmdRemove(p = {}) {
  await figma.loadAllPagesAsync();
  // 同样的护栏：没有选择器就是「删掉整页」，必须显式 opt-in。
  if (!hasSelector(p) && p.all !== true) throw new Error(NO_SELECTOR_HINT);
  const targets = await resolveTargets(p);
  if (!targets.length) throw new Error('未匹配到要删除的节点');
  const limit = p.maxRemove ?? 200;
  if (targets.length > limit && !p.force) {
    throw new Error(`匹配到 ${targets.length} 个节点，超过上限 ${limit}。确认无误请加 force:true`);
  }
  const removed = targets.map((n) => ({ id: n.id, name: n.name, type: n.type }));
  if (!p.dryRun) {
    for (const n of targets) { try { n.remove(); } catch (e) { /* 可能已被父节点连带删除 */ } }
    if (typeof figma.commitUndo === 'function') figma.commitUndo();
  }
  return { dryRun: !!p.dryRun, count: removed.length, removed };
}

/** 读/写当前选区 —— 用户说「改这个」时最自然的入口 */
/* ======================================================================
 * 结构操作 —— 顺序 / 复制 / 成组
 * ----------------------------------------------------------------------
 * 在现有稿上迭代时，"把这一行挪到那行上面"、"再复制一张卡片"、
 * "把这三个东西成组"是最常见的三类动作。以前一个都做不了
 * （文档里建议的"调整子节点顺序"根本没有对应指令）。
 * ==================================================================== */

/** target 是不是 node 的后代（用来拦「把父节点塞进自己的子树」） */
function isDescendantOf(target, node) {
  let n = target && target.parent;
  while (n) { if (n === node) return true; n = n.parent; }
  return false;
}

/** 解析目标父容器：parentId / parentName，都没给返回 null（表示"原地"） */
async function resolveParent(p) {
  if (p.parentId) {
    const n = await getNode(String(p.parentId));
    if (!n) throw new Error(`找不到目标父容器 ${p.parentId}`);
    return n;
  }
  if (p.parentName != null) {
    const n = findByName(figma.currentPage, String(p.parentName));
    if (!n) throw new Error(`找不到名为「${p.parentName}」的容器`);
    return n;
  }
  return null;
}

/**
 * 移动节点：改变它在父容器里的**顺序**，或搬到另一个容器。
 *
 * index 语义跟随 Figma：auto-layout 里是布局顺序（0 = 最前），
 * 普通容器里是 z 序（0 = 最底层）。不给 index 就放到末尾（= 最上层）。
 */
async function cmdMove(p = {}) {
  await figma.loadAllPagesAsync();
  if (!hasSelector(p) && p.all !== true) throw new Error(NO_SELECTOR_HINT);
  const targets = await resolveTargets(p);
  if (!targets.length) throw new Error('未匹配到要移动的节点');
  const parent = await resolveParent(p);

  const moved = [];
  for (const node of targets) {
    const from = node.parent;
    const target = parent || from;
    if (!target) { moved.push({ id: node.id, name: node.name, error: '节点没有父容器' }); continue; }
    if (!('insertChild' in target)) {
      moved.push({ id: node.id, name: node.name, error: `「${target.name}」(${target.type}) 不能容纳子节点` });
      continue;
    }
    if (target === node || isDescendantOf(target, node)) {
      moved.push({ id: node.id, name: node.name, error: '不能把节点移进它自己的子树' });
      continue;
    }
    const fromIndex = from ? from.children.indexOf(node) : -1;
    const want = p.index != null
      ? Math.max(0, Math.min(Number(p.index), target.children.length))
      : target.children.length;   // 不给就放末尾
    if (p.dryRun) {
      // dry-run 只算「会落到哪」，绝不动文档
      moved.push({
        id: node.id, name: node.name, type: node.type,
        from: from ? { id: from.id, name: from.name } : null,
        fromIndex,
        to: { id: target.id, name: target.name },
        index: want,
        note: 'dry-run：未移动',
      });
      continue;
    }
    try {
      target.insertChild(want, node);
      moved.push({
        id: node.id, name: node.name, type: node.type,
        from: from ? { id: from.id, name: from.name } : null,
        fromIndex,
        to: { id: target.id, name: target.name },
        // 报「实际落到哪」而不是「请求哪」——同容器内移动时索引会被移除动作偏移
        index: target.children.indexOf(node),
      });
    } catch (e) {
      moved.push({ id: node.id, name: node.name, error: String(e.message || e) });
    }
  }
  if (!p.dryRun && typeof figma.commitUndo === 'function') figma.commitUndo();
  return { count: moved.length, moved };
}

/**
 * 复制节点（含整棵子树）。可选搬到别的容器、改名、给个偏移免得完全重叠。
 * 和 remove 一样有数量上限：dup 一个通配符失手会把画布撑爆。
 */
async function cmdDup(p = {}) {
  await figma.loadAllPagesAsync();
  if (!hasSelector(p) && p.all !== true) throw new Error(NO_SELECTOR_HINT);
  const targets = await resolveTargets(p);
  if (!targets.length) throw new Error('未匹配到要复制的节点');
  const limit = p.maxDup ?? 200;
  if (targets.length > limit && !p.force) {
    throw new Error(`匹配到 ${targets.length} 个节点，超过上限 ${limit}。确认无误请加 force:true`);
  }
  const times = Math.max(1, Math.min(Number(p.count || 1), 20));
  const parent = await resolveParent(p);

  const created = [];
  for (const node of targets) {
    const snap = { id: node.id, name: node.name, type: node.type };
    if (p.dryRun) {
      // dry-run：只说会复制什么，不 clone。
      // 注意不要把这个 id 当成"副本的 id"报出去 —— 它是**源节点**的 id，
      // 报成新 id 会让人以为节点已经建好了（审计必须诚实，见 P27）。
      for (let i = 0; i < times; i++) {
        created.push({ sourceId: node.id, name: node.name, type: node.type,
          of: node.name, note: 'dry-run：未复制' });
      }
      continue;
    }
    for (let i = 0; i < times; i++) {
      let copy;
      try { copy = node.clone(); }
      catch (e) { created.push({ id: node.id, name: node.name, error: `复制失败：${String(e.message || e)}` }); break; }
      // 用 p.rename 而不是 p.name —— p.name 是选择器（"选谁"），两者不能共用一个键
      if (p.rename != null) { try { copy.name = String(p.rename); } catch (e) { /* ignore */ } }
      const target = parent || node.parent;
      if (target && copy.parent !== target && 'insertChild' in target) {
        try { target.insertChild(p.index != null ? Number(p.index) + i : target.children.length, copy); } catch (e) { /* ignore */ }
      }
      // 偏移只对非 auto-layout 父容器有意义（auto-layout 里 x/y 会被布局覆盖）
      const t = copy.parent;
      const isAutoParent = t && t.layoutMode && t.layoutMode !== 'NONE';
      if ((p.dx || p.dy) && !isAutoParent) {
        try { copy.x = node.x + Number(p.dx || 0) * (i + 1); copy.y = node.y + Number(p.dy || 0) * (i + 1); } catch (e) { /* ignore */ }
      }
      created.push({ id: copy.id, name: copy.name, type: copy.type, of: node.name });
    }
  }
  if (!p.dryRun && typeof figma.commitUndo === 'function') figma.commitUndo();
  return { count: created.length, created };
}

/** 把若干节点收进一个 GROUP（必须同父容器——Figma 的硬性要求） */
async function cmdGroup(p = {}) {
  await figma.loadAllPagesAsync();
  if (!hasSelector(p) && p.all !== true) throw new Error(NO_SELECTOR_HINT);
  const targets = await resolveTargets(p);
  if (targets.length < 1) throw new Error('未匹配到要成组的节点');
  const parent = targets[0].parent;
  if (!parent) throw new Error('节点没有父容器');
  if (targets.some((n) => n.parent !== parent)) {
    throw new Error('要成组的节点必须属于同一个父容器（先用 move 搬到一起）');
  }
  if (typeof figma.group !== 'function') throw new Error('当前 API 版本不支持 figma.group');
  const index = p.index != null
    ? Number(p.index)
    : Math.min(...targets.map((n) => parent.children.indexOf(n)));
  if (p.dryRun) {
    return {
      dryRun: true,
      group: { name: p.rename ?? 'Group', index },
      parent: { id: parent.id, name: parent.name },
      count: targets.length,
      members: targets.map((n) => ({ id: n.id, name: n.name, type: n.type })),
      note: 'dry-run：未成组',
    };
  }
  const g = figma.group(targets, parent, index);
  // 同样用 p.rename：p.name 是选择器
  if (p.rename != null) { try { g.name = String(p.rename); } catch (e) { /* ignore */ } }
  if (typeof figma.commitUndo === 'function') figma.commitUndo();
  return {
    group: { id: g.id, name: g.name, type: g.type, w: RN(g.width), h: RN(g.height) },
    parent: { id: parent.id, name: parent.name },
    count: targets.length,
  };
}

/** 解组：把 GROUP / FRAME 拆开，子节点原地保留 */
async function cmdUngroup(p = {}) {
  await figma.loadAllPagesAsync();
  if (!hasSelector(p) && p.all !== true) throw new Error(NO_SELECTOR_HINT);
  const targets = await resolveTargets(p);
  if (!targets.length) throw new Error('未匹配到要解组的节点');
  if (typeof figma.ungroup !== 'function') throw new Error('当前 API 版本不支持 figma.ungroup');

  const done = [];
  for (const n of targets) {
    if (!['GROUP', 'FRAME', 'COMPONENT'].includes(n.type)) {
      done.push({ id: n.id, name: n.name, type: n.type, error: `${n.type} 不能解组` });
      continue;
    }
    // ⚠ 必须先快照：figma.ungroup() 会**销毁**这个节点，
    // 之后再读 n.name / n.type 会抛 "The node with id ... does not exist"。
    const snap = { id: n.id, name: n.name, type: n.type };
    if (p.dryRun) {
      // dry-run：只列会被释放的子节点，不解组
      done.push({ ...snap, released: n.children.length,
        children: n.children.map((k) => ({ id: k.id, name: k.name, type: k.type })),
        note: 'dry-run：未解组' });
      continue;
    }
    try {
      const kids = figma.ungroup(n) || [];
      done.push({
        ...snap,
        released: kids.length,
        children: kids.map((k) => ({ id: k.id, name: k.name, type: k.type })),
      });
    } catch (e) {
      done.push({ ...snap, error: String(e.message || e) });
    }
  }
  if (!p.dryRun && typeof figma.commitUndo === 'function') figma.commitUndo();
  return { count: done.length, groups: done };
}

/** 列出本文件的本地样式 —— 想按名字应用样式，得先知道有哪些名字 */
async function cmdStyles() {
  const sc = await styleCache();
  const list = (kind) => [...sc[kind].byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    file: figma.root.name,
    text: list('text'),
    paint: list('paint'),
    effect: list('effect'),
    note: '只列本地样式；从库同步下来的远程样式不在其中（那需要 importStyleByKeyAsync）',
  };
}

/* ======================================================================
 * 组件 / 实例 / 原型交互
 * ==================================================================== */

/** 找一个组件：给 id 用它，给名字就在页面里搜 COMPONENT */
async function resolveComponent({ id, name, pageName }) {
  if (id) {
    const n = await getNode(String(id));
    if (!n) throw new Error(`找不到节点 ${id}`);
    if (n.type !== 'COMPONENT') throw new Error(`「${n.name}」是 ${n.type}，不是 COMPONENT`);
    return { comp: n, ambiguous: 0 };
  }
  if (name == null) return { comp: null, ambiguous: 0 };
  const found = await resolveTargets({ name, type: 'COMPONENT', pageName });
  if (!found.length) throw new Error(`页面里找不到名为「${name}」的组件`);
  if (found.length > 1) {
    // 同名组件多个时不能装作没事——调用方可能选错了那个
    return { comp: found[0], ambiguous: found.length };
  }
  return { comp: found[0], ambiguous: 0 };
}

/** 把 FRAME / GROUP 原地转成组件（保留图层结构与命名） */
async function cmdComponent(p = {}) {
  await figma.loadAllPagesAsync();
  if (!hasSelector(p) && p.all !== true) throw new Error(NO_SELECTOR_HINT);
  if (typeof figma.createComponentFromNode !== 'function') {
    throw new Error('当前 API 版本没有 figma.createComponentFromNode');
  }
  const targets = await resolveTargets(p);
  if (!targets.length) throw new Error('未匹配到要转成组件的节点');

  const created = [];
  for (const n of targets) {
    // createComponentFromNode 会**替换**原节点，所以先快照（P24 的教训）
    const snap = { id: n.id, name: n.name, type: n.type };
    if (n.type === 'COMPONENT') { created.push({ ...snap, note: '本来就是组件' }); continue; }
    if (!['FRAME', 'GROUP'].includes(n.type)) {
      created.push({ ...snap, error: `${n.type} 不能转成组件（需要 FRAME 或 GROUP）` });
      continue;
    }
    if (p.dryRun) { created.push({ ...snap, note: 'dry-run：未转换', renameTo: p.rename ?? null }); continue; }
    try {
      const c = figma.createComponentFromNode(n);
      if (p.rename != null) c.name = String(p.rename);
      created.push({ id: c.id, name: c.name, type: c.type, from: snap.type,
        w: RN(safeCall(() => c.width) || 0), h: RN(safeCall(() => c.height) || 0) });
    } catch (e) {
      created.push({ ...snap, error: String(e.message || e) });
    }
  }
  if (!p.dryRun && typeof figma.commitUndo === 'function') figma.commitUndo();
  return { count: created.length, created };
}

/** 放置组件实例 —— 有设计系统之后，搭页面就是"摆实例 + 改文案" */
async function cmdInstance(p = {}) {
  await figma.loadAllPagesAsync();
  const { comp, ambiguous } = await resolveComponent({ id: p.of, name: p.ofName, pageName: p.pageName });
  if (!comp) throw new Error('要实例化哪个组件？给 --of <组件id> 或 --of-name <组件名>');
  if (typeof comp.createInstance !== 'function') throw new Error(`「${comp.name}」不支持 createInstance`);

  const parent = await resolveParent(p);
  const times = Math.max(1, Math.min(Number(p.count || 1), 20));
  const created = [];
  if (p.dryRun) {
    // dry-run：只报会放几个、放到哪，不创建
    for (let i = 0; i < times; i++) {
      created.push({ of: comp.name, target: (parent || comp.parent || {}).name ?? null, note: 'dry-run：未创建' });
    }
    return { dryRun: true, count: created.length, component: { id: comp.id, name: comp.name },
      ambiguous: ambiguous || undefined, created };
  }
  for (let i = 0; i < times; i++) {
    let inst;
    try { inst = comp.createInstance(); }
    catch (e) { created.push({ error: `创建实例失败：${String(e.message || e)}` }); break; }
    if (p.rename != null) { try { inst.name = String(p.rename); } catch (e) { /* ignore */ } }
    const target = parent || comp.parent;
    if (target && 'insertChild' in target && inst.parent !== target) {
      try { target.insertChild(p.index != null ? Number(p.index) + i : target.children.length, inst); } catch (e) { /* ignore */ }
    }
    // 非 auto-layout 父容器里才能显式定位；逐个错开一点，免得完全重叠
    const t = inst.parent;
    const isAutoParent = t && t.layoutMode && t.layoutMode !== 'NONE';
    if (!isAutoParent) {
      try { if (typeof p.x === 'number') inst.x = Number(p.x) + i * 20; } catch (e) { /* ignore */ }
      try { if (typeof p.y === 'number') inst.y = Number(p.y) + i * 20; } catch (e) { /* ignore */ }
    }
    created.push({ id: inst.id, name: inst.name, type: inst.type, of: comp.name });
  }
  if (!p.dryRun && typeof figma.commitUndo === 'function') figma.commitUndo();
  return {
    count: created.length,
    component: { id: comp.id, name: comp.name },
    ambiguous: ambiguous || undefined,
    created,
  };
}

/** 换实例的主组件 */
async function cmdSwap(p = {}) {
  await figma.loadAllPagesAsync();
  if (!hasSelector(p) && p.all !== true) throw new Error(NO_SELECTOR_HINT);
  const targets = await resolveTargets(p);
  if (!targets.length) throw new Error('未匹配到要换组件的实例');
  const { comp, ambiguous } = await resolveComponent({ id: p.to, name: p.toName, pageName: p.pageName });
  if (!comp) throw new Error('换成哪个组件？给 --to <组件id> 或 --to-name <组件名>');

  const swapped = [];
  for (const n of targets) {
    const snap = { id: n.id, name: n.name, type: n.type };
    if (n.type !== 'INSTANCE') { swapped.push({ ...snap, error: `${n.type} 不是实例` }); continue; }
    const before = await safeCallAsync(() => (typeof n.getMainComponentAsync === 'function'
      ? n.getMainComponentAsync() : null)).then((c) => (c && c.name)
      || safeCall(() => (n.mainComponent && n.mainComponent.name) || null));
    if (p.dryRun) { swapped.push({ ...snap, from: before, to: comp.name, note: 'dry-run：未替换' }); continue; }
    try {
      // dynamic-page 下用异步版；旧版本退回同步版
      if (typeof n.swapComponentAsync === 'function') await n.swapComponentAsync(comp);
      else if (typeof n.swapComponent === 'function') n.swapComponent(comp);
      else throw new Error('该实例不支持 swapComponent');
      swapped.push({ ...snap, from: before, to: comp.name });
    } catch (e) {
      swapped.push({ ...snap, error: String(e.message || e) });
    }
  }
  if (!p.dryRun && typeof figma.commitUndo === 'function') figma.commitUndo();
  return { count: swapped.length, swapped, ambiguous: ambiguous || undefined };
}

/** 脱离组件：实例 → 普通 FRAME（之后可以随便改，不再受主组件约束） */
async function cmdDetach(p = {}) {
  await figma.loadAllPagesAsync();
  if (!hasSelector(p) && p.all !== true) throw new Error(NO_SELECTOR_HINT);
  const targets = await resolveTargets(p);
  if (!targets.length) throw new Error('未匹配到要脱离的实例');

  const out = [];
  for (const n of targets) {
    // detachInstance() 之后原实例就没了，先快照
    const snap = { id: n.id, name: n.name, type: n.type };
    if (n.type !== 'INSTANCE') { out.push({ ...snap, error: `${n.type} 不是实例` }); continue; }
    if (p.dryRun) { out.push({ ...snap, note: 'dry-run：未脱离' }); continue; }
    try {
      const detached = n.detachInstance();
      out.push({ ...snap, detachedTo: { id: detached.id, name: detached.name, type: detached.type } });
    } catch (e) {
      out.push({ ...snap, error: String(e.message || e) });
    }
  }
  if (!p.dryRun && typeof figma.commitUndo === 'function') figma.commitUndo();
  return { dryRun: !!p.dryRun, count: out.length, detached: out };
}

/** 归一 trigger / action，避免把不规范的字面量直接塞给 Figma */
const TRIGGERS = ['ON_CLICK', 'ON_HOVER', 'ON_PRESS', 'ON_DRAG', 'AFTER_TIMEOUT', 'MOUSE_ENTER',
  'MOUSE_LEAVE', 'MOUSE_UP', 'MOUSE_DOWN'];
const NAVIGATIONS = ['NAVIGATE', 'SWAP', 'OVERLAY', 'SCROLL_TO', 'CHANGE_TO'];
const TRANSITIONS = ['INSTANT', 'DISSOLVE', 'SMART_ANIMATE', 'MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT'];
const EASINGS = ['EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR', 'EASE_IN_BACK', 'EASE_OUT_BACK',
  'EASE_IN_AND_OUT_BACK', 'CUSTOM_CUBIC_BEZIER', 'GENTLE', 'QUICK', 'BOUNCY', 'SLOW'];

function pick(value, allowed, fallback, label) {
  const v = String(value ?? fallback).toUpperCase();
  if (!allowed.includes(v)) {
    throw new Error(`${label} 只能是 ${allowed.join(' / ')}，收到「${value}」`);
  }
  return v;
}

/** 读原型交互（把 destinationId 解析成人看得懂的名字） */
async function cmdReactions(p = {}) {
  await figma.loadAllPagesAsync();
  if (!hasSelector(p) && p.all !== true) throw new Error(NO_SELECTOR_HINT);
  const targets = await resolveTargets(p);
  const out = [];
  for (const n of targets) {
    const rs = safeCall(() => n.reactions) || [];
    if (!rs.length) continue;
    const items = [];
    for (const r of rs) {
      const actions = [];
      for (const a of r.actions || []) {
        const o = { type: a.type };
        if (a.navigation) o.navigation = a.navigation;
        if (a.destinationId) {
          const d = await getNode(a.destinationId);
          o.destination = d ? { id: d.id, name: d.name, type: d.type }
            : { id: a.destinationId, missing: true };
        }
        if (a.url) o.url = a.url;
        if (a.transition) o.transition = a.transition;
        actions.push(o);
      }
      items.push({ trigger: r.trigger, actions });
    }
    out.push({ id: n.id, name: n.name, type: n.type, reactions: items });
  }
  return { count: out.length, nodes: out };
}

/** 建 / 清原型交互。默认**替换**该节点上的全部交互，--append 则追加。 */
async function cmdLink(p = {}) {
  await figma.loadAllPagesAsync();
  if (!hasSelector(p) && p.all !== true) throw new Error(NO_SELECTOR_HINT);
  const targets = await resolveTargets(p);
  if (!targets.length) throw new Error('未匹配到要加交互的节点');

  let reaction = null;
  if (!p.clear) {
    const triggerType = pick(p.trigger, TRIGGERS, 'ON_CLICK', 'trigger');
    const trigger = { type: triggerType };
    if (triggerType === 'AFTER_TIMEOUT') trigger.timeout = Number(p.timeout ?? 1);

    let action;
    if (p.url) {
      action = { type: 'URL', url: String(p.url) };
    } else {
      let dest = null;
      if (p.to) {
        dest = await getNode(String(p.to));
        if (!dest) throw new Error(`找不到目标节点 ${p.to}`);
      } else if (p.toName != null) {
        const found = await resolveTargets({ name: p.toName, pageName: p.pageName });
        if (!found.length) throw new Error(`找不到名为「${p.toName}」的目标节点`);
        dest = found[0];
      }
      if (!dest) throw new Error('要连到哪里？给 --to <节点id> / --to-name <名称> / --url <网址>');
      action = {
        type: 'NODE',
        destinationId: dest.id,
        navigation: pick(p.nav, NAVIGATIONS, 'NAVIGATE', 'nav'),
        transition: p.transition === false ? null : {
          type: pick(p.transition, TRANSITIONS, 'SMART_ANIMATE', 'transition'),
          easing: { type: pick(p.easing, EASINGS, 'EASE_OUT', 'easing') },
          duration: Number(p.duration ?? 0.3),
        },
        preserveScrollPosition: false,
      };
    }
    reaction = { trigger, actions: [action] };
  }

  const done = [];
  for (const n of targets) {
    const snap = { id: n.id, name: n.name, type: n.type };
    const before = safeCall(() => (n.reactions || []).length) ?? 0;
    const canWrite = typeof n.setReactionsAsync === 'function' || 'reactions' in n;
    if (!canWrite) { done.push({ ...snap, error: `${n.type} 不支持交互` }); continue; }
    const next = p.clear ? []
      : (p.append ? [...(safeCall(() => n.reactions) || []), reaction] : [reaction]);
    if (!p.dryRun) {
      try {
        if (typeof n.setReactionsAsync === 'function') await n.setReactionsAsync(next);
        else n.reactions = next;
      } catch (e) { done.push({ ...snap, error: String(e.message || e) }); continue; }
    }
    done.push({ ...snap, before, after: next.length, action: p.clear ? 'clear' : 'set' });
  }
  if (!p.dryRun && typeof figma.commitUndo === 'function') figma.commitUndo();
  return { dryRun: !!p.dryRun, count: done.length, nodes: done };
}

async function cmdSelection(p = {}) {
  await figma.loadAllPagesAsync();
  if (p.ids && p.ids.length) {
    const nodes = [];
    for (const id of p.ids) { const n = await getNode(id); if (n) nodes.push(n); }
    if (!nodes.length) throw new Error('给的 id 一个都没找到');
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
    return { action: 'set', selected: nodes.map((n) => ({ id: n.id, name: n.name, type: n.type })) };
  }
  const sel = figma.currentPage.selection;
  const state = { count: 0, truncated: false };
  const opt = { maxDepth: p.maxDepth ?? 3, maxNodes: p.maxNodes ?? 800, styles: await styleCache() };
  // 选中的实例同样要异步解析主组件
  opt.mainComponents = new Map();
  for (const n of sel) {
    for (const d of allDescendants(n)) {
      if (d.type !== 'INSTANCE') continue;
      const mc = (await safeCallAsync(() => (typeof d.getMainComponentAsync === 'function'
        ? d.getMainComponentAsync() : null))) || safeCall(() => d.mainComponent);
      if (mc) opt.mainComponents.set(d.id, { id: mc.id, name: mc.name });
    }
  }
  return {
    action: 'get',
    page: figma.currentPage.name,
    count: sel.length,
    nodes: sel.map((n) => dumpNode(n, opt, state, 0)),
    truncated: state.truncated,
  };
}

const HANDLERS = {
  ping: cmdPing,
  stats: cmdStats,
  render: cmdRender,
  export: cmdExport,
  clear: cmdClear,
  focus: cmdFocus,
  dump: cmdDump,
  list: cmdList,
  patch: cmdPatch,
  insert: cmdInsert,
  remove: cmdRemove,
  styles: cmdStyles,
  component: cmdComponent,
  instance: cmdInstance,
  swap: cmdSwap,
  detach: cmdDetach,
  reactions: cmdReactions,
  link: cmdLink,
  move: cmdMove,
  dup: cmdDup,
  group: cmdGroup,
  ungroup: cmdUngroup,
  selection: cmdSelection,
  page: cmdPage,
};

figma.ui.onmessage = async (msg) => {
  if (!msg || !msg.cmd) return;
  const { id, cmd, payload } = msg;
  const handler = HANDLERS[cmd];
  try {
    if (!handler) throw new Error(`未知指令: ${cmd}`);
    const data = await handler(payload || {});
    figma.ui.postMessage({ id, ok: true, data });
  } catch (err) {
    figma.ui.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};

// 注意：这里不要注册 figma.on('documentchange', ...)。
// 在 documentAccess: "dynamic-page" 下，注册该处理器前必须先 await
// figma.loadAllPagesAsync()，否则插件一启动就会报
// "Cannot register documentchange handler in incremental mode"。
// 本插件也不需要监听文档变化——指令都是显式下发的。

