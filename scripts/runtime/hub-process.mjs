// Parent-lifetime binding for an ordinary Hub process, outside Hub Core.
import { createInterface } from 'node:readline';
import { normalizeConfig } from '../../src/hub/lib/store.mjs';
let server;
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  // An EOF during asynchronous Core startup must terminate even before Core
  // installed its signal handlers; EventEmitter does not emulate OS defaults.
  if (process.listenerCount('SIGTERM') === 0) process.exit(0);
  process.emit('SIGTERM');
}
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  if (line.length > 256 * 1024) return;
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame?.command === 'stop') { stop(); return; }
  if (frame?.command !== 'credentials-update') return;
  const send = value => process.stdout.write(JSON.stringify({event:'credentials-updated',id:frame.id,...value})+'\n');
  try {
    if (!server?.ownedHub || typeof frame.id !== 'string' || frame.id.length>64) throw new Error('Owned Hub control is not ready');
    const change=frame.change, current=server.ownedHub.config;
    if (!change || typeof change!=='object' || !Array.isArray(change.remove) || change.remove.length>128 || !change.credentials || typeof change.credentials!=='object' || Array.isArray(change.credentials)
        || Object.keys(change.credentials).length>128 || [...Object.keys(change.credentials),...change.remove].some(id=>typeof id!=='string'||!/^local\.[a-z0-9._-]{1,58}$/.test(id))) throw new Error('Invalid owned program credential change');
    const entries={...current.acl.credentials,...change.credentials};for(const id of change.remove) delete entries[id];
    const checked=normalizeConfig({...current,acl:{...current.acl,credentials:entries}},null);
    // Credential changes revoke current sessions first; no stale authenticated
    // bridge retains a changed authorization grant. Other principals stay live.
    for(const id of [...Object.keys(change.credentials),...change.remove]) if(current.acl.credentials[id] && JSON.stringify(current.acl.credentials[id])!==JSON.stringify(checked.acl.credentials[id])) server.ownedHub.disconnectPrincipal(id,'owner changed credentials');
    current.acl.credentials=checked.acl.credentials;
    send({ok:true});
  } catch(error) { send({ok:false,error:'Owned Hub credential change was rejected'}); }
});
input.on('close', stop);
server = await import('../../src/hub/hub-server.mjs');
