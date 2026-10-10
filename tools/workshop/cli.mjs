#!/usr/bin/env node
import { readBounded, ordinaryPath } from '../../scripts/runtime/paths.mjs';
import { open } from 'node:fs/promises';
import { WorkshopStore, initializeAdmin } from './store.mjs';
import { createWorkshopServer } from './server.mjs';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

function argumentsOf(args) {
  const value = {}; for (let i = 0; i < args.length; i++) {
    const key = args[i]; if (key === '--help') value.help = true;
    else if (key === '--password-stdin' && !value['password-stdin']) value['password-stdin'] = true;
    else if (key === '--stop' && !value.stop) value.stop = true;
    else if (['--config', '--initialize-admin', '--export'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--') && !Object.hasOwn(value, key.slice(2))) value[key.slice(2)] = args[++i];
    else throw new Error('Unsupported or missing command argument.');
  } return value;
}
export async function main(args = process.argv.slice(2)) {
  const flags = argumentsOf(args);
  if (flags.help) { console.log('World Hub Workshop\n  --config <private config.json>\n  --initialize-admin <username>  (--password-stdin, or WORLD_HUB_WORKSHOP_ADMIN_PASSWORD)\n  --stop  (gracefully release the current owned data root)\n  --export <new private directory>  (stop the service first)\n\nAn independent invite-only hosted artifact catalog. Uploaded programs are never executed.'); return; }
  if (!flags.config || [flags['initialize-admin'], flags.export, flags.stop].filter(Boolean).length > 1 || (flags['password-stdin'] && !flags['initialize-admin'])) throw new Error('Use --config and at most one maintenance operation.');
  const options = JSON.parse((await readBounded(flags.config, 16384)).toString('utf8'));
  const allowed = ['root', 'baseURL', 'bind', 'port', 'allowedHosts', 'diskQuota', 'allowInsecureLoopback', 'secureCookie'];
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !allowed.includes(k))) throw new Error('Unsupported Workshop configuration.');
  if (flags.stop) {
    const root = await ordinaryPath(resolve(options.root)), ownerPath = join(root, 'workshop-owner.lock'), stopPath = join(root, 'workshop-stop.json');
    let owner;
    try { owner = JSON.parse((await readBounded(ownerPath, 4096)).toString('utf8')); } catch (error) { if (error.code === 'ENOENT') { console.log(JSON.stringify({ event: 'workshop-stopped', alreadyStopped: true })); return; } throw error; }
    if (owner.format !== 'world-hub.workshop-owner/v1' || !/^[a-f0-9-]{36}$/.test(owner.nonce)) throw new Error('Unsupported Workshop owner generation.');
    await ordinaryPath(stopPath, { allowMissing: true });
    let handle;
    try { handle = await open(stopPath, 'wx', 0o600); await handle.writeFile(JSON.stringify({ format: 'world-hub.workshop-stop/v1', nonce: owner.nonce }) + '\n'); await handle.sync(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; const existing = JSON.parse((await readBounded(stopPath, 4096)).toString('utf8')); if (existing.format !== 'world-hub.workshop-stop/v1' || existing.nonce !== owner.nonce) throw new Error('Stop request belongs to another generation. Inspect the private data root.'); }
    finally { await handle?.close(); }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { const current = JSON.parse((await readBounded(ownerPath, 4096)).toString('utf8')); if (current.nonce !== owner.nonce) { console.log(JSON.stringify({ event: 'workshop-stopped', replaced: true })); return; } }
      catch (error) { if (error.code === 'ENOENT') { console.log(JSON.stringify({ event: 'workshop-stopped' })); return; } throw error; }
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    throw new Error('The current owner did not stop within the deadline; no process was killed.');
  }
  if (flags['initialize-admin']) {
    let password = process.env.WORLD_HUB_WORKSHOP_ADMIN_PASSWORD; delete process.env.WORLD_HUB_WORKSHOP_ADMIN_PASSWORD;
    if (flags['password-stdin']) { const chunks = []; let length = 0; for await (const chunk of process.stdin) { length += chunk.length; if (length > 512) throw new Error('Password input exceeds its bound.'); chunks.push(chunk); } password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, ''); }
    const user = await initializeAdmin({ ...options, username: flags['initialize-admin'], password }); console.log(JSON.stringify({ event: 'workshop-admin-initialized', user })); return;
  }
  if (flags.export) { const store = await WorkshopStore.open(options); try { console.log(JSON.stringify({ event: 'workshop-exported', ...await store.exportTo(flags.export) })); } finally { await store.close(); } return; }
  const service = await createWorkshopServer(options);
  console.log(JSON.stringify({ event: 'workshop-ready', url: service.url, bind: service.bind, port: service.port }));
  service.closed.then(() => console.log(JSON.stringify({ event: 'workshop-stopped' })));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; try { await service.close(); } catch { console.error('Workshop shutdown could not release its owned data lock.'); process.exitCode = 1; } };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('Workshop command failed. Check the private configuration, ownership and operation inputs; no credentials are logged.'); process.exitCode = 1; });
