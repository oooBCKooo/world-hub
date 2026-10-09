import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveView, describeResult, experimentProgress, injectionEvidence, displayDemoOutput } from '../../../examples/purpose-demos/explorer.js';
import { getProfile } from '../../../examples/purpose-demos/profiles.mjs';
import { EXPLORER_EN, translateDemoText } from '../../../examples/purpose-demos/explorer-i18n.mjs';

test('capability view keeps directory declarations, current configuration, results and sink records distinct', () => {
  const catalog = { seq: 3, body: { kind: 'demo.capability-directory', entries: [{ module: { id: 'metrics-a' }, principal: 'actual.provider', state: 'lease-valid' }] } };
  const composition = { seq: 8, body: { kind: 'demo.capability-composition', ok: true, status: 'completed', config: { provider: 'metrics-a' }, output: { codePoints: 3 } } };
  const configuration = { seq: 10, body: { kind: 'demo.capability-configuration', config: { provider: 'metrics-b' } } };
  const output = { seq: 11, body: { kind: 'demo.capability-output', records: [{ invocationId: 'actual.id' }] } };
  const state = { profile: { id: 'capability-directory' }, events: [catalog], results: [composition, configuration, output].map(response => ({ response })) };
  const before = JSON.stringify(state), view = deriveView(state);
  assert.equal(view.type, 'capabilities'); assert.equal(view.catalog, catalog); assert.equal(view.entries[0].principal, 'actual.provider');
  assert.equal(view.configuration, configuration); assert.equal(view.composition, composition); assert.equal(view.output, output);
  assert.equal(JSON.stringify(state), before, 'presentation must never rewrite provider declarations or business results');
});

test('capability summaries distinguish unknown execution from a refusal and a completed result', () => {
  const uncertain = { response: { body: { kind: 'demo.capability-composition', ok: false, status: 'uncertain', error: { code: 'PROCESSOR_TIMEOUT', message: 'Provider original reason' } } } };
  assert.match(describeResult(uncertain, { language: 'en' }), /result is unknown.*does not prove.*did not execute/);
  const refusal = { response: { body: { kind: 'demo.capability-composition', ok: false, status: 'failed', error: { code: 'CONTRACT_MISMATCH', message: '<img>原文' } } } };
  assert.match(describeResult(refusal, { language: 'en' }), /CONTRACT_MISMATCH.*<img>原文/);
  const complete = { response: { body: { kind: 'demo.capability-composition', ok: true, status: 'completed', selection: { module: { id: 'metrics-b' } }, receipts: [{}, {}, {}, {}] } } };
  assert.match(describeResult(complete, { language: 'en' }), /metrics-b.*4 actual call receipts/);
});

test('capability profile navigation has English copy while raw body stays in its original language', () => {
  const profile = getProfile('capability-directory'), before = JSON.stringify(profile);
  const strings = [profile.title, profile.description, ...profile.peers.map(peer => peer.label),
    ...profile.actions.flatMap(action => [action.label, action.description]),
    ...profile.experiments.flatMap(experiment => [experiment.title, experiment.description, experiment.takeaway,
      ...experiment.steps.flatMap(step => [step.label, step.expect])])];
  for (const value of strings) { assert.ok(EXPLORER_EN[value], value); assert.notEqual(translateDemoText(value, 'en'), value, value); }
  assert.equal(JSON.stringify(profile), before);
});

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

test('English summaries retain actual source and round counts without changing application data', () => {
  const result = { label: '运行分布上下文', body: { prompt: '用户原创中文输入', materialProviders: ['material', 'extension'] },
    response: { seq: 42, from: 'opaque:composer:1', fromPrincipal: 'demo.modular-assistant.composer',
      body: { kind: 'demo.distributed-assistant-result', sources: [{ provider: 'system' }, { provider: 'dialogue' }, { provider: 'material' }, { provider: 'extension' }],
        context: { systemPrompt: '系统原文', messages: [{ role: 'user', content: '<script>用户原文</script>' }], materials: [{ text: '参考材料原文' }] },
        answer: '执行器业务原文', harnessProvider: 'checklist' } } };
  const before = JSON.stringify(result);
  assert.match(describeResult(result, { language: 'en' }), /context from 4 sources/);
  assert.match(describeResult(result), /4 个来源/);
  assert.match(describeResult({ response: { body: { kind: 'demo.world-run', rounds: 3, receipts: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}] } } }, { language: 'en' }), /3 actual rounds and 10 program call receipts/);
  assert.equal(JSON.stringify(result), before, 'translating summaries must not change context, input, raw response, identities, or business output');
});

test('English injection and denial copy preserves acceptance and business execution boundaries', () => {
  assert.match(describeResult({ operation: 'inject', receipt: { seq: 9 } }, { language: 'en' }), /accepted the injection.*still needs to be observed/);
  const refusal = { response: { body: { ok: false, error: 'rounds 必须是 1–12 的整数' } } };
  assert.match(describeResult(refusal, { language: 'en' }), /declined the business request: rounds must be an integer from 1 to 12/);
  assert.equal(refusal.response.body.error, 'rounds 必须是 1–12 的整数');
  const unknown = '<img src=x onerror=alert(1)>提供者自己的错误';
  assert.match(describeResult({ response: { body: { ok: false, error: unknown } } }, { language: 'en' }), /declined the business request:/);
  assert.ok(describeResult({ response: { body: { ok: false, error: unknown } } }, { language: 'en' }).endsWith(unknown));
});

test('world presentation translates known demo phrases and preserves unknown program output', () => {
  assert.equal(displayDemoOutput('晴朗', 'en'), 'Clear');
  assert.equal(displayDemoOutput('交换 2 份补给恢复体力', 'en'), 'Trade 2 supply items to recover energy');
  assert.equal(displayDemoOutput('NPC 提供两份补给', 'en'), 'The NPC offers two supply items');
  assert.equal(displayDemoOutput('交换 2 份补给恢复体力'), '交换 2 份补给恢复体力');
  const externalText = '自定义世界叙述 {position} <em>原文</em>';
  assert.equal(displayDemoOutput(externalText, 'en'), externalText, 'a language preference cannot reinterpret arbitrary program text');
});
