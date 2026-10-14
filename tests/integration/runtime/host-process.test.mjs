import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ownHostedProcess } from '../../../scripts/runtime/host-process.mjs';
import { assertHostedPlatform } from '../../../scripts/runtime/host-profile.mjs';
const supported = ['win32', 'linux'].includes(process.platform);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('review rejects unsupported owned-child platforms before filesystem or installer work', () => {
  const manifest = { permissions: { processes: 'owned-children' } };
  for (const platform of ['darwin', 'freebsd', 'sunos']) assert.throws(() => assertHostedPlatform(manifest, platform), { code: 'HOST_LIFECYCLE_UNSUPPORTED' });
  for (const platform of ['win32', 'linux']) assert.doesNotThrow(() => assertHostedPlatform(manifest, platform));
  assert.doesNotThrow(() => assertHostedPlatform({ permissions: { processes: 'none' } }, 'darwin'));
});
function alive(pid) { try { process.kill(pid, 0); if (process.platform === 'linux') { const stat = readFileSync('/proc/' + pid + '/stat', 'utf8'); if (stat.slice(stat.lastIndexOf(') ') + 2).split(/\s+/)[0] === 'Z') return false; } return true; } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return false; throw error; } }
async function fixture(mode) {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-owned-host-')); await mkdir(join(directory, 'tmp'));
  const file = join(directory, 'descendant.json');
  const childCode = `import {spawn} from 'node:child_process';import{writeFileSync}from'node:fs';import{createInterface}from'node:readline';
    const child=spawn(process.execPath,['--input-type=module','-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:process.platform==='win32'});
    child.once('spawn',()=>{writeFileSync(process.argv[1],JSON.stringify({pid:child.pid}));console.log(JSON.stringify({event:'module-ready'}));${mode === 'orphan' ? 'setTimeout(()=>process.exit(0),100)' : ''}});
    createInterface({input:process.stdin}).on('line',line=>{let frame;try{frame=JSON.parse(line)}catch{return}if(frame.command==='health')console.log(JSON.stringify({event:'module-health',id:frame.id,ready:true}));${mode === 'graceful' ? "if(frame.command==='stop'){child.kill();setTimeout(()=>process.exit(0),100)}" : ''}});`;
  const failures = [];
  const handle = await ownHostedProcess(process.execPath, ['--input-type=module', '-e', childCode, file], { cwd: directory, temporary: join(directory, 'tmp'), ownedChildren: true, onFailure: error => failures.push(error) });
  await handle.waitFor(frame => frame.event === 'module-ready', 10000); const descendant = JSON.parse(await readFile(file, 'utf8')).pid;
  return { handle, descendant, failures };
}
for (const mode of ['graceful', 'forced', 'orphan']) test(`owned Host ${mode} retires its current child tree`, { skip: !supported, timeout: 60000 }, async () => {
  const { handle, descendant, failures } = await fixture(mode);
  try {
    assert.equal(alive(descendant), true); assert.ok(handle.hostOwner.programPid);
    if (mode === 'orphan') { const end = Date.now() + 5000; while (!handle.programExit && Date.now() < end) await delay(20); assert.ok(handle.programExit); assert.equal(handle.exit, null); assert.equal(alive(descendant), true); assert.ok(failures.length > 0); }
    else { handle.send({ command: 'health', id: 'probe' }); await handle.waitFor(frame => frame.event === 'module-health' && frame.id === 'probe', 5000); }
    await handle.stop(1000); assert.ok(handle.exit); assert.equal(handle.hostedLifecycle.retired, true);
    const end = Date.now() + 5000; while (alive(descendant) && Date.now() < end) await delay(20);
    assert.equal(alive(descendant), false, 'real descendant must leave the owned Job/group');
  } finally { if (!handle.hostedLifecycle.retired) await handle.stop(500).catch(() => {}); }
});
test('unsupported systems refuse owned child-process deployment', { skip: supported }, async () => {
  await assert.rejects(ownHostedProcess(process.execPath, [], { ownedChildren: true }), { code: 'HOST_LIFECYCLE_UNSUPPORTED' });
});
