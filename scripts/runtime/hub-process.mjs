// Parent-lifetime binding for an ordinary Hub process, outside Hub Core.
import { createInterface } from 'node:readline';
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  // An EOF during asynchronous Core startup must terminate even before Core
  // installed its signal handlers; EventEmitter does not emulate OS defaults.
  if (process.listenerCount('SIGTERM') === 0) process.exit(0);
  process.emit('SIGTERM');
}
const input = createInterface({ input: process.stdin });
input.on('line', line => { try { if (JSON.parse(line)?.command === 'stop') stop(); } catch {} });
input.on('close', stop);
await import('../../src/hub/hub-server.mjs');
