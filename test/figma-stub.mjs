/* =============================================================================
 * Figma Plugin API 的最小可用桩
 * -----------------------------------------------------------------------------
 * 目的：让 plugin/code.js 脱离 Figma 也能跑单元测试。
 *
 * 用法：
 *   import { createFigma, loadPlugin, send } from './figma-stub.mjs';
 *   const figma = createFigma();
 *   await loadPlugin(figma);                 // 在 vm 里执行 code.js
 *   const res = await send(figma, 'ping');   // 走真实的 figma.ui 消息通道
 *
 * 边界：这是**近似**，不是 Figma 模拟器。它保证不了 Figma 的真实行为，
 * 但能抓住逻辑错误、字段写错、分支漏掉这类问题——而这些正是最费时间的。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE_PATH = path.resolve(HERE, '..', 'plugin', 'code.js');

let seq = 0;

class Base {
  constructor(type, name) {
    this.id = `${type[0].toLowerCase()}${++seq}:0`;
    this.type = type;
    this.name = name || type;
    this.parent = null;
    this.children = [];
    this.x = 0; this.y = 0;
    this.width = 100; this.height = 100;
    this.fills = [];
    this.strokes = [];
    this.strokeWeight = 1;
    this.strokeAlign = 'INSIDE';
    this.cornerRadius = 0;
    this.opacity = 1;
    this.visible = true;
    this.effects = [];
    this.rotation = 0;
    this.blendMode = 'PASS_THROUGH';
    this.layoutMode = 'NONE';
    this.layoutSizingHorizontal = 'FIXED';
    this.layoutSizingVertical = 'FIXED';
    this.layoutGrow = 0;
    this.layoutAlign = 'INHERIT';
    this.layoutPositioning = 'AUTO';
    this.clipsContent = true;
    // 样式引用（本地样式 id，空串 = 没引用）
    this.textStyleId = '';
    this.fillStyleId = '';
    this.strokeStyleId = '';
    this.effectStyleId = '';
    this.reactions = [];
    this.paddingTop = 0; this.paddingRight = 0;
    this.paddingBottom = 0; this.paddingLeft = 0;
    this.itemSpacing = 0;
    this.primaryAxisAlignItems = 'MIN';
    this.counterAxisAlignItems = 'MIN';
    this.layoutWrap = 'NO_WRAP';
    this.counterAxisSpacing = 0;
  }

  appendChild(child) {
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
    child.parent = this;
    this.children.push(child);
  }

  insertChild(index, child) {
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
    child.parent = this;
    this.children.splice(index, 0, child);
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  resize(w, h) {
    if (this.type === 'TEXT' && this.textAutoResize === 'HEIGHT') { this.width = w; return; }
    this.width = w; this.height = h;
  }

  /** 深拷贝整棵子树（近似 node.clone()） */
  clone() {
    const copy = this._cloneSelf();
    for (const c of this.children) copy.appendChild(c.clone());
    if (this.parent) this.parent.appendChild(copy);
    return copy;
  }

  _cloneSelf() { return new Base(this.type, this.name); }

  async setReactionsAsync(list) { this.reactions = list; }

  get absoluteBoundingBox() {
    let ax = 0, ay = 0, n = this;
    while (n) { ax += n.x || 0; ay += n.y || 0; n = n.parent; }
    return { x: ax, y: ay, width: this.width, height: this.height };
  }

  async exportAsync() {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  }
}

class TextNode extends Base {
  constructor() {
    super('TEXT', 'Text');
    this.fontName = { family: 'Inter', style: 'Regular' };
    this.characters = '';
    this.fontSize = 14;
    this.lineHeight = { unit: 'AUTO' };
    this.letterSpacing = { unit: 'PIXELS', value: 0 };
    this.textAlignHorizontal = 'LEFT';
    this.textAlignVertical = 'TOP';
    this.textAutoResize = 'WIDTH_AND_HEIGHT';
    this.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 }];
  }
  getRangeFontName() { return this.fontName; }
  setRangeFontName() { /* noop */ }
  _cloneSelf() {
    const t = new TextNode();
    t.characters = this.characters;
    t.fontSize = this.fontSize;
    return t;
  }
}

class Page extends Base {
  constructor(name) { super('PAGE', name); }
}

export function createFigma(opts = {}) {
  const mixed = Symbol('figma.mixed');
  const migrated = [];
  const fonts = new Set();
  const missingFonts = new Set(opts.missingFonts || []);
  let currentPage = null;

  const allPages = () => figma.root.children;

  const figma = {
    mixed,
    editorType: 'figma',
    root: {
      id: 'root', type: 'DOCUMENT', name: opts.fileName || 'Test File', children: [],
      insertChild(index, page) {
        const arr = figma.root.children;
        const i = arr.indexOf(page);
        if (i >= 0) arr.splice(i, 1);
        page.parent = figma.root;
        arr.splice(Math.max(0, index), 0, page);
      },
    },
    ui: {
      postMessage() {},
      onmessage: null,
    },
    showUI() { figma.__uiShown = true; },
    viewport: { scrollAndZoomIntoView() {} },
    async loadAllPagesAsync() { migrated.push('loadAllPagesAsync'); },
    async loadFontAsync(font) {
      const key = `${font.family}|${font.style}`;
      if (missingFonts.has(font.family)) throw new Error(`font not found: ${key}`);
      fonts.add(key);
    },
    createPage() {
      const p = new Page(`Page ${allPages().length + 1}`);
      p.parent = figma.root;
      figma.root.children.push(p);
      return p;
    },
    async setCurrentPageAsync(page) { currentPage = page; },
    async getNodeByIdAsync(id) {
      for (const page of allPages()) {
        const found = search(page, id);
        if (found) return found;
      }
      return null;
    },
    getNodeById(id) { return figma.__syncGetNodeById ? figma.__syncGetNodeById(id) : null; },
    base64Encode(bytes) { return Buffer.from(bytes).toString('base64'); },
    base64Decode(str) { return new Uint8Array(Buffer.from(String(str), 'base64')); },
    createImage(bytes) {
      // 近似：用内容的 hash 当 imageHash，够验证「写入 → 读回」的一致性
      const h = Buffer.from(bytes).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
      const hash = `img${h}`;
      figma.__images.set(hash, bytes);
      return { hash, getBytesAsync: async () => bytes };
    },
    getImageByHash(hash) {
      const bytes = figma.__images.get(hash);
      if (!bytes) return null;
      return { hash, getBytesAsync: async () => bytes };
    },
    // ---- 本地样式 ----
    async getLocalTextStylesAsync() { return figma.__styles.text; },
    async getLocalPaintStylesAsync() { return figma.__styles.paint; },
    async getLocalEffectStylesAsync() { return figma.__styles.effect; },
    async getStyleByIdAsync(id) {
      for (const list of Object.values(figma.__styles)) {
        const hit = list.find((s) => s.id === id);
        if (hit) return hit;
      }
      return null;
    },
    // ---- 成组 / 解组 ----
    group(nodes, parent, index) {
      const g = new Base('GROUP', 'Group');
      g.appendChild === undefined;   // 占位：Group 也是容器
      const first = nodes[0];
      const at = typeof index === 'number' ? index : parent.children.length;
      // 记录原始索引后按序搬进去
      for (const n of [...nodes].sort((a, b) => parent.children.indexOf(a) - parent.children.indexOf(b))) {
        parent.children = parent.children.filter((c) => c !== n);
        g.children.push(n);
        n.parent = g;
      }
      g.parent = parent;
      parent.children.splice(Math.max(0, Math.min(at, parent.children.length)), 0, g);
      g.width = 100; g.height = 100;
      return g;
    },
    ungroup(node) {
      if (!node.parent) throw new Error('节点没有父容器');
      const parent = node.parent;
      const at = parent.children.indexOf(node);
      const kids = [...node.children];
      for (const k of kids) { k.parent = parent; }
      parent.children.splice(at, 1, ...kids);
      node.children = [];
      node.parent = null;
      // 真实 Figma 的 ungroup 会**销毁**这个节点，之后再读它的属性会抛错。
      // 桩必须模拟这一点 —— 否则「解组后又去读 node.name」这种
      // use-after-destroy 在桩上永远绿，一到真机就报
      // "The node with id ... does not exist"。
      for (const key of ['name', 'type']) {
        Object.defineProperty(node, key, {
          get() { throw new Error(`The node with id "${node.id}" does not exist`); },
          configurable: true,
        });
      }
      return kids;
    },

    // ---- 组件 / 实例 ----
    createComponentFromNode(node) {
      if (!['FRAME', 'GROUP'].includes(node.type)) {
        throw new Error(`Cannot create component from ${node.type}`);
      }
      const c = new Base('COMPONENT', node.name);
      c.width = node.width; c.height = node.height;
      c.fills = node.fills;
      const parent = node.parent;
      const at = parent ? parent.children.indexOf(node) : -1;
      for (const k of [...node.children]) { c.appendChild(k); }
      if (parent) parent.children.splice(at, 1, c);
      c.parent = parent;
      // 真机上 createComponentFromNode 会**替换**原节点；桩也让它"死掉"，
      // 这样"转成组件后还去读原节点"的写法会在秒级测试里就暴露（同 ungroup，见 P24）
      for (const key of ['name', 'type']) {
        Object.defineProperty(node, key, {
          get() { throw new Error(`The node with id "${node.id}" does not exist`); },
          configurable: true,
        });
      }
      c.createInstance = () => {
        const inst = new Base('INSTANCE', c.name);
        inst.width = c.width; inst.height = c.height;
        inst.mainComponent = c;
        inst.componentProperties = { '文案': { type: 'TEXT', value: '默认' } };
        // 注意：要读 inst.mainComponent（会被 swap 改），不能闭包捕获 c——
        // 否则 swap 之后读回来还是旧组件，测试会假绿
        inst.getMainComponentAsync = async () => inst.mainComponent;
        inst.swapComponentAsync = async (other) => { inst.mainComponent = other; };
        inst.swapComponent = (other) => { inst.mainComponent = other; };
        inst.detachInstance = () => {
          const frame = new Base('FRAME', inst.name);
          frame.width = inst.width; frame.height = inst.height;
          const p = inst.parent;
          if (p) {
            const i = p.children.indexOf(inst);
            p.children.splice(i, 1, frame);
            frame.parent = p;
          }
          return frame;
        };
        return inst;
      };
      return c;
    },
    commitUndo() { figma.__undoCommits = (figma.__undoCommits || 0) + 1; },
    notify() {},
    createFrame() { const n = new Base('FRAME', 'Frame'); n.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }]; return n; },
    createRectangle() { const n = new Base('RECTANGLE', 'Rectangle'); n.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 }, opacity: 1 }]; return n; },
    createEllipse() { const n = new Base('ELLIPSE', 'Ellipse'); n.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 }, opacity: 1 }]; return n; },
    createLine() { const n = new Base('LINE', 'Line'); n.strokes = []; n.strokes.push({ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 }); return n; },
    createText() { return new TextNode(); },
    __fonts: fonts,
    __migrated: migrated,
    __images: new Map(),
    __styles: {
      text: [
        { id: 'S:text1', name: '标题/H1' },
        { id: 'S:text2', name: '正文/Body' },
      ],
      paint: [
        { id: 'S:paint1', name: '品牌/主色' },
      ],
      effect: [
        { id: 'S:effect1', name: '投影/Card' },
      ],
    },
  };

  Object.defineProperty(figma, 'currentPage', {
    get() { return currentPage; },
    set(p) { currentPage = p; },
  });

  // 初始一个页面，并把 currentPage 设上
  const p1 = figma.createPage();
  p1.name = 'Page 1';
  currentPage = p1;

  return figma;
}

function search(node, id) {
  if (node.id === id) return node;
  if (node.children) for (const c of node.children) { const f = search(c, id); if (f) return f; }
  return null;
}

/** 在 vm 沙箱里执行 plugin/code.js，返回 figma 对象 */
export async function loadPlugin(figma, codePath = CODE_PATH) {
  const code = fs.readFileSync(codePath, 'utf8');
  const sandbox = {
    figma,
    console,
    setTimeout,
    clearTimeout,
    __html__: '<html></html>',
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'code.js' });
  figma.__sandbox = sandbox;
  return figma;
}

/**
 * 走真实的 figma.ui 消息通道下发指令（与 Figma 运行时同一路径）。
 * 只捕获 id 匹配的那条响应，跳过 progress 之类的中间消息。
 */
export function send(figma, cmd, payload = {}, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const id = `t${Math.random().toString(36).slice(2)}`;
    const progress = [];
    const timer = setTimeout(() => reject(new Error(`timeout: ${cmd}`)), timeoutMs);
    const orig = figma.ui.postMessage;
    figma.ui.postMessage = (msg) => {
      if (msg && msg.type === 'progress') { progress.push(msg); return; }
      if (msg && msg.id === id) {
        clearTimeout(timer);
        figma.ui.postMessage = orig;
        resolve({ ...msg, progress });
      }
    };
    if (!figma.ui.onmessage) throw new Error('plugin 没有注册 figma.ui.onmessage');
    figma.ui.onmessage({ id, cmd, payload });
  });
}

/** 便捷：往当前页塞一个测试用节点树 */
export function node(figma, spec) {
  const build = (s, parent) => {
    const n = s.type === 'TEXT' ? new TextNode() : new Base(s.type || 'FRAME', s.name);
    if (s.type === 'TEXT') { n.characters = s.text || ''; n.name = s.name || 'Text'; }
    Object.assign(n, s.props || {});
    if (s.w != null) n.width = s.w;
    if (s.h != null) n.height = s.h;
    if (parent) parent.appendChild(n);
    for (const c of s.children || []) build(c, n);
    return n;
  };
  return build(spec, figma.currentPage);
}
