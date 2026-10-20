import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validatePack, createLock, inspectPackage, importPackage } from '../../../scripts/runtime/package.mjs';
import { deploymentTopics } from '../../../scripts/runtime/deployment.mjs';
import { derivePackage } from '../../../scripts/runtime/authoring.mjs';
import { startInstance } from '../../../scripts/runtime/runtime.mjs';
import { previewComposition, createComposition } from '../../../tools/launcher/composition.mjs';
import { workspace, fixturePackage, environment, json, save, ROOT } from '../launcher/helpers.mjs';

const example = () => ({ format: 'world-hub.pack/v1', id: 'test.aliases', version: '1.0.0', title: 'Program-local topic aliases', license: 'MIT',
  topics: { selected: 'aliases/selected', hidden: 'aliases/known-without-access', alternate: 'aliases/alternate' },
  components: [{ id: 'first', module: 'test.fixture', after: [], settings: {},
    topicAliases: { source: 'selected', unused: 'hidden' }, bridges: { main: { publish: ['selected'], subscribe: [] } } }],
  bindings: [], entry: { component: 'first' }, startupTimeoutMs: 4000, healthTimeoutMs: 1000, stopTimeoutMs: 1000 });

test('TOPIC-ALIASES-01 optional aliases keep component schemas closed and reject unknown targets, repeated targets and grants outside the map', () => {
  assert.equal(validatePack(example()).length, 1);
  const noMap = example(); delete noMap.components[0].topicAliases;
  assert.equal(validatePack(noMap).length, 1, 'Components which need no explicit map retain the current pack contract');
  const invalid = [
    ['unknown field', component => { component.unreviewedPrivilege = true; }],
    ['empty map', component => { component.topicAliases = {}; }],
    ['array map', component => { component.topicAliases = ['selected']; }],
    ['invalid alias', component => { component.topicAliases = { 'unsafe/alias': 'selected' }; }],
    ['unknown target', component => { component.topicAliases.source = 'absent'; }],
    ['non-string target', component => { component.topicAliases.source = { name: 'selected' }; }],
    ['duplicate target', component => { component.topicAliases.extra = 'selected'; }],
    ['grant outside map', component => { component.bridges.main.subscribe = ['alternate']; }],
  ];
  for (const [label, change] of invalid) {
    const pack = example(); change(pack.components[0]);
    assert.throws(() => validatePack(pack), undefined, label);
  }
});

test('TOPIC-ALIASES-02 explicit program aliases preserve per-component names, unused topics and edited permissions independently of author defaults', () => {
  const pack = example();
  pack.components.push({ ...structuredClone(pack.components[0]), id: 'second', topicAliases: { source: 'alternate', unused: 'hidden' },
    bridges: { main: { publish: [], subscribe: ['alternate'] } } });
  const defaults = { topics: { source: 'author/initial', unused: 'author/unused' },
    bridges: { main: { publish: ['unused', 'source'], subscribe: ['source', 'unused'] } } };
  const before = structuredClone(pack);
  assert.deepEqual(deploymentTopics(pack, pack.components[0], defaults), { source: 'aliases/selected', unused: 'aliases/known-without-access' });
  assert.deepEqual(deploymentTopics(pack, pack.components[1], defaults), { source: 'aliases/alternate', unused: 'aliases/known-without-access' });
  assert.deepEqual(pack, before, 'Resolving aliases never rewrites grants or expands privileges');
  const undeclared = structuredClone(pack.components[0]); undeclared.bridges.main.publish.push('alternate');
  assert.throws(() => deploymentTopics(pack, undeclared, defaults), { code: 'DEPLOYMENT_INVALID' });
  const duplicate = structuredClone(pack.components[0]); duplicate.topicAliases.source = 'hidden';
  assert.throws(() => deploymentTopics(pack, duplicate, defaults), { code: 'DEPLOYMENT_INVALID' });
});

test('TOPIC-ALIASES-03 published schema documents an optional bounded alias map without opening component fields', async () => {
  const schema = await json(join(ROOT, 'docs/ecosystem/pack.schema.json')), component = schema.properties.components.items;
  assert.equal(schema.additionalProperties, false); assert.equal(component.additionalProperties, false);
  assert.equal(component.required.includes('topicAliases'), false);
  assert.deepEqual(component.properties.topicAliases.propertyNames, { $ref: '#/$defs/id' });
  assert.deepEqual(component.properties.topicAliases.additionalProperties, { $ref: '#/$defs/id' });
  assert.equal(component.properties.topicAliases.minProperties, 1); assert.equal(component.properties.topicAliases.maxProperties, 64);
});

async function composedFixture(app) {
  const fixture = await fixturePackage(app), source = join(fixture, 'modules/fixture');
  await save(join(source, 'deployment.json'), { format: 'world-hub.deployment/v1', title: { en: 'Aliases', zh: '别名' },
    description: { en: 'Author defaults can be explicitly edited.', zh: '作者默认值可明确修改。' },
    topics: { source: 'author/source', secondary: 'author/secondary', unused: 'author/unused' },
    bridges: { main: { publish: ['source', 'secondary'], subscribe: ['secondary', 'source'] } }, settings: [] });
  const programFile = join(source, 'program.mjs'), program = await readFile(programFile, 'utf8');
  const marker = '  const topics = [...new Set([...slot.publish, ...slot.subscribe])];';
  assert.ok(program.includes(marker));
  await writeFile(programFile, program.replace(marker, `  let registerDenied = null, publishDenied = null;
  try { await bridge.registerChannels([{ name: config.topics.unused, publish: true, subscribe: false }]); }
  catch (issue) { registerDenied = issue.code ?? issue.message; }
  try { await bridge.publishConfirmed(config.topics.unused, { attempt: 'alias-grants-no-rights' }); }
  catch (issue) { publishDenied = issue.code ?? issue.message; }
  await writeFile(join(config.stateDir, 'aliases-observed.json'), JSON.stringify({ topics: config.topics, grants: { publish: slot.publish, subscribe: slot.subscribe }, registerDenied, publishDenied }));
${marker}`));
  const input = { id: 'test.composed-aliases', version: '1.0.0', entry: 'first', modules: [
    { componentId: 'first', directory: source, topics: { source: 'selected/first', secondary: 'selected/shared', unused: 'selected/first-unused' },
      bridges: { main: { publish: ['secondary'], subscribe: ['source', 'secondary'] } } },
    { componentId: 'second', directory: source, topics: { source: 'selected/second', secondary: 'selected/shared', unused: 'selected/second-unused' },
      bridges: { main: { publish: ['secondary', 'source'], subscribe: [] } } },
  ] };
  const preview = await previewComposition(input);
  return { input, preview, created: await createComposition({ root: app.root, input, preview, environment }) };
}

test('TOPIC-ALIASES-04 composition, locking, authoring and real execution preserve alias maps without granting access to unused topics', { timeout: 45000 }, async t => {
  const app = await workspace(t), { input, preview, created } = await composedFixture(app);
  assert.equal(preview.sources.length, 1); assert.equal(preview.pack.components.length, 2);
  assert.equal(preview.pack.components[0].topicAliases.secondary, preview.pack.components[1].topicAliases.secondary);
  assert.notEqual(preview.pack.components[0].topicAliases.source, preview.pack.components[1].topicAliases.source);
  const lock = await createLock(created.directory, environment), inspected = await inspectPackage(created.directory, environment);
  assert.equal(lock.format, 'world-hub.pack-lock/v2'); assert.deepEqual(inspected.pack.components, preview.pack.components);
  const pack = structuredClone(inspected.pack); pack.id = 'test.derived-aliases';
  const derived = await derivePackage(created.directory, { ...environment, pack, destination: join(app.directory, 'derived'), redistributionAcknowledged: true });
  assert.deepEqual(derived.pack.components, inspected.pack.components);
  const imported = await importPackage(derived.directory, { ...environment, root: app.root, instanceId: 'alias-run' });
  const session = await startInstance({ root: app.root, instanceId: 'alias-run', trust: imported.digest, ...environment });
  app.trackSession(session); app.cleanups.push(() => session.close());
  for (const component of input.modules) {
    const observed = await json(join(imported.stateDir, 'programs', component.componentId, 'aliases-observed.json'));
    assert.deepEqual(observed.topics, component.topics, 'The program receives only its own explicitly chosen aliases');
    assert.deepEqual(observed.grants, Object.fromEntries(['publish', 'subscribe'].map(direction => [direction, component.bridges.main[direction].map(alias => component.topics[alias])])));
    assert.equal(observed.registerDenied, 'PUBLISH_DENIED'); assert.equal(observed.publishDenied, 'PUBLISH_DENIED');
    assert.ok(!Object.values(observed.grants).flat().includes(component.topics.unused));
  }
  app.record('explicit-aliases-survive-composition-lock-derive-and-real-runtime', { components: 2, sourceTrees: 1, unusedAliasRegistrationAndPublishDenied: true });
});

test('TOPIC-ALIASES-05 invalid maps cannot be locked, inspected or derived and do not create a destination', { timeout: 30000 }, async t => {
  const app = await workspace(t), { created } = await composedFixture(app);
  const clean = await json(join(created.directory, 'pack.json'));
  for (const [label, change] of [
    ['unknown', component => { component.topicAliases.source = 'not-in-pack'; }],
    ['duplicate', component => { component.topicAliases.source = component.topicAliases.unused; }],
    ['outside-map', component => { component.bridges.main.publish.push(clean.components[1].topicAliases.source); }],
  ]) {
    const invalid = structuredClone(clean); change(invalid.components[0]);
    await save(join(created.directory, 'pack.json'), invalid);
    await assert.rejects(createLock(created.directory, environment), undefined, label);
    await assert.rejects(inspectPackage(created.directory, environment), undefined, label);
    await save(join(created.directory, 'pack.json'), clean);
    const destination = join(app.directory, 'rejected-' + label);
    await assert.rejects(derivePackage(created.directory, { ...environment, pack: invalid, destination, redistributionAcknowledged: true }), undefined, label);
    await assert.rejects(access(destination), { code: 'ENOENT' });
  }
  app.record('invalid-alias-maps-rejected-at-authoring-boundaries', { destinationsCreated: 0 });
});
