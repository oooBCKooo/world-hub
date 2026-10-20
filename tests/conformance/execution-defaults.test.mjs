import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateExecutionDefaults, initialExecutionPolicy } from '../../scripts/runtime/execution-defaults.mjs';
import { validateDeployment } from '../../scripts/runtime/deployment.mjs';

const deployment = executionDefaults => ({
  format: 'world-hub.deployment/v1', title: { en: 'Lifecycle example' }, description: { en: 'Author defaults' },
  topics: { request: 'example/request' }, bridges: { main: { publish: [], subscribe: ['request'] } }, settings: [],
  ...(executionDefaults === undefined ? {} : { executionDefaults }),
});
const invalid = value => assert.throws(() => validateExecutionDefaults(value), { code: 'DEPLOYMENT_INVALID' });

test('author execution defaults: explicit modes normalize a missing timeout without mutating the declaration', () => {
  const authored = Object.freeze({ mode: 'on-demand' });
  assert.deepEqual(validateExecutionDefaults(authored), { mode: 'on-demand', idleTimeoutMs: 60000 });
  assert.deepEqual(authored, { mode: 'on-demand' });
  for (const mode of ['resident', 'on-demand']) for (const idleTimeoutMs of [1000, 60000, 86400000]) {
    assert.deepEqual(validateExecutionDefaults({ mode, idleTimeoutMs }), { mode, idleTimeoutMs });
  }
  const own = Object.assign(Object.create(null), { mode: 'resident' });
  assert.deepEqual(validateExecutionDefaults(own), { mode: 'resident', idleTimeoutMs: 60000 });
});

test('author execution defaults: rejects malformed shapes, missing modes, unknown fields and caller grants', () => {
  for (const value of [undefined, null, true, 1, 'on-demand', [], {}, new Date(), new String('resident'),
    Object.create({ mode: 'resident' }), { mode: 'automatic' }, { mode: null }, { mode: 'Resident' },
    { mode: 'resident', allowedCallers: [] }, { mode: 'on-demand', allowedCallers: ['caller'] },
    { mode: 'resident', autoStart: true }, { mode: 'resident', [Symbol('hidden')]: true }]) invalid(value);
  let read = false;
  invalid(Object.defineProperty({}, 'mode', { enumerable: true, get() { read = true; return 'resident'; } }));
  assert.equal(read, false);
  invalid(Object.defineProperty({ mode: 'resident' }, 'idleTimeoutMs', { get() { throw new Error('must not execute'); } }));
});

test('author execution defaults: rejects every invalid timeout instead of silently falling back', () => {
  for (const idleTimeoutMs of [undefined, null, false, '60000', 0, 999, 86400001, -1000, 1000.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER]) {
    invalid({ mode: 'on-demand', idleTimeoutMs });
  }
});

test('author execution defaults: initial policies apply local override before deployment defaults and never grant callers', () => {
  const declared = { mode: 'on-demand', idleTimeoutMs: 3000 };
  assert.deepEqual(initialExecutionPolicy(), { mode: 'resident', idleTimeoutMs: 60000, allowedCallers: [] });
  assert.deepEqual(initialExecutionPolicy(deployment(declared)), { ...declared, allowedCallers: [] });
  assert.deepEqual(initialExecutionPolicy(deployment(declared), { mode: 'resident' }), { mode: 'resident', idleTimeoutMs: 60000, allowedCallers: [] });
  const first = initialExecutionPolicy(deployment(declared));
  first.allowedCallers.push('caller'); first.mode = 'resident';
  assert.deepEqual(initialExecutionPolicy(deployment(declared)), { ...declared, allowedCallers: [] });
  assert.deepEqual(declared, { mode: 'on-demand', idleTimeoutMs: 3000 });
  assert.throws(() => initialExecutionPolicy(deployment(declared), null), { code: 'DEPLOYMENT_INVALID' });
  assert.throws(() => initialExecutionPolicy({ executionDefaults: undefined }), { code: 'DEPLOYMENT_INVALID' });
  assert.throws(() => initialExecutionPolicy(deployment(declared), { ...declared, allowedCallers: ['caller'] }), { code: 'DEPLOYMENT_INVALID' });
});

test('author execution defaults: deployment validation accepts only the optional public default declaration', () => {
  const absent = deployment(); assert.strictEqual(validateDeployment(absent), absent);
  const supplied = deployment({ mode: 'on-demand' });
  assert.strictEqual(validateDeployment(supplied), supplied);
  assert.deepEqual(supplied.executionDefaults, { mode: 'on-demand' });
  for (const executionDefaults of [null, {}, [], { mode: 'on-demand', allowedCallers: [] }, { mode: 'on-demand', idleTimeoutMs: 999 }]) {
    assert.throws(() => validateDeployment({ ...absent, executionDefaults }), { code: 'DEPLOYMENT_INVALID' });
  }
  assert.throws(() => validateDeployment({ ...absent, executionPolicy: { mode: 'resident', idleTimeoutMs: 60000, allowedCallers: [] } }), { code: 'DEPLOYMENT_INVALID' });
});

test('author execution defaults: deployment schema closes the contract without any caller authorization property', async () => {
  const schema = JSON.parse(await readFile(new URL('../../docs/ecosystem/deployment.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.executionDefaults.$ref, '#/$defs/executionDefaults');
  const defaults = schema.$defs.executionDefaults;
  assert.equal(defaults.additionalProperties, false);
  assert.deepEqual(defaults.required, ['mode']);
  assert.deepEqual(Object.keys(defaults.properties).sort(), ['idleTimeoutMs', 'mode']);
  assert.deepEqual(defaults.properties.mode.enum, ['resident', 'on-demand']);
  assert.deepEqual(defaults.properties.idleTimeoutMs, { type: 'integer', minimum: 1000, maximum: 86400000, default: 60000 });
});
