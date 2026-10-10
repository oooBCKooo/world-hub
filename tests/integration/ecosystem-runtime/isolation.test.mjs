import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace, save } from '../launcher/helpers.mjs';
import { planIsolation, probeIsolation, ownIsolatedProcess, isolationSeccomp } from '../../../scripts/runtime/isolation.mjs';
import { channelChunks, collectChannelChunk } from '../../../scripts/runtime/isolation-channel.mjs';

async function options(t) {
  const app = await workspace(t), sourceDirectory = join(app.directory, 'module'), stateDirectory = join(app.directory, 'state'), configPath = join(app.directory, 'config.json');
  await mkdir(sourceDirectory); await mkdir(stateDirectory); await writeFile(join(sourceDirectory, 'program.mjs'), 'throw new Error("must not run on the host");');
  await save(configPath, { format: 'world-hub.run/v1', bridges: [{ endpoint: 'ws://127.0.0.1:65534/bridge', bridgeId: 'fixture', credential: 'fixture', token: 'fixture' }] });
  return { app, dockerPath: process.execPath, endpoint: process.platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock', image: 'node@sha256:' + 'a'.repeat(64), runtime: 'node', sourceDirectory, stateDirectory, configPath, adapterDirectory: join(app.directory, 'adapter'), entry: 'program.mjs' };
}
test('ISOLATION-01 static planning binds executable, image, source, config and adapter without executing modules', async t => {
  const input = await options(t), plan = await planIsolation(input);
  assert.equal(plan.startsPrograms, false); assert.equal(plan.sandbox, false); assert.equal(plan.network, 'none');
  assert.equal(plan.filesystem.otherHostFiles, 'not-mounted'); assert.match(plan.digest, /^[a-f0-9]{64}$/);
  await writeFile(join(input.sourceDirectory, 'program.mjs'), 'throw new Error("different reviewed content");');
  assert.notEqual((await planIsolation(input)).digest, plan.digest);
  await assert.rejects(ownIsolatedProcess(plan, { trust: plan.digest }), { code: 'ISOLATION_REVIEW_CHANGED' });
  await assert.rejects(ownIsolatedProcess(plan, {}), { code: 'ISOLATION_REVIEW_REQUIRED' });
  input.app.record('static-only-digest-review', { digest: plan.digest, programsStarted: false });
});
test('ISOLATION-02 provider and unsupported program shapes fail closed without trusted-local fallback', async t => {
  const input = await options(t), plan = await planIsolation(input);
  const probe = await probeIsolation(input); assert.equal(probe.available, false); assert.equal(probe.startsContainers, false); assert.equal(probe.installsProvider, false);
  await assert.rejects(ownIsolatedProcess(plan, { trust: plan.digest }), { code: 'ISOLATION_PROVIDER_UNAVAILABLE' });
  for (const change of [{ image: 'node:latest' }, { runtime: 'python' }, { network: 'bridge' }, { endpoint: 'tcp://127.0.0.1:2375' }, { entryUrl: 'http://127.0.0.1:1234' }, { limits: { user: 0 } }]) await assert.rejects(planIsolation({ ...input, ...change }), /required|profile|local|Invalid|cannot/);
  await assert.rejects(planIsolation({ ...input, stateDirectory: input.sourceDirectory }), { code: 'ISOLATION_MOUNT_OVERLAP' });
  input.app.record('provider-unavailable-no-fallback', { probe });
});
test('ISOLATION-03 subprocess denial is a seccomp rule, not a PID or manifest claim; opaque bridge frames stay bounded', () => {
  const seccomp = isolationSeccomp(); assert.equal(seccomp.defaultAction, 'SCMP_ACT_ERRNO');
  assert.equal(seccomp.syscalls.flatMap(row => row.names).some(name => ['fork', 'vfork'].includes(name)), false);
  const clone = seccomp.syscalls.find(row => row.names.includes('clone')); assert.deepEqual(clone.args, [{ index: 0, value: 65536, valueTwo: 65536, op: 'SCMP_CMP_MASKED_EQ' }]);
  const text = JSON.stringify({ body: '🌍'.repeat(200000) }); let pending = null, received;
  for (const chunk of channelChunks('fixture', text)) { assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < 131072); const result = collectChannelChunk(pending, chunk); pending = result.pending; received = result.text; }
  assert.equal(received, text);
  assert.throws(() => collectChannelChunk(null, { operation: 'chunk', index: 1, final: false, text: 'x' }), /order/);
  assert.throws(() => channelChunks('fixture', 'x'.repeat(4 * 1024 * 1024 + 1)), /exceeds/);
});
