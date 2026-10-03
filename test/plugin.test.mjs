#!/usr/bin/env node
/* =============================================================================
 * 插件单元测试
 * -----------------------------------------------------------------------------
 * 在 Figma API 桩上执行**真实的** plugin/code.js，通过真实的 figma.ui 消息通道
 * 下发指令。目标是抓住逻辑错误，而不是模拟 Figma 的全部行为。
 *
 * 运行： node test/plugin.test.mjs
 * ========================================================================== */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFigma, loadPlugin, send } from './figma-stub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'specs', 'stock-app.json'), 'utf8'));

const results = [];
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    results.push(`  \x1b[31m✖\x1b[0m ${name}\n      \x1b[31m${e.message}\x1b[0m`);
  }
}

const walk = (n, fn) => { fn(n); if (n.children) for (const c of n.children) walk(c, fn); };
const countNodes = (root) => { let c = 0; walk(root, () => c++); return c; };
const findPage = (figma, name) => figma.root.children.find((p) => p.name === name);
const findFirst = (root, pred) => {
  let hit = null;
  walk(root, (n) => { if (!hit && pred(n)) hit = n; });
  return hit;
};

/* ------------------------------------------------------------------ 开跑 */

const figma = createFigma({ fileName: 'Design System 迭代测试' });
await loadPlugin(figma);

console.log('\n\x1b[1m插件单元测试\x1b[0m（Figma API 桩 + 真实 plugin/code.js）\n');

/* --- 1. 基础握手 --- */
await test('ping 返回文件与页面信息', async () => {
  const r = await send(figma, 'ping');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.file, 'Design System 迭代测试');
  assert.ok(Array.isArray(r.data.pages));
  // 版本号跟着 code.js 的 VERSION 走，这里只验「是合法 semver」，不锁死具体值
  assert.match(r.data.version, /^\d+\.\d+\.\d+$/, `version 应为 semver，收到「${r.data.version}」`);
});

/* --- 2. 渲染（同时验证渲染引擎在桩上可跑） --- */
let renderedNodes = 0;
await test('render 把 5 屏渲染到指定页面', async () => {
  const r = await send(figma, 'render', { spec: SPEC, pageName: 'FIMG Prototype' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.frames.length, 5);
  const page = findPage(figma, 'FIMG Prototype');
  assert.ok(page, '页面未创建');
  assert.equal(page.children.length, 5);
  renderedNodes = countNodes(page) - 1;   // 减掉 page 自身
  assert.ok(renderedNodes > 1000, `节点数偏少: ${renderedNodes}`);
});

/* --- 3. render 默认不清空（在现有稿上迭代的关键安全保障） --- */
await test('render 默认「不清空页面」', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const before = page.children.length;
  const r = await send(figma, 'render', { spec: SPEC, pageName: 'FIMG Prototype' });
  assert.equal(r.ok, true, r.error);
  assert.equal(page.children.length, before + 5, '默认不应清空');
});

await test('render --clear 才清空页面', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const r = await send(figma, 'render', { spec: SPEC, pageName: 'FIMG Prototype', clear: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(page.children.length, 5, 'clear:true 应只剩本次渲染的 5 屏');
});

/* --- 4. dump：读取出来的结构与 SPEC_DSL 对齐 --- */
await test('dump 读回顶层 Frame 的关键字段', async () => {
  const r = await send(figma, 'dump', { name: '01 行情', maxDepth: 2 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.nodes.length, 1);
  const n = r.data.nodes[0];
  assert.equal(n.type, 'FRAME');
  assert.equal(n.name, '01 行情');
  assert.equal(n.w, 390);
  assert.equal(n.h, 844);
  assert.equal(n.layout, 'V');
  assert.ok(n.id, 'dump 必须带 id（patch 要用）');
  assert.ok(Array.isArray(n.children) || n.childCount > 0);
});

await test('dump 能读到嵌套的 auto-layout 与文本属性', async () => {
  const r = await send(figma, 'dump', { name: '01 行情', maxDepth: 8, maxNodes: 4000 });
  assert.equal(r.ok, true, r.error);
  const root = r.data.nodes[0];
  const text = findFirst(root, (x) => x.type === 'TEXT' && x.text);
  assert.ok(text, '没读到任何文本节点');
  assert.equal(typeof text.text, 'string');
  assert.equal(typeof text.size, 'number');
  assert.ok(text.font && text.fontStyle, '文本缺少字体信息');
  const auto = findFirst(root, (x) => x.layout);
  assert.ok(auto, '没读到 auto-layout 容器');
  assert.ok(Array.isArray(auto.pad));
  assert.ok(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'].includes(auto.main));
});

/* --- 5. 颜色往返：写入 hex → 读回 hex --- */
await test('填充色 hex 往返一致', async () => {
  const rect = figma.createRectangle();
  rect.name = 'roundtrip';
  rect.fills = [{ type: 'SOLID', color: { r: 232 / 255, g: 69 / 255, b: 60 / 255 }, opacity: 1 }];
  rect.cornerRadius = 8;
  figma.currentPage.appendChild(rect);
  const r = await send(figma, 'dump', { ids: [rect.id] });
  const n = r.data.nodes[0];
  assert.equal(n.fill, '#E8453C');
  assert.equal(n.radius, 8);
});

await test('带透明度的填充读成 #RRGGBBAA', async () => {
  const rect = figma.createRectangle();
  rect.name = 'alpha';
  rect.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.1 }];
  figma.currentPage.appendChild(rect);
  const r = await send(figma, 'dump', { ids: [rect.id] });
  assert.equal(r.data.nodes[0].fill, '#0000001A');   // 0.1*255 ≈ 26 = 0x1A
});

await test('无填充读成 null（区别于读不到）', async () => {
  const rect = figma.createRectangle();
  rect.name = 'nofill';
  rect.fills = [];
  figma.currentPage.appendChild(rect);
  const r = await send(figma, 'dump', { ids: [rect.id] });
  assert.equal(r.data.nodes[0].fill, null);
});

/* --- 6. patch：核心迭代能力 --- */
await test('patch 按通配名批量改属性，并回报审计信息', async () => {
  const r = await send(figma, 'patch', { ops: [{ name: 'Row·*', set: { opacity: 0.42 } }] });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.data.totalMatched > 0, '没匹配到任何节点');
  const applied = r.data.results[0].applied;
  assert.ok(applied.length > 0);
  assert.ok(applied[0].changes, '缺少 changes 审计');
  assert.equal(applied[0].changes.opacity.to, 0.42);
  const page = findPage(figma, 'FIMG Prototype');
  const row = findFirst(page, (n) => n.name.startsWith('Row·'));
  assert.equal(row.opacity, 0.42, '属性没有真正写入');
});

await test('patch dryRun 只计算不写入', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const row = findFirst(page, (n) => n.name.startsWith('Row·'));
  const before = row.opacity;
  const r = await send(figma, 'patch', { ops: [{ name: 'Row·*', set: { opacity: 0.9 } }], dryRun: true });
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.results[0].applied[0].changes.opacity.to, 0.9, '审计里应记录目标值');
  assert.equal(row.opacity, before, 'dryRun 不应写入');
});

await test('patch 按 id 改文本内容', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const text = findFirst(page, (n) => n.type === 'TEXT' && n.characters === '贵州茅台');
  assert.ok(text, '找不到「贵州茅台」文本节点');
  const r = await send(figma, 'patch', { ops: [{ id: text.id, set: { text: '贵州茅台(改)' } }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(text.characters, '贵州茅台(改)');
});

await test('patch 能按「文案内容」选中节点（图层名不可靠时唯一的手段）', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  // 先放一个图层名毫无意义的文本，模拟真实设计稿
  const t = figma.createText();
  t.name = 'Text';
  t.characters = '提交订单';
  page.appendChild(t);

  const r = await send(figma, 'patch', { ops: [{ text: '提交订单', set: { text: '确认支付' } }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.totalMatched, 1, '应只命中那一个文本');
  assert.equal(t.characters, '确认支付');
  assert.equal(t.name, 'Text', '图层名不应被改动');
});

await test('patch 按文案通配匹配多个节点', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  // 注意：* 匹配空串，所以前缀必须唯一，否则会撞上已渲染的同名文案
  for (const s of ['ZZ·按钮', 'ZZ·提示']) {
    const t = figma.createText();
    t.name = 'T';
    t.characters = s;
    page.appendChild(t);
  }
  const r = await send(figma, 'patch', { ops: [{ text: 'ZZ·*', set: { fontSize: 18 } }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.totalMatched, 2);
  assert.equal(r.data.results[0].applied[0].changes.fontSize.to, 18);
});

await test('patch 按正则名匹配', async () => {
  const r = await send(figma, 'patch', { ops: [{ name: '/^Index·/', set: { name: '指数卡' } }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.totalMatched, 3, '上证/深证/创业板 三张指数卡');
});

await test('patch 改 auto-layout 的 gap 与 pad', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const auto = findFirst(page, (n) => n.layoutMode === 'HORIZONTAL');
  assert.ok(auto, '找不到横向 auto-layout');
  const r = await send(figma, 'patch', {
    ops: [{ id: auto.id, set: { gap: 21, pad: [4, 8, 4, 8] } }],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(auto.itemSpacing, 21);
  assert.equal(auto.paddingTop, 4);
  assert.equal(auto.paddingRight, 8);
  assert.equal(auto.paddingBottom, 4);
  assert.equal(auto.paddingLeft, 8);
});

await test('patch 未匹配时报错而不是静默成功', async () => {
  const r = await send(figma, 'patch', { ops: [{ name: '根本不存在的图层xyz', set: { opacity: 1 } }] });
  assert.equal(r.ok, true);
  assert.equal(r.data.results[0].matched, 0);
  assert.ok(r.data.results[0].error);
});

await test('patch 在 auto-layout 父容器里改 x/y 会给出警告', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const auto = findFirst(page, (n) => n.layoutMode === 'VERTICAL' && n.children.length);
  const child = auto.children[0];
  const r = await send(figma, 'patch', { ops: [{ id: child.id, set: { x: 999 } }] });
  assert.equal(r.ok, true, r.error);
  const changes = r.data.results[0].applied[0].changes;
  assert.ok(changes.position && changes.position.error, '应提示 x/y 会被忽略');
});

/* --- 7. list --- */
await test('list 输出树状大纲且带 id', async () => {
  const r = await send(figma, 'list', { maxDepth: 2 });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.data.lines > 0);
  assert.match(r.data.outline, /FRAME 01 行情/);
  assert.match(r.data.outline, /#[a-z]\d+:0/);
});

/* --- 8. insert --- */
await test('insert 往现有容器里追加节点', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const target = findFirst(page, (n) => n.type === 'FRAME' && n.layoutMode === 'VERTICAL');
  const before = target.children.length;
  const r = await send(figma, 'insert', {
    parentId: target.id,
    spec: { type: 'TEXT', text: '插入的测试文本', size: 12, color: '#FF0000', w: 120, h: 20 },
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.created.length, 1);
  assert.equal(target.children.length, before + 1);
  const added = target.children[target.children.length - 1];
  assert.equal(added.characters, '插入的测试文本');
});

await test('insert 找不到父容器时报错', async () => {
  const r = await send(figma, 'insert', { parentId: '不存在', spec: { type: 'RECT', w: 10, h: 10 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /找不到插入目标/);
});

await test('insert --dry 不创建节点，只回报计划', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const target = findFirst(page, (n) => n.type === 'FRAME' && n.layoutMode === 'VERTICAL');
  const before = target.children.length;
  const r = await send(figma, 'insert', {
    parentId: target.id,
    dryRun: true,
    spec: { type: 'RECT', name: 'dry方块', w: 10, h: 10, fill: '#00FF00' },
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.created[0].name, 'dry方块');
  assert.equal(r.data.created[0].id, null, 'dry-run 不应产出新 id');
  assert.equal(target.children.length, before, '节点数必须不变');
});

/* --- 9. remove --- */
await test('remove dryRun 不删除', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const before = countNodes(page);
  const r = await send(figma, 'remove', { name: 'Row·*', dryRun: true });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.data.count > 0);
  assert.equal(countNodes(page), before, 'dryRun 不应删除');
});

await test('remove 真正删除并回报清单', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const before = countNodes(page);
  const r = await send(figma, 'remove', { text: '插入的测试文本' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.count, 1);
  assert.ok(countNodes(page) < before);
});

await test('remove 超过上限时要求 force', async () => {
  const r = await send(figma, 'remove', { type: 'FRAME', maxRemove: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /超过上限/);
});

/* --- 10. selection --- */
await test('selection 读回当前选区', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const frame = page.children[0];
  figma.currentPage.selection = [frame];
  const r = await send(figma, 'selection', {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.action, 'get');
  assert.equal(r.data.count, 1);
  assert.equal(r.data.nodes[0].name, frame.name);
});

await test('selection 用 ids 设置选区', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const ids = page.children.slice(0, 2).map((n) => n.id);
  figma.currentPage.selection = [];
  const r = await send(figma, 'selection', { ids });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.action, 'set');
  assert.equal(figma.currentPage.selection.length, 2);
});

/* --- 11. dump 的 scope 与默认行为 --- */
await test('dump 在有选区时默认读选区', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  figma.currentPage = page;
  figma.currentPage.selection = [page.children[0]];
  const r = await send(figma, 'dump', { maxDepth: 1 });
  assert.equal(r.data.scope, 'selection');
  assert.equal(r.data.rootCount, 1);
});

await test('dump 的 maxDepth 生效并标记截断', async () => {
  figma.currentPage.selection = [];
  const r = await send(figma, 'dump', { name: '01 行情', maxDepth: 1, maxNodes: 100000 });
  const root = r.data.nodes[0];
  assert.ok(root.children, '深度 1 应该有直接子节点');
  // maxDepth=1 时，深度 1 的节点不再展开，而应标注 childCount + truncated
  const cut = findFirst(root, (n) => n.truncated);
  assert.ok(cut, '更深的层应标记截断');
  assert.ok(cut.childCount > 0, '截断处应给出 childCount');
  assert.equal(cut.children, undefined, '截断处不应带 children');
});

/* --- 12. 未知指令不静默 --- */
await test('未知指令报错', async () => {
  const r = await send(figma, 'nonsense', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /未知指令/);
});

/* --- 13. dump → patch 字段对称（回写必须真的生效） --- */
await test('dump 出来的字段能直接回写成 patch 的 set（别名归一）', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  figma.currentPage = page;
  figma.currentPage.selection = [];

  // 找一个文本节点，dump 出它，改掉再回写
  const dumped = await send(figma, 'dump', { name: '01 行情', maxDepth: 8, maxNodes: 4000 });
  const root = dumped.data.nodes[0];
  const textNode = findFirst(root, (n) => n.type === 'TEXT' && n.text);
  assert.ok(textNode, '没找到文本节点');

  // dump 用的是 size / autoResize / clip / sizing，set 只认规范名——别名必须补齐
  const alias = {
    size: 19,
    autoResize: 'HEIGHT',
    clip: false,
  };
  const r = await send(figma, 'patch', { ops: [{ id: textNode.id, set: alias }] });
  assert.equal(r.ok, true, r.error);
  const applied = r.data.results[0].applied[0];
  assert.equal(applied.changes.fontSize.to, 19, 'size 别名没落到 fontSize');
  assert.equal(applied.changes.textAutoResize.to, 'HEIGHT', 'autoResize 别名没落到 textAutoResize');
  assert.equal(applied.changes.clipsContent.to, false, 'clip 别名没落到 clipsContent');

  // 真读回来核对（不是只看审计字段）
  const back = await send(figma, 'dump', { ids: [textNode.id], maxDepth: 0 });
  assert.equal(back.data.nodes[0].size, 19);
  assert.equal(back.data.nodes[0].autoResize, 'HEIGHT');
});

await test('sizing 别名落到 layoutSizingHorizontal/Vertical', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const frame = page.children[0];
  const r = await send(figma, 'patch', {
    ops: [{ id: frame.id, set: { sizing: { h: 'FILL', v: 'FIXED' } } }],
  });
  assert.equal(r.ok, true, r.error);
  const a = r.data.results[0].applied[0];
  assert.equal(a.changes.sizingH.to, 'FILL');
  assert.equal(a.changes.sizingV.to, 'FIXED');
  assert.equal(frame.layoutSizingHorizontal, 'FILL');
});

await test('规范名优先于别名（显式 fontSize 不被 size 覆盖）', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const dumped = await send(figma, 'dump', { name: '01 行情', maxDepth: 8, maxNodes: 4000 });
  const textNode = findFirst(dumped.data.nodes[0], (n) => n.type === 'TEXT' && n.text);
  const r = await send(figma, 'patch', {
    ops: [{ id: textNode.id, set: { size: 11, fontSize: 22 } }],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.results[0].applied[0].changes.fontSize.to, 22);
});

await test('weight 别名落到 fontStyle（SPEC_DSL 的 weight 可直接 patch）', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const dumped = await send(figma, 'dump', { name: '01 行情', maxDepth: 8, maxNodes: 4000 });
  const textNode = findFirst(dumped.data.nodes[0], (n) => n.type === 'TEXT' && n.text);
  // weight: 500 → fontStyle "Medium"
  const r = await send(figma, 'patch', {
    ops: [{ id: textNode.id, set: { weight: 500 } }],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.results[0].applied[0].changes.font.to, 'PingFang SC Medium');
  const back = await send(figma, 'dump', { ids: [textNode.id], maxDepth: 0 });
  assert.equal(back.data.nodes[0].fontStyle, 'Medium');

  // 显式 fontStyle 优先于 weight
  const r2 = await send(figma, 'patch', {
    ops: [{ id: textNode.id, set: { weight: 700, fontStyle: 'Regular' } }],
  });
  assert.equal(r2.ok, true, r2.error);
  const back2 = await send(figma, 'dump', { ids: [textNode.id], maxDepth: 0 });
  assert.equal(back2.data.nodes[0].fontStyle, 'Regular', 'fontStyle 应优先于 weight');
});

/* --- 14. 无选择器护栏（防止一个漏写 id 的 op 改花整页） --- */
await test('patch 的无选择器 op 被拒绝，不会命中整页', async () => {
  const page = findPage(figma, 'FIMG Prototype');
  const before = page.children[0].name;
  const r = await send(figma, 'patch', { ops: [{ set: { name: '被误改' } }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.totalMatched, 0, '无选择器不应匹配任何节点');
  assert.match(r.data.results[0].error, /没有选择器/);
  assert.equal(page.children[0].name, before, '页面不应被改动');
});

await test('patch 的 all:true 才允许全量修改', async () => {
  const r = await send(figma, 'patch', {
    ops: [{ all: true, type: 'FRAME', set: { opacity: 0.9 } }],
  });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.data.totalMatched > 0, 'all:true 应真的匹配到节点');
  assert.equal(r.data.results[0].error, undefined);
});

await test('remove 的无选择器调用被拒绝', async () => {
  const r = await send(figma, 'remove', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /没有选择器/);
});

/* --- 15. 页名解析：读操作绝不新建页面，默认跟随当前页 --- */
await test('render 不指定页名时渲染到当前页，不新建页面', async () => {
  const namesBefore = figma.root.children.map((p) => p.name);
  const target = figma.root.children[0];
  target.name = '我的设计稿';
  await figma.setCurrentPageAsync(target);
  const namesAfterRename = figma.root.children.map((p) => p.name);

  const r = await send(figma, 'render', { spec: SPEC, clear: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.page, '我的设计稿', '应渲染到当前页');
  assert.deepEqual(figma.root.children.map((p) => p.name), namesAfterRename,
    '不应新建任何页面');
  assert.equal(namesAfterRename.length, namesBefore.length,
    '页面数量不应变化');
});

await test('render 显式给页名时仍然会创建（保持 SPEC_DSL 语义）', async () => {
  const r = await send(figma, 'render', { spec: SPEC, pageName: '专用页' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.page, '专用页');
  assert.ok(findPage(figma, '专用页'), '显式页名不存在时应创建');
});

await test('stats 不指定页名时报告当前页', async () => {
  const cur = figma.currentPage.name;
  const r = await send(figma, 'stats', {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.pageName, cur);
  assert.ok(r.data.target, '当前页应有统计结果');
});

await test('stats 页名写错时明确说明，而不是伪造结果', async () => {
  const r = await send(figma, 'stats', { pageName: '并不存在的页' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.target, null);
  assert.match(r.data.note, /未找到页面/);
});

await test('clear 不指定页名时清空当前页，且不新建页面', async () => {
  const pagesBefore = figma.root.children.length;
  const cur = figma.currentPage;
  const r = await send(figma, 'clear', {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.page, cur.name);
  assert.equal(cur.children.length, 0, '当前页应被清空');
  assert.equal(figma.root.children.length, pagesBefore, '不应新建页面');
});

await test('clear 页名不存在时不动任何页面', async () => {
  const pagesBefore = figma.root.children.length;
  const r = await send(figma, 'clear', { pageName: '并不存在的页' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.removed, 0);
  assert.match(r.data.note, /不存在/);
  assert.equal(figma.root.children.length, pagesBefore);
});

await test('dump 支持 pageName（读非当前页）', async () => {
  const other = findPage(figma, '我的设计稿');
  assert.ok(other, '前置用例应已渲染到「我的设计稿」');
  const cur = figma.root.children[0] === other ? figma.root.children[1] : figma.root.children[0];
  await figma.setCurrentPageAsync(cur);
  figma.currentPage.selection = [];
  const r = await send(figma, 'dump', { pageName: '我的设计稿', maxDepth: 1, maxNodes: 10 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.page, '我的设计稿');
  assert.ok(r.data.rootCount > 0, '应读到「我的设计稿」上的节点');
});

await test('export 支持 pageName（导出非当前页的顶层 Frame）', async () => {
  const other = findPage(figma, '我的设计稿');
  assert.ok(other, '前置用例应已渲染到「我的设计稿」');
  // 切到别的页，证明 export 确实按 pageName 找页，而不是偷懒用 currentPage
  const cur = figma.root.children.find((p) => p !== other);
  await figma.setCurrentPageAsync(cur);
  figma.currentPage.selection = [];
  const r = await send(figma, 'export', { all: true, pageName: '我的设计稿', scale: 1 });
  assert.equal(r.ok, true, r.error);
  assert.ok(Array.isArray(r.data.files) && r.data.files.length > 0, '应导出「我的设计稿」上的 Frame');
  assert.ok(r.data.files.every((f) => typeof f.base64 === 'string' && f.base64.length > 0));
});

/* --- 16. 读写对称：layout / wrap / blendMode / effects / strokeAlign / positioning ---
 * 这些字段以前 dump 有、applySet 没有 —— 读得出来但写不回去。
 * 每一个都必须「写 → 读回 → 再写回」闭环。
 */

const useMainPage = () => {
  const page = findPage(figma, 'FIMG Prototype');
  figma.currentPage = page;
  figma.currentPage.selection = [];
  return page;
};

await test('layout 模式可切换：V → H → NONE → V', async () => {
  const page = useMainPage();
  const frame = page.children[0];
  assert.equal(frame.layoutMode, 'VERTICAL', '前置用例应渲染成纵向布局');

  let r = await send(figma, 'patch', { ops: [{ id: frame.id, set: { layout: 'H' } }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.results[0].applied[0].changes.layout.to, 'HORIZONTAL');
  assert.equal(frame.layoutMode, 'HORIZONTAL');

  await send(figma, 'patch', { ops: [{ id: frame.id, set: { layout: 'NONE' } }] });
  assert.equal(frame.layoutMode, 'NONE', 'layout:NONE 应能关掉 auto-layout');

  await send(figma, 'patch', { ops: [{ id: frame.id, set: { layout: 'V' } }] });
  assert.equal(frame.layoutMode, 'VERTICAL');
});

await test('同一个 op 里「先切 layout 再设 gap/pad」都生效（顺序正确）', async () => {
  const page = useMainPage();
  const frame = page.children[0];
  await send(figma, 'patch', { ops: [{ id: frame.id, set: { layout: 'NONE' } }] });
  const r = await send(figma, 'patch', { ops: [{ id: frame.id, set: { layout: 'V', gap: 7, pad: 3 } }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(frame.layoutMode, 'VERTICAL');
  assert.equal(frame.itemSpacing, 7, '切模式与设 gap 在同一个 op 里必须都生效');
  assert.equal(frame.paddingTop, 3);
});

await test('wrap 可写（layoutWrap 往返）', async () => {
  const page = useMainPage();
  const frame = page.children[0];
  const r = await send(figma, 'patch', { ops: [{ id: frame.id, set: { wrap: true } }] });
  assert.equal(r.data.results[0].applied[0].changes.wrap.to, 'WRAP');
  assert.equal(frame.layoutWrap, 'WRAP');
  await send(figma, 'patch', { ops: [{ id: frame.id, set: { wrap: false } }] });
  assert.equal(frame.layoutWrap, 'NO_WRAP');
});

await test('blendMode 可写（dump 只在非 PASS_THROUGH 时输出，回写必须生效）', async () => {
  const page = useMainPage();
  const frame = page.children[0];
  const r = await send(figma, 'patch', { ops: [{ id: frame.id, set: { blendMode: 'MULTIPLY' } }] });
  assert.equal(r.data.results[0].applied[0].changes.blendMode.to, 'MULTIPLY');
  assert.equal(frame.blendMode, 'MULTIPLY');

  // dump 必须读得出来，否则回写会丢
  const d = await send(figma, 'dump', { ids: [frame.id], maxDepth: 0 });
  assert.equal(d.data.nodes[0].blendMode, 'MULTIPLY');

  await send(figma, 'patch', { ops: [{ id: frame.id, set: { blendMode: 'PASS_THROUGH' } }] });
  assert.equal(frame.blendMode, 'PASS_THROUGH');
});

await test('effects 往返：写阴影 → dump 读回 hex → 再写回，颜色与几何一致', async () => {
  const page = useMainPage();
  const frame = page.children[0];
  const spec = [{ type: 'DROP_SHADOW', radius: 10, spread: 2, offset: { x: 0, y: 4 }, color: '#00000040' }];

  let r = await send(figma, 'patch', { ops: [{ id: frame.id, set: { effects: spec } }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.results[0].applied[0].changes.effects.to, 'DROP_SHADOW');
  assert.equal(frame.effects.length, 1);
  assert.equal(frame.effects[0].type, 'DROP_SHADOW');
  assert.equal(frame.effects[0].radius, 10);
  assert.ok(Math.abs(frame.effects[0].color.a - 0x40 / 255) < 1e-9, 'alpha 应还原成 0x40');

  // dump 读回 → hex
  const d = await send(figma, 'dump', { ids: [frame.id], maxDepth: 0 });
  const readBack = d.data.nodes[0].effects;
  assert.equal(readBack[0].color, '#00000040', 'effect 颜色应读成带 alpha 的 hex');
  assert.equal(readBack[0].radius, 10);
  assert.equal(readBack[0].spread, 2);
  // 注意：dump 的对象产生在 vm 沙箱里，原型与测试进程不同，
  // 所以不能用 deepStrictEqual 比较整个对象，逐字段比。
  assert.equal(readBack[0].offset.x, 0);
  assert.equal(readBack[0].offset.y, 4);

  // 再写回（用 dump 的字段原样）→ 必须等价
  r = await send(figma, 'patch', { ops: [{ id: frame.id, set: { effects: readBack } }] });
  assert.equal(frame.effects[0].color.a, 0x40 / 255);
  assert.equal(frame.effects[0].radius, 10);

  // 清空
  await send(figma, 'patch', { ops: [{ id: frame.id, set: { effects: [] } }] });
  assert.equal(frame.effects.length, 0);
});

await test('effects 支持 LAYER_BLUR 与多效果叠加', async () => {
  const page = useMainPage();
  const frame = page.children[0];
  const r = await send(figma, 'patch', {
    ops: [{
      id: frame.id,
      set: {
        effects: [
          { type: 'LAYER_BLUR', radius: 6 },
          { type: 'DROP_SHADOW', radius: 4, offset: { x: 1, y: 2 }, color: '#11223380' },
        ],
      },
    }],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.results[0].applied[0].changes.effects.to, 'LAYER_BLUR+DROP_SHADOW');
  assert.equal(frame.effects.length, 2);
  assert.equal(frame.effects[0].type, 'LAYER_BLUR');
  assert.equal(frame.effects[0].radius, 6);
  assert.ok(Math.abs(frame.effects[1].color.a - 0x80 / 255) < 1e-9);
  await send(figma, 'patch', { ops: [{ id: frame.id, set: { effects: [] } }] });
});

await test('strokeAlign 可写', async () => {
  const page = useMainPage();
  const frame = page.children[0];
  const r = await send(figma, 'patch', {
    ops: [{ id: frame.id, set: { stroke: '#FF0000', strokeWeight: 2, strokeAlign: 'OUTSIDE' } }],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(frame.strokeAlign, 'OUTSIDE');
  const d = await send(figma, 'dump', { ids: [frame.id], maxDepth: 0 });
  assert.equal(d.data.nodes[0].strokeAlign, 'OUTSIDE');
  await send(figma, 'patch', { ops: [{ id: frame.id, set: { stroke: null, strokeWeight: 1, strokeAlign: 'INSIDE' } }] });
});

await test('positioning:ABSOLUTE 让 x/y 在 auto-layout 父容器里生效', async () => {
  const page = useMainPage();
  const parent = page.children[0];
  assert.notEqual(parent.layoutMode, 'NONE', '父容器应是 auto-layout');

  const ins = await send(figma, 'insert', {
    parentId: parent.id,
    specs: [{ type: 'RECT', name: '覆盖层', w: 100, h: 40, fill: '#FF0000' }],
  });
  assert.equal(ins.ok, true, ins.error);
  const id = ins.data.created[0].id;

  // ① 普通子节点改 x/y → 必须明确报错（而不是静默无效）
  let r = await send(figma, 'patch', { ops: [{ id, set: { x: 12 } }] });
  assert.match(r.data.results[0].applied[0].changes.position.error, /auto-layout/);

  // ② 同一个 op 里先转绝对定位再给 x/y → 必须都生效
  r = await send(figma, 'patch', { ops: [{ id, set: { positioning: 'ABSOLUTE', x: 12, y: 34 } }] });
  assert.equal(r.ok, true, r.error);
  const a = r.data.results[0].applied[0].changes;
  assert.equal(a.positioning.to, 'ABSOLUTE');
  assert.equal(a.position.error, undefined, '转成绝对定位后 x/y 不应再被拒绝');
  assert.equal(a.position.to, '12,34');

  // ③ dump 要读得出 positioning，否则回写会丢掉覆盖层语义
  const d = await send(figma, 'dump', { ids: [id], maxDepth: 0 });
  assert.equal(d.data.nodes[0].positioning, 'ABSOLUTE');

  // ④ 改回 AUTO 后，x/y 又该被拒绝
  r = await send(figma, 'patch', { ops: [{ id, set: { positioning: 'AUTO', x: 1 } }] });
  assert.match(r.data.results[0].applied[0].changes.position.error, /auto-layout/);
});

await test('insert 的 SPEC_DSL 支持 positioning:ABSOLUTE', async () => {
  const page = useMainPage();
  const parent = page.children[0];
  const r = await send(figma, 'insert', {
    parentId: parent.id,
    specs: [{
      type: 'RECT', name: '底部渐变遮罩', w: 390, h: 60,
      fill: '#FFFFFF00', positioning: 'ABSOLUTE', x: 0, y: 727,
    }],
  });
  assert.equal(r.ok, true, r.error);
  const node = await figma.getNodeByIdAsync(r.data.created[0].id);
  assert.equal(node.layoutPositioning, 'ABSOLUTE');
  assert.equal(node.y, 727, '绝对定位的子节点应保留 x/y');
});

/* --- 17. 结构操作：move / dup / group / ungroup --- */

/** 造一个干净的纵向 auto-layout 容器，里面 A/B/C 三个方块 */
async function makeSandbox() {
  const page = useMainPage();
  const r = await send(figma, 'insert', {
    parentId: page.id,
    specs: [{
      type: 'FRAME', name: '结构测试容器', w: 400, h: 300, layout: 'V', fill: '#FFFFFF',
      children: [
        { type: 'RECT', name: 'A', w: 100, h: 20, fill: '#FF0000' },
        { type: 'RECT', name: 'B', w: 100, h: 20, fill: '#00FF00' },
        { type: 'RECT', name: 'C', w: 100, h: 20, fill: '#0000FF' },
      ],
    }],
  });
  assert.equal(r.ok, true, r.error);
  const box = await figma.getNodeByIdAsync(r.data.created[0].id);
  const order = () => box.children.map((c) => c.name);
  return { page, box, order };
}

await test('move 能改变同一容器内的顺序（index 语义）', async () => {
  const { box, order } = await makeSandbox();
  assert.deepEqual(order(), ['A', 'B', 'C']);

  let r = await send(figma, 'move', { name: 'C', parentId: box.id, index: 0 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.moved[0].index, 0);
  assert.deepEqual(order(), ['C', 'A', 'B'], 'auto-layout 里 index 0 应排最前');

  r = await send(figma, 'move', { name: 'A', parentId: box.id });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.moved[0].index, 2);
  assert.deepEqual(order(), ['C', 'B', 'A'], '不给 index 应落到末尾');
});

await test('move 能跨容器搬移', async () => {
  const { page, box, order } = await makeSandbox();
  const other = await send(figma, 'insert', {
    parentId: page.id,
    specs: [{ type: 'FRAME', name: '目标容器', w: 400, h: 100, layout: 'V' }],
  });
  const otherId = other.data.created[0].id;
  const bId = box.children.find((c) => c.name === 'B').id;
  const r = await send(figma, 'move', { id: bId, parentId: otherId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.moved[0].from.name, '结构测试容器');
  assert.equal(r.data.moved[0].to.name, '目标容器');
  assert.deepEqual(order(), ['A', 'C']);
  const tgt = await figma.getNodeByIdAsync(otherId);
  assert.deepEqual(tgt.children.map((c) => c.name), ['B']);
});

await test('within 把选择器限定在某个容器内（同名图层遍地时唯一可靠的办法）', async () => {
  const a = await makeSandbox();
  const b = await makeSandbox();
  // 页面上现在有两组 A/B/C；不给范围会同时命中
  const all = await send(figma, 'patch', { ops: [{ name: 'A', set: { opacity: 0.5 } }], dryRun: true });
  assert.ok(all.data.totalMatched >= 2, '不给 within 应命中多个同名节点');

  // 给了 within 只命中目标容器里的那一个
  const scoped = await send(figma, 'patch', {
    ops: [{ name: 'A', within: a.box.id, set: { opacity: 0.5 } }],
    dryRun: true,
  });
  assert.equal(scoped.data.totalMatched, 1);
  assert.equal(scoped.data.results[0].applied[0].id, a.box.children.find((c) => c.name === 'A').id);
  void b;
});

await test('dump --within 不带条件时读该容器的子树（保留层级）', async () => {
  const { box } = await makeSandbox();
  const r = await send(figma, 'dump', { within: box.id, maxDepth: 2 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.scope, 'within');
  assert.equal(r.data.rootCount, 1, '应以容器本身为根');
  assert.equal(r.data.nodes[0].id, box.id);
  assert.deepEqual(r.data.nodes[0].children.map((c) => c.name), ['A', 'B', 'C']);
});

await test('dump --within 找不到容器时报错', async () => {
  const r = await send(figma, 'dump', { within: '999:999' });
  assert.equal(r.ok, false);
  assert.match(r.error, /找不到容器/);
});

await test('type 选择器同时认 DSL 名与 Figma 原生名（RECT / RECTANGLE）', async () => {
  const { box } = await makeSandbox();
  const asDsl = await send(figma, 'dump', { type: 'RECT', within: box.id, maxDepth: 1 });
  const asNative = await send(figma, 'dump', { type: 'RECTANGLE', within: box.id, maxDepth: 1 });
  assert.equal(asDsl.ok, true, asDsl.error);
  assert.equal(asDsl.data.rootCount, 3, '--type RECT 应匹配到 3 个方块（别名归一到 RECTANGLE）');
  assert.equal(asNative.data.rootCount, 3);
});

await test('move 拦住「把节点移进自己的子树」', async () => {
  const { box } = await makeSandbox();
  const aId = box.children[0].id;
  const r = await send(figma, 'move', { id: box.id, parentId: aId });
  assert.equal(r.ok, true, r.error);
  assert.match(r.data.moved[0].error, /自己的子树/);
  assert.ok(box.parent, '容器不应被搬走');
});

await test('move 找不到目标父容器时报错', async () => {
  await makeSandbox();
  const r = await send(figma, 'move', { name: 'A', parentId: '999:999' });
  assert.equal(r.ok, false);
  assert.match(r.error, /找不到目标父容器/);
});

await test('dup 复制整棵子树并给出新 id', async () => {
  const { box, order } = await makeSandbox();
  const before = box.children.length;
  const aId = box.children.find((c) => c.name === 'A').id;
  const r = await send(figma, 'dup', { id: aId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.count, 1);
  assert.equal(box.children.length, before + 1);
  const created = r.data.created[0];
  assert.equal(created.of, 'A', '要报出复制自谁');
  assert.equal(order().length, 4);
});

await test('dup 支持 count 与 dx/dy 偏移（非 auto-layout 容器里）', async () => {
  const page = useMainPage();
  const host = await send(figma, 'insert', {
    parentId: page.id,
    specs: [{ type: 'FRAME', name: '自由容器', w: 400, h: 300 }],   // 无 layout
  });
  const hostId = host.data.created[0].id;
  const seed = await send(figma, 'insert', {
    parentId: hostId,
    specs: [{ type: 'RECT', name: '种子', w: 50, h: 50, x: 10, y: 20, fill: '#123456' }],
  });
  const seedId = seed.data.created[0].id;
  const r = await send(figma, 'dup', { id: seedId, count: 2, dx: 60, dy: 5 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.count, 2);
  const host2 = await figma.getNodeByIdAsync(hostId);
  const copies = host2.children.filter((c) => c.name === '种子');
  assert.equal(copies.length, 3);
  assert.equal(copies[1].x, 70, '第一个副本应有偏移');
  assert.equal(copies[2].x, 130);
});

await test('dup 超过数量上限时要求 force', async () => {
  const { box } = await makeSandbox();
  const r = await send(figma, 'dup', { type: 'RECT', within: box.id, maxDup: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /超过上限/);
});

await test('group / ungroup 往返：子节点不丢', async () => {
  const { box, order } = await makeSandbox();
  const before = order();
  const r = await send(figma, 'group', { parentId: box.id, ids: box.children.map((c) => c.id), rename: '一组' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.group.type, 'GROUP');
  assert.equal(r.data.group.name, '一组');
  assert.equal(box.children.length, 1, '三个子节点应收进一个组');
  assert.equal(box.children[0].type, 'GROUP');

  const u = await send(figma, 'ungroup', { id: box.children[0].id });
  assert.equal(u.ok, true, u.error);
  assert.equal(u.data.groups[0].released, 3);
  assert.deepEqual(order(), before, '解组后顺序与内容应还原');
});

await test('group 拒绝跨父容器的节点', async () => {
  const { page, box } = await makeSandbox();
  const other = await send(figma, 'insert', {
    parentId: page.id,
    specs: [{ type: 'RECT', name: '外人', w: 10, h: 10 }],
  });
  const r = await send(figma, 'group', { ids: [box.children[0].id, other.data.created[0].id] });
  assert.equal(r.ok, false);
  assert.match(r.error, /同一个父容器/);
});

/* --- 18. 本地样式读写 --- */

await test('patch 能按名字应用本地文本样式，dump 读回名字', async () => {
  const page = useMainPage();
  const d = await send(figma, 'dump', { name: '01 行情', maxDepth: 8, maxNodes: 4000 });
  const text = findFirst(d.data.nodes[0], (n) => n.type === 'TEXT' && n.text);

  const r = await send(figma, 'patch', { ops: [{ id: text.id, set: { textStyle: '标题/H1' } }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.results[0].applied[0].changes.textStyle.to, '标题/H1');

  const back = await send(figma, 'dump', { ids: [text.id], maxDepth: 0 });
  assert.equal(back.data.nodes[0].textStyle.name, '标题/H1');
  assert.equal(back.data.nodes[0].textStyle.id, 'S:text1');
});

await test('样式也能按 id 应用，且能被解除', async () => {
  const page = useMainPage();
  const d = await send(figma, 'dump', { name: '01 行情', maxDepth: 8, maxNodes: 4000 });
  const text = findFirst(d.data.nodes[0], (n) => n.type === 'TEXT' && n.text);

  // 注意：dump 出来的是快照对象，要核对属性必须取活节点
  const live = await figma.getNodeByIdAsync(text.id);
  let r = await send(figma, 'patch', { ops: [{ id: text.id, set: { textStyle: 'S:text2' } }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(live.textStyleId, 'S:text2');

  r = await send(figma, 'patch', { ops: [{ id: text.id, set: { textStyle: null } }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(live.textStyleId, '', 'null 应解除样式引用');
});

await test('样式名写错时报错并列出可选项', async () => {
  const page = useMainPage();
  const d = await send(figma, 'dump', { name: '01 行情', maxDepth: 8, maxNodes: 4000 });
  const text = findFirst(d.data.nodes[0], (n) => n.type === 'TEXT' && n.text);
  const r = await send(figma, 'patch', { ops: [{ id: text.id, set: { fillStyle: '并不存在的样式' } }] });
  assert.equal(r.ok, true, r.error);
  assert.match(r.data.results[0].applied[0].changes.fillStyle.error, /找不到本地样式/);
  assert.match(r.data.results[0].applied[0].changes.fillStyle.error, /品牌\/主色/, '应提示可选项');
});

await test('填充/描边/效果样式都能应用', async () => {
  const { box } = await makeSandbox();
  const r = await send(figma, 'patch', {
    ops: [{
      id: box.children[0].id,
      set: { fillStyle: '品牌/主色', strokeStyle: 'S:paint1', effectStyle: '投影/Card' },
    }],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(box.children[0].fillStyleId, 'S:paint1');
  assert.equal(box.children[0].strokeStyleId, 'S:paint1');
  assert.equal(box.children[0].effectStyleId, 'S:effect1');
});

await test('styles 列出本地样式，patch 可按名字使用', async () => {
  const r = await send(figma, 'styles', {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.text.length, 2);
  assert.ok(r.data.text.some((s) => s.name === '标题/H1' && s.id === 'S:text1'));
  assert.ok(r.data.paint.some((s) => s.name === '品牌/主色'));
  assert.ok(r.data.effect.some((s) => s.name === '投影/Card'));
});

/* --- 19. 图片填充读写 --- */

await test('图片填充：base64 写入 → dump 读回 imageHash → 按 hash 复用', async () => {
  const { box } = await makeSandbox();
  const target = box.children[0];
  const b64 = Buffer.from('fake-png-bytes-for-stub').toString('base64');

  let r = await send(figma, 'patch', {
    ops: [{ id: target.id, set: { fill: { image: b64, scaleMode: 'FIT' } } }],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(target.fills[0].type, 'IMAGE');
  assert.equal(target.fills[0].scaleMode, 'FIT');
  const hash = target.fills[0].imageHash;

  const d = await send(figma, 'dump', { ids: [target.id], maxDepth: 0 });
  const fill = d.data.nodes[0].fill;
  assert.equal(fill.image, true);
  assert.equal(fill.imageHash, hash);
  assert.equal(fill.scaleMode, 'FIT');

  const other = box.children[1];
  r = await send(figma, 'patch', { ops: [{ id: other.id, set: { fill } }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(other.fills[0].imageHash, hash, '按 imageHash 复用应拿到同一张图');
});

await test('dataURI 写法也能用', async () => {
  const { box } = await makeSandbox();
  const target = box.children[2];
  const uri = 'data:image/png;base64,' + Buffer.from('another-image').toString('base64');
  const r = await send(figma, 'patch', { ops: [{ id: target.id, set: { fill: { image: uri } } }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(target.fills[0].type, 'IMAGE');
  assert.equal(target.fills[0].scaleMode, 'FILL', '默认 scaleMode 应为 FILL');
});

/* --- 19.5 dry-run 必须真的不写入（曾有 bug：--dry 只跳过 commitUndo，照改不误） --- */

await test('move --dry 不改变顺序', async () => {
  const { box, order } = await makeSandbox();
  const before = order();
  const r = await send(figma, 'move', { name: 'C', within: box.id, parentId: box.id, index: 0, dryRun: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.moved[0].index, 0, '应报出会落到哪个 index');
  assert.match(r.data.moved[0].note, /dry-run/);
  assert.deepEqual(order(), before, 'dry-run 绝不能改动顺序');
});

await test('dup --dry 不创建副本', async () => {
  const { box } = await makeSandbox();
  const before = box.children.length;
  const r = await send(figma, 'dup', { name: 'A', within: box.id, count: 3, dryRun: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.count, 3, '应报出会复制几个');
  assert.equal(box.children.length, before, 'dry-run 绝不能新增节点');
  // dry-run 不该报出"副本 id"——只有源 id
  assert.equal(r.data.created[0].id, undefined, 'dry-run 不能伪造成副本已存在');
  assert.ok(r.data.created[0].sourceId, '应该给出源节点 id');
});

await test('component --dry 不转换', async () => {
  const { box } = await makeSandbox();
  const r = await send(figma, 'component', { id: box.id, rename: 'X', dryRun: true });
  assert.equal(r.ok, true, r.error);
  assert.match(r.data.created[0].note, /dry-run/);
  const live = await figma.getNodeByIdAsync(box.id);
  assert.equal(live.type, 'FRAME', 'dry-run 绝不能把 Frame 变成组件');
});

await test('instance --dry 不创建实例', async () => {
  const { page, box } = await makeSandbox();
  const c = await send(figma, 'component', { id: box.id, rename: '干跑组件' });
  const before = page.children.length;
  const r = await send(figma, 'instance', { of: c.data.created[0].id, parentId: page.id, count: 2, dryRun: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.count, 2);
  assert.equal(r.data.dryRun, true);
  assert.equal(page.children.length, before, 'dry-run 绝不能新增实例');
});

await test('swap --dry 不换主组件', async () => {
  const { page, box } = await makeSandbox();
  const c1 = await send(figma, 'component', { id: box.id, rename: '干跑A' });
  const { box: box2 } = await makeSandbox();
  const c2 = await send(figma, 'component', { id: box2.id, rename: '干跑B' });
  const inst = await send(figma, 'instance', { of: c1.data.created[0].id, parentId: page.id });
  const instId = inst.data.created[0].id;

  const r = await send(figma, 'swap', { id: instId, to: c2.data.created[0].id, dryRun: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.swapped[0].to, '干跑B', '应报出会换成哪个');
  const live = await figma.getNodeByIdAsync(instId);
  assert.equal((await live.getMainComponentAsync()).name, '干跑A', 'dry-run 绝不能真的换掉');
});

await test('detach --dry 不脱离', async () => {
  const { page, box } = await makeSandbox();
  const c = await send(figma, 'component', { id: box.id, rename: '干跑脱离' });
  const inst = await send(figma, 'instance', { of: c.data.created[0].id, parentId: page.id });
  const instId = inst.data.created[0].id;

  const r = await send(figma, 'detach', { id: instId, dryRun: true });
  assert.equal(r.ok, true, r.error);
  const live = await figma.getNodeByIdAsync(instId);
  assert.equal(live.type, 'INSTANCE', 'dry-run 绝不能脱离');
});

await test('group --dry 不成组', async () => {
  const { box, order } = await makeSandbox();
  const before = order();
  const r = await send(figma, 'group', { within: box.id, ids: box.children.map((c) => c.id), dryRun: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.dryRun, true);
  assert.match(r.data.note, /dry-run/);
  assert.deepEqual(order(), before, 'dry-run 绝不能成组');
});

await test('ungroup --dry 不解组', async () => {
  const { box } = await makeSandbox();
  const g = await send(figma, 'group', { within: box.id, ids: box.children.map((c) => c.id), rename: '干跑组' });
  const groupId = g.data.group.id;
  const r = await send(figma, 'ungroup', { id: groupId, dryRun: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.detached, undefined);
  assert.match(r.data.groups[0].note, /dry-run/);
  const live = await figma.getNodeByIdAsync(groupId);
  assert.equal(live.type, 'GROUP', 'dry-run 绝不能解组');
});

/* --- 20. 组件 / 实例 --- */

await test('component 把 FRAME 原地转成 COMPONENT（保留结构）', async () => {
  const { box } = await makeSandbox();
  const r = await send(figma, 'component', { id: box.id, rename: '卡片组件' });
  assert.equal(r.ok, true, r.error);
  const c = r.data.created[0];
  assert.equal(c.type, 'COMPONENT');
  assert.equal(c.name, '卡片组件');
  const live = await figma.getNodeByIdAsync(c.id);
  assert.equal(live.type, 'COMPONENT');
  assert.equal(live.children.length, 3, '子节点应保留');
});

await test('component 拒绝 RECT 这类不能转组件的节点', async () => {
  const { box } = await makeSandbox();
  const r = await send(figma, 'component', { id: box.children[0].id });
  assert.equal(r.ok, true, r.error);
  assert.match(r.data.created[0].error, /不能转成组件/);
});

await test('instance 放置组件实例，并带上 mainComponent', async () => {
  const { page, box } = await makeSandbox();
  const c = await send(figma, 'component', { id: box.id, rename: '按钮组件' });
  const compId = c.data.created[0].id;

  const r = await send(figma, 'instance', { of: compId, parentId: page.id, count: 2, x: 10, y: 10 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.count, 2);
  assert.equal(r.data.component.name, '按钮组件');

  const inst = await figma.getNodeByIdAsync(r.data.created[0].id);
  assert.equal(inst.type, 'INSTANCE');
  const mc = await inst.getMainComponentAsync();
  assert.equal(mc.id, compId);

  const d = await send(figma, 'dump', { ids: [inst.id], maxDepth: 0 });
  assert.equal(d.data.nodes[0].mainComponent.name, '按钮组件');
  assert.ok(d.data.nodes[0].componentProperties, '应读出 componentProperties');
});

await test('instance --of-name 能找到组件；同名多个时明确提示', async () => {
  const { page, box } = await makeSandbox();
  await send(figma, 'component', { id: box.id, rename: '唯一组件' });
  const r = await send(figma, 'instance', { ofName: '唯一组件', parentId: page.id });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.count, 1);

  const { box: box2 } = await makeSandbox();
  await send(figma, 'component', { id: box2.id, rename: '唯一组件' });
  const r2 = await send(figma, 'instance', { ofName: '唯一组件', parentId: page.id });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.data.ambiguous, 2, '同名组件多个时必须报出来');
});

await test('instance 找不到组件时报错', async () => {
  const r = await send(figma, 'instance', { ofName: '不存在的组件' });
  assert.equal(r.ok, false);
  assert.match(r.error, /找不到名为/);
});

await test('swap 换实例的主组件', async () => {
  const { page, box } = await makeSandbox();
  const c1 = await send(figma, 'component', { id: box.id, rename: '组件A' });
  const { box: box2 } = await makeSandbox();
  const c2 = await send(figma, 'component', { id: box2.id, rename: '组件B' });

  const inst = await send(figma, 'instance', { of: c1.data.created[0].id, parentId: page.id });
  const instId = inst.data.created[0].id;

  const r = await send(figma, 'swap', { id: instId, to: c2.data.created[0].id });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.swapped[0].from, '组件A');
  assert.equal(r.data.swapped[0].to, '组件B');
  const live = await figma.getNodeByIdAsync(instId);
  assert.equal((await live.getMainComponentAsync()).name, '组件B');
});

await test('swap 对非实例报错', async () => {
  const { page, box } = await makeSandbox();
  // 目标必须是一个真组件，否则会在解析组件那步就抛错，走不到"不是实例"的判断
  const c = await send(figma, 'component', { id: box.id, rename: '合法组件' });
  // 转成组件之后原 Frame 节点已被替换，要从新组件上取子节点
  const comp = await figma.getNodeByIdAsync(c.data.created[0].id);
  const r = await send(figma, 'swap', { id: comp.children[0].id, to: c.data.created[0].id });
  assert.equal(r.ok, true, r.error);
  assert.match(r.data.swapped[0].error, /不是实例/);
  void page;
});

await test('detach 把实例变成普通 FRAME', async () => {
  const { page, box } = await makeSandbox();
  const c = await send(figma, 'component', { id: box.id, rename: '待脱离' });
  const inst = await send(figma, 'instance', { of: c.data.created[0].id, parentId: page.id });
  const instId = inst.data.created[0].id;

  const r = await send(figma, 'detach', { id: instId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.detached[0].name, '待脱离');
  const live = await figma.getNodeByIdAsync(instId);
  assert.equal(live, null, '原实例应已不存在');
  const detached = await figma.getNodeByIdAsync(r.data.detached[0].detachedTo.id);
  assert.equal(detached.type, 'FRAME');
});

/* --- 21. 原型交互 --- */

await test('link 建交互，reactions 读回并解析目标名', async () => {
  const { page, box } = await makeSandbox();
  const from = box.children[0].id;
  const to = page.children[0].id;

  let r = await send(figma, 'link', { id: from, to, trigger: 'ON_CLICK', nav: 'NAVIGATE' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.nodes[0].after, 1);

  r = await send(figma, 'reactions', { id: from });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.count, 1);
  const rx = r.data.nodes[0].reactions[0];
  assert.equal(rx.trigger.type, 'ON_CLICK');
  assert.equal(rx.actions[0].type, 'NODE');
  assert.equal(rx.actions[0].navigation, 'NAVIGATE');
  assert.equal(rx.actions[0].destination.id, to);
  assert.ok(rx.actions[0].destination.name, '目标名应被解析出来');
  assert.equal(rx.actions[0].transition.type, 'SMART_ANIMATE');
});

await test('link 支持 URL 动作、AFTER_TIMEOUT、OVERLAY', async () => {
  const { box } = await makeSandbox();
  const from = box.children[0].id;
  let r = await send(figma, 'link', { id: from, url: 'https://example.com' });
  assert.equal(r.ok, true, r.error);
  r = await send(figma, 'reactions', { id: from });
  assert.equal(r.data.nodes[0].reactions[0].actions[0].type, 'URL');
  assert.equal(r.data.nodes[0].reactions[0].actions[0].url, 'https://example.com');

  r = await send(figma, 'link', {
    id: from, to: box.id, trigger: 'AFTER_TIMEOUT', timeout: 2, nav: 'OVERLAY',
    transition: 'DISSOLVE', duration: 0.5,
  });
  assert.equal(r.ok, true, r.error);
  const rx = (await send(figma, 'reactions', { id: from })).data.nodes[0].reactions[0];
  assert.equal(rx.trigger.type, 'AFTER_TIMEOUT');
  assert.equal(rx.trigger.timeout, 2);
  assert.equal(rx.actions[0].navigation, 'OVERLAY');
  assert.equal(rx.actions[0].transition.type, 'DISSOLVE');
  assert.equal(rx.actions[0].transition.duration, 0.5);
});

await test('link --append 追加，--clear 清空', async () => {
  const { box } = await makeSandbox();
  const from = box.children[0].id;
  await send(figma, 'link', { id: from, to: box.id });
  let r = await send(figma, 'link', { id: from, to: box.id, append: true });
  assert.equal(r.data.nodes[0].after, 2, '--append 应保留原有交互');

  r = await send(figma, 'link', { id: from, clear: true });
  assert.equal(r.data.nodes[0].after, 0);
  const rx = await send(figma, 'reactions', { id: from });
  assert.equal(rx.data.count, 0, '清空后不应再有交互');
});

await test('link 校验 trigger / nav / transition 取值', async () => {
  const { box } = await makeSandbox();
  const from = box.children[0].id;
  let r = await send(figma, 'link', { id: from, to: box.id, nav: 'TELEPORT' });
  assert.equal(r.ok, false);
  assert.match(r.error, /nav 只能是/);

  r = await send(figma, 'link', { id: from, to: box.id, transition: 'EXPLODE' });
  assert.equal(r.ok, false);
  assert.match(r.error, /transition 只能是/);

  r = await send(figma, 'link', { id: from, trigger: 'ON_SNEEZE' });
  assert.equal(r.ok, false);
  assert.match(r.error, /trigger 只能是/);
});

await test('link 校验 easing 取值', async () => {
  const { box } = await makeSandbox();
  const from = box.children[0].id;
  const r = await send(figma, 'link', { id: from, to: box.id, easing: 'YEET' });
  assert.equal(r.ok, false);
  assert.match(r.error, /easing 只能是/);

  // 合法 easing 仍然能写
  const ok = await send(figma, 'link', { id: from, to: box.id, easing: 'EASE_IN_AND_OUT' });
  assert.equal(ok.ok, true, ok.error);
});

await test('link 不给目的地时报错', async () => {
  const { box } = await makeSandbox();
  const r = await send(figma, 'link', { id: box.children[0].id });
  assert.equal(r.ok, false);
  assert.match(r.error, /要连到哪里/);
});

await test('交互读写对称：dump 输出 reactions，patch 能原样写回', async () => {
  const { box } = await makeSandbox();
  const from = box.children[0].id;
  await send(figma, 'link', { id: from, to: box.id, nav: 'NAVIGATE' });

  const d = await send(figma, 'dump', { ids: [from], maxDepth: 0 });
  const dumped = d.data.nodes[0].reactions;
  assert.ok(Array.isArray(dumped) && dumped.length === 1, 'dump 应输出 reactions');

  await send(figma, 'patch', { ops: [{ id: from, set: { reactions: [] } }] });
  assert.equal((await send(figma, 'reactions', { id: from })).data.count, 0);

  const r = await send(figma, 'patch', { ops: [{ id: from, set: { reactions: dumped } }] });
  assert.equal(r.ok, true, r.error);
  const rx = (await send(figma, 'reactions', { id: from })).data.nodes[0].reactions[0];
  assert.equal(rx.trigger.type, 'ON_CLICK');
  assert.equal(rx.actions[0].destination.id, box.id);
});

/* --- 页面管理（迭代工作流） --- */

await test('page list 列出页面并识别 beta/release', async () => {
  const r = await send(figma, 'page', { action: 'list' });
  assert.equal(r.ok, true, r.error);
  assert.ok(Array.isArray(r.data.pages));
  assert.ok(r.data.pages.length >= 1);
  assert.equal(typeof r.data.current, 'string');
});

await test('page create 建页并插到最上方', async () => {
  const before = figma.root.children.map((p) => p.name);
  const r = await send(figma, 'page', {
    action: 'create',
    name: '2026-10-04-测试迭代-beta.1',
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.index, 0, '新页面应插到 index 0');
  assert.equal(figma.root.children[0].name, '2026-10-04-测试迭代-beta.1');
  assert.equal(figma.root.children.length, before.length + 1);
  // beta 命名识别
  const list = await send(figma, 'page', { action: 'list' });
  const rec = list.data.pages.find((p) => p.name === '2026-10-04-测试迭代-beta.1');
  assert.equal(rec.kind, 'beta');
  assert.equal(rec.rev, 1);
  assert.equal(rec.base, '2026-10-04-测试迭代');
});

await test('page create --copy 复制源页内容', async () => {
  // 先确保有一个有内容的源页
  const srcName = 'FIMG Prototype';
  const src = figma.root.children.find((p) => p.name === srcName);
  assert.ok(src && src.children.length > 0, '前置：源页应有节点');
  const r = await send(figma, 'page', {
    action: 'create',
    name: '2026-10-04-复制测试-beta.1',
    copyFrom: srcName,
  });
  assert.equal(r.ok, true, r.error);
  const created = figma.root.children.find((p) => p.name === '2026-10-04-复制测试-beta.1');
  assert.equal(created.children.length, src.children.length, '子节点数应一致');
});

await test('page rename 重命名页面', async () => {
  const r = await send(figma, 'page', {
    action: 'rename',
    name: '2026-10-04-复制测试-beta.1',
    to: '2026-10-04-复制测试-beta.2',
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.to, '2026-10-04-复制测试-beta.2');
  const list = await send(figma, 'page', { action: 'list' });
  const rec = list.data.pages.find((p) => p.name === '2026-10-04-复制测试-beta.2');
  assert.equal(rec.kind, 'beta');
  assert.equal(rec.rev, 2);
});

await test('page promote 把 beta 升为 release', async () => {
  const r = await send(figma, 'page', {
    action: 'promote',
    name: '2026-10-04-复制测试-beta.2',
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.to, '2026-10-04-复制测试');
  assert.equal(figma.root.children[0].name, '2026-10-04-复制测试', 'release 应插到最上方');
  const list = await send(figma, 'page', { action: 'list' });
  const rec = list.data.pages.find((p) => p.name === '2026-10-04-复制测试');
  assert.equal(rec.kind, 'release');
});

await test('page delete 需要 confirm，删除后页面消失', async () => {
  let r = await send(figma, 'page', { action: 'delete', name: '2026-10-04-测试迭代-beta.1' });
  assert.equal(r.ok, false, '没有 confirm 应被拒绝');
  assert.match(r.error, /confirm/);

  r = await send(figma, 'page', { action: 'delete', name: '2026-10-04-测试迭代-beta.1', confirm: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.deleted, 1);
  const list = await send(figma, 'page', { action: 'list' });
  assert.ok(!list.data.pages.find((p) => p.name === '2026-10-04-测试迭代-beta.1'));
});

await test('page 命名识别：无 -beta.N 的视为 release', async () => {
  const r = await send(figma, 'page', { action: 'list' });
  const any = r.data.pages.find((p) => !p.name.includes('-beta.'));
  if (any) {
    assert.equal(any.kind, 'release');
    assert.equal(any.rev, 0);
  }
});

/* ---------------------------------------------------------------- 汇总 */

console.log(results.join('\n'));
console.log(`\n\x1b[1m结果:\x1b[0m ${passed} 通过, ${failed} 失败  (渲染节点数 ${renderedNodes})\n`);
process.exit(failed ? 1 : 0);
