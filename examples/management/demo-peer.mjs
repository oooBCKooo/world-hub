// External test programs for the management view. No business enters the hub.
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
const [id, mode, url] = process.argv.slice(2);
if (!id || !['source', 'observer'].includes(mode) || !url) throw new Error('requires id, source|observer, hub URL');
const topic = `playground/${id}/sample`, feedback = 'playground/feedback';
const bridge = new Bridge({ url, bridgeId: id, reconnectMs: 500, cursorFile: process.env.HUB_CURSOR_FILE });
let count = 0, closing = false;
bridge.on('error', () => {}); bridge.on('denied', () => {});
bridge.on('delivery', async message => {
  if (mode === 'observer' && message.topic !== feedback) {
    await bridge.publishConfirmed(feedback, { kind: 'sample-feedback', receivedSequence: message.seq }, { replyTo: message.id ?? String(message.seq) });
  }
});
await bridge.connect();
await bridge.registerChannels(mode === 'source' ? [{ name: topic, publish: true }, { name: feedback, subscribe: true }]
  : [{ name: 'playground/+', subscribe: true }, { name: 'playground/+/sample', subscribe: true }, { name: feedback, publish: true }]);
await bridge.subscribe(mode === 'source' ? [feedback] : ['playground/+/sample'], { from: 'resume' });
const timer = mode === 'source' ? setInterval(() => {
  if (!bridge.connected) return;
  void bridge.publishConfirmed(topic, { kind: 'sample', value: ++count, source: id }, { id: `${id}-${count}` }).catch(() => {});
}, 2200) : null;
console.log(JSON.stringify({ event: 'ready', pid: process.pid, bridgeId: id }));
async function stop() {
  if (closing) return; closing = true; clearInterval(timer); await bridge.close();
  if (process.connected) process.disconnect();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
if (process.send) {
  process.on('message', message => { if (message?.type === 'stop') void stop(); });
  process.on('disconnect', () => void stop());
}
