import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { Harness, until } from '../helpers/hub-harness.mjs';

test('retention: no reader, restart, multiple later readers, ACK, capacity and provider release', async () => {
  let h = new Harness({ keepTmp: true });
  const bridges = [];
  let temp;
  async function connect(id, credential) {
    const bridge = new Bridge({ url: h.endpoint, bridgeId: id, credential, reconnectMs: 30 });
    bridges.push(bridge); await bridge.connect(); return bridge;
  }
  try {
    // One record per segment makes the capacity/cleanup boundary deterministic.
    await h.startHub();
    temp = h.tmp;
    const logDir = h.logDir;
    await h.stop();
    const configPath = join(temp, 'retention.config.json');
    await writeFile(configPath, JSON.stringify({
      log: { enabled: true, segmentMaxBytes: 1, segmentMaxCount: 2 },
      acl: {
        bridges: { reader: { allow: { publish: ['#'], subscribe: ['#'] } },
          reader2: { allow: { subscribe: ['#'] } } },
        credentials: { provider: { maxConnections: 2, allow: { publish: ['#'], subscribe: ['#'] } } },
      },
    }));
    h = new Harness({ logDir, keepTmp: true }); h.tmp = temp;
    await h.startHub({ configPath, isolateLog: false });
    const p = await connect('arbitrary-program', 'provider');
    const firstIdentity = p.welcome.bridge;
    const topic = 'new-mod/not-in-a-hub-list';
    const one = await p.publishConfirmed(topic, { n: 1, kind: 'future-information' });
    const two = await p.publishConfirmed(topic, { n: 2 });
    assert.equal((await h.status()).subscriptions.length, 0, 'accepted without any consumer');
    await assert.rejects(p.publishConfirmed(topic, { n: 3 }), /LOG_CAPACITY/);
    await p.close(); await h.stop();

    h = new Harness({ logDir, keepTmp: true }); h.tmp = temp;
    await h.startHub({ configPath, isolateLog: false });
    // Force a new instance suffix, proving ownership is the stable credential.
    const spare = await connect('same-principal', 'provider');
    const returned = await connect('arbitrary-program', 'provider');
    assert.notEqual(returned.welcome.bridge, firstIdentity);
    await spare.close();
    const reader = await connect('reader');
    const seen = [];
    reader.on('delivery', f => seen.push(f));
    await reader.subscribe([topic], { from: 0 });
    await until(() => seen.length === 2 && reader.cursorOf([topic]) === two.seq);
    assert.deepEqual(seen.map(f => f.body.n), [1, 2], 'offline input survives restart until later extraction');
    assert.equal(seen.some(f => Object.hasOwn(f, 'owner')), false, 'retention owner is not application payload');
    await assert.rejects(returned.publishConfirmed(topic, { n: 3 }), /LOG_CAPACITY/, 'ACK cannot authorize retention cleanup');
    await assert.rejects(reader.publishConfirmed(topic, { otherProvider: true }), /LOG_CAPACITY/, 'reference log capacity is global across providers');

    const reader2 = await connect('reader2');
    const repeated = [];
    reader2.on('delivery', f => repeated.push(f));
    await reader2.subscribe([topic], { from: 0 });
    await until(() => repeated.length === 2);
    assert.deepEqual(repeated.map(f => f.seq), [one.seq, two.seq], 'extraction is non-destructive');
    await assert.rejects(reader.release([one.seq]), /RELEASE_DENIED/);
    assert.deepEqual((await returned.release([one.seq])).seq, [one.seq]);
    for (const b of bridges) await b.close();
    await h.stop();

    h = new Harness({ logDir, keepTmp: true }); h.tmp = temp;
    await h.startHub({ configPath, isolateLog: false });
    const finalProvider = await connect('arbitrary-program', 'provider');
    const accepted = await finalProvider.publishConfirmed(topic, { n: 4 });
    assert.ok(accepted.seq > two.seq, 'durable provider release enables capacity cleanup after restart');
    const history = await h.log(20);
    assert.deepEqual(history.records.filter(f => f.kind === 'message').map(f => f.body.n), [2, 4]);
  } finally {
    for (const b of bridges) await b.close();
    await h.stop();
    if (temp) {
      const base = resolve(tmpdir()) + sep;
      assert.ok(resolve(temp).startsWith(base), 'cleanup stays inside the generated temporary root');
      await rm(temp, { recursive: true, force: true });
    }
  }
});
