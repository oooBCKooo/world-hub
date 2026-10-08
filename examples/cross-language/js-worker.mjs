// Independent JS fixture. The Hub sees only ordinary wire frames.
import { createInterface } from 'node:readline';
const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2].replace(/^--/, ''), process.argv[3 + i * 2]]));
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const ws = new WebSocket(args.url);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let normalClose = false, welcomed = false, stopped = false;
const fatal = (error) => {
  if (stopped) return;
  stopped = true;
  emit({ event: 'error', error: { code: error.code ?? 'TRANSPORT_FAILED', message: error.message } });
  process.exitCode = 1;
  if (ws.readyState < 2) ws.close();
  process.stdin.destroy();
};
const timeout = setTimeout(() => fatal(new Error('connection/welcome deadline exceeded')), 8000);
ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', wire: '0.1', bridge: args.bridge,
  ...(args.credential ? { credential: args.credential } : {}), ...(args.token ? { token: args.token } : {}) })));
ws.addEventListener('error', () => { if (!normalClose) fatal(new Error('WebSocket error')); });
ws.addEventListener('close', () => { clearTimeout(timeout); if (!normalClose) fatal(new Error('unexpected WebSocket close')); });
ws.addEventListener('message', (event) => {
  const raw = event.data;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4 * 1024 * 1024) return fatal(new Error('frame exceeds fixture limit or is not text'));
  try {
    const frame = JSON.parse(raw);
    emit({ event: 'frame', frame, raw });
    if (!welcomed && frame.type === 'denied') return fatal(Object.assign(new Error(frame.message ?? frame.code), { code: frame.code }));
    if (frame.type === 'welcome') {
      welcomed = true; clearTimeout(timeout);
      emit({ event: 'ready', language: 'javascript', pid: process.pid, version: process.version, welcome: frame });
    }
  } catch (error) { fatal(error); }
});
try {
  for await (const line of input) {
    const command = JSON.parse(line);
    if (command.action === 'close') { normalClose = true; emit({ id: command.id, ok: true }); ws.close(); break; }
    try {
      if (command.action !== 'send' || !welcomed) throw new Error('send requires welcome');
      const text = command.raw ?? JSON.stringify(command.frame);
      if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('outgoing frame exceeds fixture limit');
      ws.send(text); emit({ id: command.id, ok: true });
    } catch (error) { emit({ id: command.id, ok: false, error: { message: error.message } }); }
  }
} catch (error) { if (!stopped) fatal(error); }
finally {
  normalClose = true; clearTimeout(timeout); input.close(); process.stdin.destroy();
  if (ws.readyState < 2) ws.close();
}
