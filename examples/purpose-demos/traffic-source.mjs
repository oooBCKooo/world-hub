#!/usr/bin/env node
// This newly introduced source registers a new information topic through its
// own mod. The Hub does not know what traffic, vehicles or congestion mean.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPurposePeerMain } from './peer.mjs';
import { asObject, channel, openState, respondOrPublish } from './common.mjs';

export async function startTrafficSource(context) {
  if (context.profile.id !== 'event-desk' || context.peer.id !== 'traffic') throw new Error('此入口只运行独立 traffic 来源程序');
  const state = await openState(context.stateDir, 'traffic-state.json', { version: 1, enabled: false, count: 0, last: null });
  const topic = context.topic('traffic/sample'), control = context.topic('traffic/control'), changed = context.topic('traffic/configured');
  let bridge, timer, tail = Promise.resolve();
  const serialize = work => { const next = tail.then(work); tail = next.catch(() => {}); return next; };
  const sample = async () => {
    if (context.stopped || !state.value.enabled || !bridge?.connected) return;
    const next = state.value; next.count++;
    const vehicles = 12 + (next.count * 7) % 31;
    next.last = { kind: 'demo.traffic-reading', source: 'traffic', number: next.count, vehicles,
      congestion: vehicles >= 32 ? '繁忙' : '通畅', at: new Date().toISOString() };
    await state.save(next); await bridge.publishConfirmed(topic, next.last);
  };
  bridge = await context.openBridge('main', { channels: [channel(control, { subscribe: true }), channel(changed)], filters: [control],
    onDelivery: (message, activeBridge) => serialize(async () => {
      const body = asObject(message.body), command = body.command ?? 'snapshot';
      if (command === 'enable') {
        // Register only now: the first two-source observation has no traffic
        // topic declaration. Existing records are never released on disable.
        await activeBridge.registerChannels([channel(topic)]);
        await state.save({ ...state.value, enabled: true });
        await sample(); clearInterval(timer);
        timer = setInterval(() => void serialize(sample).catch(error => {
          if (!context.stopped) console.error(JSON.stringify({ event: 'traffic-error', error: error.message }));
        }), 1100);
      } else if (command === 'disable') {
        clearInterval(timer); await state.save({ ...state.value, enabled: false });
      } else if (command !== 'snapshot') throw new Error('交通来源仅支持 enable、disable、snapshot');
      const declared = activeBridge.channels.find(item => item.name === topic);
      await respondOrPublish(activeBridge, message, { ok: true, kind: 'demo.traffic-source', source: 'traffic',
        implementation: 'independent-traffic-source', ...state.value, principal: context.target('traffic').principal,
        bridge: activeBridge.bridgeId, declaredTopic: declared?.name ?? null, topicRegistered: Boolean(declared),
        retention: '暂停输出不会释放既有信息' }, command !== 'snapshot' ? changed : null);
    }) });
  context.defer(async () => { clearInterval(timer); await tail; });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runPurposePeerMain(startTrafficSource);
