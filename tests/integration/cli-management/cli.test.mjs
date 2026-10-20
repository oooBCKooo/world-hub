import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { parseManagementArgs, runManagementCli } from '../../../bin/management-cli.mjs';
import { MANAGEMENT_OPERATIONS } from '../../../sdk/javascript/management-client.mjs';
import { moduleSource } from '../../helpers/module-versions-scene.mjs';
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';

const root = resolve('.'), cli = join(root, 'bin/world-hub.mjs');
const sleep = ms => new Promise(done => setTimeout(done, ms));
function captured() { let text = ''; return { write(chunk) { text += chunk; }, get text() { return text; } }; }
async function invoke(args, options = {}) {
  const stdout = captured(), stderr = captured();
  const code = await runManagementCli(args, { stdout, stderr, ...options });
  return { code, stdout: stdout.text, stderr: stderr.text };
}
async function workspace() { await mkdir('.artifacts/cli-management', { recursive: true }); return mkdtemp(resolve('.artifacts/cli-management/case-')); }

test('every catalog command routes without hardcoded command coverage and preserves opaque revision values', () => {
  for (const entry of MANAGEMENT_OPERATIONS) {
    const args = [...entry.command, ...(entry.params ?? []).map(() => 'instance')];
    if (entry.name === 'external.apply') args.push('--secrets-file', 'new-credentials.json');
    const parsed = parseManagementArgs(args);
    assert.equal(parsed.operation.name, entry.name, args.join(' '));
    assert.equal(parseManagementArgs(['manage', entry.name, ...args.slice(entry.command.length)]).operation.name, entry.name);
  }
  assert.equal(parseManagementArgs(['group', 'review', 'desk', '--expected-revision', '000abc']).fields.expectedRevision, '000abc');
  assert.equal(parseManagementArgs(['external', 'preview', '--expected-revision', '2']).fields.expectedRevision, 2);
  assert.equal(parseManagementArgs(['--hub', 'http://127.0.0.1:1234', 'message', 'get', '42']).fields.seq, 42);
});

test('catalog and family/operation help need no network and expose review requirements', async () => {
  const options = { clientFactory: () => { throw new Error('help must not use the network'); } };
  const listing = await invoke(['operations', '--json'], options);
  assert.equal(JSON.parse(listing.stdout).operations.length, MANAGEMENT_OPERATIONS.length);
  assert.equal((await invoke(['module', '--help'], options)).code, 0);
  const help = JSON.parse((await invoke(['module', 'start', '--help', '--json'], options)).stdout);
  assert.equal(help.requiresReview, true); assert.equal(help.requiresAcceptance, true);
  const subprocess = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(subprocess.status, 0); assert.equal(subprocess.stdout.trim(), JSON.parse(await readFile('package.json', 'utf8')).version);
});

test('invalid input and conflicts fail on stderr before sending any management request', async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, 'input.json'), JSON.stringify({ programId: 'other' }));
  await writeFile(join(cwd, 'broken.json'), '{private malformed content');
  await writeFile(join(cwd, 'large.json'), ' '.repeat(1024 * 1024 + 1));
  let requests = 0;
  const options = { cwd, clientFactory: () => ({ execute: async () => { requests++; } }) };
  for (const args of [
    ['module', 'stop', 'instance', '--input', 'input.json'], ['status', '--nonsense', 'yes'],
    ['status', '--input', 'broken.json'], ['status', '--input', 'large.json'],
    ['module', 'stop', 'instance', 'extra'], ['status', '--raw'],
    ['message', 'get', '9007199254740992'], ['status', '--timeout', '0'],
    ['external', 'apply', '--accept'], ['status', '--secrets-file', 'wrong.json'],
    ['module', 'stop', 'instance', '--json', '--json'],
  ]) {
    const result = await invoke([...args, ...(args.includes('--json') ? [] : ['--json'])], options);
    assert.equal(result.code, 2, args.join(' ')); assert.equal(result.stdout, '');
    assert.ok(JSON.parse(result.stderr).error.code); assert.ok(!result.stderr.includes('private malformed content'));
  }
  assert.equal(requests, 0);
});

test('JSON stdin combines structured fields with typed flags without changing target identities', async () => {
  let request;
  const result = await invoke(['module', 'configuration', 'preview', 'desk', '--input', '-', '--expected-revision', 'a01', '--json'], {
    stdin: Readable.from(['\uFEFF{"settings":{"title":"我的模块"}}']),
    clientFactory: () => ({ execute: async (operation, input) => { request = { operation, input }; return { reviewed: true }; } }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(request, { operation: 'programs.configuration.preview', input: { settings: { title: '我的模块' }, expectedRevision: 'a01', programId: 'desk' } });
  assert.equal(result.stderr, ''); assert.deepEqual(JSON.parse(result.stdout), { reviewed: true });
});

test('external credentials go only to a new private file and existing files prevent sending the mutation', async () => {
  const cwd = await workspace(), path = join(cwd, 'private.json'); let requests = 0;
  const options = { cwd, clientFactory: () => ({ execute: async (name, input, trusted) => {
    requests++; assert.equal(name, 'external.apply'); assert.equal(trusted.includeSecrets, true);
    return { connection: { bridges: [{ token: 'private-issued-token', slot: 'main' }] }, csrfToken: 'never-keep-csrf' };
  } }) };
  const args = ['external', 'apply', '--review-id', 'review', '--accept', '--secrets-file', path, '--json'];
  const result = await invoke(args, options);
  assert.equal(result.code, 0, result.stderr); assert.ok(!result.stdout.includes('private-issued-token'));
  assert.ok((await readFile(path, 'utf8')).includes('private-issued-token'));
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  const again = await invoke(args, options); assert.equal(again.code, 2); assert.equal(requests, 1);
});

test('raw retained JSON is emitted byte-for-byte and unknown write outcomes are never retried', async () => {
  const rawJSON = '{"body":{"big":9007199254740993,"escaped":"\\u4e2d","n":1e400}}';
  const raw = await invoke(['message', 'get', '1', '--raw'], { clientFactory: () => ({ execute: async () => ({ rawJSON }) }) });
  assert.equal(raw.stdout, rawJSON + '\n');
  let writes = 0;
  const result = await invoke(['module', 'stop', 'desk', '--json'], { clientFactory: () => ({ execute: async () => {
    writes++; throw Object.assign(new Error('Write outcome unknown'), { code: 'MANAGEMENT_TIMEOUT', outcome: 'unknown', retrySafe: false });
  } }) });
  assert.equal(result.code, 1); assert.equal(writes, 1); assert.equal(JSON.parse(result.stderr).error.outcome, 'unknown');
});

test('real CLI controls independent Hub, preserves exact retained messages and reviews shared group starts/stops', { timeout: 55000 }, async t => {
  const cwd = await workspace(), config = join(cwd, 'hub.json'); let output = '', diagnostics = '', child, closed; const bridges = [];
  await writeFile(config, JSON.stringify({ transport: { host: '127.0.0.1', port: 0 }, acl: { bridges: { source: { token: 'source-test-private', allow: { publish: ['cli/retained'], subscribe: [] } } } } }));
  child = fork(cli, ['start', '--config', config, '--data-dir', join(cwd, 'data'), '--port', '0'], { cwd, silent: true, windowsHide: true });
  closed = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { diagnostics += chunk; });
  t.after(async () => {
    await Promise.all(bridges.map(bridge => bridge.close()));
    if (child.exitCode === null && child.signalCode === null) {
      child.send({ type: 'stop' });
      if (!await Promise.race([closed.then(() => true), sleep(8000).then(() => false)])) { child.kill(); await closed; }
    }
  });
  let ready; const deadline = Date.now() + 15000;
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    for (const line of output.split(/\r?\n/u)) { try { const row = JSON.parse(line); if (row.event === 'ready') ready = row; } catch {} }
    if (!ready) await sleep(20);
  }
  assert.ok(ready, diagnostics); const url = new URL(ready.statusUrl).origin;
  const execute = (args, expectedCode = 0) => {
    const result = spawnSync(process.execPath, [cli, '--hub', url, ...args, '--json'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, expectedCode, result.stderr); return JSON.parse(expectedCode ? result.stderr : result.stdout);
  };
  assert.ok(execute(['status']).storage); assert.equal(execute(['state']).csrfToken, undefined);
  const source = await moduleSource({ root: cwd }, 'cli-managed', '1.0.0');
  const registration = execute(['artifact', 'preview', '--path', source.directory, '--program-id', 'desk']);
  assert.equal(execute(['artifact', 'apply', '--review-id', registration.reviewId], 2).error.code, 'MANAGEMENT_ACCEPTANCE_REQUIRED');
  await writeFile(join(cwd, 'install.json'), JSON.stringify({ kind: 'module' }));
  execute(['artifact', 'apply', '--review-id', registration.reviewId, '--accept', '--input', 'install.json']);
  assert.equal(execute(['module', 'list']).programs[0].state, 'stopped');
  const review = execute(['module', 'review', 'desk']);
  execute(['module', 'start', 'desk', '--review-id', review.reviewId, '--accept']);
  assert.equal(execute(['module', 'list']).programs[0].state, 'running');
  execute(['module', 'stop', 'desk']);
  await writeFile(join(cwd, 'group.json'), JSON.stringify({ group: { id: 'desk-group', title: 'CLI desk', memberProgramIds: ['desk'], startupPlan: { members: [{ programId: 'desk', enabled: true, after: [] }], onFailure: 'continue-independent' } } }));
  execute(['group', 'save', '--input', 'group.json']);
  const group = execute(['group', 'list']).groups.find(group => group.id === 'desk-group');
  assert.ok(group?.revision);
  await writeFile(join(cwd, 'shared-group.json'), JSON.stringify({ group: { id: 'shared-group', title: 'Shared reference', memberProgramIds: ['desk'] } }));
  execute(['group', 'save', '--input', 'shared-group.json']);
  const groupReview = execute(['group', 'review', 'desk-group', '--expected-revision', group.revision]);
  assert.equal(execute(['group', 'start', 'shared-group', '--review-id', groupReview.reviewId, '--accept'], 1).error.code, 'GROUP_REVIEW_TARGET_MISMATCH');
  assert.equal(execute(['module', 'list']).programs[0].state, 'stopped');
  execute(['group', 'start', 'desk-group', '--review-id', groupReview.reviewId, '--accept']);
  assert.equal(execute(['module', 'list']).programs[0].state, 'running');
  const stopReview = execute(['group', 'stop-preview', 'desk-group', '--expected-revision', group.revision]);
  assert.ok(stopReview.review.programs[0].sharedWithGroups.some(group => group.id === 'shared-group'));
  assert.equal(execute(['group', 'stop', 'shared-group', '--review-id', stopReview.reviewId, '--accept', '--program-ids', 'desk'], 1).error.code, 'GROUP_REVIEW_TARGET_MISMATCH');
  execute(['group', 'stop', 'desk-group', '--review-id', stopReview.reviewId, '--accept', '--program-ids', 'desk']);
  assert.equal(execute(['module', 'list']).programs[0].state, 'stopped');
  execute(['group', 'dissolve', 'desk-group', '--expected-revision', group.revision]);
  const dissolved = execute(['group', 'list']);
  assert.ok(!dissolved.groups.some(group => group.id === 'desk-group')); assert.equal(dissolved.dissolvedGroups[0].id, 'desk-group');
  assert.equal(execute(['module', 'list']).programs.length, 1);
  execute(['group', 'restore', 'desk-group']);
  assert.ok(execute(['group', 'list']).groups.some(group => group.id === 'desk-group'));
  const bridge = new Bridge({ url: ready.endpoint, bridgeId: 'source', token: 'source-test-private' }); bridges.push(bridge);
  await bridge.connect(); await bridge.registerChannels([{ name: 'cli/retained', publish: true }]);
  const record = await bridge.publishConfirmed('cli/retained', { hello: '世界', token: 'opaque-business-value' });
  const raw = spawnSync(process.execPath, [cli, 'message', 'get', String(record.seq), '--hub', url, '--raw'], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(raw.status, 0, raw.stderr); assert.equal(JSON.parse(raw.stdout).record.body.token, 'opaque-business-value');
  const external = execute(['external', 'list']);
  await writeFile(join(cwd, 'admission.json'), JSON.stringify({ bridges: [{ slot: 'main', publish: ['cli/retained'], subscribe: [] }] }));
  const admission = execute(['external', 'preview', '--action', 'admit', '--program-id', 'outside-cli', '--expected-run-id', external.runId, '--expected-revision', String(external.revision), '--input', 'admission.json']);
  const issued = execute(['external', 'apply', '--review-id', admission.reviewId, '--accept', '--secrets-file', 'outside-private.json']);
  const privateResult = JSON.parse(await readFile(join(cwd, 'outside-private.json'), 'utf8'));
  const slot = privateResult.connection.bridges[0];
  assert.ok(slot.token); assert.ok(!JSON.stringify(issued).includes(slot.token));
  const outside = new Bridge({ url: slot.endpoint, bridgeId: slot.bridgeId, credential: slot.credential, token: slot.token }); bridges.push(outside);
  await outside.connect(); await outside.registerChannels([{ name: 'cli/retained', publish: true }]);
  assert.ok((await outside.publishConfirmed('cli/retained', { sender: 'outside-cli' })).seq);
  const current = execute(['external', 'list']);
  const revoke = execute(['external', 'preview', '--action', 'revoke', '--program-id', 'outside-cli', '--expected-run-id', current.runId, '--expected-revision', String(current.revision)]);
  execute(['external', 'apply', '--review-id', revoke.reviewId, '--accept', '--secrets-file', 'revoke-private.json']);
  assert.equal(execute(['external', 'list']).programs.length, 0);
});
