// Owning-launcher lifecycle binding. This adds no channel, payload or business
// behavior to the unchanged hub server. IPC loss closes the server on Windows.
let stopping = false;
const stop = () => {
  if (stopping) return; stopping = true;
  process.emit('SIGTERM');
  setTimeout(() => process.exit(1), 5000).unref();
};
if (process.send) {
  process.on('message', (message) => { if (message?.type === 'stop') stop(); });
  process.on('disconnect', stop);
}
await import('../../src/hub/hub-server.mjs');
