import test from 'node:test';

import assert from 'node:assert/strict';

import { artifactConfiguration } from '../../../tools/workshop/artifact-configuration.mjs';

import { mkdir, mkdtemp, readFile } from 'node:fs/promises';

import { join, resolve } from 'node:path';

import { hash } from '../../../scripts/runtime/paths.mjs';

import { WorkshopStore } from '../../../tools/workshop/store.mjs';

import { createWorkshopServer } from '../../../tools/workshop/server.mjs';

import { workshopCall } from './phase18-helpers.mjs';



const password = 'group-test-password-local-2026';

const json = value => Buffer.from(JSON.stringify(value) + '\n');

const encoded = (path, bytes) => ({ path, sha256: hash(bytes), base64: bytes.toString('base64') });

function moduleArtifact(id = 'test.group-widget', version = '1.0.0') {

  const manifest = { format: 'world-hub.module/v1', id, version, license: 'MIT', platforms: ['win32-x64', 'linux-x64'], runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: [], requires: [], permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } };

  return { format: 'world-hub.source-artifact/v1', kind: 'module', id, version, files: [encoded('module.json', json(manifest)), encoded('program.mjs', Buffer.from("throw new Error('Do not execute community uploads');\n"))], provenance: { redistributionAcknowledged: true } };

}

function configurationArtifact(version = '1.0.0', id = 'test.group-widget') {

  const manifest = {format:'world-hub.configuration/v1',id,version,title:'A shared Hub configuration',license:'MIT',platforms:['win32-x64','linux-x64'],provides:[],requires:[],scope:'global',

    modules:[{id:'source',module:{id:'test.group-member',version:'1.0.0',digest:'a'.repeat(64)},configuration:{topics:{events:'test/profile/events'},bridges:{main:{publish:['events'],subscribe:[]}},settings:{},bindings:[]}}],

    startupPlan:{members:[{programId:'source',enabled:true,after:[]}],onFailure:'continue-independent',startupOrder:['source']}};

  return {format:'world-hub.source-artifact/v1',kind:'configuration',id,version,files:[encoded('configuration.json',json(manifest))],provenance:{redistributionAcknowledged:true}};

}



async function directory() { const root = resolve('.artifacts/workshop-group-tests'); await mkdir(root, { recursive: true }); return mkdtemp(join(root, 'case-')); }

async function fixture(t, root = null) {

  root ??= await directory();

  const store = await WorkshopStore.open({ root }); if (!store.state.users.length) await store.initializeAdmin('admin', password); await store.close();

  const service = await createWorkshopServer({ root, baseURL: 'http://127.0.0.1:0/workshop', port: 0, allowInsecureLoopback: true, secureCookie: false }); t.after(() => service.close());

  const signedIn = await workshopCall(service, 'api/login', { username: 'admin', password });

  return { root, service, actor: { ...signedIn.data, cookie: signedIn.cookie } };

}

async function publish(service, actor, artifact) { return (await workshopCall(service, 'api/publications', { artifact, redistributionAcknowledged: true }, actor, 201)).data.publication; }



test('module configurations publish, download, propose and restart as current source artifacts; versions share a catalog identity', async t => {

  const { root, service, actor } = await fixture(t);

  const baseline = await publish(service, actor, configurationArtifact());

  const pre = await publish(service, actor, configurationArtifact('2.0.0-beta.2'));

  const current = await publish(service, actor, configurationArtifact('2.0.0'));

  await publish(service, actor, configurationArtifact('1.9.9')); // Backfilled history must not replace the highest release.

  const independent = await publish(service, actor, moduleArtifact());

  const catalog = (await workshopCall(service, 'api/catalog')).data;

  assert.equal(catalog.total, 2); assert.equal(catalog.publications.find(item => item.kind === 'configuration').entryId, current.entryId);

  assert.equal(catalog.publications.find(item => item.kind === 'configuration').versionCount, 4);

  assert.equal((await workshopCall(service, 'api/catalog?kind=configuration')).data.total, 1);

  assert.equal((await workshopCall(service, 'index.json')).data.entries.length, 5, 'every exact version stays independently pin-able');

  const detail = (await workshopCall(service, `api/publications/${baseline.entryId}`)).data;

  assert.equal(detail.publication.sha256, baseline.sha256);

  assert.deepEqual(detail.versions.map(item => item.version), ['2.0.0', '2.0.0-beta.2', '1.9.9', '1.0.0']);

  assert.equal(detail.configuration.manifest.modules[0].module.id, 'test.group-member');

  assert.deepEqual(detail.configuration.manifest.modules[0].configuration.bridges.main.publish, ['events']);

  assert.equal(detail.configuration.manifest.startupPlan.members[0].enabled, true);

  const bytes = Buffer.from(await (await fetch(`${service.baseURL}/artifacts/${baseline.sha256}.json`)).arrayBuffer());

  assert.equal(hash(bytes), baseline.sha256); assert.deepEqual(JSON.parse(bytes.toString()), configurationArtifact());

  const changed = configurationArtifact('2.1.0');

  const proposal = (await workshopCall(service, `api/publications/${baseline.entryId}/proposals`, { artifact: changed, redistributionAcknowledged: true, baseSha256: baseline.sha256 }, actor, 201)).data.proposal;

  assert.deepEqual((await workshopCall(service, `api/publications/${baseline.entryId}/proposals/${proposal.id}`)).data.artifact, changed);

  await workshopCall(service, `api/publications/${baseline.entryId}/comments`, { text: 'Uses one local Hub.' }, actor, 201);

  await workshopCall(service, `api/publications/${current.entryId}/visibility`, { hidden: true }, actor);

  const publicCatalog = (await workshopCall(service, 'api/catalog')).data;

  assert.equal(publicCatalog.publications.find(item => item.kind === 'configuration').entryId, pre.entryId);

  assert.equal(publicCatalog.publications.find(item => item.kind === 'module').entryId, independent.entryId);

  await service.close();

  const reopened = await WorkshopStore.open({ root }); t.after(() => reopened.close());

  assert.equal(reopened.catalog().total, 2); assert.equal(reopened.detail(baseline.entryId).comments.length, 1);

  assert.equal((await reopened.configuration(baseline.entryId)).manifest.modules.length, 1);

  assert.equal(reopened.detail(baseline.entryId).versions.some(item => item.entryId === current.entryId), false, 'hidden versions are not advertised to anonymous readers');

});



test('retired stored pack and template identities survive restart privately but cannot be discovered or downloaded', async t => {

  const root = await directory(), store = await WorkshopStore.open({ root });

  const user = await store.initializeAdmin('admin', password);

  const published = (await store.publish(user, { artifact: moduleArtifact('test.current'), redistributionAcknowledged: true })).publication;

  const retired = [];

  for (const kind of ['pack', 'template', 'module-group']) {

    const artifact = { ...moduleArtifact(`test.retired-${kind}`), kind }, bytes = json(artifact), digest = await store.storeArtifact(bytes);

    await store.transaction(state => {

      const old = structuredClone(state.publications[0]); old.kind = kind; old.id = artifact.id; old.entryId = `pub.retired.${kind}`; old.sha256 = digest; old.comments = []; old.proposals = [];

      old.entry = { ...old.entry, kind, id: old.id, entryId: old.entryId, sha256: digest, source: { path: `artifacts/${digest}.json` } };

      state.publications.push(old); retired.push({ entryId: old.entryId, sha256: digest });

    });

  }

  await store.close();

  const { service, actor } = await fixture(t, root);

  assert.equal(service.store.state.publications.length, 4);

  assert.equal((await workshopCall(service, 'api/catalog', undefined, actor)).data.total, 1);

  assert.deepEqual((await workshopCall(service, 'index.json')).data.entries.map(item => item.entryId), [published.entryId]);

  for (const item of retired) {

    await workshopCall(service, `api/publications/${item.entryId}`, undefined, actor, 404);

    await workshopCall(service, `api/publications/${item.entryId}/comments`, { text: 'Unavailable' }, actor, 404);

    await workshopCall(service, `api/publications/${item.entryId}/proposals`, { artifact: moduleArtifact('test.current', '1.1.0'), redistributionAcknowledged: true, baseSha256: item.sha256 }, actor, 404);

    assert.equal((await fetch(`${service.baseURL}/artifacts/${item.sha256}.json`)).status, 404);

  }

  assert.equal((await fetch(`${service.baseURL}/artifacts/${published.sha256}.json`)).status, 200);

});
