import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveView, describeResult, experimentProgress, injectionEvidence } from '../../../examples/purpose-demos/explorer.js';

test('ordered experiments require a later repeated action and never treat a business refusal as a completed step', () => {
  const experiment = { steps: [{ action: 'summary' }, { action: 'enable' }, { action: 'summary' }] };
  const result = (index, action, ok = true) => ({ index, action, operation: 'request', response: { body: { ok } } });
  const first = result(1, 'summary'), enabled = result(2, 'enable');
  assert.deepEqual(experimentProgress(experiment, [first, enabled]), [first, enabled, null]);
  assert.deepEqual(experimentProgress(experiment, [first, result(2, 'enable', false), result(3, 'summary')]), [first, null, null]);
  const second = result(3, 'summary');
  assert.deepEqual(experimentProgress(experiment, [second, first, enabled]), [first, enabled, second]);
});

test('an injection acceptance is distinct from a later visible target publication', () => {
  const injection = { operation: 'inject', receipt: { seq: 20 }, topic: 'demo/digital-world/npc/plan',
    target: { principal: 'demo.digital-world.npc' } };
  const bridges = [{ authenticated: true, principal: injection.target.principal, bridgeId: 'opaque:runtime:3' }];
  const update = { seq: 21, topic: 'demo/digital-world/npc/updated', operation: 'publish',
    from: 'opaque:runtime:3', body: { ok: true, kind: 'demo.npc-configured', mood: 'friendly', receivedSeq: 20 } };
  assert.equal(injectionEvidence(injection, [], bridges), null);
  assert.equal(injectionEvidence(injection, [{ ...update, seq: 19 }], bridges), null);
  assert.equal(injectionEvidence(injection, [{ ...update, from: 'another.program.main', fromPrincipal: injection.target.principal }], bridges), null);
  assert.equal(injectionEvidence(injection, [{ ...update, operation: 'response' }], bridges), null);
  assert.equal(injectionEvidence(injection, [{ ...update, body: { ...update.body, receivedSeq: 19 } }], bridges), null);
  assert.equal(injectionEvidence(injection, [{ ...update, body: { kind: 'demo.npc-configured', mood: 'friendly', ok: true } }], bridges), null);
  assert.equal(injectionEvidence(injection, [{ ...update, body: { ...update.body, ok: false } }], bridges), null);
  assert.equal(injectionEvidence(injection, [update]), null, 'an opaque origin needs an authoritative Hub bridge row');
  assert.equal(injectionEvidence(injection, [update], [{ ...bridges[0], authenticated: false }]), null);
  assert.equal(injectionEvidence(injection, [update], [{ ...bridges[0], principal: 'another.principal' }]), null);
  assert.equal(injectionEvidence(injection, [{ ...update, from: injection.target.principal + '.main' }], bridges), null, 'a readable prefix is not an authenticated identity');
  assert.equal(injectionEvidence(injection, [update], bridges), update);
  assert.match(describeResult(injection), /尚需观察/);
  assert.equal(injectionEvidence({ operation: 'inject' }, [update]), null);
});

test('an event dashboard uses the actual external aggregator output, including newly introduced sources', () => {
  const envelope = { seq: 7, from: 'aggregator.main', body: { kind: 'demo.multi-source-summary', received: 5,
    latest: { sensor: { seq: 3, from: 'sensor.metrics', value: { temperature: 23 } }, newKind: { seq: 4, from: 'custom.bridge', value: { value: 42, unit: 'widgets' } } } } };
  const view = deriveView({ profile: { id: 'event-desk' }, events: [], results: [{ response: envelope }] });
  assert.equal(view.summary, envelope);
  assert.deepEqual(view.sources.map(source => source.id), ['sensor', 'newKind']);
  assert.equal(view.sources[1].value.value, 42);
  assert.equal(view.sources[1].from, 'custom.bridge');
  assert.equal(view.sources[1].principal, undefined, 'a bridge origin is not promoted to authenticated principal evidence');
});

test('assistant provenance comes from the actual composer result, not the number of preset programs', () => {
  const baseline = { seq: 10, body: { kind: 'demo.distributed-assistant-result', sources: [{ provider: 'system', responseSeq: 3 }],
    context: { systemPrompt: 'actual input', messages: [], materials: [] }, harnessProvider: 'harness' } };
  const expanded = { seq: 25, body: { kind: 'demo.distributed-assistant-result', sources: [{ provider: 'system', responseSeq: 13 }, { provider: 'extension', responseSeq: 17 }],
    context: { systemPrompt: 'actual input', messages: [], materials: [{ provider: 'extension', text: '<img src=x onerror=alert(1)>' }] }, harnessProvider: 'checklist' } };
  const state = { profile: { id: 'modular-assistant', peers: Array.from({ length: 8 }, () => ({})) }, events: [expanded], results: [{ response: baseline }] };
  assert.equal(deriveView(state).result, expanded);
  assert.equal(deriveView(state).result.body.sources.length, 2);
  assert.equal(deriveView(state).result.body.harnessProvider, 'checklist');
  assert.equal(deriveView(state).result.body.context.materials[0].text, '<img src=x onerror=alert(1)>');
});

test('new world state overrides a previous run while its historical timeline remains separate', () => {
  const run = { seq: 20, body: { kind: 'demo.world-run', finalState: { turn: 3, energy: 5 }, timeline: [{ round: 1 }] } };
  const reset = { seq: 25, body: { kind: 'demo.world-state', world: { turn: 0, energy: 8 } } };
  const view = deriveView({ profile: { id: 'digital-world' }, events: [reset], results: [{ response: run }] });
  assert.equal(view.world.turn, 0);
  assert.equal(view.latest, reset);
  assert.equal(view.run, run);
  assert.equal(view.run.body.initialState, undefined, 'the UI never invents an unreported pre-run state');
  assert.match(describeResult({ response: { body: { ok: false, error: 'business refusal' } } }), /业务拒绝/);
});
