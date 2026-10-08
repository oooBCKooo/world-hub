// The Hub never owns or advances this world. A director program calls separate
// NPC, rules and state programs once per round and decides when the flow ends.
import { randomUUID } from 'node:crypto';
import { asObject, boundedInteger, channel, openState, respondOrPublish } from './common.mjs';

const newWorld = () => ({ turn: 0, energy: 8, inventory: 0, position: 0, weather: '晴朗' });
export async function startDigitalWorldPeer(context) {
  if (context.peer.id === 'state') return startState(context);
  if (context.peer.id === 'rules') return startRules(context);
  if (context.peer.id === 'npc') return startNpc(context);
  if (context.peer.id === 'director') return startDirector(context);
  throw new Error('未实现的数字世界程序');
}

async function startState(context) {
  const state = await openState(context.stateDir, 'world-state.json', { version: 1, revision: 0, world: newWorld() });
  const topic = context.topic('world/state'), updated = context.topic('world/updated');
  await context.openBridge('main', { channels: [channel(topic, { subscribe: true }), channel(updated)], filters: [topic], onDelivery: async (message, bridge) => {
    const body = asObject(message.body), command = body.command ?? 'snapshot';
    const next = state.value;
    if (command === 'reset') { next.world = newWorld(); next.revision++; await state.save(next); }
    else if (command === 'apply') {
      if (body.expectedRevision !== next.revision) throw new Error('世界修订号已改变，本次演示提交未执行');
      const proposed = asObject(body.world);
      for (const name of ['turn', 'energy', 'inventory', 'position']) boundedInteger(proposed[name], `world.${name}`, 0, 1000000);
      if (!['晴朗', '微风', '小雨'].includes(proposed.weather)) throw new Error('world.weather 无效');
      if (proposed.turn !== next.world.turn + 1) throw new Error('世界提交必须逐轮推进');
      next.world = { turn: proposed.turn, energy: proposed.energy, inventory: proposed.inventory, position: proposed.position, weather: proposed.weather };
      next.revision++; await state.save(next);
    } else if (command !== 'snapshot') throw new Error('state 仅支持 snapshot、reset、apply');
    const result = { ok: true, kind: 'demo.world-state', ...state.value, owner: 'state-program' };
    await respondOrPublish(bridge, message, result, command !== 'snapshot' ? updated : null);
  } });
}

async function startNpc(context) {
  const state = await openState(context.stateDir, 'npc-state.json', { version: 1, mood: 'curious' });
  const topic = context.topic('npc/plan'), updated = context.topic('npc/updated');
  await context.openBridge('main', { channels: [channel(topic, { subscribe: true }), channel(updated)], filters: [topic], onDelivery: async (message, bridge) => {
    const body = asObject(message.body);
    if (body.command === 'configure') {
      if (!['friendly', 'curious', 'quiet'].includes(body.mood)) throw new Error('mood 需要 friendly、curious 或 quiet');
      await state.save({ ...state.value, mood: body.mood });
      await respondOrPublish(bridge, message, { ok: true, kind: 'demo.npc-configured', ...state.value }, updated); return;
    }
    const world = asObject(body.world); boundedInteger(world.turn, 'world.turn', 0, 1000000);
    const mood = state.value.mood;
    const plan = mood === 'friendly' ? { gift: 2, description: 'NPC 提供两份补给' }
      : mood === 'quiet' ? { gift: 0, description: 'NPC 观察世界，暂不互动' }
      : { gift: world.turn % 2, description: world.turn % 2 ? 'NPC 找到一份补给' : 'NPC 探索周围路径' };
    await respondOrPublish(bridge, message, { ok: true, kind: 'demo.npc-plan', mood, ...plan }, null);
  } });
}

async function startRules(context) {
  const topic = context.topic('rules/step');
  await context.openBridge('main', { channels: [channel(topic, { subscribe: true })], filters: [topic], onDelivery: async (message, bridge) => {
    const body = asObject(message.body), world = asObject(body.world), npc = asObject(body.npcPlan);
    if (!['scout', 'rest', 'trade'].includes(body.action)) throw new Error('action 需要 scout、rest 或 trade');
    for (const name of ['turn', 'energy', 'inventory', 'position']) boundedInteger(world[name], `world.${name}`, 0, 1000000);
    const gift = boundedInteger(npc.gift, 'npcPlan.gift', 0, 10), next = { ...world, turn: world.turn + 1, inventory: world.inventory + gift };
    let description;
    if (body.action === 'rest') { next.energy = Math.min(20, world.energy + 3); description = '休整，恢复体力'; }
    else if (body.action === 'trade') { const quantity = Math.min(2, next.inventory); next.inventory -= quantity; next.energy = Math.min(20, world.energy + quantity); description = `交换 ${quantity} 份补给恢复体力`; }
    else if (world.energy > 0) { next.position++; next.energy--; next.inventory++; description = '探索一格路径并找到一份材料'; }
    else description = '体力不足，探索没有移动；可发起休整回合';
    next.weather = ['晴朗', '微风', '小雨'][next.turn % 3];
    await respondOrPublish(bridge, message, { ok: true, kind: 'demo.world-proposal', world: next, description, action: body.action }, null);
  } });
}

async function startDirector(context) {
  const topic = context.topic('director/run'), progress = context.topic('director/progress'), complete = context.topic('director/completed');
  const state = await openState(context.stateDir, 'last-run.json', { version: 1, completed: 0, lastResult: null });
  const callTopics = [context.topic('world/state'), context.topic('npc/plan'), context.topic('rules/step')];
  await context.openBridge('main', { channels: [channel(topic, { subscribe: true }), channel(progress), channel(complete), ...callTopics.map(name => channel(name, { subscribe: true }))], filters: [topic], onDelivery: async (message, bridge) => {
    const body = asObject(message.body), rounds = boundedInteger(body.rounds ?? 3, 'rounds', 1, 12), action = body.action ?? 'scout';
    if (!['scout', 'rest', 'trade'].includes(action)) throw new Error('action 需要 scout、rest 或 trade');
    const runId = randomUUID(), timeline = [], receipts = [];
    const call = async (peer, suffix, input) => {
      const result = await bridge.call(context.target(peer), context.topic(suffix), input, { timeoutMs: 12000 });
      if (result.response.body.ok !== true) throw new Error(`${peer} 程序拒绝：${result.response.body.error}`);
      receipts.push({ program: peer, principal: result.response.fromPrincipal, bridge: result.response.from, requestSeq: result.request.seq, responseSeq: result.response.seq });
      return result.response.body;
    };
    let snapshot = await call('state', 'world/state', { command: 'snapshot' });
    const initialState = structuredClone(snapshot.world);
    for (let round = 1; round <= rounds; round++) {
      const npcPlan = await call('npc', 'npc/plan', { world: snapshot.world, runId, round });
      const proposal = await call('rules', 'rules/step', { world: snapshot.world, action, npcPlan, runId, round });
      snapshot = await call('state', 'world/state', { command: 'apply', expectedRevision: snapshot.revision, world: proposal.world, runId, round });
      const step = { round, world: snapshot.world, revision: snapshot.revision, action, npc: npcPlan.description, description: proposal.description };
      timeline.push(step); await bridge.publishConfirmed(progress, { kind: 'demo.world-round', runId, ...step });
    }
    const result = { ok: true, kind: 'demo.world-run', runId, rounds, action, initialState, timeline, finalState: snapshot.world, revision: snapshot.revision, receipts,
      businessOwner: 'external-director-and-world-programs', resultFile: state.path };
    const next = state.value; next.completed++; next.lastResult = result; await state.save(next);
    await respondOrPublish(bridge, message, result, complete);
  } });
}
