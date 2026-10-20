import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagementClient } from '../../../sdk/javascript/management-client.mjs';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';
import { moduleSource } from '../../helpers/module-versions-scene.mjs';

const rootDirectory = fileURLToPath(new URL('../../../', import.meta.url));
const sleep = ms => new Promise(done => setTimeout(done, ms));

test('shared client controls a real independent headless Hub and an actual bridged module with explicit review boundaries', { timeout: 40000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'world-hub-management-client-'));
  const config = join(root, 'hub.json'); let child, closed, output = '', errors = ''; const bridges = [];
  t.after(async () => {
    await Promise.all(bridges.map(bridge => bridge.close()));
    if (child?.exitCode === null && child?.signalCode === null) {
      child.send({ type: 'stop' });
      if (!await Promise.race([closed.then(() => true), sleep(7000).then(() => false)])) { child.kill(); await closed; }
    }
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.match(basename(root), /^world-hub-management-client-/);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(config, JSON.stringify({ transport: { host: '127.0.0.1', port: 0 }, acl: { bridges: { source: { token: 'source-private-token', allow: { publish: ['client/test'], subscribe: [] } } } } }));
  child = fork(join(rootDirectory, 'bin/world-hub.mjs'), ['--config', config, '--data-dir', join(root, 'data'), '--port', '0'], { cwd: root, silent: true, windowsHide: true });
  closed = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { errors += bytes; });
  let ready; const deadline = Date.now() + 10000;
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    for (const line of output.split(/\r?\n/)) { try { const value = JSON.parse(line); if (value.event === 'ready') ready = value; } catch {} }
    if (!ready) await sleep(20);
  }
  assert.ok(ready, errors);
  const client = new ManagementClient({ url: new URL(ready.statusUrl).origin });
  assert.ok((await client.execute('hub.status')).storage);
  assert.equal('csrfToken' in await client.execute('hub.state'), false);
  await client.execute('annotations.save', { key: 'source', bridgeName: 'Independent source', programs: [{ id: 'outside', name: 'Outside program' }] });
  assert.equal((await client.execute('hub.state')).bridges.find(row => row.key === 'source').label, 'Independent source');
  const bridge = new Bridge({ url: ready.endpoint, bridgeId: 'source', token: 'source-private-token' }); bridges.push(bridge);
  await bridge.connect(); await bridge.registerChannels([{ name: 'client/test', publish: true }]);
  const published = await bridge.publishConfirmed('client/test', { token: 'business-token-is-not-a-management-secret', value: 'hello' });
  const message = await client.execute('messages.get', { seq: published.seq });
  assert.equal(message.record.body.token, 'business-token-is-not-a-management-secret'); assert.match(message.rawJSON, /business-token/);
  await client.execute('bridges.control', { key: 'source', action: 'pause' });
  assert.equal((await client.execute('hub.state')).bridges.find(row => row.key === 'source').paused, true);
  await client.execute('bridges.control', { key: 'source', action: 'resume' });
  const source = await moduleSource({ root }, 'cli', '1.0.0');
  const registration = await client.execute('artifacts.preview', { path: source.directory, programId: 'demo' });
  await assert.rejects(client.execute('artifacts.apply', { kind: 'module', reviewId: registration.reviewId }), { code: 'MANAGEMENT_ACCEPTANCE_REQUIRED' });
  await client.execute('artifacts.apply', { kind: 'module', reviewId: registration.reviewId, accepted: true });
  assert.equal((await client.execute('programs.list')).programs[0].state, 'stopped');
  const execution = await client.execute('programs.review', { programId: 'demo' });
  await client.execute('programs.start', { programId: 'demo', reviewId: execution.reviewId, accepted: true });
  assert.equal((await client.execute('programs.list')).programs[0].state, 'running');
  await client.execute('programs.stop', { programId: 'demo' });
  assert.equal((await client.execute('programs.list')).programs[0].state, 'stopped');
  const cleanup = await client.execute('resources.cleanup.preview', { keepProgramIds: ['demo'] });
  assert.ok(cleanup.reviewId);
  assert.ok((await client.execute('paths.known')).roots || (await client.execute('paths.known')).known || (await client.execute('paths.known')));
  assert.equal((await client.execute('resources.list')).format, 'world-hub.resource-state/v1');
  await assert.rejects(client.execute('programs.logs', { programId: 'missing' }), error => error.status >= 400 && !!error.code);
});
