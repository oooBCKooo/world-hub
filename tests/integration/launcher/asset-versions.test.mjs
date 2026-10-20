import test from 'node:test';
import assert from 'node:assert/strict';
import { groupAssets, createAssetVersionSelection, compareAssetVersions, renderAssetVersionSelector, assetOptionLabel } from '../../../tools/launcher/public/asset-versions.mjs';
import { element } from './ui-dom.mjs';

test('local modules/templates group by exact kind and stable ID, retaining version and directory identity', () => {
  const old = Object.freeze({ kind: 'module', id: 'soft.ui', title: 'Old name', version: '1.0.0', path: 'F:\\old' });
  const latest = Object.freeze({ kind: 'module', id: 'soft.ui', title: 'New name', version: '2.0.0', path: 'F:\\new' });
  const copy = { ...latest, path: 'F:\\other' };
  const rows = [old, latest, copy, latest, { kind: 'template', id: 'soft.ui', version: '1.0.0', path: 'F:\\template' }, { kind: 'module', id: 'another', title: 'Old name', version: '1.0.0', path: 'F:\\another' }];
  const groups = groupAssets(rows);
  assert.equal(groups.length, 3);
  const module = groups.find(group => group.id === 'soft.ui' && group.kind === 'module');
  assert.deepEqual(module.versions, ['2.0.0', '1.0.0']);
  assert.equal(module.options.length, 3);
  assert.equal(module.options.find(option => option.path === old.path).row, old);
  assert.notEqual(module.options[0].key, module.options[1].key);
  assert.equal(old.title, 'Old name');
});

test('case-sensitive project IDs and POSIX paths are not conflated by frontend grouping', () => {
  const groups = groupAssets([{ kind: 'module', id: 'A', version: '1.0.0', path: '/tmp/Source' }, { kind: 'module', id: 'A', version: '1.0.0', path: '/tmp/source' }, { kind: 'module', id: 'a', version: '1.0.0', path: '/tmp/a' }]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].options.length, 2);
});

test('same source version with different publishers or content remains an explicit exact choice', () => {
  const first = { kind: 'module', id: 'soft.ui', version: '1.0.0', sourceId: 'one', entryId: 'soft.ui.v1', source: 'https://one/module.json', sha256: 'abc', indexDigest: 'index-one' };
  const other = { ...first, sourceId: 'two', source: 'https://two/module.json' };
  const changed = { ...first, sha256: 'changed' };
  const group = groupAssets([first, other, changed], { mode: 'source' })[0];
  assert.equal(group.options.length, 3);
  assert.equal(new Set(group.options.map(option => option.key)).size, 3);
  const selection = createAssetVersionSelection();
  selection.select(group, group.options.find(option => option.sourceId === 'two').key);
  assert.equal(selection.get(group).row, other);
  assert.equal(selection.get(group).entryId, 'soft.ui.v1');
  assert.match(assetOptionLabel(selection.get(group)), /two/);
});

test('two versions and two instances of one pack render one project but retain independent state and operation target', () => {
  const instances = [{ instanceId: 'run-old', pack: { id: 'desk', version: '1.0.0' }, status: { state: 'running' } }, { instanceId: 'run-new', pack: { id: 'desk', version: '2.0.0' }, status: { state: 'stopped' } }, { instanceId: 'run-copy', pack: { id: 'desk', version: '2.0.0' }, status: { state: 'failed' } }];
  const groups = groupAssets(instances, { mode: 'instance' });
  assert.equal(groups.length, 1); assert.equal(groups[0].options.length, 3);
  const selection = createAssetVersionSelection(), old = groups[0].options.find(option => option.instanceId === 'run-old');
  selection.select(groups[0], old.key);
  assert.equal(selection.get(groups[0]).row, instances[0]);
  assert.equal(selection.get(groups[0]).row.status.state, 'running');
  assert.equal(selection.get(groups[0]).instanceId, 'run-old');
  assert.deepEqual(instances.map(instance => instance.status.state), ['running', 'stopped', 'failed']);
});

test('refresh preserves an available selection and automatically replaces only a disappeared selection', () => {
  const old = { kind: 'module', id: 'desk', version: '1.0.0', path: '/old' }, newer = { ...old, version: '2.0.0', path: '/new' };
  const selection = createAssetVersionSelection(), first = groupAssets([old])[0];
  assert.equal(selection.get(first).row, old);
  const refreshed = groupAssets([newer, old])[0];
  assert.equal(selection.get(refreshed).row, old);
  const removed = groupAssets([newer])[0];
  assert.equal(selection.get(removed).row, newer);
  const notice = selection.notice(removed);
  assert.equal(notice.fromVersion, '1.0.0'); assert.equal(notice.toVersion, '2.0.0');
  assert.equal(selection.select(removed, 'forged or stale key'), false);
  assert.equal(selection.get(removed).row, newer); assert.deepEqual(selection.notice(removed), notice);
  assert.equal(selection.select(removed, removed.options[0].key), true);
  assert.equal(selection.notice(removed), null);
  assert.equal(selection.get(removed).row, newer);
});

test('an observed digest change selects the current same directory and reports the change without invoking actions', () => {
  const old = { kind: 'module', id: 'desk', version: '1.0.0', path: '/old', sha256: 'original' };
  const selection = createAssetVersionSelection(); selection.get(groupAssets([old])[0]);
  const changed = groupAssets([{ ...old, sha256: 'changed' }])[0];
  assert.equal(selection.get(changed).sha256, 'changed'); assert.ok(selection.notice(changed));
});

test('missing manifest IDs and unlocated declarations never merge unrelated unknown items', () => {
  const groups = groupAssets([{ instanceId: 'unknown-one', pack: null }, { instanceId: 'unknown-two', pack: null }], { mode: 'instance' });
  assert.equal(groups.length, 2);
  const unknown = groupAssets([{ kind: 'module', id: 'a', version: '1.0.0' }, { kind: 'module', id: 'a', version: '1.0.0' }]);
  assert.equal(unknown[0].options.length, 2);
  assert.throws(() => groupAssets([], { mode: 'business' }), TypeError);
});

test('version ordering handles major numbers, stable/prerelease precedence and build metadata without changing version text', () => {
  const versions = ['1.0.0-beta.2', '1.0.0', '1.0.0-beta.10', '10.0.0', '2.0.0', '1.0.0-alpha', '1.0.0-beta'];
  assert.deepEqual(versions.sort(compareAssetVersions), ['10.0.0', '2.0.0', '1.0.0', '1.0.0-beta.10', '1.0.0-beta.2', '1.0.0-beta', '1.0.0-alpha']);
  assert.equal(compareAssetVersions('1.0.0+build1', '1.0.0+build2'), 0);
  assert.ok(compareAssetVersions('100000000000000000000.0.0', '9.0.0') < 0);
  const groups = groupAssets([{ kind: 'module', id: 'legacy', version: 'custom-release', path: '/one' }, { kind: 'module', id: 'legacy', version: '1.0.0+build2', path: '/two' }]);
  assert.deepEqual(groups[0].versions, ['1.0.0+build2', 'custom-release']);
});

test('selector shows exact version/location and returns only the explicitly selected row in both languages', async () => {
  for (const language of ['en', 'zh']) {
    const rows = [{ kind: 'module', id: 'desk', version: '1.0.0', path: '/old' }, { kind: 'module', id: 'desk', version: '2.0.0', path: '/new' }];
    const group = groupAssets(rows)[0], selection = createAssetVersionSelection(), received = [];
    const node = renderAssetVersionSelector({ el: element, say: (zh, en) => language === 'zh' ? zh : en }, group, selection, { onChange: option => received.push(option.row) });
    const select = node.querySelector('select');
    assert.equal(select.options.length, 2);
    assert.equal(select.options[0].attributes.title, '/new');
    assert.equal(select.options[1].attributes.title, '/old');
    assert.match(node.textContent, /v1\.0\.0/);
    assert.match(node.textContent, /v2\.0\.0/);
    assert.match(node.textContent, language === 'zh' ? /操作仅针对所选项/ : /actions target only the selected item/);
    select.value = group.options.find(option => option.row === rows[0]).key; await select.dispatch('change');
    assert.deepEqual(received, [rows[0]]);
    select.value = 'injected'; await select.dispatch('change'); assert.equal(received.length, 1);
    assert.equal(select.value, selection.get(group).key);
  }
});

test('selector automatically chooses an available option with a bilingual notice even when normal help or a single selector is hidden', async () => {
  for (const language of ['zh', 'en']) {
  const first = { kind: 'template', id: 'desk', version: '1.0.0', path: '/old' }, second = { ...first, version: '2.0.0', path: '/new' };
  const selection = createAssetVersionSelection(); selection.get(groupAssets([first])[0]);
  const group = groupAssets([second])[0], received = [];
  const node = renderAssetVersionSelector({ el: element, say: (zh, en) => language === 'zh' ? zh : en }, group, selection, { alwaysShow: false, showHelp: false, versionOnly: true, onChange: option => received.push(option.row) });
  const select = node.querySelector('select');
  assert.equal(select.value, group.options[0].key); assert.notEqual(select.disabled, true); assert.equal(selection.get(group).row, second);
  assert.match(node.textContent, language === 'zh' ? /已自动切换至 v2\.0\.0/ : /Automatically selected v2\.0\.0/);
  assert.deepEqual(received, [], 'Changing a display preference does not invoke its action callback');
  select.value = group.options[0].key; await select.dispatch('change');
  assert.deepEqual(received, [second]);
  assert.equal(node.querySelector('[data-asset-auto-selected]'), null);
  }
});
test('page reload preserves an older exact selection and malformed preference data cannot choose a different item',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const group=groupAssets([{kind:'module',id:'demo',version:'2.0.0',path:'/new'},{kind:'module',id:'demo',version:'1.0.0',path:'/old'}])[0];
  const selection=createAssetVersionSelection({storage});assert.equal(selection.select(group,group.options.find(option=>option.version==='1.0.0').key),true);
  assert.equal(createAssetVersionSelection({storage}).get(group).row.path,'/old');
  const gone=groupAssets([group.options.find(option=>option.version==='2.0.0').row])[0];const replacement=createAssetVersionSelection({storage});assert.equal(replacement.get(gone).version,'2.0.0');assert.ok(replacement.notice(gone));
  assert.equal(createAssetVersionSelection({storage}).get(gone).version,'2.0.0');
  assert.equal(createAssetVersionSelection({storage}).notice(gone),null);
  values.set('world-hub.asset-version-selection/v1','bad JSON');assert.equal(createAssetVersionSelection({storage}).get(group).row.path,'/new');
});

test('same instance and directory survive version changes before considering newer unrelated options', () => {
  const selection = createAssetVersionSelection({ storage: null });
  const original = { instanceId: 'mine', packageDirectory: '/mine', pack: { id: 'desk', version: '1.0.0' } };
  selection.get(groupAssets([original], { mode: 'instance' })[0]);
  const updated = { ...original, pack: { id: 'desk', version: '1.0.1' } };
  const group = groupAssets([{ instanceId: 'other', packageDirectory: '/other', pack: { id: 'desk', version: '9.0.0' } }, updated], { mode: 'instance' })[0];
  assert.equal(selection.get(group).row, updated);
  const changed = { kind: 'module', id: 'desk', version: '1.0.0', path: '/mine', sha256: 'before' };
  const local = createAssetVersionSelection({ storage: null }); local.get(groupAssets([changed])[0]);
  const current = { ...changed, version: '1.0.1', sha256: 'after' };
  assert.equal(local.get(groupAssets([{ ...current, path: '/newer', version: '9.0.0' }, current])[0]).row, current);
});

test('an index refresh preserves the same exact source artifact and persists its replacement key across reloads', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const initial = { kind: 'module', id: 'desk', version: '1.0.0', sourceId: 'one', source: 'https://one/index', entryId: 'one-v1', sha256: 'old-artifact', indexDigest: 'before' };
  const selection = createAssetVersionSelection({ storage }); selection.get(groupAssets([initial], { mode: 'source' })[0]);
  const refreshed = { ...initial, indexDigest: 'after' }, newer = { ...initial, version: '3.0.0', entryId: 'one-v3', sha256: 'new-artifact', indexDigest: 'after' };
  const group = groupAssets([newer, refreshed], { mode: 'source' })[0];
  assert.equal(selection.get(group).row, refreshed); assert.ok(selection.notice(group));
  assert.equal(selection.get(group).row, refreshed); assert.ok(selection.notice(group), 'Repeated render passes retain the notice');
  assert.equal(createAssetVersionSelection({ storage }).get(group).row, refreshed);
});

test('no available rows keep the selector disabled without selecting another project or invoking callbacks', () => {
  const first = groupAssets([{ kind: 'module', id: 'desk', version: '1.0.0', path: '/gone' }])[0];
  const selection = createAssetVersionSelection({ storage: null }); selection.get(first);
  const group = { ...first, options: [], versions: [] }, received = [];
  assert.equal(selection.get(group), null);
  const node = renderAssetVersionSelector({ el: element }, group, selection, { onChange: option => received.push(option) });
  assert.equal(node.querySelector('select').disabled, true); assert.equal(node.querySelector('select').value, '');
  assert.match(node.textContent, /No available options/); assert.deepEqual(received, []);
});
