/* 规格静态校验：在没有 Figma 的情况下先把明显错误筛出来
 * 用法： node specs/validate-spec.mjs [specs/xxx.json]   （缺省 stock-app.json） */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const specPath = process.argv[2] || path.join(HERE, 'stock-app.json');
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

const TYPES = new Set(['FRAME', 'RECT', 'ELLIPSE', 'TEXT', 'LINE']);
const SIZE = (v) => v === undefined || typeof v === 'number' || v === 'fill' || v === 'hug';
const problems = [];
const stats = { frames: 0, texts: 0, rects: 0, ellipses: 0, maxDepth: 0, autoLayout: 0 };

function walk(n, pathStr, depth, parentAuto) {
  stats.maxDepth = Math.max(stats.maxDepth, depth);
  const t = (n.type || 'FRAME').toUpperCase();
  if (!TYPES.has(t)) problems.push(`${pathStr}: 未知 type=${n.type}`);
  else if (t === 'FRAME') stats.frames++;
  else if (t === 'TEXT') stats.texts++;
  else if (t === 'RECT') stats.rects++;
  else if (t === 'ELLIPSE') stats.ellipses++;

  if (!SIZE(n.w)) problems.push(`${pathStr}: w 非法 (${JSON.stringify(n.w)})`);
  if (!SIZE(n.h)) problems.push(`${pathStr}: h 非法 (${JSON.stringify(n.h)})`);
  if (t === 'TEXT' && (n.text === undefined || n.text === null)) problems.push(`${pathStr}: TEXT 缺 text`);

  // 填充/描边的对象写法必须是「渐变」或「图片」之一，且字段齐全。
  // 写错了插件只会静默当成"没填"，画布上少一块，很难查。
  for (const key of ['fill', 'stroke']) {
    const v = n[key];
    for (const item of Array.isArray(v) ? v : [v]) {
      if (!item || typeof item !== 'object') continue;
      if (item.gradient) {
        if (!Array.isArray(item.stops) || !item.stops.length) {
          problems.push(`${pathStr}: ${key} 是渐变但缺 stops`);
        }
      } else if (typeof item.image === 'string') {
        if (!item.image.length) problems.push(`${pathStr}: ${key}.image 是空字符串`);
      } else if (item.imageHash) {
        // dump 读出来的形态（{image:true, imageHash}），可以原样回写
      } else if (item.color) {
        // 等价于字符串写法
      } else {
        problems.push(`${pathStr}: ${key} 对象形式无法识别（需要 gradient / image / imageHash / color）`);
      }
    }
  }

  const layout = n.layout ? String(n.layout).toUpperCase() : null;
  if (layout && !['V', 'VERTICAL', 'H', 'HORIZONTAL'].includes(layout)) {
    problems.push(`${pathStr}: layout 非法 (${n.layout})`);
  }
  const auto = !!layout;
  if (auto) stats.autoLayout++;

  // 非 auto-layout 容器里的子节点应有 x/y，否则会堆在 0,0
  if (!auto && (n.children || []).length > 1) {
    const missing = n.children.filter((c) => typeof c.x !== 'number' && c.type !== 'TEXT');
    if (missing.length === (n.children || []).length && t !== 'FRAME') {
      problems.push(`${pathStr}: 绝对定位容器 ${missing.length} 个子节点都没有 x`);
    }
    if (missing.length && missing.length === n.children.length) {
      problems.push(`${pathStr}: ${missing.length} 个子节点缺少 x/y（layer 会重叠）`);
    }
  }

  // auto-layout 子节点不该有 x/y（会被忽略），提醒一下。
  // 例外：positioning:"ABSOLUTE" 的子节点本来就脱离布局流，x/y 是有效的
  //（滚动淡出遮罩就是靠它叠在滚区底部）。
  const absolute = String(n.positioning || '').toUpperCase() === 'ABSOLUTE' || n.absolute === true;
  if (parentAuto && !absolute) {
    for (const k of ['x', 'y']) {
      if (typeof n[k] === 'number' && n[k] !== 0) problems.push(`${pathStr}: auto-layout 子节点带 ${k}，将被忽略（要覆盖层请加 positioning:"ABSOLUTE"）`);
    }
  }
  // positioning 只在小写 'ABSOLUTE' 时有意义，写错会被静默忽略
  if (n.positioning !== undefined && String(n.positioning).toUpperCase() !== 'ABSOLUTE') {
    problems.push(`${pathStr}: positioning 非法 (${JSON.stringify(n.positioning)})，应为 "ABSOLUTE"`);
  }

  // radius 不应超过较短边
  if (typeof n.radius === 'number' && typeof n.w === 'number' && typeof n.h === 'number') {
    if (n.radius > Math.min(n.w, n.h) / 2 + 0.01) {
      problems.push(`${pathStr}: radius ${n.radius} 超过短边一半 (${Math.min(n.w, n.h) / 2})`);
    }
  }

  const seen = new Set();
  for (const c of n.children || []) walk(c, `${pathStr} > ${c.name || c.type}`, depth + 1, auto);
  void seen;
}

for (const f of spec.frames) walk(f, f.name, 0, false);

console.log('统计:', stats);
console.log(`问题数: ${problems.length}`);
const shown = problems.slice(0, 40);
shown.forEach((p) => console.log('  ✖ ' + p));
if (problems.length > shown.length) console.log(`  … 还有 ${problems.length - shown.length} 条`);
