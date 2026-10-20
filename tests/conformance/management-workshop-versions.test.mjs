import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createI18n } from '../../src/ui/language.mjs';
import english from '../../src/management/canvas-i18n.mjs';

class Node {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this.attributes = {}; this.value = ''; this._text = '';
    const classes = new Set();
    this.classList = {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
      toggle: (c, force) => {
        const next = force !== undefined ? Boolean(force) : !classes.has(c);
        if (next) classes.add(c); else classes.delete(c);
        return next;
      }
    };
  }
  focus() { this.focused = true; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  add(option) { this.append(option); if (this.children.length === 1) this.value = option.value; }
  setAttribute(key, value) { this.attributes[key] = value; }
  set textContent(text) { this._text = String(text); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(text) { this._html = text; this._text = text; this.children = []; }
  querySelectorAll(sel) { return []; }
  querySelector(sel) { return null; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
async function scene(entries) {
  const elements = { 'inp-workshop-source-url': { value: 'https://example.test/workshop/index.json' }, 'inp-workshop-private-network': { checked: true }, 'workshop-entries-box': new Node('section') };
  const downloads = [], requests = [], details = [];
  const context = vm.createContext({ document: { getElementById: id => elements[id], createElement: tag => new Node(tag) },
    Option: function(text, value) { const node = new Node('option'); node.textContent = text; node.value = value; return node; },
    window: { hubCanvas: { state: { data: { csrfToken: 'test-only' } } } },
    fetch: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true, source: 'https://example.test/workshop/index.json', digest: 'f'.repeat(64), index: { entries } }) }; } });
  const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController') + '\nglobalThis.controller = new CanvasModesController();', context);
  context.controller.fetchWorkshopModule = async (...args) => { downloads.push(args); };
  context.controller.openWorkshopDetailModal = (entry, versions) => { details.push({ entry, versions }); };
  await context.controller.inspectWorkshopSource();
  return { box: elements['workshop-entries-box'], downloads, requests, details, controller: context.controller };
}
const entry = (version, platform, license, title = 'Same work') => ({ kind: 'module', id: 'test.module', entryId: `version.${version}`, version, title, license, platforms: [platform], sha256: (version === '1.0.0' ? 'a' : 'b').repeat(64) });
const click = { stopPropagation() {} };
const visuals = label => ({ cover: { url: `https://images.example.test/${label}-cover.png`, alt: `${label} cover` },
  icon: { url: `https://images.example.test/${label}-icon.png`, alt: `${label} icon` },
  screenshots: [{ url: `https://images.example.test/${label}-screen.png`, alt: `${label} screenshot` }] });

test('management Workshop: selecting an old version changes metadata and fetches its exact reviewed entry', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const old = { ...entry('1.0.0', 'win32-x64', 'Apache-2.0', hostile), description: 'Older description', presentation: visuals('old'),
    provides: [{ id: 'old.output', version: '1.0.0' }], requires: [{ id: 'old.input', version: '1.0.0' }] };
  const latest = { ...entry('2.0.0', 'linux-x64', 'MIT'), description: 'Latest description', presentation: visuals('latest'),
    provides: [{ id: 'latest.output', version: '2.0.0' }], requires: [] };
  const view = await scene([old, entry('2.0.0-beta.2', 'darwin-arm64', 'BSD-3-Clause'), latest]);
  assert.equal(view.box.children.length, 1, 'versions remain one work card');
  const select = walk(view.box).find(node => node.tag === 'select');
  assert.equal(select.value, 'version.2.0.0');
  assert.match(view.box.textContent, /共 3 个已发布版本/);
  assert.deepEqual(walk(view.box).filter(node => node.tag === 'img').map(node => node.src).sort(), Object.values(visuals('latest')).flat().map(item => item.url).sort());
  select.value = 'version.1.0.0'; select.onchange(click);
  assert.match(view.box.textContent, /Apache-2.0/); assert.match(view.box.textContent, /win32-x64/);
  assert.equal(view.box.textContent.includes('linux-x64'), false); assert.equal(view.box.textContent.includes('BSD-3-Clause'), false);
  assert.match(view.box.textContent, /a{64}/); assert.equal(view.box.textContent.includes('b'.repeat(64)), false);
  assert.match(view.box.textContent, /Older description/); assert.equal(view.box.textContent.includes('Latest description'), false);
  assert.match(view.box.textContent, /old\.output/); assert.match(view.box.textContent, /old\.input/); assert.equal(view.box.textContent.includes('latest.output'), false);
  assert.equal(walk(view.box).find(node => node.tag === 'h4').textContent, hostile, 'publisher title remains literal text');
  assert.equal(walk(view.box).some(node => node._html?.includes(hostile)), false, 'publisher title is never interpolated into executable markup');
  assert.deepEqual(walk(view.box).filter(node => node.tag === 'img').map(node => node.src).sort(), Object.values(visuals('old')).flat().map(item => item.url).sort());
  view.controller.renderWorkshopCards();
  assert.equal(walk(view.box).find(node => node.tag === 'select').value, 'version.1.0.0', 'rerendering filters retains the selected release');
  view.box.children[0].onclick();
  assert.equal(view.details[0].entry.version, old.version, 'the detail view also uses the selected release');
  await walk(view.box).find(node => node.tag === 'button').onclick(click);
  assert.deepEqual(Array.from(view.downloads[0]), ['https://example.test/workshop/index.json', 'version.1.0.0', 'f'.repeat(64), true]);
  assert.equal(walk(view.box).find(node => node.tag === 'select').value, 'version.1.0.0'); assert.equal(view.requests[0].body.allowPrivateNetwork, true);
});

test('management Workshop: one-version work explicitly says that only one version is public', async () => {
  const view = await scene([entry('1.0.0', 'win32-x64', 'MIT')]);
  assert.match(view.box.textContent, /当前仅公开了这一个版本/);
  assert.equal(walk(view.box).find(node => node.tag === 'select').children.length, 1);
});

test('management Workshop: group cards in updates list allow individual member version switching and updates', async () => {
  const elements = {
    'inp-workshop-source-url': { value: 'https://example.test/workshop/index.json' },
    'inp-workshop-private-network': { checked: true },
    'workshop-entries-box': new Node('section'),
    'ws-updates-items-box': new Node('div'),
    'ws-updates-summary-title': new Node('span'),
    'ws-updates-summary-sub': new Node('span'),
    'ws-batch-update-count': new Node('span'),
    'btn-ws-batch-update': new Node('button')
  };
  const versionManagerCalls = [];
  const updateSingleCalls = [];
  const context = vm.createContext({
    document: { getElementById: id => elements[id] || null, createElement: tag => new Node(tag) },
    Option: function(text, value) { const node = new Node('option'); node.textContent = text; node.value = value; return node; },
    window: { hubCanvas: { state: { data: { csrfToken: 'test-only' } }, toast: () => {} } },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, source: 'https://example.test/workshop/index.json', digest: 'f'.repeat(64), index: { entries: [] } }) })
  });
  const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController') + '\nglobalThis.controller = new CanvasModesController();', context);
  const controller = context.controller;
  controller.openVersionManager = async (kind, id, fromWs) => {
    versionManagerCalls.push({ kind, id, fromWs });
  };
  controller.updateSingleItemFromUpdates = async (kind, id, target) => {
    updateSingleCalls.push({ kind, id, target });
  };

  controller.data = {
    groups: [
      { id: 'grp.1', title: 'Text Suite', memberProgramIds: ['mem.a', 'mem.b'] }
    ],
    programs: [
      { programId: 'mem.a', title: 'Source Module', state: 'running', module: { id: 'test.source', version: '1.0.0' } },
      { programId: 'mem.b', title: 'Processor Module', state: 'stopped', module: { id: 'test.proc', version: '1.0.0' } }
    ]
  };

  controller.workshopEntries = [
    { kind: 'module', id: 'test.source', entryId: 'version.1.1.0', version: '1.1.0' }
  ];

  controller.renderWorkshopUpdatesList();

  const updatesBox = elements['ws-updates-items-box'];
  const allNodes = walk(updatesBox);

  // Group card should exist
  assert.equal(allNodes.some(n => n.textContent.includes('Text Suite')), true);
  assert.equal(allNodes.some(n => n.textContent.includes('协同子成员 (2)')), true);

  // Check member A (has update)
  const memANodes = allNodes.filter(n => n.textContent.includes('Source Module'));
  assert.equal(memANodes.length > 0, true);
  assert.equal(allNodes.some(n => n.textContent.includes('v1.0.0 ➔ v1.1.0')), true);

  // Find buttons
  const buttons = allNodes.filter(n => n.tag === 'button');
  const memASwitch = buttons.find(b => b.textContent.includes('切换版本') && b.title?.includes('mem.a'));
  assert.equal(Boolean(memASwitch), true, 'Member A has switch version button');
  memASwitch.onclick({ stopPropagation() {} });
  assert.deepEqual(versionManagerCalls[0], { kind: 'modules', id: 'mem.a', fromWs: true });

  const memAUpdate = buttons.find(b => b.textContent.includes('立即更新') && b.title?.includes('v1.1.0'));
  assert.equal(Boolean(memAUpdate), true, 'Member A has instant update button');
  memAUpdate.onclick({ stopPropagation() {} });
  assert.deepEqual(updateSingleCalls[0], { kind: 'modules', id: 'mem.a', target: controller.workshopEntries[0] });

  // Check member B (up to date, no update)
  const memBSwitch = buttons.find(b => b.textContent.includes('切换版本') && b.title?.includes('mem.b'));
  assert.equal(Boolean(memBSwitch), true, 'Member B has switch version button');
  memBSwitch.onclick({ stopPropagation() {} });
  assert.deepEqual(versionManagerCalls[1], { kind: 'modules', id: 'mem.b', fromWs: true });
});

test('management Workshop: detail modal renders "在官网打开" button with proper official publication URL and external attributes', async () => {
  const elements = {
    'modal-workshop-detail': new Node('div'),
    'ws-detail-body': new Node('div'),
    'ws-detail-header-title': new Node('h3'),
    'btn-detail-download': new Node('button'),
    'btn-detail-open-web': new Node('a'),
    'inp-workshop-source-url': { value: 'https://example.test/workshop/index.json' },
    'inp-workshop-private-network': { checked: true }
  };
  elements['modal-workshop-detail'].classList = {
    _classes: new Set(['hidden']),
    remove(c) { this._classes.delete(c); },
    add(c) { this._classes.add(c); },
    contains(c) { return this._classes.has(c); }
  };
  const context = vm.createContext({
    document: { getElementById: id => elements[id] || null, createElement: tag => new Node(tag) },
    Option: function(text, value) { const node = new Node('option'); node.textContent = text; node.value = value; return node; },
    window: { hubCanvas: { state: { data: { csrfToken: 'test-only' } }, toast: () => {} } },
    URL: globalThis.URL
  });
  const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController') + '\nglobalThis.controller = new CanvasModesController();', context);
  const controller = context.controller;

  const v1 = { kind: 'module', id: 'official.demo', entryId: 'official.demo.1.0.0', version: '1.0.0', title: 'Official Demo' };
  const v2 = { kind: 'module', id: 'official.demo', entryId: 'official.demo.2.0.0', version: '2.0.0', title: 'Official Demo' };
  const customHomepage = { kind: 'module', id: 'custom.demo', entryId: 'custom.demo.1.0.0', version: '1.0.0', title: 'Custom', presentation: { homepage: 'https://custom-project.org' } };

  // Test URL calculation
  assert.equal(controller.getEntryOfficialUrl(v1), 'https://example.test/workshop/#publication/official.demo.1.0.0');
  assert.equal(controller.getEntryOfficialUrl(customHomepage), 'https://custom-project.org');

  // Test detail modal populates link
  controller.openWorkshopDetailModal(v1, [v1, v2]);
  assert.equal(elements['btn-detail-open-web'].href, 'https://example.test/workshop/#publication/official.demo.1.0.0');

  // Test version switch updates link
  controller.openWorkshopDetailModal(v2, [v1, v2]);
  assert.equal(elements['btn-detail-open-web'].href, 'https://example.test/workshop/#publication/official.demo.2.0.0');
});

test('management: adaptAndDetectPath automatically adapts manifest files, zip archives, and directories', async () => {
  const context = vm.createContext({
    document: { getElementById: () => null, createElement: tag => new Node(tag) },
    window: { hubCanvas: { state: { data: { csrfToken: 'test-only' } }, toast: () => {} } },
    URL: globalThis.URL
  });
  const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController') + '\nglobalThis.controller = new CanvasModesController();', context);
  const controller = context.controller;

  // 1. Module manifest inside directory -> automatically adapts to parent directory
  const modManifest = controller.adaptAndDetectPath('C:\\projects\\my-module\\module.json');
  assert.equal(modManifest.path, 'C:\\projects\\my-module');
  assert.equal(modManifest.kind, 'module-dir');

  // 2. Module group manifest -> automatically adapts to parent directory
  const groupManifest = controller.adaptAndDetectPath('/home/user/groups/my-group/module-group.json');
  assert.equal(groupManifest.path, '/home/user/groups/my-group');
  assert.equal(groupManifest.kind, 'module-group-dir');

  // 3. Deployment json inside module -> adapts to parent
  const depJson = controller.adaptAndDetectPath('D:\\apps\\counter\\deployment.json');
  assert.equal(depJson.path, 'D:\\apps\\counter');
  assert.equal(depJson.kind, 'module-dir');

  // 4. ZIP archive -> preserves zip path
  const zipFile = controller.adaptAndDetectPath('F:\\dist\\counter-1.0.0.zip');
  assert.equal(zipFile.path, 'F:\\dist\\counter-1.0.0.zip');
  assert.equal(zipFile.kind, 'zip');

  // 5. Artifact json -> preserves artifact path
  const artJson = controller.adaptAndDetectPath('F:\\dist\\counter.artifact.json');
  assert.equal(artJson.path, 'F:\\dist\\counter.artifact.json');
  assert.equal(artJson.kind, 'artifact-json');

  // 6. Direct folder -> preserves directory path
  const dirPath = controller.adaptAndDetectPath('C:\\modules\\my-counter');
  assert.equal(dirPath.path, 'C:\\modules\\my-counter');
  assert.equal(dirPath.kind, 'directory');

  // 7. Enclosing quotes (Windows Copy-as-path) -> automatically stripped
  const quoted = controller.adaptAndDetectPath('"C:\\modules\\quoted-module\\module.json"');
  assert.equal(quoted.path, 'C:\\modules\\quoted-module');
  assert.equal(quoted.kind, 'module-dir');
});

test('management: inspectImportModule provides immediate visual and toast feedback on empty or valid paths', async () => {
  const elements = {
    'inp-import-path': new Node('input'),
    'btn-do-inspect': new Node('button'),
    'btn-confirm-import': new Node('button'),
    'import-preview-box': new Node('div'),
    'import-prev-title': new Node('strong'),
    'import-prev-runtime': new Node('span'),
    'import-prev-desc': new Node('div'),
    'import-review-details': new Node('div')
  };
  elements['btn-do-inspect'].textContent = '检测模块';
  elements['btn-confirm-import'].disabled = true;

  const toasts = [];
  const context = vm.createContext({
    document: { getElementById: id => elements[id], createElement: tag => new Node(tag) },
    window: {
      hubCanvas: {
        state: { data: { csrfToken: 'test-token' } },
        toast: (msg, type) => toasts.push({ msg, type })
      }
    },
    URL: globalThis.URL,
    fetch: async (url, init) => {
      if (url === '/manage/api/artifacts/preview') {
        return {
          ok: true,
          json: async () => ({
            kind: 'module',
            reviewId: 'rev-test',
            review: {
              manifest: { title: 'Test Module', runtime: { kind: 'node' } },
              module: { id: 'test.module', version: '1.0.0' },
              bridges: {},
              topics: {},
              settings: {},
              bindings: []
            }
          })
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    }
  });

  const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController') + '\nglobalThis.controller = new CanvasModesController();', context);
  const controller = context.controller;

  // Case 1: Empty input -> should highlight input-error and display warning toast without throwing
  elements['inp-import-path'].value = '   ';
  await controller.inspectImportModule();
  assert.equal(elements['inp-import-path'].classList.contains('input-error'), true, 'input has error class');
  assert.equal(elements['inp-import-path'].focused, true, 'input is focused');
  assert.match(toasts[toasts.length - 1].msg, /请先输入或选择本地模块目录/);
  assert.equal(elements['btn-confirm-import'].disabled, true);

  // Case 2: Valid path with quotes -> strips quotes, checks module, and shows success toast
  elements['inp-import-path'].value = '"F:\\test\\my-mod"';
  await controller.inspectImportModule();
  assert.equal(elements['inp-import-path'].classList.contains('input-error'), false, 'input error removed');
  assert.equal(elements['inp-import-path'].value, 'F:\\test\\my-mod', 'quotes stripped');
  assert.equal(elements['btn-confirm-import'].disabled, false, 'confirm enabled');
  assert.equal(elements['btn-do-inspect'].textContent, '检测模块', 'button text restored');
  assert.equal(elements['btn-do-inspect'].disabled, false, 'button re-enabled');
  assert.match(toasts[toasts.length - 1].msg, /模块检测通过/);
});

test('management: group containers are hidden and cleared in orbits perspective and restored in topology perspective', async () => {
  const elements = {
    'group-containers-g': new Node('g'),
    'module-nodes-g': new Node('g'),
    'wiring-cables-g': new Node('g'),
    'orchestration-dag-g': new Node('g'),
    'btn-perspective-toggle': new Node('button'),
    'viewport': new Node('g'),
    'hub-node': new Node('g'),
    'guides-g': new Node('g'),
    'rails-g': new Node('g'),
    'pulses-g': new Node('g'),
    'bridge-nodes-g': new Node('g'),
    'program-nodes-g': new Node('g'),
    'annotation-links-g': new Node('g')
  };

  const context = vm.createContext({
    window: { hubCanvas: { toast() {} } },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => []
    },
    console
  });

  const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController') + '\nglobalThis.controller = new CanvasModesController();', context);
  const controller = context.controller;

  controller.mode = 'runtime';
  controller.data = { groups: [{ id: 'grp-1', title: 'Group 1', memberProgramIds: ['mod-1'] }], programs: [{ programId: 'mod-1' }] };

  // 1. Orbits perspective -> group-containers-g must be hidden and have no children
  controller.runtimePerspective = 'orbits';
  controller.updateModeUI();
  controller.render();
  assert.equal(elements['group-containers-g'].classList.contains('hidden'), true, 'group-containers-g must be hidden in orbits');
  assert.equal(elements['module-nodes-g'].classList.contains('hidden'), true, 'module-nodes-g must be hidden in orbits');

  // 2. Topology perspective -> group-containers-g must be visible
  controller.runtimePerspective = 'topology';
  controller.updateModeUI();
  assert.equal(elements['group-containers-g'].classList.contains('hidden'), false, 'group-containers-g must be visible in topology');
  assert.equal(elements['module-nodes-g'].classList.contains('hidden'), false, 'module-nodes-g must be visible in topology');
});

test('management: CanvasModesController handles full bilingual switching between English and Chinese cleanly', async () => {
  const i18n = createI18n(english);
  const elements = {
    'btn-perspective-toggle': new Node('button'),
    'btn-dock-add-menu': new Node('button'),
    'btn-auto-layout-ctrl': new Node('button'),
    'hud-group-filter': new Node('select'),
    'group-containers-g': new Node('g'),
    'module-nodes-g': new Node('g'),
    'wiring-cables-g': new Node('g'),
    'orchestration-dag-g': new Node('g'),
    'viewport': new Node('g'),
    'hub-node': new Node('g'),
    'guides-g': new Node('g'),
    'rails-g': new Node('g'),
    'pulses-g': new Node('g'),
    'bridge-nodes-g': new Node('g'),
    'program-nodes-g': new Node('g'),
    'annotation-links-g': new Node('g')
  };

  const context = vm.createContext({
    window: {
      hubCanvas: {
        language: 'zh-CN',
        getLanguage: () => i18n.language,
        translate: (source, params) => i18n.t(source, params),
        applyLabels: root => i18n.apply(root),
        toast() {}
      }
    },
    document: {
      body: new Node('body'),
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => []
    },
    console
  });

  const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController') + '\nglobalThis.controller = new CanvasModesController();', context);
  const controller = context.controller;

  // Initialize perspective and dock
  elements['btn-perspective-toggle'].textContent = '🗺 拓扑卡片';
  elements['btn-perspective-toggle'].title = '在微服务拓扑卡片与天体同心圆轨道视角间切换';
  elements['btn-dock-add-menu'].setAttribute('data-tooltip', '➕ 添加与创作 (6 大功能)');

  // 1. Switch to English
  i18n.setLanguage('en');
  context.window.hubCanvas.language = 'en';
  controller.renderLanguage();

  assert.equal(elements['btn-perspective-toggle'].textContent, '🗺 Topology Cards');
  assert.equal(elements['btn-perspective-toggle'].title, 'Toggle between microservice topology cards and celestial orbit projection');
  assert.equal(elements['btn-dock-add-menu'].attributes['data-tooltip'], '➕ Create & Author (6 Tools)');

  // Verify workshop cache, version management, batch update, and inspect translations
  assert.equal(i18n.t('🟢 已导入 Hub'), '🟢 Imported to Hub');
  assert.equal(i18n.t('🟡 就绪待导入'), '🟡 Ready to Import');
  assert.equal(i18n.t('🧩 模块组编排'), '🧩 Module Group');
  assert.equal(i18n.t('📦 独立受管模块'), '📦 Standalone Managed Module');
  assert.equal(i18n.t('复制 SHA'), 'Copy SHA');
  assert.equal(i18n.t('🗑 清除缓存'), '🗑 Clear Cache');
  assert.equal(i18n.t('📂 本地目录或制品文件'), '📂 Local directory or artifact file');
  assert.equal(i18n.t('📁 本地目录 (Folder)'), '📁 Local Directory (Folder)');
  assert.equal(i18n.t('📄 制品文件 (ZIP / JSON)'), '📄 Distribution File (ZIP / JSON)');
  assert.equal(i18n.t('策略: 保留当前配置 · 保留实例数据'), 'Policy: Preserve current config · Preserve instance data');
  assert.equal(i18n.t('✓ 已就绪 (已停止)'), '✓ Ready (Stopped)');
  assert.equal(i18n.t('正在核对模块、依赖与启动计划…'), 'Verifying modules, dependencies, and startup plan…');
  assert.equal(i18n.t('⚠️ 检测到该模块需依赖接线配置'), '⚠️ This module requires wiring configuration');
  assert.equal(i18n.t('仅主题连接'), 'Topic connection only');
  assert.equal(i18n.t('仅能力绑定'), 'Capability binding only');
  assert.equal(i18n.t('✓ 模块检测通过，请审阅下方配置并确认导入'), '✓ Module inspection passed. Review configuration below and confirm import.');

  // 2. Switch back to Chinese
  i18n.setLanguage('zh-CN');
  context.window.hubCanvas.language = 'zh-CN';
  controller.renderLanguage();

  assert.equal(elements['btn-perspective-toggle'].textContent, '🗺 拓扑卡片');
  assert.equal(elements['btn-perspective-toggle'].title, '在微服务拓扑卡片与天体同心圆轨道视角间切换');
  assert.equal(elements['btn-dock-add-menu'].attributes['data-tooltip'], '➕ 添加与创作 (6 大功能)');

  // Verify complete faithful restoration to Chinese
  assert.equal(i18n.t('🟢 已导入 Hub'), '🟢 已导入 Hub');
  assert.equal(i18n.t('🟡 就绪待导入'), '🟡 就绪待导入');
  assert.equal(i18n.t('🧩 模块组编排'), '🧩 模块组编排');
  assert.equal(i18n.t('📦 独立受管模块'), '📦 独立受管模块');
  assert.equal(i18n.t('复制 SHA'), '复制 SHA');
  assert.equal(i18n.t('🗑 清除缓存'), '🗑 清除缓存');
  assert.equal(i18n.t('📂 本地目录或制品文件'), '📂 本地目录或制品文件');
  assert.equal(i18n.t('📁 本地目录 (Folder)'), '📁 本地目录 (Folder)');
  assert.equal(i18n.t('📄 制品文件 (ZIP / JSON)'), '📄 制品文件 (ZIP / JSON)');
  assert.equal(i18n.t('策略: 保留当前配置 · 保留实例数据'), '策略: 保留当前配置 · 保留实例数据');
  assert.equal(i18n.t('✓ 已就绪 (已停止)'), '✓ 已就绪 (已停止)');
  assert.equal(i18n.t('正在核对模块、依赖与启动计划…'), '正在核对模块、依赖与启动计划…');
  assert.equal(i18n.t('⚠️ 检测到该模块需依赖接线配置'), '⚠️ 检测到该模块需依赖接线配置');
  assert.equal(i18n.t('仅主题连接'), '仅主题连接');
  assert.equal(i18n.t('仅能力绑定'), '仅能力绑定');
  assert.equal(i18n.t('✓ 模块检测通过，请审阅下方配置并确认导入'), '✓ 模块检测通过，请审阅下方配置并确认导入');
});
