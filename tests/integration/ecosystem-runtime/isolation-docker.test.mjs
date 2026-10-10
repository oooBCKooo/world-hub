// This suite requires a real Docker Linux engine and a pre-pulled digest image.
// It is a separate explicit CI gate, never a skipped or mocked sandbox claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLock, importPackage, inspectPackage, startInstance, reviewIsolationPackage } from '../../../scripts/runtime/index.mjs';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const dockerPath = process.env.WORLD_HUB_TEST_DOCKER, image = process.env.WORLD_HUB_TEST_IMAGE;
const policy = { dockerPath, endpoint: 'unix:///var/run/docker.sock', image, limits: { memoryMiB: 128, pids: 32, cpus: .5, user: process.getuid?.() ?? 1000 } };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n');
test('ISOLATION-REAL real restricted Node communicates through the Hub while host-file, external-network and subprocess attempts fail', { timeout: 120000 }, async t => {
  assert.equal(process.platform, 'linux', 'Run this explicit suite on Linux'); assert.ok(dockerPath && image, 'Select a real Docker executable and digest image');
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-isolation-real-')), pack = join(directory, 'pack'), source = join(pack, 'modules/probe'), root = join(directory, 'root');
  let session; t.after(async () => { if (session) { const stopped = await session.close(); assert.equal(stopped.cleanupIncomplete, undefined); assert.ok(stopped.stoppedAt); }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(directory.split('/').at(-1).startsWith('world-hub-isolation-real-')); await rm(directory, { recursive: true, force: true }); });
  await mkdir(join(source, 'sdk'), { recursive: true });
  for (const file of ['bridge-kit.mjs', 'blob-client.mjs']) await cp(join(ROOT, 'sdk/javascript', file), join(source, 'sdk', file));
  await save(join(source, 'package.json'), { type: 'module', imports: { '#bridge': './sdk/bridge-kit.mjs' } });
  const canary = join(directory, 'host-secret.txt'); await writeFile(canary, 'host-only-canary');
  await writeFile(join(source, 'program.mjs'), `import {readFile,writeFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';import {createInterface} from 'node:readline';import {Bridge} from '#bridge';
const config=JSON.parse(await readFile(process.argv[3],'utf8')),b=config.bridges[0];const results={};
try{await readFile(config.settings.canary);results.hostRead=true}catch{results.hostRead=false}
try{await writeFile('/source/program.mjs','changed');results.codeWrite=true}catch{results.codeWrite=false}
try{await fetch('https://example.com',{signal:AbortSignal.timeout(1500)});results.externalNetwork=true}catch{results.externalNetwork=false}
const child=spawnSync('/usr/local/bin/node',['-e','process.exit(0)']);results.subprocess=child.status===0;results.subprocessError=child.error?.code;
await writeFile(config.stateDir+'/allowed-state.txt','private-component-state');
const bridge=new Bridge({url:b.endpoint,bridgeId:b.bridgeId,credential:b.credential,token:b.token});bridge.on('error',()=>{});await bridge.connect();
await bridge.registerChannels([{name:b.publish[0],publish:true,subscribe:true}]);
bridge.on('delivery',async event=>{if(event.topic===b.publish[0]&&event.body?.text==='real 🌍'){await writeFile(config.stateDir+'/business.json',JSON.stringify({text:event.body.text,codePoints:[...event.body.text].length,results}));bridge.ack(event);}});
await bridge.subscribe([b.subscribe[0]],{from:'now'});await bridge.publish(b.publish[0],{text:'real 🌍'});
const emit=data=>process.stdout.write(JSON.stringify(data)+'\\n');emit({event:'module-ready'});const input=createInterface({input:process.stdin});input.on('line',async line=>{let c;try{c=JSON.parse(line)}catch{return}if(c.command==='health')emit({event:'module-health',id:c.id,ready:bridge.connected});if(c.command==='stop'){await bridge.close();input.close();process.exit(0)}});input.on('close',()=>process.exit(0));
`);
  await save(join(source, 'module.json'), { format: 'world-hub.module/v1', id: 'isolation.probe', version: '1.0.0', license: 'MIT', platforms: ['linux-x64'], runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: [], requires: [], permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } });
  await save(join(pack, 'pack.json'), { format: 'world-hub.pack/v1', id: 'isolation.real', version: '1.0.0', title: 'Real isolation acceptance', license: 'MIT', topics: { proof: 'isolation/proof' }, components: [{ id: 'probe', module: 'isolation.probe', after: [], settings: { canary }, bridges: { main: { publish: ['proof'], subscribe: ['proof'] } } }], bindings: [], entry: { component: 'probe' }, startupTimeoutMs: 20000, healthTimeoutMs: 4000, stopTimeoutMs: 1000 });
  await createLock(pack, { nodePath: process.execPath }); const imported = await importPackage(pack, { root, instanceId: 'test', nodePath: process.execPath });
  const plan = await inspectPackage(join(imported.stateDir, 'package'), { nodePath: process.execPath }), review = await reviewIsolationPackage(plan, policy);
  await assert.rejects(startInstance({ root, instanceId: 'test', trust: plan.digest, isolation: policy, isolationTrust: 'outdated' }), { code: 'ISOLATION_REVIEW_REQUIRED' });
  session = await startInstance({ root, instanceId: 'test', trust: plan.digest, isolation: policy, isolationTrust: review.digest });
  const state = await session.status(); assert.equal(state.sandbox, true); assert.equal(state.components[0].communication, 'connected'); assert.equal(state.components[0].isolation.auditedBeforeStart, true); assert.equal(state.entryUrl, null);
  let business; for (let i = 0; i < 100; i++) { try { business = await json(join(imported.stateDir, 'programs/probe/business.json')); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
  assert.equal(business.text, 'real 🌍'); assert.equal(business.codePoints, 6); assert.equal(business.results.hostRead, false); assert.equal(business.results.codeWrite, false); assert.equal(business.results.externalNetwork, false); assert.equal(business.results.subprocess, false); assert.equal(business.results.subprocessError, 'EPERM');
  assert.equal(await readFile(canary, 'utf8'), 'host-only-canary'); assert.equal(await readFile(join(imported.stateDir, 'programs/probe/allowed-state.txt'), 'utf8'), 'private-component-state');
  t.diagnostic(JSON.stringify({ profile: review.profile, image, business, enforced: state.components[0].isolation }));
});
