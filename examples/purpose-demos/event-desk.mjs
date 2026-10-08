// Sample generation and aggregation are ordinary external program business.
import { asObject, boundedInteger, channel, openState, respondOrPublish } from './common.mjs';

export async function startEventDeskPeer(context) {
  if (context.peer.id === 'aggregator') return startAggregator(context);
  const sensor = context.peer.id === 'sensor';
  const state = await openState(context.stateDir, 'source-state.json', sensor
    ? { version: 1, intervalMs: 1400, offset: 0, count: 0, last: null }
    : { version: 1, intervalMs: 1800, base: 100, count: 0, last: null });
  const sampleTopic = context.topic(`${context.peer.id}/sample`), controlTopic = context.topic(`${context.peer.id}/control`);
  const changedTopic = context.topic(`${context.peer.id}/configured`);
  let outputBridge, timer, sampling = false, tail = Promise.resolve();
  const serialize = work => { const pending = tail.then(work); tail = pending.catch(() => {}); return pending; };
  const sample = async () => {
    if (context.stopped || sampling || !outputBridge?.connected) return;
    sampling = true;
    try {
      await serialize(async () => {
      const next = state.value; next.count++;
      next.last = sensor
        ? { kind: 'demo.environment-reading', source: 'sensor', number: next.count, temperature: Number((21 + Math.sin(next.count / 3) * 2 + next.offset).toFixed(2)), unit: '°C', at: new Date().toISOString() }
        : { kind: 'demo.market-reading', source: 'market', number: next.count, price: Number((next.base + Math.cos(next.count / 2) * 4).toFixed(2)), currency: 'DEMO', at: new Date().toISOString() };
      await state.save(next);
      await outputBridge.publishConfirmed(sampleTopic, next.last);
      });
    } finally { sampling = false; }
  };
  const restartTimer = () => { clearInterval(timer); timer = setInterval(() => void sample().catch(error => {
    if (!context.stopped) console.error(JSON.stringify({ event: 'sample-error', peer: context.peer.id, error: error.message }));
  }), state.value.intervalMs); };
  const onControl = (message, bridge) => serialize(async () => {
    const body = asObject(message.body), command = body.command ?? 'snapshot';
    if (command === 'configure') {
      const next = state.value;
      if (body.intervalMs !== undefined) next.intervalMs = boundedInteger(body.intervalMs, 'intervalMs', 250, 10000);
      if (sensor && body.offset !== undefined) next.offset = boundedInteger(body.offset, 'offset', -20, 20);
      if (!sensor && body.base !== undefined) next.base = boundedInteger(body.base, 'base', 1, 100000);
      await state.save(next); restartTimer();
    } else if (command !== 'snapshot') throw new Error(`来源不支持命令：${command}`);
    const result = { ok: true, kind: command === 'configure' ? 'demo.source-configured' : 'demo.source-snapshot', source: context.peer.id, ...state.value,
      bridgeMapping: sensor ? { metrics: context.bridge('metrics').bridgeId, control: context.bridge('control').bridgeId } : { main: bridge.bridgeId } };
    await respondOrPublish(bridge, message, result, command === 'configure' ? changedTopic : null);
  });
  if (sensor) {
    outputBridge = await context.openBridge('metrics', { channels: [channel(sampleTopic)] });
    await context.openBridge('control', { channels: [channel(controlTopic, { subscribe: true }), channel(changedTopic)], filters: [controlTopic], onDelivery: onControl });
  } else outputBridge = await context.openBridge('main', { channels: [channel(sampleTopic), channel(controlTopic, { subscribe: true }), channel(changedTopic)], filters: [controlTopic], onDelivery: onControl });
  context.defer(() => { clearInterval(timer); }); restartTimer();
}

async function startAggregator(context) {
  const state = await openState(context.stateDir, 'summary-state.json', { version: 1, received: 0, latest: {}, recent: [] });
  const queryTopic = context.topic('summary'), sources = [context.topic('sensor/sample'), context.topic('market/sample')], updatedTopic = context.topic('summary/updated');
  await context.openBridge('main', { channels: [...sources.map(name => channel(name, { publish: false, subscribe: true })), channel(queryTopic, { subscribe: true }), channel(updatedTopic)],
    filters: [...sources, queryTopic], operations: ['publish', 'request', 'inject'],
    onDelivery: async (message, bridge) => {
      if ((message.operation ?? 'publish') === 'publish' && sources.includes(message.topic)) {
        const source = message.topic === sources[0] ? 'sensor' : 'market';
        const next = state.value; next.received++;
        next.latest[source] = { value: message.body, from: message.from, seq: message.seq };
        next.recent.push({ source, seq: message.seq, at: new Date().toISOString() }); next.recent = next.recent.slice(-40);
        await state.save(next);
        await bridge.publishConfirmed(updatedTopic, { kind: 'demo.summary-updated', received: next.received, latest: next.latest });
      } else if (message.topic === queryTopic) {
        const body = asObject(message.body);
        if (body.command !== undefined && body.command !== 'snapshot') throw new Error('汇总程序仅支持 snapshot');
        await respondOrPublish(bridge, message, { ok: true, kind: 'demo.multi-source-summary', ...state.value }, null);
      }
    } });
}
