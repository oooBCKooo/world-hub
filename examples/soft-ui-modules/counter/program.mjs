// The counter owns its durable business state; a bound module owns native windows.
import { Bridge } from './bridge-kit.mjs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadState, saveState } from './state.mjs';
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n');
let bridge, stopped = false, ready = false, closing, work = Promise.resolve();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const stop = () => closing ??= (async () => { stopped = true; ready = false; await bridge?.close('Counter stopped'); await work.catch(() => {}); input.close(); })();
input.on('line', line => { if (line.length > 65536) return; let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame.command === 'stop') void stop();
  if (frame.command === 'health' && typeof frame.id === 'string') emit({ event: 'module-health', id: frame.id, ready: ready && !stopped && bridge?.connected === true }); });
input.on('close', () => { if (!stopped) void stop(); }); for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop());
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--runtime-config') throw new Error('Expected private Runtime configuration.');
  const config = JSON.parse(await readFile(process.argv[3], 'utf8')), connection = config.bridges?.find(item => item.slot === 'main');
  const required = config.bindings?.filter(item => item.to === config.componentId && item.contract?.id === 'soft-ui.windows' && item.contract.version === '1.0.0');
  if (config.format !== 'world-hub.run/v1' || !connection || required?.length !== 1) throw new Error('Select exactly one Soft UI provider.');
  const hostPrincipal = config.peers?.[required[0].from]?.principal, commandTopic = config.topics?.commands, eventTopic = config.topics?.events;
  const viewId = config.settings?.['view-id'] ?? 'counter', title = config.settings?.title ?? '动态计数器', initialCount = config.settings?.['initial-count'] ?? 0;
  if (typeof hostPrincipal !== 'string' || !hostPrincipal || !connection.publish.includes(commandTopic) || !connection.subscribe.includes(eventTopic)
      || typeof viewId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(viewId) || typeof title !== 'string' || !title || title.length > 120 || !Number.isSafeInteger(initialCount)) throw new Error('Invalid public settings or communication binding.');
  const file = join(config.stateDir, 'counter.json');
  let state = loadState(file, { version: 1, count: initialCount, revision: 0, lastSeq: 0, recentEvents: [], pending: null });
  if (state.version !== 1 || !Number.isSafeInteger(state.count) || !Number.isSafeInteger(state.revision) || !Number.isSafeInteger(state.lastSeq) || !Array.isArray(state.recentEvents)) throw new Error('Preserve the invalid counter state and create a new instance.');
  bridge = new Bridge({ url: connection.endpoint, bridgeId: connection.bridgeId, credential: connection.credential, token: connection.token, autoAck: true, cursorFile: join(config.stateDir, 'bridge-cursor.json') });
  const screen = (kind, snapshot = state) => ({ protocol: 'soft-ui/1', kind, viewId, title, revision: snapshot.revision, root: { type: 'column', children: [
    { type: 'text', text: '界面操作经 Hub 返回独立计数模块；计数不在界面或枢纽中执行。' },
    { type: 'metric', id: 'value', text: '计数 / Count', value: snapshot.count },
    { type: 'row', children: [{ type: 'button', id: 'inc', text: '加一 / +1' }, { type: 'button', id: 'dec', text: '减一 / −1' }] } ] } });
  const commit = next => { saveState(file, next); state = next; };
  const flush = async () => { if (state.pending) { await bridge.sendTo({ principal: hostPrincipal }, commandTopic, state.pending); commit({ ...state, pending: null }); } };
  bridge.on('open', welcome => { if (welcome.authenticated !== true || welcome.principal !== connection.principal) void bridge.close('Unexpected counter identity'); });
  bridge.on('close', () => { ready = false; });
  bridge.on('subscribed', () => { ready = !stopped && bridge.connected; });
  bridge.on('error', event => emit({ event: 'module-diagnostic', code: event.code ?? 'COUNTER_BRIDGE_ERROR' }));
  bridge.on('delivery', message => {
    if (stopped || message.operation !== 'inject' || message.topic !== eventTopic || message.fromPrincipal !== hostPrincipal) return;
    const pending = work.then(async () => {
      await flush(); const body = message.body;
      if (body?.protocol !== 'soft-ui/1' || body.kind !== 'ui.event' || body.viewId !== viewId || body.action !== 'click' || !['inc', 'dec'].includes(body.elementId)
          || !Number.isSafeInteger(body.revision) || body.revision < 1 || body.revision > state.revision || typeof body.eventId !== 'string' || body.eventId.length > 256
          || message.seq <= state.lastSeq || state.recentEvents.includes(body.eventId)) return;
      const count = state.count + (body.elementId === 'inc' ? 1 : -1); if (!Number.isSafeInteger(count)) throw new Error('Counter range exceeded');
      const next = { ...state, count, revision: state.revision + 1, lastSeq: message.seq, recentEvents: [...state.recentEvents, body.eventId].slice(-5000) };
      commit({ ...next, pending: screen('view.update', next) }); await flush();
    }); work = pending.catch(() => { ready = false; emit({ event: 'module-diagnostic', code: 'COUNTER_UPDATE_FAILED' }); }); return pending;
  });
  const welcome = await bridge.connect(); if (welcome.authenticated !== true || welcome.principal !== connection.principal) throw new Error('Counter identity was not authenticated.');
  await bridge.registerChannels([{ name: commandTopic, publish: true }, { name: eventTopic, subscribe: true }]);
  await flush(); const next = { ...state, revision: state.revision + 1 }; commit({ ...next, pending: screen('view.open', next) }); await flush();
  await bridge.subscribe([eventTopic], { from: 'resume', operations: ['inject'] });
  if (!stopped) { ready = true; emit({ event: 'module-ready' }); }
} catch (error) { emit({ event: 'module-diagnostic', code: 'COUNTER_START_FAILED', message: error.message }); process.exitCode = 1; await stop(); }
