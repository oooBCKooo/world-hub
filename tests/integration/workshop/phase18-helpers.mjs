import assert from 'node:assert/strict';
import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLock } from '../../../scripts/runtime/index.mjs';
import { hash } from '../../../scripts/runtime/paths.mjs';
import { validateArtifactBytes } from '../../../scripts/runtime/sources.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
export const saveJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

// This client also accepts an explicitly supplied HTTPS service.url/origin.
// Credentials stay in the caller's memory; it never writes them to evidence.
export async function workshopCall(service, path, body, actor, expectedStatus = 200) {
  const response = await fetch(new URL(path, service.url), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    signal: AbortSignal.timeout(20000), headers: { ...(body === undefined ? {} : { origin: service.origin, 'content-type': 'application/json' }),
      ...(actor?.cookie ? { cookie: actor.cookie } : {}), ...(actor?.csrfToken ? { 'x-csrf-token': actor.csrfToken } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(data));
  return { data, cookie: response.headers.getSetCookie()[0]?.split(';')[0], status: response.status };
}
export async function registerMember(service, admin, username, password) {
  const invite = await workshopCall(service, 'api/invitations', {}, admin, 201);
  const registered = await workshopCall(service, 'api/register', { username, password, invitation: invite.data.invitation }, null, 201);
  return { ...registered.data, cookie: registered.cookie };
}
export function launcherClient(server) {
  const call = async (path, body, expectedStatus = 200) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.timeout(20000), headers: { authorization: 'Bearer ' + server.token, 'x-csrf-token': server.csrfToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(value)); return value;
  };
  const finish = async (request, expectedState = 'succeeded') => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const row = (await call('/api/operations/' + request.operationId)).operation;
      if (row.state !== 'running') { assert.equal(row.state, expectedState, JSON.stringify(row)); return row; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Launcher operation exceeded the 90-second test deadline');
  };
  return { call, finish };
}
export async function prepareNodeScene(directory) {
  const provider = join(directory, 'author-module'), pack = join(directory, 'original-pack');
  await mkdir(provider, { recursive: true });
  await copyFile(join(repository, 'tests/integration/workshop/phase18-provider.mjs'), join(provider, 'program.mjs'));
  for (const file of ['bridge-kit.mjs', 'blob-client.mjs']) await copyFile(join(repository, 'sdk/javascript', file), join(provider, file));
  await copyFile(join(repository, 'LICENSE'), join(provider, 'LICENSE'));
  await saveJson(join(provider, 'package.json'), { imports: { '#bridge': './bridge-kit.mjs' } });
  await saveJson(join(provider, 'module.json'), { format: 'world-hub.module/v1', id: 'workshop.statistics', version: '1.0.0', license: 'MIT',
    platforms: [`${process.platform}-${process.arch}`], runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'],
    provides: [{ id: 'text.statistics', version: '1.0.0' }], requires: [],
    permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } });
  for (const name of ['source', 'desk']) await cp(join(repository, 'examples/ecosystem-pack/modules', name), join(pack, 'modules', name), { recursive: true });
  const initialProvider = join(pack, 'modules/stats'); await cp(provider, initialProvider, { recursive: true });
  const initial = await readJson(join(initialProvider, 'module.json')); initial.id = 'baseline.statistics'; await saveJson(join(initialProvider, 'module.json'), initial);
  const manifest = await readJson(join(repository, 'examples/ecosystem-pack/pack.json')); manifest.id = 'workshop.baseline'; manifest.version = '1.0.0';
  manifest.components.find(value => value.id === 'stats').module = initial.id;
  await saveJson(join(pack, 'pack.json'), manifest); await createLock(pack, { nodePath: process.execPath });
  return { provider, pack };
}

// Test transport adapter only: real HTTP responses become a local static source.
// Artifact bytes/digests are unchanged. Source URLs alone become relative paths.
// The production downloader's HTTPS and non-loopback policies remain untouched.
export async function mirrorWorkshop(service, directory) {
  await mkdir(join(directory, 'artifacts'), { recursive: true });
  const response = await fetch(new URL('index.json', service.url), { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200); const originalBytes = Buffer.from(await response.arrayBuffer()), originalIndex = JSON.parse(originalBytes);
  const entries = [];
  for (const entry of originalIndex.entries) {
    const download = await fetch(entry.source.url, { redirect: 'error', signal: AbortSignal.timeout(20000) }); assert.equal(download.status, 200);
    const bytes = Buffer.from(await download.arrayBuffer()); assert.equal(hash(bytes), entry.sha256);
    const path = `artifacts/${entry.sha256}.json`; await writeFile(join(directory, path), bytes);
    entries.push({ ...entry, source: { path } });
  }
  const index = { ...originalIndex, entries }, indexPath = join(directory, 'index.json'); await saveJson(indexPath, index);
  return { index, indexPath, upstreamIndexSha256: hash(originalBytes), upstreamArtifactBytesUnchanged: true, mirrorDirectory: dirname(indexPath) };
}

// Author review copies only already validated ordinary source files into a new
// directory. It starts no program and never overwrites an existing review tree.
export async function unpackForAuthorReview(artifact, destination) {
  const bytes = Buffer.from(JSON.stringify(artifact) + '\n'), checked = validateArtifactBytes(bytes);
  await mkdir(destination, { mode: 0o700 });
  for (const file of checked.decoded) {
    const path = join(destination, file.path); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 });
  }
  return { directory: destination, sha256: hash(bytes), startsModules: false };
}
