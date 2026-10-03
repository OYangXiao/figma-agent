/* =============================================================================
 * 炒股 App 原型 · 设计规格生成器
 * -----------------------------------------------------------------------------
 * 运行：node specs/build-stock-spec.mjs   →  specs/stock-app.json
 * 产物交给 Figma 插件（plugin/code.js）渲染成真实的 Frame / Auto Layout / 文本节点。
 *
 * 规格 DSL 速查：
 *   FRAME : layout('V'|'H') / w,h 可为数字 或 'fill'|'hug'
 *           pad [t,r,b,l]|[v,h]|num / gap / main(MIN|CENTER|MAX|SPACE_BETWEEN)
 *           cross(MIN|CENTER|MAX) / fill / radius / stroke / shadow / clip / wrap
 *   TEXT  : text / size / weight / color / align / valign / lineHeight / w
 *   RECT  : w,h,x,y,fill,radius,stroke,rotate
 *   RECT/FRAME 通用 : positioning('ABSOLUTE' = 脱离 auto-layout，按 x/y 叠在父容器上)
 *   fill  : '#RRGGBB' | '#RRGGBBAA' | {gradient,stops,angle}（angle 90 = 上→下，见 SPEC_DSL.md）
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ 设计变量 */

const C = {
  bg: '#F2F3F5',
  card: '#FFFFFF',
  cardAlt: '#F7F8FA',
  text: '#16181D',
  sub: '#8A9099',
  faint: '#C3C8D0',
  divider: '#EDEFF3',
  up: '#E8453C',      // A 股约定：红涨
  down: '#12A87A',    // 绿跌
  flat: '#8A9099',
  brand: '#E8453C',
  ma5: '#F0A020',
  ma10: '#3E7BFA',
  ma20: '#B25CE0',
};
const TR = '#00000000';
const W = 390;
const H = 844;
const COL = 460;      // 画板上每屏的横向间距
const ACTION_BAR_H = 76.5;

/* --------------------------------------------------------------- 构造快捷方式 */

const F = (o = {}) => ({ type: 'FRAME', ...o });
const R = (o = {}) => ({ type: 'RECT', ...o });
const E = (o = {}) => ({ type: 'ELLIPSE', ...o });
const T = (text, o = {}) => ({ type: 'TEXT', text, ...o });

const box = (o = {}) => F({ fill: TR, clip: false, ...o });
const col = (o = {}) => box({ layout: 'V', ...o });
const row = (o = {}) => box({ layout: 'H', cross: 'CENTER', ...o });
const px = (n) => Math.round(n * 100) / 100;

const upDown = (pct) => (pct > 0 ? C.up : pct < 0 ? C.down : C.flat);
const signed = (n, d = 2) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n).toFixed(d)}`;
const DIVIDER = (w = 'fill', color = C.divider) => R({ w, h: 0.5, fill: color });

/**
 * 把颜色按比例混到背景上，得到实色淡底。
 * 不要用「容器 opacity」做淡色底：Figma 的 opacity 会继承给子节点，
 * 胶囊里的文字会跟着变成半透明（在预览里表现为胶囊是空的）。
 */
function tint(hex, alpha, bg = '#FFFFFF') {
  const parse = (h) => {
    const s = h.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  };
  const a = parse(hex);
  const b = parse(bg);
  const mix = a.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)));
  return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/* ------------------------------------------------------------ 伪随机走势序列 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function series(seed, n, start = 100, vol = 0.012, drift = 0) {
  const rnd = mulberry32(seed);
  const out = [start];
  for (let i = 1; i < n; i++) {
    out.push(Math.max(0.01, out[i - 1] * (1 + (rnd() - 0.5) * 2 * vol + drift)));
  }
  return out;
}

/**
 * 均值回复的偏离序列（围绕 0 上下摆动）。
 * 纯随机游走会让分时图抖成锯齿山，OU 过程才像真实盘面。
 * 幅度约 ±vol/(1-revert)。
 */
function deviation(seed, n, vol = 0.012, revert = 0.88) {
  const rnd = mulberry32(seed);
  const out = [];
  let v = 0;
  for (let i = 0; i < n; i++) {
    v = v * revert + (rnd() - 0.5) * 2 * vol;
    out.push(v);
  }
  return out;
}

/** 分时量能：开盘/尾盘放量的 U 型包络 + 噪声 */
function volumeProfile(seed, n) {
  return Array.from({ length: n }, (_, i) => {
    const x = i / (n - 1);
    const u = 0.30 + 1.6 * Math.pow(x - 0.5, 2) * 2;   // 两端高、中间低
    const noise = 0.55 + mulberry32(seed + i)() * 0.9;
    return u * noise * 100;
  });
}

/* ------------------------------------------------------ 图元：折线 / 面积 / K线 */

/** 用「细长矩形 + 旋转」画折线——插件环境里最稳的实现 */
function polyline(pts, { color, weight = 1.5, opacity } = {}) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 0.05) continue;
    const ang = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
    out.push(R({
      w: px(len), h: weight, radius: weight / 2, fill: color, opacity,
      x: px((x0 + x1) / 2 - len / 2),
      y: px((y0 + y1) / 2 - weight / 2),
      rotate: ang,
    }));
  }
  return out;
}

function areaUnder(pts, baseline, { color, opacity = 0.10, width = 3 } = {}) {
  return pts.map(([x, y]) => R({
    x: px(x - width / 2), y: px(y), w: width,
    h: px(Math.max(0, baseline - y)), fill: color, opacity,
  }));
}

function project(values, { x0, y0, x1, y1, min, max }) {
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const n = values.length;
  return values.map((v, i) => [
    px(x0 + ((x1 - x0) * i) / Math.max(1, n - 1)),
    px(y1 - ((v - lo) / span) * (y1 - y0)),
  ]);
}

/* -------------------------------------------------------------------- 图标 */

const iconSearch = (size = 20, color = C.text) => box({
  name: 'ic-search', w: size, h: size, children: [
    E({ x: 0, y: 0, w: size * 0.72, h: size * 0.72, fill: null, stroke: color, strokeWeight: 1.7 }),
    R({ x: size * 0.62, y: size * 0.66, w: size * 0.44, h: 1.7, radius: 0.85, fill: color, rotate: 45 }),
  ],
});

const iconBack = (size = 22, color = C.text) => box({
  name: 'ic-back', w: size * 0.6, h: size, children: [
    R({ x: size * 0.10, y: size * 0.30, w: size * 0.46, h: 1.9, radius: 0.9, fill: color, rotate: -50 }),
    R({ x: size * 0.10, y: size * 0.58, w: size * 0.46, h: 1.9, radius: 0.9, fill: color, rotate: 50 }),
  ],
});

const iconMore = (size = 20, color = C.text) => row({
  name: 'ic-more', gap: 2.5, w: size, h: size, main: 'CENTER',
  children: [0, 1, 2].map(() => E({ w: 3, h: 3, fill: color })),
});

const iconStar = (size = 18, color = C.faint) => T('★', { size: size * 0.95, color, name: 'ic-star' });

/** 底部导航图标：用基础图元拼出来，比灰色方块像样得多 */
function tabIcon(kind, color) {
  const S = 22;
  const stroke = { fill: null, stroke: color, strokeWeight: 1.6 };
  if (kind === 'star') return T('★', { size: 17, color, name: 'tab-star' });
  if (kind === 'chart') return box({ name: 'tab-chart', w: S, h: S, children: [
    R({ x: 2, y: 10, w: 4, h: 9, radius: 1.5, fill: color }),
    R({ x: 9, y: 4, w: 4, h: 15, radius: 1.5, fill: color }),
    R({ x: 16, y: 7, w: 4, h: 12, radius: 1.5, fill: color }),
  ] });
  if (kind === 'wallet') return box({ name: 'tab-wallet', w: S, h: S, children: [
    R({ x: 2, y: 5, w: 18, h: 13, radius: 3.5, ...stroke }),
    E({ x: 13.5, y: 9.5, w: 5, h: 5, fill: color }),
  ] });
  if (kind === 'news') return box({ name: 'tab-news', w: S, h: S, children: [
    R({ x: 3.5, y: 3, w: 15, h: 16, radius: 3, ...stroke }),
    R({ x: 7, y: 8, w: 8, h: 1.6, radius: 0.8, fill: color }),
    R({ x: 7, y: 12, w: 5, h: 1.6, radius: 0.8, fill: color }),
  ] });
  return box({ name: 'tab-me', w: S, h: S, children: [
    E({ x: 7, y: 2.5, w: 8, h: 8, ...stroke }),
    R({ x: 3, y: 12, w: 16, h: 8, radius: 4, ...stroke }),
  ] });
}

/* --------------------------------------------------------------- 通用组件 */

function statusBar() {
  return row({
    name: 'StatusBar', w: W, h: 54, pad: [0, 22], main: 'SPACE_BETWEEN', fill: TR,
    children: [
      T('9:41', { size: 15, weight: 600, color: C.text }),
      row({ gap: 5, children: [
        R({ w: 17, h: 11, radius: 2, fill: C.text }),
        R({ w: 15, h: 11, radius: 2, fill: C.text }),
        R({ w: 25, h: 12, radius: 3.5, fill: C.text }),
      ] }),
    ],
  });
}

/** 个股详情底部固定的交易操作栏 */
function actionBar() {
  const btn = (label, o) => F({
    radius: 8, layout: 'H', main: 'CENTER', cross: 'CENTER', ...o,
    children: [T(label, { size: 14.5, weight: 600, color: o.textColor || '#FFFFFF' })],
  });
  return col({
    name: 'ActionBar', w: W, fill: C.card,
    children: [
      DIVIDER(),
      row({ w: W, h: 54, pad: [7, 16], gap: 10, children: [
        btn('自选', { w: 64, h: 40, stroke: C.faint, strokeWeight: 1, textColor: C.text }),
        btn('买入', { grow: 1, h: 40, fill: C.up }),
        btn('卖出', { grow: 1, h: 40, fill: C.down }),
      ] }),
      F({ w: W, h: 22, layout: 'H', main: 'CENTER', children: [
        R({ w: 134, h: 5, radius: 2.5, fill: '#D5D8DE' }),
      ] }),
    ],
  });
}

/* ============================== 屏幕 1 · 行情 ============================== */

const STOCKS = [
  { name: '贵州茅台', code: '600519', price: '1,682.00', pct: 1.24 },
  { name: '宁德时代', code: '300750', price: '196.35', pct: 2.86 },
  { name: '比亚迪', code: '002594', price: '245.80', pct: -0.94 },
  { name: '中国平安', code: '601318', price: '48.26', pct: 0.52 },
  { name: '招商银行', code: '600036', price: '35.74', pct: -1.32 },
  { name: '隆基绿能', code: '601012', price: '18.93', pct: 3.41 },
  { name: '五粮液', code: '000858', price: '138.60', pct: -0.28 },
  { name: '东方财富', code: '300059', price: '14.27', pct: 5.62 },
];

function sparkline(seed, color, w, h, trend = 0) {
  const n = 26;
  const dev = deviation(seed, n, 0.014, 0.85);
  const vals = dev.map((d, i) => 1 + d + trend * (i / (n - 1)));
  const pts = project(vals, { x0: 0, y0: 2, x1: w, y1: h - 2 });
  return box({ name: 'spark', w, h, clip: true, children: [
    ...areaUnder(pts, h, { color, opacity: 0.10, width: w / n + 0.6 }),
    ...polyline(pts, { color, weight: 1.4 }),
  ] });
}

function indexCard({ name, value, pct, seed }) {
  const color = upDown(pct);
  return F({
    name: `Index·${name}`, w: 'fill', h: 106, fill: C.card, radius: 10,
    layout: 'V', gap: 3, pad: [11, 11],
    children: [
      T(name, { size: 11, color: C.sub }),
      T(value, { size: 16, weight: 700, color, letterSpacing: -0.2 }),
      T(`${signed(pct)}%`, { size: 11, weight: 600, color }),
      sparkline(seed, color, 88, 22, (pct / 100) * 2.5),
    ],
  });
}

function stockRow(s, i) {
  const color = upDown(s.pct);
  return col({
    name: `Row·${s.name}`, w: 'fill',
    children: [
      row({
        w: 'fill', h: 59.5, pad: [0, 14], main: 'SPACE_BETWEEN', fill: C.card,
        children: [
          col({ gap: 3, w: 120, main: 'CENTER', children: [
            T(s.name, { size: 15, weight: 500, color: C.text }),
            T(s.code, { size: 11, color: C.sub }),
          ] }),
          T(s.price, { size: 16, weight: 600, color, align: 'RIGHT', w: 90 }),
          F({
            name: 'chip', w: 76, h: 30, radius: 6, fill: tint(color, 0.10),
            layout: 'V', main: 'CENTER', cross: 'CENTER',
            children: [T(`${signed(s.pct)}%`, { size: 13, weight: 600, color })],
          }),
        ],
      }),
      i < STOCKS.length - 1 ? row({ w: 'fill', h: 0.5, pad: [0, 14], fill: C.card, clip: false, children: [DIVIDER('fill')] }) : null,
    ].filter(Boolean),
  });
}

function marketTabs() {
  return row({
    name: 'MarketTabs', w: W, h: 42, pad: [0, 14], gap: 22, fill: C.card,
    children: ['自选', '沪深', '板块', '资金', '全球'].map((label, i) => col({
      gap: 5, main: 'MAX', cross: 'CENTER', h: 42,
      children: [
        T(label, { size: i === 0 ? 15 : 14, weight: i === 0 ? 600 : 400, color: i === 0 ? C.text : C.sub }),
        R({ w: 20, h: 2.5, radius: 1.25, fill: i === 0 ? C.brand : TR }),
      ],
    })),
  });
}

function tableHead() {
  return row({
    name: 'TableHead', w: W, h: 32, pad: [0, 14], main: 'SPACE_BETWEEN', fill: C.cardAlt,
    children: [
      T('名称 / 代码', { size: 11, color: C.sub, w: 120 }),
      T('最新价', { size: 11, color: C.sub, w: 90, align: 'RIGHT' }),
      T('涨跌幅', { size: 11, color: C.sub, w: 76, align: 'CENTER' }),
    ],
  });
}

function tabBar(active = 1) {
  const items = [
    ['自选', 'star'], ['行情', 'chart'], ['交易', 'wallet'], ['资讯', 'news'], ['我的', 'me'],
  ];
  return col({
    name: 'TabBar', w: W, fill: C.card,
    children: [
      DIVIDER(),
      row({
        w: W, h: 62, pad: [8, 8], main: 'SPACE_BETWEEN', cross: 'CENTER',
        children: items.map(([label, kind], i) => col({
          gap: 4, main: 'CENTER', cross: 'CENTER',
          children: [
            tabIcon(kind, i === active ? C.brand : C.faint),
            T(label, { size: 10, weight: i === active ? 600 : 400, color: i === active ? C.brand : C.sub }),
          ],
        })),
      }),
    ],
  });
}

function screenMarket() {
  const indices = [
    { name: '上证指数', value: '3,102.45', pct: 0.76, seed: 7 },
    { name: '深证成指', value: '9,845.12', pct: 1.32, seed: 21 },
    { name: '创业板指', value: '1,936.84', pct: -0.45, seed: 33 },
  ];
  return F({
    name: '01 行情', x: 0, y: 0, w: W, h: H, fill: C.bg, clip: true, layout: 'V', gap: 0,
    children: [
      col({ w: W, fill: C.card, children: [
        statusBar(),
        row({ name: 'Nav', w: W, h: 44, pad: [0, 16], main: 'SPACE_BETWEEN', fill: C.card, children: [
          T('行情', { size: 20, weight: 600, color: C.text }),
          row({ gap: 16, children: [iconSearch(20), iconMore(20)] }),
        ] }),
      ] }),
      col({ w: W, fill: C.bg, pad: [12, 12], children: [
        row({ w: 'fill', gap: 8, children: indices.map(indexCard) }),
      ] }),
      col({ w: W, fill: C.card, children: [marketTabs(), tableHead()] }),
      // 列表区吃掉剩余高度并裁剪，保证 TabBar 永远贴底
      F({ name: 'StockList', w: 'fill', h: 'fill', layout: 'V', clip: true, fill: C.card,
        children: STOCKS.map(stockRow) }),
      tabBar(1),
    ],
  });
}

/* ====================== 个股详情：公共部件 ====================== */

const STOCK = {
  name: '贵州茅台', code: '600519', price: 1682.00, prevClose: 1661.40,
  open: 1670.00, high: 1692.50, low: 1665.20, vol: '3.24万手', amount: '53.82亿',
  turnover: '0.26%', pe: '31.4', pb: '9.86', cap: '2.11万亿',
};
const pctChange = ((STOCK.price - STOCK.prevClose) / STOCK.prevClose) * 100;

function detailHeader(chartMode) {
  return col({ w: W, fill: C.card, children: [
    statusBar(),
    row({
      name: 'Nav', w: W, h: 48, pad: [0, 16], gap: 10, fill: C.card,
      children: [
        iconBack(22),
        col({ gap: 1, w: 'fill', main: 'CENTER', children: [
          T(STOCK.name, { size: 17, weight: 600, color: C.text }),
          T(STOCK.code, { size: 10, color: C.sub }),
        ] }),
        iconStar(20, C.faint),
        iconMore(20),
      ],
    }),
    priceHeader(),
    DIVIDER(),
    chartMode ? chartCard(chartMode) : null,
  ].filter(Boolean) });
}

function statCell(label, value, color = C.text) {
  return col({ gap: 4, w: 'fill', children: [
    T(label, { size: 11, color: C.sub }),
    T(value, { size: 12.5, weight: 500, color }),
  ] });
}

function priceHeader() {
  const color = upDown(pctChange);
  return col({
    name: 'PriceHeader', w: W, fill: C.card, pad: [4, 16, 12, 16], gap: 10,
    children: [
      row({ w: 'fill', main: 'SPACE_BETWEEN', cross: 'MAX', children: [
        col({ gap: 4, children: [
          T(STOCK.price.toFixed(2), { size: 33, weight: 700, color, letterSpacing: -0.6 }),
          T(`${signed(STOCK.price - STOCK.prevClose)}  ${signed(pctChange)}%`, { size: 13, weight: 600, color }),
        ] }),
        col({ gap: 3, cross: 'MAX', children: [
          T('已收盘', { size: 11, color: C.sub }),
          T('15:00:00', { size: 11, color: C.sub }),
        ] }),
      ] }),
      row({ w: 'fill', gap: 0, children: [
        statCell('今开', STOCK.open.toFixed(2), upDown(STOCK.open - STOCK.prevClose)),
        statCell('最高', STOCK.high.toFixed(2), upDown(STOCK.high - STOCK.prevClose)),
        statCell('成交量', STOCK.vol),
      ] }),
      row({ w: 'fill', gap: 0, children: [
        statCell('昨收', STOCK.prevClose.toFixed(2)),
        statCell('最低', STOCK.low.toFixed(2), upDown(STOCK.low - STOCK.prevClose)),
        statCell('成交额', STOCK.amount),
      ] }),
    ],
  });
}

const CHART_W = 358;
const CHART_H = 176;
const VOL_H = 52;

function chartTabs(active = 0) {
  return row({
    name: 'ChartTabs', w: W, h: 36, pad: [0, 16], gap: 20, fill: C.card,
    children: ['分时', '五日', '日K', '周K', '月K', '更多'].map((label, i) => col({
      main: 'MAX', cross: 'CENTER', gap: 6, h: 36,
      children: [
        T(label, { size: i === active ? 13.5 : 13, weight: i === active ? 600 : 400, color: i === active ? C.brand : C.sub }),
        R({ w: 18, h: 2.5, radius: 1.25, fill: i === active ? C.brand : TR }),
      ],
    })),
  });
}

function gridLines(x0, y0, w, h, rows = 4, cols = 4) {
  const out = [];
  for (let i = 1; i < rows; i++) out.push(R({ x: x0, y: px(y0 + (h * i) / rows), w, h: 0.5, fill: C.divider }));
  for (let i = 1; i < cols; i++) out.push(R({ x: px(x0 + (w * i) / cols), y: y0, w: 0.5, h, fill: C.divider }));
  return out;
}

/** 分时图：价格线 + 均价线 + 面积 + 量能柱 + 双击轴标签 */
function intradayChart() {
  // 右侧留给价格轴标签，否则折线会压到文字上
  const px0 = 8, py0 = 6, pw = CHART_W - 56, ph = CHART_H - 12;
  const n = 64;
  const anchor = STOCK.prevClose;
  // 均值回复 + 首尾收敛，再叠加从今开走向现价的趋势
  const amp = STOCK.price * 0.35;
  const shaped = deviation(101, n, 0.0022, 0.92).map((d, i) => {
    const t = i / (n - 1);
    const taper = 1 - Math.pow(2 * t - 1, 4);
    return STOCK.open + (STOCK.price - STOCK.open) * t + d * amp * taper;
  });
  const lo = Math.min(...shaped, anchor) * 0.9992;
  const hi = Math.max(...shaped, anchor) * 1.0008;
  const geo = { x0: px0, y0: py0, x1: px0 + pw, y1: py0 + ph, min: lo, max: hi };
  const pts = project(shaped, geo);
  // 均价线 = 累计均价（真实定义就是累计成交额/累计成交量）
  const avgPts = project(shaped.map((_, i) => {
    const s = shaped.slice(0, i + 1);
    return s.reduce((a, b) => a + b, 0) / s.length;
  }), geo);
  const anchorY = project([anchor], geo)[0][1];

  const volVals = volumeProfile(202, n);
  const maxVol = Math.max(...volVals);
  const volTop = VOL_H - 6;
  const color = upDown(pctChange);

  return col({ name: 'IntradayChart', w: 'fill', fill: C.card, pad: [0, 16, 8, 16], gap: 5, children: [
    box({ name: 'plot', w: CHART_W, h: CHART_H, clip: true, children: [
      ...gridLines(0, py0, px0 + pw, ph, 4, 4),
      R({ x: 0, y: px(anchorY), w: px0 + pw, h: 0.5, fill: C.faint, dash: [3, 3] }),
      ...areaUnder(pts, py0 + ph, { color, opacity: 0.13, width: pw / n + 0.8 }),
      ...polyline(pts, { color, weight: 1.5 }),
      ...polyline(avgPts, { color: C.ma5, weight: 1.1 }),
      T(hi.toFixed(2), { x: CHART_W - 46, y: 0, size: 9.5, color: C.up, w: 46, align: 'RIGHT' }),
      T(`${(((hi - anchor) / anchor) * 100).toFixed(2)}%`, { x: CHART_W - 46, y: 12, size: 9.5, color: C.up, w: 46, align: 'RIGHT' }),
      T(`${(((lo - anchor) / anchor) * 100).toFixed(2)}%`, { x: CHART_W - 46, y: py0 + ph - 24, size: 9.5, color: C.down, w: 46, align: 'RIGHT' }),
      T(lo.toFixed(2), { x: CHART_W - 46, y: py0 + ph - 12, size: 9.5, color: C.down, w: 46, align: 'RIGHT' }),
    ] }),
    row({ w: 'fill', gap: 14, children: [
      T('均价 1,681.20', { size: 10, color: C.ma5 }),
      T('昨收 1,661.40', { size: 10, color: C.sub }),
      T('量 3.24万手', { size: 10, color: C.sub }),
    ] }),
    box({ name: 'volume', w: CHART_W, h: VOL_H, clip: true, children: volVals.map((v, i) => {
      const hgt = (v / maxVol) * volTop;
      return R({
        x: px(px0 + (pw * i) / n), y: px(volTop - hgt), w: px(pw / n - 0.8), h: px(hgt),
        fill: i > 0 && volVals[i] >= volVals[i - 1] ? C.up : C.down, opacity: 0.6,
      });
    }) }),
  ] });
}

/** 日 K 线：真蜡烛图 + MA5 / MA10 */
function candleChart() {
  const px0 = 8, py0 = 10, pw = CHART_W - 58, ph = CHART_H - 20;
  const count = 34;
  const rnd = mulberry32(303);
  const closes = [];
  let price = 1600;
  for (let i = 0; i < count; i++) { price *= 1 + (rnd() - 0.465) * 0.022; closes.push(price); }
  const candles = closes.map((close, i) => {
    const open = i === 0 ? close * 0.995 : closes[i - 1];
    return {
      open, close,
      high: Math.max(open, close) * (1 + rnd() * 0.007),
      low: Math.min(open, close) * (1 - rnd() * 0.007),
    };
  });
  const hi = Math.max(...candles.map((c) => c.high));
  const lo = Math.min(...candles.map((c) => c.low));
  const yOf = (v) => px0 + ph - ((v - lo) / (hi - lo)) * ph;
  const step = pw / count;
  const bodyW = Math.max(3, step * 0.6);

  const nodes = [...gridLines(0, py0, px0 + pw, ph, 4, 4)];
  candles.forEach((c, i) => {
    const x = px0 + step * i + step / 2;
    const rise = c.close >= c.open;
    const color = rise ? C.up : C.down;
    nodes.push(R({ x: px(x - 0.5), y: yOf(c.high), w: 1, h: px(Math.max(1, yOf(c.low) - yOf(c.high))), fill: color }));
    const top = yOf(Math.max(c.open, c.close));
    const bottom = yOf(Math.min(c.open, c.close));
    nodes.push(R({
      x: px(x - bodyW / 2), y: top, w: px(bodyW), h: px(Math.max(1.5, bottom - top)),
      fill: rise ? TR : color, stroke: color, strokeWeight: 1,
    }));
  });
  const ma = (k) => closes.map((_, i) => (i < k - 1 ? null
    : closes.slice(i - k + 1, i + 1).reduce((a, b) => a + b, 0) / k));
  for (const [k, color] of [[5, C.ma5], [10, C.ma10]]) {
    const pts = ma(k).map((v, i) => (v == null ? null : [px0 + step * i + step / 2, yOf(v)])).filter(Boolean);
    nodes.push(...polyline(pts, { color, weight: 1.2 }));
  }

  const volTop = VOL_H - 6;
  const volHeights = candles.map((_, i) => 0.25 + mulberry32(400 + i)() * 0.75);
  return col({ name: 'CandleChart', w: 'fill', fill: C.card, pad: [0, 16, 8, 16], gap: 5, children: [
    row({ w: 'fill', gap: 14, children: [
      T(`MA5 ${closes[count - 1].toFixed(2)}`, { size: 10, color: C.ma5 }),
      T(`MA10 ${ma(10)[count - 1].toFixed(2)}`, { size: 10, color: C.ma10 }),
      T('MA20', { size: 10, color: C.ma20 }),
    ] }),
    box({ name: 'plot', w: CHART_W, h: CHART_H, clip: true, children: [
      ...gridLines(0, py0, CHART_W, ph, 4, 4),
      ...nodes,
      T(hi.toFixed(2), { x: CHART_W - 50, y: 0, size: 9.5, color: C.up, w: 50, align: 'RIGHT' }),
      T(lo.toFixed(2), { x: CHART_W - 50, y: py0 + ph - 12, size: 9.5, color: C.down, w: 50, align: 'RIGHT' }),
    ] }),
    box({ name: 'volume', w: CHART_W, h: VOL_H, clip: true, children: candles.map((c, i) => {
      const hgt = volHeights[i] * volTop;
      return R({
        x: px(px0 + step * i + step / 2 - bodyW / 2), y: px(volTop - hgt), w: px(bodyW), h: px(hgt),
        fill: c.close >= c.open ? C.up : C.down, opacity: 0.6,
      });
    }) }),
  ] });
}

const chartCard = (mode) => col({
  name: 'ChartCard', w: W, fill: C.card, gap: 0,
  children: [chartTabs(mode === 'intraday' ? 0 : 2), mode === 'intraday' ? intradayChart() : candleChart()],
});

/* ---------------------- 下方信息区：Tab 内容 ---------------------- */

function infoTabs(active = 0) {
  return col({ name: 'InfoTabs', w: W, fill: C.card, children: [
    DIVIDER(),
    row({
      w: W, h: 44, pad: [0, 16], gap: 24, cross: 'CENTER',
      children: ['盘口', '资金', '财务', '简况', '公告'].map((label, i) => col({
        main: 'MAX', cross: 'CENTER', gap: 6, h: 44,
        children: [
          T(label, { size: 14, weight: i === active ? 600 : 400, color: i === active ? C.text : C.sub }),
          R({ w: 22, h: 2.5, radius: 1.25, fill: i === active ? C.brand : TR }),
        ],
      })),
    }),
    DIVIDER(),
  ] });
}

function orderBook() {
  const asks = [['卖5', '1,682.60', '112'], ['卖4', '1,682.40', '86'], ['卖3', '1,682.20', '243'], ['卖2', '1,682.10', '57'], ['卖1', '1,682.00', '318']];
  const bids = [['买1', '1,681.90', '204'], ['买2', '1,681.80', '142'], ['买3', '1,681.60', '96'], ['买4', '1,681.50', '381'], ['买5', '1,681.30', '65']];
  const line = ([label, price, vol], isAsk) => row({
    w: 'fill', h: 25, main: 'SPACE_BETWEEN',
    children: [
      T(label, { size: 12, color: C.sub, w: 34 }),
      T(price, { size: 12.5, weight: 500, color: isAsk ? C.up : C.down, w: 74, align: 'RIGHT' }),
      T(vol, { size: 12, color: C.text, w: 52, align: 'RIGHT' }),
    ],
  });
  return col({ name: 'OrderBook', w: W, fill: C.card, pad: [10, 16, 10, 16], children: [
    row({ w: 'fill', main: 'SPACE_BETWEEN', children: [
      col({ gap: 0, w: 'fill', children: asks.map((a) => line(a, true)) }),
      R({ w: 0.5, h: 125, fill: C.divider }),
      col({ gap: 0, w: 'fill', children: bids.map((b) => line(b, false)) }),
    ] }),
  ] });
}

function recentTrades() {
  const rows = [
    ['14:59:58', '1,682.00', '12手', 'B', C.up],
    ['14:59:55', '1,681.90', '38手', 'S', C.down],
    ['14:59:51', '1,682.00', '7手', 'B', C.up],
    ['14:59:47', '1,681.80', '156手', 'S', C.down],
    ['14:59:40', '1,681.95', '23手', 'B', C.up],
  ];
  return col({ name: 'RecentTrades', w: W, fill: C.card, pad: [10, 16, 12, 16], gap: 8, children: [
    DIVIDER('fill'),
    T('最近成交', { size: 12, weight: 500, color: C.text }),
    ...rows.map(([t, p, v, dir, color]) => row({
      w: 'fill', h: 24, main: 'SPACE_BETWEEN',
      children: [
        T(t, { size: 12, color: C.sub, w: 78 }),
        T(p, { size: 12.5, weight: 500, color, w: 80, align: 'RIGHT' }),
        T(v, { size: 12, color: C.text, w: 60, align: 'RIGHT' }),
        T(dir === 'B' ? '买' : '卖', { size: 11.5, weight: 600, color, w: 24, align: 'RIGHT' }),
      ],
    })),
  ] });
}

/**
 * 占比条：按「本组最大值」归一化，否则占比只有 9% 时柱子几乎看不见。
 * 宽度用两个 grow 子节点按比例分配，比写百分比字符串可靠。
 */
function bar(label, value, pct, color, scale) {
  const p = Math.max(5, Math.min(100, (Math.abs(pct) / (scale || Math.abs(pct))) * 100));
  return col({ w: 'fill', gap: 5, children: [
    row({ w: 'fill', main: 'SPACE_BETWEEN', children: [
      T(label, { size: 12, color: C.sub }),
      T(value, { size: 12, weight: 500, color }),
    ] }),
    row({ w: 'fill', h: 6, gap: 0, radius: 3, clip: true, fill: C.divider, children: [
      F({ grow: p, h: 6, fill: color }),
      F({ grow: 100 - p, h: 6, fill: TR }),
    ] }),
  ] });
}

function fundFlow() {
  const recs = [
    ['超大单', '-1.12亿', -9.1, C.down],
    ['大单', '-1.22亿', -9.5, C.down],
    ['中单', '+0.86亿', 6.8, C.up],
    ['小单', '+1.48亿', 11.8, C.up],
  ];
  const days = [0.6, -1.2, 2.4, -0.8, 1.9, -2.34];
  const maxAbs = Math.max(...days.map(Math.abs));
  const maxPct = Math.max(...recs.map((r) => Math.abs(r[2])));
  return col({ name: 'FundFlow', w: W, fill: C.card, pad: [12, 16, 14, 16], gap: 11, children: [
    row({ w: 'fill', main: 'SPACE_BETWEEN', cross: 'MAX', children: [
      col({ gap: 4, children: [
        T('主力净流入', { size: 11, color: C.sub }),
        T('-2.34亿', { size: 22, weight: 700, color: C.down }),
      ] }),
      col({ gap: 4, cross: 'MAX', children: [
        T('占成交额', { size: 11, color: C.sub }),
        T('-4.35%', { size: 13, weight: 600, color: C.down }),
      ] }),
    ] }),
    col({ w: 'fill', gap: 9, children: recs.map(([l, v, p, c]) => bar(l, v, p, c, maxPct)) }),
    DIVIDER('fill'),
    col({ w: 'fill', gap: 8, children: [
      T('近 5 日主力净流入（亿元）', { size: 11, color: C.sub }),
      row({ w: 'fill', h: 78, gap: 14, children: days.map((d, i) => col({
        gap: 4, main: 'MAX', cross: 'CENTER', w: 'fill', h: 78,
        children: [
          T(d > 0 ? `+${d}` : `${d}`, { size: 9, color: d >= 0 ? C.up : C.down, align: 'CENTER' }),
          R({ w: 20, h: Math.max(4, (Math.abs(d) / maxAbs) * 46), radius: 2, fill: d >= 0 ? C.up : C.down }),
          T(['6/3', '6/4', '6/5', '6/6', '6/7', '今日'][i], { size: 9, color: C.sub }),
        ],
      })) }),
    ] }),
  ] });
}

function sectorRank() {
  const rows = [
    ['白酒', '-3.21亿', -12.4, C.down],
    ['银行', '+5.62亿', 21.3, C.up],
    ['半导体', '+8.14亿', 30.8, C.up],
    ['证券', '+2.07亿', 7.8, C.up],
  ];
  return col({ name: 'SectorRank', w: W, fill: C.card, pad: [10, 16, 14, 16], gap: 10, children: [
    DIVIDER('fill'),
    T('行业资金排名', { size: 12, weight: 500, color: C.text }),
    ...rows.map(([name, amount, pct, color]) => row({
      w: 'fill', h: 26, main: 'SPACE_BETWEEN',
      children: [
        T(name, { size: 12.5, color: C.text, w: 80 }),
        T(amount, { size: 12.5, weight: 500, color, w: 90, align: 'RIGHT' }),
        F({ w: 76, h: 24, radius: 6, fill: tint(color, 0.10), layout: 'H',
          main: 'CENTER', cross: 'CENTER', children: [
            T(`${signed(pct)}%`, { size: 11.5, weight: 600, color }),
          ] }),
      ],
    })),
  ] });
}

function financePanel() {
  const cells = [
    ['市盈率(TTM)', '31.4'], ['市净率', '9.86'],
    ['总市值', '2.11万亿'], ['流通市值', '2.11万亿'],
    ['每股收益', '53.42元'], ['每股净资产', '170.6元'],
    ['ROE', '31.8%'], ['毛利率', '91.6%'],
    ['资产负债率', '18.4%'], ['股息率', '1.62%'],
  ];
  return col({ name: 'Finance', w: W, fill: C.card, pad: [12, 16, 14, 16], gap: 14, children: [
    row({ w: 'fill', wrap: true, gap: 12, main: 'MIN', cross: 'MIN',
      children: cells.map(([l, v]) => col({ w: 104, gap: 4, children: [
        T(l, { size: 11, color: C.sub }),
        T(v, { size: 14, weight: 600, color: C.text }),
      ] })) }),
    DIVIDER('fill'),
    col({ w: 'fill', gap: 6, children: [
      T('盈利能力', { size: 11, color: C.sub }),
      T('近 3 年营收复合增速 14.2%，净利润复合增速 15.8%，毛利率稳定在 91% 以上。',
        { size: 11.5, color: C.text, lineHeight: 18, w: 'fill' }),
    ] }),
  ] });
}

function peerCompare() {
  const rows = [
    ['贵州茅台', '31.4', '9.86'],
    ['五粮液', '18.2', '4.31'],
    ['泸州老窖', '21.7', '6.05'],
  ];
  return col({ name: 'PeerCompare', w: W, fill: C.card, pad: [10, 16, 14, 16], gap: 10, children: [
    DIVIDER('fill'),
    T('行业估值对比', { size: 12, weight: 500, color: C.text }),
    row({ w: 'fill', h: 24, children: [
      T('名称', { size: 11, color: C.sub, w: 'fill' }),
      T('市盈率', { size: 11, color: C.sub, w: 70, align: 'RIGHT' }),
      T('市净率', { size: 11, color: C.sub, w: 70, align: 'RIGHT' }),
    ] }),
    ...rows.map(([name, pe, pb], i) => row({
      w: 'fill', h: 28, children: [
        T(name, { size: 12.5, weight: i === 0 ? 600 : 400, color: i === 0 ? C.brand : C.text, w: 'fill' }),
        T(pe, { size: 12.5, color: C.text, w: 70, align: 'RIGHT' }),
        T(pb, { size: 12.5, color: C.text, w: 70, align: 'RIGHT' }),
      ],
    })),
  ] });
}

/* --------------------------------- 屏幕组装 --------------------------------- */

/**
 * 详情页统一结构：
 *   固定头部（状态栏/导航/价格/可选图表） + 可滚动信息区（吃满剩余高度并裁剪） + 固定操作栏
 */
const SCROLL_FADE_H = 28;

/**
 * 滚区底部渐变遮罩。
 *
 * 详情页的滚动区是「吃满剩余高度 + 裁剪」，内容必然溢出——这本身没问题，
 * 但裁切线常常落在某一行中间（屏 04 就切在第二行的 9px 处），看起来像"没画完"。
 * 加一层从透明到白色的渐变，把生硬的裁切变成明确的"下面还有"。
 *
 * y 用 H - ACTION_BAR_H - FADE_H 算：滚区底边 = 屏幕底部 − 操作栏高度，
 * **与 header 多高无关**，所以同一个式子对所有详情页都成立。
 * 必须放在根容器最后一个（绝对定位 + 后绘制 = 盖在滚区内容之上）。
 */
const scrollFade = () => R({
  name: 'ScrollFade', w: W, h: SCROLL_FADE_H,
  positioning: 'ABSOLUTE', x: 0, y: px(H - ACTION_BAR_H - SCROLL_FADE_H),
  fill: { gradient: 'linear', angle: 90, stops: [[0, '#FFFFFF00'], [1, '#FFFFFFFF']] },
});

function detailScreen({ name, x, chartMode, tab, blocks }) {
  return F({
    name, x, y: 0, w: W, h: H, fill: C.bg, clip: true, layout: 'V', gap: 0,
    children: [
      detailHeader(chartMode),
      F({
        name: 'Scroll', w: W, h: 'fill', layout: 'V', clip: true, fill: C.bg,
        children: [infoTabs(tab), ...blocks],
      }),
      actionBar(),
      scrollFade(),
    ],
  });
}

const spec = {
  // 刻意不写 page：目标页面交给调用方决定（CLI 的 --page / DSH_FIGMA_PAGE），
  // 默认渲染到 Figma 的当前页。规格里钉死页名会让 render 悄悄跑到别的页上，
  // 或者在页面被改名后凭空新建一个空页。
  meta: { app: '炒股 App 原型', generatedAt: new Date().toISOString() },
  frames: [
    screenMarket(),
    detailScreen({ name: '02 个股详情·分时盘口', x: COL, chartMode: 'intraday', tab: 0, blocks: [orderBook(), recentTrades()] }),
    detailScreen({ name: '03 个股详情·日K', x: COL * 2, chartMode: 'candle', tab: 0, blocks: [orderBook(), recentTrades()] }),
    detailScreen({ name: '04 个股详情·资金流向', x: COL * 3, tab: 1, blocks: [fundFlow(), sectorRank()] }),
    detailScreen({ name: '05 个股详情·财务指标', x: COL * 4, tab: 2, blocks: [financePanel(), peerCompare()] }),
  ],
};

const out = path.join(HERE, 'stock-app.json');
fs.writeFileSync(out, JSON.stringify(spec, null, 1));

const countNodes = (n) => 1 + (n.children || []).reduce((a, c) => a + countNodes(c), 0);
console.log(`✔ ${out}`);
spec.frames.forEach((f) => console.log(`  · ${f.name}  (${countNodes(f)} nodes)`));
console.log(`  合计 ${spec.frames.reduce((a, f) => a + countNodes(f), 0)} nodes`);
