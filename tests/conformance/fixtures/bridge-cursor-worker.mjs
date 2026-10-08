// A real independent SDK consumer controlled over IPC by the test program.
// Applications choose when to ACK; the worker never releases provider records.
import { Bridge } from '../../../sdk/javascript/bridge-kit.mjs';

const options = JSON.parse(process.env.CURSOR_WORKER_OPTIONS);
const bridge = new Bridge({ ...options, autoAck: false });
const messages = new Map();
const send = (event, fields = {}) => process.send?.({ event, pid: process.pid, ...fields });
bridge.on('delivery', (frame) => { messages.set(frame.seq, frame); send('delivery', { seq: frame.seq }); });
bridge.on('error', (frame) => send('error', { frame }));
process.on('message', async (command) => {
  try {
    if (command.type === 'ack') send('result', { token: command.token, acknowledged: bridge.ack(messages.get(command.seq)), cursor: bridge.cursorOf([options.topic]) });
    else if (command.type === 'close') { await bridge.close(); send('result', { token: command.token, closed: true }); process.disconnect(); }
  } catch (error) { send('result', { token: command.token, error: error.message }); }
});
try {
  await bridge.connect();
  const subscription = await bridge.subscribe([options.topic], { from: 'resume' });
  send('ready', { subscription, cursor: bridge.cursorOf([options.topic]) });
} catch (error) { send('fatal', { message: error.message }); await bridge.close(); process.disconnect(); process.exitCode = 1; }
