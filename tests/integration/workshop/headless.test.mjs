import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createWorkshopServer } from '../../../tools/workshop/server.mjs';

test('Workshop runs with only APIs and optionally mounts a separate explicitly supplied static directory', async t => {
  const base = await mkdtemp(join(tmpdir(), 'world-hub-headless-workshop-'));
  const services = [];
  t.after(async () => {
    for (const service of services) await service.close();
    assert.equal(dirname(resolve(base)), resolve(tmpdir()));
    await rm(base, { recursive: true });
  });
  const options = root => ({ root, baseURL: 'http://127.0.0.1:0/workshop', port: 0, allowInsecureLoopback: true, secureCookie: false });
  const api = await createWorkshopServer(options(join(base, 'api'))); services.push(api);
  assert.equal((await (await fetch(api.url)).json()).interface, 'api');
  assert.equal((await fetch(new URL('health', api.url))).status, 200);
  assert.equal((await fetch(new URL('api/catalog', api.url))).status, 200);
  assert.equal((await fetch(new URL('app.mjs', api.url))).status, 404);
  const assets = join(base, 'external-ui'); await mkdir(assets);
  const page = '<!doctype html><title>External UI owned by a separate project</title>';
  await writeFile(join(assets, 'index.html'), page);
  await writeFile(join(assets, 'app.mjs'), '// external static code\n');
  await writeFile(join(base, 'private.json'), 'not public');
  const mounted = await createWorkshopServer({ ...options(join(base, 'mounted')), uiRoot: assets }); services.push(mounted);
  assert.equal(await (await fetch(mounted.url)).text(), page);
  const script = await fetch(new URL('app.mjs', mounted.url)); assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(new URL('private.json', mounted.url))).status, 404);
  assert.equal((await fetch(new URL('..%2fprivate.json', mounted.url))).status, 400);
  await assert.rejects(createWorkshopServer({ ...options(join(base, 'invalid')), uiRoot: './implicit-ui' }), /absolute directory/);
});
