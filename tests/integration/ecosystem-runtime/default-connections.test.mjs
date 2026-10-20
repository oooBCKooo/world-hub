import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeployment } from '../../../scripts/runtime/deployment.mjs';
import { resolveDefaultConnections } from '../../../scripts/runtime/default-connections.mjs';

const read = { id: 'text.read', version: '1.0.0' };
const manifest = { id: 'consumer', version: '1.0.0', bridges: ['main'], requires: [read] };
const clone = value => structuredClone(value);
function connection(overrides = {}) {
  return { id: 'text-source', provider: { moduleId: 'example.source', version: '2.0.0' }, contracts: [clone(read)],
    topics: { request: 'input', reply: 'output' }, ...overrides };
}
function deployment(connections = [connection()]) {
  return { format: 'world-hub.deployment/v1', title: { en: 'Consumer' }, description: { en: 'Default peer connection' },
    topics: { request: 'consumer/default/request', reply: 'consumer/default/reply' },
    bridges: { main: { publish: ['request'], subscribe: ['reply'] } }, settings: [], connections };
}
function provider(overrides = {}) {
  return { programId: 'installed-source', module: { id: 'example.source', version: '2.0.0' }, provides: [clone(read)],
    topics: { input: 'local/source/request', output: 'local/source/reply' },
    bridges: { main: { publish: ['output'], subscribe: ['input'] } }, state: 'stopped', ...overrides };
}
function resolve(overrides = {}) {
  return resolveDefaultConnections({ manifest, deployment: deployment(), programs: [provider()], ...overrides });
}
function invalid(action, code = 'DEFAULT_CONNECTION_INVALID') { assert.throws(action, issue => issue.code === code); }
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }

test('one exact compatible installed module resolves capability and topic defaults without widening permissions', () => {
  const source = provider(), settings = deployment();
  const result = resolve({ deployment: settings, programId: 'consumer-instance', programs: [
    provider({ programId: 'wrong-module', module: { id: 'another.source', version: '2.0.0' } }),
    provider({ programId: 'wrong-version', module: { id: 'example.source', version: '2.0.1' } }),
    provider({ programId: 'missing-contract', provides: [] }),
    provider({ programId: 'consumer-instance' }), source
  ] });
  assert.equal(result.selectionRequired, false);
  assert.equal(result.connections[0].status, 'resolved');
  assert.equal(result.connections[0].providerId, source.programId);
  assert.deepEqual(result.connections[0].candidates, [{ programId: source.programId, module: source.module, state: 'stopped' }]);
  assert.deepEqual(result.topics, { request: source.topics.input, reply: source.topics.output });
  assert.deepEqual(result.bindings, [{ providerId: source.programId, contract: read }]);
  assert.deepEqual(settings.bridges, { main: { publish: ['request'], subscribe: ['reply'] } });
});

test('missing exact provider remains pending and preserves download identity and existing topic defaults', () => {
  const defaults = deployment(), result = resolve({ deployment: defaults, programs: [] });
  assert.equal(result.selectionRequired, true);
  assert.equal(result.connections[0].status, 'missing');
  assert.deepEqual(result.connections[0].provider, { moduleId: 'example.source', version: '2.0.0' });
  assert.deepEqual(result.connections[0].candidates, []);
  assert.ok(!Object.hasOwn(result.connections[0], 'providerId'));
  assert.deepEqual(result.bindings, []);
  assert.deepEqual(result.topics, defaults.topics);
});

test('multiple instances require an explicit candidate choice regardless of running state or ordering', () => {
  const first = provider({ programId: 'first', state: 'stopped' }), second = provider({ programId: 'second', state: 'running', topics: { input: 'second/request', output: 'second/reply' } });
  for (const programs of [[first, second], [second, first]]) {
    const pending = resolve({ programs });
    assert.equal(pending.selectionRequired, true);
    assert.equal(pending.connections[0].status, 'ambiguous');
    assert.ok(!Object.hasOwn(pending.connections[0], 'providerId'));
    assert.deepEqual(pending.bindings, []);
    const selected = resolve({ programs, selections: { 'text-source': 'second' } });
    assert.equal(selected.selectionRequired, false);
    assert.equal(selected.connections[0].providerId, 'second');
    assert.deepEqual(selected.topics, { request: 'second/request', reply: 'second/reply' });
  }
});

test('unknown, incompatible, absent, undefined and undeclared explicit selections are rejected', () => {
  invalid(() => resolve({ selections: { other: 'installed-source' } }));
  invalid(() => resolve({ selections: { 'text-source': 'missing' } }));
  invalid(() => resolve({ selections: { 'text-source': undefined } }));
  invalid(() => resolve({ selections: null }));
  invalid(() => resolve({ programs: [], selections: { 'text-source': 'installed-source' } }));
  invalid(() => resolve({ programs: [provider({ module: { id: 'example.source', version: '3.0.0' } })], selections: { 'text-source': 'installed-source' } }));
});

test('every topic mapping needs an existing provider alias and complementary bridge direction', () => {
  const excluded = [
    provider({ topics: { input: 'provider/request' } }),
    provider({ bridges: { main: { publish: ['input', 'output'], subscribe: [] } } }),
    provider({ bridges: { main: { publish: [], subscribe: ['input', 'output'] } } }),
    provider({ topics: { input: 'provider/+', output: 'provider/reply' } })
  ];
  for (const row of excluded) assert.equal(resolve({ programs: [row] }).connections[0].status, 'missing');
  const unused = deployment(); unused.bridges.main.subscribe = [];
  assert.equal(resolve({ deployment: unused }).connections[0].status, 'missing');
  const separateBridges = provider({ bridges: { input: { publish: [], subscribe: ['input'] }, output: { publish: ['output'], subscribe: [] } } });
  assert.equal(resolve({ programs: [separateBridges] }).connections[0].status, 'resolved');
});

test('topic-only connections do not invent required capabilities or widen ACLs', () => {
  const defaults = deployment([connection({ contracts: [], topics: { reply: 'output' } })]);
  const result = resolve({ manifest: { ...manifest, requires: [] }, deployment: defaults, programs: [provider({ provides: [] })] });
  assert.equal(result.selectionRequired, false);
  assert.deepEqual(result.bindings, []);
  assert.deepEqual(result.topics, { request: defaults.topics.request, reply: 'local/source/reply' });
  assert.deepEqual(defaults.bridges.main, { publish: ['request'], subscribe: ['reply'] });
});

test('explicit topic choices cannot silently conflict with a resolved dedicated connection', () => {
  invalid(() => resolve({ topics: { request: 'other/request', reply: 'other/reply' } }));
  invalid(() => resolve({ topics: { request: 'local/source/request' } }));
  invalid(() => resolve({ topics: { request: 'x/+', reply: 'x/reply' } }));
  const explicit = { request: 'local/source/request', reply: 'local/source/reply' };
  assert.deepEqual(resolve({ topics: explicit }).topics, explicit);
  invalid(() => resolve({ programs: [], topics: { request: 'local/source/request' } }));
});

test('explicit capability bindings are merged once and conflicting dedicated providers are rejected', () => {
  const binding = { providerId: 'installed-source', contract: read };
  assert.deepEqual(resolve({ bindings: [binding, clone(binding)] }).bindings, [binding]);
  invalid(() => resolve({ bindings: [{ providerId: 'another-source', contract: read }] }));
  invalid(() => resolve({ bindings: [{ providerId: 'installed-source', contract: { id: 'not-required', version: '1.0.0' } }] }));
  invalid(() => resolve({ bindings: [{ providerId: 'installed-source', contract: read, extra: true }] }));
  invalid(() => resolve({ bindings: Array.from({ length: 33 }, () => clone(binding)) }));
});

test('two dedicated declarations cannot silently bind the same capability to different providers', () => {
  const defaults = deployment([
    connection({ id: 'first', topics: { request: 'input' } }),
    connection({ id: 'second', provider: { moduleId: 'example.other', version: '1.0.0' }, topics: { reply: 'output' } })
  ]);
  const other = provider({ programId: 'other', module: { id: 'example.other', version: '1.0.0' } });
  invalid(() => resolve({ deployment: defaults, programs: [provider(), other] }));
  defaults.connections[1].provider = { ...defaults.connections[0].provider };
  const same = resolve({ deployment: defaults });
  assert.equal(same.connections.length, 2);
  assert.equal(same.bindings.length, 1);
});

test('resolver neither mutates inputs nor exposes installed internal details through candidate rows', () => {
  const input = freeze({ manifest: clone(manifest), deployment: deployment(), programs: [provider({ token: 'private-not-public', nested: { untouched: true } })],
    selections: {}, bindings: [{ providerId: 'installed-source', contract: clone(read) }] });
  const before = JSON.stringify(input), result = resolveDefaultConnections(input);
  assert.equal(JSON.stringify(input), before);
  result.topics.request = 'changed/topic'; result.bindings[0].contract.id = 'changed'; result.connections[0].provider.moduleId = 'changed';
  result.connections[0].candidates[0].module.id = 'changed';
  assert.equal(JSON.stringify(input), before);
  assert.ok(!JSON.stringify(result).includes('private-not-public'));
});

test('deployment accepts absent or empty default connections and validates exact contract-only recipes', () => {
  const absent = deployment(); delete absent.connections;
  assert.equal(validateDeployment(absent, manifest), absent);
  assert.equal(validateDeployment(deployment([]), manifest).connections.length, 0);
  const contractOnly = deployment([connection({ topics: {} })]);
  assert.equal(validateDeployment(contractOnly, manifest), contractOnly);
  assert.equal(resolve({ deployment: contractOnly }).connections[0].status, 'resolved');
});

test('deployment rejects incomplete, duplicate, non-exact, undeclared or unsupported connection fields', () => {
  const failures = [
    null,
    Array.from({ length: 33 }, (_, index) => connection({ id: `connection-${index}`, topics: {} })),
    [connection({ id: 7 })],
    [connection({ extra: true })],
    [connection({ provider: { moduleId: 'example.source', version: '^2.0.0' } })],
    [connection({ provider: { moduleId: 7, version: '2.0.0' } })],
    [connection({ provider: { moduleId: 'example.source', version: '2.0.0', extra: true } })],
    [connection({ contracts: [] , topics: {} })],
    [connection({ contracts: [clone(read), clone(read)] })],
    [connection({ contracts: [{ id: 'text.other', version: '1.0.0' }] })],
    [connection({ contracts: [{ ...read, extra: true }] })],
    [connection({ topics: { missing: 'input' } })],
    [connection({ topics: { request: 7 } })],
    [connection({ topics: { request: 'not/an/alias' } })],
    [connection(), connection()],
    [connection(), connection({ id: 'another' })]
  ];
  for (const connections of failures) invalid(() => validateDeployment(deployment(connections), manifest), 'DEPLOYMENT_INVALID');
  const missing = connection(); delete missing.contracts;
  invalid(() => validateDeployment(deployment([missing]), manifest), 'DEPLOYMENT_INVALID');
  invalid(() => resolve({ deployment: deployment(null) }), 'DEPLOYMENT_INVALID');
});

test('duplicate installed candidate IDs cannot accidentally resolve to a registry-order dependent target', () => {
  invalid(() => resolve({ programs: [provider(), provider()] }));
});
