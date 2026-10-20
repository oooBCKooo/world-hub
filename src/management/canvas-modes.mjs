// World Hub 画布三模式（运行模式 / 接线模式 / 编排模式）与自由拖拽编排引擎
const NS = 'http://www.w3.org/2000/svg';
const $ = id => document.getElementById(id);
const htmlText = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const errorText = value => value?.message || value?.error?.message || (typeof value?.error === 'string' ? value.error : t('操作失败'));
const t = (source, params = {}) => {
  if (typeof window !== 'undefined' && window.hubCanvas?.translate) {
    return window.hubCanvas.translate(source, params);
  }
  return String(source ?? '').replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(params, key) ? String(params[key]) : token);
};
const canvasTextBindings = new WeakMap();
const canvasAttributeBindings = new WeakMap();
const canvasLabelFactories = new Map();
let canvasLabelSequence = 0;
const canvasRoots = ['#detached-hud-group', '#left-tool-dock', '#dock-add-flyout-panel',
  '#bottom-exec-controls', '#bottom-status-bar', '#static-filter-bar', '#inspector-drawer',
  '#import-module-modal', '#group-manager-modal', '#env-detect-modal', '#external-grant-modal',
  '#security-review-modal', '#modal-module-scaffold', '#modal-module-package', '#modal-module-workshop',
  '#modal-workshop-detail', '#modal-workshop-lightbox', '#wiring-matrix-modal', '#wiring-defaults-modal',
  '#module-version-modal', '#module-uninstall-modal', '#modal-batch-update-review'];

// Bind only text produced by this UI. Raw values are evaluated unchanged, and
// changing language never rebuilds a form or invalidates an accepted review.
function setCanvasText(element, factory) {
  element.removeAttribute?.('data-i18n');
  const value = String(factory() ?? '');
  element.textContent = value;
  canvasTextBindings.set(element, { factory, value, node: element.firstChild?.nodeType === 3 ? element.firstChild : null });
  return value;
}

function setCanvasAttribute(element, name, factory) {
  const value = String(factory() ?? '');
  element.setAttribute(name, value);
  if (element && typeof element === 'object') {
    try {
      if (['title', 'placeholder', 'alt'].includes(name)) element[name] = value;
    } catch (_) {}
  }
  let bindings = canvasAttributeBindings.get(element);
  if (!bindings) canvasAttributeBindings.set(element, bindings = new Map());
  bindings.set(name, { factory, value });
  return value;
}

function canvasLabel(factory) {
  const id = String(++canvasLabelSequence);
  canvasLabelFactories.set(id, factory);
  return `<span data-canvas-label="${id}">${htmlText(factory())}</span>`;
}

function canvasTextAttribute(factory) {
  const id = String(++canvasLabelSequence);
  canvasLabelFactories.set(id, factory);
  return `data-canvas-label="${id}"`;
}

function canvasAttribute(name, factory) {
  const id = String(++canvasLabelSequence);
  canvasLabelFactories.set(id, factory);
  return `${name}="${htmlText(factory())}" data-canvas-${name}="${id}"`;
}

function setCanvasHtml(element, factory) {
  element.removeAttribute?.('data-i18n');
  canvasTextBindings.delete(element);
  element.innerHTML = factory();
  for (const label of element.querySelectorAll?.('[data-canvas-label]') || []) {
    const id = label.getAttribute('data-canvas-label');
    const textFactory = canvasLabelFactories.get(id);
    if (textFactory) setCanvasText(label, textFactory);
    canvasLabelFactories.delete(id);
    label.removeAttribute('data-canvas-label');
  }
  for (const name of ['title', 'placeholder', 'aria-label', 'alt', 'data-tooltip']) {
    const marker = `data-canvas-${name}`;
    for (const child of element.querySelectorAll?.(`[${marker}]`) || []) {
      const id = child.getAttribute(marker), attributeFactory = canvasLabelFactories.get(id);
      if (attributeFactory) setCanvasAttribute(child, name, attributeFactory);
      canvasLabelFactories.delete(id);
      child.removeAttribute(marker);
    }
  }
  window.hubCanvas?.applyLabels?.(element);
}

function canvasOption(factory, value, defaultSelected = false, selected = false) {
  const option = new Option('', value, defaultSelected, selected);
  setCanvasText(option, factory);
  return option;
}

function refreshCanvasBindings(root) {
  for (const element of [root, ...(root.querySelectorAll?.('*') || [])]) {
    const text = canvasTextBindings.get(element);
    if (text) {
      // A different owner may have replaced a loading status with raw data.
      if (text.node?.parentNode === element && text.node.nodeValue === text.value) {
        text.value = String(text.factory() ?? ''); text.node.nodeValue = text.value;
      } else if (element.textContent === text.value) setCanvasText(element, text.factory);
      else canvasTextBindings.delete(element);
    }
    for (const [name, binding] of canvasAttributeBindings.get(element) || []) {
      if (element.getAttribute(name) === binding.value) setCanvasAttribute(element, name, binding.factory);
    }
  }
}

function localizedText(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return fallback;
  const english = typeof window !== 'undefined' && (window.hubCanvas?.language || window.hubCanvas?.getLanguage?.()) === 'en';
  return (english ? value.en || value['zh-CN'] || value.zh : value['zh-CN'] || value.zh || value.en) || fallback;
}

function canvasToast(factory, kind = 'neutral', autoClear = true) {
  const hub = typeof window !== 'undefined' ? window.hubCanvas : null;
  if (hub?.notify) hub.notify(factory, kind, autoClear);
  else hub?.toast?.(factory(), kind, autoClear);
}
function compareSourceVersions(left, right) {
  const parts = value => { const split = value.indexOf('-'); return { core: (split < 0 ? value : value.slice(0, split)).split('.').map(BigInt), pre: split < 0 ? null : value.slice(split + 1).split('.') }; };
  const a = parts(left), b = parts(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre || !b.pre) return a.pre === b.pre ? 0 : !a.pre ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined || b.pre[i] === undefined) return a.pre[i] === undefined ? -1 : 1;
    if (a.pre[i] === b.pre[i]) continue;
    const numericA = /^\d+$/.test(a.pre[i]), numericB = /^\d+$/.test(b.pre[i]);
    if (numericA && numericB) return BigInt(a.pre[i]) > BigInt(b.pre[i]) ? 1 : -1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a.pre[i] > b.pre[i] ? 1 : -1;
  }
  return 0;
}

function svgEl(tag, attrs = {}, text = '') {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text) el.textContent = text;
  return el;
}

export class CanvasModesController {
  constructor() {
    this.mode = 'runtime'; // 'runtime' | 'wiring' | 'orchestration' | 'static'
    this.runtimePerspective = 'topology'; // 'topology' | 'orbits'
    this.groupFilter = 'all'; // 'all' | groupId
    this.focusedWiringModuleId = null;
    this.staticSearchQuery = '';
    this.data = {
      programs: [],
      startupPlan: { members: [] },
      groups: [],
      wiring: { wires: [] },
      layout: { nodes: {} }
    };
    this.modePositions = {
      static: new Map(),
      runtime: new Map(),
      wiring: new Map(),
      orchestration: new Map()
    };
    this.focusedWiringPositions = new Map();
    this.draggingNode = null;
    this.draggingDep = null;
    this.selectedModuleId = null;
    this.logPollTimer = null;
    this.saveLayoutTimer = null;
    this.hoverWire = null;
    this.hoverDag = null;
    this.latestTickerText = '等待通讯事件…';
    this.mutationQueue = Promise.resolve();
    this.pendingMutations = 0;
    this.matrixCategoryFilter = 'all';
  }

  get nodePositions() {
    if (this.mode === 'wiring' && this.focusedWiringModuleId) {
      return this.focusedWiringPositions;
    }
    const m = this.mode || 'runtime';
    if (!this.modePositions[m]) {
      this.modePositions[m] = new Map();
    }
    return this.modePositions[m];
  }

  set nodePositions(map) {
    if (this.mode === 'wiring' && this.focusedWiringModuleId) {
      this.focusedWiringPositions = map;
      return;
    }
    const m = this.mode || 'runtime';
    this.modePositions[m] = map;
  }

  async init() {
    this.injectStyles();
    this.injectHUDControls();
    this.injectSVGLayers();
    this.injectInspectorContent();
    this.injectModals();
    this.bindEvents();
    this.renderLanguage();

    await this.fetchModulesData();
    this.updateModeUI();
  }

  // 1. 样式注入
  injectStyles() {
    if ($('canvas-modes-styles')) return;
    const style = document.createElement('style');
    style.id = 'canvas-modes-styles';
    style.textContent = `
      /* 顶部 HUD 模式切换器 */
      .hud-mode-group {
        display: inline-flex; gap: 4px; background: rgba(0, 0, 0, 0.45);
        padding: 3px; border-radius: 20px; border: 1px solid var(--border);
      }
      .mode-tab-btn {
        padding: 5px 14px; font-size: 11px; font-weight: 700; border-radius: 16px;
        color: var(--muted); background: transparent; transition: all 0.15s ease;
        display: flex; align-items: center; gap: 6px; cursor: pointer; border: 1px solid transparent;
      }
      .mode-tab-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.05); }
      .mode-tab-btn.active {
        background: var(--teal-soft); color: var(--teal); border: 1px solid var(--teal);
        box-shadow: 0 0 12px var(--teal-glow);
      }
      .mode-tab-btn.static.active {
        background: rgba(168, 85, 247, 0.18); color: #c084fc; border-color: #a855f7;
        box-shadow: 0 0 12px rgba(168, 85, 247, 0.4);
      }
      .mode-tab-btn.wiring.active {
        background: var(--blue-soft); color: var(--blue); border-color: var(--blue);
        box-shadow: 0 0 12px var(--blue-glow);
      }
      .mode-tab-btn.orchestration.active {
        background: var(--amber-soft); color: var(--amber); border-color: var(--amber);
        box-shadow: 0 0 12px var(--amber-glow);
      }
      .mode-tab-btn.runtime.active {
        background: rgba(16, 185, 129, 0.15); color: #10b981; border-color: #10b981;
        box-shadow: 0 0 12px rgba(16, 185, 129, 0.4);
      }

      /* 左侧垂直工具坞 */
      .left-tool-dock {
        position: fixed; top: 50%; left: 12px; transform: translateY(-50%); z-index: 50;
        display: flex; flex-direction: column; gap: 8px;
        background: rgba(13, 21, 34, 0.88); backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 10px;
        padding: 6px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
      }
      .dock-btn {
        position: relative; width: 38px; height: 38px; border-radius: 8px;
        background: transparent; border: 1px solid transparent;
        color: var(--ink-dim); display: flex; align-items: center; justify-content: center;
        cursor: pointer; transition: all 0.18s ease; font-size: 15px;
      }
      .dock-btn:hover {
        background: rgba(0, 210, 180, 0.12); border-color: rgba(0, 210, 180, 0.4);
        color: #fff; box-shadow: 0 0 12px var(--teal-glow);
      }
      .dock-btn::after {
        content: attr(data-tooltip);
        position: absolute; left: 48px; top: 50%; transform: translateY(-50%);
        background: #09101a; border: 1px solid var(--border-bright);
        color: #fff; font-size: 11px; font-weight: 600; padding: 5px 10px;
        border-radius: 6px; white-space: nowrap; pointer-events: none;
        opacity: 0; visibility: hidden; transition: opacity 0.15s ease, transform 0.15s ease;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6); z-index: 100;
      }
      .dock-btn:hover::after {
        opacity: 1; visibility: visible; transform: translateY(-50%) translateX(2px);
      }
      .dock-btn.active {
        background: rgba(0, 210, 180, 0.2); border-color: var(--teal);
        color: var(--teal); box-shadow: 0 0 16px var(--teal-glow);
      }
      .dock-btn.active::after {
        display: none;
      }

      /* 侧边工具坞快捷展开菜单 (Flyout Action Panel) */
      .dock-flyout-panel {
        position: fixed; top: 50%; left: 62px; z-index: 55;
        width: 320px; max-height: calc(100vh - 100px); overflow-y: auto;
        background: rgba(13, 21, 34, 0.96); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
        border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 12px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65), 0 0 1px rgba(0, 210, 180, 0.35);
        display: flex; flex-direction: column;
        padding: 12px; gap: 6px;
        opacity: 0; pointer-events: none; transform: translateY(-50%) translateX(-10px) scale(0.97);
        transition: opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1), transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .dock-flyout-panel.open {
        opacity: 1; pointer-events: auto; transform: translateY(-50%) translateX(0) scale(1);
      }
      .dock-flyout-header {
        display: flex; align-items: center; justify-content: space-between;
        padding-bottom: 8px; margin-bottom: 4px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .dock-flyout-title {
        font-size: 13px; font-weight: 800; color: #fff; display: flex; align-items: center; gap: 6px;
      }
      .dock-flyout-close {
        width: 24px; height: 24px; border-radius: 6px; display: grid; place-items: center;
        background: transparent; border: 1px solid transparent; color: var(--muted);
        cursor: pointer; font-size: 12px; transition: all 0.15s ease;
      }
      .dock-flyout-close:hover {
        background: rgba(255, 255, 255, 0.08); color: #fff;
      }
      .dock-flyout-item {
        display: flex; align-items: center; gap: 12px; padding: 10px 12px;
        border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.04);
        background: rgba(255, 255, 255, 0.02);
        cursor: pointer; text-align: left; width: 100%; transition: all 0.16s ease;
      }
      .dock-flyout-item:hover {
        background: rgba(0, 210, 180, 0.08); border-color: rgba(0, 210, 180, 0.3);
        transform: translateX(3px); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      }
      .dock-flyout-item:hover .dock-flyout-item-title {
        color: var(--teal);
      }
      .dock-flyout-icon-box {
        width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center;
        background: rgba(255, 255, 255, 0.04); font-size: 16px; flex-shrink: 0;
        border: 1px solid rgba(255, 255, 255, 0.08); transition: all 0.16s ease;
      }
      .dock-flyout-item:hover .dock-flyout-icon-box {
        background: rgba(0, 210, 180, 0.16); border-color: rgba(0, 210, 180, 0.45);
      }
      .dock-flyout-item-body {
        display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0;
      }
      .dock-flyout-item-title {
        font-size: 12px; font-weight: 700; color: #fff; transition: color 0.15s ease;
        display: flex; align-items: center; justify-content: space-between;
      }
      .dock-flyout-item-title span.tag {
        font-size: 9px; font-weight: 600; padding: 1px 5px; border-radius: 4px;
        background: rgba(255, 255, 255, 0.06); color: var(--ink-dim); font-family: var(--mono);
      }
      .dock-flyout-item:hover .dock-flyout-item-title span.tag {
        background: rgba(0, 210, 180, 0.15); color: var(--teal);
      }
      .dock-flyout-item-desc {
        font-size: 11px; color: var(--muted); line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .dock-flyout-footer {
        padding-top: 8px; margin-top: 4px; border-top: 1px solid rgba(255, 255, 255, 0.06);
        display: flex; align-items: center; justify-content: space-between;
      }
      .dock-flyout-footer-btn {
        background: transparent; border: none; font-size: 10px; color: var(--muted);
        cursor: pointer; display: flex; align-items: center; gap: 4px; padding: 3px 6px;
        border-radius: 4px; transition: all 0.15s ease;
      }
      .dock-flyout-footer-btn:hover {
        color: #fff; background: rgba(255, 255, 255, 0.08);
      }

      /* 底部状态监控托盘 */
      .bottom-status-bar {
        position: fixed; bottom: 0; left: 0; right: 0; height: 48px; z-index: 40;
        background: rgba(10, 16, 26, 0.96); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
        border-top: 1px solid rgba(255, 255, 255, 0.12); padding: 0 20px;
        box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.45);
        display: flex; align-items: center; justify-content: space-between;
      }
      .bottom-ticker-wrap {
        display: flex; align-items: center; gap: 10px; max-width: 520px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 12px; font-family: var(--mono); color: var(--ink-dim);
        cursor: pointer; padding: 6px 12px; border-radius: 8px;
        transition: background 0.15s ease;
      }
      .bottom-ticker-wrap:hover { color: #fff; background: rgba(255, 255, 255, 0.06); }
      .ticker-pulse-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #00d2b4;
        box-shadow: 0 0 10px #00d2b4; flex-shrink: 0;
      }
      .bottom-exec-controls {
        display: flex; align-items: center; gap: 10px;
      }
      .bottom-right-actions {
        display: flex; align-items: center; gap: 10px;
      }
      .bottom-toggle-stream-btn {
        background: var(--surface); border: 1px solid var(--border-bright);
        border-radius: 8px; color: #fff; font-size: 12px; font-weight: 700;
        padding: 6px 13px; cursor: pointer; transition: all 0.15s ease;
        white-space: nowrap; display: inline-flex; align-items: center; gap: 6px;
      }
      .bottom-toggle-stream-btn:hover { border-color: var(--teal); background: rgba(0, 210, 180, 0.12); }

      /* 视角切换胶囊 */
      .ctrl-perspective-btn {
        background: rgba(0, 210, 180, 0.12); border: 1px solid rgba(0, 210, 180, 0.35);
        border-radius: 6px; color: var(--teal); font-size: 11px; font-weight: 700;
        padding: 3px 8px; cursor: pointer; transition: all 0.15s ease;
        white-space: nowrap; display: inline-flex; align-items: center; gap: 4px;
      }
      .ctrl-perspective-btn:hover {
        background: rgba(0, 210, 180, 0.25); border-color: var(--teal);
        box-shadow: 0 0 10px var(--teal-glow); color: #fff;
      }

      /* 连线脉冲光效动画 */
      @keyframes topicPulseGlow {
        0% { stroke: #00ebb8; stroke-width: 4px; filter: drop-shadow(0 0 16px #00d2b4); }
        50% { stroke: #38bdf8; stroke-width: 5px; filter: drop-shadow(0 0 24px #38bdf8); }
        100% { stroke: #00d2b4; stroke-width: 2.2px; filter: none; }
      }
      .wiring-cable.topic-pulse {
        animation: topicPulseGlow 1.2s ease-out;
      }

      /* 脱离 top-hud 的左下/右下浮动独立组件 (模块组选择栏 & 语言选择栏) */
      .detached-hud-panel {
        position: fixed; top: calc(var(--hud-bottom, 68px) + 8px); z-index: 45;
        display: inline-flex; align-items: center; gap: 6px;
        background: rgba(13, 21, 34, 0.9); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px;
        padding: 3px 6px; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
        transition: border-color 0.18s ease, box-shadow 0.18s ease;
      }
      .detached-hud-panel:hover {
        border-color: rgba(0, 210, 180, 0.4);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.55), 0 0 12px rgba(0, 210, 180, 0.2);
      }
      .detached-hud-panel:focus-within {
        border-color: var(--teal);
        box-shadow: 0 0 12px var(--teal-glow);
      }
      .detached-hud-left {
        left: 16px;
      }
      .detached-hud-right {
        right: 16px;
      }
      .detached-hud-center {
        left: 50% !important;
        transform: translateX(-50%) !important;
      }
      .detached-hud-panel .hud-group-select,
      .detached-hud-panel .hud-btn,
      .detached-hud-panel #canvas-language,
      .detached-hud-panel #hud-group-filter {
        background: transparent !important;
        border: none !important;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        padding: 3px 6px;
        outline: none;
        cursor: pointer;
        min-width: auto;
      }
      .detached-hud-panel select option {
        background: #0d1522;
        color: #fff;
      }

      /* Toast 提示浮条位于 bottom-status-bar 中部上方，激活时置于最顶层 (突破弹窗遮罩) */
      .toast {
        position: fixed !important;
        bottom: calc(var(--status-bar-height, 48px) + 14px) !important;
        top: auto !important;
        left: 50% !important;
        transform: translateX(-50%) !important;
      }
      .toast.active {
        z-index: 100000 !important;
      }
      .toast.warning.active {
        z-index: 100000 !important;
        color: #fff !important;
        border-color: rgba(245, 158, 11, 0.85) !important;
        background: rgba(36, 24, 6, 0.98) !important;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.85), 0 0 20px rgba(245, 158, 11, 0.45) !important;
      }

      /* 模块抽屉操作按键交互动效 */
      .action-btn:active:not(:disabled) {
        transform: scale(0.95);
      }
      .action-btn.audit {
        background: rgba(56, 189, 248, 0.12) !important;
        color: #38bdf8 !important;
        border-color: rgba(56, 189, 248, 0.35) !important;
      }
      .action-btn.audit:hover:not(:disabled) {
        background: #38bdf8 !important;
        color: #000 !important;
        border-color: #38bdf8 !important;
        box-shadow: 0 0 16px rgba(56, 189, 248, 0.5) !important;
      }
      .action-btn.uninstall {
        background: rgba(244, 63, 94, 0.1) !important;
        color: #fb7185 !important;
        border-color: rgba(244, 63, 94, 0.3) !important;
      }
      .action-btn.uninstall:hover:not(:disabled) {
        background: #f43f5e !important;
        color: #fff !important;
        border-color: #f43f5e !important;
        box-shadow: 0 0 16px rgba(244, 63, 94, 0.5) !important;
      }
      .action-btn.version {
        background: rgba(0, 210, 180, 0.12) !important;
        color: var(--teal) !important;
        border-color: rgba(0, 210, 180, 0.35) !important;
      }
      .action-btn.version:hover:not(:disabled) {
        background: var(--teal) !important;
        color: #050a12 !important;
        border-color: var(--teal) !important;
        box-shadow: 0 0 16px var(--teal-glow) !important;
      }

      /* 版本管理与批量更新模态框层级 (高于工坊弹窗 z-index 1000) */
      #module-version-modal,
      #modal-batch-update-review {
        z-index: 1100 !important;
      }
      #module-version-modal .hub-modal {
        max-width: 820px !important;
        background: #080f1a !important;
        border: 1px solid rgba(0, 210, 180, 0.25) !important;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.8), 0 0 32px rgba(0, 210, 180, 0.08) !important;
        border-radius: 12px !important;
      }
      .vm-hero-card {
        background: linear-gradient(135deg, rgba(0, 210, 180, 0.06), rgba(15, 23, 42, 0.6)) !important;
        border: 1px solid rgba(0, 210, 180, 0.2) !important;
        border-radius: 10px !important;
        padding: 12px 16px !important;
        margin-bottom: 14px !important;
      }
      #version-current {
        font-size: 13px !important;
        font-weight: 700 !important;
        color: #fff !important;
        margin: 0 0 6px 0 !important;
        display: flex !important;
        align-items: center !important;
        flex-wrap: wrap !important;
        gap: 8px !important;
      }
      .vm-section {
        background: rgba(255, 255, 255, 0.02) !important;
        border: 1px solid rgba(255, 255, 255, 0.07) !important;
        border-radius: 10px !important;
        padding: 14px 16px !important;
        margin-bottom: 14px !important;
      }
      .vm-section-title {
        margin: 0 0 10px 0 !important;
        font-size: 13px !important;
        font-weight: 700 !important;
        color: #fff !important;
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
      }
      .vm-state-banner {
        border-radius: 8px !important;
        padding: 8px 12px !important;
        margin: 6px 0 0 0 !important;
        font-size: 12px !important;
        line-height: 1.5 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        flex-wrap: wrap !important;
        gap: 8px !important;
      }
      .vm-state-banner.running {
        background: rgba(245, 158, 11, 0.1) !important;
        border: 1px solid rgba(245, 158, 11, 0.35) !important;
        color: #fbbf24 !important;
      }
      .vm-state-banner.stopped {
        background: rgba(0, 210, 180, 0.08) !important;
        border: 1px solid rgba(0, 210, 180, 0.25) !important;
        color: #a7f3d0 !important;
      }
      .vm-known-chip {
        font-size: 11px !important;
        padding: 4px 10px !important;
        border-radius: 6px !important;
        border: 1px solid rgba(0, 210, 180, 0.25) !important;
        background: rgba(0, 210, 180, 0.05) !important;
        color: var(--teal) !important;
        transition: all 0.15s ease !important;
        cursor: pointer !important;
      }
      .vm-known-chip:hover {
        background: rgba(0, 210, 180, 0.15) !important;
        border-color: var(--teal) !important;
        transform: translateY(-1px) !important;
      }
      .vm-known-chip.active {
        background: var(--teal) !important;
        color: #050a12 !important;
        font-weight: 700 !important;
        box-shadow: 0 0 12px var(--teal-glow) !important;
      }
      .vm-grid-2 {
        display: grid !important;
        grid-template-columns: 1fr 1fr !important;
        gap: 12px !important;
        margin-top: 10px !important;
        margin-bottom: 10px !important;
      }
      @media (max-width: 640px) {
        .vm-grid-2 { grid-template-columns: 1fr !important; }
      }
      .vm-ack-box {
        background: rgba(0, 0, 0, 0.3) !important;
        border: 1px solid rgba(255, 255, 255, 0.1) !important;
        border-radius: 8px !important;
        padding: 10px 14px !important;
        margin-top: 12px !important;
        margin-bottom: 12px !important;
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
      }
      #version-error:not(:empty) {
        background: rgba(244, 63, 94, 0.1) !important;
        border: 1px solid rgba(244, 63, 94, 0.35) !important;
        border-radius: 8px !important;
        padding: 8px 14px !important;
        color: #fb7185 !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        margin: 10px 0 !important;
      }
      .vm-review-box {
        margin-top: 14px !important;
        margin-bottom: 14px !important;
      }
      .vm-review-program-card {
        background: rgba(0, 0, 0, 0.25) !important;
        border: 1px solid rgba(255, 255, 255, 0.08) !important;
        border-radius: 8px !important;
        padding: 12px 14px !important;
        margin-bottom: 10px !important;
      }
      .vm-history-card {
        background: rgba(0, 0, 0, 0.2) !important;
        border: 1px solid rgba(255, 255, 255, 0.06) !important;
        border-radius: 8px !important;
        padding: 10px 14px !important;
        margin-bottom: 8px !important;
        display: flex !important;
        justify-content: space-between !important;
        align-items: center !important;
        flex-wrap: wrap !important;
        gap: 10px !important;
      }

      /* 模块组下拉与动作按键 */
      .hud-group-select {
        min-width: 140px; background: var(--surface); border: 1px solid var(--border-bright);
        border-radius: 8px; padding: 5px 10px; font-size: 12px; color: var(--ink);
      }
      .hud-action-pill {
        display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px;
        font-size: 12px; font-weight: 700; border-radius: 8px; background: var(--surface);
        border: 1px solid var(--border-bright); color: #fff; transition: all 0.15s ease;
        cursor: pointer;
      }
      .hud-action-pill:hover { border-color: var(--teal); background: rgba(0, 210, 180, 0.08); }
      .hud-action-pill.primary {
        background: var(--teal); color: #050a12; border-color: var(--teal);
      }
      .hud-action-pill.primary:hover {
        background: #00ebb8; box-shadow: 0 0 16px var(--teal-glow);
      }
      .hud-action-pill.danger {
        border-color: rgba(244, 63, 94, 0.4); color: #f43f5e;
      }
      .hud-action-pill.danger:hover {
        background: rgba(244, 63, 94, 0.15); border-color: #f43f5e;
      }

      /* 静态筛选栏：脱离 HUD 居中组件 (与 bottom-exec-controls 共享顶部对齐基准) */
      .static-filter-bar {
        border-color: rgba(168, 85, 247, 0.35);
        padding: 3px 10px;
        gap: 8px;
      }
      .static-filter-bar:hover {
        border-color: rgba(168, 85, 247, 0.6);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.55), 0 0 12px rgba(168, 85, 247, 0.25);
      }
      .static-filter-bar:focus-within {
        border-color: #c084fc;
        box-shadow: 0 0 12px rgba(168, 85, 247, 0.4);
      }
      .focus-bar-label {
        font-size: 11px; font-weight: 800; color: #38bdf8; white-space: nowrap;
      }
      .focus-pill-btn {
        padding: 3px 10px; font-size: 11px; font-weight: 600; border-radius: 12px;
        background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.12);
        color: var(--ink-dim); cursor: pointer; transition: all 0.15s ease; white-space: nowrap;
      }
      .focus-pill-btn:hover {
        color: #fff; background: rgba(56, 189, 248, 0.15); border-color: #38bdf8;
      }
      .focus-pill-btn.active {
        background: rgba(56, 189, 248, 0.25); color: #38bdf8; border-color: #38bdf8;
        font-weight: 800; box-shadow: 0 0 10px rgba(56, 189, 248, 0.35);
      }

      /* 接线概览选择按键与交互 */
      .cmn-node.wiring-overview-card:hover .cmn-card-bg {
        stroke: #38bdf8; filter: drop-shadow(0 0 20px rgba(56, 189, 248, 0.35));
      }
      .cmn-select-core-btn { cursor: pointer; }
      .cmn-select-core-btn rect { transition: all 0.15s ease; }
      .cmn-select-core-btn:hover rect { fill: #38bdf8; }
      .cmn-select-core-btn:hover text { fill: #050a12; }

      /* 聚焦与匹配候选卡片 */
      .cmn-node.wiring-focus .cmn-card-bg {
        stroke: #38bdf8; stroke-width: 2.2; fill: rgba(10, 24, 46, 0.98);
        filter: drop-shadow(0 0 24px rgba(56, 189, 248, 0.4));
      }
      .cmn-wiring-partner-bg {
        fill: rgba(10, 24, 42, 0.96); stroke: rgba(56, 189, 248, 0.35);
        stroke-width: 1.5; rx: 12; transition: all 0.15s ease;
      }
      .cmn-node.wiring-partner:hover .cmn-wiring-partner-bg {
        stroke: #38bdf8; filter: drop-shadow(0 0 16px rgba(56, 189, 248, 0.3));
      }
      .cmn-connect-btn { cursor: pointer; }
      .cmn-connect-btn rect {
        rx: 5; fill: rgba(56, 189, 248, 0.18); stroke: #38bdf8; stroke-width: 1;
        transition: all 0.15s ease;
      }
      .cmn-connect-btn:hover rect { fill: #38bdf8; }
      .cmn-connect-btn text {
        fill: #38bdf8; font-size: 10px; font-weight: 800; text-anchor: middle; pointer-events: none;
      }
      .cmn-connect-btn:hover text { fill: #050a12; }
      .cmn-connected-badge rect {
        rx: 5; fill: rgba(0, 210, 180, 0.15); stroke: #00d2b4; stroke-width: 1;
      }
      .cmn-connected-badge text {
        fill: #00d2b4; font-size: 9.5px; font-weight: 700; text-anchor: middle; pointer-events: none;
      }

      /* 静态模式规格卡片 */
      .cmn-static-bg {
        fill: rgba(19, 13, 30, 0.96); stroke: rgba(168, 85, 247, 0.32);
        stroke-width: 1.5; rx: 12; transition: all 0.15s ease;
      }
      .cmn-node.static-card:hover .cmn-static-bg {
        stroke: #c084fc; filter: drop-shadow(0 0 20px rgba(168, 85, 247, 0.35));
      }

      /* 模块卡片节点 */
      .cmn-node { cursor: default; outline: none; }
      .cmn-card-bg {
        fill: rgba(13, 21, 34, 0.96); stroke: rgba(255, 255, 255, 0.12);
        stroke-width: 1.5; rx: 12; transition: stroke 0.15s ease, filter 0.15s ease;
      }
      .cmn-node:hover .cmn-card-bg {
        stroke: var(--teal); filter: drop-shadow(0 0 16px var(--teal-glow));
      }
      .cmn-node.selected .cmn-card-bg {
        stroke: var(--teal); stroke-width: 2.5; fill: rgba(16, 28, 44, 0.98);
        filter: drop-shadow(0 0 24px var(--teal-glow));
      }
      .cmn-node.dimmed { opacity: 0.22; }

      /* 卡片头部拖拽区 */
      .cmn-header-bg {
        fill: rgba(255, 255, 255, 0.04); rx: 12; cursor: grab;
      }
      .cmn-header-bg:active { cursor: grabbing; }
      .cmn-title {
        font-size: 13px; font-weight: 800; fill: #ffffff; pointer-events: none;
      }
      .cmn-sub {
        font-size: 10px; fill: var(--muted); pointer-events: none;
      }
      .cmn-badge-bg { rx: 4; }
      .cmn-badge-text { font-size: 10px; font-weight: 800; text-anchor: middle; }

      /* 节点引脚 (Pins) 规格展示 */
      .cmn-pin { cursor: default; }
      .cmn-pin.pin-dep { cursor: pointer; }
      .cmn-pin .pin-row-bg {
        fill: transparent; rx: 4; transition: fill 0.15s ease;
      }
      .cmn-pin:hover .pin-row-bg {
        fill: rgba(255, 255, 255, 0.04);
      }
      .cmn-pin circle {
        fill: #09101a; stroke-width: 1.5; transition: all 0.15s ease;
      }
      .cmn-pin.pin-input circle { stroke: var(--blue); fill: var(--blue-soft); }
      .cmn-pin.pin-output circle { stroke: var(--teal); fill: var(--teal-soft); }
      .cmn-pin.pin-dep circle { stroke: var(--amber); fill: var(--amber-soft); }
      .cmn-pin.pin-dep:hover circle {
        transform: scale(1.3); stroke-width: 2.5; filter: drop-shadow(0 0 8px currentColor);
      }
      .cmn-pin text {
        font-family: var(--mono); pointer-events: none;
      }
      .cmn-pin .pin-alias-text {
        font-size: 10px; font-weight: 700; fill: #ffffff;
      }
      .cmn-pin .pin-topic-subtext {
        font-size: 8.5px;
      }

      /* 动态连线 (Cables) */
      .wiring-cable-group { cursor: pointer; }
      .wiring-cable {
        fill: none; stroke: var(--teal); stroke-width: 2.2;
        stroke-linecap: round; opacity: 0.85; transition: stroke-width 0.15s, opacity 0.15s;
      }
      .wiring-cable.bidirectional {
        stroke: #38bdf8; stroke-width: 2.6;
      }
      .wiring-cable-group:hover .wiring-cable {
        stroke: #fff; stroke-width: 3.5; opacity: 1; filter: drop-shadow(0 0 10px var(--teal));
      }
      .wiring-cable-flow {
        fill: none; stroke: rgba(255, 255, 255, 0.8); stroke-width: 1.5;
        stroke-dasharray: 6 12; animation: cableFlow 1.5s linear infinite; pointer-events: none;
      }
      .wiring-cable-flow.bidirectional {
        stroke: #a5f3fc; stroke-dasharray: 8 14;
      }
      @keyframes cableFlow {
        from { stroke-dashoffset: 36; }
        to { stroke-dashoffset: 0; }
      }

      /* 连线与依赖信息胶囊 */
      .wire-pill-bg {
        fill: rgba(13, 21, 34, 0.95); stroke: var(--teal); stroke-width: 1.2; rx: 6;
      }
      .wire-pill-bg.bidirectional {
        fill: rgba(10, 24, 42, 0.98); stroke: #38bdf8; stroke-width: 1.4;
      }
      .wire-pill-text {
        font-size: 9px; font-family: var(--mono); fill: #fff; text-anchor: middle; pointer-events: none;
      }
      .wire-pill-text.bidirectional {
        fill: #a5f3fc; font-weight: 700;
      }
      .wire-delete-btn {
        fill: rgba(244, 63, 94, 0.2); stroke: #f43f5e; stroke-width: 1; rx: 4; cursor: pointer;
      }
      .wire-delete-btn:hover {
        fill: #f43f5e;
      }
      .wire-delete-text {
        fill: #fff; font-size: 10px; font-weight: 900; text-anchor: middle; pointer-events: none;
      }

      /* 通信分类专属配色体系 (Scheme C: 专用通道 / 共享主题 / 边界接口) */
      .wiring-cable.cat-dedicated, .wiring-cable.cat-direct { stroke: #00d2b4; }
      .wiring-cable.cat-shared, .wiring-cable.cat-broadcast, .wiring-cable.cat-collector, .wiring-cable.cat-mesh { stroke: #38bdf8; }
      .wiring-cable.cat-boundary, .wiring-cable.cat-external { stroke: #c084fc; stroke-width: 2.8; }

      .wiring-cable-flow.cat-dedicated, .wiring-cable-flow.cat-direct { stroke: #a7f3d0; }
      .wiring-cable-flow.cat-shared, .wiring-cable-flow.cat-broadcast, .wiring-cable-flow.cat-collector, .wiring-cable-flow.cat-mesh { stroke: #bae6fd; }
      .wiring-cable-flow.cat-boundary, .wiring-cable-flow.cat-external { stroke: #e9d5ff; }

      .wire-pill-bg.cat-dedicated, .wire-pill-bg.cat-direct { stroke: #00d2b4; }
      .wire-pill-bg.cat-shared, .wire-pill-bg.cat-broadcast, .wire-pill-bg.cat-collector, .wire-pill-bg.cat-mesh { stroke: #38bdf8; }
      .wire-pill-bg.cat-boundary, .wire-pill-bg.cat-external { stroke: #c084fc; fill: rgba(28, 16, 48, 0.96); }

      /* 接线矩阵分类筛选胶囊 */
      .matrix-filter-pill {
        padding: 4px 10px; font-size: 11px; font-weight: 700; border-radius: 14px;
        background: rgba(255, 255, 255, 0.05); color: var(--muted); border: 1px solid rgba(255, 255, 255, 0.1);
        cursor: pointer; transition: all 0.15s ease;
      }
      .matrix-filter-pill:hover {
        background: rgba(255, 255, 255, 0.1); color: #fff;
      }
      .matrix-filter-pill.active {
        background: var(--teal-soft); color: var(--teal); border-color: var(--teal);
        box-shadow: 0 0 10px var(--teal-glow);
      }
      .matrix-filter-pill[data-filter="mesh"].active {
        background: rgba(192, 132, 252, 0.2); color: #c084fc; border-color: #c084fc;
        box-shadow: 0 0 10px rgba(192, 132, 252, 0.4);
      }
      .matrix-filter-pill[data-filter="broadcast"].active {
        background: rgba(56, 189, 248, 0.2); color: #38bdf8; border-color: #38bdf8;
        box-shadow: 0 0 10px rgba(56, 189, 248, 0.4);
      }
      .matrix-filter-pill[data-filter="direct"].active {
        background: rgba(0, 210, 180, 0.2); color: #00d2b4; border-color: #00d2b4;
        box-shadow: 0 0 10px var(--teal-glow);
      }
      .matrix-filter-pill[data-filter="collector"].active {
        background: rgba(245, 158, 11, 0.2); color: #f59e0b; border-color: #f59e0b;
        box-shadow: 0 0 10px rgba(245, 158, 11, 0.4);
      }
      .matrix-filter-pill[data-filter="external"].active {
        background: rgba(236, 72, 153, 0.2); color: #f472b6; border-color: #f472b6;
        box-shadow: 0 0 10px rgba(236, 72, 153, 0.4);
      }

      /* 编排依赖箭头与流动粒子 */
      .dag-arrow-group { cursor: pointer; }
      .dag-arrow {
        fill: none; stroke: #f59e0b; stroke-width: 2.4;
        stroke-linecap: round; marker-end: url(#marker-amber);
        opacity: 0.85; transition: stroke 0.2s ease, stroke-width 0.2s ease;
        filter: drop-shadow(0 0 5px rgba(245, 158, 11, 0.35));
      }
      .dag-arrow-flow {
        fill: none; stroke: #fef08a; stroke-width: 1.6;
        stroke-linecap: round; stroke-dasharray: 6 12;
        animation: dagFlow 2s linear infinite; pointer-events: none;
      }
      @keyframes dagFlow {
        from { stroke-dashoffset: 36; }
        to { stroke-dashoffset: 0; }
      }
      .dag-arrow-group:hover .dag-arrow {
        stroke: #fbbf24; stroke-width: 3.5; opacity: 1; filter: drop-shadow(0 0 12px var(--amber));
      }

      /* 依赖信息胶囊与断开按钮 */
      .dag-pill-bg {
        fill: rgba(13, 21, 34, 0.96); stroke: rgba(245, 158, 11, 0.7); stroke-width: 1.2; rx: 11;
        transition: all 0.2s ease;
      }
      .dag-arrow-group:hover .dag-pill-bg {
        fill: rgba(22, 34, 52, 0.98); stroke: #fbbf24;
        filter: drop-shadow(0 0 10px rgba(245, 158, 11, 0.6));
      }
      .dag-pill-text {
        font-size: 10px; font-family: var(--font); font-weight: 700; fill: #fbbf24;
        text-anchor: middle; pointer-events: none;
      }
      .dag-del-circle {
        fill: rgba(244, 63, 94, 0.15); stroke: rgba(244, 63, 94, 0.5); stroke-width: 1;
        transition: all 0.15s ease;
      }
      .dag-pill-del-btn:hover .dag-del-circle {
        fill: #f43f5e; stroke: #f43f5e; filter: drop-shadow(0 0 6px #f43f5e);
      }
      .dag-del-icon {
        fill: #f43f5e; font-size: 9px; font-weight: 900; text-anchor: middle; pointer-events: none;
        transition: fill 0.15s ease;
      }
      .dag-pill-del-btn:hover .dag-del-icon {
        fill: #ffffff;
      }

      /* 编排阶段标牌 */
      .dag-stage-badge-bg {
        fill: rgba(13, 21, 34, 0.92); stroke: rgba(245, 158, 11, 0.5); stroke-width: 1.2;
        filter: drop-shadow(0 4px 14px rgba(0, 0, 0, 0.6));
      }
      .dag-stage-badge-text {
        font-size: 11px; font-weight: 800; fill: #fbbf24; text-anchor: middle; pointer-events: none;
      }

      /* 编排卡片特化 */
      .cmn-node.orchestration-node .cmn-card-bg {
        fill: rgba(13, 21, 34, 0.96); stroke: rgba(245, 158, 11, 0.3);
        stroke-width: 1.5; rx: 12; transition: all 0.2s ease;
      }
      .cmn-node.orchestration-node:hover .cmn-card-bg {
        stroke: #fbbf24; stroke-width: 2; filter: drop-shadow(0 0 16px rgba(245, 158, 11, 0.35));
      }
      .cmn-node.orchestration-node.selected .cmn-card-bg {
        stroke: #fbbf24; stroke-width: 2.5; fill: rgba(18, 28, 44, 0.98);
        filter: drop-shadow(0 0 24px rgba(245, 158, 11, 0.55));
      }

      /* 启动编排高亮动效 (启动到哪个高亮哪个) */
      @keyframes startingPulseGlow {
        0% {
          stroke: #fbbf24;
          stroke-width: 2.8px;
          filter: drop-shadow(0 0 10px rgba(245, 158, 11, 0.6));
        }
        50% {
          stroke: #fef08a;
          stroke-width: 3.8px;
          filter: drop-shadow(0 0 26px rgba(251, 191, 36, 0.95)) drop-shadow(0 0 8px #f59e0b);
        }
        100% {
          stroke: #fbbf24;
          stroke-width: 2.8px;
          filter: drop-shadow(0 0 10px rgba(245, 158, 11, 0.6));
        }
      }

      /* 正在启动中的卡片：高亮呼吸、黄色辉光、强化层级 */
      .cmn-node.is-starting {
        z-index: 50;
      }
      .cmn-node.is-starting .cmn-card-bg {
        stroke: #fbbf24 !important;
        stroke-width: 3px !important;
        animation: startingPulseGlow 1.1s ease-in-out infinite !important;
        fill: rgba(36, 26, 10, 0.98) !important;
      }
      .cmn-node.is-starting .cmn-header-bg {
        fill: rgba(245, 158, 11, 0.22) !important;
      }
      .cmn-node.is-starting .cmn-status-dot {
        fill: #fbbf24 !important;
        animation: startingPulseGlow 0.8s ease-in-out infinite !important;
      }
      .cmn-node.is-starting .cmn-stage-badge-bg {
        fill: rgba(245, 158, 11, 0.35) !important;
        stroke: #fbbf24 !important;
        stroke-width: 1.8px !important;
      }
      .cmn-node.is-starting .cmn-badge-text {
        fill: #ffffff !important;
        font-weight: 800 !important;
      }

      /* 启动完成/在线运行的卡片：清新翡翠绿、稳健亮起 */
      .cmn-node.is-started .cmn-card-bg {
        stroke: #00d2b4 !important;
        stroke-width: 2.2px !important;
        filter: drop-shadow(0 0 16px rgba(0, 210, 180, 0.45)) !important;
        fill: rgba(10, 32, 28, 0.98) !important;
        transition: all 0.3s ease;
      }
      .cmn-node.is-started .cmn-status-dot {
        fill: #00d2b4 !important;
        filter: drop-shadow(0 0 6px #00d2b4);
      }
      .cmn-node.is-started .cmn-stage-badge-bg {
        fill: rgba(0, 210, 180, 0.15) !important;
        stroke: #00d2b4 !important;
      }
      .cmn-node.is-started .cmn-badge-text {
        fill: #00d2b4 !important;
      }

      @keyframes failedPulseGlow {
        0% {
          stroke: #f43f5e;
          stroke-width: 2.8px;
          filter: drop-shadow(0 0 10px rgba(244, 63, 94, 0.6));
        }
        50% {
          stroke: #fda4af;
          stroke-width: 3.6px;
          filter: drop-shadow(0 0 24px rgba(244, 63, 94, 0.95)) drop-shadow(0 0 8px #e11d48);
        }
        100% {
          stroke: #f43f5e;
          stroke-width: 2.8px;
          filter: drop-shadow(0 0 10px rgba(244, 63, 94, 0.6));
        }
      }

      /* 启动异常的卡片：鲜艳玫瑰红呼吸警示辉光 (前3次高频告警，随后稳定为静态警示框) */
      .cmn-node.is-failed {
        z-index: 45;
      }
      .cmn-node.is-failed .cmn-card-bg {
        stroke: #f43f5e !important;
        stroke-width: 2.8px !important;
        animation: failedPulseGlow 0.8s ease-in-out 3 !important;
        fill: rgba(38, 12, 18, 0.98) !important;
        filter: drop-shadow(0 0 12px rgba(244, 63, 94, 0.55));
      }
      .cmn-node.is-failed .cmn-header-bg {
        fill: rgba(244, 63, 94, 0.22) !important;
      }
      .cmn-node.is-failed .cmn-status-dot {
        fill: #f43f5e !important;
        animation: failedPulseGlow 0.8s ease-in-out 3 !important;
      }
      .cmn-node.is-failed .cmn-stage-badge-bg {
        fill: rgba(244, 63, 94, 0.25) !important;
        stroke: #f43f5e !important;
        stroke-width: 1.8px !important;
      }
      .cmn-node.is-failed .cmn-badge-text {
        fill: #f43f5e !important;
        font-weight: 800 !important;
      }

      /* 等待启动的卡片：半透明静止，衬托当前启动对象 */
      .cmn-node.is-pending {
        opacity: 0.42;
        transition: opacity 0.3s ease;
      }

      /* 被阻断/异常的依赖导向箭头 */
      .dag-arrow-group.is-blocked-flow .dag-arrow {
        stroke: #f43f5e !important;
        stroke-width: 3px !important;
        stroke-dasharray: 6 6 !important;
        opacity: 0.9 !important;
        filter: drop-shadow(0 0 10px rgba(244, 63, 94, 0.7));
      }
      .dag-arrow-group.is-blocked-flow .dag-arrow-flow {
        stroke: #fda4af !important;
        stroke-width: 2px !important;
        stroke-dasharray: 4 8 !important;
      }

      /* 正在激活的依赖导引流光箭头 */
      .dag-arrow-group.is-active-flow .dag-arrow {
        stroke: #fbbf24 !important;
        stroke-width: 4px !important;
        filter: drop-shadow(0 0 16px rgba(251, 191, 36, 0.9)) !important;
      }
      .dag-arrow-group.is-active-flow .dag-arrow-flow {
        stroke: #ffffff !important;
        stroke-width: 2.8px !important;
        stroke-dasharray: 8 8 !important;
        animation: dagFlow 0.7s linear infinite !important;
      }

      /* 正在执行批次的阶段顶栏高亮 */
      .dag-stage-header.is-active-stage .dag-stage-badge-bg {
        stroke: #fbbf24 !important;
        stroke-width: 2.2px !important;
        fill: rgba(245, 158, 11, 0.28) !important;
        filter: drop-shadow(0 0 16px rgba(245, 158, 11, 0.7));
      }
      .dag-stage-header.is-active-stage .dag-stage-badge-text {
        fill: #fff !important;
        font-weight: 900 !important;
      }
      .dag-stage-header.is-done-stage .dag-stage-badge-bg {
        stroke: #00d2b4 !important;
        fill: rgba(0, 210, 180, 0.15) !important;
      }
      .dag-stage-header.is-done-stage .dag-stage-badge-text {
        fill: #00d2b4 !important;
      }

      /* 浮层弹窗通用样式 */
      .hub-modal-overlay {
        position: fixed; inset: 0; background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center; z-index: 1000;
      }
      .hub-modal {
        background: #0d1522; border: 1px solid var(--border-bright); border-radius: 12px;
        width: 540px; max-width: 90vw; max-height: 85vh; display: flex; flex-direction: column;
        box-shadow: 0 20px 48px rgba(0, 0, 0, 0.6);
      }
      .hub-modal-header {
        padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex;
        justify-content: space-between; align-items: center;
      }
      .hub-modal-header h3 { margin: 0; font-size: 15px; color: #fff; }
      .hub-modal-body {
        padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;
      }
      .hub-modal-footer {
        padding: 14px 20px; border-top: 1px solid var(--border); display: flex;
        justify-content: flex-end; gap: 10px; background: rgba(0, 0, 0, 0.2);
      }
      .hub-btn {
        padding: 6px 14px; font-size: 12px; font-weight: 700; border-radius: 6px;
        border: 1px solid var(--border-bright); background: var(--surface); color: #fff;
        cursor: pointer; transition: all 0.15s ease;
      }
      .hub-btn:hover { border-color: var(--teal); }
      .hub-btn.primary { background: var(--teal); color: #050a12; border-color: var(--teal); }
      .hub-btn.danger { background: rgba(244, 63, 94, 0.15); color: #f43f5e; border-color: #f43f5e; }

      /* 统一文件/目录选择器浮层菜单 */
      .picker-popover-menu {
        position: absolute; top: calc(100% + 4px); right: 0; z-index: 1200;
        background: #0f172a; border: 1px solid rgba(0, 210, 180, 0.3); border-radius: 8px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.6), 0 0 15px rgba(0, 210, 180, 0.1);
        padding: 4px; min-width: 175px; display: flex; flex-direction: column; gap: 2px;
      }
      .picker-popover-menu.hidden { display: none !important; }
      .picker-menu-item {
        display: flex; align-items: center; gap: 8px; width: 100%;
        padding: 7px 12px; font-size: 12px; color: #cbd5e1; font-weight: 500;
        background: transparent; border: none; border-radius: 6px; cursor: pointer;
        text-align: left; transition: all 0.15s ease; white-space: nowrap;
      }
      .picker-menu-item:hover {
        background: rgba(0, 210, 180, 0.15); color: #fff;
      }

      /* 在线工坊与社区下载重构样式 */
      .ws-dialog {
        width: 1080px !important; max-width: 96vw !important; height: 88vh !important; max-height: 860px !important;
        background: #0a0f18 !important; border: 1px solid rgba(0, 210, 180, 0.25) !important;
        box-shadow: 0 25px 60px rgba(0,0,0,0.8), 0 0 40px rgba(0,210,180,0.08) !important;
      }
      .ws-detail-dialog {
        width: 780px !important; max-width: 94vw !important; max-height: 85vh !important;
        background: #0d1522 !important; border: 1px solid rgba(0, 210, 180, 0.3) !important;
        box-shadow: 0 25px 60px rgba(0,0,0,0.8) !important;
      }
      .ws-status-badge {
        font-size: 11px; font-weight: normal; color: #00d2b4; background: rgba(0, 210, 180, 0.1);
        padding: 2px 8px; border-radius: 10px; border: 1px solid rgba(0, 210, 180, 0.25);
      }
      .ws-source-bar {
        background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 8px; padding: 8px 12px; display: flex; flex-direction: column; gap: 8px;
      }
      .ws-filter-toolbar {
        display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
        background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px; padding: 8px 12px;
      }
      .ws-search-wrap {
        position: relative; flex: 1; min-width: 240px; display: flex; align-items: center;
      }
      .ws-search-icon {
        position: absolute; left: 10px; color: var(--muted); font-size: 12px; pointer-events: none;
      }
      .ws-search-input {
        width: 100%; height: 32px; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px; padding: 0 30px 0 30px; font-size: 12px; color: #fff; outline: none;
        transition: border-color 0.15s ease;
      }
      .ws-search-input:focus { border-color: var(--teal); background: rgba(0, 0, 0, 0.45); }
      .ws-search-clear {
        position: absolute; right: 8px; background: transparent; border: none; color: var(--muted);
        cursor: pointer; font-size: 12px; padding: 2px 4px; line-height: 1;
      }
      .ws-search-clear:hover { color: #fff; }
      .ws-filter-group {
        display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      }
      .ws-select {
        height: 32px; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px; padding: 0 8px; font-size: 11px; color: #e2e8f0; outline: none;
        cursor: pointer;
      }
      .ws-select:focus { border-color: var(--teal); }
      .ws-entries-container {
        flex: 1; overflow-y: auto; background: rgba(0, 0, 0, 0.25); border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.06); padding: 14px;
        display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
        grid-auto-rows: max-content;
        gap: 14px; align-content: start; min-height: 280px;
      }
      .ws-card {
        background: #111a28; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px;
        overflow: hidden; display: flex; flex-direction: column; transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
        position: relative; cursor: pointer;
      }
      .ws-card:hover {
        transform: translateY(-2px); border-color: rgba(0, 210, 180, 0.4);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4), 0 0 16px rgba(0, 210, 180, 0.12);
      }
      .ws-card-cover {
        height: 135px; width: 100%; position: relative; overflow: hidden; flex-shrink: 0;
        background: linear-gradient(135deg, #152238 0%, #0a111a 100%);
        display: flex; align-items: center; justify-content: center;
      }
      .ws-card-cover img {
        width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s ease;
        cursor: zoom-in;
      }
      .ws-card-cover img:hover { transform: scale(1.05); }
      .ws-card-cover-empty {
        width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
        background: radial-gradient(circle at 50% 50%, rgba(0, 210, 180, 0.08), transparent 70%), linear-gradient(135deg, #121c2e 0%, #0a1019 100%);
      }
      .ws-card-badge-kind {
        position: absolute; top: 8px; left: 8px; font-size: 10px; font-weight: 700;
        padding: 2px 7px; border-radius: 4px; backdrop-filter: blur(6px); z-index: 2;
      }
      .ws-badge-group {
        background: rgba(129, 140, 248, 0.85); color: #fff; box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      }
      .ws-badge-module {
        background: rgba(0, 210, 180, 0.85); color: #050a12; box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      }
      .ws-card-badge-version {
        position: absolute; top: 8px; right: 8px; font-size: 10px; font-weight: 600;
        padding: 2px 7px; border-radius: 4px; background: rgba(0, 0, 0, 0.7);
        color: #94a3b8; border: 1px solid rgba(255, 255, 255, 0.15); backdrop-filter: blur(6px); z-index: 2;
      }
      .ws-card-body {
        padding: 12px; display: flex; flex-direction: column; gap: 8px; flex: 1;
      }
      .ws-card-header {
        display: flex; gap: 10px; align-items: flex-start;
      }
      .ws-card-icon {
        width: 40px; height: 40px; border-radius: 8px; flex-shrink: 0;
        background: #1e293b; border: 1px solid rgba(255, 255, 255, 0.1);
        display: flex; align-items: center; justify-content: center; overflow: hidden;
      }
      .ws-card-icon img { width: 100%; height: 100%; object-fit: cover; }
      .ws-card-title-box { flex: 1; min-width: 0; }
      .ws-card-title {
        font-size: 13px; font-weight: 700; color: #fff; margin: 0; line-height: 1.3;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ws-card-id {
        font-size: 10px; font-family: var(--mono); color: var(--teal); margin-top: 2px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ws-card-desc {
        font-size: 11px; color: #94a3b8; line-height: 1.4; display: -webkit-box;
        -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin: 0;
        min-height: 30px;
      }
      .ws-tag-row {
        display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
      }
      .ws-tag {
        font-size: 9px; padding: 1px 6px; border-radius: 4px; white-space: nowrap;
      }
      .ws-tag-provides {
        background: rgba(0, 210, 180, 0.12); color: #00d2b4; border: 1px solid rgba(0, 210, 180, 0.25);
      }
      .ws-tag-requires {
        background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.25);
      }
      .ws-tag-meta {
        background: rgba(255, 255, 255, 0.05); color: #94a3b8; border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .ws-screenshots-row {
        display: flex; gap: 6px; align-items: center; overflow-x: auto; padding: 2px 0;
      }
      .ws-screenshot-thumb {
        height: 36px; width: 64px; object-fit: cover; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.1);
        cursor: zoom-in; transition: transform 0.15s, border-color 0.15s; flex-shrink: 0;
      }
      .ws-screenshot-thumb:hover {
        transform: scale(1.08); border-color: var(--teal);
      }
      .ws-card-footer {
        padding: 10px 12px; background: rgba(0, 0, 0, 0.2); border-top: 1px solid rgba(255, 255, 255, 0.05);
        display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-shrink: 0;
      }
      .ws-version-select {
        height: 26px; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 4px; color: #cbd5e1; font-size: 10px; font-family: var(--mono); padding: 0 4px;
        max-width: 100px;
      }
      .ws-btn-detail {
        padding: 4px 8px; font-size: 10px; border-radius: 4px; background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15); color: #fff; cursor: pointer; transition: all 0.15s;
      }
      .ws-btn-detail:hover { background: rgba(255, 255, 255, 0.15); border-color: rgba(255, 255, 255, 0.3); }
      .ws-btn-fetch {
        padding: 4px 10px; font-size: 11px; font-weight: 700; border-radius: 4px; background: var(--teal);
        border: 1px solid var(--teal); color: #050a12; cursor: pointer; transition: all 0.15s; white-space: nowrap;
      }
      .ws-btn-fetch:hover { filter: brightness(1.1); box-shadow: 0 0 10px rgba(0, 210, 180, 0.3); }
      .ws-btn-fetch:disabled { opacity: 0.5; cursor: not-allowed; }
      .ws-btn-fetch.ws-btn-import { background: #38bdf8; border-color: #38bdf8; color: #050a12; }
      .ws-btn-fetch.ws-btn-import:hover { filter: brightness(1.1); box-shadow: 0 0 10px rgba(56, 189, 248, 0.3); }
      .ws-btn-fetch.ws-btn-installed { background: rgba(0, 210, 180, 0.15); border-color: rgba(0, 210, 180, 0.3); color: var(--teal); }

      .ws-card-badge-cached {
        position: absolute; bottom: 8px; right: 8px; font-size: 10px; font-weight: 700;
        padding: 2px 7px; border-radius: 4px; background: rgba(0, 210, 180, 0.9);
        color: #050a12; box-shadow: 0 2px 6px rgba(0,0,0,0.4); backdrop-filter: blur(6px); z-index: 2;
      }
      .ws-card-badge-installed {
        position: absolute; bottom: 8px; right: 8px; font-size: 10px; font-weight: 700;
        padding: 2px 7px; border-radius: 4px; background: rgba(14, 165, 233, 0.9);
        color: #fff; box-shadow: 0 2px 6px rgba(0,0,0,0.4); backdrop-filter: blur(6px); z-index: 2;
      }
      .ws-nav-tabs {
        display: flex; gap: 8px; padding: 8px 18px 0 18px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(0, 0, 0, 0.2);
      }
      .ws-nav-tab {
        padding: 8px 16px; font-size: 12px; font-weight: 700; color: var(--muted);
        background: transparent; border: none; border-bottom: 2px solid transparent;
        cursor: pointer; display: flex; align-items: center; gap: 8px; transition: all 0.15s ease;
      }
      .ws-nav-tab:hover { color: #fff; }
      .ws-nav-tab.active {
        color: var(--teal); border-bottom-color: var(--teal); background: rgba(0, 210, 180, 0.05);
        border-radius: 6px 6px 0 0;
      }
      .ws-tab-badge {
        font-size: 10px; padding: 1px 6px; border-radius: 10px; background: rgba(255, 255, 255, 0.1);
        color: #cbd5e1; font-weight: 600;
      }
      .ws-nav-tab.active .ws-tab-badge {
        background: rgba(0, 210, 180, 0.2); color: var(--teal);
      }
      .ws-view-pane {
        width: 100%; height: 100%;
      }
      .ws-cache-stats-bar {
        display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;
        background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 8px; padding: 8px 12px; font-size: 11px;
      }
      .ws-cache-card {
        background: #111a28; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px;
        padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
        transition: transform 0.15s ease, border-color 0.15s ease;
      }
      .ws-cache-card:hover {
        transform: translateY(-2px); border-color: rgba(0, 210, 180, 0.35);
      }
      .ws-cache-card.pending {
        border-left: 3px solid var(--amber);
      }
      .ws-cache-card.installed {
        border-left: 3px solid var(--teal);
      }
      .ws-cache-status {
        font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px;
        display: inline-flex; align-items: center; gap: 4px;
      }
      .ws-cache-status.pending {
        background: rgba(245, 158, 11, 0.15); color: var(--amber); border: 1px solid rgba(245, 158, 11, 0.3);
      }
      .ws-cache-status.installed {
        background: rgba(0, 210, 180, 0.15); color: var(--teal); border: 1px solid rgba(0, 210, 180, 0.3);
      }
      .ws-version-pill {
        font-size: 10px; font-family: var(--mono); padding: 2px 8px; border-radius: 4px;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12);
        color: #cbd5e1; cursor: pointer; transition: all 0.15s;
      }
      .ws-version-pill:hover { background: rgba(0, 210, 180, 0.15); color: var(--teal); border-color: var(--teal); }
      .ws-version-pill.active { background: var(--teal); color: #050a12; font-weight: 700; border-color: var(--teal); }

      .vm-update-badge {
        font-size: 10px; font-weight: 800; color: #fbbf24; background: rgba(245, 158, 11, 0.2);
        border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 4px; padding: 1px 4px; margin-left: 4px;
        display: inline-flex; align-items: center;
      }
      .action-btn.version.has-update {
        background: rgba(245, 158, 11, 0.16) !important; color: #fbbf24 !important;
        border-color: rgba(245, 158, 11, 0.45) !important; box-shadow: 0 0 8px rgba(245, 158, 11, 0.25);
      }
      .ws-update-row {
        background: #111a28; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px;
        padding: 10px 14px; display: flex; justify-content: space-between; align-items: center;
        gap: 12px; transition: all 0.15s ease;
      }
      .ws-update-row:hover {
        border-color: rgba(0, 210, 180, 0.3); background: rgba(255, 255, 255, 0.03);
      }
      .ws-update-row.has-update { border-left: 3px solid var(--amber); }
      .ws-update-row.up-to-date { border-left: 3px solid var(--teal); }
      .ws-update-row.no-baseline { border-left: 3px solid rgba(255, 255, 255, 0.18); }
      .ws-updates-section-header {
        font-size: 11px; font-weight: 700; color: #94a3b8; letter-spacing: 0.5px;
        margin: 12px 0 6px 0; display: flex; align-items: center; gap: 6px;
      }
      .ws-update-group-card {
        background: linear-gradient(180deg, rgba(30, 41, 59, 0.5) 0%, rgba(15, 23, 42, 0.7) 100%);
        border: 1px solid rgba(129, 140, 248, 0.22);
      }
      .ws-update-group-card:hover {
        border-color: rgba(129, 140, 248, 0.45);
      }
      .ws-group-members-box {
        background: rgba(0, 0, 0, 0.22);
        border-radius: 8px;
        padding: 8px 12px;
        border: 1px solid rgba(255, 255, 255, 0.05);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .ws-group-member-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        background: rgba(30, 41, 59, 0.5);
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 6px;
        padding: 5px 10px;
        transition: border-color 0.15s, background 0.15s;
      }
      .ws-group-member-item:hover {
        border-color: rgba(0, 210, 180, 0.35);
        background: rgba(30, 41, 59, 0.85);
      }
      .ws-group-member-item.has-update {
        border-color: rgba(245, 158, 11, 0.35);
        background: rgba(245, 158, 11, 0.05);
      }
      .input-error {
        border-color: #f87171 !important;
        box-shadow: 0 0 0 1px #f87171 !important;
      }

      /* Lightbox 样式 */
      .ws-lightbox-overlay {
        position: fixed; inset: 0; background: rgba(0, 0, 0, 0.88); backdrop-filter: blur(10px);
        display: flex; align-items: center; justify-content: center; z-index: 2000;
      }
      .ws-lightbox-content {
        position: relative; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column;
        align-items: center; justify-content: center;
      }
      .ws-lightbox-image {
        max-width: 88vw; max-height: 80vh; object-fit: contain; border-radius: 8px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.9), 0 0 30px rgba(0, 210, 180, 0.2);
        border: 1px solid rgba(255, 255, 255, 0.15);
      }
      .ws-lightbox-caption {
        margin-top: 10px; font-size: 12px; color: #e2e8f0; text-align: center; max-width: 80vw;
        background: rgba(0, 0, 0, 0.6); padding: 4px 12px; border-radius: 6px;
      }
      .ws-lightbox-close {
        position: absolute; top: -38px; right: 0; background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; font-size: 18px; width: 32px; height: 32px;
        border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: background 0.15s;
      }
      .ws-lightbox-close:hover { background: rgba(244, 63, 94, 0.6); border-color: #f43f5e; }
    `;
    document.head.append(style);
  }

  // 2. 空间布局与各功能区组件注入
  injectHUDControls() {
    const topHud = document.querySelector('.top-hud');
    if (!topHud) return;

    // 1. 顶栏中间：模式分段切换器
    let modeContainer = $('hud-mode-group');
    if (!modeContainer) {
      modeContainer = document.createElement('div');
      modeContainer.className = 'hud-mode-group';
      modeContainer.id = 'hud-mode-group';
      setCanvasHtml(modeContainer, () => (`
        <button type="button" class="mode-tab-btn static" id="tab-mode-static" data-i18n="📦 已有模块" data-i18n-title="已有模块：查看所有已安装受管模块清单、规范元数据与能力声明" title="已有模块：查看所有已安装受管模块清单、规范元数据与能力声明">📦 已有模块</button>
        <button type="button" class="mode-tab-btn wiring" id="tab-mode-wiring" data-i18n="🔌 接线架构" data-i18n-title="接线模式：聚焦待接线模块，仅展示匹配候选伙伴并一键对接" title="接线模式：聚焦待接线模块，仅展示匹配候选伙伴并一键对接">🔌 接线架构</button>
        <button type="button" class="mode-tab-btn orchestration" id="tab-mode-orchestration" data-i18n="📋 启动编排" data-i18n-title="编排模式：隐藏世界枢纽，DAG 依赖箭头与启动批次" title="编排模式：隐藏世界枢纽，DAG 依赖箭头与启动批次">📋 启动编排</button>
        <button type="button" class="mode-tab-btn runtime active" id="tab-mode-runtime" data-i18n="⚡ 运行监控" data-i18n-title="运行模式：卡片实时状态与通讯流光粒子" title="运行模式：卡片实时状态与通讯流光粒子">⚡ 运行监控</button>
      `));
      const metricsGroup = topHud.querySelector('.metrics-group');
      if (metricsGroup) {
        metricsGroup.after(modeContainer);
      } else {
        topHud.prepend(modeContainer);
      }
    }

    // 2. 脱离顶栏的独立组件：模块组筛选器 (位于 top-hud 最左侧下方)
    let groupSelect = $('hud-group-filter');
    if (!groupSelect) {
      const groupPanel = document.createElement('div');
      groupPanel.id = 'detached-hud-group';
      groupPanel.className = 'detached-hud-panel detached-hud-left';
      setCanvasAttribute(groupPanel, 'aria-label', () => ('模块组选择栏'));
      groupPanel.setAttribute('data-i18n-aria-label', '模块组选择栏');
      setCanvasHtml(groupPanel, () => (`
        <select class="hud-group-select" id="hud-group-filter" aria-label="模块组范围筛选" data-i18n-aria-label="模块组范围筛选">
          <option value="all" data-i18n="🌐 全局全部模块">🌐 全局全部模块</option>
        </select>
      `));
      document.body.append(groupPanel);
    }

    // 3. 左侧垂直工具坞 (Left Tool Dock - 收纳为单一添加中心)
    if (!$('left-tool-dock')) {
      const dock = document.createElement('aside');
      dock.id = 'left-tool-dock';
      dock.className = 'left-tool-dock';
      setCanvasAttribute(dock, 'aria-label', () => ('系统创作与接入工具坞'));
      dock.setAttribute('data-i18n-aria-label', '系统创作与接入工具坞');
      setCanvasHtml(dock, () => (`
        <button type="button" class="dock-btn" id="btn-dock-add-menu" data-tooltip="➕ 添加与创作 (6 大功能)" data-i18n-tooltip="➕ 添加与创作 (6 大功能)" data-i18n-title="➕ 添加与创作 (6 大功能)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="transition: transform 0.22s ease;"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      `));
      document.body.append(dock);
    }

    // 3.1 左侧 + 展开选项浮动面板 (6 大新建与接入功能)
    if (!$('dock-add-flyout-panel')) {
      const flyout = document.createElement('div');
      flyout.id = 'dock-add-flyout-panel';
      flyout.className = 'dock-flyout-panel';
      flyout.setAttribute('role', 'menu');
      setCanvasAttribute(flyout, 'aria-label', () => ('添加与新建选项'));
      setCanvasHtml(flyout, () => (`
        <div class="dock-flyout-header">
          <span class="dock-flyout-title" data-i18n="➕ 添加、创作与接入">➕ 添加、创作与接入</span>
          <button type="button" class="dock-flyout-close" id="btn-close-dock-flyout" title="关闭 (ESC)" data-i18n-title="关闭 (ESC)">✕</button>
        </div>
        <button type="button" class="dock-flyout-item" id="btn-action-group" role="menuitem">
          <div class="dock-flyout-icon-box">📁</div>
          <div class="dock-flyout-item-body">
            <div class="dock-flyout-item-title">
              <span data-i18n="新建模块分组">新建模块分组</span>
              <span class="tag">Group</span>
            </div>
            <div class="dock-flyout-item-desc" data-i18n="创建自定义业务逻辑分组，隔离监控与编排">创建自定义业务逻辑分组，隔离监控与编排</div>
          </div>
        </button>
        <button type="button" class="dock-flyout-item" id="btn-action-scaffold" role="menuitem">
          <div class="dock-flyout-icon-box">🛠</div>
          <div class="dock-flyout-item-body">
            <div class="dock-flyout-item-title">
              <span data-i18n="新建模块">新建模块</span>
              <span class="tag" data-i18n="模块脚手架">模块脚手架</span>
            </div>
            <div class="dock-flyout-item-desc" data-i18n="使用向导生成 Node / Python 独立模块">使用向导生成 Node / Python 独立模块</div>
          </div>
        </button>
        <button type="button" class="dock-flyout-item" id="btn-action-package" role="menuitem">
          <div class="dock-flyout-icon-box">📦</div>
          <div class="dock-flyout-item-body">
            <div class="dock-flyout-item-title">
              <span data-i18n="导出模块 / 模块组">导出模块 / 模块组</span>
              <span class="tag" data-i18n="分发制品">分发制品</span>
            </div>
            <div class="dock-flyout-item-desc" data-i18n="导出单模块源码或现有组的成员、公开接线与启动计划">导出单模块源码或现有组的成员、公开接线与启动计划</div>
          </div>
        </button>
        <button type="button" class="dock-flyout-item" id="btn-action-download" role="menuitem">
          <div class="dock-flyout-icon-box">🌐</div>
          <div class="dock-flyout-item-body">
            <div class="dock-flyout-item-title">
              <span data-i18n="下载模块 / 模块组">下载模块 / 模块组</span>
              <span class="tag" data-i18n="在线工坊与源">在线工坊与源</span>
            </div>
            <div class="dock-flyout-item-desc" data-i18n="从社区选择版本与摘要，下载后审阅导入本机 Hub">从社区选择版本与摘要，下载后审阅导入本机 Hub</div>
          </div>
        </button>
        <button type="button" class="dock-flyout-item" id="btn-action-import" role="menuitem">
          <div class="dock-flyout-icon-box">📂</div>
          <div class="dock-flyout-item-body">
            <div class="dock-flyout-item-title">
              <span data-i18n="导入模块 / 模块组">导入模块 / 模块组</span>
              <span class="tag" data-i18n="文件路径导入">文件路径导入</span>
            </div>
            <div class="dock-flyout-item-desc" data-i18n="选择目录、ZIP 或 JSON 分发文件，导入后保持停止">选择目录、ZIP 或 JSON 分发文件，导入后保持停止</div>
          </div>
        </button>
        <button type="button" class="dock-flyout-item" id="btn-action-external" role="menuitem">
          <div class="dock-flyout-icon-box">🔗</div>
          <div class="dock-flyout-item-body">
            <div class="dock-flyout-item-title">
              <span data-i18n="接入模块">接入模块</span>
              <span class="tag" data-i18n="外部程序授权">外部程序授权</span>
            </div>
            <div class="dock-flyout-item-desc" data-i18n="签发客户端临时接入凭据，桥接独立运行程序">签发客户端临时接入凭据，桥接独立运行程序</div>
          </div>
        </button>
        <div class="dock-flyout-footer">
          <button type="button" class="dock-flyout-footer-btn" id="btn-flyout-env" title="检测 Node / Python 运行环境" data-i18n="🖥 环境探测" data-i18n-title="检测 Node / Python 运行环境">
            🖥 环境探测
          </button>
          <button type="button" class="dock-flyout-footer-btn" id="btn-flyout-layout" title="智能整理画布卡片排版" data-i18n="⚡ 智能排版" data-i18n-title="智能整理画布卡片排版">
            ⚡ 智能排版
          </button>
        </div>
      `));
      document.body.append(flyout);
    }

    // 4. 脱离顶栏的中部浮动独立组件：底层执行控制台 (位于 top-hud 中部正下方)
    let execPanel = $('bottom-exec-controls');
    if (!execPanel) {
      execPanel = document.createElement('div');
      execPanel.id = 'bottom-exec-controls';
      execPanel.className = 'detached-hud-panel detached-hud-center bottom-exec-controls';
      setCanvasHtml(execPanel, () => (`
        <button type="button" class="hud-action-pill primary" id="btn-run-plan" data-i18n="▶ 启动计划">▶ 启动计划</button>
        <button type="button" class="hud-action-pill primary hidden" id="btn-run-group" data-i18n="▶ 启动本组常驻计划">▶ 启动本组常驻计划</button>
        <button type="button" class="hud-action-pill danger hidden" id="btn-stop-group" data-i18n="■ 停止本组">■ 停止本组</button>
        <button type="button" class="hud-action-pill" id="btn-stop-all" data-i18n="■ 全部停止">■ 全部停止</button>
        <select class="hud-group-select" id="hud-failure-policy" title="编排启动失败策略" data-i18n-title="编排启动失败策略">
          <option value="continue-independent" data-i18n="遇错继续 (continue)">遇错继续 (continue)</option>
          <option value="stop-plan" data-i18n="遇错中止 (stop-plan)">遇错中止 (stop-plan)</option>
        </select>
        <button type="button" class="hud-action-pill primary hidden" id="btn-auto-wire" title="自动扫描同名与兼容通信通道并建立接线" data-i18n="⚡ 智能自动对接" data-i18n-title="自动扫描同名与兼容通信通道并建立接线">⚡ 智能自动对接</button>
        <button type="button" class="hud-action-pill hidden" id="btn-wiring-matrix" title="打开通道接线矩阵与快捷配对清单" data-i18n="🔌 接线矩阵清单" data-i18n-title="打开通道接线矩阵与快捷配对清单">🔌 接线矩阵清单</button>
        <button type="button" class="hud-action-pill hidden" id="btn-restore-default-wiring" title="审阅并恢复作者默认接线" data-i18n="↺ 恢复默认接线" data-i18n-title="审阅并恢复作者默认接线">↺ 恢复默认接线</button>
      `));
      document.body.append(execPanel);
    } else {
      execPanel.classList.add('detached-hud-panel', 'detached-hud-center');
      if (execPanel.parentElement && execPanel.parentElement.id === 'bottom-status-bar') {
        document.body.append(execPanel);
      }
    }

    this.ensureWiringActionButtons(execPanel);

    // 4.1 底部状态监控托盘 (Bottom Status Bar)
    if (!$('bottom-status-bar')) {
      const bottomBar = document.createElement('footer');
      bottomBar.id = 'bottom-status-bar';
      bottomBar.className = 'bottom-status-bar';
      setCanvasHtml(bottomBar, () => (`
        <div class="bottom-ticker-wrap" id="bottom-event-ticker" title="点击定位最新活跃通讯连线" data-i18n-title="点击定位最新活跃通讯连线">
          <span class="ticker-pulse-dot"></span>
          <span class="ticker-text" id="bottom-ticker-text" data-i18n="等待通讯事件…">等待通讯事件…</span>
        </div>
        <div class="bottom-center-wrap" style="display:flex; align-items:center; justify-content:center; flex:1; min-width:0;">
          <span id="bottom-wiring-summary" class="hidden" style="font-size:11px; color:#38bdf8; font-family:var(--mono); white-space:nowrap; text-overflow:ellipsis; overflow:hidden;"></span>
          <span id="bottom-static-summary" class="hidden" style="font-size:11px; color:#c084fc; font-family:var(--mono); white-space:nowrap; text-overflow:ellipsis; overflow:hidden;"></span>
          <span id="bottom-orch-summary" class="hidden" style="font-size:11px; color:#fbbf24; font-family:var(--mono); white-space:nowrap; text-overflow:ellipsis; overflow:hidden;"></span>
        </div>
        <div class="bottom-right-actions">
          <button type="button" class="bottom-toggle-stream-btn" id="btn-manual-console" title="用界面自己的模块桥手动操作通讯" data-i18n="↗ 通讯工作台" data-i18n-title="用界面自己的模块桥手动操作通讯">
            ↗ 通讯工作台
          </button>
          <button type="button" class="bottom-toggle-stream-btn" id="btn-retention-toggle" title="查看留存与容量边界" data-i18n="📦 留存容量" data-i18n-title="查看留存与容量边界">
            📦 留存容量
          </button>
          <button type="button" class="bottom-toggle-stream-btn" id="btn-stream-drawer-toggle" data-i18n-title="展开实时通讯流水抽屉" title="展开实时通讯流水抽屉">
            <span data-i18n="📊 信息流水">📊 信息流水</span> <span id="bottom-stream-count-tag" style="opacity:0.7;">(150)</span> ▲
          </button>
        </div>
      `));
      document.body.append(bottomBar);
    } else {
      const statusBar = $('bottom-status-bar');
      let centerWrap = statusBar.querySelector('.bottom-center-wrap');
      if (!centerWrap) {
        centerWrap = document.createElement('div');
        centerWrap.className = 'bottom-center-wrap';
        centerWrap.style.cssText = 'display:flex; align-items:center; justify-content:center; flex:1; min-width:0;';
        const rightActions = statusBar.querySelector('.bottom-right-actions');
        if (rightActions) statusBar.insertBefore(centerWrap, rightActions);
        else statusBar.append(centerWrap);
      }
      ['bottom-wiring-summary', 'bottom-static-summary', 'bottom-orch-summary'].forEach(id => {
        const el = $(id);
        if (el && el.parentElement !== centerWrap) {
          centerWrap.append(el);
        }
      });
    }

    // 5. 视角切换按键 (排放在 detached-hud-panel detached-hud-left 右侧) 与悬浮控制器增强
    const detachedHudLeft = $('detached-hud-group') || document.querySelector('.detached-hud-panel.detached-hud-left');
    let perspBtn = $('btn-perspective-toggle');
    if (!perspBtn && detachedHudLeft) {
      perspBtn = document.createElement('button');
      perspBtn.type = 'button';
      perspBtn.className = 'ctrl-perspective-btn';
      perspBtn.id = 'btn-perspective-toggle';
      setCanvasAttribute(perspBtn, 'title', () => (t('在微服务拓扑卡片与天体同心圆轨道视角间切换')));
      setCanvasText(perspBtn, () => (this.runtimePerspective === 'topology' ? t('🗺 拓扑卡片') : t('🪐 天体星轨')));
      perspBtn.style.display = 'none';
      detachedHudLeft.appendChild(perspBtn);
    } else if (perspBtn && detachedHudLeft && perspBtn.parentElement !== detachedHudLeft) {
      detachedHudLeft.appendChild(perspBtn);
    }

    const controls = document.querySelector('.canvas-controls');
    let layoutBtn = $('btn-auto-layout-ctrl');
    if (!layoutBtn && controls) {
      layoutBtn = document.createElement('button');
      layoutBtn.type = 'button';
      layoutBtn.className = 'ctrl-btn';
      layoutBtn.id = 'btn-auto-layout-ctrl';
      setCanvasAttribute(layoutBtn, 'title', () => (t('智能排版 (按层级自整齐)')));
      setCanvasAttribute(layoutBtn, 'aria-label', () => (t('智能排版')));
      layoutBtn.setAttribute('data-i18n-title', '智能排版 (按层级自整齐)');
      layoutBtn.setAttribute('data-i18n-aria-label', '智能排版');
      setCanvasHtml(layoutBtn, () => (`<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>`));
      controls.prepend(layoutBtn);
    }
    if (layoutBtn) {
      if (!layoutBtn.querySelector('svg')) {
        setCanvasHtml(layoutBtn, () => (`<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>`));
      }
      if (!layoutBtn.dataset.boundAutoLayout) {
        layoutBtn.dataset.boundAutoLayout = 'true';
        layoutBtn.addEventListener('click', () => this.autoLayout());
      }
    }

    // 移除旧版接线顶栏（已全面升级为画布卡片直观接线）
    $('wiring-focus-bar')?.remove();

    // 7. 已有模块规格清单顶部过滤条 (与 bottom-exec-controls 对齐的居中 detached-hud-panel)
    let staticBar = $('static-filter-bar');
    if (!staticBar) {
      staticBar = document.createElement('div');
      staticBar.id = 'static-filter-bar';
      staticBar.className = 'detached-hud-panel detached-hud-center static-filter-bar hidden';
      staticBar.style.display = 'none';
      setCanvasHtml(staticBar, () => (`
        <span style="font-size:11px; font-weight:800; color:#c084fc; white-space:nowrap;" data-i18n="📦 已有模块清单">📦 已有模块清单</span>
        <input type="text" id="inp-filter-static" placeholder="按名称/ID/能力检索..." data-i18n-placeholder="按名称/ID/能力检索..." style="padding:3px 10px; font-size:11px; border-radius:6px; background:rgba(0,0,0,0.5); border:1px solid rgba(168,85,247,0.4); color:#fff; width:180px; outline:none;">
      `));
      document.body.append(staticBar);
    } else {
      staticBar.className = 'detached-hud-panel detached-hud-center static-filter-bar hidden';
      setCanvasHtml(staticBar, () => (`
        <span style="font-size:11px; font-weight:800; color:#c084fc; white-space:nowrap;" data-i18n="📦 已有模块清单">📦 已有模块清单</span>
        <input type="text" id="inp-filter-static" placeholder="按名称/ID/能力检索..." data-i18n-placeholder="按名称/ID/能力检索..." style="padding:3px 10px; font-size:11px; border-radius:6px; background:rgba(0,0,0,0.5); border:1px solid rgba(168,85,247,0.4); color:#fff; width:180px; outline:none;">
      `));
    }
  }

  // 3. SVG 容器层与 Marker 注入
  injectSVGLayers() {
    const defs = $('canvas-svg')?.querySelector('defs');
    if (defs && !$('marker-amber')) {
      const marker = svgEl('marker', {
        id: 'marker-amber',
        markerWidth: '8',
        markerHeight: '8',
        refX: '6',
        refY: '4',
        orient: 'auto'
      });
      marker.append(svgEl('path', { d: 'M0,1 L7,4 L0,7 Z', fill: '#f59e0b' }));
      defs.append(marker);
    }

    const viewport = $('viewport');
    if (!viewport) return;

    if (!$('group-containers-g')) {
      viewport.append(svgEl('g', { id: 'group-containers-g', class: 'hidden' }));
    }
    if (!$('wiring-cables-g')) {
      viewport.append(svgEl('g', { id: 'wiring-cables-g', class: 'hidden' }));
    }
    if (!$('orchestration-dag-g')) {
      viewport.append(svgEl('g', { id: 'orchestration-dag-g', class: 'hidden' }));
    }
    if (!$('module-nodes-g')) {
      viewport.append(svgEl('g', { id: 'module-nodes-g', class: 'hidden' }));
    }
    if (!$('drag-cable-path')) {
      viewport.append(svgEl('path', {
        id: 'drag-cable-path',
        class: 'hidden',
        fill: 'none',
        stroke: '#00d2b4',
        'stroke-width': '2.5',
        'stroke-dasharray': '5 5'
      }));
    }
  }

  // 4. 侧边检查器抽屉注入模块面板
  injectInspectorContent() {
    const drawerBody = document.querySelector('#inspector-drawer .drawer-body');
    if (!drawerBody || $('ins-module-content')) return;

    const moduleContainer = document.createElement('div');
    moduleContainer.id = 'ins-module-content';
    moduleContainer.className = 'drawer-content-group hidden';
    setCanvasHtml(moduleContainer, () => (`
      <div class="section-block">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <h3 id="ins-mod-name" style="margin:0;" data-i18n="模块实例">模块实例</h3>
          <span class="acl-pill" id="ins-mod-status" data-i18n="未启动">未启动</span>
        </div>
        <p class="action-help-text" id="ins-mod-desc" data-i18n="外部独立程序，通过世界枢纽完成语义通讯与数据订阅。">外部独立程序，通过世界枢纽完成语义通讯与数据订阅。</p>
        <div id="ins-mod-meta" style="font-size:11px; color:var(--muted); margin:4px 0 8px;"></div>

        <!-- 故障诊断告警盒 -->
        <div id="ins-mod-error-box" class="section-block hidden" style="border-color:#f43f5e; background:rgba(244,63,94,0.08); padding:8px 12px; margin-bottom:8px;">
          <div style="font-weight:700; color:#f43f5e; font-size:11px; margin-bottom:2px;" id="ins-mod-error-code" data-i18n="退出故障诊断">退出故障诊断</div>
          <div style="font-size:11px; color:var(--ink-dim);" id="ins-mod-error-msg" data-i18n="未知错误">未知错误</div>
        </div>

        <div class="btn-group" style="margin-top:8px;">
          <button type="button" class="action-btn resume" id="btn-ins-start" title="启动进程" aria-label="启动进程" data-i18n-title="启动进程" data-i18n-aria-label="启动进程" style="font-size:14px;">▶</button>
          <button type="button" class="action-btn danger" id="btn-ins-stop" title="停止进程" aria-label="停止进程" data-i18n-title="停止进程" data-i18n-aria-label="停止进程" style="font-size:14px;">■</button>
          <button type="button" class="action-btn audit" id="btn-ins-security-review" title="查看模块安全指纹与权限审计" aria-label="查看模块安全指纹与权限审计" data-i18n-title="查看模块安全指纹与权限审计" data-i18n-aria-label="查看模块安全指纹与权限审计" style="font-size:14px;">🛡</button>
          <button type="button" class="action-btn uninstall" id="btn-ins-remove" title="卸载并移除此模块" aria-label="卸载并移除此模块" data-i18n-title="卸载并移除此模块" data-i18n-aria-label="卸载并移除此模块" style="font-size:14px;">🗑</button>
        </div>
      </div>

      <!-- 模块属性标签页 -->
      <div class="stream-tabs" style="margin: 4px 0 10px;">
        <button type="button" class="tab-btn" id="tab-mod-settings" aria-pressed="true" data-i18n="⚙ 实例参数">⚙ 实例参数</button>
        <button type="button" class="tab-btn" id="tab-mod-topics" aria-pressed="false" data-i18n="🔌 通道接线">🔌 通道接线</button>
        <button type="button" class="tab-btn" id="tab-mod-deps" data-i18n="⏱ 运行与编排" aria-pressed="false">⏱ 运行与编排</button>
        <button type="button" class="tab-btn" id="tab-mod-logs" aria-pressed="false" data-i18n="📄 控制台日志">📄 控制台日志</button>
      </div>

      <!-- 参数面板 -->
      <div id="ins-panel-settings" class="section-block">
        <h3 style="margin-bottom:8px;" data-i18n="运行时参数配置">运行时参数配置</h3>
        <div id="ins-settings-fields"></div>
        <div style="margin-top:12px;">
          <label class="form-label" data-i18n="所属模块分组">所属模块分组</label>
          <select id="ins-mod-group-assign" class="drawer-input"></select>
        </div>
        <div class="drawer-footer" style="margin-top:14px;">
          <button type="button" class="action-btn" id="btn-ins-save-config" style="background:var(--teal); color:#050a12; font-weight:800;" data-i18n="保存配置并生效">保存配置并生效</button>
        </div>
      </div>

      <!-- 接线面板 -->
      <div id="ins-panel-topics" class="section-block hidden">
        <h3 style="margin-bottom:8px;" data-i18n="声明的通信通道">声明的通信通道</h3>
        <div id="ins-topics-list"></div>
      </div>

      <!-- 依赖面板 -->
      <div id="ins-panel-deps" class="section-block hidden">
        <div id="ins-execution-policy" style="margin-bottom:16px;"></div>
        <label class="form-label"><input type="checkbox" id="ins-plan-enabled"> <span data-i18n="加入当前范围常驻启动计划">加入当前范围常驻启动计划</span></label>
        <p class="action-help-text" id="ins-plan-mode-note"></p>
        <button type="button" class="action-btn" id="btn-ins-save-plan-member" data-i18n="保存计划选择">保存计划选择</button>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <h3 style="margin:0;" data-i18n="启动前置依赖">启动前置依赖</h3>
        </div>
        <div id="ins-deps-list"></div>
        <div style="margin-top:12px; display:flex; gap:6px;">
          <select id="ins-add-dep-select" class="drawer-input" style="flex:1;">
            <option value="" data-i18n="+ 选择前置依赖模块...">+ 选择前置依赖模块...</option>
          </select>
          <button type="button" class="hud-btn primary" id="btn-ins-add-dep" style="padding:4px 10px;" data-i18n="添加">添加</button>
        </div>
      </div>

      <!-- 日志面板 -->
      <div id="ins-panel-logs" class="section-block hidden">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <h3 style="margin:0;" data-i18n="实时输出 (stdout/stderr)">实时输出 (stdout/stderr)</h3>
          <button type="button" class="hud-btn" id="btn-ins-refresh-logs" style="padding:2px 8px; font-size:10px;" data-i18n="刷新日志">刷新日志</button>
        </div>
        <pre class="dialog-pre" id="ins-logs-content" style="max-height:280px; font-size:10px; overflow-y:auto;" data-i18n="无输出记录">无输出记录</pre>
      </div>
    `));
    drawerBody.append(moduleContainer);

    if (!$('ins-group-content')) {
      const groupContainer = document.createElement('div');
      groupContainer.id = 'ins-group-content';
      groupContainer.className = 'drawer-content-group hidden';
      setCanvasHtml(groupContainer, () => (`
        <div class="section-block">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <h3 id="ins-grp-name" style="margin:0;" data-i18n="模块组">模块组</h3>
            <span class="acl-pill" id="ins-grp-status" data-i18n="未启动">未启动</span>
          </div>
          <p class="action-help-text" id="ins-grp-desc" data-i18n="协同模块组，统一管理组内成员生命周期、内部接线与跨组拓扑。">协同模块组，统一管理组内成员生命周期、内部接线与跨组拓扑。</p>
          <div id="ins-grp-meta" style="font-size:11px; color:var(--muted); margin:4px 0 8px;"></div>

          <div class="btn-group" style="margin-top:8px;">
            <button type="button" class="action-btn resume" id="btn-grp-start" title="启动整组" aria-label="启动整组" data-i18n-title="启动整组" data-i18n-aria-label="启动整组" style="font-size:14px;">▶</button>
            <button type="button" class="action-btn danger" id="btn-grp-stop" title="停止整组" aria-label="停止整组" data-i18n-title="停止整组" data-i18n-aria-label="停止整组" style="font-size:14px;">■</button>
            <button type="button" class="action-btn uninstall" id="btn-grp-remove" title="卸载此模块组" aria-label="卸载此模块组" data-i18n-title="卸载此模块组" data-i18n-aria-label="卸载此模块组" style="font-size:14px;">🗑</button>
          </div>
        </div>

        <!-- 模块组标签页 -->
        <div class="stream-tabs" style="margin: 4px 0 10px;">
          <button type="button" class="tab-btn" id="tab-grp-members" aria-pressed="true" data-i18n="📋 组内成员">📋 组内成员</button>
          <button type="button" class="tab-btn" id="tab-grp-topics" aria-pressed="false" data-i18n="🔌 通道接线">🔌 通道接线</button>
        </div>

        <!-- 成员面板 -->
        <div id="ins-grp-panel-members" class="section-block">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <h4 style="margin:0; font-size:12px; color:var(--ink);" data-i18n="组内成员列表">组内成员列表</h4>
            <span id="ins-grp-members-count" style="font-size:11px; color:var(--muted);" data-i18n="0 个成员">0 个成员</span>
          </div>
          <div id="ins-grp-members-list" style="display:flex; flex-direction:column; gap:6px; margin-bottom:12px;"></div>
          <div class="drawer-footer" style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; border-top:1px solid var(--border); padding-top:10px;">
            <button type="button" class="hud-btn" id="btn-grp-restore-wiring" style="font-size:11px;" data-i18n="🔄 恢复默认接线">🔄 恢复默认接线</button>
            <button type="button" class="hud-btn" id="btn-grp-package" style="font-size:11px;" data-i18n="📦 打包导出制品">📦 打包导出制品</button>
          </div>
        </div>

        <!-- 接线面板 -->
        <div id="ins-grp-panel-topics" class="section-block hidden">
          <h4 style="margin:0 0 8px; font-size:12px; color:var(--ink);" data-i18n="组内及跨组通道拓扑">组内及跨组通道拓扑</h4>
          <div id="ins-grp-topics-list"></div>
        </div>
      `));
      drawerBody.append(groupContainer);
    }

    // 确保 drawer-head 中存在位于关闭按钮左侧的“版本”操作按键
    if (!$('btn-ins-versions')) {
      const insClose = $('ins-close');
      const verBtn = document.createElement('button');
      verBtn.type = 'button';
      verBtn.className = 'action-btn version hidden';
      verBtn.id = 'btn-ins-versions';
      setCanvasAttribute(verBtn, 'title', () => (t('版本升级与回退')));
      setCanvasAttribute(verBtn, 'aria-label', () => (t('版本升级与回退')));
      verBtn.setAttribute('data-i18n', '🏷 版本');
      verBtn.setAttribute('data-i18n-title', '版本升级与回退');
      verBtn.setAttribute('data-i18n-aria-label', '版本升级与回退');
      verBtn.style.cssText = 'display:inline-flex; align-items:center; gap:4px; font-size:11px; padding:3px 10px; height:28px; line-height:1; font-weight:700; border-radius:6px; background:rgba(0,210,180,0.12); color:var(--teal); border:1px solid rgba(0,210,180,0.35); cursor:pointer;';
      setCanvasText(verBtn, () => (t('🏷 版本')));
      if (insClose?.parentNode) {
        insClose.parentNode.insertBefore(verBtn, insClose);
      } else {
        document.body.append(verBtn);
      }
    }
  }

  // 5. 模态对话框注入（导入模块、管理分组）
  injectModals() {
    if ($('import-module-modal')) return;

    // 导入模块弹窗
    const importModal = document.createElement('div');
    importModal.id = 'import-module-modal';
    importModal.className = 'hub-modal-overlay hidden';
    setCanvasHtml(importModal, () => (`
      <div class="hub-modal">
        <div class="hub-modal-header">
          <h3 data-i18n="导入模块 / 模块组到本机 Hub">导入模块 / 模块组到本机 Hub</h3>
          <button type="button" class="hud-btn" id="btn-close-import-modal">✕</button>
        </div>
        <div class="hub-modal-body">
          <div>
            <label class="form-label" data-i18n="模块或模块组目录 / ZIP / artifact.json 文件">模块或模块组目录 / ZIP / artifact.json 文件</label>
            <div style="display:flex; gap:8px; align-items:center;">
              <input type="text" id="inp-import-path" class="drawer-input" placeholder="例如: C:\\path\\to\\my-module 或 my-module.zip" data-i18n-placeholder="例如: C:\\path\\to\\my-module 或 my-module.zip" data-i18n-placeholder="例如: C:\\path\\to\\my-module 或 my-module.zip" style="flex:1;">
              <div class="picker-dropdown-wrap" style="position:relative;">
                <button type="button" class="hud-action-pill" id="btn-native-pick" title="选择本地目录或制品文件 (自动适应)" data-i18n-title="选择本地目录或制品文件 (自动适应)" data-i18n-title="选择本地目录或制品文件 (自动适应)" style="padding:0 12px; height:34px; font-size:14px; display:inline-flex; align-items:center; justify-content:center;">📁</button>
                <div id="import-pick-menu" class="picker-popover-menu hidden">
                  <button type="button" class="picker-menu-item" id="btn-import-pick-dir" data-i18n="📁 本地目录 (Folder)">📁 本地目录 (Folder)</button>
                  <button type="button" class="picker-menu-item" id="btn-import-pick-file" data-i18n="📄 制品文件 (ZIP / JSON)">📄 制品文件 (ZIP / JSON)</button>
                </div>
              </div>
              <button type="button" class="hub-btn primary" id="btn-do-inspect" style="height:34px; padding:0 16px; white-space:nowrap;" data-i18n="检测模块">检测模块</button>
            </div>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <button type="button" class="hud-action-pill" id="btn-toggle-tree-browser" style="padding:4px 10px; font-size:11px;" data-i18n="📂 展开网页目录树浏览...">📂 展开网页目录树浏览...</button>
          </div>
          <div id="import-tree-browser" class="section-block hidden" style="background:rgba(0,0,0,0.3); border:1px solid var(--border); border-radius:6px; padding:10px; max-height:220px; overflow-y:auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; font-size:11px;">
              <span id="tree-current-path" style="font-family:var(--mono); color:var(--teal); word-break:break-all;"></span>
              <div id="tree-roots-bar" style="display:flex; gap:4px; flex-wrap:wrap;"></div>
            </div>
            <div id="tree-entries-list" style="display:flex; flex-direction:column; gap:4px; font-size:11px;"></div>
          </div>
          <div>
            <label class="form-label" data-i18n="已知可用预设模块">已知可用预设模块</label>
            <div id="import-known-paths" style="display:flex; flex-wrap:wrap; gap:6px;"></div>
          </div>
          <div id="import-preview-box" class="section-block hidden" style="background:rgba(255,255,255,0.02);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong id="import-prev-title" style="color:var(--teal);"></strong>
              <span id="import-prev-runtime" class="acl-pill"></span>
            </div>
            <div id="import-prev-desc" style="font-size:11px; color:var(--muted); margin-bottom:8px;"></div>
            <div id="import-prev-bindings"></div>
          </div>
        </div>
        <div class="hub-modal-footer">
          <button type="button" class="hub-btn" id="btn-cancel-import" data-i18n="取消">取消</button>
          <button type="button" class="hub-btn primary" id="btn-confirm-import" disabled data-i18n="确认导入并加入画布">确认导入并加入画布</button>
        </div>
      </div>
    `));
    document.body.append(importModal);

    // 分组管理弹窗
    const groupModal = document.createElement('div');
    groupModal.id = 'group-manager-modal';
    groupModal.className = 'hub-modal-overlay hidden';
    setCanvasHtml(groupModal, () => (`
      <div class="hub-modal">
        <div class="hub-modal-header">
          <h3 data-i18n="模块分组管理">模块分组管理</h3>
          <button type="button" class="hud-btn" id="btn-close-group-modal">✕</button>
        </div>
        <div class="hub-modal-body">
          <div>
            <label class="form-label" data-i18n="新建模块组">新建模块组</label>
            <div style="display:flex; gap:8px;">
              <input type="text" id="inp-new-group-title" class="drawer-input" placeholder="输入分组名称 (如: 文本处理套件)" data-i18n-placeholder="输入分组名称 (如: 文本处理套件)" data-i18n-placeholder="输入分组名称 (如: 文本处理套件)" style="flex:1;">
              <button type="button" class="hub-btn primary" id="btn-create-group" data-i18n="新建组">新建组</button>
            </div>
          </div>
          <div style="margin-top:10px;">
            <label class="form-label" data-i18n="已有模块分组">已有模块分组</label>
            <div id="group-list-box" style="display:flex; flex-direction:column; gap:8px;"></div>
          </div>
        </div>
        <div class="hub-modal-footer">
          <button type="button" class="hub-btn" id="btn-finish-group" data-i18n="关闭">关闭</button>
        </div>
      </div>
    `));
    document.body.append(groupModal);

    // 环境探测弹窗
    const envModal = document.createElement('div');
    envModal.id = 'env-detect-modal';
    envModal.className = 'hub-modal-overlay hidden';
    setCanvasHtml(envModal, () => (`
      <div class="hub-modal" style="max-width:540px;">
        <div class="hub-modal-header">
          <h3 data-i18n="🖥 本机运行环境与解释器探测">🖥 本机运行环境与解释器探测</h3>
          <button type="button" class="hud-btn" id="btn-close-env-modal">✕</button>
        </div>
        <div class="hub-modal-body">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <span style="font-size:12px; color:var(--muted);" data-i18n="探测本地 Node.js / Python 解释器版本、架构以及 websockets 依赖">探测本地 Node.js / Python 解释器版本、架构以及 websockets 依赖</span>
            <button type="button" class="hub-btn primary" id="btn-reprobe-env" style="padding:4px 10px; font-size:11px;" data-i18n="🔍 重新探测">🔍 重新探测</button>
          </div>
          <div id="env-detect-cards" style="display:flex; flex-direction:column; gap:10px;">
            <div style="font-size:12px; color:var(--muted);" data-i18n="点击“重新探测”检测本机 Node.js 与 Python 环境...">点击“重新探测”检测本机 Node.js 与 Python 环境...</div>
          </div>
          <div style="margin-top:14px;">
            <label class="form-label" data-i18n="系统发现的候选解释器 (Candidates)">系统发现的候选解释器 (Candidates)</label>
            <div id="env-candidates-box" style="max-height:140px; overflow-y:auto; background:rgba(0,0,0,0.25); border-radius:6px; padding:8px; font-family:var(--mono); font-size:11px;" data-i18n="等待探测...">
              等待探测...
            </div>
          </div>
        </div>
        <div class="hub-modal-footer">
          <button type="button" class="hub-btn" id="btn-finish-env" data-i18n="关闭">关闭</button>
        </div>
      </div>
    `));
    document.body.append(envModal);

    // 外部程序接入授权弹窗
    const extModal = document.createElement('div');
    extModal.id = 'external-grant-modal';
    extModal.className = 'hub-modal-overlay hidden';
    setCanvasHtml(extModal, () => (`
      <div class="hub-modal" style="width:680px; max-width:92vw;">
        <div class="hub-modal-header">
          <h3 data-i18n="🔗 外部独立程序 / 脚本接入授权">🔗 外部独立程序 / 脚本接入授权</h3>
          <button type="button" class="hud-btn" id="btn-close-external-modal">✕</button>
        </div>
        <div class="hub-modal-body">
          <div style="font-size:12px; color:var(--muted);" data-i18n="为外部 Python 脚本、Node.js 客户端或独立服务签发临时通信凭证，无需通过本地启动器托管即可直接通过 WebSocket 接入世界枢纽进行语义通讯与通道订阅。">
            为外部 Python 脚本、Node.js 客户端或独立服务签发临时通信凭证，无需通过本地启动器托管即可直接通过 WebSocket 接入世界枢纽进行语义通讯与通道订阅。
          </div>

          <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border); border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:10px;">
            <h4 style="margin:0; font-size:13px; color:#fff;" data-i18n="快速签发外部接入凭证">快速签发外部接入凭证</h4>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
              <div>
                <label class="form-label" data-i18n="客户端标识 (Program ID)">客户端标识 (Program ID)</label>
                <input type="text" id="inp-ext-id" class="drawer-input" placeholder="例如: client.data-analyzer" data-i18n-placeholder="例如: client.data-analyzer">
              </div>
              <div>
                <label class="form-label" data-i18n="显示名称 (Title)">显示名称 (Title)</label>
                <input type="text" id="inp-ext-title" class="drawer-input" placeholder="例如: 外部数据分析脚本" data-i18n-placeholder="例如: 外部数据分析脚本">
              </div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
              <div>
                <label class="form-label" data-i18n="允许发布的主题通道 (逗号分隔)">允许发布的主题通道 (逗号分隔)</label>
                <input type="text" id="inp-ext-publish" class="drawer-input" placeholder="例如: telemetry.metrics, user.events" data-i18n-placeholder="例如: telemetry.metrics, user.events">
              </div>
              <div>
                <label class="form-label" data-i18n="允许订阅的主题通道 (逗号分隔)">允许订阅的主题通道 (逗号分隔)</label>
                <input type="text" id="inp-ext-subscribe" class="drawer-input" placeholder="例如: system.alert, hub.broadcast" data-i18n-placeholder="例如: system.alert, hub.broadcast">
              </div>
            </div>
            <div style="display:flex; justify-content:flex-end;">
              <button type="button" class="hub-btn primary" id="btn-do-quick-grant" data-i18n="⚡ 签发通信凭证并生成接入代码">⚡ 签发通信凭证并生成接入代码</button>
            </div>
          </div>

          <!-- 签发结果及接入代码展示 -->
          <div id="ext-grant-result" class="section-block hidden" style="background:rgba(0,210,180,0.04); border:1px solid var(--teal); border-radius:8px; padding:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <strong style="color:var(--teal); font-size:12px;" data-i18n="✓ 凭证签发成功！即刻在外部脚本中运行：">✓ 凭证签发成功！即刻在外部脚本中运行：</strong>
              <div class="stream-tabs" style="margin:0;">
                <button type="button" class="tab-btn active" id="tab-code-python" style="font-size:10px; padding:2px 8px;">Python (websockets)</button>
                <button type="button" class="tab-btn" id="tab-code-node" style="font-size:10px; padding:2px 8px;">Node.js (ws)</button>
              </div>
            </div>
            <div style="position:relative;">
              <pre id="ext-code-snippet" style="background:#050a12; border:1px solid var(--border); border-radius:6px; padding:10px; font-family:var(--mono); font-size:11px; max-height:180px; overflow-y:auto; color:#a5f3fc; margin:0;"></pre>
              <button type="button" class="hub-btn" id="btn-copy-code" style="position:absolute; top:6px; right:6px; padding:2px 8px; font-size:10px; background:rgba(13,21,34,0.8);" data-i18n="📋 复制代码">📋 复制代码</button>
            </div>
          </div>

          <!-- 已授权外部程序列表 -->
          <div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <label class="form-label" style="margin:0;"><span data-i18n="当前活动的外部授权客户端">当前活动的外部授权客户端</span> (<span id="ext-active-count">0</span>)</label>
              <button type="button" class="hub-btn" id="btn-refresh-ext-list" style="font-size:10px; padding:2px 8px;" data-i18n="刷新列表">刷新列表</button>
            </div>
            <div id="ext-grants-list" style="max-height:180px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">
              <div style="font-size:12px; color:var(--muted); padding:8px;" data-i18n="暂无外部授权程序">暂无外部授权程序</div>
            </div>
          </div>
        </div>
        <div class="hub-modal-footer">
          <button type="button" class="hub-btn" id="btn-finish-external" data-i18n="完成并关闭">完成并关闭</button>
        </div>
      </div>
    `));
    document.body.append(extModal);

    // 模块安全审查与指纹审计弹窗
    const reviewModal = document.createElement('div');
    reviewModal.id = 'security-review-modal';
    reviewModal.className = 'hub-modal-overlay hidden';
    setCanvasHtml(reviewModal, () => (`
      <div class="hub-modal" style="width:640px; max-width:92vw;">
        <div class="hub-modal-header">
          <h3 data-i18n="🛡 模块安全审计与指纹审查">🛡 模块安全审计与指纹审查</h3>
          <button type="button" class="hud-btn" id="btn-close-review-modal">✕</button>
        </div>
        <div class="hub-modal-body">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <h4 id="review-mod-title" style="margin:0; font-size:14px; color:#fff;" data-i18n="模块名称">模块名称</h4>
              <span id="review-mod-id" style="font-family:var(--mono); font-size:11px; color:var(--muted);">program.id</span>
            </div>
            <span id="review-profile-badge" class="acl-pill" style="background:rgba(0,210,180,0.15); color:var(--teal);">trusted-local</span>
          </div>

          <!-- 指纹审查 -->
          <div class="section-block" style="background:rgba(255,255,255,0.02); border-radius:8px; padding:10px;">
            <div style="font-size:11px; color:var(--muted); margin-bottom:4px;" data-i18n="源码与配置 SHA-256 审计指纹 (Digest):">源码与配置 SHA-256 审计指纹 (Digest):</div>
            <div style="display:flex; align-items:center; gap:8px;">
              <input type="text" id="review-digest-val" readonly class="drawer-input" style="font-family:var(--mono); font-size:11px; color:var(--amber); flex:1;" value="...">
              <button type="button" class="hub-btn" id="btn-copy-review-digest" style="font-size:11px; padding:4px 8px;" data-i18n="复制指纹">复制指纹</button>
            </div>
          </div>

          <!-- 解释器与可执行路径 -->
          <div class="section-block" style="background:rgba(255,255,255,0.02); border-radius:8px; padding:10px;">
            <div style="font-size:12px; font-weight:700; color:#fff; margin-bottom:6px;" data-i18n="运行时与解释器">运行时与解释器</div>
            <div style="display:grid; grid-template-columns:120px 1fr; gap:6px; font-size:11px;">
              <span style="color:var(--muted);" data-i18n="解释器路径:">解释器路径:</span>
              <span id="review-exec-path" style="font-family:var(--mono); word-break:break-all; color:#fff;">-</span>
              <span style="color:var(--muted);" data-i18n="解释器 SHA-256:">解释器 SHA-256:</span>
              <span id="review-exec-digest" style="font-family:var(--mono); word-break:break-all; color:var(--muted); font-size:10px;">-</span>
              <span style="color:var(--muted);" data-i18n="源码物理路径:">源码物理路径:</span>
              <span id="review-source-dir" style="font-family:var(--mono); word-break:break-all; color:#fff;">-</span>
            </div>
          </div>

          <!-- 权限声明 -->
          <div class="section-block" style="background:rgba(255,255,255,0.02); border-radius:8px; padding:10px;">
            <div style="font-size:12px; font-weight:700; color:#fff; margin-bottom:6px;" data-i18n="进程权限与通信 ACL">进程权限与通信 ACL</div>
            <div id="review-permissions-box" style="display:flex; flex-direction:column; gap:4px; font-size:11px;"></div>
          </div>

          <!-- 下游依赖与拓扑影响 -->
          <div class="section-block" style="background:rgba(255,255,255,0.02); border-radius:8px; padding:10px;">
            <div style="font-size:12px; font-weight:700; color:#fff; margin-bottom:6px;" data-i18n="下游服务与拓扑依赖影响">下游服务与拓扑依赖影响</div>
            <div id="review-downstream-box" style="font-size:11px; color:var(--muted);"></div>
          </div>
        </div>
        <div class="hub-modal-footer">
          <button type="button" class="hub-btn" id="btn-finish-review" data-i18n="关闭审查">关闭审查</button>
        </div>
      </div>
    `));
    document.body.append(reviewModal);

    // 1. 模块脚手架弹窗（向导式创建新模块代码）
    const scaffoldModal = document.createElement('div');
    scaffoldModal.id = 'modal-module-scaffold';
    scaffoldModal.className = 'hub-modal-overlay hidden';
    setCanvasHtml(scaffoldModal, () => (`
      <div class="hub-modal" style="width:640px; max-width:94vw;">
        <div class="hub-modal-header">
          <h3 data-i18n="🛠 新建模块 (模块脚手架向导)">🛠 新建模块 (模块脚手架向导)</h3>
          <button type="button" class="hud-btn" id="btn-close-scaffold-modal">✕</button>
        </div>
        <div class="hub-modal-body" style="display:flex; flex-direction:column; gap:10px;">
          <div style="font-size:12px; color:var(--muted);" data-i18n="向导式生成符合 World Hub 标准规范的微服务模块代码与元数据（自动创建 module.json、deployment.json 与接入主入口，并加入画布）。">
            向导式生成符合 World Hub 标准规范的微服务模块代码与元数据（自动创建 module.json、deployment.json 与接入主入口，并加入画布）。
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
            <div>
              <label class="form-label" data-i18n="模块唯一标识 (Module ID, 英文/数字/中划线)">模块唯一标识 (Module ID, 英文/数字/中划线)</label>
              <input type="text" id="inp-scaffold-id" class="drawer-input" placeholder="例如: telemetry-sensor" data-i18n-placeholder="例如: telemetry-sensor">
            </div>
            <div>
              <label class="form-label" data-i18n="模块显示名称 (Title)">模块显示名称 (Title)</label>
              <input type="text" id="inp-scaffold-title" class="drawer-input" placeholder="例如: 智能遥测传感器" data-i18n-placeholder="例如: 智能遥测传感器">
            </div>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
            <div>
              <label class="form-label" data-i18n="运行时技术栈 (Runtime)">运行时技术栈 (Runtime)</label>
              <select id="sel-scaffold-runtime" class="drawer-input">
                <option value="python">Python (asyncio / websockets)</option>
                <option value="node">Node.js (ESM / ws)</option>
              </select>
            </div>
            <div>
              <label class="form-label" data-i18n="主入口文件 (Entry file)">主入口文件 (Entry file)</label>
              <input type="text" id="inp-scaffold-entry" class="drawer-input" placeholder="例如: main.py 或 index.mjs" data-i18n-placeholder="例如: main.py 或 index.mjs">
            </div>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
            <div>
              <label class="form-label" data-i18n="声明发布的通信通道 (逗号分隔)">声明发布的通信通道 (逗号分隔)</label>
              <input type="text" id="inp-scaffold-publish" class="drawer-input" placeholder="例如: telemetry/metrics, sensor/alert" data-i18n-placeholder="例如: telemetry/metrics, sensor/alert">
            </div>
            <div>
              <label class="form-label" data-i18n="声明订阅的通信通道 (逗号分隔)">声明订阅的通信通道 (逗号分隔)</label>
              <input type="text" id="inp-scaffold-subscribe" class="drawer-input" placeholder="例如: system/command, time/pulse" data-i18n-placeholder="例如: system/command, time/pulse">
            </div>
          </div>
          <div>
            <label class="form-label" data-i18n="作者运行默认值">作者运行默认值</label>
            <select id="sel-scaffold-execution-mode" class="drawer-input">
              <option value="resident" data-i18n="常驻">常驻</option>
              <option value="on-demand" data-i18n="按需">按需</option>
            </select>
            <label class="form-label" data-i18n="默认空闲停止等待（秒）">默认空闲停止等待（秒）</label>
            <input type="number" id="inp-scaffold-idle-seconds" class="drawer-input" min="1" max="86400" step="1" value="60">
            <p class="action-help-text" data-i18n="新实例导入时采用此默认值，用户可覆盖。不会自动启动，也不会授予任何调用者唤醒权限。">新实例导入时采用此默认值，用户可覆盖。不会自动启动，也不会授予任何调用者唤醒权限。</p>
          </div>
          <div>
            <label class="form-label" data-i18n="模块存储本地路径 (留空将自动置于受管目录)">模块存储本地路径 (留空将自动置于受管目录)</label>
            <div style="display:flex; gap:6px;">
              <input type="text" id="inp-scaffold-dir" class="drawer-input" placeholder="例如: C:\\Projects\\modules\\telemetry-sensor" data-i18n-placeholder="例如: C:\\Projects\\modules\\telemetry-sensor" style="flex:1;">
              <button type="button" class="hud-action-pill" id="btn-scaffold-pick-dir" data-i18n="📁 浏览路径...">📁 浏览路径...</button>
            </div>
          </div>
        </div>
        <div class="hub-modal-footer" style="display:flex; justify-content:space-between; align-items:center;">
          <button type="button" class="hub-btn" id="btn-cancel-scaffold" data-i18n="取消">取消</button>
          <button type="button" class="hub-btn primary" id="btn-do-scaffold" data-i18n="⚡ 立即创建模块模板并初始化脚手架">⚡ 立即创建模块模板并初始化脚手架</button>
        </div>
      </div>
    `));
    document.body.append(scaffoldModal);

    // 2. 模块打包发布弹窗（生成制品与导出包）
    const pkgModal = document.createElement('div');
    pkgModal.id = 'modal-module-package';
    pkgModal.className = 'hub-modal-overlay hidden';
    setCanvasHtml(pkgModal, () => (`
      <div class="hub-modal" style="width:620px; max-width:94vw;">
        <div class="hub-modal-header">
          <h3 data-i18n="📦 导出模块 / 模块组">📦 导出模块 / 模块组</h3>
          <button type="button" class="hud-btn" id="btn-close-package-modal">✕</button>
        </div>
        <div class="hub-modal-body" style="display:flex; flex-direction:column; gap:10px;">
          <div style="font-size:12px; color:var(--muted);" data-i18n="生成可上传社区的 artifact.json 与 index.json。模块组包含成员源码、公开配置和启动计划，不包含 Hub、身份凭据或运行数据；导出不会生成签名。">
            生成可上传社区的 artifact.json 与 index.json。模块组包含成员源码、公开配置和启动计划，不包含 Hub、身份凭据或运行数据；导出不会生成签名。
          </div>
          <label class="form-label"><span data-i18n="导出范围">导出范围</span><select id="inp-pkg-group" class="drawer-input"><option value="" data-i18n="模块 / 模块组源码目录">模块 / 模块组源码目录</option></select></label>
          <label class="form-label"><span data-i18n="模块组发行版本">模块组发行版本</span><input id="inp-pkg-version" class="drawer-input" value="1.0.0" placeholder="例如 1.0.0" data-i18n-placeholder="例如 1.0.0"></label>
          <label class="form-label"><input type="checkbox" id="inp-pkg-redistribution"> <span data-i18n="我有权再分发所选模块及组内全部成员，且已检查公开参数不含秘密">我有权再分发所选模块及组内全部成员，且已检查公开参数不含秘密</span></label>
          <div>
            <label class="form-label" data-i18n="源码目录 (module.json 或 module-group.json；选择现有组后可留空)">源码目录 (module.json 或 module-group.json；选择现有组后可留空)</label>
            <div style="display:flex; gap:6px;">
              <input type="text" id="inp-pkg-source" class="drawer-input" placeholder="例如: C:\\Projects\\examples\\capability-directory" data-i18n-placeholder="例如: C:\\Projects\\examples\\capability-directory" style="flex:1;">
              <button type="button" class="hud-action-pill" id="btn-pkg-pick-source" data-i18n="📁 选择模块...">📁 选择模块...</button>
            </div>
          </div>
          <div>
            <label class="form-label" data-i18n="制品输出目录 (Destination)">制品输出目录 (Destination)</label>
            <div style="display:flex; gap:6px;">
              <input type="text" id="inp-pkg-dest" class="drawer-input" placeholder="例如: C:\\Projects\\artifacts\\dist-pkg" data-i18n-placeholder="例如: C:\\Projects\\artifacts\\dist-pkg" style="flex:1;">
              <button type="button" class="hud-action-pill" id="btn-pkg-pick-dest" data-i18n="📁 选择输出目录...">📁 选择输出目录...</button>
            </div>
          </div>
          <div id="pkg-result-box" class="section-block hidden" style="background:rgba(0,210,180,0.04); border:1px solid var(--teal); border-radius:6px; padding:10px; font-size:11px;">
            <strong style="color:var(--teal);" data-i18n="✓ 打包发布成功！制品信息：">✓ 打包发布成功！制品信息：</strong>
            <div id="pkg-result-content" style="font-family:var(--mono); margin-top:6px; word-break:break-all;"></div>
          </div>
        </div>
        <div class="hub-modal-footer" style="display:flex; justify-content:space-between; align-items:center;">
          <button type="button" class="hub-btn" id="btn-cancel-package" data-i18n="关闭">关闭</button>
          <button type="button" class="hub-btn primary" id="btn-do-package" data-i18n="📦 立即打包并生成标准分发制品">📦 立即打包并生成标准分发制品</button>
        </div>
      </div>
    `));
    document.body.append(pkgModal);

    // 3. 在线工坊与源弹窗（社区下载与订阅）
    const wsModal = document.createElement('div');
    wsModal.id = 'modal-module-workshop';
    wsModal.className = 'hub-modal-overlay hidden';
    setCanvasHtml(wsModal, () => (`
      <div class="hub-modal ws-dialog">
        <div class="hub-modal-header" style="border-bottom:1px solid rgba(255,255,255,0.08); padding:12px 18px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <span style="font-size:18px;">🌐</span>
            <div>
              <div style="font-size:14px; font-weight:700; color:#fff; display:flex; align-items:center; gap:8px;">
                <span data-i18n="在线工坊与社区下载 (Workshop & Catalog)">在线工坊与社区下载 (Workshop & Catalog)</span>
                <span class="ws-status-badge" data-i18n="● 官方社区已同步">● 官方社区已同步</span>
              </div>
              <div style="font-size:11px; color:var(--muted); margin-top:2px;" data-i18n="浏览、搜索、预览官方社区与第三方模块及编排组；下载后可在导入流程中审阅授权与接线，绝不静默启动。">
                浏览、搜索、预览官方社区与第三方模块及编排组；下载后可在导入流程中审阅授权与接线，绝不静默启动。
              </div>
            </div>
          </div>
          <button type="button" class="hud-btn" id="btn-close-workshop-modal" title="关闭" data-i18n-title="关闭">✕</button>
        </div>

        <!-- 顶部导航选项卡：在线工坊 vs 已有模块更新 vs 已下载与缓存 vs 下载与策略设置 -->
        <div class="ws-nav-tabs">
          <button type="button" class="ws-nav-tab active" id="tab-ws-nav-online">
            <span data-i18n="🌐 在线工坊目录 (Catalog)">🌐 在线工坊目录 (Catalog)</span>
          </button>
          <button type="button" class="ws-nav-tab" id="tab-ws-nav-updates">
            <span data-i18n="📋 已有模块更新 (Installed & Updates)">📋 已有模块更新 (Installed & Updates)</span>
            <span class="ws-tab-badge" id="badge-ws-updates-count" style="display:none;">0</span>
          </button>
          <button type="button" class="ws-nav-tab" id="tab-ws-nav-downloaded">
            <span data-i18n="💾 已下载与缓存管理 (Downloaded & Cache)">💾 已下载与缓存管理 (Downloaded & Cache)</span>
            <span class="ws-tab-badge" id="badge-ws-cache-count">0</span>
          </button>
          <button type="button" class="ws-nav-tab" id="tab-ws-nav-settings">
            <span data-i18n="⚙ 下载与策略设置 (Settings)">⚙ 下载与策略设置 (Settings)</span>
          </button>
        </div>

        <div class="hub-modal-body" style="padding:14px 18px; display:flex; flex-direction:column; gap:10px; overflow:hidden; flex:1;">
          <!-- 1. 在线工坊视图面板 -->
          <div id="ws-view-online" class="ws-view-pane" style="display:flex; flex-direction:column; gap:10px; overflow:hidden; flex:1;">
            <!-- 来源配置栏 -->
            <div class="ws-source-bar">
              <div style="display:flex; gap:8px; align-items:center; width:100%;">
                <div style="position:relative; flex:1; display:flex; align-items:center;">
                  <span style="position:absolute; left:10px; color:var(--muted); font-size:12px;">🔗</span>
                  <input type="text" id="inp-workshop-source-url" class="drawer-input" value="https://peros.cn/workshop/index.json" placeholder="输入在线工坊源 URL 或本地 index.json 路径" data-i18n-placeholder="输入在线工坊源 URL 或本地 index.json 路径" data-i18n-placeholder="输入在线工坊源 URL 或本地 index.json 路径" style="width:100%; padding-left:30px; font-size:12px; height:32px;">
                </div>
                <button type="button" class="hub-btn primary" id="btn-inspect-workshop" style="height:32px; padding:0 14px; white-space:nowrap;" data-i18n="🔍 检索工坊源">🔍 检索工坊源</button>
                <button type="button" class="hub-btn" id="btn-refresh-sources" style="height:32px; padding:0 10px; white-space:nowrap;" title="刷新工坊源" data-i18n="🔄 刷新" data-i18n-title="刷新工坊源">🔄 刷新</button>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; color:var(--muted);">
                <label style="cursor:pointer; display:flex; align-items:center; gap:6px;">
                  <input type="checkbox" id="inp-workshop-private-network" checked> <span data-i18n="此来源经过我信任的本机代理或私网地址（自动绕过私网阻断，仍校验 HTTPS 证书与 SHA-256）">此来源经过我信任的本机代理或私网地址（自动绕过私网阻断，仍校验 HTTPS 证书与 SHA-256）</span>
                </label>
                <a href="https://peros.cn/workshop" target="_blank" rel="noopener noreferrer" style="color:var(--teal); text-decoration:none; display:flex; align-items:center; gap:4px; font-weight:600;">
                  <span data-i18n="访问官方社区网页版 ↗">访问官方社区网页版 ↗</span>
                </a>
              </div>
            </div>

            <!-- 搜索与筛选工具栏 -->
            <div class="ws-filter-toolbar">
              <div class="ws-search-wrap">
                <span class="ws-search-icon">🔍</span>
                <input type="text" id="inp-ws-search" placeholder="搜索模块名称、ID、契约能力、作者或描述..." class="ws-search-input" data-i18n-placeholder="搜索模块名称、ID、契约能力、作者或描述...">
                <button type="button" id="btn-ws-search-clear" class="ws-search-clear hidden" title="清空搜索" data-i18n-title="清空搜索">✕</button>
              </div>
              <div class="ws-filter-group">
                <select id="sel-ws-type" class="ws-select" title="按类型筛选" data-i18n-title="按类型筛选">
                  <option value="all" data-i18n="📦 全部类型">📦 全部类型</option>
                  <option value="module" data-i18n="📦 独立模块 (Module)">📦 独立模块 (Module)</option>
                  <option value="module-group" data-i18n="🧩 模块组编排 (Group)">🧩 模块组编排 (Group)</option>
                </select>
                <select id="sel-ws-contract" class="ws-select" title="按能力契约筛选" data-i18n-title="按能力契约筛选">
                  <option value="all" data-i18n="🔌 全部契约 (All Contracts)">🔌 全部契约 (All Contracts)</option>
                </select>
                <select id="sel-ws-sort" class="ws-select" title="排序规则" data-i18n-title="排序规则">
                  <option value="default" data-i18n="✨ 默认排序">✨ 默认排序</option>
                  <option value="name" data-i18n="🔤 名称 (A-Z)">🔤 名称 (A-Z)</option>
                  <option value="versions" data-i18n="🔢 版本数量优先">🔢 版本数量优先</option>
                  <option value="groups-first" data-i18n="🧩 模块组优先">🧩 模块组优先</option>
                </select>
                <button type="button" id="btn-ws-reset-filters" class="hub-btn" style="height:32px; padding:0 10px; font-size:11px; display:none;" data-i18n="✕ 重置筛选">✕ 重置筛选</button>
              </div>
            </div>

            <!-- 统计与说明栏 -->
            <div style="display:flex; justify-content:space-between; align-items:center; padding:0 4px; font-size:11px; color:var(--muted);">
              <div id="ws-results-counter" data-i18n="正在读取工坊目录...">正在读取工坊目录...</div>
              <div style="display:flex; gap:12px;">
                <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--teal);"></span> <span data-i18n="独立模块">独立模块</span></span>
                <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#818cf8;"></span> <span data-i18n="模块组编排">模块组编排</span></span>
              </div>
            </div>

            <!-- 卡片展示瀑布网格容器 -->
            <div id="workshop-entries-box" class="ws-entries-container">
              <div style="font-size:12px; color:var(--muted); padding:20px; text-align:center;" data-i18n="点击“检索工坊源”读取模块列表...">点击“检索工坊源”读取模块列表...</div>
            </div>
          </div>

          <!-- 2. 已下载与本地缓存管理面板 -->
          <div id="ws-view-downloaded" class="ws-view-pane hidden" style="display:flex; flex-direction:column; gap:10px; overflow:hidden; flex:1;">
            <!-- 缓存概览统计栏 -->
            <div class="ws-cache-stats-bar">
              <div style="display:flex; gap:14px; align-items:center;">
                <span style="color:#fff; font-weight:700;"><span data-i18n="📦 本地缓存总计:">📦 本地缓存总计:</span> <span id="ws-cache-stat-total" style="color:var(--teal);">0</span> <span data-i18n="个">个</span></span>
                <span style="color:var(--amber); font-weight:600;"><span data-i18n="🟡 待审阅导入:">🟡 待审阅导入:</span> <span id="ws-cache-stat-pending">0</span></span>
                <span style="color:var(--teal); font-weight:600;"><span data-i18n="🟢 已导入 Hub:">🟢 已导入 Hub:</span> <span id="ws-cache-stat-installed">0</span></span>
              </div>
              <div style="display:flex; gap:10px; align-items:center;">
                <span style="color:var(--muted); font-size:10px; font-family:var(--mono);" id="ws-cache-dir-label"></span>
                <button type="button" class="hub-btn" id="btn-refresh-cache" style="height:28px; padding:0 10px; font-size:11px;" title="重新扫描本地 source-cache 目录" data-i18n="🔄 刷新缓存" data-i18n-title="重新扫描本地 source-cache 目录">🔄 刷新缓存</button>
              </div>
            </div>

            <!-- 缓存搜索与过滤工具栏 -->
            <div class="ws-filter-toolbar">
              <div class="ws-search-wrap">
                <span class="ws-search-icon">🔍</span>
                <input type="text" id="inp-ws-cache-search" placeholder="搜索已缓存的模块/编排组 ID、名称、SHA-256..." data-i18n-placeholder="搜索已缓存的模块/编排组 ID、名称、SHA-256..." class="ws-search-input">
                <button type="button" id="btn-ws-cache-search-clear" class="ws-search-clear hidden" title="清空搜索" data-i18n-title="清空搜索">✕</button>
              </div>
              <div class="ws-filter-group">
                <select id="sel-ws-cache-status" class="ws-select" title="按导入状态筛选" data-i18n-title="按导入状态筛选">
                  <option value="all" data-i18n="⚡ 全部状态 (All)">⚡ 全部状态 (All)</option>
                  <option value="pending" data-i18n="🟡 仅看待审阅导入">🟡 仅看待审阅导入</option>
                  <option value="installed" data-i18n="🟢 仅看已导入本机 Hub">🟢 仅看已导入本机 Hub</option>
                </select>
                <select id="sel-ws-cache-type" class="ws-select" title="按类型筛选" data-i18n-title="按类型筛选">
                  <option value="all" data-i18n="📦 全部类型">📦 全部类型</option>
                  <option value="module" data-i18n="📦 独立模块 (Module)">📦 独立模块 (Module)</option>
                  <option value="module-group" data-i18n="🧩 模块组编排 (Group)">🧩 模块组编排 (Group)</option>
                </select>
              </div>
            </div>

            <!-- 缓存卡片列表容器 -->
            <div id="workshop-cached-entries-box" class="ws-entries-container" style="grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));">
              <div style="font-size:12px; color:var(--muted); padding:20px; text-align:center; grid-column:1/-1;" data-i18n="正在加载本地缓存目录...">正在加载本地缓存目录...</div>
            </div>
          </div>

          <!-- 3. 已有模块更新面板 -->
          <div id="ws-view-updates" class="ws-view-pane hidden" style="display:flex; flex-direction:column; gap:10px; overflow:hidden; flex:1;">
            <!-- 更新汇总工具栏 -->
            <div class="ws-cache-stats-bar" style="padding:10px 14px;">
              <div>
                <div style="font-size:13px; font-weight:700; color:#fff;" id="ws-updates-summary-title" data-i18n="拓扑内受管模块与编排组更新状态">拓扑内受管模块与编排组更新状态</div>
                <div style="font-size:11px; color:var(--muted); margin-top:2px;" id="ws-updates-summary-sub" data-i18n="正在核对工坊目录与本地缓存...">正在核对工坊目录与本地缓存...</div>
              </div>
              <div style="display:flex; gap:8px; align-items:center;">
                <button type="button" class="hub-btn" id="btn-ws-check-updates" style="height:32px; padding:0 12px; font-size:11px;" data-i18n="🔄 检查更新">🔄 检查更新</button>
                <button type="button" class="hub-btn primary" id="btn-ws-batch-update" style="height:32px; padding:0 14px; font-size:11px; font-weight:700;" disabled><span data-i18n="🚀 一键更新全部">🚀 一键更新全部</span> (<span id="ws-batch-update-count">0</span>)</button>
              </div>
            </div>

            <!-- 更新列表容器 -->
            <div id="ws-updates-items-box" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding-right:4px;">
              <div style="font-size:12px; color:var(--muted); padding:20px; text-align:center;" data-i18n="正在读取当前拓扑模块...">正在读取当前拓扑模块...</div>
            </div>
          </div>

          <!-- 4. 下载与策略设置面板 -->
          <div id="ws-view-settings" class="ws-view-pane hidden" style="display:flex; flex-direction:column; gap:12px; overflow-y:auto; flex:1; padding-right:4px;">
            <!-- 策略设置 -->
            <div class="ws-cache-card" style="padding:16px;">
              <h4 style="font-size:13px; font-weight:700; color:#fff; margin:0 0 4px 0; display:flex; align-items:center; gap:6px;">
                <span data-i18n="⚙ 版本切换与更新默认策略">⚙ 版本切换与更新默认策略</span>
              </h4>
              <p style="font-size:11px; color:var(--muted); margin:0 0 12px 0;" data-i18n="配置在版本管理弹窗及一键更新中默认选用的策略预设。">配置在版本管理弹窗及一键更新中默认选用的策略预设。</p>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                <div>
                  <label class="form-label" style="font-size:11px; margin-bottom:4px; display:block;" data-i18n="🔌 默认配置策略">🔌 默认配置策略</label>
                  <select id="sel-setting-default-config-policy" class="drawer-input" style="width:100%; height:34px; font-size:12px;">
                    <option value="preserve" data-i18n="保留当前参数、主题与接线 (推荐)">保留当前参数、主题与接线 (推荐)</option>
                    <option value="author" data-i18n="使用目标发行版本的作者默认值">使用目标发行版本的作者默认值</option>
                  </select>
                  <span style="font-size:10px; color:var(--muted); display:block; margin-top:3px;" data-i18n="更新版本时默认保留您在通信画布上设置的主题接线与公开参数。">更新版本时默认保留您在通信画布上设置的主题接线与公开参数。</span>
                </div>
                <div>
                  <label class="form-label" style="font-size:11px; margin-bottom:4px; display:block;" data-i18n="💾 默认实例数据策略">💾 默认实例数据策略</label>
                  <select id="sel-setting-default-data-policy" class="drawer-input" style="width:100%; height:34px; font-size:12px;">
                    <option value="preserve" data-i18n="保留当前实例数据 (推荐)">保留当前实例数据 (推荐)</option>
                    <option value="fresh" data-i18n="使用全新实例数据，旧数据保留在历史">使用全新实例数据，旧数据保留在历史</option>
                  </select>
                  <span style="font-size:10px; color:var(--muted); display:block; margin-top:3px;" data-i18n="更新版本时默认保留程序已生成的本地持久化文件与数据库。">更新版本时默认保留程序已生成的本地持久化文件与数据库。</span>
                </div>
              </div>
            </div>

            <!-- 本地缓存与下载路径 -->
            <div class="ws-cache-card" style="padding:16px;">
              <h4 style="font-size:13px; font-weight:700; color:#fff; margin:0 0 4px 0; display:flex; align-items:center; gap:6px;">
                <span data-i18n="💾 本地制品缓存与下载路径">💾 本地制品缓存与下载路径</span>
              </h4>
              <p style="font-size:11px; color:var(--muted); margin:0 0 12px 0;" data-i18n="工坊下载的模块制品与 ZIP 压缩包缓存的存放位置。">工坊下载的模块制品与 ZIP 压缩包缓存的存放位置。</p>
              <div style="display:flex; gap:8px; align-items:center;">
                <input type="text" id="inp-setting-cache-dir" class="drawer-input" readonly style="flex:1; height:34px; font-size:11px; font-family:var(--mono);" value="" placeholder="系统默认 Hub 缓存目录 (经由服务端管理)" data-i18n-placeholder="系统默认 Hub 缓存目录 (经由服务端管理)">
                <button type="button" class="hub-btn" id="btn-setting-pick-cache-dir" style="height:34px; padding:0 14px; white-space:nowrap;" data-i18n="📁 复制路径">📁 复制路径</button>
              </div>
              <span style="font-size:10px; color:var(--muted); display:block; margin-top:4px;" data-i18n="下载制品将经过 SHA-256 校验并持久化缓存，支持断网环境离线快速切换。">下载制品将经过 SHA-256 校验并持久化缓存，支持断网环境离线快速切换。</span>
            </div>

            <!-- 网络与源设置 -->
            <div class="ws-cache-card" style="padding:16px;">
              <h4 style="font-size:13px; font-weight:700; color:#fff; margin:0 0 4px 0; display:flex; align-items:center; gap:6px;">
                <span data-i18n="🌐 网络访问与官方源">🌐 网络访问与官方源</span>
              </h4>
              <div style="margin-top:10px;">
                <label style="cursor:pointer; display:flex; align-items:center; gap:8px; font-size:12px; color:#cbd5e1;">
                  <input type="checkbox" id="chk-setting-private-network" checked> <span data-i18n="允许访问信任的内网 / 本机代理源（自动绕过私网阻断）">允许访问信任的内网 / 本机代理源（自动绕过私网阻断）</span>
                </label>
                <span style="font-size:10px; color:var(--muted); display:block; margin-top:4px; margin-left:22px;" data-i18n="适用于本地测试自建工坊源或内网镜像源。">适用于本地测试自建工坊源或内网镜像源。</span>
              </div>
            </div>
          </div>
        </div>

        <div class="hub-modal-footer" style="border-top:1px solid rgba(255,255,255,0.08); padding:10px 18px; display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:11px; color:var(--muted);" id="ws-footer-hint" data-i18n="提示：下载制品后将自动存入本地缓存，并在导入向导中审阅权限及端口绑定后再启用。">
            提示：下载制品后将自动存入本地缓存，并在导入向导中审阅权限及端口绑定后再启用。
          </div>
          <button type="button" class="hub-btn" id="btn-finish-workshop" data-i18n="关闭工坊">关闭工坊</button>
        </div>
      </div>
    `));
    document.body.append(wsModal);

    // 4. 图片预览 Lightbox 浮层
    const wsLightbox = document.createElement('div');
    wsLightbox.id = 'modal-workshop-lightbox';
    wsLightbox.className = 'ws-lightbox-overlay hidden';
    setCanvasHtml(wsLightbox, () => (`
      <div class="ws-lightbox-content">
        <button type="button" class="ws-lightbox-close" id="btn-close-ws-lightbox" title="关闭 (Esc)" data-i18n-title="关闭 (Esc)">✕</button>
        <img id="ws-lightbox-img" src="" alt="预览大图" class="ws-lightbox-image" data-i18n-alt="预览大图">
        <div id="ws-lightbox-caption" class="ws-lightbox-caption"></div>
      </div>
    `));
    document.body.append(wsLightbox);

    // 5. 模块与模块组详情弹窗
    const wsDetailModal = document.createElement('div');
    wsDetailModal.id = 'modal-workshop-detail';
    wsDetailModal.className = 'hub-modal-overlay hidden';
    wsDetailModal.style.zIndex = '1050';
    setCanvasHtml(wsDetailModal, () => (`
      <div class="hub-modal ws-detail-dialog">
        <div class="hub-modal-header" style="border-bottom:1px solid rgba(255,255,255,0.08); padding:14px 20px;">
          <h3 id="ws-detail-header-title" data-i18n="模块规格与编排详情">模块规格与编排详情</h3>
          <button type="button" class="hud-btn" id="btn-close-ws-detail" title="关闭" data-i18n-title="关闭">✕</button>
        </div>
        <div class="hub-modal-body" id="ws-detail-body" style="padding:18px 20px; overflow-y:auto; max-height:calc(85vh - 120px);">
        </div>
        <div class="hub-modal-footer" style="border-top:1px solid rgba(255,255,255,0.08); padding:12px 20px; display:flex; justify-content:space-between; align-items:center;">
          <button type="button" class="hub-btn" id="btn-finish-ws-detail" data-i18n="关闭详情">关闭详情</button>
          <div style="display:flex; align-items:center; gap:10px;">
            <a id="btn-detail-open-web" class="hub-btn" href="https://peros.cn/workshop" target="_blank" rel="noopener noreferrer" style="text-decoration:none; display:inline-flex; align-items:center; gap:5px;" title="在工坊官网或官方发布页查看" data-i18n="🌐 在官网打开 ↗" data-i18n-title="在工坊官网或官方发布页查看">🌐 在官网打开 ↗</a>
            <button type="button" class="hub-btn primary" id="btn-detail-download" data-i18n="⬇ 下载">⬇ 下载</button>
          </div>
        </div>
      </div>
    `));
    document.body.append(wsDetailModal);

    // 通信通道接线矩阵弹窗
    const wiringModal = document.createElement('div');
    wiringModal.id = 'wiring-matrix-modal';
    wiringModal.className = 'hub-modal-overlay hidden';
    setCanvasHtml(wiringModal, () => (`
      <div class="hub-modal" style="width:720px; max-width:94vw;">
        <div class="hub-modal-header">
          <h3 data-i18n="🔌 通信通道接线矩阵">🔌 通信通道接线矩阵</h3>
          <button type="button" class="hud-btn" id="btn-close-wiring-modal">✕</button>
        </div>
        <div class="hub-modal-body">
          <div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <label class="form-label" style="margin:0;"><span data-i18n="通信拓扑分类与通道清单">通信拓扑分类与通道清单</span> (<span id="matrix-wire-count">0</span>)</label>
              <div style="display:flex; align-items:center; gap:8px;">
                <button type="button" class="hub-btn primary" id="btn-modal-auto-wire" style="padding:2px 8px; font-size:11px;" data-i18n="⚡ 一键自动对接全部同名通道">⚡ 一键自动对接全部同名通道</button>
                <input type="text" id="inp-filter-wires" class="drawer-input" placeholder="搜索主题或模块..." data-i18n-placeholder="搜索主题或模块..." style="width:180px; padding:2px 8px; font-size:11px;">
              </div>
            </div>
            <div class="matrix-filter-bar" style="display:flex; gap:6px; margin-bottom:10px; flex-wrap:wrap;">
              <button type="button" class="matrix-filter-pill active" data-filter="all"><span data-i18n="全部">全部</span> (<span id="count-filter-all">0</span>)</button>
              <button type="button" class="matrix-filter-pill" data-filter="dedicated"><span data-i18n="🔌 专用通道">🔌 专用通道</span> (<span id="count-filter-dedicated">0</span>)</button>
              <button type="button" class="matrix-filter-pill" data-filter="shared"><span data-i18n="📡 共享主题">📡 共享主题</span> (<span id="count-filter-shared">0</span>)</button>
              <button type="button" class="matrix-filter-pill" data-filter="boundary"><span data-i18n="🌐 边界接口">🌐 边界接口</span> (<span id="count-filter-boundary">0</span>)</button>
            </div>
            <div id="matrix-wires-list" style="max-height:380px; overflow-y:auto; display:flex; flex-direction:column; gap:8px;"></div>
          </div>
        </div>
        <div class="hub-modal-footer">
          <button type="button" class="hub-btn" id="btn-finish-wiring-modal" data-i18n="完成并关闭">完成并关闭</button>
        </div>
      </div>
    `));
    document.body.append(wiringModal);
  }

  // 6. 事件绑定
  bindEvents() {
    $('tab-mode-static')?.addEventListener('click', () => this.switchMode('static'));
    $('tab-mode-runtime')?.addEventListener('click', () => this.switchMode('runtime'));
    $('tab-mode-wiring')?.addEventListener('click', () => this.switchMode('wiring'));
    $('tab-mode-orchestration')?.addEventListener('click', () => this.switchMode('orchestration'));

    $('inp-filter-static')?.addEventListener('input', e => {
      this.staticSearchQuery = (e.target.value || '').trim().toLowerCase();
      this.render();
    });

    $('hud-group-filter')?.addEventListener('change', e => {
      this.groupFilter = e.target.value;
      this.updateGroupActionButtons();
      this.render();
    });

    $('hud-failure-policy')?.addEventListener('change', async e => {
      const plan = this.getActivePlan();
      plan.onFailure = e.target.value;
      await this.saveActivePlan(plan);
    });

    // 侧边栏添加菜单触发
    $('btn-dock-add-menu')?.addEventListener('click', e => {
      e.stopPropagation();
      this.toggleDockFlyout();
    });
    $('btn-close-dock-flyout')?.addEventListener('click', e => {
      e.stopPropagation();
      this.closeDockFlyout();
    });

    // 6 大添加与新建功能收纳
    $('btn-action-group')?.addEventListener('click', () => {
      this.closeDockFlyout();
      this.openGroupModal();
    });
    $('btn-action-scaffold')?.addEventListener('click', () => {
      this.closeDockFlyout();
      this.openScaffoldModal();
    });
    $('btn-action-package')?.addEventListener('click', () => {
      this.closeDockFlyout();
      this.openPackageModal();
    });
    $('btn-action-download')?.addEventListener('click', () => {
      this.closeDockFlyout();
      this.openOnlineWorkshopModal();
    });
    $('btn-action-import')?.addEventListener('click', () => {
      this.closeDockFlyout();
      this.openImportModal();
    });
    $('btn-action-external')?.addEventListener('click', () => {
      this.closeDockFlyout();
      this.openExternalModal();
    });

    $('btn-flyout-env')?.addEventListener('click', () => {
      this.closeDockFlyout();
      this.openEnvModal();
    });
    $('btn-flyout-layout')?.addEventListener('click', () => {
      this.closeDockFlyout();
      this.autoLayout();
    });

    // 全局点击空白或 ESC 自动收起
    document.addEventListener('click', e => {
      if (!e.target.closest('#dock-add-flyout-panel') && !e.target.closest('#btn-dock-add-menu')) {
        this.closeDockFlyout();
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (!$('modal-workshop-lightbox')?.classList.contains('hidden')) {
          this.closeWorkshopLightbox();
          return;
        }
        if (!$('modal-batch-update-review')?.classList.contains('hidden')) {
          this.closeBatchUpdateModal();
          return;
        }
        if (!$('module-version-modal')?.classList.contains('hidden')) {
          this.closeVersionManager();
          return;
        }
        if (!$('modal-workshop-detail')?.classList.contains('hidden')) {
          this.closeWorkshopDetailModal();
          return;
        }
        if (!$('modal-module-workshop')?.classList.contains('hidden')) {
          this.closeOnlineWorkshopModal();
          return;
        }
        this.closeDockFlyout();
      }
    });

    $('btn-auto-layout')?.addEventListener('click', () => this.autoLayout());
    $('btn-run-plan')?.addEventListener('click', () => this.executeStartupPlan());
    $('btn-stop-all')?.addEventListener('click', () => this.stopAllModules());

    $('btn-run-group')?.addEventListener('click', () => this.startCurrentGroup());
    $('btn-stop-group')?.addEventListener('click', () => this.stopCurrentGroup());
    $('btn-manage-groups')?.addEventListener('click', () => this.openGroupModal());

    $('btn-env-detect')?.addEventListener('click', () => this.openEnvModal());
    $('btn-close-env-modal')?.addEventListener('click', () => this.closeEnvModal());
    $('btn-finish-env')?.addEventListener('click', () => this.closeEnvModal());
    $('btn-reprobe-env')?.addEventListener('click', () => this.probeEnvironment());

    $('btn-native-pick')?.addEventListener('click', (e) => {
      e.stopPropagation();
      $('import-pick-menu')?.classList.toggle('hidden');
    });
    $('btn-import-pick-dir')?.addEventListener('click', (e) => {
      e.stopPropagation();
      $('import-pick-menu')?.classList.add('hidden');
      this.pickNativeModuleDirectory('module');
    });
    $('btn-import-pick-file')?.addEventListener('click', (e) => {
      e.stopPropagation();
      $('import-pick-menu')?.classList.add('hidden');
      this.pickNativeModuleDirectory('file');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.picker-dropdown-wrap')) {
        document.querySelectorAll('.picker-popover-menu').forEach(m => m.classList.add('hidden'));
      }
    });
    let treeAutoSyncTimer = null;
    const triggerTreeSync = (val) => {
      clearTimeout(treeAutoSyncTimer);
      if (!val) return;
      const clean = val.replace(/^["']+|["']+$/g, '').trim();
      if (clean.length < 2) return;
      let browseDir = clean;
      if (/\.[a-zA-Z0-9]+$/.test(browseDir)) {
        browseDir = browseDir.replace(/[\\/][^\\/]+$/, '') || browseDir;
      }
      this.loadTreeBrowser?.(browseDir);
    };

    $('inp-import-path')?.addEventListener('input', () => {
      this.currentImportReview = null;
      this.importProviderSelection = null;
      $('import-provider-selection')?.remove();
      $('btn-confirm-import').disabled = true;
      $('import-preview-box')?.classList.add('hidden');
      $('inp-import-path')?.classList.remove('input-error');

      // 输入路径时自动防抖（300ms）同步下方的网页目录树浏览器 (section-block)
      clearTimeout(treeAutoSyncTimer);
      treeAutoSyncTimer = setTimeout(() => {
        triggerTreeSync($('inp-import-path')?.value?.trim());
      }, 300);
    });

    $('inp-import-path')?.addEventListener('paste', () => {
      setTimeout(() => {
        triggerTreeSync($('inp-import-path')?.value?.trim());
      }, 50);
    });

    $('inp-import-path')?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(treeAutoSyncTimer);
        const raw = $('inp-import-path')?.value?.trim();
        if (raw) {
          const clean = raw.replace(/^["']+|["']+$/g, '').trim();
          let browseDir = clean;
          if (/\.[a-zA-Z0-9]+$/.test(browseDir)) {
            browseDir = browseDir.replace(/[\\/][^\\/]+$/, '') || browseDir;
          }
          await this.loadTreeBrowser?.(browseDir);
        }
        const treeOpen = !$('import-tree-browser')?.classList.contains('hidden');
        if (!treeOpen) {
          this.inspectImportModule();
        } else {
          this.inspectImportModule({ silentIfInvalidDir: true });
        }
      }
    });
    $('btn-toggle-tree-browser')?.addEventListener('click', () => this.toggleTreeBrowser());
    $('btn-close-import-modal')?.addEventListener('click', () => this.closeImportModal());
    $('btn-cancel-import')?.addEventListener('click', () => this.closeImportModal());
    $('btn-do-inspect')?.addEventListener('click', () => this.inspectImportModule());
    $('btn-confirm-import')?.addEventListener('click', () => this.confirmImportModule());

    $('btn-workshop')?.addEventListener('click', () => this.openWorkshopModal());
    $('btn-close-workshop-modal')?.addEventListener('click', () => this.closeOnlineWorkshopModal());
    $('btn-finish-workshop')?.addEventListener('click', () => this.closeOnlineWorkshopModal());

    $('inp-ws-search')?.addEventListener('input', () => this.renderWorkshopCards());
    $('btn-ws-search-clear')?.addEventListener('click', () => {
      const inp = $('inp-ws-search');
      if (inp) inp.value = '';
      this.renderWorkshopCards();
    });
    $('sel-ws-type')?.addEventListener('change', () => this.renderWorkshopCards());
    $('sel-ws-contract')?.addEventListener('change', () => this.renderWorkshopCards());
    $('sel-ws-sort')?.addEventListener('change', () => this.renderWorkshopCards());
    $('btn-ws-reset-filters')?.addEventListener('click', () => this.resetWorkshopFilters());

    // 工坊四视图切换（在线工坊 vs 已有模块更新 vs 已下载与缓存 vs 下载与策略设置）
    $('tab-ws-nav-online')?.addEventListener('click', () => this.switchWorkshopView('online'));
    $('tab-ws-nav-updates')?.addEventListener('click', () => this.switchWorkshopView('updates'));
    $('tab-ws-nav-downloaded')?.addEventListener('click', () => this.switchWorkshopView('downloaded'));
    $('tab-ws-nav-settings')?.addEventListener('click', () => this.switchWorkshopView('settings'));

    // 已有模块更新工具栏
    $('btn-ws-check-updates')?.addEventListener('click', () => this.checkAllUpdates(true));
    $('btn-ws-batch-update')?.addEventListener('click', () => this.openBatchUpdateModal());

    // 设置项变化监听
    $('sel-setting-default-config-policy')?.addEventListener('change', e => {
      localStorage.setItem('hub.versions.defaultConfigPolicy', e.target.value);
      canvasToast(() => (t('已更新默认配置策略：{policy}', { policy: e.target.value === 'preserve' ? t('保留当前配置 (推荐)') : t('使用作者默认值') })), 'neutral');
    });
    $('sel-setting-default-data-policy')?.addEventListener('change', e => {
      localStorage.setItem('hub.versions.defaultDataPolicy', e.target.value);
      canvasToast(() => (t('已更新默认数据策略：{policy}', { policy: e.target.value === 'preserve' ? t('保留实例数据 (推荐)') : t('使用全新实例数据') })), 'neutral');
    });
    $('chk-setting-private-network')?.addEventListener('change', e => {
      localStorage.setItem('hub.workshop.allowPrivateNetwork', e.target.checked ? '1' : '0');
      if ($('inp-workshop-private-network')) $('inp-workshop-private-network').checked = e.target.checked;
    });
    $('btn-setting-pick-cache-dir')?.addEventListener('click', () => {
      const val = this.cacheDirectory || $('inp-setting-cache-dir')?.value;
      if (val) {
        navigator.clipboard?.writeText(val);
        canvasToast(() => (t('已复制本地缓存目录路径到剪贴板')), 'neutral');
      }
    });

    // 本地下载缓存筛选与控制
    $('inp-ws-cache-search')?.addEventListener('input', () => this.renderWorkshopCacheList());
    $('btn-ws-cache-search-clear')?.addEventListener('click', () => {
      const inp = $('inp-ws-cache-search');
      if (inp) inp.value = '';
      this.renderWorkshopCacheList();
    });
    $('sel-ws-cache-status')?.addEventListener('change', () => this.renderWorkshopCacheList());
    $('sel-ws-cache-type')?.addEventListener('change', () => this.renderWorkshopCacheList());
    $('btn-refresh-cache')?.addEventListener('click', () => this.loadWorkshopCache());

    $('btn-close-ws-lightbox')?.addEventListener('click', () => this.closeWorkshopLightbox());
    $('modal-workshop-lightbox')?.addEventListener('click', e => {
      if (e.target.id === 'modal-workshop-lightbox' || e.target.classList.contains('ws-lightbox-content')) {
        this.closeWorkshopLightbox();
      }
    });
    $('btn-close-ws-detail')?.addEventListener('click', () => this.closeWorkshopDetailModal());
    $('btn-finish-ws-detail')?.addEventListener('click', () => this.closeWorkshopDetailModal());
    $('inp-workshop-private-network')?.addEventListener('change', e => {
      localStorage.setItem('hub.workshop.allowPrivateNetwork', e.target.checked ? '1' : '0');
    });

    $('btn-close-scaffold-modal')?.addEventListener('click', () => this.closeScaffoldModal());
    $('btn-cancel-scaffold')?.addEventListener('click', () => this.closeScaffoldModal());

    $('btn-close-package-modal')?.addEventListener('click', () => this.closePackageModal());
    $('btn-cancel-package')?.addEventListener('click', () => this.closePackageModal());

    $('tab-ws-scaffold')?.addEventListener('click', () => this.switchWorkshopTab('scaffold'));
    $('tab-ws-package')?.addEventListener('click', () => this.switchWorkshopTab('package'));
    $('tab-ws-online')?.addEventListener('click', () => this.switchWorkshopTab('online'));
    $('btn-do-scaffold')?.addEventListener('click', () => this.doScaffoldModule());
    $('btn-do-package')?.addEventListener('click', () => this.doPackageModule());
    $('btn-inspect-workshop')?.addEventListener('click', () => this.inspectWorkshopSource());
    $('btn-refresh-sources')?.addEventListener('click', () => this.loadWorkshopSources());
    $('btn-scaffold-pick-dir')?.addEventListener('click', async () => {
      const p = await this.pickFolderGeneric(t('选择模块存放目录'));
      if (p) $('inp-scaffold-dir').value = p;
    });
    $('btn-pkg-pick-source')?.addEventListener('click', async () => {
      const p = await this.pickFolderGeneric(t('选择待打包模块目录'));
      if (p) $('inp-pkg-source').value = p;
    });
    $('btn-pkg-pick-dest')?.addEventListener('click', async () => {
      const p = await this.pickFolderGeneric(t('选择打包输出目录'));
      if (p) $('inp-pkg-dest').value = p;
    });

    $('btn-external-grant')?.addEventListener('click', () => this.openExternalModal());
    $('btn-close-external-modal')?.addEventListener('click', () => this.closeExternalModal());
    $('btn-finish-external')?.addEventListener('click', () => this.closeExternalModal());
    $('btn-do-quick-grant')?.addEventListener('click', () => this.quickGrantExternal());
    $('btn-refresh-ext-list')?.addEventListener('click', () => this.fetchExternalInventory());
    $('btn-copy-code')?.addEventListener('click', () => this.copySnippetCode());
    $('tab-code-python')?.addEventListener('click', () => this.switchCodeTab('python'));
    $('tab-code-node')?.addEventListener('click', () => this.switchCodeTab('node'));

    $('btn-close-group-modal')?.addEventListener('click', () => this.closeGroupModal());
    $('btn-finish-group')?.addEventListener('click', () => this.closeGroupModal());
    $('btn-create-group')?.addEventListener('click', () => this.createModuleGroup());
    $('inp-new-group-title')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.createModuleGroup();
      }
    });
    $('inp-new-group-title')?.addEventListener('input', () => {
      $('inp-new-group-title')?.classList.remove('input-error');
    });
    $('group-manager-modal')?.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.closeGroupModal();
    });

    // 抽屉模块 Tab 切换
    const setupTab = (tabId, panelId) => {
      $(tabId)?.addEventListener('click', () => {
        ['settings', 'topics', 'deps', 'logs'].forEach(k => {
          $(`tab-mod-${k}`)?.setAttribute('aria-pressed', k === panelId ? 'true' : 'false');
          $(`ins-panel-${k}`)?.classList.toggle('hidden', k !== panelId);
        });
        if (panelId === 'logs') this.startLogPolling();
        else this.stopLogPolling();
      });
    };
    setupTab('tab-mod-settings', 'settings');
    setupTab('tab-mod-topics', 'topics');
    setupTab('tab-mod-deps', 'deps');
    setupTab('tab-mod-logs', 'logs');

    // 抽屉模块组 Tab 切换
    const setupGrpTab = (tabId, panelId) => {
      $(tabId)?.addEventListener('click', () => {
        ['members', 'topics'].forEach(k => {
          $(`tab-grp-${k}`)?.setAttribute('aria-pressed', k === panelId ? 'true' : 'false');
          $(`ins-grp-panel-${k}`)?.classList.toggle('hidden', k !== panelId);
        });
      });
    };
    setupGrpTab('tab-grp-members', 'members');
    setupGrpTab('tab-grp-topics', 'topics');

    // 抽屉模块动作
    $('btn-ins-start')?.addEventListener('click', () => this.startSelectedModule());
    $('btn-ins-save-plan-member')?.addEventListener('click', () => this.saveSelectedPlanMembership());
    $('btn-ins-stop')?.addEventListener('click', () => this.stopSelectedModule());
    $('btn-ins-remove')?.addEventListener('click', () => this.removeSelectedModule());
    $('btn-ins-security-review')?.addEventListener('click', () => this.openSecurityReviewModal());
    $('btn-ins-versions')?.addEventListener('click', () => {
      if (this.selectedGroupId) {
        this.openVersionManager('groups', this.selectedGroupId);
      } else if (this.selectedModuleId) {
        this.openVersionManager('modules', this.selectedModuleId);
      }
    });
    $('btn-grp-start')?.addEventListener('click', () => {
      if (this.selectedGroupId) this.startGroupById(this.selectedGroupId);
    });
    $('btn-grp-stop')?.addEventListener('click', () => {
      if (this.selectedGroupId) this.stopGroupById(this.selectedGroupId);
    });
    $('btn-grp-remove')?.addEventListener('click', () => {
      if (this.selectedGroupId) this.openUninstallManager('groups', this.selectedGroupId);
    });
    $('btn-grp-restore-wiring')?.addEventListener('click', () => {
      if (this.selectedGroupId) {
        this.groupFilter = this.selectedGroupId;
        this.updateGroupActionButtons();
        this.openWiringDefaultsManager();
      }
    });
    $('btn-grp-package')?.addEventListener('click', () => {
      if (this.selectedGroupId) this.openPackageModalForGroup(this.selectedGroupId);
    });
    $('btn-close-review-modal')?.addEventListener('click', () => this.closeSecurityReviewModal());
    $('btn-finish-review')?.addEventListener('click', () => this.closeSecurityReviewModal());
    $('btn-copy-review-digest')?.addEventListener('click', async () => {
      const d = $('review-digest-val')?.value;
      if (d) {
        await navigator.clipboard.writeText(d);
        canvasToast(() => (t('指纹已复制')), 'neutral');
      }
    });
    $('btn-ins-save-config')?.addEventListener('click', () => this.saveSelectedModuleConfig());
    $('btn-ins-refresh-logs')?.addEventListener('click', () => this.refreshModuleLogs());
    $('btn-ins-add-dep')?.addEventListener('click', () => this.addPrerequisiteFromDrawer());

    // 运行模式视角切换（拓扑卡片 vs 天体星轨）
    $('btn-perspective-toggle')?.addEventListener('click', () => {
      this.runtimePerspective = this.runtimePerspective === 'topology' ? 'orbits' : 'topology';
      this.updateModeUI();
      this.render();
      canvasToast(() => (this.runtimePerspective === 'topology' ? t('已切换至微服务拓扑视图') : t('已切换至天体星轨投影视图')), 'neutral');
    });

    // 底部状态栏抽屉切换
    $('btn-stream-drawer-toggle')?.addEventListener('click', () => {
      const drawer = $('stream-drawer');
      if (drawer) {
        $('stream-bar')?.click();
        const isExpanded = drawer.classList.contains('expanded');
        setCanvasHtml($('btn-stream-drawer-toggle'), () => (`${canvasLabel(() => t('📊 信息流水'))} <span id="bottom-stream-count-tag" style="opacity:0.7;">(150)</span> ${isExpanded ? '▼' : '▲'}`));
      }
    });

    // 监听实时通讯跑马灯并与连线流光同步
    const origTicker = $('stream-ticker');
    if (origTicker) {
      const updateBottomTicker = () => {
        const text = origTicker.textContent?.trim();
        if (text) {
          const tEl = $('bottom-ticker-text');
          if (tEl) setCanvasText(tEl, () => (text));
          const match = text.match(/:\s*([^\s#]+)/);
          if (match && match[1]) {
            this.pulseTopicWire(match[1]);
          }
        }
      };
      const obs = new MutationObserver(updateBottomTicker);
      obs.observe(origTicker, { childList: true, characterData: true, subtree: true });
      updateBottomTicker();
    }

    $('bottom-event-ticker')?.addEventListener('click', () => {
      const text = $('bottom-ticker-text')?.textContent;
      const match = text?.match(/:\s*([^\s#]+)/);
      if (match && match[1]) {
        this.inspectWireTopic(match[1]);
      } else {
        $('stream-bar')?.click();
      }
    });

    // 接线模式智能对接与矩阵清单
    $('btn-auto-wire')?.addEventListener('click', () => this.autoWireMatchingTopics());
    $('btn-wiring-matrix')?.addEventListener('click', () => this.openWiringMatrixModal());
    $('btn-restore-default-wiring')?.addEventListener('click', () => this.openWiringDefaultsManager());
    $('btn-modal-auto-wire')?.addEventListener('click', () => this.autoWireMatchingTopics());
    $('btn-close-wiring-modal')?.addEventListener('click', () => this.closeWiringMatrixModal());
    $('btn-finish-wiring-modal')?.addEventListener('click', () => this.closeWiringMatrixModal());
    $('btn-do-pair-connect')?.addEventListener('click', () => this.doPairConnectFromModal());
    $('inp-filter-wires')?.addEventListener('input', e => this.filterWiringMatrixTable(e.target.value));
    $('sel-pair-source')?.addEventListener('change', () => this.onPairSourceChange());

    // 接线矩阵分类筛选切换
    $('wiring-matrix-modal')?.addEventListener('click', e => {
      const pill = e.target.closest('.matrix-filter-pill');
      if (pill) {
        const filter = pill.dataset.filter || 'all';
        this.matrixCategoryFilter = filter;
        document.querySelectorAll('.matrix-filter-pill').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
        this.renderWiringMatrixModal();
      }
    });

    // 画布全局鼠标事件（节点卡片与编排依赖拖拽）
    window.addEventListener('mousemove', e => this.handleMouseMove(e));
    window.addEventListener('mouseup', e => this.handleMouseUp(e));
  }

  // 7. 数据拉取
  async fetchModulesData() {
    if (this.pendingMutations > 0) return { refreshed: false, error: new Error(t('正在保存其他操作，请稍后刷新。')) };
    try {
      const res = await fetch('/manage/api/programs');
      if (this.pendingMutations > 0) return { refreshed: false, error: new Error(t('正在保存其他操作，请稍后刷新。')) };
      if (!res.ok) {
        let detail; try { detail = await res.json(); } catch { /* Preserve an HTTP error when no JSON is available. */ }
        throw new Error(detail ? errorText(detail) : `HTTP ${res.status}`);
      }
      if (res.ok) {
        this.data = await res.json();
        const savedNodes = this.data.layout?.nodes || {};
        const savedModes = this.data.layout?.modes || {};
        const allModes = ['static', 'runtime', 'wiring', 'orchestration'];
        for (const m of allModes) {
          const modeSaved = savedModes[m] || (m === 'runtime' ? savedNodes : {});
          for (const prog of this.data.programs) {
            if (!this.modePositions[m].has(prog.programId)) {
              const p = modeSaved[prog.programId];
              if (p && typeof p.x === 'number' && typeof p.y === 'number') {
                this.modePositions[m].set(prog.programId, { x: p.x, y: p.y });
              }
            }
          }
        }
        this.updateGroupFilterOptions();
        this.updateGroupActionButtons();
        this.render();
        return { refreshed: true };
      }
    } catch (e) {
      console.warn('拉取模块数据失败:', e);
      return { refreshed: false, error: e };
    }
  }

  updateGroupFilterOptions() {
    const sel = $('hud-group-filter');
    if (!sel) return;
    const currentVal = sel.value;
    setCanvasHtml(sel, () => ('<option value="all" data-i18n="🌐 全局全部模块">' + t('🌐 全局全部模块') + '</option>'));
    for (const g of this.data.groups || []) {
      const opt = document.createElement('option');
      opt.value = g.id;
      setCanvasText(opt, () => (`📁 ${g.title || g.id} (${(g.memberProgramIds || []).length})`));
      sel.append(opt);
    }
    sel.value = currentVal || 'all';
  }

  updateGroupActionButtons() {
    const isGroupSelected = this.groupFilter !== 'all';
    const isStatic = this.mode === 'static';
    const isOrch = this.mode === 'orchestration';
    const isRuntime = this.mode === 'runtime';
    const isWiring = this.mode === 'wiring';

    const runPlanBtn = $('btn-run-plan');
    if (runPlanBtn) {
      runPlanBtn.style.display = (isOrch || isRuntime) ? 'inline-flex' : 'none';
      setCanvasText(runPlanBtn, () => (this.executionText(isGroupSelected ? '▶ 启动本组常驻计划' : '▶ 启动全局常驻计划')));
    }

    const runGrpBtn = $('btn-run-group');
    if (runGrpBtn) {
      const show = isGroupSelected && !isWiring && !isStatic;
      runGrpBtn.classList.toggle('hidden', !show);
      runGrpBtn.style.display = show ? 'inline-flex' : 'none';
    }

    const stopGrpBtn = $('btn-stop-group');
    if (stopGrpBtn) {
      const show = isGroupSelected && !isWiring && !isStatic;
      stopGrpBtn.classList.toggle('hidden', !show);
      stopGrpBtn.style.display = show ? 'inline-flex' : 'none';
    }

    const stopAllBtn = $('btn-stop-all');
    if (stopAllBtn) {
      const show = !isGroupSelected && !isWiring && !isStatic;
      stopAllBtn.classList.toggle('hidden', !show);
      stopAllBtn.style.display = show ? 'inline-flex' : 'none';
    }

    const failSel = $('hud-failure-policy');
    if (failSel) {
      failSel.style.display = (isOrch || isRuntime) ? 'inline-block' : 'none';
      failSel.value = this.getActivePlan().onFailure || 'continue-independent';
    }

    const autoWireBtn = $('btn-auto-wire');
    if (autoWireBtn) {
      autoWireBtn.classList.toggle('hidden', !isWiring);
      autoWireBtn.style.display = isWiring ? 'inline-flex' : 'none';
    }

    const matrixBtn = $('btn-wiring-matrix');
    if (matrixBtn) {
      matrixBtn.classList.toggle('hidden', !isWiring);
      matrixBtn.style.display = isWiring ? 'inline-flex' : 'none';
    }

    const restoreWiringBtn = $('btn-restore-default-wiring');
    if (restoreWiringBtn) {
      restoreWiringBtn.classList.toggle('hidden', !isWiring);
      restoreWiringBtn.style.display = isWiring ? 'inline-flex' : 'none';
      restoreWiringBtn.disabled = this.pendingMutations > 0;
    }

    const execPanel = $('bottom-exec-controls');
    if (execPanel) {
      const showExec = !isStatic;
      execPanel.classList.toggle('hidden', !showExec);
      execPanel.style.display = showExec ? 'inline-flex' : 'none';
    }

    const wiringSummary = $('bottom-wiring-summary');
    if (wiringSummary) {
      if (isWiring) {
        wiringSummary.classList.remove('hidden');
        const focusProg = (this.data.programs || []).find(p => p.programId === this.focusedWiringModuleId);
        const focusTitle = focusProg ? (localizedText(focusProg.title, focusProg.programId)) : '';
        if (focusProg) {
          setCanvasText(wiringSummary, () => (t('🔌 当前接线: [{title}] · 点击候选伙伴卡片上的【一键对接】即可建立通道', { title: focusTitle })));
        } else {
          setCanvasText(wiringSummary, () => (t('🔌 接线架构: 点击画布模块卡片选为接线对象，或点击上方【接线矩阵清单】集中管理')));
        }
      } else {
        wiringSummary.classList.add('hidden');
      }
    }

    const staticSummary = $('bottom-static-summary');
    if (staticSummary) {
      if (isStatic) {
        staticSummary.classList.remove('hidden');
        const count = this.filteredPrograms().length;
        setCanvasText(staticSummary, () => (t('📦 已有模块: {count} 个 (点击卡片查看规范/审计)', { count })));
      } else {
        staticSummary.classList.add('hidden');
      }
    }

    const orchSummary = $('bottom-orch-summary');
    if (orchSummary) {
      if (isOrch) {
        orchSummary.classList.remove('hidden');
        const progs = this.filteredPrograms();
        const stages = this.computeStages();
        let maxStage = 1;
        stages.forEach(s => { if (s > maxStage) maxStage = s; });
        const plan = this.getActivePlan()?.members || [];
        let totalDeps = 0;
        plan.forEach(m => totalDeps += (m.after || []).length);
        setCanvasText(orchSummary, () => (t('📋 编排批次: {stages} 阶段 · {deps} 条前置规则 ({modules} 个模块)', { stages: maxStage, deps: totalDeps, modules: progs.length })));
      } else {
        orchSummary.classList.add('hidden');
      }
    }
  }

  // 8. 切换模式
  switchMode(newMode) {
    this.mode = newMode;
    this.updateModeUI();
    this.render();
  }

  updateModeUI() {
    ['static', 'wiring', 'orchestration', 'runtime'].forEach(m => {
      const btn = $(`tab-mode-${m}`);
      if (btn) {
        btn.classList.toggle('active', m === this.mode);
        btn.setAttribute('aria-pressed', m === this.mode ? 'true' : 'false');
      }
    });

    const isStatic = this.mode === 'static';
    const isRuntime = this.mode === 'runtime';
    const isWiring = this.mode === 'wiring';
    const isOrch = this.mode === 'orchestration';

    // 视角切换按键更新 (仅在运行模式下可见)
    const perspBtn = $('btn-perspective-toggle');
    if (perspBtn) {
      perspBtn.style.display = isRuntime ? 'inline-flex' : 'none';
      setCanvasText(perspBtn, () => (this.runtimePerspective === 'topology' ? t('🗺 拓扑卡片') : t('🪐 天体星轨')));
      setCanvasAttribute(perspBtn, 'title', () => (t('在微服务拓扑卡片与天体同心圆轨道视角间切换')));
    }

    // 悬浮条控制
    $('wiring-focus-bar')?.remove();

    const staticBar = $('static-filter-bar');
    if (staticBar) {
      staticBar.style.display = isStatic ? 'inline-flex' : 'none';
      staticBar.classList.toggle('hidden', !isStatic);
    }

    // 核心层可见性控制：拓扑卡片在三模式下连续展示！
    const showOrbits = isRuntime && this.runtimePerspective === 'orbits';
    const showCards = !isRuntime || this.runtimePerspective === 'topology';

    $('hub-node')?.classList.toggle('hidden', !showOrbits);
    $('guides-g')?.classList.toggle('hidden', !showOrbits);
    $('rails-g')?.classList.toggle('hidden', !showOrbits);
    $('pulses-g')?.classList.toggle('hidden', !showOrbits);
    $('bridge-nodes-g')?.classList.toggle('hidden', !showOrbits);
    $('program-nodes-g')?.classList.toggle('hidden', !showOrbits);
    $('annotation-links-g')?.classList.toggle('hidden', !showOrbits);

    // 自定义拓扑层：卡片与分组外框在静态、接线、编排与拓扑视角运行模式下均可见！
    $('module-nodes-g')?.classList.toggle('hidden', !showCards);
    $('group-containers-g')?.classList.toggle('hidden', !showCards);
    $('wiring-cables-g')?.classList.toggle('hidden', !isWiring || !this.focusedWiringModuleId);
    $('orchestration-dag-g')?.classList.toggle('hidden', !isOrch);

    this.updateGroupActionButtons();
  }

  // 9. 核心渲染
  render() {
    // 若在运行模式且透视为天体星轨，则清空并隐藏卡片层和分组框层，不重绘卡片层
    if (this.mode === 'runtime' && this.runtimePerspective === 'orbits') {
      $('module-nodes-g')?.replaceChildren();
      $('group-containers-g')?.replaceChildren();
      $('group-containers-g')?.classList.add('hidden');
      return;
    }

    // 非接线模式下清空接线层，杜绝连线残留至运行监控模式
    if (this.mode !== 'wiring') {
      $('wiring-cables-g')?.replaceChildren();
    }

    const container = $('module-nodes-g');
    if (!container) return;
    container.replaceChildren();

    if (this.mode === 'static') {
      this.renderStaticMode(container);
      this.renderGroupContainers();
      return;
    }

    if (this.mode === 'wiring') {
      this.renderFocusedWiringMode(container);
      this.renderGroupContainers();
      return;
    }

    const programs = this.filteredPrograms();
    if (this.mode === 'orchestration') {
      if (this.modePositions.orchestration.size === 0) {
        this.layoutDAG(programs);
      } else {
        programs.forEach(prog => {
          if (!this.modePositions.orchestration.has(prog.programId)) {
            const stages = this.computeStages();
            const s = stages.get(prog.programId) || 1;
            const x = (s - 1) * 360 - 200;
            this.modePositions.orchestration.set(prog.programId, { x, y: 0 });
          }
        });
      }
    } else if (this.mode === 'runtime') {
      let unplacedIdx = 0;
      programs.forEach(prog => {
        let pos = this.modePositions.runtime.get(prog.programId);
        if (!pos) {
          pos = { x: (unplacedIdx % 3) * 340 - 340, y: Math.floor(unplacedIdx / 3) * 220 - 110 };
          this.modePositions.runtime.set(prog.programId, pos);
          unplacedIdx++;
        }
      });
    }

    // 渲染模块卡片
    programs.forEach(prog => {
      const pos = this.nodePositions.get(prog.programId);
      const nodeEl = this.createModuleCard(prog, pos);
      container.append(nodeEl);
    });

    if (this.mode === 'orchestration') this.renderDAGArrows();
    this.renderGroupContainers();
  }

  // 9.1 静态模式：查看所有已安装受管模块清单与规范元数据
  renderStaticMode(container) {
    let programs = this.filteredPrograms();
    if (this.staticSearchQuery) {
      const q = this.staticSearchQuery;
      programs = programs.filter(p => {
        const title = (localizedText(p.title, '')).toLowerCase();
        const id = (p.programId || '').toLowerCase();
        const modId = (p.module?.id || '').toLowerCase();
        const caps = [...(p.provides || []), ...(p.requires || [])].map(c => (typeof c === 'string' ? c : c.id || '').toLowerCase()).join(' ');
        return title.includes(q) || id.includes(q) || modId.includes(q) || caps.includes(q);
      });
    }

    const cardWidth = 350;
    const cardHeight = 230;
    const total = programs.length;
    const cols = total <= 1 ? 1 : (total <= 4 ? 2 : 3);
    const rows = Math.ceil(total / cols);

    programs.forEach((prog, idx) => {
      let pos = this.modePositions.static.get(prog.programId);
      if (!pos) {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        pos = {
          x: Math.round((col - (cols - 1) / 2) * 380),
          y: Math.round((row - (rows - 1) / 2) * 260)
        };
        this.modePositions.static.set(prog.programId, pos);
      }
      const cardEl = this.createStaticModuleCard(prog, pos, cardWidth, cardHeight);
      container.append(cardEl);
    });
  }

  createStaticModuleCard(prog, pos, cardWidth = 350, cardHeight = 230) {
    const isSelected = this.selectedModuleId === prog.programId;
    const title = localizedText(prog.title, prog.module?.id || prog.programId);
    const modId = prog.module?.id || prog.manifest?.id || prog.programId;
    const version = prog.module?.version || prog.manifest?.version || '1.0.0';
    const runtimeKind = prog.runtime?.kind || prog.manifest?.runtime?.kind || 'node';
    const entryFile = prog.runtime?.entry || prog.manifest?.runtime?.entry || prog.entry || 'program.mjs';
    const sourceDir = prog.sourceDirectory || prog.directory || prog.module?.dir || '—';
    const digest = prog.sourceFiles?.[0]?.sha256 || prog.configurationRevision || '';
    const digestShort = digest ? (digest.slice(0, 16) + '…') : t('未生成');

    const provides = (prog.provides || []).map(p => typeof p === 'string' ? p : p.id).join(', ') || t('无能力声明');
    const requires = (prog.requires || []).map(r => typeof r === 'string' ? r : r.id).join(', ') || t('无前置要求');

    const channels = this.extractProgramChannels(prog);
    const pubStr = channels.publish.map(p => `${p.alias}➔${p.topic}`).join(', ') || t('无');
    const subStr = channels.subscribe.map(s => `${s.alias}➔${s.topic}`).join(', ') || t('无');

    const g = svgEl('g', {
      class: `cmn-node static-card${isSelected ? ' selected' : ''}`,
      id: `cmn-${prog.programId}`,
      transform: `translate(${pos.x}, ${pos.y})`
    });

    g.append(this.executionPolicyBadge(prog, cardWidth / 2 - 66, -cardHeight / 2 - 19));
    // 背景
    g.append(svgEl('rect', {
      x: -cardWidth / 2, y: -cardHeight / 2,
      width: cardWidth, height: cardHeight,
      class: 'cmn-static-bg'
    }));

    // 头部
    const headerBg = svgEl('rect', {
      x: -cardWidth / 2, y: -cardHeight / 2,
      width: cardWidth, height: 38,
      fill: 'rgba(168, 85, 247, 0.08)', rx: 12
    });
    headerBg.style.cursor = 'grab';
    headerBg.addEventListener('mousedown', e => this.startDragNode(e, prog.programId));
    g.append(headerBg);

    // 运行环境徽标
    const isPy = runtimeKind === 'python';
    const badgeG = svgEl('g', { transform: `translate(${-cardWidth / 2 + 12}, ${-cardHeight / 2 + 10})` });
    badgeG.append(
      svgEl('rect', {
        x: 0, y: 0, width: isPy ? 58 : 62, height: 18, rx: 4,
        fill: isPy ? 'rgba(56, 189, 248, 0.15)' : 'rgba(0, 210, 180, 0.15)',
        stroke: isPy ? '#38bdf8' : '#00d2b4', 'stroke-width': '1'
      }),
      svgEl('text', {
        x: (isPy ? 58 : 62) / 2, y: 13,
        fill: isPy ? '#38bdf8' : '#00d2b4',
        'font-size': '10px', 'font-weight': '800', 'text-anchor': 'middle'
      }, isPy ? '🐍 Python' : '🟢 Node.js')
    );
    g.append(badgeG);

    // 模块主标题
    const titleText = svgEl('text', {
      x: -cardWidth / 2 + (isPy ? 76 : 80), y: -cardHeight / 2 + 23,
      fill: '#ffffff', 'font-size': '13px', 'font-weight': '800'
    }, title.length > 14 ? title.slice(0, 13) + '…' : title);
    g.append(titleText);

    // 版本标签
    g.append(svgEl('text', {
      x: cardWidth / 2 - 12, y: -cardHeight / 2 + 23,
      fill: 'var(--muted)', 'font-size': '10px', 'font-family': 'var(--mono)', 'text-anchor': 'end'
    }, `v${version}`));

    // 卡片信息主体
    const startY = -cardHeight / 2 + 54;
    const rowH = 18;

    const addPropRow = (icon, label, val, y, isMono = false, color = 'var(--ink)') => {
      const rowG = svgEl('g', { transform: `translate(${-cardWidth / 2 + 14}, ${y})` });
      rowG.append(svgEl('text', { x: 0, y: 0, fill: 'var(--muted)', 'font-size': '10px' }, `${icon} ${label}:`));
      const valText = svgEl('text', {
        x: 72, y: 0, fill: color, 'font-size': '10px',
        ...(isMono ? { 'font-family': 'var(--mono)' } : {})
      }, val.length > 34 ? val.slice(0, 32) + '…' : val);
      rowG.append(valText);
      g.append(rowG);
    };

    addPropRow('📁', t('源码目录'), sourceDir, startY, true);
    addPropRow('📄', t('执行入口'), `${runtimeKind} ${entryFile}`, startY + rowH, true);
    addPropRow('🛡', t('安全指纹'), digestShort, startY + rowH * 2, true, '#f59e0b');
    addPropRow('💡', t('能力声明'), `${provides} | ${t('需:')}${requires}`, startY + rowH * 3, false, '#c084fc');
    addPropRow('📡', t('通道规格'), `▲${pubStr} | ▼${subStr}`, startY + rowH * 4, false, 'var(--teal)');

    // 底部动作条
    const footerY = cardHeight / 2 - 28;
    const btnW = 72;
    const btnH = 20;

    const makeBtn = (x, text, color, onClick) => {
      const btn = svgEl('g', { transform: `translate(${x}, ${footerY})`, style: 'cursor:pointer;' });
      btn.append(
        svgEl('rect', {
          x: 0, y: 0, width: btnW, height: btnH, rx: 4,
          fill: 'rgba(255,255,255,0.04)', stroke: 'rgba(255,255,255,0.12)', 'stroke-width': '1'
        }),
        svgEl('text', {
          x: btnW / 2, y: 14, fill: color,
          'font-size': '10px', 'font-weight': '700', 'text-anchor': 'middle'
        }, text)
      );
      btn.addEventListener('click', e => {
        e.stopPropagation();
        onClick();
      });
      return btn;
    };

    g.append(makeBtn(-cardWidth / 2 + 14, t('🔍 查看规范'), '#c084fc', () => {
      this.selectModule(prog.programId);
      $('tab-mod-settings')?.click();
    }));

    g.append(makeBtn(-cardWidth / 2 + 94, t('🛡 安全审计'), '#f59e0b', () => {
      this.selectModule(prog.programId);
      this.openSecurityReviewModal();
    }));

    g.append(makeBtn(-cardWidth / 2 + 174, t('📋 复制路径'), '#38bdf8', async () => {
      if (sourceDir && sourceDir !== '—') {
        await navigator.clipboard.writeText(sourceDir);
        canvasToast(() => (t('物理源码目录已复制到剪贴板')), 'neutral');
      }
    }));

    g.append(makeBtn(-cardWidth / 2 + 254, t('🗑 卸载移除'), '#f43f5e', () => {
      this.removeProgramDirectly(prog.programId);
    }));

    g.addEventListener('click', () => this.selectModule(prog.programId));
    return g;
  }

  async removeProgramDirectly(programId) {
    return this.openUninstallManager('modules', programId);
  }

  // 9.2 接线模式（已全面使用画布卡片直观选择与取消，移除顶栏悬浮条）
  updateWiringFocusPills() {
    $('wiring-focus-bar')?.remove();
  }

  extractProgramChannels(prog) {
    const pubList = [];
    const subList = [];
    for (const [slot, perms] of Object.entries(prog.bridges || {})) {
      for (const alias of perms.publish || []) {
        const topic = prog.topics?.[alias] || alias;
        pubList.push({ alias, topic, slot });
      }
      for (const alias of perms.subscribe || []) {
        const topic = prog.topics?.[alias] || alias;
        subList.push({ alias, topic, slot });
      }
    }
    return { publish: pubList, subscribe: subList };
  }

  findMatchingPartners(focusProg, allPrograms) {
    const rawWires = this.data.wiring?.wires || [];
    const focusChannels = this.extractProgramChannels(focusProg);
    const results = [];

    allPrograms.forEach(p => {
      if (p.programId === focusProg.programId) return;

      const partnerChannels = this.extractProgramChannels(p);
      const pairs = [];

      // 1. focusProg (publish) -> p (subscribe)
      for (const pub of focusChannels.publish) {
        for (const sub of partnerChannels.subscribe) {
          const wire = rawWires.find(w =>
            w.from.programId === focusProg.programId &&
            w.from.alias === pub.alias &&
            w.to.programId === p.programId &&
            w.to.alias === sub.alias
          );
          if (wire) {
            pairs.push({
              dir: 'focus-to-partner',
              from: { ...pub, programId: focusProg.programId },
              to: { ...sub, programId: p.programId },
              topic: wire.topic,
              status: 'wired',
              wire
            });
          } else if (
            (pub.topic && sub.topic && pub.topic === sub.topic && !pub.topic.includes('unwired')) ||
            pub.alias === sub.alias ||
            (pub.topic && sub.topic && pub.topic.split('/')[0] === sub.topic.split('/')[0] && pub.topic.split('/')[0] !== '' && !pub.topic.includes('unwired') && !sub.topic.includes('unwired'))
          ) {
            let pairTopic = pub.topic;
            if (!pairTopic || pairTopic.includes('unwired')) {
              pairTopic = sub.topic;
            }
            if (!pairTopic || pairTopic.includes('unwired')) {
              pairTopic = `${focusProg.programId}/${pub.alias}`;
            }
            pairs.push({
              dir: 'focus-to-partner',
              from: { ...pub, programId: focusProg.programId },
              to: { ...sub, programId: p.programId },
              topic: pairTopic,
              status: 'match'
            });
          }
        }
      }

      // 2. p (publish) -> focusProg (subscribe)
      for (const pub of partnerChannels.publish) {
        for (const sub of focusChannels.subscribe) {
          const wire = rawWires.find(w =>
            w.from.programId === p.programId &&
            w.from.alias === pub.alias &&
            w.to.programId === focusProg.programId &&
            w.to.alias === sub.alias
          );
          if (wire) {
            pairs.push({
              dir: 'partner-to-focus',
              from: { ...pub, programId: p.programId },
              to: { ...sub, programId: focusProg.programId },
              topic: wire.topic,
              status: 'wired',
              wire
            });
          } else if (
            (pub.topic && sub.topic && pub.topic === sub.topic && !pub.topic.includes('unwired')) ||
            pub.alias === sub.alias ||
            (pub.topic && sub.topic && pub.topic.split('/')[0] === sub.topic.split('/')[0] && pub.topic.split('/')[0] !== '' && !pub.topic.includes('unwired') && !sub.topic.includes('unwired'))
          ) {
            let pairTopic = pub.topic;
            if (!pairTopic || pairTopic.includes('unwired')) {
              pairTopic = sub.topic;
            }
            if (!pairTopic || pairTopic.includes('unwired')) {
              pairTopic = `${p.programId}/${pub.alias}`;
            }
            pairs.push({
              dir: 'partner-to-focus',
              from: { ...pub, programId: p.programId },
              to: { ...sub, programId: focusProg.programId },
              topic: pairTopic,
              status: 'match'
            });
          }
        }
      }

      // 仅当存在已接线或兼容匹配时，才算作有效候选伙伴！
      if (pairs.length > 0) {
        // 合并双向对称全双工通道（避免卡片中生成两个混淆的重复按键）
        const consolidated = [];
        const pairedSet = new Set();
        for (let i = 0; i < pairs.length; i++) {
          if (pairedSet.has(i)) continue;
          const p1 = pairs[i];
          let revIdx = -1;
          for (let j = i + 1; j < pairs.length; j++) {
            if (pairedSet.has(j)) continue;
            const p2 = pairs[j];
            if (p1.from.alias === p2.to.alias && p1.to.alias === p2.from.alias && p1.dir !== p2.dir) {
              revIdx = j;
              break;
            }
          }
          if (revIdx !== -1) {
            pairedSet.add(i);
            pairedSet.add(revIdx);
            const p2 = pairs[revIdx];
            const isWired = p1.status === 'wired' || p2.status === 'wired';
            const fwd = p1.dir === 'focus-to-partner' ? p1 : p2;
            const rev = p1.dir === 'focus-to-partner' ? p2 : p1;
            consolidated.push({
              isBidirectional: true,
              dir: 'bidirectional',
              forward: fwd,
              reverse: rev,
              from: fwd.from,
              to: fwd.to,
              alias: fwd.from.alias,
              partnerAlias: fwd.to.alias,
              topic: fwd.topic || rev.topic,
              status: isWired ? 'wired' : 'match',
              wires: [fwd.wire, rev.wire].filter(Boolean)
            });
          } else {
            pairedSet.add(i);
            consolidated.push({
              isBidirectional: false,
              ...p1
            });
          }
        }

        consolidated.sort((a, b) => (a.status === 'wired' ? -1 : 1));
        results.push({ prog: p, pairs: consolidated });
      }
    });

    return results;
  }

  getPairCountForProg(programId) {
    if (this.mode !== 'wiring' || !this.focusedWiringModuleId) return 0;
    const focusProg = (this.data.programs || []).find(p => p.programId === this.focusedWiringModuleId);
    if (!focusProg) return 0;
    const partners = this.findMatchingPartners(focusProg, this.filteredPrograms());
    const match = partners.find(cand => cand.prog.programId === programId);
    return match ? match.pairs.length : 0;
  }

  renderFocusedWiringMode(container) {
    const allPrograms = this.filteredPrograms();
    if (!allPrograms.length) return;

    // 状态 A: 未选中接线主体 -> 渲染全量模块概览供点击选择
    if (!this.focusedWiringModuleId || !allPrograms.some(p => p.programId === this.focusedWiringModuleId)) {
      this.focusedWiringModuleId = null;
      this.renderWiringOverview(container, allPrograms);
      return;
    }

    // 状态 B: 选定了某个模块 -> 聚焦核心 + 仅显示匹配候选模块 (彻底隐藏不相干模块)
    const focusProg = allPrograms.find(p => p.programId === this.focusedWiringModuleId);
    if (!focusProg) {
      this.focusedWiringModuleId = null;
      this.renderWiringOverview(container, allPrograms);
      return;
    }

    // 寻找所有匹配的候选伙伴模块 (过滤掉完全不相干模块)
    const candidatePartners = this.findMatchingPartners(focusProg, allPrograms);

    // 定位核心模块在左侧
    const focusPos = { x: -280, y: 0 };
    this.nodePositions.set(focusProg.programId, focusPos);

    // 定位匹配伙伴在右侧
    const totalPartners = candidatePartners.length;
    const spacingY = 250;
    candidatePartners.forEach((cand, idx) => {
      const py = Math.round((idx - (totalPartners - 1) / 2) * spacingY);
      const pPos = { x: 280, y: py };
      this.nodePositions.set(cand.prog.programId, pPos);
    });

    // 1. 渲染核心模块卡片
    const focusCard = this.createFocusedWiringCard(focusProg, focusPos);
    container.append(focusCard);

    // 2. 渲染各个候选伙伴卡片
    if (candidatePartners.length > 0) {
      candidatePartners.forEach(cand => {
        const pPos = this.nodePositions.get(cand.prog.programId);
        const partnerCard = this.createPartnerWiringCard(focusProg, cand.prog, cand.pairs, pPos);
        container.append(partnerCard);
      });
    } else {
      // 无匹配伙伴时的引导卡片
      const emptyCard = this.createEmptyPartnerGuideCard(focusProg, { x: 280, y: 0 });
      container.append(emptyCard);
    }

    // 3. 渲染连线 (仅在可见的核心和伙伴之间绘制！)
    this.renderWiringCables();
  }

  // 9.2.1 接线模式概览状态：展示全部已安装受管模块
  renderWiringOverview(container, allPrograms) {
    const cardWidth = 320;
    const cardHeight = 160;
    const total = allPrograms.length;
    const cols = total <= 2 ? total : (total <= 4 ? 2 : 3);
    const rows = Math.ceil(total / cols);

    allPrograms.forEach((prog, idx) => {
      let pos = this.modePositions.wiring.get(prog.programId);
      if (!pos) {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        pos = {
          x: Math.round((col - (cols - 1) / 2) * 360),
          y: Math.round((row - (rows - 1) / 2) * 200)
        };
        this.modePositions.wiring.set(prog.programId, pos);
      }

      const card = this.createWiringOverviewCard(prog, pos, cardWidth, cardHeight);
      container.append(card);
    });

    // 概览状态下亦呈现已有连线
    this.renderWiringCables();
  }

  createWiringOverviewCard(prog, pos, cardWidth = 320, cardHeight = 160) {
    const isRunning = prog.instanceCount > 0;
    const isFailed = (prog.errorCount || 0) > 0;
    const title = localizedText(prog.title, prog.module?.id || prog.programId);

    const g = svgEl('g', {
      id: `cmn-${prog.programId}`,
      class: 'cmn-node wiring-overview-card',
      transform: `translate(${pos.x}, ${pos.y})`,
      style: 'cursor:pointer;'
    });

    // 卡片背景
    const bg = svgEl('rect', {
      x: -cardWidth / 2, y: -cardHeight / 2,
      width: cardWidth, height: cardHeight,
      class: 'cmn-card-bg'
    });
    g.append(bg);

    // 顶部标题栏背景
    const headerHeight = 38;
    g.append(svgEl('rect', {
      x: -cardWidth / 2, y: -cardHeight / 2,
      width: cardWidth, height: headerHeight,
      class: 'cmn-header-bg'
    }));

    // 状态指示灯
    g.append(svgEl('circle', {
      cx: -cardWidth / 2 + 18, cy: -cardHeight / 2 + headerHeight / 2,
      r: 5, fill: isRunning ? '#00d2b4' : isFailed ? '#f43f5e' : '#64748b'
    }));

    // 标题文本
    g.append(svgEl('text', {
      x: -cardWidth / 2 + 30, y: -cardHeight / 2 + headerHeight / 2 + 4,
      class: 'cmn-title'
    }, title.length > 13 ? title.slice(0, 12) + '…' : title));

    // 运行环境标签
    const runtimeVal = typeof prog.runtime === 'string' ? prog.runtime : (typeof prog.module?.runtime === 'string' ? prog.module.runtime : '');
    const runtimeText = runtimeVal.toLowerCase().includes('python') ? 'Python' : 'Node.js';
    g.append(svgEl('text', {
      x: cardWidth / 2 - 14, y: -cardHeight / 2 + headerHeight / 2 + 4,
      fill: 'var(--muted)', 'font-size': '10px', 'text-anchor': 'end'
    }, runtimeText));

    // 通道统计
    const channels = this.extractProgramChannels(prog);
    const pubCount = channels.publish.length;
    const subCount = channels.subscribe.length;

    // 通道摘要信息
    const infoY = -cardHeight / 2 + headerHeight + 24;
    g.append(
      svgEl('text', {
        x: -cardWidth / 2 + 16, y: infoY,
        fill: 'var(--ink-dim)', 'font-size': '11px', 'font-weight': '600'
      }, t('📡 通信端口: {pub} 发布 / {sub} 订阅', { pub: pubCount, sub: subCount })),
      svgEl('text', {
        x: -cardWidth / 2 + 16, y: infoY + 20,
        fill: 'var(--muted)', 'font-size': '10px'
      }, t('模块 ID: {id}', { id: prog.programId }))
    );

    // 底部核心操作按键：🎯 点击设为待接线主体
    const btnY = cardHeight / 2 - 24;
    const selectBtn = svgEl('g', {
      class: 'cmn-select-core-btn',
      transform: `translate(0, ${btnY})`
    });
    selectBtn.append(
      svgEl('rect', {
        x: -cardWidth / 2 + 14, y: -12,
        width: cardWidth - 28, height: 26,
        rx: 6, fill: 'rgba(56, 189, 248, 0.18)', stroke: '#38bdf8', 'stroke-width': '1'
      }),
      svgEl('text', {
        x: 0, y: 4, fill: '#38bdf8', 'font-size': '11px', 'font-weight': '800', 'text-anchor': 'middle'
      }, t('🎯 点击选择此模块进行接线'))
    );
    g.append(selectBtn);

    // 点击整张卡片任意位置即可聚焦
    g.addEventListener('click', e => {
      e.stopPropagation();
      this.focusedWiringModuleId = prog.programId;
      this.updateWiringFocusPills();
      this.updateGroupActionButtons();
      this.render();
      canvasToast(() => (t('已选择接线对象: {title}，正在匹配兼容伙伴...', { title })), 'neutral');
    });

    return g;
  }

  createFocusedWiringCard(prog, pos) {
    const isSelected = this.selectedModuleId === prog.programId;
    const isRunning = prog.state === 'running';
    const isFailed = prog.state === 'failed';
    const title = localizedText(prog.title, prog.module?.id || prog.programId);

    const g = svgEl('g', {
      class: `cmn-node wiring-focus${isSelected ? ' selected' : ''}`,
      id: `cmn-${prog.programId}`,
      transform: `translate(${pos.x}, ${pos.y})`
    });

    let pubCount = 0, subCount = 0;
    for (const perms of Object.values(prog.bridges || {})) {
      pubCount += (perms.publish || []).length;
      subCount += (perms.subscribe || []).length;
    }
    const maxPins = Math.max(pubCount, subCount, 1);
    const cardWidth = 320;
    const headerHeight = 40;
    const pinRowHeight = 28;
    const cardHeight = Math.max(160, headerHeight + 24 + maxPins * pinRowHeight + 36);

    // 卡片背景
    g.append(svgEl('rect', {
      x: -cardWidth / 2, y: -cardHeight / 2,
      width: cardWidth, height: cardHeight,
      class: 'cmn-card-bg'
    }));

    // 头部区域
    const headerBg = svgEl('rect', {
      x: -cardWidth / 2, y: -cardHeight / 2,
      width: cardWidth, height: headerHeight,
      class: 'cmn-header-bg'
    });
    headerBg.addEventListener('mousedown', e => this.startDragNode(e, prog.programId));
    g.append(headerBg);

    // 状态指示灯
    g.append(svgEl('circle', {
      cx: -cardWidth / 2 + 18, cy: -cardHeight / 2 + headerHeight / 2,
      r: 5, fill: isRunning ? '#00d2b4' : isFailed ? '#f43f5e' : '#64748b'
    }));

    // 标题
    g.append(svgEl('text', {
      x: -cardWidth / 2 + 30, y: -cardHeight / 2 + headerHeight / 2 + 4,
      class: 'cmn-title'
    }, title.length > 13 ? title.slice(0, 12) + '…' : title));

    // 当前接线对象徽章
    const badgeG = svgEl('g', { transform: `translate(${cardWidth / 2 - 104}, ${-cardHeight / 2 + 10})` });
    badgeG.append(
      svgEl('rect', {
        x: 0, y: 0, width: 94, height: 20, rx: 10,
        fill: 'rgba(56, 189, 248, 0.2)', stroke: '#38bdf8', 'stroke-width': '1'
      }),
      svgEl('text', {
        x: 47, y: 14, fill: '#38bdf8',
        'font-size': '10px', 'font-weight': '800', 'text-anchor': 'middle'
      }, t('🎯 当前接线对象'))
    );
    g.append(badgeG);

    // 渲染引脚
    const bridges = prog.bridges || {};
    let pubPinY = -cardHeight / 2 + headerHeight + 18;
    for (const [slot, perms] of Object.entries(bridges)) {
      for (const alias of perms.publish || []) {
        const topic = prog.topics?.[alias] || alias;
        const isWired = (this.data.wiring?.wires || []).some(w => w.from.programId === prog.programId && w.from.alias === alias);
        const isExternal = !isWired && topic && !topic.includes('unwired');
        const pinG = svgEl('g', {
          class: `cmn-pin pin-output${isWired ? ' is-wired' : isExternal ? ' is-external' : ' is-unwired'}`,
          transform: `translate(${cardWidth / 2}, ${pubPinY})`
        });
        const subtext = isExternal ? `🌐 ${topic.length > 15 ? topic.slice(0, 13) + '…' : topic}` : (topic.length > 18 ? topic.slice(0, 16) + '…' : topic);
        const subtextFill = isWired ? 'var(--teal)' : isExternal ? '#c084fc' : 'var(--muted)';
        const socketFill = isWired ? '#00d2b4' : isExternal ? 'rgba(192, 132, 252, 0.25)' : '#0d1522';
        const socketStroke = isWired ? '#00d2b4' : isExternal ? '#c084fc' : 'var(--muted)';
        const pinTitle = isWired
          ? t('✓ 已接线输出通道 [{alias}] ➔ 主题 [{topic}]', { alias, topic })
          : isExternal
          ? t('🌐 外部总线通道: 此端口正广播到外部总线主题 [{topic}]，无需本地模块对接，可直接与外部系统通信', { topic })
          : t('⚪ 未接线端口 [{alias}]', { alias });
        setCanvasAttribute(pinG, 'title', () => (pinTitle));

        pinG.append(
          svgEl('rect', { x: -cardWidth / 2 + 10, y: -pinRowHeight / 2 + 2, width: cardWidth / 2 - 10, height: pinRowHeight - 4, class: 'pin-row-bg' }),
          svgEl('text', { x: -16, y: -2, 'text-anchor': 'end', class: 'pin-alias-text' }, alias),
          svgEl('text', { x: -16, y: 9, 'text-anchor': 'end', class: 'pin-topic-subtext', fill: subtextFill, opacity: '0.85' }, subtext),
          svgEl('circle', { cx: 0, cy: 0, r: 6, class: 'pin-socket-circle', fill: socketFill, stroke: socketStroke, 'stroke-width': isWired ? '2' : '1.5' })
        );
        pinG.dataset.programId = prog.programId;
        pinG.dataset.alias = alias;
        pinG.dataset.slot = slot;
        pinG.dataset.direction = 'publish';
        pinG.dataset.topic = topic;
        g.append(pinG);
        pubPinY += pinRowHeight;
      }
    }

    let subPinY = -cardHeight / 2 + headerHeight + 18;
    for (const [slot, perms] of Object.entries(bridges)) {
      for (const alias of perms.subscribe || []) {
        const topic = prog.topics?.[alias] || alias;
        const isWired = (this.data.wiring?.wires || []).some(w => w.to.programId === prog.programId && w.to.alias === alias);
        const isExternal = !isWired && topic && !topic.includes('unwired');
        const pinG = svgEl('g', {
          class: `cmn-pin pin-input${isWired ? ' is-wired' : isExternal ? ' is-external' : ' is-unwired'}`,
          transform: `translate(${-cardWidth / 2}, ${subPinY})`
        });
        const subtext = isExternal ? `🌐 ${topic.length > 15 ? topic.slice(0, 13) + '…' : topic}` : (topic.length > 18 ? topic.slice(0, 16) + '…' : topic);
        const subtextFill = isWired ? 'var(--blue)' : isExternal ? '#c084fc' : 'var(--muted)';
        const socketFill = isWired ? '#38bdf8' : isExternal ? 'rgba(192, 132, 252, 0.25)' : '#0d1522';
        const socketStroke = isWired ? '#38bdf8' : isExternal ? '#c084fc' : 'var(--muted)';
        const pinTitle = isWired
          ? t('✓ 已接线输入通道 [{alias}] ➔ 主题 [{topic}]', { alias, topic })
          : isExternal
          ? t('🌐 外部总线通道: 此端口正监听外部总线主题 [{topic}]，无需本地模块对接，可直接接收外部系统消息', { topic })
          : t('⚪ 未接线端口 [{alias}]', { alias });
        setCanvasAttribute(pinG, 'title', () => (pinTitle));

        pinG.append(
          svgEl('rect', { x: 0, y: -pinRowHeight / 2 + 2, width: cardWidth / 2 - 10, height: pinRowHeight - 4, class: 'pin-row-bg' }),
          svgEl('text', { x: 16, y: -2, 'text-anchor': 'start', class: 'pin-alias-text' }, alias),
          svgEl('text', { x: 16, y: 9, 'text-anchor': 'start', class: 'pin-topic-subtext', fill: subtextFill, opacity: '0.85' }, subtext),
          svgEl('circle', { cx: 0, cy: 0, r: 6, class: 'pin-socket-circle', fill: socketFill, stroke: socketStroke, 'stroke-width': isWired ? '2' : '1.5' })
        );
        pinG.dataset.programId = prog.programId;
        pinG.dataset.alias = alias;
        pinG.dataset.slot = slot;
        pinG.dataset.direction = 'subscribe';
        pinG.dataset.topic = topic;
        g.append(pinG);
        subPinY += pinRowHeight;
      }
    }

    // 卡片底部操作按键：返回全部模块概览
    const resetG = svgEl('g', {
      transform: `translate(0, ${cardHeight / 2 - 20})`,
      style: 'cursor:pointer;'
    });
    resetG.append(
      svgEl('rect', {
        x: -cardWidth / 2 + 16, y: -11, width: cardWidth - 32, height: 22,
        rx: 5, fill: 'rgba(244, 63, 94, 0.15)', stroke: 'rgba(244, 63, 94, 0.45)', 'stroke-width': '1'
      }),
      svgEl('text', {
        x: 0, y: 4, fill: '#f43f5e', 'font-size': '10px', 'font-weight': '700', 'text-anchor': 'middle'
      }, t('✕ 取消聚焦 / 返回全部模块概览'))
    );
    resetG.addEventListener('click', e => {
      e.stopPropagation();
      this.focusedWiringModuleId = null;
      this.updateWiringFocusPills();
      this.render();
      canvasToast(() => (t('已返回全景模块概览')), 'neutral');
    });
    g.append(resetG);

    g.addEventListener('click', e => {
      e.stopPropagation();
      this.selectModule(prog.programId);
    });

    return g;
  }

  createPartnerWiringCard(focusProg, partnerProg, pairs, pos) {
    const isSelected = this.selectedModuleId === partnerProg.programId;
    const isRunning = partnerProg.state === 'running';
    const isFailed = partnerProg.state === 'failed';
    const title = localizedText(partnerProg.title, partnerProg.module?.id || partnerProg.programId);

    const g = svgEl('g', {
      class: `cmn-node wiring-partner${isSelected ? ' selected' : ''}`,
      id: `cmn-${partnerProg.programId}`,
      transform: `translate(${pos.x}, ${pos.y})`
    });

    let pubCount = 0, subCount = 0;
    for (const perms of Object.values(partnerProg.bridges || {})) {
      pubCount += (perms.publish || []).length;
      subCount += (perms.subscribe || []).length;
    }
    const maxPins = Math.max(pubCount, subCount, 1);
    const cardWidth = 320;
    const headerHeight = 40;
    const pinRowHeight = 28;
    const actionsHeight = pairs.length * 34;
    const cardHeight = Math.max(140, headerHeight + 16 + maxPins * pinRowHeight + actionsHeight + 12);

    // 卡片背景
    g.append(svgEl('rect', {
      x: -cardWidth / 2, y: -cardHeight / 2,
      width: cardWidth, height: cardHeight,
      class: 'cmn-wiring-partner-bg'
    }));

    // 头部区域
    const headerBg = svgEl('rect', {
      x: -cardWidth / 2, y: -cardHeight / 2,
      width: cardWidth, height: headerHeight,
      fill: 'rgba(56, 189, 248, 0.08)', rx: 12
    });
    headerBg.addEventListener('mousedown', e => this.startDragNode(e, partnerProg.programId));
    g.append(headerBg);

    // 状态指示灯
    g.append(svgEl('circle', {
      cx: -cardWidth / 2 + 18, cy: -cardHeight / 2 + headerHeight / 2,
      r: 5, fill: isRunning ? '#00d2b4' : isFailed ? '#f43f5e' : '#64748b'
    }));

    // 标题
    g.append(svgEl('text', {
      x: -cardWidth / 2 + 30, y: -cardHeight / 2 + headerHeight / 2 + 4,
      class: 'cmn-title'
    }, title.length > 11 ? title.slice(0, 10) + '…' : title));

    // 快捷切换聚焦按钮
    const switchBtn = svgEl('g', {
      transform: `translate(${cardWidth / 2 - 104}, ${-cardHeight / 2 + 10})`,
      style: 'cursor:pointer;'
    });
    switchBtn.append(
      svgEl('rect', {
        x: 0, y: 0, width: 94, height: 20, rx: 10,
        fill: 'rgba(255,255,255,0.06)', stroke: 'rgba(255,255,255,0.18)', 'stroke-width': '1'
      }),
      svgEl('text', {
        x: 47, y: 14, fill: '#fff',
        'font-size': '10px', 'font-weight': '700', 'text-anchor': 'middle'
      }, t('🎯 切为接线对象'))
    );
    switchBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.focusedWiringModuleId = partnerProg.programId;
      this.updateWiringFocusPills();
      this.updateGroupActionButtons();
      this.render();
      canvasToast(() => (t('已将接线对象切换为: {title}', { title })), 'neutral');
    });
    g.append(switchBtn);

    // 引脚渲染 (左右两端)
    const bridges = partnerProg.bridges || {};
    let pubPinY = -cardHeight / 2 + headerHeight + 18;
    for (const [slot, perms] of Object.entries(bridges)) {
      for (const alias of perms.publish || []) {
        const topic = partnerProg.topics?.[alias] || alias;
        const isWired = (this.data.wiring?.wires || []).some(w => w.from.programId === partnerProg.programId && w.from.alias === alias);
        const isExternal = !isWired && topic && !topic.includes('unwired');
        const pinG = svgEl('g', {
          class: `cmn-pin pin-output${isWired ? ' is-wired' : isExternal ? ' is-external' : ' is-unwired'}`,
          transform: `translate(${cardWidth / 2}, ${pubPinY})`
        });
        const subtext = isExternal ? `🌐 ${topic.length > 15 ? topic.slice(0, 13) + '…' : topic}` : (topic.length > 18 ? topic.slice(0, 16) + '…' : topic);
        const subtextFill = isWired ? 'var(--teal)' : isExternal ? '#c084fc' : 'var(--muted)';
        const socketFill = isWired ? '#00d2b4' : isExternal ? 'rgba(192, 132, 252, 0.25)' : '#0d1522';
        const socketStroke = isWired ? '#00d2b4' : isExternal ? '#c084fc' : 'var(--muted)';
        const pinTitle = isWired
          ? t('✓ 已接线输出通道 [{alias}] ➔ 主题 [{topic}]', { alias, topic })
          : isExternal
          ? t('🌐 外部总线通道: 此端口正广播到外部总线主题 [{topic}]，无需本地模块对接，可直接与外部系统通信', { topic })
          : t('⚪ 未接线端口 [{alias}]', { alias });
        setCanvasAttribute(pinG, 'title', () => (pinTitle));

        pinG.append(
          svgEl('rect', { x: -cardWidth / 2 + 10, y: -pinRowHeight / 2 + 2, width: cardWidth / 2 - 10, height: pinRowHeight - 4, class: 'pin-row-bg' }),
          svgEl('text', { x: -16, y: -2, 'text-anchor': 'end', class: 'pin-alias-text' }, alias),
          svgEl('text', { x: -16, y: 9, 'text-anchor': 'end', class: 'pin-topic-subtext', fill: subtextFill, opacity: '0.85' }, subtext),
          svgEl('circle', { cx: 0, cy: 0, r: 6, class: 'pin-socket-circle', fill: socketFill, stroke: socketStroke, 'stroke-width': isWired ? '2' : '1.5' })
        );
        pinG.dataset.programId = partnerProg.programId;
        pinG.dataset.alias = alias;
        pinG.dataset.slot = slot;
        pinG.dataset.direction = 'publish';
        pinG.dataset.topic = topic;
        g.append(pinG);
        pubPinY += pinRowHeight;
      }
    }

    let subPinY = -cardHeight / 2 + headerHeight + 18;
    for (const [slot, perms] of Object.entries(bridges)) {
      for (const alias of perms.subscribe || []) {
        const topic = partnerProg.topics?.[alias] || alias;
        const isWired = (this.data.wiring?.wires || []).some(w => w.to.programId === partnerProg.programId && w.to.alias === alias);
        const isExternal = !isWired && topic && !topic.includes('unwired');
        const pinG = svgEl('g', {
          class: `cmn-pin pin-input${isWired ? ' is-wired' : isExternal ? ' is-external' : ' is-unwired'}`,
          transform: `translate(${-cardWidth / 2}, ${subPinY})`
        });
        const subtext = isExternal ? `🌐 ${topic.length > 15 ? topic.slice(0, 13) + '…' : topic}` : (topic.length > 18 ? topic.slice(0, 16) + '…' : topic);
        const subtextFill = isWired ? 'var(--blue)' : isExternal ? '#c084fc' : 'var(--muted)';
        const socketFill = isWired ? '#38bdf8' : isExternal ? 'rgba(192, 132, 252, 0.25)' : '#0d1522';
        const socketStroke = isWired ? '#38bdf8' : isExternal ? '#c084fc' : 'var(--muted)';
        const pinTitle = isWired
          ? t('✓ 已接线输入通道 [{alias}] ➔ 主题 [{topic}]', { alias, topic })
          : isExternal
          ? t('🌐 外部总线通道: 此端口正监听外部总线主题 [{topic}]，无需本地模块对接，可直接接收外部系统消息', { topic })
          : t('⚪ 未接线端口 [{alias}]', { alias });
        setCanvasAttribute(pinG, 'title', () => (pinTitle));

        pinG.append(
          svgEl('rect', { x: 0, y: -pinRowHeight / 2 + 2, width: cardWidth / 2 - 10, height: pinRowHeight - 4, class: 'pin-row-bg' }),
          svgEl('text', { x: 16, y: -2, 'text-anchor': 'start', class: 'pin-alias-text' }, alias),
          svgEl('text', { x: 16, y: 9, 'text-anchor': 'start', class: 'pin-topic-subtext', fill: subtextFill, opacity: '0.85' }, subtext),
          svgEl('circle', { cx: 0, cy: 0, r: 6, class: 'pin-socket-circle', fill: socketFill, stroke: socketStroke, 'stroke-width': isWired ? '2' : '1.5' })
        );
        pinG.dataset.programId = partnerProg.programId;
        pinG.dataset.alias = alias;
        pinG.dataset.slot = slot;
        pinG.dataset.direction = 'subscribe';
        pinG.dataset.topic = topic;
        g.append(pinG);
        subPinY += pinRowHeight;
      }
    }

    // 核心特征：卡片中直接渲染一键对接按钮区！用户直接点击此按键对接，无需拉线！
    const maxPinY = Math.max(pubPinY, subPinY);
    let actionY = maxPinY + 8;

    pairs.forEach(pair => {
      const isWired = pair.status === 'wired';
      const isBi = Boolean(pair.isBidirectional);
      const isFocusToPartner = pair.dir === 'focus-to-partner';
      const focusZh = localizedText(focusProg.title, focusProg.programId);
      const partnerZh = localizedText(partnerProg.title, partnerProg.programId);
      const cat = this.getChannelCategory(pair.topic);

      let rolePrefix, fullLabel, shortLabel;
      if (isBi) {
        rolePrefix = `${cat.icon} ${t('双向互联')}`;
        fullLabel = `[${cat.label}] ${focusZh}.${pair.alias} ⇄ ${partnerZh}.${pair.partnerAlias}`;
        shortLabel = `${focusZh}.${pair.alias} ⇄ ${pair.partnerAlias}`;
      } else {
        rolePrefix = isFocusToPartner ? `${cat.icon} ${t('供应')}` : `${cat.icon} ${t('回传')}`;
        fullLabel = isFocusToPartner
          ? `[${cat.label}] ${focusZh}.${pair.from.alias}(${t('出')}) ➔ ${partnerZh}.${pair.to.alias}(${t('入')})`
          : `[${cat.label}] ${partnerZh}.${pair.from.alias}(${t('出')}) ➔ ${focusZh}.${pair.to.alias}(${t('入')})`;
        shortLabel = isFocusToPartner
          ? `${focusZh}.${pair.from.alias}(${t('出')}) ➔ ${pair.to.alias}(${t('入')})`
          : `${partnerZh}.${pair.from.alias}(${t('出')}) ➔ ${pair.to.alias}(${t('入')})`;
      }
      const displayLabel = shortLabel.length > 21 ? shortLabel.slice(0, 20) + '…' : shortLabel;

      const rowG = svgEl('g', { transform: `translate(0, ${actionY})` });

      if (isWired) {
        // 已连线状态胶囊 + 断开按钮
        const badgeG = svgEl('g', {
          class: `cmn-connected-badge cat-${cat.kind}${isBi ? ' bidirectional' : ''}`,
          transform: 'translate(-16, 0)'
        });
        setCanvasAttribute(badgeG, 'title', () => (t('已建立接线通道: {label} (主题: {topic})', { label: fullLabel, topic: pair.topic })));
        badgeG.append(
          svgEl('rect', { x: -cardWidth / 2 + 24, y: -11, width: cardWidth - 68, height: 22 }),
          svgEl('text', { x: 0, y: 4 }, `✓ [${cat.label.slice(0, 2)}] ${isBi ? t('双向已通') : rolePrefix + t('已通')}: ${displayLabel}`)
        );

        // ✕ 断开按钮
        const delBtn = svgEl('g', {
          transform: `translate(${cardWidth / 2 - 34}, 0)`,
          style: 'cursor:pointer;'
        });
        delBtn.append(
          svgEl('rect', { x: 0, y: -10, width: 20, height: 20, rx: 4, fill: 'rgba(244,63,94,0.18)', stroke: '#f43f5e', 'stroke-width': '1' }),
          svgEl('text', { x: 10, y: 4, fill: '#f43f5e', 'font-size': '11px', 'font-weight': '900', 'text-anchor': 'middle' }, '✕')
        );
        delBtn.addEventListener('click', async e => {
          e.stopPropagation();
          e.preventDefault();
          let toDisconnect = [];
          if (isBi) {
            if (pair.wires?.length) toDisconnect.push(...pair.wires);
            const byTopic = (this.data.wiring?.wires || []).filter(w => w.topic === pair.topic);
            toDisconnect.push(...byTopic);
            toDisconnect.push(
              { from: { programId: focusProg.programId, alias: pair.alias }, to: { programId: partnerProg.programId, alias: pair.partnerAlias }, topic: pair.topic },
              { from: { programId: partnerProg.programId, alias: pair.partnerAlias }, to: { programId: focusProg.programId, alias: pair.alias }, topic: pair.topic }
            );
          } else {
            toDisconnect = pair.wire ? [pair.wire] : [
              { from: { programId: pair.from?.programId || focusProg.programId, alias: pair.from?.alias },
                to: { programId: pair.to?.programId || partnerProg.programId, alias: pair.to?.alias },
                topic: pair.topic }
            ];
          }
          await this.disconnectWires(toDisconnect);
        });

        rowG.append(badgeG, delBtn);
      } else {
        // 未连线状态：直接点击一键对接！
        const connectBtn = svgEl('g', {
          class: `cmn-connect-btn${isBi ? ' bidirectional' : ''}`,
          style: 'cursor:pointer;'
        });
        setCanvasAttribute(connectBtn, 'title', () => (isBi
          ? t('点击建立全双工双向电缆互联 (蓝色): {label}', { label: fullLabel })
          : t('点击建立{type}: {label}', { type: isFocusToPartner ? t('单向供应连线 (绿色)') : t('反向应答通道'), label: fullLabel })));
        connectBtn.append(
          svgEl('rect', { x: -cardWidth / 2 + 16, y: -12, width: cardWidth - 32, height: 24 }),
          svgEl('text', { x: 0, y: 4 }, `${isBi ? t('⚡ 一键双向对接') : '⚡ ' + rolePrefix}: ${displayLabel}`)
        );
        connectBtn.addEventListener('click', async e => {
          e.stopPropagation();
          if (isBi) {
            await this.connectWiring(
              { programId: focusProg.programId, slot: pair.forward.from.slot, alias: pair.forward.from.alias, topic: pair.topic },
              { programId: partnerProg.programId, slot: pair.forward.to.slot, alias: pair.forward.to.alias, topic: pair.topic },
              pair.topic
            );
          } else if (isFocusToPartner) {
            await this.connectWiring(
              { programId: focusProg.programId, slot: pair.from.slot, alias: pair.from.alias, topic: pair.topic },
              { programId: partnerProg.programId, slot: pair.to.slot, alias: pair.to.alias, topic: pair.topic },
              pair.topic
            );
          } else {
            await this.connectWiring(
              { programId: partnerProg.programId, slot: pair.from.slot, alias: pair.from.alias, topic: pair.topic },
              { programId: focusProg.programId, slot: pair.to.slot, alias: pair.to.alias, topic: pair.topic },
              pair.topic
            );
          }
        });
        rowG.append(connectBtn);
      }

      g.append(rowG);
      actionY += 30;
    });

    g.addEventListener('click', async () => {
      this.selectModule(partnerProg.programId);
      const unwiredPairs = pairs.filter(p => p.status !== 'wired');
      if (pairs.length === 1 && unwiredPairs.length === 1) {
        const pair = unwiredPairs[0];
        const isFocusToPartner = pair.dir === 'focus-to-partner';
        if (isFocusToPartner) {
          await this.connectWiring(
            { programId: focusProg.programId, slot: pair.from.slot, alias: pair.from.alias, topic: pair.topic },
            { programId: partnerProg.programId, slot: pair.to.slot, alias: pair.to.alias, topic: pair.topic },
            pair.topic
          );
        } else {
          await this.connectWiring(
            { programId: partnerProg.programId, slot: pair.from.slot, alias: pair.from.alias, topic: pair.topic },
            { programId: focusProg.programId, slot: pair.to.slot, alias: pair.to.alias, topic: pair.topic },
            pair.topic
          );
        }
      }
    });
    return g;
  }

  createEmptyPartnerGuideCard(focusProg, pos) {
    const cardWidth = 340;
    const cardHeight = 160;
    const title = localizedText(focusProg.title, focusProg.module?.id || focusProg.programId);

    // 检查该模块是否具有活跃的边界接口或共享主题通道
    let boundaryCount = 0;
    for (const perms of Object.values(focusProg.bridges || {})) {
      for (const alias of [...(perms.publish || []), ...(perms.subscribe || [])]) {
        const topic = focusProg.topics?.[alias] || alias;
        const cat = this.getChannelCategory(topic);
        if (cat.kind === 'boundary' || cat.kind === 'external') boundaryCount++;
      }
    }
    const isBoundaryDominated = boundaryCount > 0;

    const g = svgEl('g', {
      class: 'cmn-node empty-guide',
      transform: `translate(${pos.x}, ${pos.y})`
    });

    g.append(svgEl('rect', {
      x: -cardWidth / 2, y: -cardHeight / 2,
      width: cardWidth, height: cardHeight, rx: 12,
      fill: isBoundaryDominated ? 'rgba(28, 16, 48, 0.85)' : 'rgba(10, 24, 42, 0.75)',
      stroke: isBoundaryDominated ? 'rgba(192, 132, 252, 0.45)' : 'rgba(56, 189, 248, 0.35)',
      'stroke-width': '1.5', 'stroke-dasharray': '5 4'
    }));

    g.append(svgEl('text', {
      x: 0, y: -cardHeight / 2 + 34,
      fill: isBoundaryDominated ? '#c084fc' : '#38bdf8',
      'font-size': '13px', 'font-weight': '800', 'text-anchor': 'middle'
    }, isBoundaryDominated ? t('🌐 边界接口模式 · 暂无内部专线') : t('ℹ️ 暂无重合匹配伙伴')));

    g.append(svgEl('text', {
      x: 0, y: -cardHeight / 2 + 62,
      fill: 'var(--muted)', 'font-size': '11px', 'text-anchor': 'middle'
    }, isBoundaryDominated
      ? t('模块 [{title}] 端口正作为【边界接口】连接外部总线。', { title })
      : t('模块 [{title}] 暂无与其同名或兼容通道的伙伴。', { title })
    ));

    g.append(svgEl('text', {
      x: 0, y: -cardHeight / 2 + 82,
      fill: isBoundaryDominated ? '#e9d5ff' : 'var(--ink-dim)',
      'font-size': '10px', 'font-weight': isBoundaryDominated ? '600' : '400',
      'text-anchor': 'middle'
    }, isBoundaryDominated
      ? t('数据直接与外部系统/授权程序通信；若需内部模块接入可在接线矩阵中建立专线。')
      : t('可打开“接线矩阵”手动跨模块对接，或返回全景概览。')
    ));

    // 两个操作按键
    const btnMatrix = svgEl('g', { transform: 'translate(-70, 30)', style: 'cursor:pointer;' });
    btnMatrix.append(
      svgEl('rect', { x: -60, y: -12, width: 120, height: 24, rx: 12, fill: 'var(--teal-soft)', stroke: 'var(--teal)', 'stroke-width': '1' }),
      svgEl('text', { x: 0, y: 4, fill: 'var(--teal)', 'font-size': '10px', 'font-weight': '700', 'text-anchor': 'middle' }, t('🔌 打开接线矩阵'))
    );
    btnMatrix.addEventListener('click', e => {
      e.stopPropagation();
      this.openWiringMatrixModal();
    });

    const btnNext = svgEl('g', { transform: 'translate(70, 30)', style: 'cursor:pointer;' });
    btnNext.append(
      svgEl('rect', { x: -60, y: -12, width: 120, height: 24, rx: 12, fill: 'rgba(244,63,94,0.18)', stroke: '#f43f5e', 'stroke-width': '1' }),
      svgEl('text', { x: 0, y: 4, fill: '#f43f5e', 'font-size': '10px', 'font-weight': '700', 'text-anchor': 'middle' }, t('✕ 返回全景概览'))
    );
    btnNext.addEventListener('click', e => {
      e.stopPropagation();
      this.focusedWiringModuleId = null;
      this.updateWiringFocusPills();
      this.updateGroupActionButtons();
      this.render();
      canvasToast(() => (t('已返回全景模块概览')), 'neutral');
    });

    g.append(btnMatrix, btnNext);
    return g;
  }

  filteredPrograms() {
    const list = this.data.programs || [];
    if (this.groupFilter === 'all') return list;
    const group = (this.data.groups || []).find(g => g.id === this.groupFilter);
    if (!group) return list;
    const members = new Set(group.memberProgramIds || []);
    return list.filter(p => members.has(p.programId));
  }

  // 10. 模块卡片 DOM 生成
  createModuleCard(prog, pos) {
    const isSelected = this.selectedModuleId === prog.programId;
    const isRunning = prog.state === 'running';
    const isFailed = prog.state === 'failed';
    const title = localizedText(prog.title, prog.module?.id || prog.programId);

    const isOrch = this.mode === 'orchestration';
    const g = svgEl('g', {
      class: `cmn-node${isOrch ? ' orchestration-node' : ''}${isSelected ? ' selected' : ''}${isFailed ? ' is-failed' : ''}`,
      id: `cmn-${prog.programId}`,
      transform: `translate(${pos.x}, ${pos.y})`
    });
    g.dataset.programId = prog.programId;

    let pubCount = 0, subCount = 0;
    for (const perms of Object.values(prog.bridges || {})) {
      pubCount += (perms.publish || []).length;
      subCount += (perms.subscribe || []).length;
    }
    const maxPins = Math.max(pubCount, subCount, 1);
    const cardWidth = 300;
    const headerHeight = 40;
    const pinRowHeight = 28;
    let cardHeight = Math.max(124, headerHeight + 24 + maxPins * pinRowHeight);
    if (this.mode === 'runtime') {
      cardHeight = 144;
    } else if (isOrch) {
      cardHeight = 148;
    }

    // 卡片背景
    g.append(svgEl('rect', {
      x: -cardWidth / 2, y: -cardHeight / 2,
      width: cardWidth, height: cardHeight,
      class: 'cmn-card-bg'
    }));

    // 头部区域 (可拖拽移动卡片)
    const headerBg = svgEl('rect', {
      x: -cardWidth / 2, y: -cardHeight / 2,
      width: cardWidth, height: headerHeight,
      class: 'cmn-header-bg'
    });
    headerBg.addEventListener('mousedown', e => this.startDragNode(e, prog.programId));
    g.append(headerBg);

    // 状态指示灯
    const statusDot = svgEl('circle', {
      cx: -cardWidth / 2 + 18, cy: -cardHeight / 2 + headerHeight / 2,
      r: 5, fill: isRunning ? '#00d2b4' : isFailed ? '#f43f5e' : '#64748b',
      class: 'cmn-status-dot'
    });
    g.append(statusDot);

    // 模块名称
    g.append(svgEl('text', {
      x: -cardWidth / 2 + 30, y: -cardHeight / 2 + headerHeight / 2 + 4,
      class: 'cmn-title'
    }, title));

    // 编排模式下的阶段徽标
    if (isOrch) {
      const stages = this.computeStages();
      const stageNum = stages.get(prog.programId) || 1;
      const badgeG = svgEl('g', {
        transform: `translate(${cardWidth / 2 - 100}, ${-cardHeight / 2 + 10})`,
        class: 'cmn-stage-badge'
      });
      const badgeIcon = isFailed ? '✕' : (stageNum === 1 ? '⚡' : '⏱');
      const badgeFill = isFailed ? 'rgba(244, 63, 94, 0.22)' : 'rgba(245, 158, 11, 0.14)';
      const badgeStroke = isFailed ? '#f43f5e' : 'rgba(245, 158, 11, 0.6)';
      const badgeTextColor = isFailed ? '#f43f5e' : '#fbbf24';
      const badgeLabel = isFailed ? t('✕ 启动失败') : `${badgeIcon} ${t('批次 #{stage}', { stage: stageNum })}`;
      badgeG.append(
        svgEl('rect', { x: 0, y: 0, width: 68, height: 20, rx: 10, fill: badgeFill, stroke: badgeStroke, 'stroke-width': '1.2', class: 'cmn-stage-badge-bg' }),
        svgEl('text', { x: 34, y: 14, class: 'cmn-badge-text', fill: badgeTextColor, 'font-size': '10px' }, badgeLabel)
      );
      g.append(badgeG);
    }

    // 快捷启停按键
    const btnAction = svgEl('g', {
      transform: `translate(${cardWidth / 2 - 20}, ${-cardHeight / 2 + headerHeight / 2})`,
      style: 'cursor:pointer;'
    });
    btnAction.append(
      svgEl('circle', { cx: 0, cy: 0, r: 10, fill: isRunning ? 'var(--red-soft)' : 'var(--teal-soft)' }),
      svgEl('text', { x: 0, y: 3, 'text-anchor': 'middle', 'font-size': '10px', fill: isRunning ? 'var(--red)' : 'var(--teal)' }, isRunning ? '■' : '▶')
    );
    btnAction.addEventListener('click', e => {
      e.stopPropagation();
      if (isRunning) this.stopProgram(prog.programId);
      else this.startProgram(prog.programId);
    });
    g.append(btnAction);

    // 运行监控模式下的实时遥测与数据流概览
    if (this.mode === 'runtime') {
      const infoY = -cardHeight / 2 + headerHeight + 22;
      const statusText = isRunning
        ? t('● 运行中 · PID {pid}', { pid: prog.pid || '—' })
        : (prog.state === 'failed' ? t('✕ 异常退出 · 码 {code}', { code: prog.diagnostics?.exitCode ?? '—' }) : t('○ 已停止'));
      const statusColor = isRunning ? '#00d2b4' : (prog.state === 'failed' ? '#f43f5e' : '#64748b');

      g.append(svgEl('text', {
        x: -cardWidth / 2 + 18, y: infoY,
        fill: statusColor, 'font-size': '11px', 'font-weight': '700',
        class: 'cmn-runtime-status-text'
      }, statusText));

      const startTime = typeof prog.startedAt === 'number' ? prog.startedAt : (typeof prog.startedAt === 'string' ? Date.parse(prog.startedAt) : null);
      const uptimeText = isRunning && startTime && !isNaN(startTime)
        ? t('已运行 {seconds} 秒', { seconds: Math.max(1, Math.round((Date.now() - startTime) / 1000)) })
        : t('未在运行 (就绪)');
      g.append(svgEl('text', {
        x: -cardWidth / 2 + 18, y: infoY + 20,
        fill: 'var(--muted)', 'font-size': '10px'
      }, uptimeText));

      let tY = infoY + 42;
      const pubTopics = Object.values(prog.bridges || {}).flatMap(b => b.publish || []);
      const subTopics = Object.values(prog.bridges || {}).flatMap(b => b.subscribe || []);
      if (pubTopics.length) {
        const txt = `${t('▲ 发送:')} ${pubTopics.join(', ')}`;
        g.append(svgEl('text', { x: -cardWidth / 2 + 18, y: tY, fill: 'var(--teal)', 'font-size': '9px' }, txt.length > 32 ? txt.slice(0, 30) + '…' : txt));
        tY += 16;
      }
      if (subTopics.length) {
        const txt = `${t('▼ 接收:')} ${subTopics.join(', ')}`;
        g.append(svgEl('text', { x: -cardWidth / 2 + 18, y: tY, fill: 'var(--blue)', 'font-size': '9px' }, txt.length > 32 ? txt.slice(0, 30) + '…' : txt));
      }
    }

    // 接线模式下的引脚
    if (this.mode === 'wiring') {
      const pinRowHeight = 28;
      let pubPinY = -cardHeight / 2 + headerHeight + 18;
      const bridges = prog.bridges || {};

      for (const [slot, perms] of Object.entries(bridges)) {
        // 输出引脚 (Publish - 右侧)
        for (const alias of perms.publish || []) {
          const topic = prog.topics?.[alias] || alias;
          const isWired = (this.data.wiring?.wires || []).some(w => w.from.programId === prog.programId && w.from.alias === alias);
          const pinG = svgEl('g', {
            class: `cmn-pin pin-output${isWired ? ' is-wired' : ' is-unwired'}`,
            transform: `translate(${cardWidth / 2}, ${pubPinY})`
          });

          pinG.append(svgEl('rect', {
            x: -cardWidth / 2 + 10, y: -pinRowHeight / 2 + 2,
            width: cardWidth / 2 - 10, height: pinRowHeight - 4,
            class: 'pin-row-bg'
          }));

          pinG.append(svgEl('text', {
            x: -16, y: -2, 'text-anchor': 'end', class: 'pin-alias-text'
          }, alias));

          const subTopicStr = topic.length > 18 ? topic.slice(0, 16) + '…' : topic;
          pinG.append(svgEl('text', {
            x: -16, y: 9, 'text-anchor': 'end', class: 'pin-topic-subtext',
            fill: isWired ? 'var(--teal)' : 'var(--muted)', opacity: '0.85'
          }, subTopicStr));

          pinG.append(svgEl('circle', {
            cx: 0, cy: 0, r: 6,
            class: 'pin-socket-circle',
            fill: isWired ? '#00d2b4' : '#0d1522',
            stroke: '#00d2b4',
            'stroke-width': isWired ? '2' : '1.5',
            'stroke-dasharray': isWired ? 'none' : '3 2'
          }));

          pinG.dataset.programId = prog.programId;
          pinG.dataset.alias = alias;
          pinG.dataset.slot = slot;
          pinG.dataset.direction = 'publish';
          pinG.dataset.topic = topic;
          g.append(pinG);
          pubPinY += pinRowHeight;
        }

        // 输入引脚 (Subscribe - 左侧)
        let subPinY = -cardHeight / 2 + headerHeight + 18;
        for (const alias of perms.subscribe || []) {
          const topic = prog.topics?.[alias] || alias;
          const isWired = (this.data.wiring?.wires || []).some(w => w.to.programId === prog.programId && w.to.alias === alias);
          const pinG = svgEl('g', {
            class: `cmn-pin pin-input${isWired ? ' is-wired' : ' is-unwired'}`,
            transform: `translate(${-cardWidth / 2}, ${subPinY})`
          });

          pinG.append(svgEl('rect', {
            x: 0, y: -pinRowHeight / 2 + 2,
            width: cardWidth / 2 - 10, height: pinRowHeight - 4,
            class: 'pin-row-bg'
          }));

          pinG.append(svgEl('text', {
            x: 16, y: -2, 'text-anchor': 'start', class: 'pin-alias-text'
          }, alias));

          const subTopicStr = topic.length > 18 ? topic.slice(0, 16) + '…' : topic;
          pinG.append(svgEl('text', {
            x: 16, y: 9, 'text-anchor': 'start', class: 'pin-topic-subtext',
            fill: isWired ? 'var(--blue)' : 'var(--muted)', opacity: '0.85'
          }, subTopicStr));

          pinG.append(svgEl('circle', {
            cx: 0, cy: 0, r: 6,
            class: 'pin-socket-circle',
            fill: isWired ? '#38bdf8' : '#0d1522',
            stroke: '#38bdf8',
            'stroke-width': isWired ? '2' : '1.5',
            'stroke-dasharray': isWired ? 'none' : '3 2'
          }));

          pinG.dataset.programId = prog.programId;
          pinG.dataset.alias = alias;
          pinG.dataset.slot = slot;
          pinG.dataset.direction = 'subscribe';
          pinG.dataset.topic = topic;
          g.append(pinG);
          subPinY += pinRowHeight;
        }
      }
    }

    // 编排模式下的模块依赖流向、阶段与触发端子
    if (isOrch) {
      const stages = this.computeStages();
      const stageNum = stages.get(prog.programId) || 1;
      const planMembers = this.getActivePlan()?.members || [];
      const member = planMembers.find(m => m.programId === prog.programId);
      const prereqIds = member?.after || [];
      const prereqTitles = prereqIds.map(depId => {
        const p = (this.data.programs || []).find(x => x.programId === depId);
        return p ? (localizedText(p.title, depId)) : depId;
      });
      const successorProgs = planMembers.filter(m => (m.after || []).includes(prog.programId)).map(m => {
        const p = (this.data.programs || []).find(x => x.programId === m.programId);
        return p ? (localizedText(p.title, m.programId)) : m.programId;
      });

      // 顶部区域分隔线
      g.append(svgEl('line', {
        x1: -cardWidth / 2 + 14, y1: -cardHeight / 2 + headerHeight,
        x2: cardWidth / 2 - 14, y2: -cardHeight / 2 + headerHeight,
        stroke: 'rgba(255, 255, 255, 0.08)', 'stroke-width': '1'
      }));

      // 阶段与就绪状态行
      const stageDesc = prog.executionPolicy?.mode === 'on-demand' ? t('按需唤醒 · 不随计划启动')
        : member?.enabled !== true ? t('未加入常驻启动计划')
        : isFailed
        ? t('✕ 模块异常退出 · 启动失败')
        : (stageNum === 1
          ? t('⚡ 首批启动 · 独立并发就绪')
          : t('⏱ 第 {stage} 批次 · 需等待前置模块就绪', { stage: stageNum }));
      const stageColor = isFailed ? '#f43f5e' : (stageNum === 1 ? '#00d2b4' : '#fbbf24');
      g.append(
        svgEl('circle', { cx: -cardWidth / 2 + 22, cy: -cardHeight / 2 + headerHeight + 15, r: 3, fill: stageColor, class: 'cmn-stage-desc-dot' }),
        svgEl('text', {
          x: -cardWidth / 2 + 32, y: -cardHeight / 2 + headerHeight + 18,
          fill: stageColor, 'font-size': '10px', 'font-weight': '700',
          class: 'cmn-stage-desc'
        }, this.executionText(stageDesc))
      );

      // 前置依赖标签条
      const prereqY = -cardHeight / 2 + headerHeight + 28;
      const prereqBox = svgEl('g', { transform: `translate(${-cardWidth / 2 + 16}, ${prereqY})` });
      prereqBox.append(
        svgEl('rect', {
          x: 0, y: 0, width: cardWidth - 32, height: 24, rx: 6,
          fill: prereqTitles.length ? 'rgba(245, 158, 11, 0.06)' : 'rgba(255, 255, 255, 0.02)',
          stroke: prereqTitles.length ? 'rgba(245, 158, 11, 0.28)' : 'rgba(255, 255, 255, 0.06)'
        })
      );
      const rawPrereqTxt = prereqTitles.length ? `${t('◀ 前置:')} ${prereqTitles.join(', ')}` : t('◀ 前置: 无依赖 (独立就绪)');
      const prereqTxt = rawPrereqTxt.length > 28 ? rawPrereqTxt.slice(0, 26) + '…' : rawPrereqTxt;
      prereqBox.append(
        svgEl('text', {
          x: 10, y: 16,
          fill: prereqTitles.length ? '#f59e0b' : 'var(--muted)',
          'font-size': '9.5px', 'font-family': 'var(--mono)'
        }, prereqTxt)
      );
      g.append(prereqBox);

      // 触发下游标签条
      const succY = prereqY + 30;
      const succBox = svgEl('g', { transform: `translate(${-cardWidth / 2 + 16}, ${succY})` });
      succBox.append(
        svgEl('rect', {
          x: 0, y: 0, width: cardWidth - 32, height: 24, rx: 6,
          fill: successorProgs.length ? 'rgba(56, 189, 248, 0.06)' : 'rgba(255, 255, 255, 0.02)',
          stroke: successorProgs.length ? 'rgba(56, 189, 248, 0.28)' : 'rgba(255, 255, 255, 0.06)'
        })
      );
      const rawSuccTxt = successorProgs.length ? `${t('▶ 驱动:')} ${successorProgs.join(', ')}` : t('▶ 驱动: 终端服务 (无后续)');
      const succTxt = rawSuccTxt.length > 28 ? rawSuccTxt.slice(0, 26) + '…' : rawSuccTxt;
      succBox.append(
        svgEl('text', {
          x: 10, y: 16,
          fill: successorProgs.length ? '#38bdf8' : 'var(--muted)',
          'font-size': '9.5px', 'font-family': 'var(--mono)'
        }, succTxt)
      );
      g.append(succBox);

      // 编排模式专属引脚端子 (输入与输出锚点)
      const depAnchorY = 12;
      // 左侧输入锚点：前置依赖接入
      const inAnchor = svgEl('g', {
        class: 'cmn-pin pin-dep pin-dep-in',
        transform: `translate(${-cardWidth / 2}, ${depAnchorY})`
      });
      inAnchor.append(
        svgEl('circle', {
          cx: 0, cy: 0, r: 8,
          class: 'pin-socket-bg',
          fill: prereqTitles.length ? 'rgba(245, 158, 11, 0.25)' : '#0d1522',
          stroke: '#f59e0b',
          'stroke-width': '2'
        }),
        svgEl('circle', {
          cx: 0, cy: 0, r: 3.5,
          fill: prereqTitles.length ? '#fbbf24' : '#64748b'
        })
      );
      inAnchor.dataset.programId = prog.programId;
      setCanvasAttribute(inAnchor, 'title', () => (t('前置依赖输入端口 (接收上游触发)')));
      g.append(inAnchor);

      // 右侧输出锚点：触发后续启动
      const outAnchor = svgEl('g', {
        class: 'cmn-pin pin-dep pin-dep-out',
        transform: `translate(${cardWidth / 2}, ${depAnchorY})`
      });
      outAnchor.append(
        svgEl('circle', {
          cx: 0, cy: 0, r: 8,
          class: 'pin-socket-bg',
          fill: '#f59e0b',
          stroke: '#fff',
          'stroke-width': '1.8'
        }),
        svgEl('polygon', {
          points: '-2,-3.5 3,0 -2,3.5',
          fill: '#0d1522'
        })
      );
      outAnchor.dataset.programId = prog.programId;
      setCanvasAttribute(outAnchor, 'title', () => (t('拖拽连线至目标模块建立启动依赖')));
      outAnchor.addEventListener('mousedown', e => this.startDragDep(e, prog.programId, cardWidth / 2 + pos.x, depAnchorY + pos.y));
      g.append(outAnchor);
    }

    g.append(this.executionPolicyBadge(prog, cardWidth / 2 - 66, -cardHeight / 2 - 19));
    // 点击选择卡片
    g.addEventListener('click', e => {
      e.stopPropagation();
      this.selectModule(prog.programId);
    });

    return g;
  }

  // 11. 引脚精确坐标查询
  findPinCoord(programId, direction, alias) {
    const pos = this.nodePositions.get(programId);
    if (!pos) return null;
    const prog = this.data.programs.find(p => p.programId === programId);
    if (!prog) return null;

    let pubCount = 0, subCount = 0;
    for (const perms of Object.values(prog.bridges || {})) {
      pubCount += (perms.publish || []).length;
      subCount += (perms.subscribe || []).length;
    }
    const maxPins = Math.max(pubCount, subCount, 1);
    const cardWidth = this.mode === 'wiring' ? 320 : 300;
    const headerHeight = 40;
    const pinRowHeight = 28;

    let cardHeight;
    if (this.mode === 'runtime') {
      cardHeight = 144;
    } else if (this.mode === 'wiring') {
      if (!this.focusedWiringModuleId) {
        cardHeight = 160;
      } else if (programId === this.focusedWiringModuleId) {
        cardHeight = Math.max(160, headerHeight + 24 + maxPins * pinRowHeight + 36);
      } else {
        const pairsCount = this.getPairCountForProg(programId);
        cardHeight = Math.max(140, headerHeight + 16 + maxPins * pinRowHeight + pairsCount * 34 + 12);
      }
    } else {
      cardHeight = Math.max(124, headerHeight + 24 + maxPins * pinRowHeight);
    }

    let targetIdx = -1;
    let total = 0;
    for (const perms of Object.values(prog.bridges || {})) {
      const list = direction === 'publish' ? (perms.publish || []) : (perms.subscribe || []);
      const idx = list.indexOf(alias);
      if (idx !== -1) targetIdx = total + idx;
      total += list.length;
    }
    if (targetIdx === -1) targetIdx = 0;

    const pinY = pos.y - cardHeight / 2 + headerHeight + 18 + targetIdx * pinRowHeight;
    const pinX = direction === 'publish' ? pos.x + cardWidth / 2 : pos.x - cardWidth / 2;
    return { x: pinX, y: pinY };
  }

  // 11.5 通信通道分类器 (Scheme C 底层三分类: 专用通道 / 共享主题 / 边界接口)
  getChannelCategory(topic) {
    if (!topic || topic.includes('unwired')) {
      return { kind: 'unwired', label: t('未接线'), icon: '⚪', badge: t('⚪ 未接线'), color: '#64748b', desc: t('未建立通信接线') };
    }
    let providers = (this.data.wiring?.topicProviders?.[topic] || []);
    let consumers = (this.data.wiring?.topicConsumers?.[topic] || []);

    // 乐观更新即时识别：若当前 topicProviders/topicConsumers 尚未由后端同步回来，动态扫描内存中的 programs 端点
    if (!providers.length && !consumers.length) {
      const dynamicPubs = [];
      const dynamicSubs = [];
      (this.data.programs || []).forEach(p => {
        for (const [slot, perms] of Object.entries(p.bridges || {})) {
          for (const alias of perms.publish || []) {
            if ((p.topics?.[alias] || alias) === topic) {
              dynamicPubs.push({ programId: p.programId, slot, alias });
            }
          }
          for (const alias of perms.subscribe || []) {
            if ((p.topics?.[alias] || alias) === topic) {
              dynamicSubs.push({ programId: p.programId, slot, alias });
            }
          }
        }
      });
      if (dynamicPubs.length || dynamicSubs.length) {
        providers = dynamicPubs;
        consumers = dynamicSubs;
        if (this.data.wiring) {
          this.data.wiring.topicProviders = this.data.wiring.topicProviders || {};
          this.data.wiring.topicConsumers = this.data.wiring.topicConsumers || {};
          this.data.wiring.topicProviders[topic] = providers;
          this.data.wiring.topicConsumers[topic] = consumers;
        }
      }
    }

    const uniquePrograms = new Set([
      ...providers.map(p => p.programId),
      ...consumers.map(c => c.programId)
    ]);
    const pCount = providers.length;
    const cCount = consumers.length;

    // 1. 边界接口 (Boundary I/O): 仅 1 个内部模块参与，面向外部系统、外部授权程序或外部设备
    if (uniquePrograms.size === 1 || (pCount > 0 && cCount === 0) || (pCount === 0 && cCount > 0)) {
      const isSend = pCount > 0;
      return {
        kind: 'boundary',
        label: t('边界接口'),
        icon: '🌐',
        badge: isSend ? t('🌐 边界发送') : t('🌐 边界接收'),
        color: isSend ? '#818cf8' : '#ec4899',
        pCount, cCount,
        desc: isSend ? t('面向外部系统、独立脚本或全局总线单向发送数据') : t('单向接收外部系统、独立进程或全局数据源推送')
      };
    }

    // 2. 专用通道 (Dedicated Channel): 恰好 2 个内部模块点对点独占专线 (单向定向或全双工互联)
    if (uniquePrograms.size === 2) {
      const isBi = (pCount >= 2 && cCount >= 2) || (providers.some(p => consumers.some(c => c.programId === p.programId)));
      return {
        kind: 'dedicated',
        label: t('专用通道'),
        icon: '🔌',
        badge: isBi ? t('🔌 专用通道 (双向互通)') : t('🔌 专用通道 (单向直连)'),
        color: '#00d2b4',
        pCount, cCount, bidirectional: isBi,
        desc: isBi ? t('两模块点对点全双工专用专线，双向互通') : t('两模块专属点对点专线，直接定向传输')
      };
    }

    // 3. 共享主题 (Shared Topic): 3 个或更多模块接入公共主题总线 (涵盖广播、多发汇聚与协同网格)
    const subInfo = pCount === 1 ? t('{p}发{c}收广播', { p: 1, c: cCount }) : (cCount === 1 ? t('{p}发{c}收汇聚', { p: pCount, c: 1 }) : t('{p}发{c}收网格', { p: pCount, c: cCount }));
    return {
      kind: 'shared',
      label: t('共享主题'),
      icon: '📡',
      badge: `${t('📡 共享主题')} (${subInfo})`,
      color: '#38bdf8',
      pCount, cCount,
      desc: t('枢纽公共主题总线：{p} 个供应端与 {c} 个抽取端解耦协同', { p: pCount, c: cCount })
    };
  }

  // 12. 接线模式连线渲染（双向线缆合并、拓扑分类着色、智能走线与断开按键）
  renderWiringCables() {
    const cablesG = $('wiring-cables-g');
    if (!cablesG) return;
    cablesG.replaceChildren();

    // 连线仅在接线模式（且已聚焦核心模块）时展示，运行监控模式与概览状态均不展示连线！
    if (this.mode !== 'wiring' || !this.focusedWiringModuleId) {
      cablesG.classList.add('hidden');
      return;
    }
    cablesG.classList.remove('hidden');

    const rawWires = this.data.wiring?.wires || [];
    let processedWires = [];
    const pairedSet = new Set();

    for (let i = 0; i < rawWires.length; i++) {
      if (pairedSet.has(i)) continue;
      const w1 = rawWires[i];
      let reverseIdx = -1;
      for (let j = i + 1; j < rawWires.length; j++) {
        if (pairedSet.has(j)) continue;
        const w2 = rawWires[j];
        if (
          w1.topic === w2.topic &&
          w1.from.programId === w2.to.programId &&
          w1.to.programId === w2.from.programId
        ) {
          reverseIdx = j;
          break;
        }
      }

      if (reverseIdx !== -1) {
        pairedSet.add(i);
        pairedSet.add(reverseIdx);
        processedWires.push({
          isBidirectional: true,
          topic: w1.topic,
          wire1: w1,
          wire2: rawWires[reverseIdx],
          from: w1.from,
          to: w1.to
        });
      } else {
        pairedSet.add(i);
        processedWires.push({
          isBidirectional: false,
          topic: w1.topic,
          wire1: w1,
          from: w1.from,
          to: w1.to
        });
      }
    }

    if (this.mode === 'wiring' && this.focusedWiringModuleId) {
      processedWires = processedWires.filter(w =>
        w.from.programId === this.focusedWiringModuleId ||
        w.to.programId === this.focusedWiringModuleId
      );
    }

    processedWires.forEach((w, wIdx) => {
      let fromPin = this.findPinCoord(w.from.programId, 'publish', w.from.alias);
      let toPin = this.findPinCoord(w.to.programId, 'subscribe', w.to.alias);
      if (!fromPin || !toPin) return;

      const cat = this.getChannelCategory(w.topic);
      const isBi = w.isBidirectional;
      // 双向线缆：保证从左向右平滑绘制，避免反拉绕圈
      if (isBi && fromPin.x > toPin.x) {
        const tmp = fromPin; fromPin = toPin; toPin = tmp;
      }

      const sx = fromPin.x, sy = fromPin.y;
      const ex = toPin.x, ey = toPin.y;

      let pathData;
      if (ex >= sx) {
        const dx = Math.max(40, (ex - sx) * 0.45);
        pathData = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`;
      } else {
        // 反向走线：平滑 C 型包络，避免直接穿透卡片
        const dy = (ey >= sy ? 60 : -60);
        pathData = `M ${sx} ${sy} C ${sx + 60} ${sy + dy}, ${ex - 60} ${ey - dy}, ${ex} ${ey}`;
      }

      const group = svgEl('g', {
        class: `wiring-cable-group cat-${cat.kind}${isBi ? ' bidirectional' : ''}`,
        id: `wire-${wIdx}`,
        'data-topic': w.topic
      });
      const cable = svgEl('path', {
        d: pathData,
        class: `wiring-cable cat-${cat.kind}${isBi ? ' bidirectional' : ''}`,
        'data-topic': w.topic
      });
      const flow = svgEl('path', {
        d: pathData,
        class: `wiring-cable-flow cat-${cat.kind}${isBi ? ' bidirectional' : ''}`
      });

      // 中间信息胶囊与断开按钮
      const midX = (sx + ex) / 2;
      const midY = (sy + ey) / 2;
      const pillG = svgEl('g', { class: 'wire-pill-g', transform: `translate(${midX}, ${midY})` });
      const labelText = isBi
        ? `◄── ${cat.icon} ${cat.label} ──►`
        : `➔ ${cat.icon} ${cat.label}`;
      const pillWidth = Math.max(90, labelText.length * 7.5 + 36);

      const pillBg = svgEl('rect', {
        x: -pillWidth / 2, y: -10, width: pillWidth, height: 20,
        class: `wire-pill-bg cat-${cat.kind}${isBi ? ' bidirectional' : ''}`
      });
      const pillText = svgEl('text', {
        x: -8, y: 4,
        class: `wire-pill-text cat-${cat.kind}${isBi ? ' bidirectional' : ''}`,
        'text-anchor': 'middle'
      }, labelText);

      setCanvasAttribute(pillG, 'title', () => (`${cat.icon} 【${cat.label}】(${cat.badge}): ${t('主题')} [${w.topic}]\n${cat.desc}\n${t('点击右侧 ✕ 可断开通道')}`));
      pillG.append(pillBg, pillText);

      // ✕ 断开按钮
      const delBtn = svgEl('g', {
        transform: `translate(${pillWidth / 2 - 16}, -7)`,
        style: 'cursor:pointer;'
      });
      setCanvasAttribute(delBtn, 'title', () => (t('断开此接线通道 [{topic}]', { topic: w.topic })));
      delBtn.append(
        svgEl('rect', { x: 0, y: 0, width: 14, height: 14, class: 'wire-delete-btn' }),
        svgEl('text', { x: 7, y: 10, class: 'wire-delete-text' }, '✕')
      );
      delBtn.addEventListener('click', async e => {
        e.stopPropagation();
        e.preventDefault();
        const list = [w.wire1];
        if (w.wire2) list.push(w.wire2);
        await this.disconnectWires(list);
      });
      pillG.append(delBtn);

      group.append(cable, flow, pillG);
      cablesG.append(group);
    });
  }

  inspectWireTopic(topic) {
    const streamSearch = $('stream-search');
    if (streamSearch) {
      streamSearch.value = topic;
      streamSearch.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const drawer = $('stream-drawer');
    if (drawer && !drawer.classList.contains('expanded')) {
      $('stream-bar')?.click();
    }
    canvasToast(() => (t('已定位主题 [{topic}] 的通讯流水记录', { topic })), 'neutral');
  }

  pulseTopicWire(topic) {
    const cables = document.querySelectorAll(`.wiring-cable[data-topic="${topic}"]`);
    cables.forEach(c => {
      c.classList.remove('topic-pulse');
      void c.offsetWidth;
      c.classList.add('topic-pulse');
    });
  }

  // 13. 编排模式 DAG 依赖箭头与阶段标牌渲染
  renderDAGArrows() {
    const dagG = $('orchestration-dag-g');
    if (!dagG) return;
    dagG.replaceChildren();

    const cardWidth = 300;
    const depAnchorY = 12;
    const plan = this.getActivePlan()?.members || [];

    // 1. 渲染各启动批次列顶部的阶段标牌 (Stage Wave Headers)
    const stages = this.computeStages();
    const stageMap = new Map();
    (this.filteredPrograms() || []).forEach(p => {
      const s = stages.get(p.programId) || 1;
      if (!stageMap.has(s)) stageMap.set(s, []);
      const pos = this.nodePositions.get(p.programId);
      if (pos) stageMap.get(s).push({ prog: p, pos });
    });

    stageMap.forEach((members, s) => {
      if (!members.length) return;
      const avgX = members.reduce((sum, m) => sum + m.pos.x, 0) / members.length;
      const minY = members.reduce((min, m) => Math.min(min, m.pos.y), Infinity);

      const headerG = svgEl('g', {
        class: 'dag-stage-header',
        id: `dag-stage-header-${s}`,
        transform: `translate(${Math.round(avgX)}, ${Math.round(minY - 110)})`
      });
      headerG.dataset.stage = String(s);
      const badgeWidth = 210;
      const badgeHeight = 28;
      headerG.append(
        svgEl('rect', {
          x: -badgeWidth / 2, y: -badgeHeight / 2,
          width: badgeWidth, height: badgeHeight,
          rx: 14,
          class: 'dag-stage-badge-bg'
        }),
        svgEl('text', {
          x: 0, y: 4,
          class: 'dag-stage-badge-text'
        }, t('⚡ 第 {stage} 批次 · {status} ({count})', { stage: s, status: s === 1 ? t('并行首发') : t('前置依赖就绪'), count: members.length }))
      );
      dagG.append(headerG);
    });

    // 2. 渲染各模块间的前置依赖导引箭头
    plan.forEach(member => {
      const toPos = this.nodePositions.get(member.programId);
      if (!toPos) return;

      (member.after || []).forEach(depId => {
        const fromPos = this.nodePositions.get(depId);
        if (!fromPos) return;

        // 箭头从 Predecessor 右侧端子出发，指向 Successor 左侧端子
        const sx = fromPos.x + cardWidth / 2;
        const sy = fromPos.y + depAnchorY;
        const ex = toPos.x - cardWidth / 2;
        const ey = toPos.y + depAnchorY;
        const dx = Math.max(50, Math.abs(ex - sx) * 0.45);
        const pathData = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`;

        const group = svgEl('g', {
          class: 'dag-arrow-group',
          id: `dag-arrow-${depId}-to-${member.programId}`
        });
        group.dataset.from = depId;
        group.dataset.to = member.programId;
        const arrow = svgEl('path', { d: pathData, class: 'dag-arrow' });
        const flow = svgEl('path', { d: pathData, class: 'dag-arrow-flow' });

        // 中间交互胶囊与断开按钮
        const midX = (sx + ex) / 2;
        const midY = (sy + ey) / 2;
        const pillG = svgEl('g', { class: 'dag-pill-g', transform: `translate(${midX}, ${midY})` });
        pillG.append(
          svgEl('rect', { x: -32, y: -11, width: 64, height: 22, class: 'dag-pill-bg' }),
          svgEl('text', { x: -10, y: 3.5, class: 'dag-pill-text' }, t('依赖 →')),
          svgEl('g', { class: 'dag-pill-del-btn', transform: 'translate(17, 0)', style: 'cursor:pointer;' })
        );
        const delG = pillG.lastElementChild;
        setCanvasAttribute(delG, 'title', () => (t('点击断开前置启动依赖')));
        delG.append(
          svgEl('circle', { cx: 0, cy: 0, r: 7, class: 'dag-del-circle' }),
          svgEl('text', { x: 0, y: 3, class: 'dag-del-icon' }, '✕')
        );
        delG.addEventListener('click', e => {
          e.stopPropagation();
          this.removeDependency(member.programId, depId);
        });

        group.append(arrow, flow, pillG);
        dagG.append(group);
      });
    });
  }

  // 14. 计算各模块启动阶段 (Topological Stage Tiers)
  computeStages() {
    const programs = this.filteredPrograms();
    const planMembers = this.getActivePlan()?.members || [];
    const memberMap = new Map();
    planMembers.forEach(m => memberMap.set(m.programId, m.after || []));
    const stages = new Map();

    const getStage = (id, visited = new Set()) => {
      if (stages.has(id)) return stages.get(id);
      if (visited.has(id)) return 1;
      visited.add(id);
      const after = memberMap.get(id) || [];
      if (!after.length) {
        stages.set(id, 1);
        return 1;
      }
      let maxPrereq = 0;
      for (const p of after) maxPrereq = Math.max(maxPrereq, getStage(p, new Set(visited)));
      const s = maxPrereq + 1;
      stages.set(id, s);
      return s;
    };

    programs.forEach(p => getStage(p.programId));
    return stages;
  }

  // 14.1 实时启动高亮状态机 (启动到哪个高亮哪个)
  updateStartupHighlightState({ startingProgramId = null, results = [] } = {}) {
    const hasExecution = Boolean(startingProgramId || results.length);
    const resultsMap = new Map();
    results.forEach(r => resultsMap.set(r.programId, r.state));

    const stages = this.computeStages();
    const activeStage = startingProgramId ? stages.get(startingProgramId) : null;
    const planMembers = this.getActivePlan()?.members || [];

    // 1. 遍历并动态更新所有节点 DOM 元素
    const nodes = document.querySelectorAll('.cmn-node');
    nodes.forEach(node => {
      const pid = node.dataset?.programId || node.id?.replace('cmn-', '');
      if (!pid) return;

      const progRecord = (this.data.programs || []).find(p => p.programId === pid);
      const eligible = progRecord?.executionPolicy?.mode !== 'on-demand' && planMembers.find(member => member.programId === pid)?.enabled === true;
      const isStarting = pid === startingProgramId;
      const state = resultsMap.get(pid);
      const isStarted = hasExecution && !isStarting && (state === 'started' || state === 'already-running' || (!state && progRecord?.state === 'running'));
      const isFailed = !isStarting && ((state === 'failed' || state === 'blocked') || (hasExecution && progRecord?.state === 'failed'));
      const isPending = hasExecution && eligible && !isStarting && !isStarted && !isFailed;

      node.classList.toggle('is-starting', isStarting);
      node.classList.toggle('is-started', isStarted);
      node.classList.toggle('is-failed', isFailed);
      node.classList.toggle('is-pending', isPending);

      // 更新卡片内文本与状态指示
      if (isStarting) {
        const badgeText = node.querySelector('.cmn-badge-text');
        if (badgeText) setCanvasText(badgeText, () => (t('🚀 启动中...')));
        const badgeBg = node.querySelector('.cmn-stage-badge-bg');
        if (badgeBg) {
          badgeBg.setAttribute('fill', 'rgba(245, 158, 11, 0.35)');
          badgeBg.setAttribute('stroke', '#fbbf24');
        }
        const stageDesc = node.querySelector('.cmn-stage-desc');
        if (stageDesc) {
          setCanvasText(stageDesc, () => (t('🚀 正在唤醒启动此模块进程...')));
          stageDesc.setAttribute('fill', '#fbbf24');
        }
        const stageDescDot = node.querySelector('.cmn-stage-desc-dot');
        if (stageDescDot) stageDescDot.setAttribute('fill', '#fbbf24');
        const runtimeText = node.querySelector('.cmn-runtime-status-text');
        if (runtimeText) {
          setCanvasText(runtimeText, () => (t('🚀 正在启动进程...')));
          runtimeText.setAttribute('fill', '#fbbf24');
        }
        const statusDot = node.querySelector('.cmn-status-dot');
        if (statusDot) statusDot.setAttribute('fill', '#fbbf24');
      } else if (isFailed) {
        const badgeText = node.querySelector('.cmn-badge-text');
        if (badgeText) setCanvasText(badgeText, () => (state === 'blocked' ? t('⚠ 依赖未就绪') : t('✕ 启动失败')));
        const badgeBg = node.querySelector('.cmn-stage-badge-bg');
        if (badgeBg) {
          badgeBg.setAttribute('fill', 'rgba(244, 63, 94, 0.25)');
          badgeBg.setAttribute('stroke', '#f43f5e');
        }
        const stageDesc = node.querySelector('.cmn-stage-desc');
        if (stageDesc) {
          setCanvasText(stageDesc, () => (state === 'blocked' ? t('⚠ 前置依赖异常，已跳过启动') : t('✕ 进程异常退出 · 启动失败')));
          stageDesc.setAttribute('fill', '#f43f5e');
        }
        const stageDescDot = node.querySelector('.cmn-stage-desc-dot');
        if (stageDescDot) stageDescDot.setAttribute('fill', '#f43f5e');
        const runtimeText = node.querySelector('.cmn-runtime-status-text');
        if (runtimeText) {
          setCanvasText(runtimeText, () => (t('✕ 启动失败 · 点击可查看日志')));
          runtimeText.setAttribute('fill', '#f43f5e');
        }
        const statusDot = node.querySelector('.cmn-status-dot');
        if (statusDot) statusDot.setAttribute('fill', '#f43f5e');
      } else if (isStarted) {
        const stageNum = stages.get(pid) || 1;
        const badgeText = node.querySelector('.cmn-badge-text');
        if (badgeText) setCanvasText(badgeText, () => (t('✓ 批次 #{stage} 已就绪', { stage: stageNum })));
        const badgeBg = node.querySelector('.cmn-stage-badge-bg');
        if (badgeBg) {
          badgeBg.setAttribute('fill', 'rgba(0, 210, 180, 0.15)');
          badgeBg.setAttribute('stroke', '#00d2b4');
        }
        const stageDesc = node.querySelector('.cmn-stage-desc');
        if (stageDesc) {
          setCanvasText(stageDesc, () => (t('✓ 模块已就绪并正常入网运行')));
          stageDesc.setAttribute('fill', '#00d2b4');
        }
        const stageDescDot = node.querySelector('.cmn-stage-desc-dot');
        if (stageDescDot) stageDescDot.setAttribute('fill', '#00d2b4');
        const runtimeText = node.querySelector('.cmn-runtime-status-text');
        if (runtimeText) {
          setCanvasText(runtimeText, () => (t('● 运行中 (已上线)')));
          runtimeText.setAttribute('fill', '#00d2b4');
        }
        const statusDot = node.querySelector('.cmn-status-dot');
        if (statusDot) statusDot.setAttribute('fill', '#00d2b4');
      } else if (!hasExecution) {
        // 恢复默认文案与状态
        const stageNum = stages.get(pid) || 1;
        const isRun = progRecord?.state === 'running';
        const isFail = progRecord?.state === 'failed';
        const badgeText = node.querySelector('.cmn-badge-text');
        if (badgeText) {
          setCanvasText(badgeText, () => (isRun ? t('✓ 批次 #{stage} 已就绪', { stage: stageNum }) : (isFail ? t('✕ 启动失败') : t('{icon} 批次 #{stage}', { icon: stageNum === 1 ? '⚡' : '⏱', stage: stageNum }))));
        }
        const badgeBg = node.querySelector('.cmn-stage-badge-bg');
        if (badgeBg) {
          badgeBg.setAttribute('fill', isRun ? 'rgba(0, 210, 180, 0.15)' : (isFail ? 'rgba(244, 63, 94, 0.25)' : 'rgba(255, 255, 255, 0.05)'));
          badgeBg.setAttribute('stroke', isRun ? '#00d2b4' : (isFail ? '#f43f5e' : 'rgba(255, 255, 255, 0.2)'));
        }
        const statusDot = node.querySelector('.cmn-status-dot');
        if (statusDot) {
          statusDot.setAttribute('fill', isRun ? '#00d2b4' : (isFail ? '#f43f5e' : '#64748b'));
        }
      }
      if (!eligible && !isStarting && !isStarted && !isFailed) {
        const demand = progRecord?.executionPolicy?.mode === 'on-demand';
        const desc = node.querySelector('.cmn-stage-desc');
        if (desc) setCanvasText(desc, () => (this.executionText(demand ? '按需唤醒 · 不随计划启动' : '未加入常驻启动计划')));
        const badge = node.querySelector('.cmn-badge-text');
        if (badge) setCanvasText(badge, () => (this.executionText(demand ? '按需' : '未加入常驻启动计划')));
      }
    });

    // 2. 编排导向箭头流向高亮与异常阻塞
    const arrows = document.querySelectorAll('.dag-arrow-group');
    arrows.forEach(arrow => {
      const toId = arrow.dataset?.to;
      const fromId = arrow.dataset?.from;
      const fromProg = (this.data.programs || []).find(p => p.programId === fromId);
      const isActive = startingProgramId && toId === startingProgramId;
      const isBlocked = (resultsMap.get(fromId) === 'failed' || fromProg?.state === 'failed') || (resultsMap.get(toId) === 'blocked');
      arrow.classList.toggle('is-active-flow', Boolean(isActive));
      arrow.classList.toggle('is-blocked-flow', Boolean(isBlocked));
    });

    // 3. 编排批次阶段顶栏标牌高亮与警示
    const stageHeaders = document.querySelectorAll('.dag-stage-header');
    stageHeaders.forEach(header => {
      const s = Number(header.dataset?.stage);
      const isCurrentStage = activeStage && s === activeStage;
      const stageProgs = (this.filteredPrograms() || []).filter(p => stages.get(p.programId) === s);
      const stageHasFailed = stageProgs.some(p => resultsMap.get(p.programId) === 'failed' || resultsMap.get(p.programId) === 'blocked' || p.state === 'failed');
      const stageAllDone = stageProgs.length > 0 && stageProgs.every(p => {
        const st = resultsMap.get(p.programId);
        return st === 'started' || st === 'already-running' || (!st && p.state === 'running');
      });

      header.classList.toggle('is-active-stage', Boolean(isCurrentStage));
      header.classList.toggle('is-failed-stage', Boolean(stageHasFailed));
      header.classList.toggle('is-done-stage', Boolean(stageAllDone && (!activeStage || s < activeStage)));
    });
  }

  // 15. 智能拓扑自动排版
  autoLayout() {
    const programs = this.filteredPrograms();
    if (!programs.length) return;

    // 两级分层聚类智能排版：当全局视图存在模块组时，按组聚类，组间绝对隔离防交叉
    if (this.groupFilter === 'all' && this.layoutClustered(programs, this.mode)) {
      this.debounceSaveLayout();
      this.render();
      canvasToast(() => (t('已自动按模块组聚类完成排版（防交叉）')), 'neutral');
      return;
    }

    if (this.mode === 'static') {
      const total = programs.length;
      const cols = total <= 1 ? 1 : (total <= 4 ? 2 : 3);
      const rows = Math.ceil(total / cols);
      programs.forEach((prog, idx) => {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const pos = {
          x: Math.round((col - (cols - 1) / 2) * 380),
          y: Math.round((row - (rows - 1) / 2) * 260)
        };
        this.modePositions.static.set(prog.programId, pos);
      });
      this.debounceSaveLayout();
      this.render();
      canvasToast(() => (t('已自动完成模块清单排版')), 'neutral');
      return;
    }

    if (this.mode === 'wiring') {
      if (this.focusedWiringModuleId) {
        const focusProg = programs.find(p => p.programId === this.focusedWiringModuleId);
        if (focusProg) {
          const candidatePartners = this.findMatchingPartners(focusProg, programs);
          this.focusedWiringPositions.set(focusProg.programId, { x: -280, y: 0 });
          const totalPartners = candidatePartners.length;
          const spacingY = 250;
          candidatePartners.forEach((cand, idx) => {
            const py = Math.round((idx - (totalPartners - 1) / 2) * spacingY);
            this.focusedWiringPositions.set(cand.prog.programId, { x: 280, y: py });
          });
        }
      } else {
        const total = programs.length;
        const cols = total <= 2 ? total : (total <= 4 ? 2 : 3);
        const rows = Math.ceil(total / cols);
        programs.forEach((prog, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const pos = {
            x: Math.round((col - (cols - 1) / 2) * 360),
            y: Math.round((row - (rows - 1) / 2) * 200)
          };
          this.modePositions.wiring.set(prog.programId, pos);
        });
      }
      this.debounceSaveLayout();
      this.render();
      canvasToast(() => (t('已自动完成接线排版')), 'neutral');
      return;
    }

    if (this.mode === 'orchestration') {
      this.layoutDAG(programs);
      this.debounceSaveLayout();
      this.render();
      canvasToast(() => (t('已自动按编排阶段完成排版')), 'neutral');
      return;
    }

    // Default: Runtime mode layout
    this.layoutRuntime(programs);
    this.debounceSaveLayout();
    this.render();
    canvasToast(() => (t('已自动按运行时拓扑完成排版')), 'neutral');
  }

  layoutDAG(programs = this.filteredPrograms()) {
    if (!programs || !programs.length) return;
    const stages = this.computeStages();
    const cols = [];

    programs.forEach(p => {
      const tier = (stages.get(p.programId) || 1) - 1;
      if (!cols[tier]) cols[tier] = [];
      cols[tier].push(p.programId);
    });

    let effectiveCols = cols.filter(c => c && c.length);
    if (effectiveCols.length === 1 && effectiveCols[0].length > 1) {
      const all = effectiveCols[0];
      const mid = Math.ceil(all.length / 2);
      effectiveCols = [all.slice(0, mid), all.slice(mid)];
    }

    const colWidth = 440;
    const rowHeight = 185;
    const yOffset = 35;
    const totalCols = effectiveCols.length;

    effectiveCols.forEach((colMembers, colIdx) => {
      const x = (colIdx - (totalCols - 1) / 2) * colWidth;
      const totalRows = colMembers.length;
      colMembers.forEach((id, rowIdx) => {
        const y = (rowIdx - (totalRows - 1) / 2) * rowHeight + yOffset;
        this.modePositions.orchestration.set(id, { x: Math.round(x), y: Math.round(y) });
      });
    });
  }

  layoutRuntime(programs = this.filteredPrograms()) {
    if (!programs || !programs.length) return;
    const cols = [];

    programs.forEach(p => {
      const planMember = (this.getActivePlan()?.members || []).find(m => m.programId === p.programId);
      const hasPrereq = (planMember?.after || []).length > 0;
      const requiresCaps = (p.requires || []).length > 0;
      const providesCaps = (p.provides || []).length > 0;

      let tier = 0;
      if (requiresCaps || hasPrereq) {
        tier = 1; // 消费者/下游在右边
      } else if (providesCaps) {
        tier = 0; // 生产者/上游在左边
      } else {
        const wires = this.data.wiring?.wires || [];
        const inDegree = wires.filter(w => w.to.programId === p.programId).length;
        const outDegree = wires.filter(w => w.from.programId === p.programId).length;
        tier = inDegree > outDegree ? 1 : 0;
      }

      if (!cols[tier]) cols[tier] = [];
      cols[tier].push(p.programId);
    });

    let effectiveCols = cols.filter(c => c && c.length);
    if (effectiveCols.length === 1 && effectiveCols[0].length > 1) {
      const all = effectiveCols[0];
      const mid = Math.ceil(all.length / 2);
      effectiveCols = [all.slice(0, mid), all.slice(mid)];
    }

    const colWidth = 440;
    const rowHeight = 220;
    const totalCols = effectiveCols.length;

    effectiveCols.forEach((colMembers, colIdx) => {
      const x = (colIdx - (totalCols - 1) / 2) * colWidth;
      const totalRows = colMembers.length;
      colMembers.forEach((id, rowIdx) => {
        const y = (rowIdx - (totalRows - 1) / 2) * rowHeight;
        this.modePositions.runtime.set(id, { x: Math.round(x), y: Math.round(y) });
      });
    });
  }

  layoutClustered(programs = this.filteredPrograms(), mode = this.mode) {
    if (!programs || !programs.length) return false;
    const groups = (this.data.groups || []).filter(g => (g.memberProgramIds || []).some(id => programs.some(p => p.programId === id)));
    if (!groups.length) return false;

    // Pass 1: 组内聚类
    const clusters = [];
    const assignedIds = new Set();
    groups.forEach(g => {
      const members = programs.filter(p => (g.memberProgramIds || []).includes(p.programId));
      if (members.length > 0) {
        clusters.push({ kind: 'group', id: g.id, title: g.title, programs: members });
        members.forEach(m => assignedIds.add(m.programId));
      }
    });

    const ungrouped = programs.filter(p => !assignedIds.has(p.programId));
    if (ungrouped.length > 0) {
      clusters.push({ kind: 'ungrouped', id: 'ungrouped', title: t('散装模块'), programs: ungrouped });
    }

    // 测量各组边界与组内紧凑排版
    const colWidth = mode === 'static' ? 390 : 360;
    const rowHeight = mode === 'static' ? 260 : 220;
    const pad = 42;
    const headerH = 38;

    const clusterBoxes = clusters.map(cluster => {
      const n = cluster.programs.length;
      const cols = n <= 1 ? 1 : (n <= 4 ? 2 : 3);
      const rows = Math.ceil(n / cols);
      const localPositions = new Map();

      cluster.programs.forEach((prog, idx) => {
        const c = idx % cols;
        const r = Math.floor(idx / cols);
        const lx = Math.round((c - (cols - 1) / 2) * colWidth);
        const ly = Math.round((r - (rows - 1) / 2) * rowHeight + 16);
        localPositions.set(prog.programId, { x: lx, y: ly });
      });

      const width = cols * colWidth + pad * 2;
      const height = rows * rowHeight + pad * 2 + headerH;
      return { cluster, localPositions, width, height };
    });

    // Pass 2: 宏观组间刚体隔离排版 (两列货架排布，块间 80px 绝对隔离，100% 杜绝交叉)
    const numClusters = clusterBoxes.length;
    const macroCols = numClusters <= 1 ? 1 : 2;
    const macroRows = Math.ceil(numClusters / macroCols);

    const colWidths = new Array(macroCols).fill(0);
    const rowHeights = new Array(macroRows).fill(0);
    clusterBoxes.forEach((cb, idx) => {
      const c = idx % macroCols;
      const r = Math.floor(idx / macroCols);
      colWidths[c] = Math.max(colWidths[c], cb.width);
      rowHeights[r] = Math.max(rowHeights[r], cb.height);
    });

    const gapX = 80;
    const gapY = 80;
    const totalMacroW = colWidths.reduce((a, b) => a + b, 0) + (macroCols - 1) * gapX;
    const totalMacroH = rowHeights.reduce((a, b) => a + b, 0) + (macroRows - 1) * gapY;

    let curY = -totalMacroH / 2;
    for (let r = 0; r < macroRows; r++) {
      let curX = -totalMacroW / 2;
      for (let c = 0; c < macroCols; c++) {
        const idx = r * macroCols + c;
        if (idx < clusterBoxes.length) {
          const cb = clusterBoxes[idx];
          const clusterCenterX = curX + colWidths[c] / 2;
          const clusterCenterY = curY + rowHeights[r] / 2;

          cb.cluster.programs.forEach(prog => {
            const lpos = cb.localPositions.get(prog.programId) || { x: 0, y: 0 };
            const absPos = {
              x: Math.round(clusterCenterX + lpos.x),
              y: Math.round(clusterCenterY + lpos.y)
            };
            this.modePositions[mode].set(prog.programId, absPos);
          });
        }
        curX += colWidths[c] + gapX;
      }
      curY += rowHeights[r] + gapY;
    }

    return true;
  }

  renderGroupContainers() {
    let container = $('group-containers-g');
    if (!container) {
      const viewport = $('viewport');
      if (viewport) {
        container = svgEl('g', { id: 'group-containers-g', class: 'hidden' });
        viewport.insertBefore(container, $('wiring-cables-g') || $('module-nodes-g'));
      }
    }
    if (!container) return;
    container.replaceChildren();

    // 天体星轨模式下禁止渲染卡片分组框，强制隐藏
    if (this.mode === 'runtime' && this.runtimePerspective === 'orbits') {
      container.classList.add('hidden');
      return;
    }
    container.classList.remove('hidden');

    if (this.groupFilter !== 'all') return;
    const groups = this.data.groups || [];
    if (!groups.length) return;

    const programs = this.filteredPrograms() || [];

    for (const group of groups) {
      const members = programs.filter(p => (group.memberProgramIds || []).includes(p.programId));
      if (!members.length) continue;

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let cardHalfW = 175;
      let cardHalfH = 115;
      let topExtra = 0;

      if (this.mode === 'static') {
        cardHalfW = 175;
        cardHalfH = 115;
        topExtra = 24; // 模块顶部常驻/临时执行策略徽章及呼吸空隙
      } else if (this.mode === 'wiring') {
        cardHalfW = 165;
        cardHalfH = 120;
      } else {
        cardHalfW = 150;
        cardHalfH = 75;
      }

      for (const m of members) {
        const pos = this.nodePositions?.get(m.programId);
        if (!pos) continue;
        minX = Math.min(minX, pos.x - cardHalfW);
        maxX = Math.max(maxX, pos.x + cardHalfW);
        minY = Math.min(minY, pos.y - cardHalfH - topExtra);
        maxY = Math.max(maxY, pos.y + cardHalfH);
      }

      if (!isFinite(minX)) continue;

      const padX = 42, padY = 36, headerH = 38;
      const boxX = minX - padX;
      const boxY = minY - padY - headerH;
      const boxW = (maxX - minX) + padX * 2;
      const boxH = (maxY - minY) + padY * 2 + headerH;

      const isSelected = this.selectedGroupId === group.id;

      const gBox = svgEl('g', {
        class: `cmn-group-container ${isSelected ? 'selected' : ''}`,
        'data-group-id': group.id
      });

      // Background rect (pointer-events: none so wire drag passes through)
      const bgRect = svgEl('rect', {
        x: String(boxX),
        y: String(boxY),
        width: String(boxW),
        height: String(boxH),
        rx: '16',
        fill: isSelected ? 'rgba(0, 210, 180, 0.08)' : 'rgba(13, 21, 34, 0.45)',
        stroke: isSelected ? '#00d2b4' : 'rgba(0, 210, 180, 0.28)',
        'stroke-width': isSelected ? '2' : '1.5',
        'stroke-dasharray': isSelected ? 'none' : '5 4',
        style: 'pointer-events: none; transition: stroke 0.2s, fill 0.2s;'
      });
      gBox.append(bgRect);

      // Header interactive bar (pointer-events: all)
      const headerG = svgEl('g', {
        class: 'cmn-group-header-bar',
        style: 'cursor: pointer; pointer-events: all;'
      });
      const headerBg = svgEl('rect', {
        x: String(boxX + 8),
        y: String(boxY + 8),
        width: String(boxW - 16),
        height: String(headerH - 8),
        rx: '8',
        fill: isSelected ? 'rgba(0, 210, 180, 0.22)' : 'rgba(0, 210, 180, 0.09)',
        stroke: isSelected ? '#00d2b4' : 'rgba(0, 210, 180, 0.22)',
        'stroke-width': '1'
      });
      const titleText = svgEl('text', {
        x: String(boxX + 22),
        y: String(boxY + 27),
        fill: isSelected ? '#ffffff' : '#00d2b4',
        'font-size': '12',
        'font-weight': '700',
        'font-family': 'var(--sans)'
      });
      setCanvasText(titleText, () => (`📦 ${group.title || group.id} (${t('{count} 个成员', { count: members.length })})`));

      const manageBadge = svgEl('text', {
        x: String(boxX + boxW - 22),
        y: String(boxY + 27),
        'text-anchor': 'end',
        fill: isSelected ? '#00d2b4' : 'var(--muted)',
        'font-size': '11',
        'font-family': 'var(--sans)'
      });
      setCanvasText(manageBadge, () => (t('⚙ 点击管理组')));

      headerG.append(headerBg, titleText, manageBadge);
      headerG.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectGroup(group.id);
      });

      gBox.append(headerG);
      container.append(gBox);
    }
  }

  // 16. 手势拖拽处理
  startDragNode(e, programId) {
    e.stopPropagation();
    const pos = this.nodePositions.get(programId) || { x: 0, y: 0 };
    this.draggingNode = {
      id: programId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      initPos: { x: pos.x || 0, y: pos.y || 0 }
    };
  }

  startDragDep(e, programId, pinX, pinY) {
    e.stopPropagation();
    this.draggingDep = {
      fromProgramId: programId,
      startX: pinX,
      startY: pinY
    };
    const dragPath = $('drag-cable-path');
    if (dragPath) {
      dragPath.setAttribute('stroke', '#f59e0b');
      dragPath.classList.remove('hidden');
    }
  }

  handleMouseMove(e) {
    const viewport = window.hubCanvas?.state?.viewport || { x: 0, y: 0, scale: 1 };
    const mouseSvgX = (e.clientX - viewport.x) / viewport.scale;
    const mouseSvgY = (e.clientY - viewport.y) / viewport.scale;

    if (this.draggingNode) {
      const dx = (e.clientX - this.draggingNode.startClientX) / viewport.scale;
      const dy = (e.clientY - this.draggingNode.startClientY) / viewport.scale;
      const curPos = {
        x: Math.round(this.draggingNode.initPos.x + dx),
        y: Math.round(this.draggingNode.initPos.y + dy)
      };
      this.nodePositions.set(this.draggingNode.id, curPos);

      const el = $(`cmn-${this.draggingNode.id}`);
      if (el) el.setAttribute('transform', `translate(${curPos.x}, ${curPos.y})`);

      if (this.mode === 'wiring') this.renderWiringCables();
      if (this.mode === 'orchestration') this.renderDAGArrows();
      this.renderGroupContainers();
    }

    if (this.draggingDep) {
      const sx = this.draggingDep.startX;
      const sy = this.draggingDep.startY;
      const dx = Math.max(30, Math.abs(mouseSvgX - sx) * 0.45);
      $('drag-cable-path')?.setAttribute('d', `M ${sx} ${sy} C ${sx + dx} ${sy}, ${mouseSvgX - dx} ${mouseSvgY}, ${mouseSvgX} ${mouseSvgY}`);
    }
  }

  handleMouseUp(e) {
    if (this.draggingNode) {
      this.draggingNode = null;
      this.debounceSaveLayout();
      this.renderGroupContainers();
    }

    if (this.draggingDep) {
      $('drag-cable-path')?.classList.add('hidden');
      const targetIn = e.target.closest('.pin-dep-in') || e.target.closest('.cmn-node');
      if (targetIn) {
        const targetId = targetIn.dataset?.programId || targetIn.id?.replace('cmn-', '');
        if (targetId && targetId !== this.draggingDep.fromProgramId) {
          this.connectDependency(targetId, this.draggingDep.fromProgramId);
        }
      }
      this.draggingDep = null;
    }
  }

  debounceSaveLayout() {
    clearTimeout(this.saveLayoutTimer);
    this.saveLayoutTimer = setTimeout(async () => {
      const modes = {};
      for (const m of ['static', 'runtime', 'wiring', 'orchestration']) {
        modes[m] = {};
        for (const [id, pos] of this.modePositions[m].entries()) {
          modes[m][id] = pos;
        }
      }
      const nodes = modes[this.mode] || modes.runtime || {};
      try {
        await fetch('/manage/api/layout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
          },
          body: JSON.stringify({ layout: { version: 1, nodes, modes } })
        });
      } catch (err) {
        console.warn('保存画布坐标失败:', err);
      }
    }, 400);
  }

  // 事务队列与配置持久化，杜绝并发竞态与状态回弹
  enqueueMutation(mutationFn) {
    this.pendingMutations++;
    const task = this.mutationQueue.then(async () => {
      try {
        await mutationFn();
      } catch (err) {
        console.warn('事务队列任务异常:', err);
      } finally {
        this.pendingMutations--;
        if (this.pendingMutations === 0) {
          await this.fetchModulesData();
        }
      }
    });
    this.mutationQueue = task;
    return task;
  }

  async applyProgramConfiguration(prog, csrf) {
    if (!prog || !prog.programId) return null;
    let res = await fetch(`/manage/api/programs/${prog.programId}/configuration/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Management-Token': csrf },
      body: JSON.stringify({
        expectedRevision: prog.configurationRevision,
        topics: prog.topics,
        bridges: prog.bridges,
        settings: prog.settings,
        bindings: prog.bindings
      })
    });

    if (res.status === 409) {
      // 遇到版本冲突时，仅向服务端同步最新 configurationRevision，保留当前前端乐观变更，避免覆盖本地最新编辑
      const listRes = await fetch('/manage/api/programs');
      if (listRes.ok) {
        const listData = await listRes.json();
        const serverProg = (listData.programs || []).find(p => p.programId === prog.programId);
        if (serverProg && serverProg.configurationRevision != null) {
          prog.configurationRevision = serverProg.configurationRevision;
          res = await fetch(`/manage/api/programs/${prog.programId}/configuration/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Management-Token': csrf },
            body: JSON.stringify({
              expectedRevision: prog.configurationRevision,
              topics: prog.topics,
              bridges: prog.bridges,
              settings: prog.settings,
              bindings: prog.bindings
            })
          });
        }
      }
    }

    if (!res.ok) {
      let errText = '';
      try {
        const errObj = await res.json();
        errText = errObj?.message || errObj?.error?.message || res.statusText;
      } catch {}
      throw new Error(errText || `HTTP ${res.status}`);
    }

    const resData = await res.json();
    if (resData?.configurationRevision) {
      prog.configurationRevision = resData.configurationRevision;
    } else if (resData?.program?.configurationRevision) {
      prog.configurationRevision = resData.program.configurationRevision;
    }
    return resData;
  }

  // 17. 接线建立与断开 (采用 0ms 乐观更新机制，避免网络等待与操作迟滞)
  async connectWiring(source, target, customTopic = null) {
    let prog = this.data.programs.find(p => p.programId === target.programId);
    if (!prog) return;

    let cleanCustom = (customTopic && !customTopic.includes('unwired')) ? customTopic : null;
    let cleanSrc = (source.topic && !source.topic.includes('unwired')) ? source.topic : null;
    let cleanTgt = (target.topic && !target.topic.includes('unwired')) ? target.topic : null;
    const topicToUse = cleanCustom || cleanSrc || cleanTgt || `${source.programId}/${source.alias}`;

    // 1. 乐观更新 (Optimistic UI)：0毫秒即刻在内存建立连线与状态胶囊，立刻重绘！
    const oldProgTopics = { ...prog.topics };
    let srcProg = this.data.programs.find(p => p.programId === source.programId);
    const oldSrcTopics = srcProg ? { ...srcProg.topics } : null;
    const oldWires = [...(this.data.wiring?.wires || [])];

    prog.topics = { ...prog.topics, [target.alias]: topicToUse };
    if (srcProg) {
      srcProg.topics = { ...srcProg.topics, [source.alias]: topicToUse };
    }
    if (this.data.wiring) {
      delete this.data.wiring.topicProviders?.[topicToUse];
      delete this.data.wiring.topicConsumers?.[topicToUse];
    }

    if (!this.data.wiring) this.data.wiring = { wires: [], topicProviders: {}, topicConsumers: {} };
    if (!this.data.wiring.wires) this.data.wiring.wires = [];

    const hasWire = this.data.wiring.wires.some(w =>
      w.from.programId === source.programId && w.from.alias === source.alias &&
      w.to.programId === target.programId && w.to.alias === target.alias
    );
    if (!hasWire) {
      this.data.wiring.wires.push({
        topic: topicToUse,
        from: { programId: source.programId, slot: source.slot || 'main', alias: source.alias },
        to: { programId: target.programId, slot: target.slot || 'main', alias: target.alias }
      });
    }

    // 检查是否同时激活了反向互联（当目标端拥有发布能力且源端拥有订阅能力时，共享同一主题即在Hub物理层构成全双工双向互联）
    const targetHasPub = Object.values(prog.bridges || {}).some(b => (b.publish || []).includes(target.alias));
    const srcHasSub = srcProg && Object.values(srcProg.bridges || {}).some(b => (b.subscribe || []).includes(source.alias));
    if (targetHasPub && srcHasSub) {
      const hasReverse = this.data.wiring.wires.some(w =>
        w.from.programId === target.programId && w.from.alias === target.alias &&
        w.to.programId === source.programId && w.to.alias === source.alias
      );
      if (!hasReverse) {
        this.data.wiring.wires.push({
          topic: topicToUse,
          from: { programId: target.programId, slot: target.slot || 'main', alias: target.alias },
          to: { programId: source.programId, slot: source.slot || 'main', alias: source.alias }
        });
      }
    }

    // 0 毫秒即刻重绘界面，粒子线缆瞬间展开，按钮即刻变为已接线！
    this.render();
    canvasToast(() => (t('✓ 成功建立数据通道对接: {topic}', { topic: topicToUse })), 'neutral');

    // 2. 压入后台事务队列排队串行持久化，彻底消除并发冲突与回弹
    this.enqueueMutation(async () => {
      try {
        const csrf = window.hubCanvas?.state?.data?.csrfToken || '';
        if (srcProg && oldSrcTopics && oldSrcTopics[source.alias] !== topicToUse) {
          await this.applyProgramConfiguration(srcProg, csrf);
        }
        await this.applyProgramConfiguration(prog, csrf);
      } catch (e) {
        console.warn('建立接线后台同步异常:', e);
        prog.topics = oldProgTopics;
        if (srcProg && oldSrcTopics) srcProg.topics = oldSrcTopics;
        if (this.data.wiring) this.data.wiring.wires = oldWires;
        this.render();
        canvasToast(() => (t('接线失败: {error}', { error: e.message })), 'error');
      }
    });
  }

  // 17.1 一键自动按相同或兼容通道对接
  async autoWireMatchingTopics() {
    const programs = this.filteredPrograms();
    if (!programs.length) return;

    // 1. 扫描当前全部模块的所有发布(pub)与订阅(sub)端点
    const pubList = [];
    const subList = [];
    programs.forEach(p => {
      for (const [slot, perms] of Object.entries(p.bridges || {})) {
        for (const alias of perms.publish || []) {
          const rawTopic = p.topics?.[alias] || alias;
          pubList.push({ programId: p.programId, slot, alias, rawTopic, prog: p });
        }
        for (const alias of perms.subscribe || []) {
          const rawTopic = p.topics?.[alias] || alias;
          subList.push({ programId: p.programId, slot, alias, rawTopic, prog: p });
        }
      }
    });

    const isCompatible = (pAlias, sAlias) => {
      if (pAlias === sAlias) return true;
      const np = pAlias.toLowerCase().replace(/[-_]/g, '');
      const ns = sAlias.toLowerCase().replace(/[-_]/g, '');
      if (np === ns) return true;
      if ((np === 'output' || np === 'out') && (ns === 'input' || ns === 'in')) return true;
      if ((np === 'source' || np === 'src') && (ns === 'target' || ns === 'sink' || ns === 'dest')) return true;
      return false;
    };

    const resolveCanonicalTopic = (pub, sub) => {
      if (pub.rawTopic && !pub.rawTopic.includes('unwired')) return pub.rawTopic;
      if (sub.rawTopic && !sub.rawTopic.includes('unwired')) return sub.rawTopic;
      if (pub.alias === sub.alias) return pub.alias;
      return `${pub.programId}/${pub.alias}`;
    };

    // 保存快照以备出错回滚
    const snapshots = [];
    const progMap = new Map();
    const recordSnapshot = (prog) => {
      if (!progMap.has(prog.programId)) {
        snapshots.push({ prog, oldTopics: { ...prog.topics } });
        progMap.set(prog.programId, prog);
      }
    };

    const oldWires = [...(this.data.wiring?.wires || [])];
    if (!this.data.wiring) this.data.wiring = { wires: [], topicProviders: {}, topicConsumers: {} };
    if (!this.data.wiring.wires) this.data.wiring.wires = [];

    const existingWires = this.data.wiring.wires;
    let matchCount = 0;
    const progsToUpdate = new Set();

    // 2. 遍历匹配候选对，建立双向/单向连线与统一数据主题
    subList.forEach(sub => {
      const candidates = pubList.filter(pub => {
        if (pub.programId === sub.programId) return false;
        if (pub.alias === sub.alias) return true;
        if (isCompatible(pub.alias, sub.alias)) return true;
        if (pub.rawTopic && sub.rawTopic && !pub.rawTopic.includes('unwired') && pub.rawTopic === sub.rawTopic) return true;
        if (pub.rawTopic && sub.rawTopic && !pub.rawTopic.includes('unwired') && !sub.rawTopic.includes('unwired') &&
            pub.rawTopic.split('/')[0] === sub.rawTopic.split('/')[0] && pub.rawTopic.split('/')[0] !== '') return true;
        return false;
      });

      candidates.forEach(pub => {
        const canonicalTopic = resolveCanonicalTopic(pub, sub);

        // 检查是否已经存在该方向的有效接线且主题一致
        const hasForwardWire = existingWires.some(w =>
          w.from.programId === pub.programId && w.from.alias === pub.alias &&
          w.to.programId === sub.programId && w.to.alias === sub.alias &&
          w.topic === canonicalTopic
        );
        const pubTopicMatches = pub.prog.topics?.[pub.alias] === canonicalTopic;
        const subTopicMatches = sub.prog.topics?.[sub.alias] === canonicalTopic;

        if (hasForwardWire && pubTopicMatches && subTopicMatches) {
          return; // 已接通，无需重复建立
        }

        // 记录快照
        recordSnapshot(pub.prog);
        recordSnapshot(sub.prog);

        // 更新双方的 topics 为同一个统一规范通道主题
        pub.prog.topics = { ...pub.prog.topics, [pub.alias]: canonicalTopic };
        sub.prog.topics = { ...sub.prog.topics, [sub.alias]: canonicalTopic };

        // 更新端点当前 rawTopic，便于后续同轮循环匹配
        pub.rawTopic = canonicalTopic;
        sub.rawTopic = canonicalTopic;

        // 添加正向连线
        if (!hasForwardWire) {
          existingWires.push({
            topic: canonicalTopic,
            from: { programId: pub.programId, slot: pub.slot || 'main', alias: pub.alias },
            to: { programId: sub.programId, slot: sub.slot || 'main', alias: sub.alias }
          });
        }

        // 检查反向全双工连线是否成立：如果 sub 端也拥有该 alias 的发布能力，且 pub 端拥有该 alias 的订阅能力
        const subHasPub = Object.values(sub.prog.bridges || {}).some(b => (b.publish || []).includes(sub.alias));
        const pubHasSub = Object.values(pub.prog.bridges || {}).some(b => (b.subscribe || []).includes(pub.alias));
        if (subHasPub && pubHasSub) {
          const hasReverseWire = existingWires.some(w =>
            w.from.programId === sub.programId && w.from.alias === sub.alias &&
            w.to.programId === pub.programId && w.to.alias === pub.alias &&
            w.topic === canonicalTopic
          );
          if (!hasReverseWire) {
            existingWires.push({
              topic: canonicalTopic,
              from: { programId: sub.programId, slot: sub.slot || 'main', alias: sub.alias },
              to: { programId: pub.programId, slot: pub.slot || 'main', alias: pub.alias }
            });
          }
        }

        progsToUpdate.add(pub.prog);
        progsToUpdate.add(sub.prog);
        matchCount++;
      });
    });

    if (matchCount === 0) {
      canvasToast(() => (t('所有匹配通道均已建立接线，无需额外对接')), 'neutral');
      return;
    }

    if (!this.focusedWiringModuleId && progsToUpdate.size > 0) {
      this.focusedWiringModuleId = [...progsToUpdate][0].programId;
      this.updateWiringFocusPills();
      this.updateGroupActionButtons();
    }

    // 0 毫秒即刻乐观重绘！粒子连线与状态胶囊瞬间展现
    this.render();
    canvasToast(() => (t('✓ 智能对接完成：已自动建立 {count} 处匹配数据通道！', { count: matchCount })), 'neutral');

    if ($('wiring-matrix-modal') && !$('wiring-matrix-modal').classList.contains('hidden')) {
      this.renderWiringMatrixModal();
    }

    // 压入后台串行持久化队列，处理 409 冲突与落盘
    this.enqueueMutation(async () => {
      try {
        const csrf = window.hubCanvas?.state?.data?.csrfToken || '';
        for (const prog of progsToUpdate) {
          await this.applyProgramConfiguration(prog, csrf);
        }
      } catch (e) {
        console.warn('智能自动对接后台同步异常:', e);
        snapshots.forEach(s => { s.prog.topics = s.oldTopics; });
        if (this.data.wiring) this.data.wiring.wires = oldWires;
        this.render();
        canvasToast(() => (t('自动对接同步失败: {error}', { error: e.message })), 'error');
      }
    });
  }

  // 17.2 接线矩阵与快捷配对弹窗控制
  openWiringMatrixModal() {
    const modal = $('wiring-matrix-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    this.matrixCategoryFilter = this.matrixCategoryFilter || 'all';
    document.querySelectorAll('.matrix-filter-pill').forEach(b => b.classList.toggle('active', b.dataset.filter === this.matrixCategoryFilter));
    this.renderWiringMatrixModal();
  }

  closeWiringMatrixModal() {
    $('wiring-matrix-modal')?.classList.add('hidden');
  }

  renderWiringMatrixModal() {
    const programs = this.filteredPrograms();
    const selSrc = $('sel-pair-source');
    const selTgt = $('sel-pair-target');
    const inpTopic = $('inp-pair-topic');
    const wiresList = $('matrix-wires-list');
    const countEl = $('matrix-wire-count');

    if (selSrc) {
      selSrc.replaceChildren();
      programs.forEach(p => {
        const title = localizedText(p.title, p.programId);
        for (const [slot, perms] of Object.entries(p.bridges || {})) {
          for (const alias of perms.publish || []) {
            const topic = p.topics?.[alias] || alias;
            const opt = document.createElement('option');
            opt.value = `${p.programId}|${slot}|${alias}|${topic}`;
            setCanvasText(opt, () => (`${localizedText(p.title, p.programId)} · ${t('输出')} [${alias}] (${t('主题:')} ${topic})`));
            selSrc.append(opt);
          }
        }
      });
    }

    if (selTgt) {
      selTgt.replaceChildren();
      programs.forEach(p => {
        const title = localizedText(p.title, p.programId);
        for (const [slot, perms] of Object.entries(p.bridges || {})) {
          for (const alias of perms.subscribe || []) {
            const topic = p.topics?.[alias] || alias;
            const opt = document.createElement('option');
            opt.value = `${p.programId}|${slot}|${alias}|${topic}`;
            setCanvasText(opt, () => (`${localizedText(p.title, p.programId)} · ${t('输入')} [${alias}] (${t('主题:')} ${topic})`));
            selTgt.append(opt);
          }
        }
      });
    }

    this.onPairSourceChange();

    // 收集所有有效通信主题通道 (点对点专线 / 广播总线 / 汇聚管道 / 协同网格 / 外部通道)
    const allTopics = new Set([
      ...Object.keys(this.data.wiring?.topicProviders || {}),
      ...Object.keys(this.data.wiring?.topicConsumers || {})
    ]);
    const activeTopics = [...allTopics].filter(t => t && !t.includes('unwired'));

    let countAll = 0;
    let countDedicated = 0;
    let countShared = 0;
    let countBoundary = 0;

    const channelItems = [];

    activeTopics.forEach(topic => {
      const cat = this.getChannelCategory(topic);
      if (cat.kind === 'unwired') return;

      const providers = this.data.wiring?.topicProviders?.[topic] || [];
      const consumers = this.data.wiring?.topicConsumers?.[topic] || [];
      const topicWires = (this.data.wiring?.wires || []).filter(w => w.topic === topic);

      countAll++;
      if (cat.kind === 'dedicated' || cat.kind === 'direct') countDedicated++;
      else if (cat.kind === 'shared' || cat.kind === 'broadcast' || cat.kind === 'collector' || cat.kind === 'mesh') countShared++;
      else if (cat.kind === 'boundary' || cat.kind === 'external') countBoundary++;

      channelItems.push({
        topic,
        cat,
        providers,
        consumers,
        wires: topicWires
      });
    });

    // 更新各个分类计数器徽章
    if (countEl) setCanvasText(countEl, () => (countAll));
    if ($('count-filter-all')) setCanvasText($('count-filter-all'), () => (countAll));
    if ($('count-filter-dedicated')) setCanvasText($('count-filter-dedicated'), () => (countDedicated));
    if ($('count-filter-shared')) setCanvasText($('count-filter-shared'), () => (countShared));
    if ($('count-filter-boundary')) setCanvasText($('count-filter-boundary'), () => (countBoundary));

    const currentFilter = this.matrixCategoryFilter || 'all';

    // 筛选当前分类 (兼容历史过滤 key)
    const displayItems = channelItems.filter(item => {
      if (currentFilter === 'all') return true;
      if (currentFilter === 'dedicated' || currentFilter === 'direct') return item.cat.kind === 'dedicated' || item.cat.kind === 'direct';
      if (currentFilter === 'shared' || currentFilter === 'broadcast' || currentFilter === 'collector' || currentFilter === 'mesh') {
        return item.cat.kind === 'shared' || item.cat.kind === 'broadcast' || item.cat.kind === 'collector' || item.cat.kind === 'mesh';
      }
      if (currentFilter === 'boundary' || currentFilter === 'external') return item.cat.kind === 'boundary' || item.cat.kind === 'external';
      return item.cat.kind === currentFilter;
    });

    const getProgTitle = (progId) => {
      const p = this.data.programs.find(x => x.programId === progId);
      if (!p) return progId;
      return localizedText(p.title, p.programId);
    };

    if (wiresList) {
      wiresList.replaceChildren();
      if (!displayItems.length) {
        setCanvasHtml(wiresList, () => (`<div style="font-size:12px; color:var(--muted); padding:24px; text-align:center;">${canvasLabel(() => (currentFilter === 'all' ? t('当前暂无任何已建立的通信通道') : t('当前分类下暂无通信通道')))}</div>`));
      } else {
        displayItems.forEach(item => {
          const card = document.createElement('div');
          card.className = 'matrix-channel-card';
          card.style.display = 'flex';
          card.style.flexDirection = 'column';
          card.style.gap = '8px';
          card.style.background = 'rgba(255, 255, 255, 0.03)';
          card.style.border = `1px solid ${item.cat.color}35`;
          card.style.borderLeft = `4px solid ${item.cat.color}`;
          card.style.borderRadius = '6px';
          card.style.padding = '8px 12px';

          // 标题行：分类标签 + 主题名称 + 操作按钮
          const headerRow = document.createElement('div');
          headerRow.style.display = 'flex';
          headerRow.style.justifyContent = 'space-between';
          headerRow.style.alignItems = 'center';

          const titleLeft = document.createElement('div');
          titleLeft.style.display = 'flex';
          titleLeft.style.alignItems = 'center';
          titleLeft.style.gap = '8px';
          setCanvasHtml(titleLeft, () => (`
            <span class="acl-pill" style="background:${item.cat.color}22; color:${item.cat.color}; border:1px solid ${item.cat.color}66; font-weight:700; font-size:11px;">${canvasLabel(() => this.getChannelCategory(item.topic).badge)}</span>
            <code style="font-family:var(--mono); font-size:12px; font-weight:700; color:#fff;">${item.topic}</code>
          `));

          const actionRight = document.createElement('div');
          if (item.wires.length > 0) {
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'hub-btn danger';
            delBtn.style.padding = '2px 8px';
            delBtn.style.fontSize = '10px';
            setCanvasText(delBtn, () => (t('✕ 断开通道')));
            setCanvasAttribute(delBtn, 'title', () => (t('断开此主题 [{topic}] 的全部接线', { topic: item.topic })));
            delBtn.addEventListener('click', async () => {
              await this.disconnectWires(item.wires);
              this.renderWiringMatrixModal();
            });
            actionRight.append(delBtn);
          } else {
            setCanvasHtml(actionRight, () => (`<span style="font-size:11px; color:${item.cat.color}; font-weight:600;">${canvasLabel(() => (t('🌐 通道生效中')))}</span>`));
          }

          headerRow.append(titleLeft, actionRight);

          // 说明行
          const descRow = document.createElement('div');
          descRow.style.fontSize = '11px';
          descRow.style.color = 'var(--muted)';
          setCanvasText(descRow, () => (this.getChannelCategory(item.topic).desc));

          // 拓扑流向图
          const flowRow = document.createElement('div');
          flowRow.style.fontSize = '11px';
          flowRow.style.background = 'rgba(0,0,0,0.2)';
          flowRow.style.padding = '6px 10px';
          flowRow.style.borderRadius = '4px';
          flowRow.style.display = 'flex';
          flowRow.style.alignItems = 'center';
          flowRow.style.gap = '8px';
          flowRow.style.flexWrap = 'wrap';

          if (item.cat.kind === 'dedicated' || item.cat.kind === 'direct') {
            const pList = item.providers;
            const cList = item.consumers;
            const pProgId = pList[0]?.programId;
            const cProgId = cList.find(c => c.programId !== pProgId)?.programId || cList[0]?.programId;
            const p = pList.find(x => x.programId === pProgId) || pList[0];
            const c = cList.find(x => x.programId === cProgId) || cList[0];
            const isBi = item.cat.bidirectional;
            const arrowStr = isBi ? t('◄───── 点对点全双工专线 ─────►') : t('────── 点对点专用专线 ──────►');
            setCanvasHtml(flowRow, () => (`
              <strong style="color:var(--teal);">${getProgTitle(p.programId)} [${p.alias}]</strong>
              <span style="color:#00d2b4; font-weight:700;">${arrowStr}</span>
              <strong style="color:var(--blue);">${getProgTitle(c.programId)} [${c.alias}]</strong>
            `));
          } else if (item.cat.kind === 'shared' || item.cat.kind === 'broadcast' || item.cat.kind === 'collector' || item.cat.kind === 'mesh') {
            const provs = item.providers.map(p => `<span class="acl-pill" style="border-color:#38bdf866; color:#bae6fd;">${getProgTitle(p.programId)} [${p.alias}]</span>`).join(' ');
            const cons = item.consumers.map(c => `<span class="acl-pill" style="border-color:#00d2b466; color:#a7f3d0;">${getProgTitle(c.programId)} [${c.alias}]</span>`).join(' ');
            setCanvasHtml(flowRow, () => (`
              <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span style="color:#fde68a; font-weight:700;">${canvasLabel(() => (t('供应端 ({count}):', { count: item.providers.length })))}</span> ${provs}
                <span style="color:#38bdf8; font-weight:800; margin: 0 4px;">${canvasLabel(() => (t('──► 📡 公共主题总线 ──►')))}</span>
                <span style="color:#a7f3d0; font-weight:700;">${canvasLabel(() => (t('抽取端 ({count}):', { count: item.consumers.length })))}</span> ${cons}
              </div>
            `));
          } else if (item.cat.kind === 'boundary' || item.cat.kind === 'external') {
            if (item.providers.length > 0) {
              const p = item.providers[0];
              setCanvasHtml(flowRow, () => (`
                <strong style="color:#c084fc;">${getProgTitle(p.programId)} [${p.alias}]</strong>
                <span style="color:#818cf8; font-weight:700;">${canvasLabel(() => (t('────── 发送至外部系统 / 独立脚本 ──────►')))}</span>
                <span style="color:var(--muted); font-style:italic;">${canvasLabel(() => (t('(外部应用 / IoT网关 / 全局总线)')))}</span>
              `));
            } else if (item.consumers.length > 0) {
              const c = item.consumers[0];
              setCanvasHtml(flowRow, () => (`
                <span style="color:var(--muted); font-style:italic;">${canvasLabel(() => (t('(外部传感器 / 独立进程 / 全局数据源)')))}</span>
                <span style="color:#ec4899; font-weight:700;">${canvasLabel(() => (t('────── 外部数据接收推送 ──────►')))}</span>
                <strong style="color:#f472b6;">${getProgTitle(c.programId)} [${c.alias}]</strong>
              `));
            }
          }

          card.append(headerRow, descRow, flowRow);
          wiresList.append(card);
        });
      }
    }
  }

  onPairSourceChange() {
    const selSrc = $('sel-pair-source');
    const inpTopic = $('inp-pair-topic');
    if (selSrc && inpTopic && selSrc.value) {
      const parts = selSrc.value.split('|');
      if (parts[3]) {
        inpTopic.value = parts[3].includes('unwired') ? (parts[2] || `${parts[0]}/${parts[2]}`) : parts[3];
      }
    }
  }

  async doPairConnectFromModal() {
    const selSrc = $('sel-pair-source');
    const selTgt = $('sel-pair-target');
    const inpTopic = $('inp-pair-topic');
    if (!selSrc?.value || !selTgt?.value) return;

    const [srcProgId, srcSlot, srcAlias] = selSrc.value.split('|');
    const [tgtProgId, tgtSlot, tgtAlias] = selTgt.value.split('|');
    const topic = inpTopic?.value?.trim() || `${srcProgId}/${srcAlias}`;

    if (srcProgId === tgtProgId) {
      canvasToast(() => (t('同模块内部无需通过枢纽总线接线')), 'error');
      return;
    }

    const source = { programId: srcProgId, slot: srcSlot, alias: srcAlias, topic };
    const target = { programId: tgtProgId, slot: tgtSlot, alias: tgtAlias };

    await this.connectWiring(source, target, topic);
    this.renderWiringMatrixModal();
  }

  filterWiringMatrixTable(keyword) {
    const kw = keyword.toLowerCase().trim();
    const rows = document.querySelectorAll('#matrix-wires-list > div');
    rows.forEach(r => {
      const match = !kw || r.textContent.toLowerCase().includes(kw);
      r.style.display = match ? 'flex' : 'none';
    });
  }

  async disconnectWire(wire) {
    return this.disconnectWires([wire]);
  }

  // 17.2 批量/单条连线断开 (采用 0ms 乐观更新机制，避免网络等待与操作迟滞)
  async disconnectWires(wiresList) {
    if (!wiresList || !wiresList.length) return;
    const validWires = wiresList.filter(w => w && ((w.to && w.to.programId && w.to.alias) || (w.from && w.from.programId && w.from.alias)));
    if (!validWires.length) return;

    // 1. 乐观更新 (Optimistic UI)：0毫秒即刻在内存移除连线与重置对接按钮，立刻重绘！
    const snapshots = [];
    const targetMap = new Map();

    const recordSnapshot = (prog) => {
      if (!targetMap.has(prog.programId)) {
        snapshots.push({
          prog,
          oldTopics: { ...prog.topics }
        });
        targetMap.set(prog.programId, prog);
      }
    };

    validWires.forEach(w => {
      if (w.to?.programId && w.to?.alias) {
        let targetProg = this.data.programs.find(p => p.programId === w.to.programId);
        if (targetProg) {
          recordSnapshot(targetProg);
          const uniqueUnwired = `${targetProg.programId}/${w.to.alias}/unwired-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          targetProg.topics = { ...targetProg.topics, [w.to.alias]: uniqueUnwired };
        }
      }

      if (w.from?.programId && w.from?.alias) {
        let srcProg = this.data.programs.find(p => p.programId === w.from.programId);
        if (srcProg) {
          recordSnapshot(srcProg);
          const uniqueUnwiredSrc = `${srcProg.programId}/${w.from.alias}/unwired-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          srcProg.topics = { ...srcProg.topics, [w.from.alias]: uniqueUnwiredSrc };
        }
      }
    });

    const oldWires = [...(this.data.wiring?.wires || [])];
    if (this.data.wiring?.wires) {
      this.data.wiring.wires = this.data.wiring.wires.filter(existing =>
        !validWires.some(w =>
          (w.to?.programId && existing.to?.programId === w.to.programId && existing.to?.alias === w.to.alias) ||
          (w.from?.programId && existing.from?.programId === w.from.programId && existing.from?.alias === w.from.alias) ||
          (w.topic && existing.topic === w.topic)
        )
      );
    }

    validWires.forEach(w => {
      if (w.topic && this.data.wiring) {
        delete this.data.wiring.topicProviders?.[w.topic];
        delete this.data.wiring.topicConsumers?.[w.topic];
      }
    });

    // 0 毫秒即刻重绘界面！线缆瞬间消失，卡片按钮瞬间恢复！
    this.render();
    canvasToast(() => (t('已断开接线通道')), 'neutral');

    // 2. 压入后台事务队列排队串行持久化，彻底消除并发冲突与回弹
    this.enqueueMutation(async () => {
      try {
        const csrf = window.hubCanvas?.state?.data?.csrfToken || '';
        for (const prog of targetMap.values()) {
          await this.applyProgramConfiguration(prog, csrf);
        }
      } catch (e) {
        console.warn('断开接线后台同步异常:', e);
        snapshots.forEach(s => { s.prog.topics = s.oldTopics; });
        if (this.data.wiring) this.data.wiring.wires = oldWires;
        this.render();
        canvasToast(() => (t('断开接线失败: {error}', { error: e.message })), 'error');
      }
    });
  }

  // 18. 依赖建立、循环死锁检测与移除
  async connectDependency(targetId, prerequisiteId) {
    const plan = this.getActivePlan();
    if (!plan) return;

    // 循环依赖死锁检测
    if (this.wouldCreateCycle(targetId, prerequisiteId)) {
      canvasToast(() => (t('⚠️ 拒绝连接：添加依赖将造成循环死锁 ({from} ↔ {to})', { from: prerequisiteId, to: targetId })), 'error');
      return;
    }

    if (!plan.members) plan.members = [];
    let member = plan.members.find(m => m.programId === targetId);
    if (!member) {
      member = { programId: targetId, enabled: false, after: [] };
      plan.members.push(member);
    }

    const currentAfter = new Set(member.after || []);
    if (currentAfter.has(prerequisiteId)) return;
    currentAfter.add(prerequisiteId);
    member.after = [...currentAfter];

    if (await this.saveActivePlan(plan, true)) canvasToast(() => (t('✓ 已添加启动依赖: {from} → {to}', { from: prerequisiteId, to: targetId })), 'neutral');
  }

  wouldCreateCycle(targetId, prerequisiteId) {
    // 检查 prerequisiteId 是否已经依赖了 targetId
    const plan = this.getActivePlan()?.members || [];
    const visited = new Set();
    const queue = [prerequisiteId];

    while (queue.length) {
      const cur = queue.shift();
      if (cur === targetId) return true;
      if (!visited.has(cur)) {
        visited.add(cur);
        const member = plan.find(m => m.programId === cur);
        if (member) {
          for (const dep of member.after || []) queue.push(dep);
        }
      }
    }
    return false;
  }

  async removeDependency(targetId, prerequisiteId) {
    const plan = this.getActivePlan();
    if (!plan || !plan.members) return;
    const member = plan.members.find(m => m.programId === targetId);
    if (!member) return;

    member.after = (member.after || []).filter(id => id !== prerequisiteId);
    canvasToast(() => (t('已移除启动依赖: {from} → {to}', { from: prerequisiteId, to: targetId })), 'neutral');
    await this.saveActivePlan(plan, true);
    if (this.selectedModuleId === targetId) this.selectModule(targetId);
  }

  // Instance execution policies belong to the external process manager, never Hub business routing.
  executionText(source, params = {}) {
    return window.hubCanvas?.translate?.(source, params) ?? source.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(params, key) ? String(params[key]) : token);
  }

  executionReviewText(policy, source) {
    return t('运行方式：{mode}；空闲等待 {seconds} 秒；来源：{source}；允许唤醒的调用者：{callers}。', {
      mode: t(policy.mode === 'on-demand' ? '按需' : '常驻'), seconds: policy.idleTimeoutMs / 1000,
      source: t(source === 'local' ? '保留本机策略' : source === 'module-group' ? '模块组作者默认' : source === 'module' ? '模块作者默认' : '内建默认'),
      callers: policy.allowedCallers?.join(', ') || t('无')
    });
  }

  renderExecutionPolicy(prog) {
    const box = $('ins-execution-policy');
    if (!box) return;
    const session = { programId: prog.programId, expectedRevision: prog.executionPolicyRevision };
    this.executionPolicySession = session;
    box.replaceChildren();
    const planNote = prog.executionPolicy?.mode === 'on-demand'
      ? '按需模块不随编排启动；可保留计划选择，切回常驻后生效。保存不会立即启动。'
      : '常驻模块仅在已加入计划且用户执行编排时启动；保存不会立即启动。';
    if ($('ins-plan-mode-note')) { $('ins-plan-mode-note').setAttribute('data-i18n', planNote); setCanvasText($('ins-plan-mode-note'), () => (this.executionText(planNote))); }
    const create = (tag, id, text, parent = box) => {
      const node = document.createElement(tag); if (id) node.id = id;
      if (text) { node.setAttribute('data-i18n', text); setCanvasText(node, () => (this.executionText(text))); }
      parent.append(node); return node;
    };
    create('h3', '', '模块运行策略');
    create('p', '', '策略对本机实例生效，所有共享此实例的模块组一致。保存策略不会立即启停现有进程。').className = 'action-help-text';
    const shared = (this.data.groups || []).filter(group => (group.memberProgramIds || []).includes(prog.programId));
    if (shared.length) setCanvasText(create('p', '', ''), () => (this.executionText('共享此实例的模块组：{groups}', { groups: shared.map(group => group.title || group.id).join('、') })));
    const modeLabel = create('label', '', ''); modeLabel.className = 'form-label'; create('span', '', '运行方式', modeLabel);
    const mode = create('select', 'ins-execution-mode', '', modeLabel); mode.className = 'drawer-input';
    for (const [value, text] of [['resident', '常驻（加入计划后随编排启动）'], ['on-demand', '按需（授权调用时自动唤醒）']]) {
      const option = create('option', '', text, mode); option.value = value;
    }
    mode.value = prog.executionPolicy?.mode || 'resident';
    const details = create('div', 'ins-execution-demand-fields', '');
    const idleLabel = create('label', '', '', details); idleLabel.className = 'form-label'; create('span', '', '空闲停止等待（秒）', idleLabel);
    const idle = create('input', 'ins-execution-idle-seconds', '', idleLabel); idle.type = 'number'; idle.min = '1'; idle.max = '86400'; idle.step = '1'; idle.className = 'drawer-input';
    idle.value = String((prog.executionPolicy?.idleTimeoutMs ?? 60000) / 1000);
    create('p', '', '允许唤醒此模块的调用者', details).className = 'form-label';
    create('p', '', '默认不授权任何调用者。仅支持生命周期租约的调用会自动唤醒；普通消息不会启动模块，未改造模块仍可手动启动。', details).className = 'action-help-text';
    create('p', '', '首次启用按需唤醒后，已在运行的调用者需要重启以取得生命周期通讯配置。后续修改策略无需重启 Hub。', details).className = 'action-help-text';
    const allowed = new Set(prog.executionPolicy?.allowedCallers || []);
    const callers = create('div', 'ins-execution-callers', '', details);
    this.executionCallerInputs = [];
    const candidates = (this.data.programs || []).filter(row => row.programId !== prog.programId);
    for (const id of allowed) if (!candidates.some(row => row.programId === id)) candidates.push({ programId: id, title: id });
    for (const candidate of candidates) {
      const label = create('label', '', '', callers); label.style.display = 'block'; label.className = 'form-label';
      const input = create('input', '', '', label); input.type = 'checkbox'; input.checked = allowed.has(candidate.programId); input.dataset.programId = candidate.programId;
      const name = localizedText(candidate.title, candidate.programId);
      const missing = !(this.data.programs || []).some(row => row.programId === candidate.programId);
      setCanvasText(create('span', '', '', label), () => (` ${localizedText(candidate.title, candidate.programId)} · ${candidate.programId}${missing ? this.executionText('（已卸载，请取消授权）') : ''}`));
      this.executionCallerInputs.push(input);
    }
    if (!candidates.length) create('p', '', '尚无可选调用者；导入其他模块后再授权。', callers);
    create('p', '', '仅自动唤醒的进程在所有调用正常完成后计算空闲时间。任务超时或断线后状态未知时不自动停止；手动启动会保持运行，需手动停止。', details).className = 'action-help-text';
    const note = create('p', 'ins-execution-policy-error', ''); note.setAttribute('role', 'status');
    const save = create('button', 'btn-ins-save-execution-policy', '保存运行策略'); save.type = 'button'; save.className = 'action-btn';
    save.disabled = this.savingExecutionPolicyIds?.has(prog.programId) === true;
    save.addEventListener('click', () => this.saveExecutionPolicy());
    const updateMode = () => { details.classList.toggle('hidden', mode.value !== 'on-demand'); };
    mode.addEventListener('change', updateMode); updateMode();
    create('p', 'ins-execution-status', '正在读取按需运行状态…').className = 'action-help-text';
    const refresh = create('button', 'btn-ins-refresh-execution', '刷新运行状态'); refresh.type = 'button'; refresh.className = 'action-btn';
    refresh.addEventListener('click', () => this.refreshExecutionStatus(session.programId));
  }

  async saveExecutionPolicy() {
    const session = this.executionPolicySession;
    if (!session || this.selectedModuleId !== session.programId) return;
    this.savingExecutionPolicyIds ??= new Set();
    if (this.savingExecutionPolicyIds.has(session.programId)) return;
    const current = () => this.executionPolicySession === session && this.selectedModuleId === session.programId;
    const error = (text, params) => { if (current() && $('ins-execution-policy-error')) setCanvasText($('ins-execution-policy-error'), () => (this.executionText(text, params))); };
    const mode = $('ins-execution-mode')?.value;
    const secondsText = $('ins-execution-idle-seconds')?.value?.trim();
    const seconds = Number(secondsText);
    if (!['resident', 'on-demand'].includes(mode) || !secondsText || !Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
      error('请选择有效运行方式，空闲等待须为 1 至 86400 的整数秒。'); return;
    }
    const allowedCallers = (this.executionCallerInputs || []).filter(input => input.checked).map(input => input.dataset.programId);
    if (allowedCallers.some(id => id === session.programId || !(this.data.programs || []).some(row => row.programId === id))) {
      error('所选调用者已不可用，请取消已卸载模块的授权后保存。'); return;
    }
    const policy = { mode, idleTimeoutMs: seconds * 1000, allowedCallers };
    this.savingExecutionPolicyIds.add(session.programId); $('btn-ins-save-execution-policy').disabled = true; error('正在保存运行策略…');
    let committed = false;
    try {
      const response = await fetch(`/manage/api/programs/${encodeURIComponent(session.programId)}/execution-policy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
        body: JSON.stringify({ expectedRevision: session.expectedRevision, policy })
      });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(errorText(result));
      committed = true;
      // No optimistic writes: a rejected or stale response cannot alter another drawer's draft.
      if (current()) {
        const index = this.data.programs.findIndex(row => row.programId === session.programId);
        if (index >= 0 && result.program) this.data.programs[index] = result.program;
        session.expectedRevision = result.program?.executionPolicyRevision ?? session.expectedRevision;
        error('运行策略已保存；现有进程不会立即启停。');
      }
      const refreshed = await this.fetchModulesData();
      if (refreshed?.refreshed === false) throw refreshed.error || new Error('列表刷新失败');
      if (current()) {
        const prog = this.data.programs.find(row => row.programId === session.programId);
        if (prog) { this.renderExecutionPolicy(prog); if ($('ins-execution-policy-error')) setCanvasText($('ins-execution-policy-error'), () => (this.executionText('运行策略已保存；现有进程不会立即启停。'))); }
        this.refreshExecutionStatus(session.programId);
      }
    } catch (failure) {
      error(committed ? '运行策略已保存，但列表刷新失败：{error}。请刷新页面。' : '运行策略保存失败：{error}', { error: failure.message });
    } finally {
      this.savingExecutionPolicyIds.delete(session.programId);
      if (this.selectedModuleId === session.programId && $('btn-ins-save-execution-policy')) $('btn-ins-save-execution-policy').disabled = false;
    }
  }

  executionStatusText(row) {
    if (!row) return this.executionText('此实例暂无按需运行记录。');
    const parts = [this.executionText('进行中的调用：{count}', { count: row.activeLeaseCount || 0 }), this.executionText('状态未知的调用：{count}', { count: row.uncertainLeaseCount || 0 })];
    if (row.pinned) parts.push(this.executionText('手动启动，保持运行'));
    else if (row.uncertainLeaseCount > 0) parts.push(this.executionText('任务状态未知，暂停自动停止'));
    else if (row.idleStopAt) parts.push(this.executionText('等待空闲停止：{time}', { time: new Date(row.idleStopAt).toLocaleTimeString() }));
    else if (row.autoStarted) parts.push(this.executionText('由授权调用自动唤醒'));
    if (row.lastError) parts.push(typeof row.lastError === 'string' ? row.lastError : row.lastError.message || row.lastError.code || this.executionText('按需运行异常'));
    return parts.join(' · ');
  }

  executionPlanSummary(results = [], skipped = []) {
    return this.executionText('常驻计划完成：已启动或保持运行 {started} 个，按需跳过 {demand} 个，未选中 {unselected} 个。', {
      started: results.filter(row => ['started', 'running', 'already-running'].includes(row.state)).length,
      demand: skipped.filter(row => row.reason === 'on-demand').length,
      unselected: skipped.filter(row => row.reason === 'not-selected').length
    });
  }

  executionServiceStatus(result, programId) {
    if (result.enabled === false) return this.executionText('按需唤醒未启用；常驻模块按计划运行。');
    const row = (result.programs || []).find(item => item.programId === programId);
    const detail = this.executionStatusText(row);
    if (result.available !== false) return detail;
    const message = typeof result.lastError === 'string' ? result.lastError : result.lastError?.message || result.error?.message;
    return [this.executionText('按需唤醒服务当前不可用；仍可手动启动模块。'), detail, message].filter(Boolean).join(' · ');
  }

  async refreshExecutionStatus(programId = this.selectedModuleId) {
    const session = this.executionPolicySession;
    if (!session || session.programId !== programId || this.selectedModuleId !== programId) return;
    const request = {}; this.executionStatusRequest = request;
    const current = () => this.executionPolicySession === session && this.executionStatusRequest === request && this.selectedModuleId === programId;
    try {
      const response = await fetch('/manage/api/execution/status'); const result = await response.json();
      if (!response.ok || result.error) throw new Error(errorText(result));
      if (current() && $('ins-execution-status')) {
        this.executionStatus = result;
        $('ins-execution-status').removeAttribute('data-i18n');
        setCanvasText($('ins-execution-status'), () => (this.executionServiceStatus(result, programId)));
      }
    } catch (failure) {
      if (current() && $('ins-execution-status')) { $('ins-execution-status').removeAttribute('data-i18n'); setCanvasText($('ins-execution-status'), () => (this.executionText('读取运行状态失败：{error}', { error: failure.message }))); }
    }
  }

  async saveSelectedPlanMembership() {
    const programId = this.selectedModuleId, scope = this.groupFilter;
    if (!programId || this.savingPlanMember) return;
    const enabled = $('ins-plan-enabled')?.checked === true;
    const plan = this.getActivePlan(), member = plan.members.find(row => row.programId === programId);
    if (!member) return;
    member.enabled = enabled;
    this.savingPlanMember = true;
    if ($('btn-ins-save-plan-member')) $('btn-ins-save-plan-member').disabled = true;
    try { await this.saveActivePlan(plan, false, scope); }
    finally { this.savingPlanMember = false; if ($('btn-ins-save-plan-member')) $('btn-ins-save-plan-member').disabled = false; }
  }

  executionPolicyBadge(prog, x, y) {
    const demand = prog.executionPolicy?.mode === 'on-demand';
    const badge = svgEl('g', { transform: `translate(${x}, ${y})`, 'pointer-events': 'none', class: 'cmn-execution-policy-badge' });
    badge.append(svgEl('rect', { width: 62, height: 16, rx: 4, fill: demand ? '#23334b' : '#113c35', stroke: demand ? '#7db4ee' : '#39c7a0', 'stroke-width': '.6' }),
      svgEl('text', { x: 31, y: 11, 'text-anchor': 'middle', 'font-size': '9px', fill: demand ? '#a3cbff' : '#8ee6d1' }, this.executionText(demand ? '按需' : '常驻')));
    return badge;
  }

  renderLanguage() {
    window.hubCanvas?.applyCanvasLabels?.();
    for (const selector of canvasRoots) {
      const root = document.querySelector?.(selector);
      if (!root) continue;
      window.hubCanvas?.applyLabels?.(root);
      refreshCanvasBindings(root);
    }

    const perspBtn = $('btn-perspective-toggle');
    if (perspBtn) {
      setCanvasText(perspBtn, () => (this.runtimePerspective === 'topology' ? t('🗺 拓扑卡片') : t('🪐 天体星轨')));
      setCanvasAttribute(perspBtn, 'title', () => (t('在微服务拓扑卡片与天体同心圆轨道视角间切换')));
    }

    const layoutBtn = $('btn-auto-layout-ctrl');
    if (layoutBtn) {
      setCanvasAttribute(layoutBtn, 'title', () => (t('智能排版 (按层级自整齐)')));
      setCanvasAttribute(layoutBtn, 'aria-label', () => (t('智能排版')));
    }

    const dockAdd = $('btn-dock-add-menu');
    if (dockAdd) {
      setCanvasAttribute(dockAdd, 'data-tooltip', () => (t('➕ 添加与创作 (6 大功能)')));
      setCanvasAttribute(dockAdd, 'title', () => (t('➕ 添加与创作 (6 大功能)')));
    }

    this.updateGroupActionButtons();
    this.updateModeUI();

    this.render();
  }

  renderExecutionLanguage() {
    const box = $('ins-execution-policy');
    if (box) window.hubCanvas?.applyLabels?.(box);
    if (box && this.executionStatus && this.executionPolicySession?.programId === this.selectedModuleId && $('ins-execution-status')) {
      setCanvasText($('ins-execution-status'), () => (this.executionServiceStatus(this.executionStatus, this.selectedModuleId)));
    }
    this.updateGroupActionButtons();
    this.render();
  }

  // 19. 检查器展现与交互
  selectModule(programId) {
    this.selectedModuleId = programId;
    this.selectedGroupId = null;
    this.render();

    const prog = this.data.programs.find(p => p.programId === programId);
    if (!prog) return;

    const title = localizedText(prog.title, prog.module?.id || prog.programId);

    $('ins-bridge-content')?.classList.add('hidden');
    $('ins-program-content')?.classList.add('hidden');
    $('ins-group-content')?.classList.add('hidden');
    $('ins-module-content')?.classList.remove('hidden');

    const verBtn = $('btn-ins-versions');
    if (verBtn) {
      verBtn.classList.remove('hidden');
      const info = this.getModuleUpdateInfo(prog);
      verBtn.replaceChildren();
      const icon = document.createElement('span'); setCanvasText(icon, () => ('🏷 '));
      const text = document.createElement('span'); setCanvasText(text, () => (info.currentVersion ? `v${info.currentVersion}` : t('版本')));
      verBtn.append(icon, text);
      if (info.hasUpdate) {
        const badge = document.createElement('span');
        badge.className = 'vm-update-badge';
        setCanvasText(badge, () => (` ⬆ v${info.latestVersion}`));
        verBtn.append(badge);
        setCanvasAttribute(verBtn, 'title', () => (t('发现可用新版本: v{latest} (当前 v{current}) · 点击管理与升级', { latest: info.latestVersion, current: info.currentVersion })));
        verBtn.classList.add('has-update');
      } else {
        setCanvasAttribute(verBtn, 'title', () => (info.currentVersion ? t('版本管理 (当前 v{ver} · 已是最新)', { ver: info.currentVersion }) : t('版本管理 (尚未建立发行基线)')));
        verBtn.classList.remove('has-update');
      }
    }

    setCanvasText($('ins-title'), () => (localizedText(prog.title, prog.module?.id || prog.programId)));
    setCanvasText($('ins-key'), () => (t('模块实例 · {id}', { id: prog.programId })));
    setCanvasText($('ins-mod-name'), () => (localizedText(prog.title, prog.module?.id || prog.programId)));
    setCanvasText($('ins-mod-desc'), () => (localizedText(prog.deployment?.description, t('外部独立程序，通过世界枢纽完成语义通讯与数据订阅。'))));

    const isRunning = prog.state === 'running';
    const isFailed = prog.state === 'failed';
    setCanvasText($('ins-mod-status'), () => (isRunning ? t('● 运行中') : isFailed ? t('▲ 异常') : t('○ 已停止')));
    $('ins-mod-status').className = `acl-pill ${isRunning ? 'online' : ''}`;

    // PID 与运行时元信息
    setCanvasText($('ins-mod-meta'), () => (
      t('ID: {id} · 语言: {lang}', { id: prog.programId, lang: prog.manifest?.runtime?.kind || 'node' })
      + (isRunning && prog.pid ? ` · PID: ${prog.pid}` : '')
      + (prog.startedAt ? ` · ${t('启动:')} ${new Date(prog.startedAt).toLocaleTimeString(window.hubCanvas?.language)}` : '')
    ));

    // 故障诊断提示
    const errBox = $('ins-mod-error-box');
    if (isFailed && prog.error) {
      errBox.classList.remove('hidden');
      setCanvasText($('ins-mod-error-code'), () => (t('诊断: {code}', { code: prog.error.code || t('启动失败') })));
      setCanvasText($('ins-mod-error-msg'), () => (prog.error.message || t('进程异常退出')));
    } else {
      errBox.classList.add('hidden');
    }

    // 渲染实例参数表单
    const settingsBox = $('ins-settings-fields');
    settingsBox.replaceChildren();
    const settingsEntries = Object.entries(prog.settings || {});
    if (!settingsEntries.length) {
      setCanvasHtml(settingsBox, () => (`<div style="font-size:11px; color:var(--muted); margin:4px 0;">${canvasLabel(() => (t('该模块无特殊公开配置项。')))}</div>`));
    } else {
      for (const [k, v] of settingsEntries) {
        const row = document.createElement('div');
        row.style.marginBottom = '8px';
        setCanvasHtml(row, () => (`
          <label class="form-label">${k}</label>
          <input type="text" class="drawer-input mod-setting-input" data-key="${k}" value="${v}">
        `));
        settingsBox.append(row);
      }
    }

    // 环境覆盖项 (Node / Python)
    const envBox = document.createElement('div');
    envBox.style.marginTop = '10px';
    setCanvasHtml(envBox, () => (`
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <label class="form-label" style="margin:0;">${canvasLabel(() => (t('运行环境可执行文件 (可选覆盖)')))}</label>
        <button type="button" class="hud-action-pill" id="btn-ins-probe-env" style="padding:2px 8px; font-size:10px;">${canvasLabel(() => (t('🔍 探测环境')))}</button>
      </div>
      <input type="text" class="drawer-input" id="inp-env-override" value="${prog.environment?.nodePath || prog.environment?.pythonPath || ''}" ${canvasAttribute('placeholder', () => (t('默认使用系统 PATH')))} style="margin-top:4px;">
    `));
    settingsBox.append(envBox);
    envBox.querySelector('#btn-ins-probe-env')?.addEventListener('click', () => this.openEnvModal());

    // 分组归属下拉选项
    const groupAssign = $('ins-mod-group-assign');
    groupAssign.replaceChildren();
    groupAssign.append(canvasOption(() => (t('（无所属组 / 全局独立）')), 'none'));
    for (const g of this.data.groups || []) {
      const isMember = (g.memberProgramIds || []).includes(prog.programId);
      const opt = canvasOption(() => (g.title || g.id), g.id, false, isMember);
      groupAssign.append(opt);
    }

    // 渲染通道接线
    const topicsBox = $('ins-topics-list');
    topicsBox.replaceChildren();

    const candidateTopics = [];
    (this.data.programs || []).forEach(p => {
      if (p.programId !== prog.programId) {
        const pTitle = localizedText(p.title, p.programId);
        for (const [pAlias, pTopic] of Object.entries(p.topics || {})) {
          if (pTopic && !candidateTopics.some(c => c.topic === pTopic)) {
            candidateTopics.push({ topic: pTopic, fromTitle: pTitle, fromId: p.programId, alias: pAlias });
          }
        }
      }
    });

    const topicEntries = Object.entries(prog.topics || {});
    if (!topicEntries.length) {
      setCanvasHtml(topicsBox, () => (`<div style="font-size:11px; color:var(--muted);">${canvasLabel(() => (t('此模块未声明通信通道')))}</div>`));
    } else {
      for (const [alias, topic] of topicEntries) {
        const item = document.createElement('div');
        item.style.padding = '8px 10px';
        item.style.marginBottom = '8px';
        item.style.background = 'rgba(255,255,255,0.03)';
        item.style.borderRadius = '6px';
        item.style.border = '1px solid var(--border)';
        setCanvasHtml(item, () => (`
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <strong style="font-size:11px; color:var(--teal);">${alias}</strong>
            <span style="font-size:10px; color:var(--muted);">${canvasLabel(() => (t('当前:')))} <code style="color:var(--ink);">${topic}</code></span>
          </div>
          <div style="display:flex; flex-direction:column; gap:4px;">
            <input type="text" class="drawer-input mod-topic-input" data-alias="${alias}" value="${topic}" style="font-size:11px; font-family:var(--mono);">
            <select class="drawer-input quick-topic-select" data-alias="${alias}" style="font-size:10px;">
              <option value="" data-i18n="💡 快捷对齐现有通道...">${t('💡 快捷对齐现有通道...')}</option>
              ${candidateTopics.map(c => `<option value="${c.topic}">${c.topic} (${c.fromTitle} · ${c.alias})</option>`).join('')}
            </select>
          </div>
        `));

        const sel = item.querySelector('.quick-topic-select');
        const inp = item.querySelector('.mod-topic-input');
        sel.addEventListener('change', () => {
          if (sel.value) inp.value = sel.value;
        });

        topicsBox.append(item);
      }

      const saveTopicsBtn = document.createElement('button');
      saveTopicsBtn.type = 'button';
      saveTopicsBtn.className = 'action-btn';
      saveTopicsBtn.style.cssText = 'background:var(--teal); color:#050a12; font-weight:800; margin-top:8px; width:100%;';
      setCanvasText(saveTopicsBtn, () => (t('保存接线通道并重新生效')));
      saveTopicsBtn.addEventListener('click', () => this.saveTopicsFromDrawer());
      topicsBox.append(saveTopicsBtn);
    }

    // 渲染依赖列表与添加下拉
    const depsBox = $('ins-deps-list');
    depsBox.replaceChildren();
    const planMember = (this.getActivePlan()?.members || []).find(m => m.programId === prog.programId);
    if ($('ins-plan-enabled')) $('ins-plan-enabled').checked = planMember?.enabled === true;
    if ($('ins-plan-mode-note')) setCanvasText($('ins-plan-mode-note'), () => (prog.executionPolicy?.mode === 'on-demand'
      ? t('按需模块不随编排启动；可保留计划选择，切回常驻后生效。保存不会立即启动。')
      : t('常驻模块仅在已加入计划且用户执行编排时启动；保存不会立即启动。')));
    this.renderExecutionPolicy(prog);
    this.refreshExecutionStatus(prog.programId);
    const afterList = planMember?.after || [];
    if (!afterList.length) {
      setCanvasHtml(depsBox, () => (`<div style="font-size:11px; color:var(--muted);">${canvasLabel(() => (t('无前置依赖（第一阶段可直接启动）')))}</div>`));
    } else {
      afterList.forEach(depId => {
        const depProg = this.data.programs.find(p => p.programId === depId);
        const depTitle = localizedText(depProg?.title, depId);
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.padding = '4px 8px';
        row.style.background = 'rgba(245,158,11,0.08)';
        row.style.border = '1px solid rgba(245,158,11,0.3)';
        row.style.borderRadius = '6px';
        row.style.marginBottom = '4px';
        setCanvasHtml(row, () => (`
          <span style="font-size:11px; color:var(--amber);">⏱ ${depTitle}</span>
          <button type="button" class="hud-btn" style="padding:1px 6px; font-size:10px;" data-remove-dep="${depId}">${canvasLabel(() => (t('移除')))}</button>
        `));
        row.querySelector('[data-remove-dep]').addEventListener('click', () => {
          this.removeDependency(prog.programId, depId);
        });
        depsBox.append(row);
      });
    }

    // 添加依赖下拉框填充其他模块
    const addDepSelect = $('ins-add-dep-select');
    setCanvasHtml(addDepSelect, () => (`<option value="" data-i18n="+ 选择前置依赖模块...">${t('+ 选择前置依赖模块...')}</option>`));
    this.data.programs.forEach(p => {
      if (p.programId !== prog.programId && !afterList.includes(p.programId)) {
        const pTitle = localizedText(p.title, p.programId);
        addDepSelect.append(canvasOption(() => (localizedText(p.title, p.programId)), p.programId));
      }
    });

    window.hubCanvas?.openInspector(document.activeElement, true);
  }

  selectGroup(groupId) {
    this.selectedGroupId = groupId;
    this.selectedModuleId = null;
    if (window.hubCanvas?.state) {
      window.hubCanvas.state.selected = null;
      window.hubCanvas.state.selectedProgram = null;
      window.hubCanvas.state.dirty = false;
    }
    this.render();

    const group = (this.data.groups || []).find(g => g.id === groupId);
    if (!group) return;

    $('ins-bridge-content')?.classList.add('hidden');
    $('ins-program-content')?.classList.add('hidden');
    $('ins-module-content')?.classList.add('hidden');
    $('ins-group-content')?.classList.remove('hidden');

    const verBtn = $('btn-ins-versions');
    if (verBtn) {
      verBtn.classList.remove('hidden');
      const info = this.getGroupUpdateInfo(group);
      verBtn.replaceChildren();
      const icon = document.createElement('span'); setCanvasText(icon, () => ('🏷 '));
      const text = document.createElement('span'); setCanvasText(text, () => (info.currentVersion ? `v${info.currentVersion}` : t('组版本')));
      verBtn.append(icon, text);
      if (info.hasUpdate) {
        const badge = document.createElement('span');
        badge.className = 'vm-update-badge';
        setCanvasText(badge, () => (` ⬆ v${info.latestVersion}`));
        verBtn.append(badge);
        setCanvasAttribute(verBtn, 'title', () => (t('发现可用新版本: v{latest} (当前 v{current}) · 点击管理与升级', { latest: info.latestVersion, current: info.currentVersion })));
        verBtn.classList.add('has-update');
      } else {
        setCanvasAttribute(verBtn, 'title', () => (info.currentVersion ? t('模块组版本管理 (当前 v{ver} · 已是最新)', { ver: info.currentVersion }) : t('模块组版本管理 (尚未建立发行基线)')));
        verBtn.classList.remove('has-update');
      }
    }

    const title = group.title || group.id;
    setCanvasText($('ins-title'), () => (localizedText(group.title, group.id)));
    setCanvasText($('ins-key'), () => (t('模块组 · {id}', { id: group.id })));
    setCanvasText($('ins-grp-name'), () => (localizedText(group.title, group.id)));
    setCanvasText($('ins-grp-desc'), () => (localizedText(group.description, t('协同模块组，统一管理组内成员生命周期、内部接线与跨组拓扑。'))));

    const members = (this.data.programs || []).filter(p => (group.memberProgramIds || []).includes(p.programId));
    const runningCount = members.filter(p => p.state === 'running').length;
    const failedCount = members.filter(p => p.state === 'failed').length;
    const stoppedCount = members.length - runningCount - failedCount;
    setCanvasText($('ins-grp-status'), () => ((runningCount > 0 ? '● ' : '○ ') + t('{running} 运行中 · {stopped} 已停止{failed}', { running: runningCount, stopped: stoppedCount, failed: failedCount > 0 ? ` · ${failedCount} ${t('异常')}` : '' })));
    $('ins-grp-status').className = `acl-pill ${runningCount > 0 ? 'online' : ''}`;
    setCanvasText($('ins-grp-meta'), () => (t('组 ID: {id} · 成员数: {count}', { id: group.id, count: members.length })));

    // Reset tabs to members tab
    ['members', 'topics'].forEach(k => {
      $(`tab-grp-${k}`)?.setAttribute('aria-pressed', k === 'members' ? 'true' : 'false');
      $(`ins-grp-panel-${k}`)?.classList.toggle('hidden', k !== 'members');
    });

    this.renderGroupMembersTab(group, members);
    this.renderGroupTopicsTab(group, members);

    window.hubCanvas?.openInspector(document.activeElement, true);
  }

  renderGroupMembersTab(group, members) {
    const countBadge = $('ins-grp-members-count');
    if (countBadge) setCanvasText(countBadge, () => (t('{count} 个成员', { count: members.length })));
    const list = $('ins-grp-members-list');
    if (!list) return;
    list.replaceChildren();

    if (!members.length) {
      setCanvasHtml(list, () => (`<div style="font-size:11px; color:var(--muted); padding:8px 0;">${canvasLabel(() => (t('该模块组内暂无成员模块。')))}</div>`));
      return;
    }

    members.forEach(prog => {
      const isRunning = prog.state === 'running';
      const isFailed = prog.state === 'failed';
      const pTitle = localizedText(prog.title, prog.module?.id || prog.programId);

      const card = document.createElement('div');
      card.style.cssText = 'background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:8px; padding:10px 12px; display:flex; justify-content:space-between; align-items:center; gap:8px;';
      setCanvasHtml(card, () => (`
        <div style="flex:1; min-width:0;">
          <div style="display:flex; align-items:center; gap:6px; margin-bottom:2px;">
            <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${isRunning ? '#10b981' : isFailed ? '#f43f5e' : '#64748b'};"></span>
            <strong style="font-size:12px; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${canvasLabel(() => localizedText(prog.title, prog.module?.id || prog.programId))}</strong>
          </div>
          <div style="font-size:10px; font-family:var(--mono); color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${prog.programId} · ${canvasLabel(() => (prog.module?.version ? 'v' + prog.module.version : t('无版本')))}</div>
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button type="button" class="hud-btn" data-btn-inspect style="padding:2px 8px; font-size:11px;">${canvasLabel(() => (t('🔍 查看')))}</button>
          <button type="button" class="hud-btn ${isRunning ? 'danger' : 'primary'}" data-btn-toggle style="padding:2px 8px; font-size:11px;">${isRunning ? '■' : '▶'}</button>
        </div>
      `));
      card.querySelector('[data-btn-inspect]').onclick = () => this.selectModule(prog.programId);
      card.querySelector('[data-btn-toggle]').onclick = async () => {
        if (isRunning) await this.stopProgram(prog.programId);
        else await this.startProgram(prog.programId);
        if (this.selectedGroupId === group.id) this.selectGroup(group.id);
      };
      list.append(card);
    });
  }

  renderGroupTopicsTab(group, members) {
    const list = $('ins-grp-topics-list');
    if (!list) return;
    list.replaceChildren();

    const memberIds = new Set(members.map(m => m.programId));
    const allWires = this.data.wiring?.wires || [];
    const internalWires = allWires.filter(w => memberIds.has(w.from?.programId) && memberIds.has(w.to?.programId));
    const incomingWires = allWires.filter(w => !memberIds.has(w.from?.programId) && memberIds.has(w.to?.programId));
    const outgoingWires = allWires.filter(w => memberIds.has(w.from?.programId) && !memberIds.has(w.to?.programId));

    const makeSection = (title, wires, icon) => {
      const sec = document.createElement('div');
      sec.style.cssText = 'margin-bottom:12px;';
      setCanvasHtml(sec, () => (`<div style="font-size:11px; font-weight:700; color:var(--ink-dim); margin-bottom:6px;">${icon} ${title} (${wires.length})</div>`));
      if (!wires.length) {
        sec.innerHTML += `<div style="font-size:11px; color:var(--muted); font-style:italic;">${canvasLabel(() => (t('无相关接线')))}</div>`;
      } else {
        const ul = document.createElement('div');
        ul.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
        wires.forEach(w => {
          const item = document.createElement('div');
          item.style.cssText = 'font-size:11px; background:rgba(255,255,255,0.02); border:1px solid var(--border); border-radius:6px; padding:4px 8px; font-family:var(--mono); color:var(--teal);';
          setCanvasText(item, () => (`${w.from?.programId || '?'}:${w.from?.alias || ''} ──> ${w.to?.programId || '?'}:${w.to?.alias || ''} (${w.topic || ''})`));
          ul.append(item);
        });
        sec.append(ul);
      }
      return sec;
    };

    list.append(makeSection(t('组内互联通道'), internalWires, '🔄'));
    list.append(makeSection(t('外部输入通道'), incomingWires, '📥'));
    list.append(makeSection(t('对外输出通道'), outgoingWires, '📤'));
  }

  async startGroupById(groupId) {
    try {
      const res = await fetch(`/manage/api/groups/${groupId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
        body: JSON.stringify({})
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && !data.error) {
        const results = data.results || data.result?.results || [];
        const failed = results.some(row => ['failed', 'blocked', 'cancelled', 'not-started'].includes(row.state));
        canvasToast(() => (this.executionPlanSummary(results, data.skipped || data.result?.skipped || [])), failed ? 'error' : 'neutral');
        await this.fetchModulesData();
        if (this.selectedGroupId === groupId) this.selectGroup(groupId);
      } else {
        canvasToast(() => (t('启动失败: {error}', { error: errorText(data) })), 'error');
      }
    } catch (e) {
      canvasToast(() => (t('启动失败: {error}', { error: e.message })), 'error');
    }
  }

  async stopGroupById(groupId) {
    try {
      const res = await fetch(`/manage/api/groups/${groupId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
        body: JSON.stringify({})
      });
      if (res.ok) {
        canvasToast(() => (t('已触发模块组停止流程')), 'neutral');
        await this.fetchModulesData();
        if (this.selectedGroupId === groupId) this.selectGroup(groupId);
      } else {
        const err = await res.json().catch(() => ({}));
        canvasToast(() => (t('停止失败: {error}', { error: err.error?.message || err.message || t('未知错误') })), 'error');
      }
    } catch (e) {
      canvasToast(() => (t('停止失败: {error}', { error: e.message })), 'error');
    }
  }

  openPackageModalForGroup(groupId) {
    const sel = $('inp-pkg-group');
    if (sel) sel.value = groupId;
    this.openPackageModal();
  }

  addPrerequisiteFromDrawer() {
    if (!this.selectedModuleId) return;
    const prereqId = $('ins-add-dep-select')?.value;
    if (!prereqId) return;
    this.connectDependency(this.selectedModuleId, prereqId);
  }

  async startProgram(id) {
    this.updateStartupHighlightState({ startingProgramId: id, results: [] });
    try {
      const res = await fetch(`/manage/api/programs/${id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`);
      this.updateStartupHighlightState({ startingProgramId: null, results: [{ programId: id, state: 'started' }] });
      canvasToast(() => (t('✓ 模块进程已启动上线')), 'neutral');
      await this.fetchModulesData();
      if (this.selectedModuleId === id) this.selectModule(id);
      setTimeout(() => this.updateStartupHighlightState(), 1200);
    } catch (e) {
      this.updateStartupHighlightState({ startingProgramId: null, results: [{ programId: id, state: 'failed' }] });
      canvasToast(() => (t('启动失败: {error}', { error: e.message })), 'error');
      setTimeout(() => this.updateStartupHighlightState(), 1800);
    }
  }

  async stopProgram(id) {
    try {
      await fetch(`/manage/api/programs/${id}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
        body: JSON.stringify({})
      });
      this.updateStartupHighlightState();
      canvasToast(() => (t('已发出停止指令，重置模块状态')), 'neutral');
      await this.fetchModulesData();
      if (this.selectedModuleId === id) this.selectModule(id);
    } catch (e) {
      canvasToast(() => (t('停止失败: {error}', { error: e.message })), 'error');
    }
  }

  async startSelectedModule() {
    if (this.selectedModuleId) await this.startProgram(this.selectedModuleId);
  }

  async stopSelectedModule() {
    if (this.selectedModuleId) await this.stopProgram(this.selectedModuleId);
  }

  async removeSelectedModule() {
    if (this.selectedModuleId) return this.openUninstallManager('modules', this.selectedModuleId);
  }

  async saveSelectedModuleConfig() {
    if (!this.selectedModuleId) return;
    const prog = this.data.programs.find(p => p.programId === this.selectedModuleId);
    if (!prog) return;

    const newSettings = {};
    document.querySelectorAll('.mod-setting-input').forEach(inp => {
      newSettings[inp.dataset.key] = inp.value;
    });

    const newTopics = { ...(prog.topics || {}) };
    document.querySelectorAll('.mod-topic-input').forEach(inp => {
      if (inp.dataset.alias) newTopics[inp.dataset.alias] = inp.value.trim();
    });

    const envOverride = $('inp-env-override')?.value?.trim();
    const envPayload = envOverride ? {
      nodePath: (prog.manifest?.runtime?.kind === 'python' ? undefined : envOverride),
      pythonPath: (prog.manifest?.runtime?.kind === 'python' ? envOverride : undefined)
    } : undefined;

    try {
      const res = await fetch(`/manage/api/programs/${this.selectedModuleId}/configuration/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
        body: JSON.stringify({
          expectedRevision: prog.configurationRevision,
          settings: newSettings,
          topics: newTopics,
          environment: envPayload,
          bridges: prog.bridges,
          bindings: prog.bindings
        })
      });
      if (res.ok) {
        // 更新分组归属
        const selectedGroup = $('ins-mod-group-assign')?.value;
        if (selectedGroup) await this.assignModuleGroup(prog.programId, selectedGroup);

        canvasToast(() => (t('模块参数保存成功')), 'neutral');
        await this.fetchModulesData();
      } else {
        const err = await res.json();
        canvasToast(() => (t('保存失败: {error}', { error: err.message })), 'error');
      }
    } catch (e) {
      canvasToast(() => (t('保存异常: {error}', { error: e.message })), 'error');
    }
  }

  async assignModuleGroup(programId, groupId) {
    for (const g of this.data.groups || []) {
      const isMember = (g.memberProgramIds || []).includes(programId);
      if (g.id === groupId && !isMember) {
        g.memberProgramIds = [...(g.memberProgramIds || []), programId];
        await fetch('/manage/api/groups/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
          body: JSON.stringify({ group: g, expectedRevision: g.revision })
        });
      } else if (g.id !== groupId && isMember) {
        g.memberProgramIds = (g.memberProgramIds || []).filter(id => id !== programId);
        await fetch('/manage/api/groups/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
          body: JSON.stringify({ group: g, expectedRevision: g.revision })
        });
      }
    }
  }

  // 20. 日志轮询
  startLogPolling() {
    this.stopLogPolling();
    this.refreshModuleLogs();
    this.logPollTimer = setInterval(() => this.refreshModuleLogs(), 2000);
  }

  stopLogPolling() {
    if (this.logPollTimer) {
      clearInterval(this.logPollTimer);
      this.logPollTimer = null;
    }
  }

  async refreshModuleLogs() {
    if (!this.selectedModuleId) return;
    try {
      const res = await fetch(`/manage/api/programs/${this.selectedModuleId}/logs`);
      if (res.ok) {
        const data = await res.json();
        const logs = data.logs || {};
        setCanvasText($('ins-logs-content'), () => (logs.stdout || logs.stderr || t('暂无控制台日志输出')));
      }
    } catch (e) {
      setCanvasText($('ins-logs-content'), () => (t('读取日志失败: {error}', { error: e.message })));
    }
  }

  // 21. 全量计划与分组批量启停
  async executeStartupPlan() {
    if (this.groupFilter !== 'all') {
      await this.startCurrentGroup();
      return;
    }
    const runBtn = $('btn-run-plan');
    if (runBtn) runBtn.disabled = true;
    let pollTimer = null;
    try {
      const failurePolicy = $('hud-failure-policy')?.value || 'continue-independent';
      const plan = this.getActivePlan();
      const planData = plan ? { ...plan, onFailure: failurePolicy } : undefined;

      let seenStartingIds = new Set();
      // 实时状态轮询 (每 50ms 追踪后端当前启动到哪个模块)
      pollTimer = setInterval(async () => {
        try {
          const sRes = await fetch('/manage/api/programs/startup-plan/status');
          if (sRes.ok) {
            const sData = await sRes.json();
            if (sData.status) {
              if (sData.status.currentProgramId) {
                seenStartingIds.add(sData.status.currentProgramId);
              }
              this.updateStartupHighlightState({
                startingProgramId: sData.status.currentProgramId,
                results: sData.status.results || []
              });
            }
          }
        } catch {}
      }, 50);

      const res = await fetch('/manage/api/programs/startup-plan/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
        body: JSON.stringify(planData ? { planData } : {})
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error?.message || `HTTP ${res.status}`);
      }
      const results = data.result?.results || [];

      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

      // 只有在后端瞬间返回、前端实时轮询未捕捉到流转过程时 (seenStartingIds < 2)，才做一次极简平滑波浪；
      // 若实时轮询已全程逐一高亮，则决不重复二次播放，直接定格最终结果！
      if (results.length > 0 && seenStartingIds.size < 2) {
        for (let i = 0; i < results.length; i++) {
          const item = results[i];
          this.updateStartupHighlightState({
            startingProgramId: item.programId,
            results: results.slice(0, i)
          });
          await new Promise(r => setTimeout(r, 220));
          this.updateStartupHighlightState({
            startingProgramId: null,
            results: results.slice(0, i + 1)
          });
          await new Promise(r => setTimeout(r, 60));
        }
      } else {
        this.updateStartupHighlightState({
          startingProgramId: null,
          results
        });
      }

      const startedCount = results.filter(r => ['started', 'running', 'already-running'].includes(r.state)).length;
      const failedCount = results.filter(r => ['failed', 'blocked', 'cancelled', 'not-started'].includes(r.state)).length;
      if (failedCount > 0) {
        canvasToast(() => (t('编排执行完成: {started} 个模块就绪，{failed} 个模块启动异常 (红色高亮)', { started: startedCount, failed: failedCount })), 'error');
      } else {
        canvasToast(() => (this.executionPlanSummary(results, data.result?.skipped || [])), 'neutral');
      }
      await this.fetchModulesData();
      // 保持全量就绪翡翠绿高亮 1.5 秒后平滑恢复默认视图；
      // 【关键设计】：启动失败或受阻的模块持续保持红色告警高亮，直到用户修复或点击停止重置
      setTimeout(() => {
        this.updateStartupHighlightState({
          startingProgramId: null,
          results: results.filter(r => r.state === 'failed' || r.state === 'blocked')
        });
        this.fetchModulesData();
      }, 1500);
    } catch (e) {
      if (pollTimer) clearInterval(pollTimer);
      this.updateStartupHighlightState();
      canvasToast(() => (t('执行启动计划失败: {error}', { error: e.message })), 'error');
    } finally {
      if (pollTimer) clearInterval(pollTimer);
      if (runBtn) runBtn.disabled = false;
    }
  }

  async stopAllModules() {
    for (const prog of this.filteredPrograms()) {
      if (prog.state === 'running' || prog.state === 'failed') {
        await fetch(`/manage/api/programs/${prog.programId}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
          body: JSON.stringify({})
        }).catch(() => {});
      }
    }
    this.updateStartupHighlightState();
    canvasToast(() => (t('已发出全部停止指令，并重置异常状态')), 'neutral');
    await this.fetchModulesData();
  }

  async startCurrentGroup() {
    if (this.groupFilter === 'all') return;
    const runBtn = $('btn-run-group');
    if (runBtn) runBtn.disabled = true;
    let pollTimer = null;
    let seenStartingIds = new Set();
    try {
      pollTimer = setInterval(async () => {
        try {
          const sRes = await fetch('/manage/api/programs/startup-plan/status');
          if (sRes.ok) {
            const sData = await sRes.json();
            if (sData.status) {
              if (sData.status.currentProgramId) {
                seenStartingIds.add(sData.status.currentProgramId);
              }
              this.updateStartupHighlightState({
                startingProgramId: sData.status.currentProgramId,
                results: sData.status.results || []
              });
            }
          }
        } catch {}
      }, 50);

      const res = await fetch(`/manage/api/groups/${this.groupFilter}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (!res.ok || data.error) throw new Error(errorText(data));
      const results = (data.results || data.result?.results || []).map(r => ({ ...r, state: r.state || (r.ok ? 'started' : 'failed') }));
      if (results.length > 0 && seenStartingIds.size < 2) {
        for (let i = 0; i < results.length; i++) {
          const item = results[i];
          this.updateStartupHighlightState({
            startingProgramId: item.programId,
            results: results.slice(0, i)
          });
          await new Promise(r => setTimeout(r, 220));
          this.updateStartupHighlightState({
            startingProgramId: null,
            results: results.slice(0, i + 1)
          });
          await new Promise(r => setTimeout(r, 60));
        }
      } else {
        this.updateStartupHighlightState({
          startingProgramId: null,
          results
        });
      }
      const failedGroupCount = results.filter(r => ['failed', 'blocked', 'cancelled', 'not-started'].includes(r.state)).length;
      if (failedGroupCount > 0) {
        canvasToast(() => (t('分组启动完成: {success} 成功，{failed} 个异常 (红色高亮)', { success: results.length - failedGroupCount, failed: failedGroupCount })), 'error');
      } else {
        canvasToast(() => (this.executionPlanSummary(results, data.skipped || data.result?.skipped || [])), 'neutral');
      }
      await this.fetchModulesData();
      setTimeout(() => {
        this.updateStartupHighlightState({
          startingProgramId: null,
          results: results.filter(r => r.state === 'failed')
        });
        this.fetchModulesData();
      }, 1500);
    } catch (e) {
      if (pollTimer) clearInterval(pollTimer);
      this.updateStartupHighlightState();
      canvasToast(() => (t('启动本组失败: {error}', { error: e.message })), 'error');
    } finally {
      if (pollTimer) clearInterval(pollTimer);
      if (runBtn) runBtn.disabled = false;
    }
  }

  async stopCurrentGroup() {
    if (this.groupFilter === 'all') return;
    try {
      await fetch(`/manage/api/groups/${this.groupFilter}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
        body: JSON.stringify({})
      });
      this.updateStartupHighlightState();
      canvasToast(() => (t('已发出停止本组指令并重置状态')), 'neutral');
      await this.fetchModulesData();
    } catch (e) {
      canvasToast(() => (t('停止本组失败: {error}', { error: e.message })), 'error');
    }
  }

  ensureWiringActionButtons(panel = $('bottom-exec-controls')) {
    if (!panel) return;
    // console.html may already provide the detached controls; do not create a
    // second button when this controller owns the panel's dynamic path.
    for (const [id, text, title] of [
      ['btn-wiring-matrix', '🔌 接线矩阵清单', '打开通道接线矩阵与快捷配对清单'],
      ['btn-restore-default-wiring', '↺ 恢复默认接线', '审阅并恢复作者默认接线']
    ]) {
      if ($(id)) continue;
      const button = document.createElement('button'); button.id = id; button.type = 'button'; button.className = 'hud-action-pill hidden';
      setCanvasText(button, () => (t(text))); setCanvasAttribute(button, 'title', () => (t(title)));
      if (id === 'btn-restore-default-wiring') { button.setAttribute('data-i18n', text); button.setAttribute('data-i18n-title', title); }
      panel.append(button);
    }
    window.hubCanvas?.applyLabels?.(panel);
  }

  wiringDefaultsText(source, params = {}) {
    return window.hubCanvas?.translate?.(source, params) ?? source.replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(params, name) ? String(params[name]) : token);
  }

  ensureWiringDefaultsModal() {
    if ($('wiring-defaults-modal')) return;
    const create = (tag, id, text, parent, className) => {
      const node = document.createElement(tag); if (id) node.id = id; if (className) node.className = className;
      if (text) { node.setAttribute('data-i18n', text); setCanvasText(node, () => (this.wiringDefaultsText(text))); }
      parent?.append(node); return node;
    };
    const overlay = create('div', 'wiring-defaults-modal', '', document.body, 'hub-modal-overlay hidden');
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'wiring-defaults-title');
    const modal = create('div', '', '', overlay, 'hub-modal'); modal.style.maxWidth = '820px';
    const header = create('div', '', '', modal, 'hub-modal-header');
    create('h3', 'wiring-defaults-title', '恢复默认接线', header);
    const close = create('button', 'btn-close-wiring-defaults', '关闭', header, 'hud-btn'); close.type = 'button'; close.onclick = () => this.closeWiringDefaultsManager();
    const body = create('div', '', '', modal, 'hub-modal-body'); body.style.cssText = 'max-height:75vh;overflow:auto;';
    create('p', '', '按作者的模块默认值或模块组发行配方恢复主题、桥权限和能力绑定。参数、启动计划、版本、源码、实例身份与私有数据保持不变；不会自动停止或启动模块。', body, 'action-help-text');
    const scopeLabel = create('label', '', '', body, 'form-label'); create('span', '', '恢复范围', scopeLabel);
    const scope = create('select', 'wiring-defaults-scope', '', scopeLabel, 'drawer-input');
    scope.addEventListener('change', () => {
      const session = this.wiringDefaultsSession; if (!session || session.busy) return;
      session.groupSources = Object.create(null); session.sourceDefinitions = Object.create(null); session.connectionSelections = Object.create(null); return this.previewWiringDefaults();
    });
    create('p', 'wiring-defaults-target', '', body);
    create('div', 'wiring-defaults-sources', '', body); create('div', 'wiring-defaults-connections', '', body);
    create('div', 'wiring-defaults-review', '', body);
    const error = create('p', 'wiring-defaults-error', '', body); error.setAttribute('role', 'status');
    const ackLabel = create('label', '', '', body, 'form-label');
    const ack = create('input', 'wiring-defaults-ack', '', ackLabel); ack.type = 'checkbox'; ack.addEventListener('change', () => this.refreshWiringDefaultsApply());
    create('span', '', '我已审阅恢复范围、作者默认接线与共享影响。', ackLabel);
    const actions = create('div', '', '', body, 'btn-group');
    const preview = create('button', 'btn-preview-wiring-defaults', '重新审阅', actions, 'hub-btn'); preview.type = 'button'; preview.onclick = () => this.previewWiringDefaults();
    const apply = create('button', 'btn-apply-wiring-defaults', '确认恢复默认接线', actions, 'hub-btn primary'); apply.type = 'button'; apply.disabled = true; apply.onclick = () => this.applyWiringDefaultsReview();
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') this.closeWiringDefaultsManager(); });
  }

  wiringDefaultsControls() {
    const session = this.wiringDefaultsSession;
    const selected = session?.scopes?.find(scope => scope.value === $('wiring-defaults-scope')?.value);
    if (!selected) return null;
    const sources = Object.fromEntries(Object.entries(session.groupSources).map(([id, value]) => [id, value.trim()]).filter(([, path]) => path));
    const selections = Object.fromEntries(Object.entries(session.connectionSelections).map(([id, values]) => [id, Object.fromEntries(Object.entries(values).filter(([, value]) => value))]).filter(([, values]) => Object.keys(values).length));
    return { scope: selected.scope, ...(selected.targetId ? { targetId: selected.targetId } : {}),
      ...(Object.keys(sources).length ? { groupSources: sources } : {}), ...(Object.keys(selections).length ? { connectionSelections: selections } : {}) };
  }

  invalidateWiringDefaultsReview() {
    const session = this.wiringDefaultsSession; if (!session || session.busy) return;
    session.epoch++; session.review = null; session.loading = false;
    if (session.expiryTimer) globalThis.clearTimeout?.(session.expiryTimer);
    $('wiring-defaults-ack').checked = false; $('wiring-defaults-review').replaceChildren(); setCanvasText($('wiring-defaults-error'), () => (''));
    this.refreshWiringDefaultsApply();
  }

  wiringDefaultsExpired(session = this.wiringDefaultsSession) {
    const expiresAt = session?.review?.expiresAt, time = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
    return !Number.isFinite(time) || time <= Date.now();
  }

  refreshWiringDefaultsApply() {
    const session = this.wiringDefaultsSession, review = session?.review?.review;
    const changed = (review?.programs || []).some(program => program.changed) || Boolean(review?.groupBaselinesEstablished?.length);
    const blocked = !review || review.blocked || review.blockers?.length || review.missingGroupSources?.length || review.requiresStop?.length ||
      review.connections?.some(connection => connection.status !== 'resolved') || !changed;
    if ($('btn-apply-wiring-defaults')) $('btn-apply-wiring-defaults').disabled = Boolean(!session?.review?.reviewId || session.busy || session.loading || this.pendingMutations > 0 || blocked || this.wiringDefaultsExpired(session) || !$('wiring-defaults-ack')?.checked);
    for (const node of this.wiringDefaultsInputs || []) node.disabled = Boolean(session?.busy);
    for (const id of ['wiring-defaults-scope', 'wiring-defaults-ack', 'btn-close-wiring-defaults']) if ($(id)) $(id).disabled = Boolean(session?.busy);
    if ($('btn-preview-wiring-defaults')) $('btn-preview-wiring-defaults').disabled = Boolean(session?.busy || session?.loading);
  }

  closeWiringDefaultsManager() {
    const session = this.wiringDefaultsSession;
    if (session?.busy) return;
    if (session?.expiryTimer) globalThis.clearTimeout?.(session.expiryTimer);
    this.wiringDefaultsSession = null; this.wiringDefaultsInputs = [];
    $('wiring-defaults-modal')?.classList.add('hidden');
  }

  async openWiringDefaultsManager() {
    if (this.wiringDefaultsSession?.busy) return;
    if (this.pendingMutations > 0) { canvasToast(() => (this.wiringDefaultsText('接线同步中，请等待现有操作完成后重新审阅默认接线。')), 'neutral'); return; }
    this.closeWiringDefaultsManager(); this.ensureWiringDefaultsModal();
    const group = this.data.groups?.find(group => group.id === this.groupFilter);
    const program = this.data.programs?.find(program => program.programId === this.focusedWiringModuleId);
    const scopes = [{ value: 'all', scope: 'all', label: '全部已安装模块' }];
    if (group) scopes.push({ value: `group:${group.id}`, scope: 'group', targetId: group.id, label: '当前模块组：{name}', name: group.title || group.id });
    if (program) scopes.push({ value: `module:${program.programId}`, scope: 'module', targetId: program.programId, label: '聚焦模块：{name}', name: program.module?.id || program.programId });
    this.wiringDefaultsSession = { scopes, epoch: 0, review: null, groupSources: Object.create(null), sourceDefinitions: Object.create(null), connectionSelections: Object.create(null), busy: false, loading: false };
    const select = $('wiring-defaults-scope'); select.replaceChildren();
    for (const scope of scopes) { const option = document.createElement('option'); option.value = scope.value; setCanvasText(option, () => (this.wiringDefaultsText(scope.label, { name: scope.name }))); select.append(option); }
    select.value = group ? `group:${group.id}` : program ? `module:${program.programId}` : 'all';
    $('wiring-defaults-sources').replaceChildren(); $('wiring-defaults-connections').replaceChildren();
    $('wiring-defaults-modal').classList.remove('hidden');
    return this.previewWiringDefaults();
  }

  async wiringDefaultsRequest(action, body) {
    const response = await fetch(`/manage/api/wiring/defaults/${action}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
    }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok || result.error) throw new Error(errorText(result)); return result;
  }

  async previewWiringDefaults() {
    const session = this.wiringDefaultsSession; if (!session || session.busy) return;
    if (this.pendingMutations > 0) { this.invalidateWiringDefaultsReview(); setCanvasText($('wiring-defaults-error'), () => (this.wiringDefaultsText('接线同步中，请等待现有操作完成后重新审阅默认接线。'))); return; }
    this.invalidateWiringDefaultsReview(); const controls = this.wiringDefaultsControls(); if (!controls) return;
    const epoch = session.epoch, fingerprint = JSON.stringify(controls); session.loading = true;
    setCanvasText($('wiring-defaults-error'), () => (this.wiringDefaultsText('正在核对作者默认接线…'))); this.refreshWiringDefaultsApply();
    try {
      const result = await this.wiringDefaultsRequest('preview', controls);
      if (this.wiringDefaultsSession !== session || epoch !== session.epoch || fingerprint !== JSON.stringify(this.wiringDefaultsControls())) return;
      session.review = { ...result, fingerprint }; setCanvasText($('wiring-defaults-error'), () => ('')); this.renderWiringDefaultsReview();
      const expiry = typeof result.expiresAt === 'number' ? result.expiresAt : Date.parse(result.expiresAt);
      if (Number.isFinite(expiry) && expiry > Date.now()) {
        session.expiryTimer = globalThis.setTimeout?.(() => {
          if (this.wiringDefaultsSession === session && session.epoch === epoch && session.review) {
            setCanvasText($('wiring-defaults-error'), () => (this.wiringDefaultsText('审阅已过期，请重新审阅。'))); this.refreshWiringDefaultsApply();
          }
        }, Math.min(expiry - Date.now() + 10, 2147483647)); session.expiryTimer?.unref?.();
      }
    } catch (error) {
      if (this.wiringDefaultsSession === session && epoch === session.epoch) setCanvasText($('wiring-defaults-error'), () => (this.wiringDefaultsText('默认接线审阅失败：{error}', { error: error.message })));
    } finally {
      if (this.wiringDefaultsSession === session && epoch === session.epoch) { session.loading = false; this.refreshWiringDefaultsApply(); }
    }
  }

  renderWiringDefaultsLanguage() {
    const session = this.wiringDefaultsSession; if (!session) return;
    const select = $('wiring-defaults-scope');
    for (let i = 0; i < session.scopes.length; i++) {
      const scope = session.scopes[i], option = select?.children[i]; if (option) setCanvasText(option, () => (this.wiringDefaultsText(scope.label, { name: scope.name })));
    }
    if (session.review && !session.busy) this.renderWiringDefaultsReview();
  }

  renderWiringDefaultsReview() {
    const session = this.wiringDefaultsSession, review = session?.review?.review; if (!review) return;
    const box = $('wiring-defaults-review'), sources = $('wiring-defaults-sources'), connections = $('wiring-defaults-connections');
    box.replaceChildren(); sources.replaceChildren(); connections.replaceChildren(); this.wiringDefaultsInputs = [];
    const text = (parent, source, params = {}) => { const node = document.createElement('p'); setCanvasText(node, () => (this.wiringDefaultsText(source, params))); node.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:12px;'; parent.append(node); return node; };
    const scope = session.scopes.find(scope => scope.value === $('wiring-defaults-scope').value);
    setCanvasText($('wiring-defaults-target'), () => (this.wiringDefaultsText('恢复范围：{scope}', { scope: this.wiringDefaultsText(scope.label, { name: scope.name }) })));
    for (const source of review.missingGroupSources || []) session.sourceDefinitions[source.groupId] = source;
    for (const source of Object.values(session.sourceDefinitions)) {
      const section = document.createElement('section'); section.className = 'section-block'; sources.append(section);
      text(section, '模块组 {group} 的原始接线来源：{id} @ {version}。请选择相同版本的原发行制品。', { group: source.groupId, id: source.id, version: source.version });
      text(section, '不会把当前改装接线当作默认，也不会猜测其他版本。来源核验通过后才可恢复。');
      const label = document.createElement('label'); setCanvasText(label, () => (this.wiringDefaultsText('本机目录、ZIP 或 JSON 路径'))); label.className = 'form-label'; section.append(label);
      const input = document.createElement('input'); input.type = 'text'; input.className = 'drawer-input'; input.style.width = '100%'; input.value = session.groupSources[source.groupId] || ''; input.groupId = source.groupId;
      input.addEventListener('input', () => { if (!session.busy) { session.groupSources[source.groupId] = input.value; this.invalidateWiringDefaultsReview(); } });
      input.addEventListener('change', () => this.previewWiringDefaults()); label.append(input); this.wiringDefaultsInputs.push(input);
      for (const [purpose, caption] of [['module', '选择目录'], ['file', '选择 ZIP / JSON']]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'hub-btn'; setCanvasText(button, () => (this.wiringDefaultsText(caption)));
        button.onclick = () => this.pickWiringDefaultsSource(source.groupId, purpose); section.append(button); this.wiringDefaultsInputs.push(button);
      }
    }
    for (const connection of review.connections || []) {
      const section = document.createElement('section'); section.className = 'section-block'; connections.append(section);
      text(section, '{program} / {connection} → {module} @ {version}', { program: connection.programId, connection: connection.id, module: connection.provider?.moduleId, version: connection.provider?.version });
      text(section, '要求契约：{contracts}；主题：{topics}', { contracts: (connection.contracts || []).map(contract => `${contract.id} @ ${contract.version}`).join('、') || this.wiringDefaultsText('无'),
        topics: Object.entries(connection.topics || {}).map(([alias, target]) => `${alias} → ${target}`).join('、') || this.wiringDefaultsText('无') });
      if (connection.status === 'resolved') text(section, '已匹配实例：{id}', { id: connection.providerId });
      if (connection.status === 'missing') text(section, '缺少匹配的已安装实例。请先从社区下载并导入声明的模块版本，再重新审阅；此处不会自动下载或执行。');
      if ((connection.status !== 'resolved' && connection.status !== 'missing') || connection.candidates?.length > 1) {
        const label = document.createElement('label'); setCanvasText(label, () => (this.wiringDefaultsText('选择提供者实例'))); section.append(label);
        const select = document.createElement('select'); select.className = 'drawer-input'; select.programId = connection.programId; select.connectionId = connection.id;
        const placeholder = document.createElement('option'); placeholder.value = ''; setCanvasText(placeholder, () => (this.wiringDefaultsText('请选择确切实例'))); select.append(placeholder);
        for (const candidate of connection.candidates || []) { const option = document.createElement('option'); option.value = candidate.programId; setCanvasText(option, () => (`${candidate.module?.id || connection.provider?.moduleId} @ ${candidate.module?.version || connection.provider?.version} · ${candidate.programId} · ${candidate.state || ''}`)); select.append(option); }
        select.value = session.connectionSelections[connection.programId]?.[connection.id] || connection.providerId || '';
        select.addEventListener('change', () => { if (session.busy) return; (session.connectionSelections[connection.programId] ??= Object.create(null))[connection.id] = select.value; return this.previewWiringDefaults(); });
        label.append(select); this.wiringDefaultsInputs.push(select);
      }
    }
    for (const program of review.programs || []) {
      const card = document.createElement('section'); card.className = 'section-block'; box.append(card);
      text(card, '{program} · {state} · {change}', { program: program.programId, state: program.state, change: this.wiringDefaultsText(program.changed ? '将恢复默认接线' : '接线无需变更') });
      text(card, '作者来源：{id} @ {version}{group}', { id: program.source?.id || program.module?.id, version: program.source?.version || program.module?.version,
        group: program.source?.groupId ? ` · ${program.source.groupId}` : '' });
      const absent = this.wiringDefaultsText('无');
      const before = program.before || {}, after = program.after || {};
      const aliases = [...new Set([...Object.keys(before.topics || {}), ...Object.keys(after.topics || {})])];
      if (!aliases.length) text(card, '{field}：{value}', { field: this.wiringDefaultsText('主题'), value: absent });
      for (const alias of aliases) text(card, '主题 {alias}：{before} → {after}', { alias, before: before.topics?.[alias] ?? absent, after: after.topics?.[alias] ?? absent });
      const slots = [...new Set([...Object.keys(before.bridges || {}), ...Object.keys(after.bridges || {})])];
      text(card, '{field}：{value}', { field: this.wiringDefaultsText('桥发布 / 订阅权限'), value: slots.length ? '' : absent });
      for (const slot of slots) for (const [key, label] of [['publish', '发布'], ['subscribe', '订阅']]) text(card, '桥 {slot} · {direction}：{before} → {after}', {
        slot, direction: this.wiringDefaultsText(label), before: (before.bridges?.[slot]?.[key] || []).join('、') || absent, after: (after.bridges?.[slot]?.[key] || []).join('、') || absent });
      const bound = bindings => {
        const values = new Map();
        for (const binding of bindings || []) { const contract = binding.contract || {}; const key = `${contract.id || '?'} @ ${contract.version || '?'}`; values.set(key, [...(values.get(key) || []), binding.providerId]); }
        return values;
      };
      const previousBindings = bound(before.bindings), nextBindings = bound(after.bindings);
      const contracts = [...new Set([...previousBindings.keys(), ...nextBindings.keys()])];
      text(card, '{field}：{value}', { field: this.wiringDefaultsText('能力提供者绑定'), value: contracts.length ? '' : absent });
      for (const contract of contracts) text(card, '能力 {contract} 的提供者：{before} → {after}', { contract, before: previousBindings.get(contract)?.join('、') || absent, after: nextBindings.get(contract)?.join('、') || absent });
      text(card, '共享此实例的模块组：{groups}', { groups: (program.affected?.sharedWithGroups || []).map(group => group.title || group.id).join('、') || this.wiringDefaultsText('无') });
      text(card, '依赖此实例的消费者：{consumers}', { consumers: (program.affected?.consumers || []).map(consumer => `${consumer.programId} (${consumer.state})`).join('、') || this.wiringDefaultsText('无') });
    }
    if (review.requiresStop?.length) text(box, '请先停止将要改变接线的模块：{modules}，然后重新审阅。此处不会自动停止；无需变更的运行模块不受影响。', { modules: review.requiresStop.join('、') });
    for (const blocker of review.blockers || []) text(box, '无法恢复：{reason}', { reason: blocker.message || blocker.code });
    if (review.blocked && review.scope === 'all') text(box, '可切换到具体模块组核对来源和接线冲突，再重新审阅。');
    if (review.groupBaselinesEstablished?.length) text(box, '本次将保存已核验的原发行接线配方：{groups}', { groups: review.groupBaselinesEstablished.join('、') });
    const baselineOnly = !(review.programs || []).some(program => program.changed) && Boolean(review.groupBaselinesEstablished?.length);
    setCanvasText($('btn-apply-wiring-defaults'), () => (this.wiringDefaultsText(baselineOnly ? '确认保存作者默认接线配方' : '确认恢复默认接线')));
    if (!(review.programs || []).some(program => program.changed) && !review.groupBaselinesEstablished?.length && !review.blocked && !review.missingGroupSources?.length && !review.blockers?.length) text(box, '当前已是默认接线，无需恢复。');
    const details = document.createElement('details'), summary = document.createElement('summary'), raw = document.createElement('pre');
    setCanvasText(summary, () => (this.wiringDefaultsText('完整接线审阅（可选）'))); setCanvasText(raw, () => (JSON.stringify(review, null, 2))); raw.style.cssText = 'white-space:pre-wrap;word-break:break-word;';
    details.append(summary, raw); box.append(details);
    this.refreshWiringDefaultsApply();
  }

  async pickWiringDefaultsSource(groupId, purpose) {
    const session = this.wiringDefaultsSession; if (!session || session.busy) return;
    const epoch = session.epoch;
    try {
      const response = await fetch('/manage/api/paths/native-pick', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' }, body: JSON.stringify({ purpose, initialPath: session.groupSources[groupId] || '' }) });
      const selected = await response.json(); if (!response.ok || selected.error) throw new Error(errorText(selected));
      if (this.wiringDefaultsSession !== session || epoch !== session.epoch || session.busy || selected.cancelled || !selected.path) return;
      session.groupSources[groupId] = selected.path; return this.previewWiringDefaults();
    } catch (error) { if (this.wiringDefaultsSession === session && epoch === session.epoch) setCanvasText($('wiring-defaults-error'), () => (error.message)); }
  }

  async applyWiringDefaultsReview() {
    const session = this.wiringDefaultsSession, saved = session?.review;
    if (!session || session.busy || session.loading || !saved?.reviewId) return;
    if (this.pendingMutations > 0) { this.invalidateWiringDefaultsReview(); setCanvasText($('wiring-defaults-error'), () => (this.wiringDefaultsText('接线同步中，请等待现有操作完成后重新审阅默认接线。'))); return; }
    if (this.wiringDefaultsExpired(session)) { this.invalidateWiringDefaultsReview(); setCanvasText($('wiring-defaults-error'), () => (this.wiringDefaultsText('审阅已过期，请重新审阅。'))); return; }
    if (saved.fingerprint !== JSON.stringify(this.wiringDefaultsControls())) { this.invalidateWiringDefaultsReview(); return; }
    const review = saved.review;
    if (review.blocked || review.blockers?.length || review.missingGroupSources?.length || review.requiresStop?.length || review.connections?.some(connection => connection.status !== 'resolved') ||
      (!(review.programs || []).some(program => program.changed) && !review.groupBaselinesEstablished?.length) || !$('wiring-defaults-ack')?.checked) return;
    session.busy = true; this.refreshWiringDefaultsApply(); setCanvasText($('wiring-defaults-error'), () => (this.wiringDefaultsText('正在恢复默认接线，请等待…')));
    try {
      await this.wiringDefaultsRequest('apply', { reviewId: saved.reviewId, accepted: true });
      session.review = null; let refreshError;
      try { const refresh = await this.fetchModulesData(); if (refresh?.refreshed === false) refreshError = refresh.error; } catch (error) { refreshError = error; }
      session.busy = false; if (this.wiringDefaultsSession === session) this.closeWiringDefaultsManager();
      canvasToast(() => (this.wiringDefaultsText(refreshError ? '默认接线已恢复，但画布刷新失败：{error}。请刷新界面核对。' : '默认接线已恢复。模块保持原运行状态，参数与本地数据保留。', { error: refreshError?.message })), refreshError ? 'error' : 'neutral');
    } catch (error) {
      if (this.wiringDefaultsSession === session) { session.busy = false; this.invalidateWiringDefaultsReview(); setCanvasText($('wiring-defaults-error'), () => (this.wiringDefaultsText('恢复默认接线失败：{error}。请重新审阅。', { error: error.message }))); }
    } finally { if (this.wiringDefaultsSession === session) { session.busy = false; this.refreshWiringDefaultsApply(); } }
  }

  // 原位版本管理属于本机模块管理层，不改变 Hub 通讯规则。
  ensureUninstallModal() {
    if ($('module-uninstall-modal')) return;
    const create = (tag, id, text, parent, className) => {
      const element = document.createElement(tag);
      if (id) element.id = id;
      if (text) {
        element.setAttribute('data-i18n', text);
        setCanvasText(element, () => (t(text)));
      }
      if (className) element.className = className;
      parent?.append(element); return element;
    };
    const overlay = create('div', 'module-uninstall-modal', '', document.body, 'hub-modal-overlay hidden');
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'uninstall-manager-title');
    const modal = create('div', '', '', overlay, 'hub-modal'); modal.style.maxWidth = '760px';
    const header = create('div', '', '', modal, 'hub-modal-header');
    create('h3', 'uninstall-manager-title', '审阅卸载', header);
    const close = create('button', 'btn-close-uninstall', '关闭', header, 'hud-btn'); close.type = 'button'; close.onclick = () => this.closeUninstallManager();
    const body = create('div', '', '', modal, 'hub-modal-body'); body.style.cssText = 'max-height:75vh;overflow:auto;';
    create('p', '', '卸载会移除所选模块的本机运行登记、接线权限及启动计划引用。源码、实例身份和本地数据保留在本机；不会永久删除文件。', body, 'action-help-text');
    create('p', 'uninstall-target', '', body);
    create('div', 'uninstall-programs', '', body);
    create('div', 'uninstall-retained', '', body);
    create('div', 'uninstall-effects', '', body);
    const stopLabel = create('label', '', '', body, 'form-label');
    const stop = create('input', 'uninstall-stop-owned', '', stopLabel); stop.type = 'checkbox'; stop.checked = true;
    stop.addEventListener('change', () => this.refreshUninstallApply());
    create('span', '', '停止所选模块并卸载（仅停止本管理器拥有的进程；保留的模块继续运行）', stopLabel);
    const error = create('p', 'uninstall-error', '', body); error.setAttribute('role', 'status');
    const ackLabel = create('label', '', '', body, 'form-label');
    const ack = create('input', 'uninstall-ack', '', ackLabel); ack.type = 'checkbox'; ack.addEventListener('change', () => this.refreshUninstallApply());
    create('span', '', '我已审阅卸载范围、保留模块与接线影响。', ackLabel);
    const actions = create('div', '', '', body, 'btn-group');
    const reload = create('button', 'btn-refresh-uninstall', '重新审阅', actions, 'hub-btn'); reload.type = 'button';
    reload.onclick = () => this.previewUninstall(this.uninstallSession?.programIds);
    const apply = create('button', 'btn-apply-uninstall', '确认卸载所选模块', actions, 'hub-btn danger'); apply.type = 'button'; apply.disabled = true; apply.onclick = () => this.applyUninstallReview();
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') this.closeUninstallManager(); });
  }

  async uninstallRequest(path, body) {
    const response = await fetch(path, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
    }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(errorText(result));
    return result;
  }

  uninstallEndpoint(session = this.uninstallSession) {
    return `/manage/api/uninstall/${session.kind}/${encodeURIComponent(session.targetId)}`;
  }

  uninstallExpired(session = this.uninstallSession) {
    const expiresAt = session?.review?.expiresAt;
    const time = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
    return !Number.isFinite(time) || time <= Date.now();
  }

  refreshUninstallApply() {
    const session = this.uninstallSession, review = session?.review?.review;
    const blocked = !review || review.blocked || Boolean(review.blockers?.length);
    if ($('btn-apply-uninstall')) $('btn-apply-uninstall').disabled = !session?.review?.reviewId || session.busy || session.loading || blocked || this.uninstallExpired(session) ||
      !$('uninstall-ack')?.checked || (Boolean(review?.requiresStop?.length) && !$('uninstall-stop-owned')?.checked);
    for (const id of ['uninstall-stop-owned', 'uninstall-ack', 'btn-refresh-uninstall']) if ($(id)) $(id).disabled = Boolean(session?.busy || session?.loading);
    for (const input of this.uninstallMemberInputs || []) input.disabled = Boolean(session?.busy || session?.loading || (!input.canRemove && !input.checked));
    if ($('btn-close-uninstall')) $('btn-close-uninstall').disabled = Boolean(session?.busy);
  }

  closeUninstallManager() {
    if (this.uninstallSession?.busy) { canvasToast(() => (t('正在执行卸载，请等待结果。')), 'neutral'); return; }
    this.uninstallSession = null; this.uninstallMemberInputs = [];
    $('module-uninstall-modal')?.classList.add('hidden');
  }

  async openUninstallManager(kind, targetId) {
    if (!targetId || !['modules', 'groups'].includes(kind) || this.uninstallSession?.busy) return;
    this.ensureUninstallModal();
    this.uninstallSession = { kind, targetId, epoch: 0, review: null, programIds: undefined, busy: false, loading: false };
    $('module-uninstall-modal').classList.remove('hidden');
    setCanvasText($('uninstall-manager-title'), () => (kind === 'groups' ? t('审阅整组卸载') : t('审阅模块卸载')));
    const target = kind === 'groups' ? this.data.groups?.find(group => group.id === targetId) : this.data.programs?.find(program => program.programId === targetId);
    setCanvasText($('uninstall-target'), () => (t('目标：{target} ({id})', { target: target?.title || target?.module?.id || targetId, id: targetId })));
    $('uninstall-stop-owned').checked = true;
    for (const id of ['uninstall-programs', 'uninstall-retained', 'uninstall-effects']) $(id).replaceChildren();
    return this.previewUninstall();
  }

  async previewUninstall(programIds) {
    const session = this.uninstallSession;
    if (!session || session.busy) return;
    const epoch = ++session.epoch;
    session.review = null; session.loading = true; session.programIds = programIds;
    $('uninstall-ack').checked = false; setCanvasText($('uninstall-error'), () => (t('正在核对模块、依赖与启动计划…')));
    this.refreshUninstallApply();
    try {
      const result = await this.uninstallRequest(`${this.uninstallEndpoint(session)}/preview`, programIds === undefined ? {} : { programIds });
      if (this.uninstallSession !== session || session.epoch !== epoch) return;
      session.review = result; session.programIds = [...result.review.programIds];
      this.renderUninstallReview();
      setCanvasText($('uninstall-error'), () => (result.review.blocked ? t('当前范围存在阻止卸载的依赖或进程状态，请先处理以下原因，再重新审阅。') : ''));
    } catch (error) {
      if (this.uninstallSession === session && session.epoch === epoch) setCanvasText($('uninstall-error'), () => (t('卸载审阅失败：{error}', { error: error.message })));
    } finally {
      if (this.uninstallSession === session && session.epoch === epoch) { session.loading = false; this.refreshUninstallApply(); }
    }
  }

  renderUninstallReview() {
    const session = this.uninstallSession, review = session?.review?.review;
    if (!review) return;
    const programs = $('uninstall-programs'), retained = $('uninstall-retained'), effects = $('uninstall-effects');
    programs.replaceChildren(); retained.replaceChildren(); effects.replaceChildren(); this.uninstallMemberInputs = [];
    const describe = value => {
      if (typeof value === 'string') return value;
      if (value?.code === 'UNINSTALL_SHARED_MEMBER') return t('此实例也属于其他模块组，保留它以免影响其他组。');
      if (value?.code === 'UNINSTALL_PROVIDER_IN_USE') return t('仍被保留模块 {consumers} 调用；请先调整能力接线，或将调用者一起纳入卸载范围。', { consumers: (value.consumerIds || []).join('、') });
      if (value?.code === 'LOCAL_PROCESS_OWNERSHIP_UNKNOWN') return t('进程归属未知，不能代为停止或卸载；请先确认该模块已退出。');
      if (value?.code === 'CLEANUP_INCOMPLETE') return t('进程清理尚未完成，请先确认停止成功。');
      if (value?.code === 'VERSION_RECOVERY_REQUIRED') return t('请先在版本管理中恢复中断的版本事务。');
      return value?.message || value?.reason || value?.code || value?.programId || value?.id || JSON.stringify(value);
    };
    const line = (parent, text) => { const node = document.createElement('p'); setCanvasText(node, () => (text())); parent.append(node); return node; };
    line(programs, () => (session.kind === 'groups' ? t('卸载成员（可取消勾选；每次调整都会重新核对依赖）：') : t('所选模块：')));
    for (const program of review.programs || []) {
      const row = document.createElement('section'); row.className = 'section-block';
      const label = document.createElement('label'); label.className = 'form-label';
      if (session.kind === 'groups') {
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(program.selected); input.canRemove = program.canRemove !== false; input.programId = program.programId;
        input.addEventListener('change', () => this.previewUninstall(this.uninstallMemberInputs.filter(item => item.checked).map(item => item.programId)));
        this.uninstallMemberInputs.push(input); label.append(input);
      }
      const title = document.createElement('span'); setCanvasText(title, () => (`${program.module?.id || program.programId} @ ${program.module?.version || t('未知版本')} · ${program.programId} · ${program.state || t('未知状态')}${program.selected ? t(' · 将卸载') : t(' · 保留')}`));
      label.append(title); row.append(label);
      if (program.groups?.length) line(row, () => (t('所属组：{groups}', { groups: program.groups.map(group => group.title || group.id || group).join('、') })));
      if (program.consumers?.length) line(row, () => (t('能力调用者：{consumers}', { consumers: program.consumers.map(item => item.programId || item).join('、') })));
      for (const blocker of program.blockers || []) line(row, () => (t('原因：{reason}', { reason: describe(blocker) })));
      programs.append(row);
    }
    for (const program of review.retainedPrograms || []) line(retained, () => (t('保留模块：{target}。它的进程与登记将保留。', { target: `${program.module?.id || program.programId} (${program.programId})${program.blockers?.length ? `；${program.blockers.map(describe).join('；')}` : ''}` })));
    for (const group of review.groupsChanged || []) line(effects, () => (group.removed
      ? t('移除分组：{group}；组中保留的模块仍可独立使用。', { group: group.title || group.id })
      : t('更新分组：{group}；移除成员引用 {removed}。', { group: group.title || group.id, removed: (group.removedProgramIds || []).join('、') || t('无') })));
    if (review.startupReferences?.length) line(effects, () => (t('移除启动计划引用：{refs}。', { refs: review.startupReferences.map(describe).join('、') })));
    if (review.requiresStop?.length) line(effects, () => (t('需要先停止所选模块：{order}。只处理本管理器拥有的进程。', { order: (review.stopOrder || review.requiresStop).join(' → ') })));
    for (const blocker of review.blockers || []) line(effects, () => (t('无法卸载：{reason}', { reason: describe(blocker) })));
    if (!(review.programIds || []).length) line(effects, () => (session.kind === 'groups' ? t('没有选中可卸载模块；确认后仅移除此分组，所有成员登记保留。') : t('没有可卸载模块。')));
    setCanvasText($('btn-apply-uninstall'), () => (session.kind === 'groups' && !review.programIds.length ? t('确认仅移除分组') : t('确认卸载所选模块')));
  }

  async applyUninstallReview() {
    const session = this.uninstallSession;
    if (!session || session.busy || session.loading || !session.review?.reviewId) return;
    if (this.uninstallExpired(session)) { session.review = null; $('uninstall-ack').checked = false; setCanvasText($('uninstall-error'), () => (t('卸载审阅已过期，请重新审阅。'))); this.refreshUninstallApply(); return; }
    const review = session.review.review;
    if (review.blocked || review.blockers?.length || !$('uninstall-ack')?.checked || (review.requiresStop?.length && !$('uninstall-stop-owned')?.checked)) return;
    session.busy = true; this.refreshUninstallApply(); setCanvasText($('uninstall-error'), () => (t('正在卸载，请等待结果…')));
    try {
      await this.uninstallRequest(`${this.uninstallEndpoint(session)}/apply`, { reviewId: session.review.reviewId, accepted: true, stopOwned: Boolean($('uninstall-stop-owned')?.checked) });
      session.review = null;
      const removed = new Set(review.programIds || []);
      if (removed.has(this.selectedModuleId)) { this.selectedModuleId = null; window.hubCanvas?.closeInspector(); }
      if (removed.has(this.focusedWiringModuleId)) this.focusedWiringModuleId = null;
      if ((review.groupsChanged || []).some(group => group.removed && group.id === this.groupFilter)) this.groupFilter = 'all';
      let refreshError;
      try {
        const refresh = await this.fetchModulesData(); if (refresh?.refreshed === false) throw refresh.error;
        if (!$('group-manager-modal')?.classList.contains('hidden') && $('group-list-box')) this.renderGroupListModal();
      } catch (error) { refreshError = error; }
      if (this.uninstallSession === session) { session.busy = false; this.closeUninstallManager(); }
      canvasToast(() => (refreshError ? t('卸载已完成，但列表刷新失败：{error}。请刷新页面查看当前登记。', { error: refreshError.message })
        : session.kind === 'groups' ? t('模块组已卸载，移除 {count} 个模块登记；未选成员及文件保留。', { count: removed.size }) : t('模块已卸载，源码与本地数据保留。')), refreshError ? 'error' : 'neutral');
    } catch (error) {
      if (this.uninstallSession === session) { session.review = null; $('uninstall-ack').checked = false; setCanvasText($('uninstall-error'), () => (t('卸载失败：{error}。请重新审阅后重试。', { error: error.message }))); }
    } finally {
      if (this.uninstallSession === session) { session.busy = false; this.refreshUninstallApply(); }
    }
  }

  ensureVersionModal() {
    if ($('module-version-modal')) return;
    const create = (tag, id, text, parent, className) => {
      const element = document.createElement(tag);
      if (id) element.id = id;
      if (text) {
        element.setAttribute('data-i18n', text);
        setCanvasText(element, () => (t(text)));
      }
      if (className) element.className = className;
      parent?.append(element);
      return element;
    };
    const overlay = create('div', 'module-version-modal', '', document.body, 'hub-modal-overlay hidden');
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'version-manager-title');
    const modal = create('div', '', '', overlay, 'hub-modal');
    modal.style.maxWidth = '920px';

    // 头部区域
    const header = create('div', '', '', modal, 'hub-modal-header');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.08); padding:14px 20px;';
    const headerLeft = create('div', '', '', header);
    headerLeft.style.cssText = 'display:flex; align-items:center; gap:10px;';
    create('span', '', '🏷', headerLeft);
    create('h3', 'version-manager-title', '模块版本管理', headerLeft);

    const headerActions = create('div', '', '', header);
    headerActions.style.cssText = 'display:flex; align-items:center; gap:8px;';
    const reload = create('button', 'btn-refresh-version-manager', '🔄 刷新', headerActions, 'hud-btn'); reload.type = 'button'; reload.onclick = () => {
      const session = this.versionSession; if (session) this.openVersionManager(session.kind, session.targetId);
    };
    const close = create('button', 'btn-close-version-manager', '✕ 关闭', headerActions, 'hud-btn'); close.type = 'button'; close.onclick = () => this.closeVersionManager();

    // 弹窗内部 Tab 导航栏
    const nav = create('div', 'vm-nav-bar', '', modal, 'vm-nav-tabs');
    const tabCurrent = create('button', 'tab-vm-current', '📌 当前版本', nav, 'vm-nav-tab'); tabCurrent.type = 'button'; tabCurrent.setAttribute('aria-pressed', 'false');
    tabCurrent.onclick = () => this.switchVersionModalTab('current');
    const tabSwitch = create('button', 'tab-vm-switch', '🔄 切换版本', nav, 'vm-nav-tab active'); tabSwitch.type = 'button'; tabSwitch.setAttribute('aria-pressed', 'true');
    tabSwitch.onclick = () => this.switchVersionModalTab('switch');
    const tabReview = create('button', 'tab-vm-review', '📋 变更审阅与应用', nav, 'vm-nav-tab'); tabReview.type = 'button'; tabReview.setAttribute('aria-pressed', 'false');
    tabReview.onclick = () => this.switchVersionModalTab('review');

    // 主体区域
    const body = create('div', '', '', modal, 'hub-modal-body');

    // ==========================================
    // 面板 1：切换版本 (panel-vm-switch)
    // ==========================================
    const panelSwitch = create('div', 'panel-vm-switch', '', body, 'vm-panel');

    // 1.1 本地已下载可用版本列表
    const knownSection = create('section', '', '', panelSwitch, 'section-block vm-section');
    create('h4', '', '⚡ 本地已下载可用版本 (点击快速选用):', knownSection, 'vm-section-title');
    const knownBox = create('div', 'version-known-paths', '', knownSection);
    knownBox.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:6px; min-height:28px;';

    // 1.2 从工坊/社区选择版本
    const commSection = create('section', '', '', panelSwitch, 'section-block vm-section');
    commSection.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:rgba(0,210,180,0.05); border:1px solid rgba(0,210,180,0.2); border-radius:8px; margin-bottom:12px;';
    const commDesc = create('div', '', '', commSection);
    const commTitle = create('strong', '', '🌐 从工坊/社区下载新版本', commDesc); commTitle.style.cssText = 'font-size:12px; color:var(--teal); display:block;';
    const commSub = create('span', '', '自动锁定当前模块/模块组，在工坊中直接挑选并下载其他版本。', commDesc); commSub.style.cssText = 'font-size:10px; color:var(--muted);';
    const community = create('button', 'btn-version-community', '🌐 前往工坊下载...', commSection, 'hub-btn primary');
    community.type = 'button'; community.onclick = () => this.openVersionWorkshop();

    // 1.3 本地源码目录、ZIP 制品路径输入 (单行整合工具栏)
    const customSection = create('section', '', '', panelSwitch, 'section-block vm-section');
    create('h4', '', '📂 本地目录或制品文件', customSection, 'vm-section-title');
    create('label', '', '已下载的源码目录、ZIP 或制品 JSON 完整路径', customSection, 'form-label');
    const pathToolbar = create('div', '', '', customSection, 'vm-path-toolbar');
    const path = create('input', 'version-source-path', '', pathToolbar, 'drawer-input vm-path-input'); path.type = 'text';
    setCanvasAttribute(path, 'placeholder', () => (t('输入或粘贴本地目录、ZIP 或 artifact.json 完整路径，或点击右侧选择...')));
    path.addEventListener('input', () => this.invalidateVersionReview());
    const pickWrap = create('div', 'vm-pick-wrap', '', pathToolbar, 'picker-dropdown-wrap');
    pickWrap.style.cssText = 'position:relative; flex-shrink:0;';
    const btnPick = create('button', 'btn-vm-pick-dir', '📁', pickWrap, 'hud-btn');
    btnPick.type = 'button';
    setCanvasAttribute(btnPick, 'title', () => (t('选择本地目录或制品文件 (自动适应)')));
    btnPick.style.cssText = 'display:inline-flex; align-items:center; justify-content:center; width:36px; height:34px; font-size:14px; padding:0; flex-shrink:0;';

    const vmPickMenu = create('div', 'vm-pick-menu', '', pickWrap, 'picker-popover-menu hidden');
    const itemDir = create('button', 'btn-vm-menu-dir', '📁 本地目录 (Folder)', vmPickMenu, 'picker-menu-item');
    itemDir.type = 'button';
    itemDir.onclick = (e) => { e.stopPropagation(); vmPickMenu.classList.add('hidden'); this.pickVersionSource('module'); };
    const itemFile = create('button', 'btn-vm-menu-file', '📄 制品文件 (ZIP / JSON)', vmPickMenu, 'picker-menu-item');
    itemFile.type = 'button';
    itemFile.onclick = (e) => { e.stopPropagation(); vmPickMenu.classList.add('hidden'); this.pickVersionSource('file'); };

    btnPick.onclick = (e) => {
      e.stopPropagation();
      vmPickMenu.classList.toggle('hidden');
    };

    // 策略选项 (Grid: 接线与参数 / 实例数据)
    const policyGrid = create('div', '', '', customSection, 'vm-grid-2');
    const options = (id, text, values, parent) => {
      const label = create('label', '', text, parent, 'form-label');
      const select = create('select', id, '', label, 'drawer-input');
      for (const [value, title] of values) select.add(canvasOption(() => (t(title)), value));
      select.addEventListener('change', () => this.invalidateVersionReview());
      return select;
    };
    options('version-configuration-policy', '🔌 接线与参数配置策略', [['preserve', '保留当前参数、主题与接线 (推荐)'], ['author', '使用目标发行版本的作者默认值（需重新审阅）']], policyGrid);
    options('version-data-policy', '💾 实例运行数据策略', [['preserve', '保留当前实例数据 (推荐)'], ['fresh', '使用全新实例数据，当前数据保留在版本历史']], policyGrid);

    const originLabel = create('label', 'version-origin-label', '', customSection, 'form-label');
    const origin = create('input', 'version-establish-origin', '', originLabel); origin.type = 'checkbox'; origin.addEventListener('change', () => this.invalidateVersionReview());
    create('span', '', '此组尚无发行来源：以所选模块组建立首次来源基线', originLabel);

    const inspect = create('button', 'btn-version-preview', '🔍 审阅版本变更 (Preview & Pre-Flight) ➔', customSection, 'hub-btn primary');
    inspect.type = 'button';
    inspect.style.cssText = 'width:100%; padding:10px 16px; font-size:13px; font-weight:700; margin-top:10px;';
    inspect.onclick = () => this.previewVersionUpdate();

    // 错误 / 提示状态
    create('p', 'version-error', '', customSection); $('version-error').setAttribute('role', 'status');

    // ==========================================
    // 面板 2：变更审阅与应用 (panel-vm-review)
    // ==========================================
    const panelReview = create('div', 'panel-vm-review', '', body, 'vm-panel hidden');

    // 审阅结果卡片容器
    create('div', 'version-review', '', panelReview, 'vm-review-box');

    // 确认与应用条
    const ackBox = create('div', 'version-ack-container', '', panelReview, 'vm-ack-box');
    const acknowledge = create('label', '', '', ackBox, 'form-label');
    acknowledge.style.cssText = 'display:flex; align-items:center; gap:8px; margin:0; cursor:pointer; font-size:12px; color:#cbd5e1;';
    const ack = create('input', 'version-data-ack', '', acknowledge); ack.type = 'checkbox'; ack.addEventListener('change', () => this.refreshVersionApply());
    create('span', '', '我已审阅变更，并了解数据兼容性未验证；代码回退不能撤销程序已产生的外部副作用。', acknowledge);

    const reviewActions = create('div', '', '', panelReview, 'btn-group');
    reviewActions.style.cssText = 'display:flex; gap:10px; margin-top:14px; margin-bottom:14px;';
    const backBtn = create('button', 'btn-vm-back-switch', '⬅ 返回修改版本或策略', reviewActions, 'hud-btn');
    backBtn.type = 'button'; backBtn.style.cssText = 'padding:10px 18px; font-size:13px; font-weight:600; white-space:nowrap;';
    backBtn.onclick = () => this.switchVersionModalTab(this.versionReviewSourceTab || 'switch');
    const apply = create('button', 'btn-version-apply', '🚀 确认应用已审阅的版本', reviewActions, 'hub-btn primary');
    apply.type = 'button'; apply.disabled = true;
    apply.style.cssText = 'flex:1; padding:10px 18px; font-size:13px; font-weight:800;';
    apply.onclick = () => this.applyVersionReview();

    // ==========================================
    // 面板 3：当前版本与历史 (panel-vm-current)
    // ==========================================
    const panelCurrent = create('div', 'panel-vm-current', '', body, 'vm-panel hidden');

    // 3.1 目标实例与运行状态看板
    const heroCard = create('section', 'version-hero-card', '', panelCurrent, 'vm-hero-card');
    create('p', 'version-current', '', heroCard);
    create('p', 'version-state-note', '更新前请停止目标模块；模块组更新前请停止组内相关模块。此处不会自动停止或启动任何程序。', heroCard, 'action-help-text vm-state-banner');
    const toSwitchBtn = create('button', 'btn-vm-to-switch', '🔄 升级或切换版本 ➔', heroCard, 'hub-btn primary');
    toSwitchBtn.type = 'button';
    toSwitchBtn.style.cssText = 'font-size:12px; font-weight:700; padding:6px 14px; margin-top:10px; display:inline-block;';
    toSwitchBtn.onclick = () => this.switchVersionModalTab('switch');

    // 3.2 待恢复中断事务容器
    create('div', 'version-recovery', '', panelCurrent);

    // 3.3 版本历史与原位回退
    const history = create('section', '', '', panelCurrent, 'section-block vm-section');
    create('h4', '', '🕒 版本历史与原位回退', history, 'vm-section-title');
    const historyLabel = create('label', '', '回退时的实例数据策略', history, 'form-label');
    const rollbackData = create('select', 'version-rollback-data', '', historyLabel, 'drawer-input');
    rollbackData.add(canvasOption(() => (t('保留当前数据，只恢复历史代码与配置 (推荐)')), 'preserve'));
    rollbackData.add(canvasOption(() => (t('恢复该次变更前的本地数据快照')), 'restore'));
    rollbackData.addEventListener('change', () => this.invalidateVersionReview());
    create('div', 'version-history', '', history);

    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') this.closeVersionManager(); });
  }

  getModuleUpdateInfo(prog) {
    if (!prog) return { currentVersion: null, latestVersion: null, hasUpdate: false, targetEntry: null };
    const currentVer = prog.module?.version || prog.manifest?.version || null;
    const moduleId = prog.module?.id || prog.manifest?.id || prog.programId;
    const candidates = [];
    for (const e of this.workshopEntries || []) {
      if (e.kind === 'module' && (e.id === moduleId || (prog.module?.id && e.id === prog.module.id))) {
        candidates.push(e);
      }
    }
    for (const a of this.cachedArtifacts || []) {
      if (a.kind === 'module' && a.id === moduleId && a.version) {
        if (!candidates.some(c => c.version === a.version)) {
          candidates.push({ ...a, entryId: a.id, isLocalCacheOnly: true });
        }
      }
    }
    if (!candidates.length) {
      return { currentVersion: currentVer, latestVersion: currentVer, hasUpdate: false, targetEntry: null };
    }
    candidates.sort((a, b) => compareSourceVersions(b.version, a.version));
    const highest = candidates[0];
    const hasUpdate = currentVer ? compareSourceVersions(highest.version, currentVer) > 0 : false;
    return {
      currentVersion: currentVer,
      latestVersion: highest.version,
      hasUpdate,
      targetEntry: highest
    };
  }

  getGroupUpdateInfo(group) {
    if (!group) return { currentVersion: null, latestVersion: null, hasUpdate: false, targetEntry: null };
    let currentVer = group.version || group.origin?.version || null;
    const groupId = group.origin?.id || group.id;

    const matchesGroup = (candId, candTitle) => {
      if (!candId) return false;
      if (candId === groupId || candId === group.id) return true;
      const normCand = candId.replace(/^demo\./, '').replace(/[-_]group$/, '');
      const normGroup = (group.id || '').replace(/^demo\./, '').replace(/[-_]group$/, '');
      if (normCand && normGroup && normCand === normGroup) return true;
      if (typeof group.title === 'string' && candTitle && typeof candTitle === 'string') {
        if (candTitle.includes(group.title) || group.title.includes(candTitle)) return true;
      }
      return false;
    };

    const candidates = [];
    for (const e of this.workshopEntries || []) {
      if (e.kind === 'module-group' && matchesGroup(e.id, e.title)) {
        candidates.push(e);
      }
    }
    for (const a of this.cachedArtifacts || []) {
      if (a.kind === 'module-group' && matchesGroup(a.id, a.title) && a.version) {
        if (!candidates.some(c => c.version === a.version)) {
          candidates.push({ ...a, entryId: a.id, isLocalCacheOnly: true });
        }
      }
    }
    if (!candidates.length) {
      return { currentVersion: currentVer, latestVersion: currentVer, hasUpdate: false, targetEntry: null };
    }
    candidates.sort((a, b) => compareSourceVersions(b.version, a.version));
    const highest = candidates[0];
    if (!currentVer && candidates.length) {
      const cachedGroup = (this.cachedArtifacts || []).find(a => a.kind === 'module-group' && matchesGroup(a.id, a.title));
      if (cachedGroup?.version) {
        currentVer = cachedGroup.version;
      } else {
        currentVer = candidates[candidates.length - 1].version;
      }
    }
    const hasUpdate = currentVer ? compareSourceVersions(highest.version, currentVer) > 0 : false;
    return {
      currentVersion: currentVer,
      latestVersion: highest.version,
      hasUpdate,
      targetEntry: highest
    };
  }

  getAvailableUpdatesCount() {
    let count = 0;
    const memberProgramIds = new Set();
    for (const g of this.data?.groups || []) {
      for (const pid of (g.memberProgramIds || [])) memberProgramIds.add(pid);
      if (this.getGroupUpdateInfo(g).hasUpdate) count++;
    }
    for (const p of this.data?.programs || []) {
      if (!memberProgramIds.has(p.programId) && this.getModuleUpdateInfo(p).hasUpdate) count++;
    }
    return count;
  }

  updateAllVersionBadges() {
    const updatesCount = this.getAvailableUpdatesCount();
    const badge = $('badge-ws-updates-count');
    if (badge) {
      setCanvasText(badge, () => (String(updatesCount)));
      badge.style.display = updatesCount > 0 ? 'inline-flex' : 'none';
      badge.style.background = updatesCount > 0 ? 'rgba(245, 158, 11, 0.25)' : 'rgba(255, 255, 255, 0.1)';
      badge.style.color = updatesCount > 0 ? '#fbbf24' : '#cbd5e1';
    }

    const batchCount = $('ws-batch-update-count');
    if (batchCount) setCanvasText(batchCount, () => (String(updatesCount)));
    const batchBtn = $('btn-ws-batch-update');
    if (batchBtn) batchBtn.disabled = updatesCount === 0;

    const verBtn = $('btn-ins-versions');
    if (verBtn && !verBtn.classList.contains('hidden')) {
      if (this.selectedGroupId) {
        const group = (this.data?.groups || []).find(g => g.id === this.selectedGroupId);
        if (group) {
          const info = this.getGroupUpdateInfo(group);
          verBtn.replaceChildren();
          const icon = document.createElement('span'); setCanvasText(icon, () => ('🏷 '));
          const text = document.createElement('span'); setCanvasText(text, () => (info.currentVersion ? `v${info.currentVersion}` : t('组版本')));
          verBtn.append(icon, text);
          if (info.hasUpdate) {
            const upBadge = document.createElement('span');
            upBadge.className = 'vm-update-badge';
            setCanvasText(upBadge, () => (` ⬆ v${info.latestVersion}`));
            verBtn.append(upBadge);
            setCanvasAttribute(verBtn, 'title', () => (t('发现可用新版本: v{latest} (当前 v{current}) · 点击管理与升级', { latest: info.latestVersion, current: info.currentVersion })));
            verBtn.classList.add('has-update');
          } else {
            setCanvasAttribute(verBtn, 'title', () => (info.currentVersion
              ? t('模块组版本管理 (当前 v{ver} · 已是最新)', { ver: info.currentVersion })
              : t('模块组版本管理 (尚未建立发行基线)')));
            verBtn.classList.remove('has-update');
          }
        }
      } else if (this.selectedModuleId) {
        const prog = (this.data?.programs || []).find(p => p.programId === this.selectedModuleId);
        if (prog) {
          const info = this.getModuleUpdateInfo(prog);
          verBtn.replaceChildren();
          const icon = document.createElement('span'); setCanvasText(icon, () => ('🏷 '));
          const text = document.createElement('span'); setCanvasText(text, () => (info.currentVersion ? `v${info.currentVersion}` : t('版本')));
          verBtn.append(icon, text);
          if (info.hasUpdate) {
            const upBadge = document.createElement('span');
            upBadge.className = 'vm-update-badge';
            setCanvasText(upBadge, () => (` ⬆ v${info.latestVersion}`));
            verBtn.append(upBadge);
            setCanvasAttribute(verBtn, 'title', () => (t('发现可用新版本: v{latest} (当前 v{current}) · 点击管理与升级', { latest: info.latestVersion, current: info.currentVersion })));
            verBtn.classList.add('has-update');
          } else {
            setCanvasAttribute(verBtn, 'title', () => (info.currentVersion
              ? t('版本管理 (当前 v{ver} · 已是最新)', { ver: info.currentVersion })
              : t('版本管理 (尚未建立发行基线)')));
            verBtn.classList.remove('has-update');
          }
        }
      }
    }
  }

  renderWorkshopUpdatesList() {
    const box = $('ws-updates-items-box');
    if (!box) return;
    box.replaceChildren();

    const programs = this.data?.programs || [];
    const groups = this.data?.groups || [];
    const progMap = new Map();
    for (const p of programs) progMap.set(p.programId, p);

    const memberProgramIds = new Set();
    for (const g of groups) {
      for (const pid of (g.memberProgramIds || [])) memberProgramIds.add(pid);
    }
    const standalonePrograms = programs.filter(p => !memberProgramIds.has(p.programId));
    const totalCount = groups.length + standalonePrograms.length;
    const updatesCount = this.getAvailableUpdatesCount();

    const titleEl = $('ws-updates-summary-title');
    if (titleEl) {
      if (groups.length && standalonePrograms.length) {
        setCanvasText(titleEl, () => (t('拓扑内受管服务 ({groups} 编排组 · {programs} 独立模块)', { groups: groups.length, programs: standalonePrograms.length })));
      } else if (groups.length) {
        setCanvasText(titleEl, () => (t('拓扑内受管编排组 ({groups} 组 · 共含 {count} 个成员模块)', { groups: groups.length, count: memberProgramIds.size })));
      } else {
        setCanvasText(titleEl, () => (t('拓扑内受管独立模块 ({count} 个独立模块)', { count: standalonePrograms.length })));
      }
    }
    const subEl = $('ws-updates-summary-sub');
    if (subEl) setCanvasText(subEl, () => (updatesCount > 0
      ? t('检测到 {count} 个模块组/模块有可用新版本，支持单项审阅或一键批量统一审阅更新。', { count: updatesCount })
      : t('当前拓扑内受管的所有模块组与模块均为最新版本。')));

    const batchCount = $('ws-batch-update-count');
    if (batchCount) setCanvasText(batchCount, () => (String(updatesCount)));
    const batchBtn = $('btn-ws-batch-update');
    if (batchBtn) batchBtn.disabled = updatesCount === 0;

    if (totalCount === 0 && programs.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.style.cssText = 'padding:40px 20px; text-align:center; color:var(--muted);';
      setCanvasText(emptyDiv, () => (t('当前画布拓扑内暂无受管模块或编排组。可从工坊或本地导入模块。')));
      box.append(emptyDiv);
      return;
    }

    // 1. Render Module Groups first (as primary entities)
    if (groups.length > 0) {
      const groupSectionHeader = document.createElement('div');
      groupSectionHeader.className = 'ws-updates-section-header';
      const secIcon = document.createElement('span'); setCanvasText(secIcon, () => ('🧩'));
      const secTitle = document.createElement('span'); setCanvasText(secTitle, () => (t('编排模块组 ({count} 个编排组合)', { count: groups.length })));
      groupSectionHeader.append(secIcon, secTitle);
      box.append(groupSectionHeader);
    }

    for (const group of groups) {
      const info = this.getGroupUpdateInfo(group);
      const members = (group.memberProgramIds || []).map(pid => progMap.get(pid)).filter(Boolean);
      const isAnyMemberRunning = members.some(m => m.state === 'running');

      const card = document.createElement('div');
      card.className = `ws-update-row ws-update-group-card ${info.hasUpdate ? 'has-update' : (info.currentVersion ? 'up-to-date' : 'no-baseline')}`;
      card.style.cssText = 'flex-direction:column; align-items:stretch; gap:10px; padding:12px 16px;';

      const topBar = document.createElement('div');
      topBar.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;';

      const left = document.createElement('div');
      left.style.cssText = 'flex:1; min-width:200px;';
      const titleRow = document.createElement('div');
      titleRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:3px;';
      const icon = document.createElement('span'); setCanvasText(icon, () => ('🧩'));
      const title = document.createElement('strong');
      title.style.cssText = 'font-size:13px; color:#fff;';
      setCanvasText(title, () => (group.title || group.id));
      titleRow.append(icon, title);

      const grpBadge = document.createElement('span');
      grpBadge.className = 'acl-pill';
      grpBadge.style.cssText = 'font-size:10px; padding:1px 8px; background:rgba(129,140,248,0.25); color:#a5b4fc; border:1px solid rgba(129,140,248,0.3);';
      setCanvasText(grpBadge, () => (t('{count} 个协同子模块', { count: members.length })));
      titleRow.append(grpBadge);

      const statusBadge = document.createElement('span');
      statusBadge.className = `acl-pill ${isAnyMemberRunning ? 'online' : ''}`;
      statusBadge.style.cssText = 'font-size:10px; padding:1px 6px;';
      setCanvasText(statusBadge, () => (isAnyMemberRunning ? t('● 成员运行中') : t('■ 成员已全停')));
      titleRow.append(statusBadge);

      const sub = document.createElement('div');
      sub.style.cssText = 'font-size:11px; color:var(--muted); font-family:var(--mono);';
      setCanvasText(sub, () => (`${t('模块组 ID: {id}', { id: group.id })}${info.targetEntry ? ' · ' + t('发行基线: {id}', { id: info.targetEntry.id }) : ''}`));
      left.append(titleRow, sub);

      const middle = document.createElement('div');
      middle.style.cssText = 'padding:0 12px; text-align:center; flex-shrink:0;';
      if (info.hasUpdate) {
        const verLine = document.createElement('div');
        verLine.style.cssText = 'font-size:12px; font-weight:700; color:#fbbf24; font-family:var(--mono);';
        setCanvasText(verLine, () => (`v${info.currentVersion} ➔ v${info.latestVersion}`));
        const pill = document.createElement('span');
        pill.className = 'vm-update-badge';
        pill.style.cssText = 'margin:3px 0 0 0; font-size:10px;';
        setCanvasText(pill, () => (t('⬆ 发现新版本')));
        middle.append(verLine, pill);
      } else if (info.currentVersion) {
        const verLine = document.createElement('div');
        verLine.style.cssText = 'font-size:12px; color:var(--teal); font-family:var(--mono);';
        setCanvasText(verLine, () => (`v${info.currentVersion}`));
        const pill = document.createElement('span');
        pill.style.cssText = 'font-size:10px; color:#94a3b8; display:block; margin-top:2px;';
        setCanvasText(pill, () => (t('✓ 已是最新')));
        middle.append(verLine, pill);
      } else {
        const verLine = document.createElement('div');
        verLine.style.cssText = 'font-size:11px; color:var(--muted);';
        setCanvasText(verLine, () => (t('未建立发行基线')));
        middle.append(verLine);
      }

      const right = document.createElement('div');
      right.style.cssText = 'flex-shrink:0; display:flex; gap:8px;';
      if (info.hasUpdate) {
        const updateBtn = document.createElement('button');
        updateBtn.type = 'button';
        updateBtn.className = 'hub-btn primary';
        updateBtn.style.cssText = 'font-size:11px; font-weight:700; padding:4px 14px;';
        setCanvasText(updateBtn, () => (t('⚡ 立即更新模块组')));
        updateBtn.onclick = () => this.updateSingleItemFromUpdates('groups', group.id, info.targetEntry);
        right.append(updateBtn);
      }
      const manageBtn = document.createElement('button');
      manageBtn.type = 'button';
      manageBtn.className = 'hud-btn';
      manageBtn.style.cssText = 'font-size:11px; padding:4px 12px;';
      setCanvasText(manageBtn, () => (t('🏷 组版本管理')));
      manageBtn.onclick = () => {
        this.openVersionManager('groups', group.id, true);
      };
      right.append(manageBtn);

      topBar.append(left, middle, right);
      card.append(topBar);

      // Members section
      if (members.length > 0) {
        const membersBox = document.createElement('div');
        membersBox.className = 'ws-group-members-box';

        const membersHeader = document.createElement('div');
        membersHeader.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:2px;';

        const hLeft = document.createElement('div');
        hLeft.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:11px; font-weight:700; color:#cbd5e1;';
        const hIcon = document.createElement('span'); setCanvasText(hIcon, () => ('👥'));
        const hTitle = document.createElement('span'); setCanvasText(hTitle, () => (t('协同子成员 ({count})', { count: members.length })));
        const hSub = document.createElement('span');
        hSub.style.cssText = 'font-size:10px; color:var(--muted); font-weight:normal;';
        setCanvasText(hSub, () => (t('· 可单独针对成员切换版本或更新')));
        hLeft.append(hIcon, hTitle, hSub);

        const hRight = document.createElement('div');
        hRight.style.cssText = 'font-size:10px; color:var(--muted); font-style:italic;';
        setCanvasText(hRight, () => (t('※ 组整体更新会按编排基线协同更新所有成员')));
        membersHeader.append(hLeft, hRight);
        membersBox.append(membersHeader);

        const membersList = document.createElement('div');
        membersList.className = 'ws-group-members-list';
        membersList.style.cssText = 'display:flex; flex-direction:column; gap:6px;';

        for (const m of members) {
          const mInfo = this.getModuleUpdateInfo(m);
          const isRunning = m.state === 'running';

          const mRow = document.createElement('div');
          mRow.className = `ws-group-member-item ${mInfo.hasUpdate ? 'has-update' : ''}`;

          // Left: Dot, Title, Program ID, Module ID
          const mLeft = document.createElement('div');
          mLeft.style.cssText = 'display:flex; align-items:center; gap:8px; min-width:0; flex:1;';

          const mDot = document.createElement('span');
          mDot.style.fontSize = '9px';
          setCanvasText(mDot, () => (isRunning ? '🟢' : '⚪'));
          setCanvasAttribute(mDot, 'title', () => (isRunning ? t('运行中') : t('已停止')));

          const mTitle = document.createElement('strong');
          mTitle.style.cssText = 'font-size:11px; color:#f8fafc; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;';
          setCanvasText(mTitle, () => (localizedText(m.title, m.programId)));

          const mProgId = document.createElement('span');
          mProgId.style.cssText = 'font-size:10px; color:var(--muted); font-family:var(--mono); white-space:nowrap;';
          setCanvasText(mProgId, () => (`(${m.programId})`));

          if (m.module?.id && m.module.id !== m.programId) {
            const mOrigin = document.createElement('span');
            mOrigin.style.cssText = 'font-size:10px; color:#64748b; font-family:var(--mono);';
            setCanvasText(mOrigin, () => (`· ${m.module.id}`));
            mLeft.append(mDot, mTitle, mProgId, mOrigin);
          } else {
            mLeft.append(mDot, mTitle, mProgId);
          }

          // Middle: Version status
          const mMid = document.createElement('div');
          mMid.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0; padding:0 8px;';
          if (mInfo.hasUpdate) {
            const mVer = document.createElement('span');
            mVer.style.cssText = 'font-size:11px; font-weight:700; color:#fbbf24; font-family:var(--mono);';
            setCanvasText(mVer, () => (`v${mInfo.currentVersion} ➔ v${mInfo.latestVersion}`));
            const mBadge = document.createElement('span');
            mBadge.className = 'vm-update-badge';
            mBadge.style.cssText = 'font-size:9px; padding:1px 6px;';
            setCanvasText(mBadge, () => (t('⬆ 新版本')));
            mMid.append(mVer, mBadge);
          } else if (mInfo.currentVersion) {
            const mVer = document.createElement('span');
            mVer.style.cssText = 'font-size:11px; color:var(--teal); font-family:var(--mono);';
            setCanvasText(mVer, () => (`v${mInfo.currentVersion}`));
            const mBadge = document.createElement('span');
            mBadge.style.cssText = 'font-size:10px; color:#94a3b8;';
            setCanvasText(mBadge, () => (t('✓ 最新')));
            mMid.append(mVer, mBadge);
          } else {
            const mVer = document.createElement('span');
            mVer.style.cssText = 'font-size:10px; color:var(--muted);';
            setCanvasText(mVer, () => (t('未建立基线')));
            mMid.append(mVer);
          }

          // Right: Action buttons
          const mRight = document.createElement('div');
          mRight.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0;';

          if (mInfo.hasUpdate) {
            const mUpdateBtn = document.createElement('button');
            mUpdateBtn.type = 'button';
            mUpdateBtn.className = 'hub-btn primary';
            mUpdateBtn.style.cssText = 'font-size:10px; font-weight:700; padding:3px 10px;';
            setCanvasText(mUpdateBtn, () => (t('⚡ 立即更新')));
            setCanvasAttribute(mUpdateBtn, 'title', () => (t('将此成员独立升级至 v{version}', { version: mInfo.latestVersion })));
            mUpdateBtn.onclick = (e) => {
              e.stopPropagation();
              this.updateSingleItemFromUpdates('modules', m.programId, mInfo.targetEntry);
            };
            mRight.append(mUpdateBtn);
          }

          const mSwitchBtn = document.createElement('button');
          mSwitchBtn.type = 'button';
          mSwitchBtn.className = 'hud-btn';
          mSwitchBtn.style.cssText = 'font-size:10px; padding:3px 10px;';
          setCanvasText(mSwitchBtn, () => (t('🏷 切换版本')));
          setCanvasAttribute(mSwitchBtn, 'title', () => (t('管理或切换实例 {id} 的版本', { id: m.programId })));
          mSwitchBtn.onclick = (e) => {
            e.stopPropagation();
            this.openVersionManager('modules', m.programId, true);
          };
          mRight.append(mSwitchBtn);

          mRow.append(mLeft, mMid, mRight);
          membersList.append(mRow);
        }

        membersBox.append(membersList);
        card.append(membersBox);
      }

      box.append(card);
    }

    // 2. Render Standalone Modules (programs that do NOT belong to any group)
    if (standalonePrograms.length > 0) {
      if (groups.length > 0) {
        const standaloneHeader = document.createElement('div');
        standaloneHeader.className = 'ws-updates-section-header';
        const secIcon = document.createElement('span'); setCanvasText(secIcon, () => ('📦'));
        const secTitle = document.createElement('span'); setCanvasText(secTitle, () => (t('独立受管模块 ({count} 个独立模块)', { count: standalonePrograms.length })));
        standaloneHeader.append(secIcon, secTitle);
        box.append(standaloneHeader);
      }

      for (const prog of standalonePrograms) {
        const info = this.getModuleUpdateInfo(prog);
        const isRunning = prog.state === 'running';
        const row = document.createElement('div');
        row.className = `ws-update-row ${info.hasUpdate ? 'has-update' : (info.currentVersion ? 'up-to-date' : 'no-baseline')}`;

        const left = document.createElement('div');
        left.style.cssText = 'flex:1; min-width:0;';
        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:3px;';
        const icon = document.createElement('span'); setCanvasText(icon, () => ('📦'));
        const title = document.createElement('strong');
        title.style.cssText = 'font-size:12px; color:#fff;';
        setCanvasText(title, () => (localizedText(prog.title, prog.programId)));
        titleRow.append(icon, title);

        const statusBadge = document.createElement('span');
        statusBadge.className = `acl-pill ${isRunning ? 'online' : ''}`;
        statusBadge.style.cssText = 'font-size:10px; padding:1px 6px;';
        setCanvasText(statusBadge, () => (isRunning ? t('● 运行中') : t('■ 已停止')));
        titleRow.append(statusBadge);

        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:11px; color:var(--muted); font-family:var(--mono);';
        setCanvasText(sub, () => (t('实例 ID: {programId} · 来源: {source}', { programId: prog.programId, source: prog.module?.id || t('本地定义') })));
        left.append(titleRow, sub);

        const middle = document.createElement('div');
        middle.style.cssText = 'padding:0 12px; text-align:center; flex-shrink:0;';
        if (info.hasUpdate) {
          const verLine = document.createElement('div');
          verLine.style.cssText = 'font-size:12px; font-weight:700; color:#fbbf24; font-family:var(--mono);';
          setCanvasText(verLine, () => (`v${info.currentVersion} ➔ v${info.latestVersion}`));
          const pill = document.createElement('span');
          pill.className = 'vm-update-badge';
          pill.style.cssText = 'margin:3px 0 0 0; font-size:10px;';
          setCanvasText(pill, () => (t('⬆ 发现新版本')));
          middle.append(verLine, pill);
        } else if (info.currentVersion) {
          const verLine = document.createElement('div');
          verLine.style.cssText = 'font-size:12px; color:var(--teal); font-family:var(--mono);';
          setCanvasText(verLine, () => (`v${info.currentVersion}`));
          const pill = document.createElement('span');
          pill.style.cssText = 'font-size:10px; color:#94a3b8; display:block; margin-top:2px;';
          setCanvasText(pill, () => (t('✓ 已是最新')));
          middle.append(verLine, pill);
        } else {
          const verLine = document.createElement('div');
          verLine.style.cssText = 'font-size:11px; color:var(--muted);';
          setCanvasText(verLine, () => (t('未建立发行基线')));
          middle.append(verLine);
        }

        const right = document.createElement('div');
        right.style.cssText = 'flex-shrink:0; display:flex; gap:8px;';
        if (info.hasUpdate) {
          const updateBtn = document.createElement('button');
          updateBtn.type = 'button';
          updateBtn.className = 'hub-btn primary';
          updateBtn.style.cssText = 'font-size:11px; font-weight:700; padding:4px 14px;';
          setCanvasText(updateBtn, () => (t('⚡ 立即更新')));
          updateBtn.onclick = () => this.updateSingleItemFromUpdates('modules', prog.programId, info.targetEntry);
          right.append(updateBtn);
        }
        const manageBtn = document.createElement('button');
        manageBtn.type = 'button';
        manageBtn.className = 'hud-btn';
        manageBtn.style.cssText = 'font-size:11px; padding:4px 12px;';
        setCanvasText(manageBtn, () => (info.hasUpdate ? t('🏷 切换版本') : t('🏷 版本管理')));
        manageBtn.onclick = () => {
          this.openVersionManager('modules', prog.programId, true);
        };
        right.append(manageBtn);

        row.append(left, middle, right);
        box.append(row);
      }
    }
  }

  async updateSingleItemFromUpdates(kind, id, targetEntry) {
    await this.openVersionManager(kind, id, true);
    if (targetEntry?.directory || targetEntry?.path) {
      if ($('version-source-path')) {
        $('version-source-path').value = targetEntry.directory || targetEntry.path;
        this.invalidateVersionReview();
        await this.previewVersionUpdate();
      }
    } else if (targetEntry?.entryId) {
      this.openVersionWorkshop();
    }
  }

  async checkAllUpdates(userTriggered = false) {
    if (userTriggered) {
      canvasToast(() => (t('正在与工坊源及本地缓存比对可用版本...')), 'neutral');
    }
    await this.loadWorkshopCache();
    await this.inspectWorkshopSource();
    this.updateAllVersionBadges();
    this.renderWorkshopUpdatesList();
    if (userTriggered) {
      const count = this.getAvailableUpdatesCount();
      canvasToast(() => (count > 0 ? t('✓ 检查完成：发现 {count} 个条目有可用新版本！', { count }) : t('✓ 检查完成：当前所有模块与模块组均为最新版本。')), 'neutral');
    }
  }

  initWorkshopSettings() {
    const conf = localStorage.getItem('hub.versions.defaultConfigPolicy') || 'preserve';
    const data = localStorage.getItem('hub.versions.defaultDataPolicy') || 'preserve';
    const priv = localStorage.getItem('hub.workshop.allowPrivateNetwork') !== '0';
    if ($('sel-setting-default-config-policy')) $('sel-setting-default-config-policy').value = conf;
    if ($('sel-setting-default-data-policy')) $('sel-setting-default-data-policy').value = data;
    if ($('chk-setting-private-network')) $('chk-setting-private-network').checked = priv;
    if ($('inp-setting-cache-dir')) {
      $('inp-setting-cache-dir').value = this.cacheDirectory || '';
      setCanvasAttribute($('inp-setting-cache-dir'), 'placeholder', () => t('系统默认 Hub 制品缓存目录'));
    }
  }

  ensureBatchUpdateModal() {
    if ($('modal-batch-update-review')) return;
    const create = (tag, id, text, parent, className) => {
      const element = document.createElement(tag);
      if (id) element.id = id;
      if (text) {
        element.setAttribute('data-i18n', text);
        setCanvasText(element, () => (t(text)));
      }
      if (className) element.className = className;
      parent?.append(element);
      return element;
    };
    const overlay = create('div', 'modal-batch-update-review', '', document.body, 'hub-modal-overlay hidden');
    overlay.style.zIndex = '1100';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    const modal = create('div', '', '', overlay, 'hub-modal');
    modal.style.maxWidth = '880px';
    modal.style.maxHeight = '88vh';
    modal.style.display = 'flex';
    modal.style.flexDirection = 'column';

    // Header
    const header = create('div', '', '', modal, 'hub-modal-header');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.08); padding:14px 20px;';
    const headerLeft = create('div', '', '', header);
    headerLeft.style.cssText = 'display:flex; align-items:center; gap:10px;';
    create('span', '', '🚀', headerLeft);
    create('h3', 'batch-update-modal-title', '批量版本更新 · 统一审阅汇总清单', headerLeft);

    const closeBtn = create('button', 'btn-close-batch-update', '✕ 关闭', header, 'hud-btn');
    closeBtn.type = 'button';
    closeBtn.onclick = () => this.closeBatchUpdateModal();

    // Body
    const body = create('div', '', '', modal, 'hub-modal-body');
    body.style.cssText = 'padding:16px 20px; overflow-y:auto; display:flex; flex-direction:column; gap:12px;';

    // Overview banner
    const summaryCard = create('div', 'batch-update-summary-banner', '', body, 'section-block');
    summaryCard.style.cssText = 'background:rgba(0,210,180,0.06); border:1px solid rgba(0,210,180,0.25); border-radius:8px; padding:12px 14px;';
    create('p', 'batch-update-summary-text', '正在准备待更新清单…', summaryCard, 'action-help-text');

    // Running programs warning banner (if any)
    const runningWarning = create('div', 'batch-update-running-warning', '', body, 'section-block hidden');
    runningWarning.style.cssText = 'background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.35); border-radius:8px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center; gap:10px;';
    const warnText = create('div', 'batch-update-running-text', '', runningWarning);
    warnText.style.cssText = 'font-size:12px; color:#fbbf24; line-height:1.4;';
    const stopAllBtn = create('button', 'btn-batch-stop-all', '■ 一键停止运行中模块', runningWarning, 'hub-btn danger');
    stopAllBtn.type = 'button';
    stopAllBtn.style.cssText = 'font-size:11px; padding:4px 12px; white-space:nowrap;';
    stopAllBtn.onclick = () => this.batchStopRunningUpdateTargets();

    // Items list table/box
    const itemsBox = create('div', 'batch-update-items-box', '', body);
    itemsBox.style.cssText = 'display:flex; flex-direction:column; gap:8px;';

    // Progress bar container (hidden during review)
    const progBox = create('div', 'batch-update-progress-box', '', body, 'hidden');
    progBox.style.cssText = 'background:rgba(0,0,0,0.25); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:12px;';
    const progLabel = create('div', 'batch-update-progress-label', '正在准备更新...', progBox);
    progLabel.style.cssText = 'font-size:12px; color:#fff; font-weight:600; margin-bottom:8px;';
    const progBarTrack = create('div', '', '', progBox);
    progBarTrack.style.cssText = 'background:rgba(255,255,255,0.08); border-radius:4px; height:6px; overflow:hidden;';
    const progBar = create('div', 'batch-update-progress-bar', '', progBarTrack);
    progBar.style.cssText = 'background:var(--teal); height:100%; width:0%; transition:width 0.25s ease;';

    // Risk acknowledge checkbox
    const ackCard = create('div', 'batch-update-ack-card', '', body, 'section-block');
    ackCard.style.cssText = 'background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:10px 14px;';
    const ackLabel = create('label', '', '', ackCard, 'form-label');
    ackLabel.style.cssText = 'display:flex; align-items:center; gap:8px; margin:0; cursor:pointer; font-size:12px; color:#cbd5e1;';
    const ackInput = create('input', 'batch-update-ack', '', ackLabel);
    ackInput.type = 'checkbox';
    ackInput.onchange = () => this.refreshBatchUpdateButtons();
    create('span', '', '我已审阅上述清单，确认按【保留现有接线配置与本地实例数据】策略统一批量应用新版本。', ackLabel);

    // Footer actions
    const footer = create('div', '', '', modal, 'hub-modal-footer');
    footer.style.cssText = 'border-top:1px solid rgba(255,255,255,0.08); padding:12px 20px; display:flex; justify-content:space-between; align-items:center;';
    const cancelBtn = create('button', 'btn-batch-cancel', '取消', footer, 'hud-btn');
    cancelBtn.type = 'button';
    cancelBtn.onclick = () => this.closeBatchUpdateModal();

    const confirmBtn = create('button', 'btn-batch-confirm-apply', '🚀 确认执行批量更新', footer, 'hub-btn primary');
    confirmBtn.type = 'button';
    confirmBtn.disabled = true;
    confirmBtn.style.cssText = 'font-weight:700; padding:8px 20px;';
    confirmBtn.onclick = () => this.executeBatchUpdate();

    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') this.closeBatchUpdateModal(); });
  }

  openBatchUpdateModal() {
    this.ensureBatchUpdateModal();
    const updatableItems = [];
    const memberProgramIds = new Set();

    for (const group of this.data?.groups || []) {
      for (const pid of (group.memberProgramIds || [])) memberProgramIds.add(pid);
      const info = this.getGroupUpdateInfo(group);
      if (info.hasUpdate) {
        const members = (this.data?.programs || []).filter(p => (group.memberProgramIds || []).includes(p.programId));
        const hasRunningMember = members.some(m => m.state === 'running');
        updatableItems.push({
          kind: 'groups',
          id: group.id,
          title: group.title || group.id,
          currentVersion: info.currentVersion,
          targetVersion: info.latestVersion,
          targetEntry: info.targetEntry,
          isRunning: hasRunningMember
        });
      }
    }

    for (const prog of this.data?.programs || []) {
      if (memberProgramIds.has(prog.programId)) continue;
      const info = this.getModuleUpdateInfo(prog);
      if (info.hasUpdate) {
        updatableItems.push({
          kind: 'modules',
          id: prog.programId,
          title: localizedText(prog.title, prog.programId),
          currentVersion: info.currentVersion,
          targetVersion: info.latestVersion,
          targetEntry: info.targetEntry,
          isRunning: prog.state === 'running'
        });
      }
    }

    if (!updatableItems.length) {
      canvasToast(() => (t('当前没有检测到待更新的模块或模块组。')), 'neutral');
      return;
    }

    this.pendingBatchItems = updatableItems;
    this.batchUpdateBusy = false;

    const modal = $('modal-batch-update-review');
    modal?.classList.remove('hidden');

    const summaryText = $('batch-update-summary-text');
    if (summaryText) {
      setCanvasText(summaryText, () => (t('共选定 {count} 个待更新模块与模块组。将统一执行下载、依赖校验，并在【保留现有接线配置与本地实例数据】的前提下应用新版本。', { count: updatableItems.length })));
    }

    const itemsBox = $('batch-update-items-box');
    if (itemsBox) {
      itemsBox.replaceChildren();
      for (const item of updatableItems) {
        const row = document.createElement('div');
        row.style.cssText = 'background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center; gap:10px;';

        const left = document.createElement('div');
        left.style.cssText = 'flex:1; min-width:0;';
        const nameRow = document.createElement('div');
        nameRow.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:2px;';
        const icon = document.createElement('span'); setCanvasText(icon, () => (item.kind === 'groups' ? '🧩' : '📦'));
        const name = document.createElement('strong');
        name.style.cssText = 'font-size:12px; color:#fff;';
        setCanvasText(name, () => (`${item.title} (${item.id})`));
        nameRow.append(icon, name);

        const policyText = document.createElement('div');
        policyText.style.cssText = 'font-size:11px; color:var(--muted);';
        setCanvasText(policyText, () => (t('策略: 保留当前配置 · 保留实例数据')));
        left.append(nameRow, policyText);

        const mid = document.createElement('div');
        mid.style.cssText = 'font-size:12px; font-weight:700; color:#fbbf24; font-family:var(--mono); white-space:nowrap; padding:0 10px;';
        setCanvasText(mid, () => (`v${item.currentVersion} ➔ v${item.targetVersion}`));

        const right = document.createElement('div');
        right.style.cssText = 'font-size:11px; font-weight:600; white-space:nowrap;';
        right.id = `batch-row-status-${item.id}`;
        if (item.isRunning) {
          right.style.color = '#fbbf24';
          setCanvasText(right, () => (t('⚠️ 运行中 (需停止)')));
        } else {
          right.style.color = 'var(--teal)';
          setCanvasText(right, () => (t('✓ 已就绪 (已停止)')));
        }

        row.append(left, mid, right);
        itemsBox.append(row);
      }
    }

    const ack = $('batch-update-ack');
    if (ack) ack.checked = false;
    $('batch-update-progress-box')?.classList.add('hidden');

    this.refreshBatchUpdateButtons();
  }

  closeBatchUpdateModal() {
    if (this.batchUpdateBusy) {
      canvasToast(() => (t('批量更新进行中，请等待完成。')), 'neutral');
      return;
    }
    $('modal-batch-update-review')?.classList.add('hidden');
    this.pendingBatchItems = null;
  }

  refreshBatchUpdateButtons() {
    const items = this.pendingBatchItems || [];
    const hasRunning = items.some(item => item.isRunning);
    const ackChecked = $('batch-update-ack')?.checked === true;
    const confirmBtn = $('btn-batch-confirm-apply');

    const warningBox = $('batch-update-running-warning');
    const warningText = $('batch-update-running-text');
    if (warningBox) {
      warningBox.classList.toggle('hidden', !hasRunning);
      if (hasRunning && warningText) {
        const runningNames = items.filter(i => i.isRunning).map(i => i.title).join('、');
        setCanvasText(warningText, () => (t('⚠️ 检测到待更新模块【{names}】当前正在运行。版本代码替换必须在模块完全停止后进行。可点击右侧按钮一键停止。', { names: runningNames })));
      }
    }

    if (confirmBtn) {
      confirmBtn.disabled = this.batchUpdateBusy || !ackChecked || hasRunning;
      setCanvasText(confirmBtn, () => (this.batchUpdateBusy
        ? t('⏳ 正在批量更新...')
        : t('🚀 确认执行批量更新 ({count} 个条目)', { count: items.length })));
    }
  }

  async batchStopRunningUpdateTargets() {
    const items = (this.pendingBatchItems || []).filter(i => i.isRunning);
    if (!items.length) return;
    const stopBtn = $('btn-batch-stop-all');
    if (stopBtn) { stopBtn.disabled = true; setCanvasText(stopBtn, () => (t('⏳ 正在停止...'))); }
    for (const item of items) {
      if (item.kind === 'modules') {
        await this.stopProgram(item.id);
        item.isRunning = false;
        const rowStatus = $(`batch-row-status-${item.id}`);
        if (rowStatus) {
          setCanvasText(rowStatus, () => (t('✓ 已就绪 (已停止)')));
          rowStatus.style.color = 'var(--teal)';
        }
      } else if (item.kind === 'groups') {
        const group = (this.data?.groups || []).find(g => g.id === item.id);
        for (const mid of group?.memberProgramIds || []) {
          await this.stopProgram(mid);
        }
        item.isRunning = false;
        const rowStatus = $(`batch-row-status-${item.id}`);
        if (rowStatus) {
          setCanvasText(rowStatus, () => (t('✓ 已就绪 (已停止)')));
          rowStatus.style.color = 'var(--teal)';
        }
      }
    }
    if (stopBtn) { stopBtn.disabled = false; setCanvasText(stopBtn, () => (t('■ 一键停止运行中模块'))); }
    this.refreshBatchUpdateButtons();
  }

  async executeBatchUpdate() {
    if (!this.pendingBatchItems?.length || this.batchUpdateBusy) return;
    const items = this.pendingBatchItems;
    this.batchUpdateBusy = true;
    this.refreshBatchUpdateButtons();
    const progBox = $('batch-update-progress-box');
    const progLabel = $('batch-update-progress-label');
    const progBar = $('batch-update-progress-bar');
    if (progBox) progBox.classList.remove('hidden');

    let successCount = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const percent = Math.round(((i) / items.length) * 100);
      if (progBar) progBar.style.width = `${percent}%`;
      if (progLabel) setCanvasText(progLabel, () => (t('正在更新 ({index}/{total})：{title} (v{cur} ➔ v{target})...', { index: i + 1, total: items.length, title: item.title, cur: item.currentVersion, target: item.targetVersion })));

      try {
        let artifactPath = item.targetEntry?.directory || item.targetEntry?.path;
        if (!artifactPath && item.targetEntry?.entryId) {
          const res = await fetch('/manage/api/workshop/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
            body: JSON.stringify({ source: this.workshopData?.source, entryId: item.targetEntry.entryId, digest: this.workshopData?.digest, allowPrivateNetwork: true })
          });
          if (res.ok) {
            const data = await res.json();
            artifactPath = data.directory;
          }
        }
        if (!artifactPath) {
          throw new Error('未获取到目标版本本地制品路径');
        }

        const endpoint = item.kind === 'groups' ? `/manage/api/versions/groups/${item.id}` : `/manage/api/versions/modules/${item.id}`;
        const overview = await this.versionRequest(endpoint);
        const expectedRevision = overview.revision ?? overview.current?.revision;

        const previewRes = await this.versionRequest(`${endpoint}/preview`, {
          path: artifactPath,
          expectedRevision,
          configurationPolicy: localStorage.getItem('hub.versions.defaultConfigPolicy') || 'preserve',
          dataPolicy: localStorage.getItem('hub.versions.defaultDataPolicy') || 'preserve',
          ...(item.kind === 'groups' && !overview.current?.version ? { establishOrigin: true } : {})
        });

        if (previewRes.reviewId) {
          await this.versionRequest(`${endpoint}/apply`, {
            reviewId: previewRes.reviewId,
            accepted: true,
            dataAcknowledged: true
          });
          successCount++;
          const rowStatus = $(`batch-row-status-${item.id}`);
          if (rowStatus) {
            setCanvasText(rowStatus, () => (t('✓ 已更新')));
            rowStatus.style.color = 'var(--teal)';
          }
        }
      } catch (err) {
        console.error(`Batch update error on ${item.id}:`, err);
        const rowStatus = $(`batch-row-status-${item.id}`);
        if (rowStatus) {
          setCanvasText(rowStatus, () => (t('失败: {error}', { error: err.message })));
          rowStatus.style.color = 'var(--red)';
        }
      }
    }

    if (progBar) progBar.style.width = '100%';
    if (progLabel) setCanvasText(progLabel, () => (t('批量更新处理完成！成功 {success} / {total} 个条目。', { success: successCount, total: items.length })));

    await this.fetchModulesData();
    await this.loadWorkshopCache();
    this.batchUpdateBusy = false;

    canvasToast(() => (t('🎉 批量更新完成！已成功更新 {count} 个模块/模块组。', { count: successCount })), 'neutral');
    setTimeout(() => {
      this.closeBatchUpdateModal();
      this.renderWorkshopUpdatesList();
      this.updateAllVersionBadges();
    }, 1500);
  }

  switchVersionModalTab(tabKey) {
    for (const k of ['switch', 'review', 'current']) {
      const tab = $(`tab-vm-${k}`);
      const panel = $(`panel-vm-${k}`);
      if (tab) {
        tab.setAttribute('aria-pressed', k === tabKey ? 'true' : 'false');
        tab.classList.toggle('active', k === tabKey);
      }
      if (panel) {
        panel.classList.toggle('hidden', k !== tabKey);
      }
    }
  }

  versionEndpoint(session = this.versionSession) {
    return `/manage/api/versions/${session.kind}/${encodeURIComponent(session.targetId)}`;
  }

  async versionRequest(path, body) {
    const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
    }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(errorText(result));
    return result;
  }

  invalidateVersionReview() {
    const session = this.versionSession;
    if (session) { session.review = null; session.epoch++; }
    if ($('version-data-ack')) $('version-data-ack').checked = false;
    if (!session?.busy && $('version-error')) setCanvasText($('version-error'), () => (''));
    $('version-review')?.replaceChildren();
    this.refreshVersionApply();
  }

  refreshVersionApply() {
    const session = this.versionSession;
    const blocked = session?.busy || this.versionTargetRunning(session) || Boolean(session?.overview?.recoveryRequired?.length);
    if ($('btn-version-apply')) $('btn-version-apply').disabled = !session?.review?.reviewId || blocked || !$('version-data-ack')?.checked;
    if ($('btn-version-preview')) $('btn-version-preview').disabled = !session?.overview || blocked;
    for (const id of ['version-source-path', 'version-configuration-policy', 'version-data-policy', 'version-rollback-data', 'version-establish-origin', 'version-data-ack', 'btn-version-community', 'btn-refresh-version-manager'])
      if ($(id)) $(id).disabled = Boolean(session?.busy);
  }

  versionTargetRunning(session = this.versionSession) {
    if (!session) return false;
    // A group release may only detach a running member while retaining its
    // independent registration. Until the candidate is reviewed, let the engine
    // determine which existing members actually need their software replaced.
    const ids = session.kind === 'groups'
      ? (session.review?.review?.programs || []).filter(program => program.before && program.change !== 'retain').map(program => program.programId)
      : [session.targetId];
    return ids.some(id => this.data.programs.find(program => program.programId === id)?.state !== 'stopped');
  }

  closeVersionManager() {
    if (this.versionSession?.busy) { canvasToast(() => (t('正在提交版本事务，请等待结果。')), 'neutral'); return; }
    this.invalidateVersionReview(); this.versionSession = null; this.versionWorkshopTarget = null;
    $('module-version-modal')?.classList.add('hidden');
    if (this.versionOpenedFromWorkshop) {
      this.versionOpenedFromWorkshop = false;
      $('modal-module-workshop')?.classList.remove('hidden');
      this.renderWorkshopUpdatesList();
      this.updateAllVersionBadges();
    }
  }

  async openVersionManager(kind, targetId, fromWorkshop = false) {
    if (!targetId || !['modules', 'groups'].includes(kind) || this.versionSession?.busy) return;
    this.versionOpenedFromWorkshop = Boolean(fromWorkshop);
    this.ensureVersionModal();
    this.invalidateVersionReview(); this.versionWorkshopTarget = null;
    const session = this.versionSession = { kind, targetId, epoch: 0, overview: null, review: null, busy: false };

    const modal = $('module-version-modal');
    if (modal && modal.parentElement !== document.body) {
      document.body.append(modal);
    }
    this.switchVersionModalTab('switch');

    modal?.classList.remove('hidden');
    setCanvasText($('version-manager-title'), () => (kind === 'groups' ? t('模块组版本升级与回退') : t('模块版本升级与回退')));
    setCanvasText($('version-current'), () => (t('正在读取当前来源与版本历史…')));
    $('version-source-path').value = ''; setCanvasText($('version-error'), () => (''));
    $('version-configuration-policy').value = localStorage.getItem('hub.versions.defaultConfigPolicy') || 'preserve';
    $('version-data-policy').value = localStorage.getItem('hub.versions.defaultDataPolicy') || 'preserve';
    $('version-rollback-data').value = 'preserve';
    $('version-establish-origin').checked = false;
    $('version-known-paths').replaceChildren(); $('version-history').replaceChildren(); $('version-recovery').replaceChildren();
    this.refreshVersionApply();
    try {
      const overview = await this.versionRequest(this.versionEndpoint(session));
      if (this.versionSession !== session) return;
      session.overview = overview;
      const current = overview.current || {};
      setCanvasText($('version-current'), () => (t('当前来源：{source} · 修订 {rev} · 实例 {id}', {
        source: `${current.id || targetId} @ ${current.version || t('尚未建立发行基线')}`,
        rev: overview.revision ?? current.revision ?? t('未知'),
        id: targetId
      })));
      const isRunning = this.versionTargetRunning(session);
      const stateNote = $('version-state-note');
      stateNote.className = `action-help-text vm-state-banner ${isRunning ? 'running' : 'stopped'}`;
      setCanvasText(stateNote, () => (kind === 'groups'
        ? t('可先审阅目标发行版本。实际替换代码的已有成员必须完全停止，涉及运行成员时后端会拒绝审阅；仅移出组且保留独立注册的成员可继续运行。版本操作不会自动停启任何程序。')
        : isRunning
          ? t('目标尚未完全停止，请先在通信画布停止目标模块，再刷新版本管理。版本操作不会自动停启程序。')
          : t('保留实例身份；更新与回退完成后保持停止。共享成员和外部消费者的影响将在审阅中列出。')));
      if (isRunning && kind === 'modules') {
        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'hub-btn danger';
        stopBtn.style.cssText = 'font-size:11px; padding:3px 10px; margin-left:10px; font-weight:700; cursor:pointer;';
        setCanvasText(stopBtn, () => (t('■ 立即停止此模块')));
        stopBtn.onclick = async () => {
          stopBtn.disabled = true;
          setCanvasText(stopBtn, () => (t('⏳ 正在停止...')));
          await this.stopProgram(targetId);
          if (this.versionSession === session) await this.openVersionManager(session.kind, session.targetId);
        };
        stateNote.append(stopBtn);
      }
      $('version-origin-label').classList.toggle('hidden', kind !== 'groups' || Boolean(current.version));
      $('version-recovery').replaceChildren();
      for (const pending of overview.recoveryRequired || []) {
        const committed = pending.status === 'committed';
        const line = document.createElement('p');
        line.style.cssText = 'background:rgba(245,158,11,0.1); border:1px solid rgba(245,158,11,0.3); border-radius:8px; padding:8px 12px; font-size:12px; color:#fbbf24; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;';
        setCanvasText(line, () => (committed
          ? t('版本切换已完成，仍需清理事务标记：{id}。清理不会改变软件、配置或本地实例数据。', { id: pending.transactionId })
          : t('需要恢复中断事务：{id} · {status}。恢复会还原变更前的软件、配置与本地实例数据快照；外部副作用无法撤销。', { id: pending.transactionId, status: pending.status })));
        const button = document.createElement('button'); button.type = 'button'; button.className = 'hub-btn';
        button.style.cssText = 'font-size:11px; padding:3px 10px;';
        setCanvasText(button, () => (committed ? t('清理事务标记') : t('恢复中断事务')));
        button.onclick = () => this.recoverVersionTransaction(pending.transactionId, pending); line.append(button); $('version-recovery').append(line);
      }
      const history = $('version-history');
      if (!(overview.history || []).length) setCanvasText(history, () => (t('暂无已完成的原位版本变更。首次更新完成后可在这里回退。')));
      for (const entry of overview.history || []) {
        const row = document.createElement('section'); row.className = 'section-block vm-history-card';
        const line = document.createElement('p');
        line.style.cssText = 'font-size:12px; color:#cbd5e1; margin:0;';
        setCanvasText(line, () => (`${entry.before?.version || t('无发行基线')} → ${entry.after?.version || t('未知版本')} · ${entry.action === 'rollback' ? t('回退') : t('更新')} · ${entry.createdAt || ''} · ${entry.status || ''}`));
        row.append(line);
        if (entry.status === 'committed') {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'hub-btn';
          button.style.cssText = 'font-size:11px; padding:3px 10px;';
          setCanvasText(button, () => (t('审阅回到 {version}', { version: entry.before?.version || t('变更前版本') })));
          button.onclick = () => this.previewVersionRollback(entry.id); row.append(button);
        }
        history.append(row);
      }
      this.refreshVersionApply();
      const known = await this.versionRequest('/manage/api/paths/known');
      if (this.versionSession !== session) return;
      const objects = (known.objects || []).filter(object => object.kind === (kind === 'groups' ? 'module-group' : 'module') && (!current.version || !object.id || object.id === current.id));
      if (!objects.length) {
        const emptyHint = document.createElement('span');
        emptyHint.style.cssText = 'font-size:11px; color:var(--muted); font-style:italic;';
        setCanvasText(emptyHint, () => (t('本地暂无同模块制品，可点击上方“🌐 从工坊/社区选择版本”下载')));
        $('version-known-paths').append(emptyHint);
      }
      for (const object of objects) {
        const itemBox = document.createElement('div');
        itemBox.className = 'section-block vm-known-card';
        itemBox.style.cssText = 'background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:8px; padding:8px 12px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; gap:8px;';

        const info = document.createElement('div');
        info.style.cssText = 'flex:1; min-width:0;';
        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:2px;';
        const badge = document.createElement('span');
        badge.className = 'acl-pill online';
        badge.style.cssText = 'font-size:10px; padding:1px 6px;';
        setCanvasText(badge, () => (object.version ? `v${object.version}` : t('本地版本')));
        const titleEl = document.createElement('strong');
        titleEl.style.cssText = 'font-size:12px; color:var(--ink);';
        setCanvasText(titleEl, () => (object.title || object.id || t('已下载制品')));
        titleRow.append(badge, titleEl);

        const pathEl = document.createElement('div');
        pathEl.style.cssText = 'font-size:10px; font-family:var(--mono); color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        setCanvasText(pathEl, () => (object.path));
        info.append(titleRow, pathEl);
        itemBox.append(info);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'hud-btn vm-known-chip';
        button.style.cssText = 'font-size:11px; padding:4px 10px; font-weight:700; flex-shrink:0;';
        setCanvasText(button, () => (t('⚡ 载入并审阅')));
        setCanvasAttribute(button, 'title', () => (object.path));
        button.onclick = async () => {
          if (this.versionSession === session && !session.busy) {
            $('version-source-path').value = object.path;
            this.invalidateVersionReview();
            $('version-known-paths')?.querySelectorAll('.vm-known-chip').forEach(b => b.classList.remove('active'));
            button.classList.add('active');
            await this.previewVersionUpdate();
          }
        };
        itemBox.append(button);
        $('version-known-paths').append(itemBox);
      }
    } catch (error) { if (this.versionSession === session) setCanvasText($('version-error'), () => (error.message)); }
  }

  adaptAndDetectPath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return { path: '', kind: 'unknown', label: t('未知路径') };
    let clean = rawPath.trim().replace(/^["']+|["']+$/g, '').trim();
    const norm = clean.replace(/\\/g, '/');
    const fileName = norm.split('/').pop().toLowerCase();

    // 1. 如果用户在模块目录或模块组目录中选中了 module.json 或 module-group.json，自动自适应定位至其所在根目录
    if (fileName === 'module.json' || fileName === 'module-group.json') {
      const parentDir = clean.replace(/[\\/][^\\/]+$/, '');
      const isGroup = fileName === 'module-group.json';
      return {
        path: parentDir,
        kind: isGroup ? 'module-group-dir' : 'module-dir',
        label: isGroup ? t('模块组目录 (已自适应)') : t('模块目录 (已自适应)')
      };
    }
    // 2. 如果选中的是 deployment.json 或 package.json，同样自适应到上层根目录
    if (fileName === 'deployment.json' || fileName === 'package.json') {
      const parentDir = clean.replace(/[\\/][^\\/]+$/, '');
      return {
        path: parentDir,
        kind: 'module-dir',
        label: t('模块目录 (已自适应)')
      };
    }
    // 3. 如果选中的是 .zip 制品压缩包
    if (fileName.endsWith('.zip')) {
      return {
        path: clean,
        kind: 'zip',
        label: t('制品压缩包 (ZIP)')
      };
    }
    // 4. 如果选中的是 .artifact.json 或 .json 制品文件
    if (fileName.endsWith('.artifact.json') || fileName.endsWith('.json')) {
      return {
        path: clean,
        kind: 'artifact-json',
        label: t('分发制品定义文件 (JSON)')
      };
    }
    // 5. 默认作为本地目录识别
    return {
      path: clean,
      kind: 'directory',
      label: t('本地目录')
    };
  }

  async pickVersionSource(purpose) {
    const session = this.versionSession;
    if (!session || session.busy) return;
    try {
      const selected = await this.versionRequest('/manage/api/paths/native-pick', { purpose, initialPath: $('version-source-path').value });
      if (this.versionSession === session && !selected.cancelled && selected.path) {
        const adapted = this.adaptAndDetectPath(selected.path);
        $('version-source-path').value = adapted.path;
        canvasToast(() => (t('✓ 已自动适应并识别为【{label}】: {path}', { label: adapted.label, path: adapted.path })), 'neutral');
        this.invalidateVersionReview();
      }
    } catch (error) { if (this.versionSession === session) setCanvasText($('version-error'), () => (error.message)); }
  }

  versionControls() {
    return { path: $('version-source-path')?.value?.trim(), configurationPolicy: $('version-configuration-policy')?.value,
      dataPolicy: $('version-data-policy')?.value, rollbackData: $('version-rollback-data')?.value, establishOrigin: Boolean($('version-establish-origin')?.checked) };
  }

  async previewVersionUpdate() { return this.prepareVersionReview('update'); }
  async previewVersionRollback(transactionId) { return this.prepareVersionReview('rollback', transactionId); }

  async prepareVersionReview(action, transactionId) {
    const session = this.versionSession;
    if (!session?.overview || session.busy) return;
    this.versionReviewSourceTab = action === 'rollback' ? 'current' : 'switch';
    this.invalidateVersionReview();
    if (session.overview.recoveryRequired?.length) { setCanvasText($('version-error'), () => (t('请先恢复中断事务，再审阅新的版本变更。'))); return; }
    if (this.versionTargetRunning(session)) { setCanvasText($('version-error'), () => (t('请先停止目标模块，再审阅版本变更。'))); return; }
    const controls = this.versionControls();
    if (action === 'update' && !controls.path) { setCanvasText($('version-error'), () => (t('请先选择已下载的目标版本，或从社区下载。'))); return; }
    const epoch = session.epoch, fingerprint = JSON.stringify(controls);
    const expectedRevision = session.overview.revision ?? session.overview.current?.revision;
    const body = action === 'rollback' ? { transactionId, expectedRevision, dataPolicy: controls.rollbackData }
      : { path: controls.path, expectedRevision, dataPolicy: controls.dataPolicy, configurationPolicy: controls.configurationPolicy,
        ...(controls.establishOrigin ? { establishOrigin: true } : {}) };
    setCanvasText($('version-error'), () => (t('正在核对源码、运行环境、权限与接线…')));
    try {
      const result = await this.versionRequest(`${this.versionEndpoint(session)}/${action === 'rollback' ? 'rollback-preview' : 'preview'}`, body);
      if (this.versionSession !== session || session.epoch !== epoch || JSON.stringify(this.versionControls()) !== fingerprint) return;
      session.review = { ...result, fingerprint, action };
      setCanvasText($('version-error'), () => (''));
      this.renderVersionReview(result.review); this.refreshVersionApply();
      this.switchVersionModalTab('review');
    } catch (error) { if (this.versionSession === session && session.epoch === epoch) setCanvasText($('version-error'), () => (error.message)); }
  }

  renderVersionReview(review) {
    const box = $('version-review'); box.replaceChildren();
    const line = (parent, label, value, css) => {
      const node = document.createElement('p');
      setCanvasText(node, () => (`${label()}${value()}`));
      node.style.cssText = css || 'white-space:pre-wrap;word-break:break-word;font-size:12px;margin:4px 0;';
      parent.append(node);
      return node;
    };
    const compact = value => JSON.stringify(value ?? null);
    const names = values => (values || []).map(value => typeof value === 'string' ? value : value.title || value.programId || value.id || compact(value)).join('、') || t('无');
    const policy = {
      get preserve() { return t('保留当前实例数据'); },
      get fresh() { return t('使用全新实例数据，保存变更前快照'); },
      get restore() { return t('恢复此次历史变更前的本地数据快照'); }
    };

    // 概览卡片
    const summaryCard = document.createElement('div');
    summaryCard.className = 'section-block';
    summaryCard.style.cssText = 'background:rgba(0,210,180,0.06); border:1px solid rgba(0,210,180,0.25); border-radius:8px; padding:12px 14px; margin-bottom:12px;';

    line(summaryCard, () => (review.action === 'rollback' ? t('回退版本：') : t('目标版本：')), () => (`${review.before?.id || ''} @ ${review.before?.version || t('无发行基线')} → ${review.after?.id || ''} @ ${review.after?.version || t('未知')}`), 'font-size:13px; font-weight:700; color:#fff; margin:0 0 6px 0; white-space:pre-wrap; word-break:break-word;');
    line(summaryCard, () => (t('数据策略：')), () => (t('{policy}。数据格式兼容性未验证。', { policy: policy[review.dataPolicy] || review.dataPolicy })), 'font-size:11px; color:#94a3b8; margin:2px 0;');
    line(summaryCard, () => (t('配置策略：')), () => (review.configurationPolicy === 'historical' ? t('恢复该次历史变更前的参数、主题、接线与启动计划。')
      : review.configurationPolicy === 'author' ? t('使用作者默认值；请核对以下参数、接线和权限。') : t('保留当前配置；目标版本不接受的配置会被拒绝。')), 'font-size:11px; color:#94a3b8; margin:2px 0;');
    if (review.establishesOrigin) line(summaryCard, () => (t('首次来源基线：')), () => (t('本次将以所选发行品建立该组的来源身份；后续在此身份下更新。')), 'font-size:11px; color:var(--teal); margin:2px 0;');
    box.append(summaryCard);

    // 程序卡片
    for (const program of review.programs || []) {
      const card = document.createElement('section');
      card.className = 'section-block vm-review-program-card';
      const before = Object.hasOwn(program, 'previousConfiguration') ? program.previousConfiguration
        : this.data.programs.find(item => item.programId === program.programId);
      line(card, () => (`${program.programId}：`), () => (`${program.before ? `${program.before.id} @ ${program.before.version}` : t('新增成员')} → ${program.after?.id} @ ${program.after?.version}${program.change === 'retain' ? t('（保留）') : ''}`), 'font-size:12px; font-weight:700; color:#38bdf8; margin:0 0 6px 0;');
      for (const [title, key] of [['公开参数', 'settings'], ['主题', 'topics'], ['桥发布 / 订阅权限', 'bridges'], ['能力提供者绑定', 'bindings']])
        line(card, () => (`${t(title)}：`), () => (`${compact(before?.[key])} → ${compact(program[key])}`));
      line(card, () => (t('模块权限声明：')), () => (`${compact(before?.permissions ?? before?.manifest?.permissions)} → ${compact(program.manifest?.permissions)}`));
      if (program.executionPolicy) line(card, () => (''), () => this.executionReviewText(program.executionPolicy, program.executionPolicySource || 'local'));
      line(card, () => (t('共享此成员的模块组：')), () => (names(program.affected?.sharedWithGroups)));
      line(card, () => (t('依赖此成员的消费者：')), () => (names(program.affected?.consumers)));
      box.append(card);
    }
    for (const removed of review.removedMembers || []) line(box, () => (t('从组中移除：')), () => (t('从组中移除：{programId}；仍保留为已注册的独立模块，不删除其数据。', { programId: removed.programId })));
    if (review.group) line(box, () => (t('模块组成员与启动计划：')), () => (`${compact(review.group.before)} → ${compact(review.group.after)}`));

    // 执行行为提示卡片
    const notice = document.createElement('div');
    notice.style.cssText = 'background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:10px 12px; margin:10px 0;';
    line(notice, () => (t('执行行为：')), () => (t('替换或新增的模块保持停止；仅移出组并保留独立注册的成员保持原运行状态。不会自动停启业务，实例身份保留。请自行确认目标版本的数据兼容性与外部副作用。')), 'font-size:11px; color:#94a3b8; line-height:1.5; margin:0;');
    box.append(notice);

    const details = document.createElement('details'), summary = document.createElement('summary'), raw = document.createElement('pre');
    details.style.cssText = 'margin-top:10px; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.06); border-radius:6px; padding:6px 10px;';
    summary.style.cssText = 'font-size:11px; color:var(--muted); cursor:pointer; outline:none;';
    setCanvasText(summary, () => (t('完整源码与事务审阅（可选）')));
    setCanvasText(raw, () => (JSON.stringify(review, null, 2)));
    raw.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:10px;color:#94a3b8;max-height:200px;overflow-y:auto;margin:6px 0 0 0;';
    details.append(summary, raw); box.append(details);
  }

  async applyVersionReview() {
    const session = this.versionSession, review = session?.review;
    if (!review?.reviewId || session.busy || !$('version-data-ack')?.checked) return;
    if (this.versionTargetRunning(session) || session.overview?.recoveryRequired?.length) { this.invalidateVersionReview(); setCanvasText($('version-error'), () => (t('目标状态已变化，请停止目标或恢复中断事务后重新审阅。'))); return; }
    if (review.fingerprint !== JSON.stringify(this.versionControls())) { this.invalidateVersionReview(); return; }
    session.busy = true; this.refreshVersionApply(); setCanvasText($('version-error'), () => (t('正在应用已审阅的版本，请等待…')));
    try {
      const result = await this.versionRequest(`${this.versionEndpoint(session)}/apply`, { reviewId: review.reviewId, accepted: true, dataAcknowledged: true });
      if (this.versionSession !== session) return;
      session.busy = false; this.invalidateVersionReview();
      canvasToast(() => (result.cleanupPending ? t('版本切换已完成，已替换或新增的模块保持停止。请在版本管理中清理残留事务标记，再继续操作。')
        : t('版本变更已完成，已替换或新增的模块保持停止。可在版本历史中审阅回退。')), 'neutral');
      await this.fetchModulesData();
      if (this.versionSession === session) await this.openVersionManager(session.kind, session.targetId);
    } catch (error) {
      if (this.versionSession === session) { session.busy = false; this.invalidateVersionReview(); setCanvasText($('version-error'), () => (t('{error}；请刷新版本管理核对当前状态。', { error: error.message }))); }
    }
  }

  async recoverVersionTransaction(transactionId, pending) {
    const session = this.versionSession;
    const message = pending?.status === 'committed' ? t('清理已完成版本事务的残留标记？不会改变软件、配置或本地实例数据。')
      : t('恢复中断的版本事务？将还原变更前的软件、配置与本地实例数据快照；模块保持停止，外部业务副作用无法撤销。');
    if (!session || session.busy || !confirm(message)) return;
    this.invalidateVersionReview(); session.busy = true; this.refreshVersionApply();
    const target = pending?.targetId && ['module', 'module-group'].includes(pending.kind)
      ? { kind: pending.kind === 'module' ? 'modules' : 'groups', targetId: pending.targetId } : session;
    try {
      await this.versionRequest(`${this.versionEndpoint(target)}/recover`, { transactionId, accepted: true });
      session.busy = false; await this.fetchModulesData();
      if (this.versionSession === session) await this.openVersionManager(session.kind, session.targetId);
    } catch (error) { if (this.versionSession === session) { session.busy = false; setCanvasText($('version-error'), () => (error.message)); this.refreshVersionApply(); } }
  }

  openVersionWorkshop() {
    const session = this.versionSession;
    if (!session?.overview || session.busy) return;
    this.invalidateVersionReview();
    const grp = session.kind === 'groups' ? this.data?.groups?.find(g => g.id === session.targetId) : null;
    const prog = session.kind === 'modules' ? this.data?.programs?.find(p => p.programId === session.targetId) : null;
    const matchedEntry = grp ? this.getGroupUpdateInfo(grp)?.targetEntry : this.getModuleUpdateInfo(prog)?.targetEntry;
    const resolvedId = matchedEntry?.id || (session.overview.current?.version ? session.overview.current?.id : null);
    const identity = session.overview.current?.version ? session.overview.current?.id : (resolvedId || null);
    this.requiredWorkshopProvider = null;
    this.versionWorkshopTarget = {
      session,
      identity: identity || resolvedId || null,
      kind: session.kind === 'groups' ? 'module-group' : 'module',
      searchHint: resolvedId || identity || (grp?.title || session.targetId),
      autoOpened: false
    };
    $('module-version-modal').classList.add('hidden');
    if ($('inp-ws-search')) $('inp-ws-search').value = this.versionWorkshopTarget.identity || this.versionWorkshopTarget.searchHint || '';
    if ($('sel-ws-type')) $('sel-ws-type').value = this.versionWorkshopTarget.kind;
    if ($('sel-ws-contract')) $('sel-ws-contract').value = 'all';
    this.openOnlineWorkshopModal(); this.renderWorkshopCards();
    canvasToast(() => (t('选择所需发行版本下载后，将返回当前实例的版本审阅，不会新建实例。')), 'neutral');
  }

  // 22. 导入模块模态框逻辑
  async openImportModal() {
    this.currentImportReview = null; this.importProviderSelection = null;
    $('import-provider-selection')?.remove();
    $('inp-import-path')?.classList.remove('input-error');
    $('import-module-modal')?.classList.remove('hidden');
    $('import-preview-box')?.classList.add('hidden');
    $('btn-confirm-import').disabled = true;

    // 拉取已知可用模块
    try {
      const res = await fetch('/manage/api/paths/known');
      if (res.ok) {
        const data = await res.json();
        const box = $('import-known-paths');
        box.replaceChildren();
        const moduleObjects = (data.objects || []).filter(o => ['module', 'module-group'].includes(o.kind));
        if (!moduleObjects.length) {
          setCanvasHtml(box, () => ('<span style="font-size:11px; color:var(--muted);" data-i18n="未检测到预设模块">未检测到预设模块</span>'));
        } else {
          moduleObjects.forEach(p => {
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'hud-btn';
            pill.style.fontSize = '10px';
            setCanvasText(pill, () => (`📦 ${p.title || p.id || p.path.split(/[/\\]/).pop()}`));
            setCanvasAttribute(pill, 'title', () => (p.path));
            pill.addEventListener('click', () => {
              $('inp-import-path').value = p.path;
              this.inspectImportModule();
            });
            box.append(pill);
          });
        }
      }
    } catch {}
  }

  closeImportModal() {
    $('import-module-modal')?.classList.add('hidden');
  }

  async inspectImportModule(options = {}) {
    const input = $('inp-import-path');
    let dir = input?.value?.trim();
    if (!dir) {
      if (!options.silentIfInvalidDir) {
        input?.classList.add('input-error');
        input?.focus();
        canvasToast(() => (t('请先输入或选择本地模块目录、ZIP 或 artifact.json 完整路径')), 'warning');
      }
      return;
    }
    input?.classList.remove('input-error');

    // 自动清理两侧可能存在的引号（Windows资源管理器“复制为路径”常带有双引号）
    dir = dir.replace(/^["']+|["']+$/g, '').trim();

    // 智能自适应路径（如用户直接输入了 module.json 或 module-group.json）
    const adapted = this.adaptAndDetectPath(dir);
    if (adapted.path && adapted.path !== dir) {
      dir = adapted.path;
      if (input) input.value = dir;
      canvasToast(() => (t('已自动自适应路径为【{label}】: {dir}', { label: adapted.label, dir })), 'neutral');
    } else {
      if (input) input.value = dir;
    }

    const inspectBtn = $('btn-do-inspect');
    const originalBtnText = inspectBtn ? inspectBtn.textContent : t('检测模块');
    if (inspectBtn) {
      inspectBtn.disabled = true;
      setCanvasText(inspectBtn, () => (t('检测中...')));
    }

    this.currentImportReview = null;
    $('btn-confirm-import').disabled = true;
    $('import-preview-box')?.classList.add('hidden');
    $('import-provider-selection')?.remove();

    try {
      const progId = `prog-${Date.now().toString(36)}`;
      const res = await fetch('/manage/api/artifacts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
        body: JSON.stringify({ programId: progId, path: dir,
          ...(this.importProviderSelection?.path === dir ? { bindings: this.importProviderSelection.bindings(),
            connectionSelections: this.importProviderSelection.connections() } : {}) })
      });
      if (res.ok) {
        const data = await res.json();
        if ($('inp-import-path')?.value?.trim() !== dir) return;
        if (data.selectionRequired) {
          $('import-provider-selection')?.remove();
          const panel = document.createElement('section');
          panel.id = 'import-provider-selection';
          panel.className = 'section-block';
          panel.style.cssText = 'margin-top:12px; background:rgba(245, 158, 11, 0.08); border:1px solid rgba(245, 158, 11, 0.35); border-radius:6px; padding:12px;';

          const header = document.createElement('div');
          header.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:8px; font-weight:600; color:var(--gold, #f59e0b);';
          setCanvasHtml(header, () => (`<span>${canvasLabel(() => (t('⚠️ 检测到该模块需依赖接线配置')))}</span>`));
          panel.append(header);

          const note = document.createElement('p');
          note.style.cssText = 'font-size:12px; margin-bottom:10px; line-height:1.5;';
          setCanvasText(note, () => (t('按作者声明准备默认接线。缺少目标时先下载并导入；多个匹配实例时选择一个，再点击“检测模块”。')));
          panel.append(note);

          const selections = [];
          const connections = [];
          for (const connection of data.defaultConnections || []) {
            const label = document.createElement('label');
            label.style.cssText = 'display:block; margin-bottom:8px; font-size:12px;';
            setCanvasText(label, () => (`${connection.id} → ${connection.provider.moduleId} @ ${connection.provider.version}`));
            const specification = document.createElement('p');
            specification.style.cssText = 'font-size:11px; color:var(--muted); margin:2px 0;';
            const contractsStr = connection.contracts.map(contract => `${contract.id} @ ${contract.version}`).join('、') || t('仅主题连接');
            const topicsStr = Object.entries(connection.topics).map(([alias, target]) => `${alias} → ${target}`).join('、') || t('仅能力绑定');
            setCanvasText(specification, () => (t('契约：{contracts}；主题：{topics}', { contracts: contractsStr, topics: topicsStr })));
            label.append(specification);
            if (connection.status === 'resolved') {
              const ready = document.createElement('p');
              ready.style.cssText = 'color:var(--teal); font-size:11px;';
              setCanvasText(ready, () => (t('已自动匹配：{id}', { id: connection.providerId })));
              label.append(ready);
            } else if (connection.status === 'missing') {
              const missing = document.createElement('p');
              missing.style.cssText = 'color:#f87171; font-size:11px; margin:4px 0;';
              setCanvasText(missing, () => (t('尚无版本、契约和主题方向均匹配的已安装实例。请下载并导入所需模块；已下载但未导入的模块还不能接线。')));
              const download = document.createElement('button');
              download.type = 'button';
              download.className = 'hub-btn';
              download.style.fontSize = '11px';
              setCanvasText(download, () => (t('查找所需模块')));
              download.onclick = () => this.findRequiredModule(connection.provider, dir);
              label.append(missing, download);
            } else {
              const select = document.createElement('select');
              select.className = 'drawer-input';
              select.style.marginTop = '4px';
              select.add(canvasOption(() => (t('请选择目标实例')), ''));
              for (const candidate of connection.candidates) select.add(canvasOption(() => (`${candidate.module.id} @ ${candidate.module.version} · ${candidate.programId} · ${candidate.state}`), candidate.programId));
              label.append(select);
              connections.push({ id: connection.id, select });
            }
            panel.append(label);
          }
          for (const required of data.requiredProviders || []) {
            const label = document.createElement('label');
            label.style.cssText = 'display:block; margin-bottom:8px; font-size:12px;';
            setCanvasText(label, () => (`${required.contract.id} @ ${required.contract.version}`));
            const select = document.createElement('select');
            select.className = 'drawer-input';
            select.style.marginTop = '4px';
            select.add(canvasOption(() => (t('请选择提供者')), ''));
            for (const candidate of required.candidates) select.add(canvasOption(() => (`${candidate.module.id} · ${candidate.programId} · ${candidate.state}`), candidate.programId));
            label.append(select);
            panel.append(label);
            selections.push({ contract: required.contract, select });
            if (!required.candidates.length) {
              const missing = document.createElement('p');
              missing.style.cssText = 'color:#f87171; font-size:11px;';
              setCanvasText(missing, () => (t('本机暂无匹配提供者，请先导入对应模块，或使用包含提供者的模块组。')));
              panel.append(missing);
            }
          }
          $('inp-import-path')?.closest('.hub-modal-body')?.append(panel);
          panel.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
          this.importProviderSelection = {
            path: dir,
            bindings: () => selections.filter(item => item.select.value).map(item => ({ providerId: item.select.value, contract: item.contract })),
            connections: () => Object.fromEntries(connections.filter(item => item.select.value).map(item => [item.id, item.select.value]))
          };
          canvasToast(() => (t('检测到该模块需依赖接线配置，请在下方选择目标实例后重新点击“检测模块”')), 'warning');
          return;
        }
        $('import-provider-selection')?.remove();
        this.currentImportReview = data;
        this.currentImportReview.sourcePath = dir;
        const rev = data.review;

        setCanvasText($('import-prev-title'), () => (rev.manifest?.title || rev.manifest?.id || progId));
        setCanvasText($('import-prev-runtime'), () => (data.kind === 'module-group'
          ? t('模块组 · {count} 个独立模块 · 同一个本机 Hub', { count: rev.members.length })
          : t('运行环境: {kind}', { kind: rev.manifest?.runtime?.kind || 'node' })));
        setCanvasText($('import-prev-desc'), () => (data.kind === 'module-group'
          ? t('将还原作者预置的主题、能力绑定和启动计划，无需重新手动接线。请审阅下方配置；导入后所有成员保持停止。')
          : t('请核对源码、权限、运行环境和接线。导入后保持停止；权限声明不构成系统沙箱。')));
        let details = $('import-review-details');
        if (!details) { details = document.createElement('div'); details.id = 'import-review-details'; $('import-preview-box').append(details); }
        details.replaceChildren(); details.style.cssText = 'max-height:300px;overflow:auto;font-size:11px;';
        const members = data.kind === 'module-group' ? rev.members.map(member => member.review) : [rev];
        for (const member of members) {
          const card = document.createElement('section'); card.style.cssText = 'border-top:1px solid var(--border);padding:8px 0;white-space:pre-wrap;word-break:break-word;';
          const title = document.createElement('strong'); setCanvasText(title, () => (`${member.module.id} @ ${member.module.version} · ${member.manifest.runtime.kind}`));
          card.append(title);
          if (member.executionPolicy) {
            const policy = document.createElement('p'); policy.className = 'action-help-text';
            setCanvasText(policy, () => this.executionReviewText(member.executionPolicy, member.executionPolicySource));
            card.append(policy);
          }
          const content = document.createElement('p');
          const rules = () => Object.entries(member.bridges).map(([slot, permissions]) => `${slot}：${t('发布')} ${(permissions.publish || []).map(alias => member.topics[alias]).join('、') || t('无')}；${t('接收')} ${(permissions.subscribe || []).map(alias => member.topics[alias]).join('、') || t('无')}`).join('\n');
          const bindings = (member.bindings || []).map(binding => {
            const target = rev.members?.find(item => item.programId === binding.providerId)?.review || this.data.programs?.find(item => item.programId === binding.providerId);
            return `${binding.contract.id} @ ${binding.contract.version} → ${target?.module?.id || binding.providerId} (${binding.providerId})`;
          });
          setCanvasText(content, () => (`${rules()}\n${t('能力接线：')}${bindings.join('；') || t('无')}\n${t('公开参数：')}${JSON.stringify(member.settings)}\n${t('权限声明：')}${JSON.stringify(member.manifest.permissions)}`));
          card.append(content); details.append(card);
        }
        for (const connection of rev.defaultConnections || []) {
          const line = document.createElement('p');
          setCanvasText(line, () => (t('默认接线已准备：{id} → {moduleId} @ {version} ({providerId})；主题 {topics}。确认导入后生效。', { id: connection.id, moduleId: connection.provider.moduleId, version: connection.provider.version, providerId: connection.providerId, topics: Object.entries(connection.topics).map(([alias, target]) => `${alias} → ${target}`).join('、') || t('无主题映射') })));
          details.append(line);
        }
        if (data.kind === 'module-group') {
          const order = document.createElement('p');
          setCanvasText(order, () => (t('启动计划：{plan}。导入本身不会执行此计划。', { plan: rev.manifest.startupPlan.startupOrder.map(id => `${id}${rev.manifest.startupPlan.members.find(member => member.programId === id).enabled ? '' : t('（手动启动）')}`).join(' → ') })));
          details.append(order);
        }
        const technical = document.createElement('details'), summary = document.createElement('summary'), raw = document.createElement('pre');
        setCanvasText(summary, () => (t('源码、解释器与绑定详情（可选）'))); raw.style.whiteSpace = 'pre-wrap'; setCanvasText(raw, () => (JSON.stringify(rev, null, 2)));
        technical.append(summary, raw); details.append(technical);

        $('import-preview-box')?.classList.remove('hidden');
        $('btn-confirm-import').disabled = false;
        $('import-preview-box')?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
        canvasToast(() => (t('✓ 模块检测通过，请审阅下方配置并确认导入')), 'neutral');
      } else {
        if (!options.silentIfInvalidDir) {
          const err = await res.json().catch(() => ({}));
          canvasToast(() => (t('检测未通过: {error}', { error: errorText(err) })), 'error');
        }
      }
    } catch (e) {
      if (!options.silentIfInvalidDir) {
        canvasToast(() => (t('检测异常: {error}', { error: e.message })), 'error');
      }
    } finally {
      if (inspectBtn) {
        inspectBtn.disabled = false;
        setCanvasText(inspectBtn, () => (originalBtnText));
      }
    }
  }

  async confirmImportModule() {
    if (!this.currentImportReview?.reviewId) return;
    if (this.currentImportReview.sourcePath !== $('inp-import-path')?.value?.trim()) { this.currentImportReview = null; $('btn-confirm-import').disabled = true; return; }
    try {
      const res = await fetch('/manage/api/artifacts/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
        body: JSON.stringify({ kind: this.currentImportReview.kind, reviewId: this.currentImportReview.reviewId, accepted: true })
      });
      if (res.ok) {
        canvasToast(() => (t('已导入通信画布，模块保持停止，可按需启动。')), 'neutral');
        this.closeImportModal();
        await this.fetchModulesData();
        this.autoLayout();
        const pending = this.pendingDependencyImports?.at(-1), review = this.currentImportReview.review;
        const importedModules = review.members?.map(member => member.review.module) || [review.module];
        if (pending && importedModules.some(module => module.id === pending.provider.moduleId && module.version === pending.provider.version)) {
          this.pendingDependencyImports.pop();
          await this.openImportModal();
          $('inp-import-path').value = pending.path;
          canvasToast(() => (t('所需模块已导入，继续检测原模块的默认接线。')), 'neutral');
          await this.inspectImportModule();
        }
      } else {
        const err = await res.json();
        canvasToast(() => (t('导入失败: {error}', { error: errorText(err) })), 'error');
      }
    } catch (e) {
      canvasToast(() => (t('导入异常: {error}', { error: e.message })), 'error');
    }
  }

  findRequiredModule(provider, path) {
    this.pendingDependencyImports ??= [];
    if (!this.pendingDependencyImports.some(item => item.path === path && item.provider.moduleId === provider.moduleId && item.provider.version === provider.version))
      this.pendingDependencyImports.push({ path, provider });
    this.requiredWorkshopProvider = provider;
    this.closeImportModal();
    if ($('inp-ws-search')) $('inp-ws-search').value = provider.moduleId;
    if ($('sel-ws-type')) $('sel-ws-type').value = 'module';
    if ($('sel-ws-contract')) $('sel-ws-contract').value = 'all';
    this.openOnlineWorkshopModal();
    this.renderWorkshopCards();
    canvasToast(() => (t('请下载并导入 {moduleId} @ {version}；可更换作者提供的工坊源或从本地导入。', { moduleId: provider.moduleId, version: provider.version })), 'neutral');
  }

  // 23. 分组管理模态框逻辑
  openGroupModal() {
    $('group-manager-modal')?.classList.remove('hidden');
    const inp = $('inp-new-group-title');
    if (inp) {
      inp.value = '';
      inp.classList.remove('input-error');
      setTimeout(() => inp.focus(), 50);
    }
    this.renderGroupListModal();
  }

  closeGroupModal() {
    $('group-manager-modal')?.classList.add('hidden');
  }

  renderGroupListModal() {
    const box = $('group-list-box');
    if (!box) return;
    box.replaceChildren();

    const groups = this.data.groups || [];
    const dissolvedGroups = this.data.dissolvedGroups || [];

    if (!groups.length && !dissolvedGroups.length) {
      const emptyDiv = document.createElement('div');
      emptyDiv.style.cssText = 'font-size:11px; color:var(--muted); padding:8px 0;';
      setCanvasText(emptyDiv, () => (t('暂无自定义模块组。')));
      box.append(emptyDiv);
      return;
    }

    if (!groups.length) {
      const emptyActive = document.createElement('div');
      emptyActive.style.cssText = 'font-size:11px; color:var(--muted); padding:6px 0;';
      setCanvasText(emptyActive, () => (t('当前暂无活跃分组。')));
      box.append(emptyActive);
    } else {
      groups.forEach(g => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.padding = '8px 12px';
        item.style.background = 'rgba(255,255,255,0.03)';
        item.style.borderRadius = '8px';
        item.style.border = '1px solid var(--border)';
        item.style.flexWrap = 'wrap'; item.style.gap = '8px';

        const description = document.createElement('div');
        const title = document.createElement('strong'); title.style.cssText = 'color:var(--ink);font-size:12px;'; setCanvasText(title, () => (`📁 ${g.title || g.id}`));
        const count = document.createElement('span'); count.style.cssText = 'font-size:10px;color:var(--muted);margin-left:8px;'; setCanvasText(count, () => (t('成员: {count} 个模块', { count: (g.memberProgramIds || []).length })));
        description.append(title, count); item.append(description);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'hud-btn danger';
        remove.style.cssText = 'font-size:11px; padding:4px 12px;';
        setCanvasText(remove, () => (t('解散分组')));
        setCanvasAttribute(remove, 'title', () => (t('解散此分组关系；组内模块自身、运行进程与本地数据均完好保留')));
        remove.onclick = () => this.removeModuleGroupOnly(g.id, g.revision, g.title || g.id);
        item.append(remove);

        box.append(item);
      });
    }

    if (dissolvedGroups.length > 0) {
      const sectionHeader = document.createElement('div');
      sectionHeader.style.cssText = 'margin-top:16px; padding-top:12px; border-top:1px dashed rgba(255,255,255,0.1);';

      const titleRow = document.createElement('div');
      titleRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;';
      const label = document.createElement('span');
      label.style.cssText = 'font-size:11px; font-weight:600; color:#818cf8;';
      setCanvasText(label, () => (t('📦 已解散分组 ({count}) · 可撤销恢复', { count: dissolvedGroups.length })));
      titleRow.append(label);
      sectionHeader.append(titleRow);

      const subtitle = document.createElement('div');
      subtitle.style.cssText = 'font-size:10px; color:var(--muted); margin-bottom:8px;';
      setCanvasText(subtitle, () => (t('解散后模块仍保留在画布上。点击“撤销解散”可原样重建分组关系、作者出厂接线基线与启动计划。')));
      sectionHeader.append(subtitle);

      box.append(sectionHeader);

      dissolvedGroups.forEach(dg => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.padding = '8px 12px';
        item.style.background = 'rgba(129,140,248,0.04)';
        item.style.borderRadius = '8px';
        item.style.border = '1px solid rgba(129,140,248,0.18)';
        item.style.flexWrap = 'wrap'; item.style.gap = '8px';

        const description = document.createElement('div');
        const title = document.createElement('strong'); title.style.cssText = 'color:#e0e7ff;font-size:12px;'; setCanvasText(title, () => (`📁 ${dg.title || dg.id}`));
        const count = document.createElement('span'); count.style.cssText = 'font-size:10px;color:var(--muted);margin-left:8px;';
        const dTime = dg.dissolvedAt ? new Date(dg.dissolvedAt).toLocaleTimeString() : '';
        setCanvasText(count, () => (dTime ? t('原成员: {count} 个 · 解散于 {time}', { count: (dg.memberProgramIds || []).length, time: dTime }) : t('原成员: {count} 个', { count: (dg.memberProgramIds || []).length })));
        description.append(title, count); item.append(description);

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex; gap:6px; align-items:center;';

        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'hub-btn primary';
        restoreBtn.style.cssText = 'font-size:10px; padding:3px 10px; background:rgba(59,130,246,0.2); border-color:rgba(59,130,246,0.5); color:#93c5fd;';
        setCanvasText(restoreBtn, () => (t('↩ 撤销解散')));
        setCanvasAttribute(restoreBtn, 'title', () => (t('重新恢复此模块组，还原组内结构、作者接线基线与启动编排')));
        restoreBtn.onclick = () => this.restoreModuleGroup(dg.id, dg.title || dg.id);

        const discardBtn = document.createElement('button');
        discardBtn.type = 'button';
        discardBtn.className = 'hud-btn';
        discardBtn.style.cssText = 'font-size:10px; padding:3px 8px; color:var(--muted);';
        setCanvasText(discardBtn, () => (t('🗑 彻底清除')));
        setCanvasAttribute(discardBtn, 'title', () => (t('从归档中彻底清除此解散记录（组内模块依然完好保留）')));
        discardBtn.onclick = () => this.discardDissolvedGroup(dg.id, dg.title || dg.id);

        actions.append(restoreBtn, discardBtn);
        item.append(actions);
        box.append(item);
      });
    }
  }

  async removeModuleGroupOnly(id, expectedRevision, title = id) {
    this.removingGroupIds ??= new Set();
    if (this.removingGroupIds.has(id) || !confirm(t('确定解散分组 "{title}" 吗？组内模块自身、进程、源码与数据均保留，后续可在下方“已解散”列表中随时撤销恢复。', { title }))) return;
    this.removingGroupIds.add(id);
    try {
      await this.uninstallRequest(`/manage/api/groups/${encodeURIComponent(id)}/remove`, { expectedRevision });
      if (this.groupFilter === id) this.groupFilter = 'all';
      try { const refresh = await this.fetchModulesData(); if (refresh?.refreshed === false) throw refresh.error; this.renderGroupListModal(); }
      catch (error) { canvasToast(() => (t('分组已删除，模块保留；列表刷新失败：{error}。请刷新页面。', { error: error.message })), 'error'); return; }
      canvasToast(() => (t('已成功解散分组 "{title}"，模块保留。可在下方“已解散”列表中随时撤销恢复。', { title })), 'neutral');
    } catch (error) {
      canvasToast(() => (t('解散分组失败：{error}', { error: error.message })), 'error');
    } finally { this.removingGroupIds.delete(id); }
  }

  async restoreModuleGroup(id, title = id) {
    try {
      canvasToast(() => (t('正在恢复分组 "{title}"...', { title })), 'neutral');
      const res = await fetch(`/manage/api/groups/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        canvasToast(() => (t('恢复分组失败: {error}', { error: errorText(err) })), 'error');
        return;
      }
      await this.fetchModulesData();
      this.renderGroupListModal();
      canvasToast(() => (t('✓ 已成功撤销解散，恢复分组 "{title}"！', { title })), 'neutral');
    } catch (e) {
      canvasToast(() => (t('恢复分组异常: {error}', { error: e.message })), 'error');
    }
  }

  async discardDissolvedGroup(id, title = id) {
    if (!confirm(t('确定彻底清除已解散分组 "{title}" 的归档记录吗？清除后不可撤销恢复（组内模块依然完好保留）。', { title }))) return;
    try {
      const res = await fetch(`/manage/api/groups/${encodeURIComponent(id)}/discard`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        canvasToast(() => (t('清除失败: {error}', { error: errorText(err) })), 'error');
        return;
      }
      await this.fetchModulesData();
      this.renderGroupListModal();
      canvasToast(() => (t('已彻底清除 "{title}" 归档记录。', { title })), 'neutral');
    } catch (e) {
      canvasToast(() => (t('清除异常: {error}', { error: e.message })), 'error');
    }
  }

  async createModuleGroup() {
    const inp = $('inp-new-group-title');
    const title = inp?.value?.trim();
    if (!title) {
      inp?.focus();
      inp?.classList.add('input-error');
      canvasToast(() => (t('请输入新建分组的名称')), 'neutral');
      return;
    }

    const btn = $('btn-create-group');
    if (btn) {
      btn.disabled = true;
      setCanvasText(btn, () => (t('创建中...')));
    }

    const id = `grp-${Date.now().toString(36)}`;
    try {
      const res = await fetch('/manage/api/groups/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
        body: JSON.stringify({
          group: {
            id,
            title,
            memberProgramIds: [],
            startupPlan: { members: [], onFailure: 'continue-independent' }
          }
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error?.message || data.message || `HTTP ${res.status}`);
      }
      if (inp) {
        inp.value = '';
        inp.classList.remove('input-error');
      }
      canvasToast(() => (t('成功创建分组: {title}', { title })), 'neutral');
      await this.fetchModulesData();
      this.renderGroupListModal();
    } catch (e) {
      canvasToast(() => (t('创建分组失败: {error}', { error: e.message })), 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        setCanvasText(btn, () => (t('新建组')));
      }
    }
  }

  // 22. 编排计划与分组计划统一获取/保存
  getActivePlan() {
    const group = this.groupFilter === 'all' ? null : (this.data.groups || []).find(item => item.id === this.groupFilter);
    const ids = group ? group.memberProgramIds || [] : (this.data.programs || []).map(row => row.programId);
    const existing = group ? group.startupPlan : this.data.startupPlan;
    // Reading a plan must never enroll modules or change the saved selection.
    const plan = structuredClone(existing || { format: 'world-hub.launcher-startup-plan/v1', members: [], onFailure: 'continue-independent' });
    const allowed = new Set(ids);
    plan.members = (plan.members || []).filter(row => allowed.has(row.programId));
    for (const id of ids) if (!plan.members.some(row => row.programId === id)) plan.members.push({ programId: id, enabled: false, after: [] });
    return plan;
  }

  async saveActivePlan(plan, silentToast = false, scope = this.groupFilter) {
    const group = scope === 'all' ? null : (this.data.groups || []).find(item => item.id === scope);
    if (scope !== 'all' && !group) { canvasToast(() => (t('保存失败：原模块组已不可用。')), 'error'); return false; }
    try {
      const res = await fetch(group ? '/manage/api/groups/save' : '/manage/api/programs/startup-plan/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify(group ? { group: { ...group, startupPlan: structuredClone(plan) }, expectedRevision: group.revision }
          : { plan, expectedRevision: plan.revision })
      });
      const result = await res.json();
      if (!res.ok || result.error) throw new Error(errorText(result));
      const refresh = await this.fetchModulesData();
      if (refresh?.refreshed === false) { canvasToast(() => (t('计划已保存，但列表刷新失败。请刷新页面后继续。')), 'error'); return true; }
      if (!silentToast) canvasToast(() => (t('已保存常驻启动计划选择，不会立即启动模块。')), 'neutral');
      return true;
    } catch (e) {
      canvasToast(() => (t('保存编排计划异常: {error}', { error: e.message })), 'error');
      return false;
    }
  }

  // 23. 抽屉通道保存
  async saveTopicsFromDrawer() {
    if (!this.selectedModuleId) return;
    const prog = this.data.programs.find(p => p.programId === this.selectedModuleId);
    if (!prog) return;

    const newTopics = { ...(prog.topics || {}) };
    document.querySelectorAll('.mod-topic-input').forEach(inp => {
      if (inp.dataset.alias) newTopics[inp.dataset.alias] = inp.value.trim();
    });

    try {
      const res = await fetch(`/manage/api/programs/${this.selectedModuleId}/configuration/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || '' },
        body: JSON.stringify({
          expectedRevision: prog.configurationRevision,
          settings: prog.settings || {},
          topics: newTopics,
          bridges: prog.bridges || {},
          bindings: prog.bindings || []
        })
      });
      if (res.ok) {
        canvasToast(() => (t('通道接线已更新并重新生效')), 'neutral');
        await this.fetchModulesData();
        if (this.selectedModuleId === prog.programId) this.selectModule(prog.programId);
      } else {
        const err = await res.json();
        canvasToast(() => (t('通道保存失败: {error}', { error: err.message })), 'error');
      }
    } catch (e) {
      canvasToast(() => (t('通道保存异常: {error}', { error: e.message })), 'error');
    }
  }

  // 24. 原生文件与文件夹自适应选择器
  async pickNativeModuleDirectory(purpose = 'module') {
    try {
      canvasToast(() => (t('正在打开系统选择器...')), 'neutral');
      const res = await fetch('/manage/api/paths/native-pick', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({ purpose, initialPath: $('inp-import-path')?.value || '' })
      });
      if (!res.ok) {
        const err = await res.json();
        canvasToast(() => (t('选择器异常: {error}', { error: err.message || err.error })), 'error');
        return;
      }
      const data = await res.json();
      if (data.cancelled) {
        canvasToast(() => (t('已取消系统选择')), 'neutral');
        return;
      }
      if (data.path) {
        const adapted = this.adaptAndDetectPath(data.path);
        $('inp-import-path').value = adapted.path;
        canvasToast(() => (t('✓ 已自动适应并识别为【{label}】: {path}', { label: adapted.label, path: adapted.path })), 'neutral');
        await this.inspectImportModule();
      }
    } catch (e) {
      canvasToast(() => (t('原生选择器错误: {error}', { error: e.message })), 'error');
    }
  }

  // 25. 环境探测模态窗口与探测请求
  openEnvModal() {
    $('env-detect-modal')?.classList.remove('hidden');
    this.probeEnvironment();
  }

  closeEnvModal() {
    $('env-detect-modal')?.classList.add('hidden');
  }

  async probeEnvironment() {
    const cards = $('env-detect-cards');
    const candidatesBox = $('env-candidates-box');
    if (cards) setCanvasHtml(cards, () => (`<div style="font-size:12px; color:var(--teal);">${canvasLabel(() => (t('正在探测本机 Node.js 与 Python 运行环境...')))}</div>`));

    try {
      const res = await fetch('/manage/api/environment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const err = await res.json();
        const msg = err.error?.message || err.message || (typeof err.error === 'string' ? err.error : t('未知错误'));
        if (cards) setCanvasHtml(cards, () => (`<div style="color:var(--rose);">${canvasLabel(() => (t('探测失败: {error}', { error: msg })))}</div>`));
        return;
      }
      const data = await res.json();
      const node = data.environment?.node || {};
      const py = data.environment?.python || {};
      const candidates = data.candidates || { node: [], python: [] };

      if (cards) {
        setCanvasHtml(cards, () => (`
          <div style="background:rgba(255,255,255,0.03); border:1px solid ${node.available ? 'var(--teal)' : 'var(--rose)'}; border-radius:8px; padding:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong style="color:var(--teal); font-size:13px;">${canvasLabel(() => (t('Node.js 运行时')))}</strong>
              <span class="acl-pill" style="border-color:${node.available ? 'var(--teal)' : 'var(--rose)'}; color:${node.available ? 'var(--teal)' : 'var(--rose)'};">
                ${canvasLabel(() => (node.available ? t('✓ 可用') : t('✕ 未就绪')))}
              </span>
            </div>
            <div style="font-size:11px; margin-top:6px; color:#fff; font-family:var(--mono);">
              ${canvasLabel(() => (t('版本:')))} ${canvasLabel(() => node.version || t('未知'))} · ${canvasLabel(() => (t('架构:')))} ${canvasLabel(() => node.arch || t('未知'))}
            </div>
            <div style="font-size:10px; margin-top:2px; color:var(--muted); font-family:var(--mono); word-break:break-all;">
              ${canvasLabel(() => (t('路径:')))} ${canvasLabel(() => node.executable || node.requested || t('未定位'))}
            </div>
          </div>

          <div style="background:rgba(255,255,255,0.03); border:1px solid ${py.available ? 'var(--teal)' : 'var(--amber)'}; border-radius:8px; padding:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong style="color:var(--amber); font-size:13px;">${canvasLabel(() => (t('Python 运行时')))}</strong>
              <span class="acl-pill" style="border-color:${py.available ? 'var(--teal)' : 'var(--amber)'}; color:${py.available ? 'var(--teal)' : 'var(--amber)'};">
                ${canvasLabel(() => (py.available ? t('✓ 可用') : t('⚠ 未就绪')))}
              </span>
            </div>
            <div style="font-size:11px; margin-top:6px; color:#fff; font-family:var(--mono);">
              ${canvasLabel(() => (t('版本:')))} ${canvasLabel(() => py.version || t('未知'))} · ${canvasLabel(() => (t('架构:')))} ${canvasLabel(() => py.arch || t('未知'))} · ${canvasLabel(() => (t('位长:')))} ${py.pointerBits || 64}-bit
            </div>
            <div style="font-size:11px; margin-top:4px; color:${py.packages?.websockets ? 'var(--teal)' : 'var(--rose)'};">
              ${canvasLabel(() => (t('websockets 依赖:')))} ${canvasLabel(() => (py.packages?.websockets ? t('✓ {version} (已就绪)', { version: py.packages.websockets }) : t('✕ 未安装 (需 pip install websockets)')))}
            </div>
            <div style="font-size:10px; margin-top:2px; color:var(--muted); font-family:var(--mono); word-break:break-all;">
              ${canvasLabel(() => (t('路径:')))} ${canvasLabel(() => py.executable || py.requested || t('未定位'))}
            </div>
          </div>
        `));
      }

      if (candidatesBox) {
        const allCandidates = [
          ...(candidates.node || []).map(c => `[Node] ${c.path} (${c.source})`),
          ...(candidates.python || []).map(c => `[Python] ${c.path} (${c.source})`)
        ];
        if (allCandidates.length) {
          setCanvasHtml(candidatesBox, () => (allCandidates.map(c => `<div style="padding:2px 0;">${c}</div>`).join('')));
        } else {
          setCanvasText(candidatesBox, () => (t('无候选解释器')));
        }
      }
    } catch (e) {
      if (cards) setCanvasHtml(cards, () => (`<div style="color:var(--rose);">${canvasLabel(() => (t('探测请求异常: {error}', { error: e.message })))}</div>`));
    }
  }

  // 26. 网页端目录树浏览器
  toggleTreeBrowser() {
    const browser = $('import-tree-browser');
    if (!browser) return;
    const isHidden = browser.classList.toggle('hidden');
    const toggleBtn = $('btn-toggle-tree-browser');
    if (toggleBtn) setCanvasText(toggleBtn, () => (isHidden ? t('📂 展开网页目录树浏览...') : t('📂 收起网页目录树浏览')));
    if (!isHidden) {
      const cur = $('inp-import-path')?.value?.trim();
      this.loadTreeBrowser(cur || undefined);
    }
  }

  async loadTreeBrowser(dirPath) {
    const list = $('tree-entries-list');
    const pathSpan = $('tree-current-path');
    const rootsBar = $('tree-roots-bar');
    if (list) setCanvasHtml(list, () => (`<div style="color:var(--muted); padding:4px;">${canvasLabel(() => (t('正在读取目录条目...')))}</div>`));
    try {
      if (dirPath) {
        dirPath = dirPath.replace(/^["']+|["']+$/g, '').trim();
        if (/\.[a-zA-Z0-9]+$/.test(dirPath)) {
          dirPath = dirPath.replace(/[\\/][^\\/]+$/, '') || dirPath;
        }
      }
      const res = await fetch('/manage/api/paths/browse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({ directory: dirPath, purpose: 'module' })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (list) setCanvasHtml(list, () => (`<div style="color:var(--rose); padding:4px;">${canvasLabel(() => (t('读取失败: {error}', { error: err.message || err.error || t('无法读取目录') })))}</div>`));
        return;
      }
      const data = await res.json();
      if (pathSpan) setCanvasText(pathSpan, () => (data.directory || ''));
      if (rootsBar && data.roots) {
        rootsBar.replaceChildren();
        data.roots.forEach(root => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'hub-btn';
          btn.style.padding = '1px 6px';
          btn.style.fontSize = '10px';
          const rName = typeof root === 'string' ? root : (root.name || root.path || '');
          const rPath = typeof root === 'string' ? root : (root.path || root.name || '');
          setCanvasText(btn, () => (rName));
          setCanvasAttribute(btn, 'title', () => (t('切换到 {path}', { path: rPath })));
          btn.onclick = () => {
            this.loadTreeBrowser(rPath);
            if ($('inp-import-path')) $('inp-import-path').value = rPath;
          };
          rootsBar.append(btn);
        });
      }
      this.renderTreeEntries(data);
    } catch (e) {
      if (list) setCanvasHtml(list, () => (`<div style="color:var(--rose); padding:4px;">${canvasLabel(() => (t('浏览异常: {error}', { error: e.message })))}</div>`));
    }
  }

  renderTreeEntries(data) {
    const list = $('tree-entries-list');
    if (!list) return;
    list.replaceChildren();

    // 父级目录项
    if (data.parent) {
      const parentRow = document.createElement('div');
      parentRow.style.display = 'flex';
      parentRow.style.alignItems = 'center';
      parentRow.style.padding = '4px 6px';
      parentRow.style.borderRadius = '4px';
      parentRow.style.cursor = 'pointer';
      parentRow.style.color = 'var(--muted)';
      setCanvasHtml(parentRow, () => (`<span>📁 .. (${canvasLabel(() => (t('返回上一级目录')))})</span>`));
      parentRow.onmouseenter = () => parentRow.style.background = 'rgba(255,255,255,0.05)';
      parentRow.onmouseleave = () => parentRow.style.background = 'transparent';
      parentRow.onclick = () => {
        this.loadTreeBrowser(data.parent);
        if ($('inp-import-path')) $('inp-import-path').value = data.parent;
      };
      list.append(parentRow);
    }

    if (!data.entries || !data.entries.length) {
      const empty = document.createElement('div');
      empty.style.color = 'var(--muted)';
      empty.style.padding = '4px';
      setCanvasText(empty, () => (t('(当前目录为空)')));
      list.append(empty);
      return;
    }

    data.entries.forEach(entry => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';
      row.style.padding = '3px 6px';
      row.style.borderRadius = '4px';
      row.style.cursor = entry.kind === 'directory' ? 'pointer' : 'default';

      const left = document.createElement('div');
      left.style.display = 'flex';
      left.style.alignItems = 'center';
      left.style.gap = '6px';
      left.style.overflow = 'hidden';
      left.style.textOverflow = 'ellipsis';
      left.style.whiteSpace = 'nowrap';

      const icon = entry.kind === 'directory' ? '📁' : '📄';
      const name = document.createElement('span');
      setCanvasText(name, () => (`${icon} ${entry.name}`));
      name.style.color = entry.kind === 'directory' ? '#fff' : 'var(--muted)';
      left.append(name);

      if (entry.object?.kind === 'module') {
        const badge = document.createElement('span');
        badge.className = 'acl-pill';
        badge.style.border = '1px solid var(--teal)';
        badge.style.color = 'var(--teal)';
        badge.style.fontSize = '9px';
        badge.style.padding = '0 4px';
        setCanvasText(badge, () => (t('📦 模块 ({kind})', { kind: entry.object.title || entry.object.runtimeKind || 'module' })));
        left.append(badge);
      }

      row.append(left);

      const right = document.createElement('div');
      right.style.display = 'flex';
      right.style.gap = '4px';

      if (entry.object?.kind === 'module' || entry.kind === 'directory') {
        const selectBtn = document.createElement('button');
        selectBtn.type = 'button';
        selectBtn.className = 'hub-btn';
        selectBtn.style.padding = '1px 6px';
        selectBtn.style.fontSize = '10px';
        setCanvasText(selectBtn, () => (t('选择此路径')));
        selectBtn.onclick = (e) => {
          e.stopPropagation();
          $('inp-import-path').value = entry.path;
          this.inspectImportModule();
        };
        right.append(selectBtn);
      }

      row.append(right);

      row.onmouseenter = () => row.style.background = 'rgba(255,255,255,0.06)';
      row.onmouseleave = () => row.style.background = 'transparent';

      if (entry.kind === 'directory') {
        row.onclick = () => {
          this.loadTreeBrowser(entry.path);
          if ($('inp-import-path')) $('inp-import-path').value = entry.path;
        };
      }

      list.append(row);
    });
  }

  // 27. 外部客户端接入授权管理
  openExternalModal() {
    $('external-grant-modal')?.classList.remove('hidden');
    $('ext-grant-result')?.classList.add('hidden');
    this.currentSnippets = null;
    this.currentCodeTab = 'python';
    this.fetchExternalInventory();
  }

  closeExternalModal() {
    $('external-grant-modal')?.classList.add('hidden');
  }

  switchCodeTab(lang) {
    this.currentCodeTab = lang;
    $('tab-code-python')?.classList.toggle('active', lang === 'python');
    $('tab-code-node')?.classList.toggle('active', lang === 'node');
    if (this.currentSnippets) {
      setCanvasText($('ext-code-snippet'), () => (this.currentSnippets[lang] || ''));
    }
  }

  async copySnippetCode() {
    const code = $('ext-code-snippet')?.textContent;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      canvasToast(() => (t('代码已复制到剪贴板')), 'neutral');
    } catch {
      canvasToast(() => (t('复制失败，请手动选择复制')), 'error');
    }
  }

  async quickGrantExternal() {
    const programId = $('inp-ext-id')?.value?.trim();
    if (!programId) {
      canvasToast(() => (t('请填写客户端标识 (programId)')), 'error');
      return;
    }
    const title = $('inp-ext-title')?.value?.trim() || programId;
    const publish = $('inp-ext-publish')?.value?.trim() || '';
    const subscribe = $('inp-ext-subscribe')?.value?.trim() || '';

    try {
      canvasToast(() => (t('正在签发外部凭证与通信配额...')), 'neutral');
      const res = await fetch('/manage/api/external/quick-grant', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({ programId, title, publish, subscribe })
      });
      if (!res.ok) {
        const err = await res.json();
        canvasToast(() => (t('授权失败: {error}', { error: err.message || err.error })), 'error');
        return;
      }
      const data = await res.json();
      this.currentSnippets = data.snippets;
      $('ext-grant-result')?.classList.remove('hidden');
      this.switchCodeTab(this.currentCodeTab || 'python');
      canvasToast(() => (t('✓ 凭证签发成功！可复制代码并在外部运行')), 'neutral');
      await this.fetchExternalInventory();
    } catch (e) {
      canvasToast(() => (t('授权异常: {error}', { error: e.message })), 'error');
    }
  }

  async fetchExternalInventory() {
    const list = $('ext-grants-list');
    const countSpan = $('ext-active-count');
    try {
      const res = await fetch('/manage/api/external');
      if (!res.ok) return;
      const data = await res.json();
      const records = data.programs || data.records || [];
      if (countSpan) setCanvasText(countSpan, () => (String(records.length)));
      if (!list) return;
      list.replaceChildren();

      if (!records.length) {
        setCanvasHtml(list, () => (`<div style="font-size:12px; color:var(--muted); padding:8px;">${canvasLabel(() => (t('暂无外部授权程序')))}</div>`));
        return;
      }

      records.forEach(r => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.padding = '8px 12px';
        item.style.background = 'rgba(255,255,255,0.03)';
        item.style.borderRadius = '8px';
        item.style.border = '1px solid var(--border)';

        const left = document.createElement('div');
        const pub = (r.bridges?.[0]?.publish || []).join(', ') || '无';
        const sub = (r.bridges?.[0]?.subscribe || []).join(', ') || '无';
        setCanvasHtml(left, () => (`
          <div>
            <strong style="color:var(--teal); font-size:12px;">🔗 ${r.title || r.programId}</strong>
            <span style="font-size:10px; color:var(--muted); margin-left:6px; font-family:var(--mono);">${r.programId}</span>
          </div>
          <div style="font-size:10px; color:var(--muted); margin-top:2px;">
            ${canvasLabel(() => (t('发布通道:')))} <span style="color:#fff;">${canvasLabel(() => (r.bridges?.[0]?.publish || []).join(', ') || t('无'))}</span> · ${canvasLabel(() => (t('订阅通道:')))} <span style="color:#fff;">${canvasLabel(() => (r.bridges?.[0]?.subscribe || []).join(', ') || t('无'))}</span>
          </div>
        `));
        item.append(left);

        const revokeBtn = document.createElement('button');
        revokeBtn.type = 'button';
        revokeBtn.className = 'hub-btn danger';
        revokeBtn.style.padding = '2px 8px';
        revokeBtn.style.fontSize = '10px';
        setCanvasText(revokeBtn, () => (t('撤销授权')));
        revokeBtn.onclick = () => this.revokeExternalGrant(r.programId);
        item.append(revokeBtn);

        list.append(item);
      });
    } catch (e) {
      console.warn('拉取外部凭证记录失败:', e);
    }
  }

  async revokeExternalGrant(programId) {
    if (!confirm(t('确定要撤销外部客户端 "{programId}" 的通信凭证吗？撤销后该客户端将无法连接世界枢纽。', { programId }))) return;
    try {
      const res = await fetch('/manage/api/external/quick-revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({ programId })
      });
      if (res.ok) {
        canvasToast(() => (t('已撤销外部客户端 "{programId}" 的通信授权', { programId })), 'neutral');
        await this.fetchExternalInventory();
      } else {
        const err = await res.json();
        canvasToast(() => (t('撤销失败: {error}', { error: err.message || err.error })), 'error');
      }
    } catch (e) {
      canvasToast(() => (t('撤销请求异常: {error}', { error: e.message })), 'error');
    }
  }

  // 28. 模块安全审计与指纹审查模态框
  async openSecurityReviewModal() {
    if (!this.selectedModuleId) return;
    const modal = $('security-review-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const mod = (this.data.programs || []).find(p => p.programId === this.selectedModuleId);
    setCanvasText($('review-mod-title'), () => (mod?.module?.name || mod?.programId || this.selectedModuleId));
    setCanvasText($('review-mod-id'), () => (this.selectedModuleId));
    $('review-digest-val').value = t('正在计算模块 SHA-256 审计指纹...');
    setCanvasText($('review-exec-path'), () => (t('正在读取...')));
    setCanvasText($('review-exec-digest'), () => (t('正在读取...')));
    setCanvasText($('review-source-dir'), () => (t('正在读取...')));
    setCanvasHtml($('review-permissions-box'), () => (`<div style="color:var(--muted);">${canvasLabel(() => (t('正在解析权限...')))}</div>`));
    setCanvasText($('review-downstream-box'), () => (t('正在分析拓扑依赖...')));

    try {
      const res = await fetch(`/manage/api/programs/${this.selectedModuleId}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const err = await res.json();
        $('review-digest-val').value = t('审查失败: {error}', { error: err.message || err.error });
        return;
      }
      const data = await res.json();
      const rev = data.review || {};
      $('review-digest-val').value = rev.digest || t('无指纹');
      setCanvasText($('review-profile-badge'), () => (rev.executionProfile || 'trusted-local'));

      // 运行时解释器
      const rtKind = rev.manifest?.runtime?.kind || 'node';
      const rtEnv = rev.environment?.[rtKind] || {};
      setCanvasText($('review-exec-path'), () => (rtEnv.executable || '-'));
      setCanvasText($('review-exec-digest'), () => (rtEnv.sha256 || '-'));
      setCanvasText($('review-source-dir'), () => (rev.directory || '-'));

      // 权限与 ACL
      const permBox = $('review-permissions-box');
      permBox.replaceChildren();

      const perms = rev.permissions || {};
      const addPerm = (label, value, ok) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.padding = '2px 0';
        setCanvasHtml(row, () => (`<span style="color:var(--muted);">${canvasLabel(label)}:</span> <span style="font-family:var(--mono); color:${ok ? 'var(--teal)' : 'var(--amber)'};">${canvasLabel(value)}</span>`));
        permBox.append(row);
      };

      addPerm(() => t('子进程托管 (Processes)'), () => perms.processes || t('owned-children (Launcher 独占托管)'), true);
      addPerm(() => t('网络权限 (Network)'), () => Array.isArray(perms.network) && perms.network.length ? perms.network.join(', ') : t('无网络监听权限'), true);
      addPerm(() => t('文件系统权限 (Filesystem)'), () => perms.filesystem || t('模块独立私有运行空间 (state/tmp)'), true);

      // 通道通信权限
      const pubTopics = [...new Set(Object.values(rev.bridges || {}).flatMap(b => (b.publish || []).map(a => rev.topics?.[a] || a)))];
      const subTopics = [...new Set(Object.values(rev.bridges || {}).flatMap(b => (b.subscribe || []).map(a => rev.topics?.[a] || a)))];
      addPerm(() => t('允许发布主题 (Publish)'), () => pubTopics.join(', ') || t('无'), true);
      addPerm(() => t('允许订阅主题 (Subscribe)'), () => subTopics.join(', ') || t('无'), true);

      // 下游依赖影响
      const downBox = $('review-downstream-box');
      if (rev.providerConfigurationBoundary) {
        setCanvasText(downBox, () => (`⚠ ${rev.providerConfigurationBoundary}`));
        downBox.style.color = 'var(--amber)';
      } else {
        setCanvasText(downBox, () => (t('✓ 此模块配置独立，不影响其他外部服务的接入边界。')));
        downBox.style.color = 'var(--teal)';
      }
    } catch (e) {
      $('review-digest-val').value = t('审查请求异常: {error}', { error: e.message });
    }
  }

  closeSecurityReviewModal() {
    $('security-review-modal')?.classList.add('hidden');
  }

  // 29. 模块创作与工坊解耦弹窗
  openScaffoldModal() {
    $('modal-module-scaffold')?.classList.remove('hidden');
  }

  closeScaffoldModal() {
    $('modal-module-scaffold')?.classList.add('hidden');
  }

  openPackageModal() {
    const selector = $('inp-pkg-group');
    selector.replaceChildren(canvasOption(() => (t('模块 / 模块组源码目录')), ''));
    for (const group of this.data.groups) selector.add(canvasOption(() => (t('模块组：{title}', { title: group.title })), group.id));
    if (this.groupFilter !== 'all') selector.value = this.groupFilter;
    $('inp-pkg-redistribution').checked = false;
    $('modal-module-package')?.classList.remove('hidden');
  }

  closePackageModal() {
    $('modal-module-package')?.classList.add('hidden');
  }

  openOnlineWorkshopModal() {
    $('modal-module-workshop')?.classList.remove('hidden');
    const chk = $('inp-workshop-private-network');
    if (chk) {
      const stored = localStorage.getItem('hub.workshop.allowPrivateNetwork');
      chk.checked = stored !== '0';
    }
    this.switchWorkshopView('online');
    this.loadWorkshopCache();
    this.loadWorkshopSources().then(() => {
      if (!this.workshopEntries || this.workshopEntries.length === 0) {
        this.inspectWorkshopSource();
      }
    });
  }

  closeOnlineWorkshopModal() {
    $('modal-module-workshop')?.classList.add('hidden');
    this.closeWorkshopLightbox();
    $('modal-workshop-detail')?.classList.add('hidden');
    this.requiredWorkshopProvider = null;
    const target = this.versionWorkshopTarget;
    this.versionWorkshopTarget = null;
    if (target) {
      if ($('inp-ws-search')) $('inp-ws-search').value = '';
      if ($('sel-ws-type')) $('sel-ws-type').value = 'all';
      if ($('sel-ws-contract')) $('sel-ws-contract').value = 'all';
      this.renderWorkshopCards();
    }
    if (target && this.versionSession === target.session) $('module-version-modal')?.classList.remove('hidden');
  }

  openWorkshopLightbox(src, caption) {
    const box = $('modal-workshop-lightbox');
    const img = $('ws-lightbox-img');
    const cap = $('ws-lightbox-caption');
    if (!box || !img) return;
    img.src = src;
    if (cap) setCanvasText(cap, () => (caption || ''));
    box.classList.remove('hidden');
  }

  closeWorkshopLightbox() {
    const box = $('modal-workshop-lightbox');
    const img = $('ws-lightbox-img');
    if (box) box.classList.add('hidden');
    if (img) img.src = '';
  }

  closeWorkshopDetailModal() {
    $('modal-workshop-detail')?.classList.add('hidden');
    if (this.versionWorkshopTarget) {
      this.closeOnlineWorkshopModal();
    }
  }

  // 兼容旧接口 openWorkshopModal(tab) 与 closeWorkshopModal()
  openWorkshopModal(tab = 'scaffold') {
    if (tab === 'package') {
      this.openPackageModal();
    } else if (tab === 'online') {
      this.openOnlineWorkshopModal();
    } else {
      this.openScaffoldModal();
    }
  }

  closeWorkshopModal() {
    this.closeScaffoldModal();
    this.closePackageModal();
    this.closeOnlineWorkshopModal();
    $('workshop-creator-modal')?.classList.add('hidden');
  }

  // 29.1 侧边工具坞折叠菜单显隐控制
  toggleDockFlyout() {
    const panel = $('dock-add-flyout-panel');
    const btn = $('btn-dock-add-menu');
    if (!panel) return;
    const isOpen = panel.classList.toggle('open');
    btn?.classList.toggle('active', isOpen);
    const svg = btn?.querySelector('svg');
    if (svg) svg.style.transform = isOpen ? 'rotate(45deg)' : 'none';
  }

  closeDockFlyout() {
    const panel = $('dock-add-flyout-panel');
    const btn = $('btn-dock-add-menu');
    panel?.classList.remove('open');
    btn?.classList.remove('active');
    const svg = btn?.querySelector('svg');
    if (svg) svg.style.transform = 'none';
  }

  switchWorkshopTab(tab) {
    ['scaffold', 'package', 'online'].forEach(t => {
      $(`tab-ws-${t}`)?.classList.toggle('active', t === tab);
      $(`ws-panel-${t}`)?.classList.toggle('hidden', t !== tab);
    });
    if (tab === 'online') {
      this.loadWorkshopSources();
    }
  }

  async pickFolderGeneric(title) {
    try {
      canvasToast(() => (t('正在打开系统文件夹选择器...')), 'neutral');
      const res = await fetch('/manage/api/paths/native-pick', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({ purpose: 'module', title })
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.path) {
        canvasToast(() => (t('已选择目录: {path}', { path: data.path })), 'neutral');
        return data.path;
      }
      return null;
    } catch {
      return null;
    }
  }

  async doScaffoldModule() {
    const id = $('inp-scaffold-id')?.value?.trim();
    if (!id || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      canvasToast(() => (t('请输入合法的模块标识（小写英文、数字或中划线）')), 'error');
      return;
    }
    const title = $('inp-scaffold-title')?.value?.trim() || id;
    const runtime = $('sel-scaffold-runtime')?.value || 'python';
    const entry = $('inp-scaffold-entry')?.value?.trim() || (runtime === 'python' ? 'main.py' : 'index.mjs');
    const publish = $('inp-scaffold-publish')?.value?.trim() || '';
    const subscribe = $('inp-scaffold-subscribe')?.value?.trim() || '';
    const directory = $('inp-scaffold-dir')?.value?.trim() || '';
    const mode = $('sel-scaffold-execution-mode')?.value || 'resident';
    const seconds = Number($('inp-scaffold-idle-seconds')?.value ?? '60');
    if (!['resident', 'on-demand'].includes(mode) || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400) {
      canvasToast(() => t('请选择有效运行方式，空闲等待须为 1 至 86400 的整数秒。'), 'error'); return;
    }

    try {
      canvasToast(() => (t('正在构建模块规范与代码脚手架...')), 'neutral');
      const res = await fetch('/manage/api/creator/scaffold', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({ id, title, runtime, entry, publish, subscribe, directory, executionDefaults: { mode, idleTimeoutMs: seconds * 1000 } })
      });
      if (!res.ok) {
        const err = await res.json();
        canvasToast(() => (t('创建脚手架失败: {error}', { error: err.message || err.error })), 'error');
        return;
      }
      const data = await res.json();
      canvasToast(() => (t('✓ 模块 "{title}" 脚手架创建成功并已加入画布！', { title })), 'neutral');
      this.closeWorkshopModal();
      await this.fetchModulesData();
      this.autoLayout();
      if (data.programId) {
        this.selectModule(data.programId);
      }
    } catch (e) {
      canvasToast(() => (t('创建异常: {error}', { error: e.message })), 'error');
    }
  }

  async doPackageModule() {
    const directory = $('inp-pkg-source')?.value?.trim();
    const destination = $('inp-pkg-dest')?.value?.trim();
    const group = this.data.groups.find(item => item.id === $('inp-pkg-group').value);
    if ((!directory && !group) || !destination) {
      canvasToast(() => (t('请选择源模块目录和打包输出目录')), 'error');
      return;
    }
    if (!$('inp-pkg-redistribution').checked) { canvasToast(() => (t('请先确认有权再分发所选源码，并检查公开参数。')), 'error'); return; }

    try {
      canvasToast(() => (t('正在验证模块规范并打包制品...')), 'neutral');
      const res = await fetch(group ? `/manage/api/groups/${group.id}/export` : '/manage/api/creator/package', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({ directory, destination, version: $('inp-pkg-version').value.trim(), expectedRevision: group?.revision, redistributionAcknowledged: true })
      });
      if (!res.ok) {
        const err = await res.json();
        canvasToast(() => (t('打包失败: {error}', { error: err.message || err.error })), 'error');
        return;
      }
      const data = await res.json();
      const resBox = $('pkg-result-box');
      const resContent = $('pkg-result-content');
      if (resBox && resContent) {
        resBox.classList.remove('hidden');
        setCanvasHtml(resContent, () => (`
          <div><strong data-i18n="制品清单:">制品清单:</strong> ${htmlText(data.artifactPath)}</div>
          <div><strong data-i18n="索引文件:">索引文件:</strong> ${htmlText(data.indexPath)}</div>
          <div><strong data-i18n="包含条目:">包含条目:</strong> ${(data.index?.entries || []).map(e => `${htmlText(e.id)}@${htmlText(e.version)} (SHA: ${htmlText(e.sha256?.slice(0, 16))}...)`).join('<br>')}</div>
        `));
      }
      canvasToast(() => (t('✓ 已导出分发制品，可上传社区。未发布到远端。')), 'neutral');
    } catch (e) {
      canvasToast(() => (t('打包异常: {error}', { error: e.message })), 'error');
    }
  }

  async loadWorkshopSources() {
    try {
      const res = await fetch('/manage/api/workshop/sources');
      if (!res.ok) return;
      const data = await res.json();
      const sources = data.sources || [];
      if (sources.length && !$('inp-workshop-source-url').value) {
        $('inp-workshop-source-url').value = sources[0].source || '';
      }
    } catch {}
  }

  getEntryDescription(entry) {
    if (entry.description) return localizedText(entry.description);
    if (entry.summary) return localizedText(entry.summary);
    if (entry.id === 'demo.text-desk') {
      return t('跨语言文本台：三个独立程序（Node 文本源、Python 统计分析、Web 界面）通过 Hub 协同接线与通信，全流程双向流式交互。');
    }
    if (entry.id === 'demo.desk') {
      return t('独立文本台界面：提供简洁的可视化 Web 界面，调用 text.read 与 text.statistics 契约，并实时显示统计指标与日志。');
    }
    if (entry.id === 'demo.source') {
      return t('独立文本来源：Node.js 编写的独立程序，向 Hub 发布与维护可读文本内容，支持实时读写与内容变更广播。');
    }
    if (entry.id === 'demo.stats') {
      return t('独立文本统计：Python 编写的高效统计分析程序，提供 Unicode 字符数、行数、字节数与 SHA-256 算法计算。');
    }
    if (entry.kind === 'module-group') {
      return t('包含多个协同子模块的标准编排拓扑组合，一次性统一下载并部署。');
    }
    const cap = (entry.provides || []).map(p => p.id).join(', ');
    return cap
      ? t('提供 {provides} 的独立受管模块。', { provides: cap })
      : t('提供核心计算能力的独立受管模块。');
  }

  async inspectWorkshopSource() {
    const source = $('inp-workshop-source-url')?.value?.trim();
    const allowPrivateNetwork = $('inp-workshop-private-network')?.checked === true;
    const box = $('workshop-entries-box');
    const counter = $('ws-results-counter');
    if (!box) return;
    setCanvasHtml(box, () => (`<div style="color:var(--teal); padding:20px; text-align:center; grid-column:1/-1;">${canvasLabel(() => (t('正在拉取工坊源索引与社区模块目录...')))}</div>`));
    if (counter) setCanvasText(counter, () => (t('正在连接检索工坊源...')));

    try {
      const res = await fetch('/manage/api/workshop/inspect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({ source, allowPrivateNetwork })
      });
      const data = await res.json();
      if (!data.ok && data.offline) {
        const isPrivate = /private or unsupported address/i.test(data.error?.message || '') || /私网|代理/.test(data.guidance || '');
        setCanvasHtml(box, () => (`
          <div style="grid-column:1/-1; background:rgba(245,158,11,0.08); border:1px solid var(--amber); border-radius:8px; padding:16px;">
            <div style="color:var(--amber); font-weight:700; margin-bottom:6px; font-size:13px;">⚠ ${canvasLabel(() => data.error?.message || t('工坊源无法连接'))}</div>
            <div style="color:var(--muted); font-size:11px; margin-bottom:${isPrivate ? '10px' : '0'}; line-height:1.5;">${canvasLabel(() => data.guidance || t('可使用本地制作的索引文件。'))}</div>
            ${isPrivate ? `<button type="button" class="hub-btn primary" id="btn-retry-with-private" style="font-size:11px; padding:6px 14px; cursor:pointer;">${canvasLabel(() => (t('✓ 信任本机代理/私网并重试')))}</button>` : ''}
          </div>
        `));
        if (counter) setCanvasText(counter, () => (t('工坊源离线或需代理授权')));
        if (isPrivate) {
          $('btn-retry-with-private')?.addEventListener('click', () => {
            const chk = $('inp-workshop-private-network');
            if (chk) {
              chk.checked = true;
              localStorage.setItem('hub.workshop.allowPrivateNetwork', '1');
            }
            this.inspectWorkshopSource();
          });
        }
        return;
      }
      if (!res.ok) {
        setCanvasHtml(box, () => (`<div style="grid-column:1/-1; color:var(--red); padding:16px;">${canvasLabel(() => (t('检索失败: {error}', { error: errorText(data) })))}</div>`));
        if (counter) setCanvasText(counter, () => (t('检索失败')));
        return;
      }

      this.workshopData = data;
      const allEntries = (data.index?.entries || []).filter(entry => ['module', 'module-group'].includes(entry.kind));
      this.workshopEntries = allEntries;
      this.updateAllVersionBadges();

      // 动态填充契约下拉选项
      const contractSelect = $('sel-ws-contract');
      if (contractSelect) {
        const currentContract = contractSelect.value;
        const contractsSet = new Set();
        for (const entry of allEntries) {
          for (const p of (entry.provides || [])) if (p.id) contractsSet.add(p.id);
          for (const r of (entry.requires || [])) if (r.id) contractsSet.add(r.id);
        }
        contractSelect.replaceChildren(canvasOption(() => (t('🔌 全部契约 (All Contracts)')), 'all'));
        for (const c of Array.from(contractsSet).sort()) {
          contractSelect.add(canvasOption(() => (t('契约: {contract}', { contract: c })), c));
        }
        if (contractsSet.has(currentContract)) {
          contractSelect.value = currentContract;
        }
      }

      if (Array.isArray(data.cachedSha256s)) {
        this.cachedSha256s = new Set(data.cachedSha256s);
      }
      this.loadWorkshopCache();

      this.renderWorkshopCards();
    } catch (e) {
      setCanvasHtml(box, () => (`<div style="grid-column:1/-1; color:var(--red); padding:16px;">${canvasLabel(() => (t('检索异常: {error}', { error: e.message })))}</div>`));
      if (counter) setCanvasText(counter, () => (t('连接异常')));
    }
  }

  renderWorkshopCards(focusFamily) {
    const box = $('workshop-entries-box');
    const counter = $('ws-results-counter');
    if (!box) return;

    const entries = this.workshopEntries || [];
    const selectionScope = `${this.workshopData?.source || ''}\n${this.workshopData?.digest || ''}`;
    if (this.workshopVersionSelectionScope !== selectionScope) {
      this.workshopVersionSelectionScope = selectionScope;
      this.workshopVersionSelections = new Map();
    }
    if (!entries.length) {
      setCanvasHtml(box, () => (`<div style="grid-column:1/-1; color:var(--muted); padding:30px; text-align:center;">${canvasLabel(() => (t('当前工坊源无可用模块条目。')))}</div>`));
      if (counter) setCanvasText(counter, () => (t('无可用条目')));
      return;
    }

    const searchQuery = $('inp-ws-search')?.value?.trim().toLowerCase() || '';
    const typeFilter = $('sel-ws-type')?.value || 'all';
    const contractFilter = $('sel-ws-contract')?.value || 'all';
    const sortRule = $('sel-ws-sort')?.value || 'default';

    // 更新搜索清空按钮与重置筛选按钮
    const clearBtn = $('btn-ws-search-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !searchQuery);
    const resetBtn = $('btn-ws-reset-filters');
    const hasFilter = searchQuery || typeFilter !== 'all' || contractFilter !== 'all' || sortRule !== 'default';
    if (resetBtn) resetBtn.style.display = hasFilter ? 'block' : 'none';

    // 按家族分组：kind:id
    const families = new Map();
    for (const entry of entries) {
      if (this.requiredWorkshopProvider && (entry.kind !== 'module' || entry.id !== this.requiredWorkshopProvider.moduleId || entry.version !== this.requiredWorkshopProvider.version)) continue;
      const target = this.versionWorkshopTarget;
      if (target && (entry.kind !== target.kind || target.identity && entry.id !== target.identity)) continue;
      const key = `${entry.kind}:${entry.id}`;
      if (!families.has(key)) families.set(key, []);
      families.get(key).push(entry);
    }

    // 过滤家族
    const matchedFamilies = [];
    for (const [key, versions] of families.entries()) {
      versions.sort((a, b) => compareSourceVersions(b.version, a.version));
      const latest = versions[0];

      // 类型筛选
      if (typeFilter !== 'all' && latest.kind !== typeFilter) continue;

      // 契约筛选
      if (contractFilter !== 'all') {
        const hasContract = versions.some(v =>
          (v.provides || []).some(p => p.id === contractFilter) ||
          (v.requires || []).some(r => r.id === contractFilter)
        );
        if (!hasContract) continue;
      }

      // 关键词搜索（支持标题、包名ID、作者、描述、契约）
      if (searchQuery) {
        const matchTitle = (latest.title || '').toLowerCase().includes(searchQuery);
        const matchId = (latest.id || '').toLowerCase().includes(searchQuery);
        const matchOwner = (latest.owner?.username || '').toLowerCase().includes(searchQuery);
        const matchDesc = this.getEntryDescription(latest).toLowerCase().includes(searchQuery);
        const matchContracts = versions.some(v =>
          (v.provides || []).some(p => (p.id || '').toLowerCase().includes(searchQuery)) ||
          (v.requires || []).some(r => (r.id || '').toLowerCase().includes(searchQuery))
        );
        if (!matchTitle && !matchId && !matchOwner && !matchDesc && !matchContracts) {
          continue;
        }
      }

      matchedFamilies.push(versions);
    }

    // 排序
    matchedFamilies.sort((aList, bList) => {
      const a = aList[0], b = bList[0];
      if (sortRule === 'name') {
        return (a.title || a.id).localeCompare(b.title || b.id, window.hubCanvas?.language || 'zh-CN');
      }
      if (sortRule === 'versions') {
        return (bList.length || 1) - (aList.length || 1);
      }
      if (sortRule === 'groups-first') {
        if (a.kind === 'module-group' && b.kind !== 'module-group') return -1;
        if (a.kind !== 'module-group' && b.kind === 'module-group') return 1;
        return (a.title || a.id).localeCompare(b.title || b.id, window.hubCanvas?.language || 'zh-CN');
      }
      // default: module-group first, then title
      if (a.kind === 'module-group' && b.kind !== 'module-group') return -1;
      if (a.kind !== 'module-group' && b.kind === 'module-group') return 1;
      return (a.title || a.id).localeCompare(b.title || b.id, window.hubCanvas?.language || 'zh-CN');
    });

    if (counter) {
      setCanvasText(counter, () => (hasFilter
        ? t('共筛选出 {count} 个条目 (共 {total} 个)', { count: matchedFamilies.length, total: families.size })
        : t('共 {count} 个可用模块与编排组 (官方源同步)', { count: matchedFamilies.length })));
    }

    box.replaceChildren();

    if (!matchedFamilies.length) {
      if (this.requiredWorkshopProvider) {
        box.replaceChildren();
        const note = document.createElement('p');
        setCanvasText(note, () => (t('当前工坊源未找到 {moduleId} @ {version}。可更换发布者提供的工坊源，或下载后从本地导入；不会自动改用其它版本。', { moduleId: this.requiredWorkshopProvider.moduleId, version: this.requiredWorkshopProvider.version })));
        box.append(note);
        return;
      }
      setCanvasHtml(box, () => (`
        <div style="grid-column:1/-1; text-align:center; padding:50px 20px; color:var(--muted);">
          <div style="font-size:32px; margin-bottom:10px;">🔍</div>
          <div style="font-size:14px; font-weight:600; color:#cbd5e1; margin-bottom:6px;">${canvasLabel(() => (t('未找到匹配的工坊模块')))}</div>
          <div style="font-size:11px;">${canvasLabel(() => (t('尝试更换搜索关键词，或重置类型/契约筛选条件')))}</div>
          <button type="button" class="hub-btn primary" id="btn-ws-empty-reset" style="margin-top:16px;">${canvasLabel(() => (t('重置所有筛选')))}</button>
        </div>
      `));
      $('btn-ws-empty-reset')?.addEventListener('click', () => this.resetWorkshopFilters());
      return;
    }

    const allowPrivateNetwork = $('inp-workshop-private-network')?.checked === true;

    for (const versions of matchedFamilies) {
      const family = `${versions[0].kind}:${versions[0].id}`;
      let activeEntry = versions.find(entry => entry.entryId === this.workshopVersionSelections.get(family)) || versions[0];
      const card = document.createElement('div');
      card.className = 'ws-card';
      card.onclick = () => this.openWorkshopDetailModal(activeEntry, versions);

      // 1. Cover
      const coverBox = document.createElement('div');
      coverBox.className = 'ws-card-cover';
      const coverUrl = activeEntry.presentation?.cover?.url;
      if (coverUrl) {
        const img = document.createElement('img');
        img.src = coverUrl;
        setCanvasAttribute(img, 'alt', () => (activeEntry.presentation?.cover?.alt || activeEntry.title || activeEntry.id));
        img.onerror = () => {
          img.remove();
          const emptyCover = document.createElement('div');
          emptyCover.className = 'ws-card-cover-empty';
          setCanvasHtml(emptyCover, () => (`
            <div style="font-size:26px; opacity:0.6; margin-bottom:4px;">${activeEntry.kind === 'module-group' ? '🧩' : '📦'}</div>
            <div style="font-size:10px; color:rgba(255,255,255,0.4); font-family:var(--mono);">${htmlText(activeEntry.id)}</div>
          `));
          coverBox.prepend(emptyCover);
        };
        coverBox.append(img);
      } else {
        const emptyCover = document.createElement('div');
        emptyCover.className = 'ws-card-cover-empty';
        setCanvasHtml(emptyCover, () => (`
          <div style="font-size:26px; opacity:0.6; margin-bottom:4px;">${activeEntry.kind === 'module-group' ? '🧩' : '📦'}</div>
          <div style="font-size:10px; color:rgba(255,255,255,0.4); font-family:var(--mono);">${htmlText(activeEntry.id)}</div>
        `));
        coverBox.append(emptyCover);
      }

      // Badges on cover
      const isGroup = activeEntry.kind === 'module-group';
      const kindBadge = document.createElement('span');
      kindBadge.className = `ws-card-badge-kind ${isGroup ? 'ws-badge-group' : 'ws-badge-module'}`;
      setCanvasText(kindBadge, () => (isGroup ? t('🧩 模块组') : t('📦 独立模块')));
      coverBox.append(kindBadge);

      const verBadge = document.createElement('span');
      verBadge.className = 'ws-card-badge-version';
      setCanvasText(verBadge, () => (`v${activeEntry.version}${versions.length > 1 ? ` (${t('{count}版', { count: versions.length })})` : ''}`));
      coverBox.append(verBadge);

      const isCached = Boolean(this.cachedSha256s?.has(activeEntry.sha256));
      const cachedItem = isCached ? this.cachedArtifacts?.find(a => a.sha256 === activeEntry.sha256) : null;
      const isInstalled = cachedItem?.installed;

      if (isCached) {
        const cachedBadge = document.createElement('span');
        cachedBadge.className = isInstalled ? 'ws-card-badge-installed' : 'ws-card-badge-cached';
        setCanvasText(cachedBadge, () => (isInstalled ? t('🟢 已导入') : t('💾 已下载')));
        setCanvasAttribute(cachedBadge, 'title', () => (isInstalled ? t('已在本地 Hub 中导入运行') : t('已下载至本地缓存，可立即审阅导入')));
        coverBox.append(cachedBadge);
      }

      card.append(coverBox);

      // 2. Body
      const body = document.createElement('div');
      body.className = 'ws-card-body';

      // Header row with Icon + Title + ID
      const headerRow = document.createElement('div');
      headerRow.className = 'ws-card-header';

      const iconBox = document.createElement('div');
      iconBox.className = 'ws-card-icon';
      const iconUrl = activeEntry.presentation?.icon?.url;
      if (iconUrl) {
        const iconImg = document.createElement('img');
        iconImg.src = iconUrl;
        setCanvasAttribute(iconImg, 'alt', () => (activeEntry.title));
        iconImg.onerror = () => {
          iconImg.remove();
          setCanvasHtml(iconBox, () => (`<span style="font-size:20px;">${isGroup ? '🧩' : '📦'}</span>`));
        };
        iconBox.append(iconImg);
      } else {
        setCanvasHtml(iconBox, () => (`<span style="font-size:20px;">${isGroup ? '🧩' : '📦'}</span>`));
      }
      headerRow.append(iconBox);

      const titleBox = document.createElement('div');
      titleBox.className = 'ws-card-title-box';
      const titleEl = document.createElement('h4');
      titleEl.className = 'ws-card-title';
      setCanvasText(titleEl, () => (activeEntry.title || activeEntry.id));
      setCanvasAttribute(titleEl, 'title', () => (titleEl.textContent));

      const idEl = document.createElement('div');
      idEl.className = 'ws-card-id';
      setCanvasText(idEl, () => (activeEntry.id));
      titleBox.append(titleEl, idEl);
      headerRow.append(titleBox);
      body.append(headerRow);

      // Description
      const descEl = document.createElement('p');
      descEl.className = 'ws-card-desc';
      setCanvasText(descEl, () => (this.getEntryDescription(activeEntry)));
      setCanvasAttribute(descEl, 'title', () => (descEl.textContent));
      body.append(descEl);

      const versionCount = document.createElement('p'); versionCount.className = 'action-help-text';
      setCanvasText(versionCount, () => (this.requiredWorkshopProvider ? t('当前接线指定 v{version}，仅显示匹配版本', { version: activeEntry.version })
        : versions.length === 1 ? t('当前仅公开了这一个版本') : t('共 {count} 个已发布版本，可选择所需版本下载', { count: versions.length })));
      body.append(versionCount);

      // Metadata tags (Author, License, Platform)
      const metaRow = document.createElement('div');
      metaRow.className = 'ws-tag-row';
      for (const text of [() => `👤 @${activeEntry.owner?.username || t('官方团队')}`, () => `⚖️ ${activeEntry.license || 'MIT'}`, () => `💻 ${(activeEntry.platforms || []).join('/') || t('跨平台')}`]) {
        const tag = document.createElement('span'); tag.className = 'ws-tag ws-tag-meta'; setCanvasText(tag, text); metaRow.append(tag);
      }
      body.append(metaRow);

      const integrity = document.createElement('details'); integrity.className = 'action-help-text';
      const integrityTitle = document.createElement('summary'); setCanvasText(integrityTitle, () => (t('所选版本制品校验摘要')));
      const integrityHash = document.createElement('code'); integrityHash.style.cssText = 'font-size:10px;word-break:break-all;'; setCanvasText(integrityHash, () => (`SHA-256: ${activeEntry.sha256 || t('未提供')}`));
      integrity.onclick = event => event.stopPropagation(); integrity.append(integrityTitle, integrityHash); body.append(integrity);

      // Capability contracts tags
      const provides = activeEntry.provides || [];
      const requires = activeEntry.requires || [];
      if (provides.length || requires.length) {
        const contractRow = document.createElement('div');
        contractRow.className = 'ws-tag-row';
        for (const p of provides.slice(0, 2)) {
          const pill = document.createElement('span');
          pill.className = 'ws-tag ws-tag-provides';
          setCanvasText(pill, () => (`🟢 ${p.id}`));
          setCanvasAttribute(pill, 'title', () => (t('产出契约: {id}@{version}', { id: p.id, version: p.version || '' })));
          contractRow.append(pill);
        }
        for (const r of requires.slice(0, 2)) {
          const pill = document.createElement('span');
          pill.className = 'ws-tag ws-tag-requires';
          setCanvasText(pill, () => (`🔵 ${r.id}`));
          setCanvasAttribute(pill, 'title', () => (t('接入契约: {id}@{version}', { id: r.id, version: r.version || '' })));
          contractRow.append(pill);
        }
        if (provides.length + requires.length > 4) {
          const more = document.createElement('span');
          more.className = 'ws-tag ws-tag-meta';
          setCanvasText(more, () => (`+${provides.length + requires.length - 4}`));
          contractRow.append(more);
        }
        body.append(contractRow);
      }

      // Screenshot thumbnails row
      const screenshots = activeEntry.presentation?.screenshots || [];
      if (screenshots.length) {
        const screensRow = document.createElement('div');
        screensRow.className = 'ws-screenshots-row';
        for (const s of screenshots) {
          const thumb = document.createElement('img');
          thumb.className = 'ws-screenshot-thumb';
          thumb.src = s.url;
          setCanvasAttribute(thumb, 'alt', () => (s.alt || activeEntry.title));
          setCanvasAttribute(thumb, 'title', () => (t('点击放大查看效果预览')));
          thumb.onclick = (e) => {
            e.stopPropagation();
            this.openWorkshopLightbox(s.url, thumb.alt);
          };
          screensRow.append(thumb);
        }
        body.append(screensRow);
      }

      card.append(body);

      // 3. Footer
      const footer = document.createElement('div');
      footer.className = 'ws-card-footer';

      // Version selector dropdown
      const verSelect = document.createElement('select');
      verSelect.className = 'ws-version-select';
      setCanvasAttribute(verSelect, 'aria-label', () => (t('{id} 版本选择', { id: activeEntry.id })));
      for (const cand of versions) {
        verSelect.add(canvasOption(() => (`v${cand.version}`), cand.entryId));
      }
      verSelect.value = activeEntry.entryId;
      verSelect.onclick = (e) => e.stopPropagation();
      verSelect.onchange = (e) => {
        e.stopPropagation();
        const found = versions.find(cand => cand.entryId === verSelect.value);
        if (found) {
          activeEntry = found;
          this.workshopVersionSelections.set(family, found.entryId);
          // The whole visible card belongs to the selected immutable release,
          // including artwork, contracts and digest, not only its download URL.
          this.renderWorkshopCards(family);
        }
      };
      footer.append(verSelect);

      const fetchBtn = document.createElement('button');
      fetchBtn.type = 'button';
      fetchBtn.className = 'ws-btn-fetch';
      if (isCached && isInstalled) {
        fetchBtn.className += ' ws-btn-installed';
        setCanvasText(fetchBtn, () => (t('✅ 已导入')));
        setCanvasAttribute(fetchBtn, 'title', () => (t('已在 Hub 中导入运行，点击查看详情或重新审阅')));
      } else if (isCached) {
        fetchBtn.className += ' ws-btn-import';
        setCanvasText(fetchBtn, () => (t('📦 审阅导入')));
        setCanvasAttribute(fetchBtn, 'title', () => (t('制品已在本地缓存，点击直接审阅导入')));
      } else {
        setCanvasText(fetchBtn, () => (t('⬇ 下载')));
      }
      fetchBtn.onclick = async (e) => {
        e.stopPropagation();
        if (this.versionWorkshopTarget) {
          fetchBtn.disabled = true;
          setCanvasText(fetchBtn, () => (t('⏳ 下载中...')));
          try {
            const allowPrivateNetwork = $('inp-workshop-private-network')?.checked === true;
            const digest = this.workshopData?.digest;
            await this.fetchWorkshopModule(this.workshopData?.source, activeEntry.entryId, digest, allowPrivateNetwork);
          } finally {
            fetchBtn.disabled = false;
            setCanvasText(fetchBtn, () => (isCached ? (isInstalled ? t('✅ 已导入') : t('📦 审阅导入')) : t('⬇ 下载')));
          }
          return;
        }

        if (isCached && cachedItem?.directory) {
          this.closeOnlineWorkshopModal();
          await this.openImportModal();
          if ($('inp-import-path')) {
            $('inp-import-path').value = cachedItem.directory;
            await this.inspectImportModule();
          }
          return;
        }

        fetchBtn.disabled = true;
        setCanvasText(fetchBtn, () => (t('⏳ 下载中...')));
        try {
          const allowPrivateNetwork = $('inp-workshop-private-network')?.checked === true;
          const digest = this.workshopData?.digest;
          await this.fetchWorkshopModule(this.workshopData?.source, activeEntry.entryId, digest, allowPrivateNetwork);
        } finally {
          fetchBtn.disabled = false;
          setCanvasText(fetchBtn, () => (isCached ? (isInstalled ? t('✅ 已导入') : t('📦 审阅导入')) : t('⬇ 下载')));
        }
      };
      footer.append(fetchBtn);

      card.append(footer);

      box.append(card);
      if (family === focusFamily) verSelect.focus?.();
    }

    if (this.versionWorkshopTarget && !this.versionWorkshopTarget.autoOpened && matchedFamilies.length > 0 && $('ws-detail-body')) {
      const targetFamily = (this.versionWorkshopTarget.identity
        ? matchedFamilies.find(f => f[0]?.id === this.versionWorkshopTarget.identity)
        : null) || (matchedFamilies.length === 1 ? matchedFamilies[0] : null);

      if (targetFamily && targetFamily.length > 0) {
        this.versionWorkshopTarget.autoOpened = true;
        const familyKey = `${targetFamily[0].kind}:${targetFamily[0].id}`;
        const activeEntry = targetFamily.find(entry => entry.entryId === this.workshopVersionSelections.get(familyKey)) || targetFamily[0];
        this.openWorkshopDetailModal(activeEntry, targetFamily);
      }
    }
  }

  resetWorkshopFilters() {
    this.requiredWorkshopProvider = null;
    const inp = $('inp-ws-search');
    if (inp) inp.value = '';
    const selType = $('sel-ws-type');
    if (selType) selType.value = 'all';
    const selContract = $('sel-ws-contract');
    if (selContract) selContract.value = 'all';
    const selSort = $('sel-ws-sort');
    if (selSort) selSort.value = 'default';
    this.renderWorkshopCards();
  }

  getEntryOfficialUrl(entry) {
    if (!entry) return 'https://peros.cn/workshop';
    if (entry.presentation?.homepage && typeof entry.presentation.homepage === 'string' && /^https?:\/\//i.test(entry.presentation.homepage)) {
      return entry.presentation.homepage;
    }
    if (entry.homepage && typeof entry.homepage === 'string' && /^https?:\/\//i.test(entry.homepage)) {
      return entry.homepage;
    }
    const source = this.workshopData?.source || $('inp-workshop-source-url')?.value?.trim() || 'https://peros.cn/workshop/index.json';
    try {
      const u = new URL(source, window.location?.href || 'https://peros.cn/workshop/index.json');
      if (u.pathname.endsWith('/index.json')) {
        u.pathname = u.pathname.slice(0, -('/index.json'.length));
        if (!u.pathname.endsWith('/')) u.pathname += '/';
      } else if (!u.pathname.endsWith('/')) {
        u.pathname += '/';
      }
      u.search = '';
      const entryRef = entry.entryId || entry.id || '';
      u.hash = entryRef ? `#publication/${encodeURIComponent(entryRef)}` : '';
      return u.toString();
    } catch {
      const entryRef = entry.entryId || entry.id || '';
      return entryRef ? `https://peros.cn/workshop/#publication/${encodeURIComponent(entryRef)}` : 'https://peros.cn/workshop';
    }
  }

  openWorkshopDetailModal(entry, versions = []) {
    const modal = $('modal-workshop-detail');
    const body = $('ws-detail-body');
    const headerTitle = $('ws-detail-header-title');
    const dlBtn = $('btn-detail-download');
    if (!modal || !body) return;

    const family = `${entry.kind}:${entry.id}`;
    const isCached = Boolean(this.cachedSha256s?.has(entry.sha256));
    const cachedItem = isCached ? this.cachedArtifacts?.find(a => a.sha256 === entry.sha256) : null;
    const isInstalled = cachedItem?.installed;

    if (headerTitle) setCanvasText(headerTitle, () => (t('{kind}规格详情：{title}', { kind: entry.kind === 'module-group' ? t('🧩 模块组') : t('📦 模块'), title: entry.title || entry.id })));

    const coverUrl = entry.presentation?.cover?.url;
    const iconUrl = entry.presentation?.icon?.url;
    const screenshots = entry.presentation?.screenshots || [];
    const isGroup = entry.kind === 'module-group';

    setCanvasHtml(body, () => (`
      <div style="display:flex; flex-direction:column; gap:16px;">
        <!-- 版本切换与本地状态栏 -->
        <div style="background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:12px; color:var(--muted); font-weight:600;">${canvasLabel(() => (t('切换版本 (Select Version):')))}</span>
            <select id="ws-detail-version-select" class="ws-version-select" style="height:28px; font-size:11px; max-width:160px;">
              ${versions.map(v => `<option value="${v.entryId}" ${v.entryId === entry.entryId ? 'selected' : ''} ${canvasTextAttribute(() => `v${v.version} ${v.entryId === entry.entryId ? t('(当前选择)') : ''}`)}></option>`).join('')}
            </select>
            ${versions.length > 1 ? `
              <div style="display:flex; gap:4px; margin-left:6px; flex-wrap:wrap;">
                ${versions.map(v => `<button type="button" class="ws-version-pill ${v.entryId === entry.entryId ? 'active' : ''}" data-entry-id="${htmlText(v.entryId)}">v${htmlText(v.version)}</button>`).join('')}
              </div>
            ` : ''}
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            ${isInstalled ? `<span class="ws-cache-status installed" style="font-size:11px;">${canvasLabel(() => (t('🟢 已导入本机 Hub')))}</span>`
              : isCached ? `<span class="ws-cache-status pending" style="font-size:11px;">${canvasLabel(() => (t('💾 已在本地缓存')))}</span>`
              : `<span style="font-size:11px; color:var(--muted);">${canvasLabel(() => (t('☁️ 远端未下载')))}</span>`}
          </div>
        </div>

        ${coverUrl ? `
          <div style="position:relative; width:100%; height:220px; border-radius:10px; overflow:hidden; border:1px solid rgba(255,255,255,0.1); background:#050a12; cursor:zoom-in;">
            <img id="ws-detail-cover-img" src="${htmlText(coverUrl)}" alt="${htmlText(entry.title)}" style="width:100%; height:100%; object-fit:cover;">
            <div style="position:absolute; bottom:10px; right:10px; font-size:10px; color:#fff; background:rgba(0,0,0,0.6); padding:2px 8px; border-radius:4px; backdrop-filter:blur(4px);">${canvasLabel(() => (t('🔍 点击查看原始大图')))}</div>
          </div>
        ` : ''}

        <div style="display:flex; gap:14px; align-items:center;">
          ${iconUrl ? `
            <img src="${htmlText(iconUrl)}" ${canvasAttribute('alt', () => (t('图标')))} style="width:52px; height:52px; border-radius:10px; border:1px solid rgba(0,210,180,0.3); background:#1e293b; object-fit:cover;">
          ` : `
            <div style="width:52px; height:52px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:#1e293b; display:flex; align-items:center; justify-content:center; font-size:24px;">
              ${isGroup ? '🧩' : '📦'}
            </div>
          `}
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; gap:8px;">
              <h3 style="margin:0; font-size:16px; color:#fff;">${htmlText(entry.title || entry.id)}</h3>
              <span class="acl-pill" style="font-size:11px;">v${htmlText(entry.version)}</span>
              <span class="acl-pill" style="font-size:11px; background:${isGroup ? 'rgba(129,140,248,0.2)' : 'rgba(0,210,180,0.15)'}; color:${isGroup ? '#818cf8' : 'var(--teal)'};">${canvasLabel(() => (isGroup ? t('🧩 模块组编排') : t('📦 独立模块')))}</span>
            </div>
            <div style="font-family:var(--mono); font-size:11px; color:var(--teal); margin-top:3px;">${htmlText(entry.id)}</div>
          </div>
        </div>

        <div style="font-size:12px; line-height:1.6; color:#cbd5e1; background:rgba(255,255,255,0.03); padding:12px 14px; border-radius:8px; border:1px solid rgba(255,255,255,0.06);">
          ${canvasLabel(() => this.getEntryDescription(entry))}
        </div>

        <!-- 规格元数据网格 -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px; font-size:11px;">
          <div style="background:rgba(0,0,0,0.2); padding:8px 12px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
            <div style="color:var(--muted); margin-bottom:2px;">${canvasLabel(() => (t('发布者 / 作者')))}</div>
            <div style="color:#fff; font-weight:600;">👤 @${canvasLabel(() => entry.owner?.username || t('官方团队'))}</div>
          </div>
          <div style="background:rgba(0,0,0,0.2); padding:8px 12px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
            <div style="color:var(--muted); margin-bottom:2px;">${canvasLabel(() => (t('开源许可证')))}</div>
            <div style="color:#fff; font-weight:600;">⚖️ ${htmlText(entry.license || 'MIT')}</div>
          </div>
          <div style="background:rgba(0,0,0,0.2); padding:8px 12px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
            <div style="color:var(--muted); margin-bottom:2px;">${canvasLabel(() => (t('支持平台')))}</div>
            <div style="color:#fff; font-weight:600;">💻 ${canvasLabel(() => (entry.platforms || []).join(', ') || t('跨平台'))}</div>
          </div>
          <div style="background:rgba(0,0,0,0.2); padding:8px 12px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
            <div style="color:var(--muted); margin-bottom:2px;">${canvasLabel(() => (t('可用版本历史')))}</div>
            <div style="color:#fff; font-weight:600;">🔢 ${canvasLabel(() => (t('共 {count} 个版本 ({versions})', { count: versions.length, versions: versions.map(v => 'v' + v.version).join(', ') })))}</div>
          </div>
        </div>

        <!-- SHA-256 制品校验摘要 -->
        <div style="background:rgba(0,0,0,0.2); padding:10px 12px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <span style="font-size:11px; color:var(--muted);">${canvasLabel(() => (t('SHA-256 制品安全校验摘要')))}</span>
            <button type="button" class="hub-btn" id="btn-copy-sha" style="font-size:9px; padding:2px 8px;">${canvasLabel(() => (t('复制 SHA')))}</button>
          </div>
          <div style="font-family:var(--mono); font-size:11px; color:var(--teal); word-break:break-all;">${htmlText(entry.sha256)}</div>
        </div>

        <!-- 契约能力清单 -->
        <div style="display:flex; flex-direction:column; gap:8px;">
          <h4 style="margin:0; font-size:12px; color:#fff;">${canvasLabel(() => (t('🔌 能力契约与端口接入')))}</h4>
          <div style="display:flex; flex-direction:column; gap:6px;">
            <div style="font-size:11px; display:flex; gap:8px; align-items:center;">
              <span style="color:var(--muted); width:70px;">${canvasLabel(() => (t('产出契约:')))}</span>
              <div style="display:flex; flex-wrap:wrap; gap:4px;">
                ${(entry.provides || []).length ? (entry.provides || []).map(p => `<span class="ws-tag ws-tag-provides">🟢 ${htmlText(p.id)}@${htmlText(p.version)}</span>`).join('') : `<span style="color:var(--muted);">${canvasLabel(() => (t('无独立声明产出契约')))}</span>`}
              </div>
            </div>
            <div style="font-size:11px; display:flex; gap:8px; align-items:center;">
              <span style="color:var(--muted); width:70px;">${canvasLabel(() => (t('接入契约:')))}</span>
              <div style="display:flex; flex-wrap:wrap; gap:4px;">
                ${(entry.requires || []).length ? (entry.requires || []).map(r => `<span class="ws-tag ws-tag-requires">🔵 ${htmlText(r.id)}@${htmlText(r.version)}</span>`).join('') : `<span style="color:var(--muted);">${canvasLabel(() => (t('无需外部契约依赖')))}</span>`}
              </div>
            </div>
          </div>
        </div>

        ${isGroup ? `
          <div style="background:rgba(129,140,248,0.06); border:1px solid rgba(129,140,248,0.2); border-radius:8px; padding:12px 14px;">
            <h4 style="margin:0 0 6px 0; font-size:12px; color:#818cf8;">${canvasLabel(() => (t('🧩 模块组成员编排与拓扑说明')))}</h4>
            <div style="font-size:11px; color:#cbd5e1; line-height:1.5;">
              ${canvasLabel(() => (t('此模块组打包了多个独立协同模块制品（包含文本数据源、统计分析服务、桌面 Web 视图三者协同）。下载后导入 Hub 时，系统将统一步骤引导登记为相互独立的实例并建立拓扑通道，避免各模块手工逐一配置。')))}
            </div>
          </div>
        ` : ''}

        ${screenshots.length ? `
          <div style="display:flex; flex-direction:column; gap:8px;">
            <h4 style="margin:0; font-size:12px; color:#fff;">${canvasLabel(() => (t('📸 界面与运行效果预览截图 (点击查看原图)')))}</h4>
            <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:8px;">
              ${screenshots.map(s => `
                <div class="ws-detail-thumb-box" style="height:110px; border-radius:6px; overflow:hidden; border:1px solid rgba(255,255,255,0.1); background:#050a12; cursor:zoom-in;">
                  <img src="${htmlText(s.url)}" alt="${htmlText(s.alt || '')}" style="width:100%; height:100%; object-fit:cover; transition:transform 0.2s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `));

    // 绑定版本切换事件
    const handleVersionSwitch = (targetEntryId) => {
      const found = versions.find(cand => cand.entryId === targetEntryId);
      if (found) {
        this.workshopVersionSelections.set(family, found.entryId);
        this.renderWorkshopCards(family);
        this.openWorkshopDetailModal(found, versions);
      }
    };
    const detailVerSelect = $('ws-detail-version-select');
    if (detailVerSelect) {
      detailVerSelect.onchange = (e) => {
        e.stopPropagation();
        handleVersionSwitch(detailVerSelect.value);
      };
    }
    body.querySelectorAll('.ws-version-pill').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const eid = btn.getAttribute('data-entry-id');
        if (eid) handleVersionSwitch(eid);
      };
    });

    // Wire clicks
    if (coverUrl) {
      $('ws-detail-cover-img')?.addEventListener('click', () => {
        this.openWorkshopLightbox(coverUrl, entry.title);
      });
    }
    const thumbBoxes = body.querySelectorAll('.ws-detail-thumb-box');
    screenshots.forEach((s, i) => {
      if (thumbBoxes[i]) {
        thumbBoxes[i].addEventListener('click', () => {
          this.openWorkshopLightbox(s.url, s.alt || entry.title);
        });
      }
    });

    $('btn-copy-sha')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(entry.sha256);
      canvasToast(() => (t('✓ SHA-256 摘要已复制到剪贴板')), 'neutral');
    });

    const webBtn = $('btn-detail-open-web');
    if (webBtn) {
      webBtn.href = this.getEntryOfficialUrl(entry);
    }

    if (dlBtn) {
      if (isCached && isInstalled) {
        setCanvasText(dlBtn, () => (t('✅ 重新审阅导入 (已在 Hub)')));
        dlBtn.className = 'hub-btn';
        dlBtn.onclick = async () => {
          this.closeWorkshopDetailModal();
          this.closeOnlineWorkshopModal();
          await this.openImportModal();
          if ($('inp-import-path') && cachedItem?.directory) {
            $('inp-import-path').value = cachedItem.directory;
            await this.inspectImportModule();
          }
        };
      } else if (isCached) {
        setCanvasText(dlBtn, () => (t('📥 立即审阅导入 (已下载)')));
        dlBtn.className = 'hub-btn primary';
        dlBtn.onclick = async () => {
          this.closeWorkshopDetailModal();
          this.closeOnlineWorkshopModal();
          await this.openImportModal();
          if ($('inp-import-path') && cachedItem?.directory) {
            $('inp-import-path').value = cachedItem.directory;
            await this.inspectImportModule();
          }
        };
      } else {
        setCanvasText(dlBtn, () => (t('⬇ 下载并审阅导入')));
        dlBtn.className = 'hub-btn primary';
        dlBtn.onclick = async () => {
          dlBtn.disabled = true;
          setCanvasText(dlBtn, () => (t('⏳ 下载中...')));
          try {
            const allowPrivateNetwork = $('inp-workshop-private-network')?.checked === true;
            const digest = this.workshopData?.digest;
            await this.fetchWorkshopModule(this.workshopData?.source, entry.entryId, digest, allowPrivateNetwork);
            this.closeWorkshopDetailModal();
          } finally {
            dlBtn.disabled = false;
            setCanvasText(dlBtn, () => (t('⬇ 下载并审阅导入')));
          }
        };
      }
    }

    modal.classList.remove('hidden');
  }

  async fetchWorkshopModule(source, entryId, digest, allowPrivateNetwork = false) {
    // A version download returns to its exact existing instance. A closed or
    // replaced selection may still populate the cache, but cannot open an import.
    const target = this.versionWorkshopTarget;
    if (target) {
      const entry = this.workshopEntries?.find(item => item.entryId === entryId);
      if (this.versionSession !== target.session || target.downloading) return;
      if (!entry || entry.kind !== target.kind || target.identity && entry.id !== target.identity) {
        canvasToast(() => (t('请选择当前模块或模块组的同一来源身份，不能用其它作品替换此实例。')), 'error'); return;
      }
      target.downloading = true;
    }
    try {
      canvasToast(() => (t('正在下载工坊模块 [{entryId}]...', { entryId })), 'neutral');
      const res = await fetch('/manage/api/workshop/fetch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({ source, entryId, digest, allowPrivateNetwork })
      });
      if (!res.ok) {
        const err = await res.json();
        canvasToast(() => (t('下载失败: {error}', { error: errorText(err) })), 'error');
        return;
      }
      const data = await res.json();
      canvasToast(() => (t('✓ 模块已成功下载并缓存至本地: {dir}', { dir: data.directory })), 'neutral');
      await this.fetchModulesData();
      await this.loadWorkshopCache();
      if (target) {
        if (this.versionWorkshopTarget !== target || this.versionSession !== target.session) return;
        this.closeWorkshopModal();
        if (data.directory) {
          $('version-source-path').value = data.directory; this.invalidateVersionReview();
          await this.previewVersionUpdate();
        }
        return;
      }
      this.closeWorkshopModal();
      await this.openImportModal();
      if ($('inp-import-path') && data.directory) {
        $('inp-import-path').value = data.directory;
        await this.inspectImportModule();
      }
    } catch (e) {
      canvasToast(() => (t('下载异常: {error}', { error: e.message })), 'error');
    } finally {
      if (target) target.downloading = false;
    }
  }

  switchWorkshopView(view = 'online') {
    const tabs = ['online', 'updates', 'downloaded', 'settings'];
    for (const t of tabs) {
      $(`tab-ws-nav-${t}`)?.classList.toggle('active', t === view);
      $(`ws-view-${t}`)?.classList.toggle('hidden', t !== view);
    }
    const hint = $('ws-footer-hint');
    if (hint) {
      if (view === 'online') {
        setCanvasText(hint, () => (t('提示：下载制品后将自动存入本地缓存，并在导入向导中审阅权限及端口绑定后再启用。')));
      } else if (view === 'updates') {
        setCanvasText(hint, () => (t('提示：检测当前拓扑中各模块/模块组是否有新发行版本发布；支持单项审阅升级或一键统一批量审阅更新。')));
      } else if (view === 'downloaded') {
        setCanvasText(hint, () => (t('提示：本地缓存中的制品可随时审阅导入或清除；清除缓存不会影响已在 Hub 运行的受管模块。')));
      } else if (view === 'settings') {
        setCanvasText(hint, () => (t('提示：设置版本切换的默认配置策略和数据策略，以及工坊访问与缓存存储路径。')));
      }
    }

    if (view === 'updates') {
      this.renderWorkshopUpdatesList();
    } else if (view === 'downloaded') {
      this.loadWorkshopCache();
    } else if (view === 'settings') {
      this.initWorkshopSettings();
    }
  }

  async loadWorkshopCache() {
    try {
      const res = await fetch('/manage/api/workshop/cache');
      if (!res.ok) return;
      const data = await res.json();
      this.cachedArtifacts = data.artifacts || [];
      this.cachedSha256s = new Set(this.cachedArtifacts.map(a => a.sha256).filter(Boolean));
      this.cacheDirectory = data.cacheDirectory || '';

      const badge = $('badge-ws-cache-count');
      if (badge) setCanvasText(badge, () => (this.cachedArtifacts.length));
      this.updateAllVersionBadges();

      this.renderWorkshopCacheList();
      if (this.workshopEntries?.length && !$('ws-view-online')?.classList.contains('hidden')) {
        this.renderWorkshopCards();
      }
    } catch {}
  }

  renderWorkshopCacheList() {
    const box = $('workshop-cached-entries-box');
    if (!box) return;

    const list = this.cachedArtifacts || [];
    const totalCount = list.length;
    const pendingCount = list.filter(a => !a.installed).length;
    const installedCount = list.filter(a => a.installed).length;

    const statTotal = $('ws-cache-stat-total');
    if (statTotal) setCanvasText(statTotal, () => (totalCount));
    const statPending = $('ws-cache-stat-pending');
    if (statPending) setCanvasText(statPending, () => (pendingCount));
    const statInstalled = $('ws-cache-stat-installed');
    if (statInstalled) setCanvasText(statInstalled, () => (installedCount));
    const dirLabel = $('ws-cache-dir-label');
    if (dirLabel && this.cacheDirectory) setCanvasText(dirLabel, () => (t('目录: {dir}', { dir: this.cacheDirectory })));

    const searchQuery = $('inp-ws-cache-search')?.value?.trim().toLowerCase() || '';
    const statusFilter = $('sel-ws-cache-status')?.value || 'all';
    const typeFilter = $('sel-ws-cache-type')?.value || 'all';

    const clearBtn = $('btn-ws-cache-search-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !searchQuery);

    const filtered = list.filter(item => {
      if (statusFilter === 'pending' && item.installed) return false;
      if (statusFilter === 'installed' && !item.installed) return false;
      if (typeFilter !== 'all' && item.kind !== typeFilter) return false;
      if (searchQuery) {
        const matchTitle = (item.title || '').toLowerCase().includes(searchQuery);
        const matchId = (item.id || '').toLowerCase().includes(searchQuery);
        const matchSha = (item.sha256 || '').toLowerCase().includes(searchQuery);
        const matchVersion = (item.version || '').toLowerCase().includes(searchQuery);
        if (!matchTitle && !matchId && !matchSha && !matchVersion) return false;
      }
      return true;
    });

    box.replaceChildren();

    if (!filtered.length) {
      const emptyDiv = document.createElement('div');
      emptyDiv.style.cssText = 'grid-column:1/-1; text-align:center; padding:40px 20px; color:var(--muted);';
      setCanvasHtml(emptyDiv, () => (`
        <div style="font-size:32px; margin-bottom:10px;">💾</div>
        <div style="font-size:14px; font-weight:600; color:#cbd5e1; margin-bottom:6px;">${canvasLabel(() => (searchQuery || statusFilter !== 'all' ? t('未找到符合条件的缓存制品') : t('本地暂无已下载制品')))}</div>
        <div style="font-size:11px; margin-bottom:14px;">${canvasLabel(() => (searchQuery || statusFilter !== 'all' ? t('请尝试更换搜索词或重置筛选条件') : t('前往【在线工坊目录】浏览并下载所需的模块或模块组制品')))}</div>
        <button type="button" class="hub-btn primary" id="btn-ws-goto-online">${canvasLabel(() => (t('🌐 前往在线工坊下载')))}</button>
      `));
      box.append(emptyDiv);
      box.querySelector('#btn-ws-goto-online')?.addEventListener('click', () => this.switchWorkshopView('online'));
      return;
    }

    for (const a of filtered) {
      const isGroup = a.kind === 'module-group';
      const card = document.createElement('div');
      card.className = `ws-cache-card ${a.installed ? 'installed' : 'pending'}`;

      const formatSize = (bytes) => {
        if (!bytes || bytes < 1024) return `${bytes || 0} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      };

      const dateStr = () => a.cachedAt ? new Date(a.cachedAt).toLocaleString(window.hubCanvas?.language || 'zh-CN', { hour12: false }) : t('刚刚');

      setCanvasHtml(card, () => (`
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
          <div style="display:flex; align-items:center; gap:8px; min-width:0;">
            <div style="width:36px; height:36px; border-radius:8px; background:#1e293b; border:1px solid rgba(255,255,255,0.1); display:flex; align-items:center; justify-content:center; font-size:18px; flex-shrink:0;">
              ${isGroup ? '🧩' : '📦'}
            </div>
            <div style="min-width:0;">
              <h4 style="margin:0; font-size:13px; font-weight:700; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                ${htmlText(a.title || a.id)}
              </h4>
              <div style="font-size:10px; font-family:var(--mono); color:var(--teal); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                ${htmlText(a.id)} @ v${htmlText(a.version)}
              </div>
            </div>
          </div>
          <div style="flex-shrink:0;">
            ${a.installed
              ? `<span class="ws-cache-status installed">${canvasLabel(() => (t('🟢 已导入 Hub')))}</span>`
              : `<span class="ws-cache-status pending">${canvasLabel(() => (t('🟡 就绪待导入')))}</span>`
            }
          </div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:10px; color:var(--muted); background:rgba(0,0,0,0.25); padding:8px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.04);">
          <div>${canvasLabel(() => (t('📁 文件数量:')))} <strong style="color:#cbd5e1;">${a.filesCount || 0} ${canvasLabel(() => (t('个')))}</strong></div>
          <div>${canvasLabel(() => (t('💾 制品体积:')))} <strong style="color:#cbd5e1;">${formatSize(a.jsonBytes)}</strong></div>
          <div>${canvasLabel(() => (t('🕒 缓存时间:')))} <strong style="color:#cbd5e1;">${canvasLabel(dateStr)}</strong></div>
          <div>${canvasLabel(() => (t('🏷 制品类别:')))} <strong style="color:${isGroup ? '#818cf8' : 'var(--teal)'};">${canvasLabel(() => (isGroup ? t('🧩 模块组编排') : t('📦 独立受管模块')))}</strong></div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; font-size:10px; background:rgba(0,0,0,0.15); padding:4px 8px; border-radius:4px;">
          <span style="font-family:var(--mono); color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:210px;" title="SHA-256: ${htmlText(a.sha256)}">
            SHA: ${canvasLabel(() => a.sha256 ? a.sha256.slice(0, 16) + '...' : t('未提供'))}
          </span>
          <button type="button" class="hub-btn btn-copy-cache-sha" style="font-size:9px; padding:1px 6px;">${canvasLabel(() => (t('复制 SHA')))}</button>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:2px;">
          <button type="button" class="hub-btn danger btn-delete-cache" style="font-size:11px; padding:4px 8px;" ${canvasAttribute('title', () => (t('从本地缓存清除此制品')))}>${canvasLabel(() => (t('🗑 清除缓存')))}</button>
          <div style="display:flex; gap:6px;">
            ${a.installed ? `
              <button type="button" class="hub-btn btn-import-cache" style="font-size:11px; padding:4px 10px;" ${canvasAttribute('title', () => (t('重新启动导入向导审阅')))}>${canvasLabel(() => (t('🔄 重新审阅导入')))}</button>
            ` : `
              <button type="button" class="hub-btn primary btn-import-cache" style="font-size:11px; padding:4px 12px; font-weight:700;" ${canvasAttribute('title', () => (t('立即打开导入向导审阅授权与端口')))}>${canvasLabel(() => (t('📥 立即审阅导入')))}</button>
            `}
          </div>
        </div>
      `));

      card.querySelector('.btn-copy-cache-sha')?.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(a.sha256);
        canvasToast(() => (t('✓ SHA-256 已复制到剪贴板')), 'neutral');
      });

      card.querySelector('.btn-delete-cache')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.deleteCachedArtifact(a.sha256, `${a.title || a.id} @ v${a.version}`);
      });

      card.querySelector('.btn-import-cache')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        this.closeOnlineWorkshopModal();
        await this.openImportModal();
        if ($('inp-import-path') && a.directory) {
          $('inp-import-path').value = a.directory;
          await this.inspectImportModule();
        }
      });

      box.append(card);
    }
  }

  async deleteCachedArtifact(sha256, title) {
    if (!sha256) return;
    const ok = window.confirm(t('确定要从本地缓存清除制品【{title}】吗？\n\n此操作仅删除磁盘上的下载缓存文件，不会卸载已在 Hub 中运行的模块。', { title }));
    if (!ok) return;

    try {
      canvasToast(() => (t('正在清理缓存制品 [{sha256}...]...', { sha256: sha256.slice(0, 10) })), 'neutral');
      const res = await fetch('/manage/api/workshop/cache/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Token': window.hubCanvas?.state?.data?.csrfToken || ''
        },
        body: JSON.stringify({ sha256 })
      });
      if (!res.ok) {
        const err = await res.json();
        canvasToast(() => (t('清除失败: {error}', { error: err.message || err.error })), 'error');
        return;
      }
      canvasToast(() => (t('✓ 缓存制品已成功删除')), 'neutral');
      await this.loadWorkshopCache();
    } catch (e) {
      canvasToast(() => (t('清理异常: {error}', { error: e.message })), 'error');
    }
  }
}

// 自动初始化并挂载
const canvasModes = new CanvasModesController();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => canvasModes.init());
} else {
  canvasModes.init();
}
window.canvasModes = canvasModes;
