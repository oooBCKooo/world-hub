import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { groupAssets, createAssetVersionSelection } from '../../../tools/launcher/public/asset-versions.mjs';

const source = await readFile(new URL('../../../tools/launcher/public/app.mjs', import.meta.url), 'utf8');
function scene() {
  const original = { instanceId: 'edited', directory: 'F:/private/edited', pack: { id: 'example.same', version: '1.0.0', title: 'Same pack' } };
  const other = { instanceId: 'other', directory: 'F:/private/other', pack: { id: 'example.same', version: '0.9.0', title: 'Same pack' } };
  const state = { instances: [original, other] }, selection = createAssetVersionSelection({ storage: null });
  const group = groupAssets(state.instances, { mode: 'instance' })[0];
  selection.select(group, group.options.find(row => row.instanceId === 'edited').key);
  const sandbox = vm.createContext({ state, groupAssets, packVersionSelection: selection, idOf: row => row.instanceId, invalidateChangedRun() {} });
  const start = source.indexOf('function replaceInstance('), tail = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && tail > start);
  vm.runInContext(source.slice(start, tail), sandbox);
  return { original, other, state, selection, replace: sandbox.replaceInstance };
}
test('explicit customization save and restore select the updated exact instance version without an unavailable card', () => {
  const view = scene();
  view.replace({ ...view.original, pack: { ...view.original.pack, version: '1.0.1' } }, { selectVersion: true });
  let group = groupAssets(view.state.instances, { mode: 'instance' })[0];
  assert.equal(view.selection.get(group).row.instanceId, 'edited'); assert.equal(view.selection.get(group).version, '1.0.1');
  view.replace(view.original, { selectVersion: true }); group = groupAssets(view.state.instances, { mode: 'instance' })[0];
  assert.equal(view.selection.get(group).row.instanceId, 'edited'); assert.equal(view.selection.get(group).version, '1.0.0');
  assert.equal(view.state.instances.find(row => row.instanceId === 'other'), view.other);
});
test('ordinary instance observations follow the same exact updated instance when the remembered option disappears', () => {
  const view = scene();
  view.state.instances.push({ instanceId: 'unrelated-newest', directory: 'F:/private/newest', pack: { id: 'example.same', version: '9.0.0' } });
  view.replace({ ...view.original, pack: { ...view.original.pack, version: '1.0.1' } });
  const selected = view.selection.get(groupAssets(view.state.instances, { mode: 'instance' })[0]);
  assert.equal(selected.row.instanceId, 'edited'); assert.equal(selected.version, '1.0.1');
  assert.equal(view.state.instances.find(row => row.instanceId === 'other'), view.other);
});

test('a removed instance falls back to an available exact instance without replacing another row or starting anything', () => {
  const view = scene(); view.state.instances = view.state.instances.filter(row => row.instanceId !== 'edited');
  const group = groupAssets(view.state.instances, { mode: 'instance' })[0], selected = view.selection.get(group);
  assert.equal(selected.row.instanceId, 'other'); assert.equal(selected.path, view.other.directory); assert.deepEqual(view.state.instances, [view.other]);
});
