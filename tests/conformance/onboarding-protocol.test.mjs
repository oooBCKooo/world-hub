import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Harness } from '../helpers/hub-harness.mjs';

class WireClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.frames = [];
    this.waiters = [];
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      const frame = JSON.parse(event.data);
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) if (waiter.matches(frame)) {
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    });
  }
  wait(matches) {
    const existing = this.frames.find(matches);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`wire wait timed out; received=${JSON.stringify(this.frames)}`));
      }, 5000);
      this.waiters.push(waiter);
    });
  }
  send(frame) { this.ws.send(JSON.stringify(frame)); }
  async hello(principal) {
    await this.opened;
    this.send({ type: 'hello', wire: '0.1', bridge: principal });
    return this.wait(frame => frame.type === 'welcome');
  }
  async receipt(type, fields) {
    const requestToken = randomUUID();
    this.send({ type, ...fields, requestToken });
    return this.wait(frame => frame.requestToken === requestToken);
  }
  async subscribe(filters, options = {}) {
    const token = randomUUID();
    this.send({ type: 'subscribe', filters, ...options, token });
    const subscribed = await this.wait(frame => frame.type === 'subscribed' && frame.token === token);
    await this.wait(frame => frame.type === 'caught_up' && frame.subscription === subscribed.subscription);
    return subscribed.subscription;
  }
  deliveries(subscription) {
    return this.frames.filter(frame => frame.type === 'delivery' && (!subscription || frame.subscription === subscription));
  }
  async close() {
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise(resolve => {
      this.ws.addEventListener('close', resolve, { once: true });
      this.ws.close();
    });
  }
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'hub-onboarding-protocol-'));
  const configPath = join(directory, 'config.json');
  const allow = { publish: ['#'], subscribe: ['#'] };
  writeFileSync(configPath, JSON.stringify({ acl: { bridges: {
    alpha: { allow }, beta: { allow }, worker: { allow },
  } } }));
  const h = new Harness(), clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await h.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await h.startHub({ configPath });
  const connect = async principal => {
    const client = new WireClient(h.endpoint);
    clients.push(client);
    await client.hello(principal);
    return client;
  };
  return { h, connect };
}

test('requestSeq binds an accepted reply but delivery still needs a matching topic subscription', async t => {
  const { h, connect } = await fixture(t);
  const caller = await connect('alpha'), worker = await connect('worker');
  await worker.subscribe(['external/new-query'], { operations: ['request'], from: 0 });
  const request = await caller.receipt('request', {
    target: { principal: 'worker' }, topic: 'external/new-query', body: { question: 'opaque' },
  });
  assert.equal(request.type, 'published');
  await worker.wait(frame => frame.type === 'delivery' && frame.seq === request.seq);
  const changedTopic = await worker.receipt('respond', {
    requestSeq: request.seq, topic: 'private/reply-inbox', body: { answer: 'wrong route' },
  });
  assert.equal(changedTopic.code, 'FRAME_INVALID');
  const response = await worker.receipt('respond', { requestSeq: request.seq, body: { answer: 'later pull' } });
  assert.equal(response.type, 'published');
  assert.equal(response.requestSeq, request.seq);
  const retained = (await h.log()).records.find(record => record.seq === response.seq);
  assert.equal(retained.topic, 'external/new-query');
  assert.deepEqual(retained.target, { principal: 'alpha' });
  // caught_up is an ordered wire barrier, rather than a timing assumption about silence.
  await caller.subscribe(['private/reply-inbox'], { from: 0, operations: ['response'] });
  assert.equal(caller.deliveries().length, 0);
  const history = await caller.subscribe(['external/new-query'], { from: 0, operations: ['response'] });
  assert.deepEqual(caller.deliveries(history).map(frame => frame.seq), [response.seq]);
  assert.deepEqual(caller.deliveries(history)[0].body, { answer: 'later pull' });
  assert.equal((await h.status()).storage.log.protectedCount, 2);
});

test('shared topic permissions do not expose another principal directed requests or responses', async t => {
  const { connect } = await fixture(t);
  const alpha = await connect('alpha'), beta = await connect('beta'), worker = await connect('worker');
  const asub = await alpha.subscribe(['shared/call'], { from: 0 });
  const bsub = await beta.subscribe(['shared/call'], { from: 0 });
  await worker.subscribe(['shared/call'], { from: 0, operations: ['request'] });
  const roundTrip = async (caller, name) => {
    const request = await caller.receipt('request', {
      target: { principal: 'worker' }, topic: 'shared/call', body: { owner: name },
    });
    await worker.wait(frame => frame.type === 'delivery' && frame.seq === request.seq);
    const response = await worker.receipt('respond', { requestSeq: request.seq, body: { answered: name } });
    await caller.wait(frame => frame.type === 'delivery' && frame.seq === response.seq);
    return { request, response };
  };
  const a = await roundTrip(alpha, 'alpha'), b = await roundTrip(beta, 'beta');
  const ahistory = await alpha.subscribe(['shared/#'], { from: 0 });
  const bhistory = await beta.subscribe(['shared/#'], { from: 0 });
  assert.deepEqual(alpha.deliveries(asub).map(frame => frame.seq), [a.response.seq]);
  assert.deepEqual(beta.deliveries(bsub).map(frame => frame.seq), [b.response.seq]);
  assert.deepEqual(alpha.deliveries(ahistory).map(frame => frame.seq), [a.response.seq]);
  assert.deepEqual(beta.deliveries(bhistory).map(frame => frame.seq), [b.response.seq]);
  assert.equal(alpha.deliveries().some(frame => frame.seq === b.request.seq || frame.seq === b.response.seq), false);
  assert.equal(beta.deliveries().some(frame => frame.seq === a.request.seq || frame.seq === a.response.seq), false);
});
