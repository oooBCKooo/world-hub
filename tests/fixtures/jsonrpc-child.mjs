import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'normal';
const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
const reply = (request, result) => send({ jsonrpc: '2.0', id: request.id, result });
const requests = new Map();
const keepAlive = setInterval(() => {}, 10_000);
process.stdin.on('end', () => {
  if (mode === 'stubborn') return;
  clearInterval(keepAlive);
  process.exit(0);
});

createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (!frame.method) {
    const request = requests.get(frame.id);
    if (request) { requests.delete(frame.id); reply(request, frame); }
    return;
  }
  if (mode === 'timeout') return;
  if (mode === 'malformed') return process.stdout.write('{broken}\n');
  if (mode === 'invalid-utf8') return process.stdout.write(Buffer.from([0xff, 10]));
  if (mode === 'line-limit') return process.stdout.write(`${'x'.repeat(400)}\n`);
  if (mode === 'buffer-limit') return process.stdout.write('x'.repeat(900));
  // The last bytes have no newline; they must not be treated as a valid frame.
  if (mode === 'eof') {
    return process.stdout.write('{"jsonrpc":"2.0","id":1', () => process.exit(0));
  }
  if (mode === 'exit') return process.exit(12);
  if (frame.method === 'echo') return reply(frame, { id: frame.id, params: frame.params });
  if (frame.method === 'notify') {
    send({ jsonrpc: '2.0', method: 'changed', params: { text: '中文\n🙂' } });
    if (frame.id !== undefined) reply(frame, true);
    return;
  }
  if (frame.method === 'reverse') {
    requests.set(`server-${frame.id}`, frame);
    send({ jsonrpc: '2.0', id: `server-${frame.id}`, method: 'confirm', params: { value: frame.params } });
    return;
  }
  if (frame.method === 'error') return send({ jsonrpc: '2.0', id: frame.id, error: { code: -32001, message: 'Rejected by child', data: { reason: 'test' } } });
  if (frame.method === 'stderr') {
    process.stderr.write('diagnostic from child\n');
    return reply(frame, true);
  }
  if (frame.method === 'shutdown') {
    reply(frame, true);
    return;
  }
  if (frame.method === 'split') {
    const wire = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: '🙂中文' })}\r\n`);
    const emoji = wire.indexOf(Buffer.from('🙂'));
    process.stdout.write(wire.subarray(0, emoji + 2));
    return setTimeout(() => process.stdout.write(wire.subarray(emoji + 2)), 15);
  }
  if (frame.method === 'late') return setTimeout(() => reply(frame, 'late'), 100);
  if (frame.id !== undefined) reply(frame, null);
});
