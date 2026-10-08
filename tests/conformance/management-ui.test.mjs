// Source-function tests using a small DOM model. NOT real browser or HTTP tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../src/management/console.html', import.meta.url), 'utf8');
function sourceFunction(name, endMarker) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(html);
  assert.ok(match, 'source function missing: ' + name);
  const rest = html.slice(match.index);
  const next = endMarker ? rest.indexOf(endMarker) : /\n    (?:async )?function \w+\(/.exec(rest)?.index;
  assert.ok(next > 0, 'function end missing: ' + name);
  return rest.slice(0, next);
}
class NodeModel {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.parentElement = null; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map(); this.value = ''; this.inert = false; this._text = ''; this.classes = new Set();
    this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)), remove: (...names) => names.forEach(name => this.classes.delete(name)), contains: name => this.classes.has(name), toggle: (name, force) => { const on = force ?? !this.classes.has(name); if (on) this.classes.add(name); else this.classes.delete(name); return on; } };
  }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { for (const node of [...this.children]) node.remove(); this._text = String(value); }
  get childNodes() { return this.children; }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling() { if (!this.parentElement) return null; return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
  get isConnected() { return this === this.doc.body || this.doc.body.contains(this); }
  get offsetWidth() { return 1; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = value; if (name === 'id') this.id = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, next) {
    if (node.parentElement) node.remove();
    const index = next ? this.children.indexOf(next) : this.children.length; assert.ok(index >= 0);
    this.children.splice(index, 0, node); node.parentElement = this;
  }
  remove() { if (this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body; if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this._text = ''; this.append(...nodes); }
  closest(selector) { if (selector.toUpperCase() === this.tagName) return this; return this.parentElement?.closest(selector) ?? null; }
  querySelector(selector) { for (const child of this.children) { if (selector[0] === '.' && child.classes.has(selector.slice(1))) return child; const found = child.querySelector(selector); if (found) return found; } return null; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  focus() { let node = this; while (node) { if (node.inert || node.classes.has('hidden')) return; node = node.parentElement; } if (this.isConnected) this.doc.activeElement = this; }
}

function harness() {
  const doc = { hidden: false, body: null, activeElement: null };
  doc.body = new NodeModel('body', doc); doc.activeElement = doc.body;
  doc.createElement = tag => new NodeModel(tag, doc); doc.createElementNS = (_ns, tag) => new NodeModel(tag, doc);
  const dom = new Map();
  function add(id, tag = 'div', parent = doc.body) { const node = doc.createElement(tag); node.id = id; dom.set(id, node); parent.append(node); return node; }
  const drawer = add('inspector-drawer'); drawer.inert = true;
  add('ins-title', 'h2', drawer); add('ins-key', 'p', drawer); add('ins-close', 'button', drawer);
  const bridgeContent = add('ins-bridge-content', 'div', drawer), programContent = add('ins-program-content', 'div', drawer);
  for (const id of ['ins-toggle', 'ins-disconnect', 'ins-help-text', 'ins-subscriptions', 'ins-channels', 'ins-acl-pub', 'ins-acl-sub']) add(id, 'div', bridgeContent);
  const form = add('annotation-form', 'form', bridgeContent);
  for (const id of ['bridge-name-input', 'program-names-input', 'annotation-dirty', 'annotation-save']) add(id, 'input', form);
  for (const id of ['ins-prog-bridge-count', 'ins-prog-bridges-list', 'btn-prog-fly']) add(id, 'div', programContent);
  for (const id of ['hud-search-input', 'stream-search', 'stream-bridge-filter', 'stream-count', 'stream-ticker', 'stream-empty', 'btn-refresh', 'status-dot', 'status-text']) add(id, 'input');
  add('stream-drawer').classList.add('expanded'); add('stream-table-body', 'tbody');
  for (const id of ['ret-protected-count', 'ret-last-seq', 'ret-capacity-spec', 'ret-usage-text', 'ret-oldest-seq',
    'ret-segment-room', 'ret-blockers', 'ret-blob-usage', 'ret-blob-room', 'ret-gap-failures', 'ret-warning-text']) add(id);
  const raf = [], timers = [], animations = [], readRequests = [];
  const state = { data: { hub: { hubId: 'probe-hub', startedAt: 'one', subscriptions: [] }, bridges: [], events: [], log: { records: [] } }, selected: null, selectedProgram: null, hoveredBridge: null, hoveredProgram: null, fresh: true, busy: new Set(), dirty: false, drafts: new Map(), view: 'activity', epoch: 'probe-hub|one', first: false, eventIds: new Set(), maxEventId: 0, events: [], streamSignature: '', programPositions: new Map(), nodePositions: new Map(), viewport: { x: 500, y: 400, scale: 1 }, flowAnimation: true };
  const context = vm.createContext({ state, document: doc, NS: 'http://www.w3.org/2000/svg', MAX_EVENTS: 600, MAX_ROWS: 150, MAX_PULSES: 8,
    str: value => value == null ? '' : String(value), asArray: value => Array.isArray(value) ? value : [],
    formatCount: value => Number.isFinite(value) ? String(value) : '—', bytes: value => String(value), time: value => String(value),
    $: id => dom.get(id) ?? null, setText: (id, value) => { const node = dom.get(id); if (node) node.textContent = value; },
    polling: false, refreshAgain: false, pollTimer: null, pollCompletion: Promise.resolve(), lastGoodAt: null,
    inspectorOpener: null, inspectorProgramKey: null, programBridgeCards: new Map(), streamRows: new Map(),
    render: () => {}, renderRetentionData: () => {}, fitAll: () => {}, toast: () => {}, updateViewportCulling: () => {}, updateTransform: () => {},
    window: { innerWidth: 1000, innerHeight: 800 }, performance: { now: () => 0 }, viewportG: { style: {} },
    requestAnimationFrame: callback => { raf.push(callback); return raf.length; }, setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout: () => {},
    request: async path => { readRequests.push(path); return state.data; }, animateEvents: events => animations.push(events.map(event => ({ ...event }))), viewMessage: seq => readRequests.push(seq),
  });
  const names = ['el', 'svgEl', 'shorten', 'bridges', 'selectedBridge', 'selectedProgram', 'label', 'status', 'stateClass', 'endpointBridge', 'endpointName',
    'safeId', 'programKey', 'computeGraphLayout', 'applyHighlightTopology', 'highlightProgram', 'captureDraft', 'openInspector', 'closeInspector', 'selectBridge', 'selectProgram', 'renderInspector',
    'updateBridgeNodeContents', 'eventType', 'eventRoute', 'concernsBridge', 'streamRowKey', 'createStreamRow', 'updateStreamRow', 'renderStream', 'renderRetentionData', 'refresh', 'collectEvents', 'saveAnnotation'];
  vm.runInContext(names.map(name => sourceFunction(name)).join('\n'), context);
  vm.runInContext(sourceFunction('flyToNode', '// Top HUD Search'), context);
  function bridge(key, programs = []) { return { key, label: key, manageable: true, paused: false, kind: 'bridge', programs, instances: [], allow: { publish: [], subscribe: [] } }; }
  return { context, state, doc, dom, add, bridge, animations, raf, readRequests };
}

test('P6: retention view exposes capacity blockers and exact blob bytes without executing provider text', () => {
  const h = harness();
  h.state.data.log = { protectedCount: 3, lastSeq: 9, oldestSeq: 1, bytes: 800, segmentCount: 2, retainedCount: 4,
    capacity: { segmentMaxBytes: 512, segmentMaxCount: 2 }, unusedSegmentSlots: 0, activeSegmentTargetRemainingBytes: 200,
    nextRotationBlocked: true, oldestProtectedOwners: [{ principal: '<img src=x onerror=run()>', firstSeq: 1, lastSeq: 3, count: 3 }] };
  h.state.data.blobs = { reservedBytesExact: '9007199254740993', remainingBytes: '0', remainingObjectSlots: 0,
    count: 2, uploadingCount: 1, reclaimableBytes: '123', reclaimableObjectCount: 1,
    limits: { maxTotalBytes: 9007199254740991, maxObjects: 2 } };
  h.state.data.hub.counters = { gapLogFailures: 2 };
  h.context.renderRetentionData();
  assert.match(h.dom.get('ret-blockers').textContent, /<img src=x onerror=run\(\)>.*#1–#3/);
  assert.equal(h.dom.get('ret-blockers').childNodes.length, 0, 'principal names remain literal text');
  assert.match(h.dom.get('ret-blob-usage').textContent, /9007199254740993 B/);
  assert.match(h.dom.get('ret-blob-room').textContent, /剩余 0 B.*可按需回收 123 B/);
  assert.match(h.dom.get('ret-segment-room').textContent, /非精确可写容量/);
  assert.match(h.dom.get('ret-gap-failures').textContent, /2 次.*重启归零/);
  h.state.data.log.oldestProtectedOwners = []; h.state.data.log.nextRotationBlocked = false;
  h.state.data.blobs = undefined; h.context.renderRetentionData();
  assert.equal(h.dom.get('ret-blockers').textContent, '最旧段没有受保护的提供者记录');
  assert.equal(h.dom.get('ret-warning-text').textContent, '');
  assert.equal(h.dom.get('ret-blob-usage').textContent, '附件状态不可用');
});

test('R02: arbitrary IDs have distinct DOM encodings and placeholders cannot merge with real programs', () => {
  const h = harness(), ids = ['p.a', 'p_a', '程序甲', '程序乙', 'a:b', 'a.b', '😀', 'unmarked:bridge.a'];
  assert.equal(new Set(ids.map(id => h.context.safeId(id))).size, ids.length);
  h.state.data.bridges = [h.bridge('bridge.a'), h.bridge('bridge.b', [{ id: 'unmarked:bridge.a', name: 'Real program' }])];
  h.context.computeGraphLayout(); assert.equal(h.state.programPositions.size, 2);
  assert.equal([...h.state.programPositions.values()].filter(p => p.unmarked).length, 1);
});

test('R02: shared arbitrary program still has N:M relations', () => {
  const h = harness();
  h.state.data.bridges = [h.bridge('a', [{ id: '共享:程序', name: 'Shared' }, { id: 'p.a', name: 'Extra' }]), h.bridge('b', [{ id: '共享:程序', name: 'Shared' }])];
  h.context.computeGraphLayout();
  assert.deepEqual([...h.state.programPositions.get(h.context.programKey('共享:程序')).bridgeKeys], ['a', 'b']);
  assert.equal(h.state.programPositions.size, 2);
});

test('R02: selection, hover and fly-to emphasize the intended node for formerly colliding IDs', () => {
  const h = harness(); h.state.data.bridges = [h.bridge('a', [{ id: '程序甲', name: 'A' }]), h.bridge('b', [{ id: '程序乙', name: 'B' }])]; h.context.computeGraphLayout();
  for (const bridge of h.state.data.bridges) { h.add('node-' + bridge.key); h.add('rail-' + bridge.key); }
  for (const [key, program] of h.state.programPositions) { h.add('pnode-' + h.context.safeId(key), 'g'); program.links = [...program.bridgeKeys].map(bKey => ({ bKey, link: new NodeModel('path', h.doc) })); }
  const key = h.context.programKey('程序乙'), target = h.dom.get('pnode-' + h.context.safeId(key)), other = h.dom.get('pnode-' + h.context.safeId(h.context.programKey('程序甲')));
  h.context.selectProgram(key, target); assert.equal(target.classList.contains('selected'), true); assert.equal(other.classList.contains('selected'), false);
  h.state.selectedProgram = null; h.context.highlightProgram(h.state.programPositions.get(key)); assert.equal(target.classList.contains('highlight'), true); assert.equal(other.classList.contains('highlight'), false);
  h.context.flyToNode('program', key); h.raf.shift()(400); assert.equal(target.classList.contains('target-flash'), true); assert.equal(other.classList.contains('target-flash'), false);
});

test('R04: online channel and instance changes update existing card without replacing its node', () => {
  const h = harness(), bridge = h.bridge('a'); bridge.instances = [{ bridgeId: 'a:1', channels: [] }]; h.state.data.bridges = [bridge];
  const group = h.add('node-a', 'g'), rail = h.add('rail-a', 'path');
  for (const name of ['bridge-dot', 'bridge-name', 'bridge-channel-text', 'bridge-status-text']) { const child = new NodeModel('text', h.doc); child.className = name; group.append(child); }
  const position = { el: group, rail }; h.state.nodePositions.set('a', position); h.context.updateBridgeNodeContents();
  assert.equal(group.querySelector('.bridge-channel-text').textContent, '未注册通道');
  bridge.instances = [{ bridgeId: 'a:2', connectionId: 'connection-two', channels: [{ name: 'arbitrary/new/topic', publish: true }] }]; h.context.updateBridgeNodeContents();
  assert.equal(group.querySelector('.bridge-channel-text').textContent, 'arbitrary/new/topic'); assert.equal(h.state.nodePositions.get('a').el === group, true);
  bridge.paused = true; bridge.instances = []; h.context.updateBridgeNodeContents(); assert.equal(group.classList.contains('paused'), true); assert.match(group.querySelector('.bridge-status-text').textContent, /0 实例/);
});

test('R05: 150 sequence-less events continue updating and same-seq events have separate rows', () => {
  const h = harness(); h.state.events = Array.from({ length: 150 }, (_, index) => ({ eventId: index + 1, kind: 'management.pause', principal: 'a' })); h.context.renderStream();
  h.state.events.push({ eventId: 151, kind: 'management.resume', principal: 'a' }); h.context.renderStream();
  assert.equal(h.dom.get('stream-table-body').firstElementChild.children[1].textContent, '恢复'); assert.equal(h.dom.get('stream-table-body').children.length, 150);
  h.state.events = [{ eventId: 152, kind: 'message', seq: 8, from: 'a', topic: 'any/topic' }, { eventId: 153, kind: 'delivery', seq: 8, to: 'a', sent: false, topic: 'any/topic' }]; h.context.renderStream();
  assert.equal(h.context.streamRows.size, 2); assert.equal(h.dom.get('stream-table-body').firstElementChild.children[1].textContent, '投递失败');
});

test('R05/R09: renamed paths update while an existing original-frame button remains focusable', () => {
  const h = harness(), bridge = h.bridge('a'); h.state.data.bridges = [bridge]; h.state.events = [{ eventId: 1, kind: 'message', seq: 8, from: 'a', topic: 'any/topic' }]; h.context.renderStream();
  const key = h.context.streamRowKey(h.state.events[0]), entry = h.context.streamRows.get(key), button = entry.seqButton; button.focus();
  bridge.label = 'New label'; h.state.events.push({ eventId: 2, kind: 'message', seq: 9, from: 'a', topic: 'any/topic' }); h.context.renderStream();
  assert.equal(h.context.streamRows.get(key).seqButton === button, true); assert.equal(h.doc.activeElement === button, true); assert.match(entry.routeText.textContent, /New label/);
  button.listeners.get('click')(); assert.equal(h.readRequests.at(-1), 8);
});

test('R09: focused historical row stays within the 150-row bound during high event turnover', () => {
  const h = harness(); h.state.events = [{ eventId: 1, kind: 'message', seq: 8, from: 'a' }]; h.context.renderStream();
  const entry = h.context.streamRows.get(h.context.streamRowKey(h.state.events[0])); entry.seqButton.focus();
  h.state.events = Array.from({ length: 200 }, (_, index) => ({ eventId: index + 2, kind: 'message', seq: index + 9, from: 'a' })); h.context.renderStream();
  assert.equal(h.doc.activeElement === entry.seqButton, true); assert.equal(h.dom.get('stream-table-body').children.length, 150); assert.match(h.dom.get('stream-count').textContent, /保留键盘焦点行/);
});

test('R06/R08: same-bridge reselection, switching and close/reopen preserve draft and return focus', () => {
  const h = harness(); h.state.data.bridges = [h.bridge('a'), h.bridge('b')];
  const opener = h.add('node-a', 'g'); opener.focus(); h.context.selectBridge('a', opener);
  const input = h.dom.get('bridge-name-input'); input.value = 'Unsaved draft'; h.state.dirty = true; h.context.captureDraft(); input.focus();
  h.context.selectBridge('a', opener); assert.equal(input.value, 'Unsaved draft'); assert.equal(h.state.dirty, true); assert.equal(h.doc.activeElement === input, true);
  h.context.selectBridge('b'); h.context.selectBridge('a'); assert.equal(input.value, 'Unsaved draft');
  h.dom.get('ins-close').focus(); h.context.closeInspector(); assert.equal(h.dom.get('inspector-drawer').inert, true); assert.equal(h.dom.get('inspector-drawer').getAttribute('aria-hidden'), 'true'); assert.equal(h.doc.activeElement === opener, true);
  h.context.selectBridge('a', opener); assert.equal(input.value, 'Unsaved draft'); assert.equal(h.dom.get('inspector-drawer').inert, false);
});

test('R09: program-to-bridge buttons are reused across online-state polling', () => {
  const h = harness(), bridge = h.bridge('a', [{ id: 'p.a', name: 'Program' }]); h.state.data.bridges = [bridge]; h.context.computeGraphLayout(); h.context.selectProgram(h.context.programKey('p.a'), h.add('program-node', 'g'));
  const first = h.context.programBridgeCards.get('a').jumpBtn; first.focus(); bridge.instances = [{ bridgeId: 'a', channels: [] }]; bridge.label = 'Updated bridge'; h.context.renderInspector();
  assert.equal(h.context.programBridgeCards.get('a').jumpBtn === first, true); assert.equal(h.doc.activeElement === first, true); assert.equal(h.context.programBridgeCards.get('a').title.textContent, 'Updated bridge');
});

test('R06: edits typed while annotation save is pending are not discarded by its successful response', async () => {
  const h = harness(), bridge = h.bridge('a'); h.state.data.bridges = [bridge]; h.state.selected = 'a'; h.context.renderInspector(true);
  const input = h.dom.get('bridge-name-input'); input.value = 'Submitted name'; h.state.dirty = true; h.context.captureDraft();
  let resolvePost; h.context.request = () => new Promise(resolve => { resolvePost = resolve; }); h.context.refresh = async options => { assert.equal(options.afterMutation, true); };
  const pending = h.context.saveAnnotation({ preventDefault() {} });
  input.value = 'Newer unsaved name'; h.context.captureDraft(); resolvePost({ ok: true }); await pending;
  assert.equal(h.state.dirty, true); assert.equal(input.value, 'Newer unsaved name'); assert.equal(h.state.drafts.get('a').bridgeName, 'Newer unsaved name');
});

test('R10: first and restarted-hub snapshots establish a baseline; subsequent real events animate', async () => {
  const h = harness(); h.state.epoch = null; h.state.first = true;
  h.state.data.bridges = [h.bridge('a')]; h.state.data.events = [{ eventId: 1, kind: 'message', seq: 1, from: 'a', at: '2000-01-01' }];
  await h.context.refresh(); assert.equal(h.animations.length, 0);
  h.state.data.events.push({ eventId: 2, kind: 'message', seq: 2, from: 'a' }); await h.context.refresh(); assert.equal(h.animations.length, 1); assert.equal(h.animations[0][0].eventId, 2);
  h.state.data.hub.startedAt = 'two'; h.state.data.events = [{ eventId: 1, kind: 'message', seq: 3, from: 'a' }]; await h.context.refresh(); assert.equal(h.animations.length, 1);
  h.state.data.events.push({ eventId: 2, kind: 'message', seq: 4, from: 'a' }); await h.context.refresh(); assert.equal(h.animations.length, 2);
});
