// Actual A -> Hub -> B -> Hub -> C -> Hub -> D file relay. The Hub neither
// chooses the next hop nor copies another program's attachment as its provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createScene, bounded } from '../../../examples/directed-transfer/scene-harness.mjs';
import { startOwnedProgram } from '../../helpers/owned-program.mjs';

const script = fileURLToPath(new URL('../../../examples/workflows/blob-relay-program.mjs', import.meta.url));
const BYTES = 6 * 1024 * 1024 + 19;
function control(program, op, args = {}) {
  const commandId = randomUUID();
  let timer, onMessage, onExit;
  return new Promise((resolve, reject) => {
    const clear = () => { clearTimeout(timer); program.child.off('message', onMessage); program.child.off('exit', onExit); };
    onMessage = (event) => {
      if (event.type !== 'result' || event.commandId !== commandId) return;
      clear();
      if (event.error) reject(Object.assign(new Error(event.error.message), { code: event.error.code }));
      else resolve(event.value);
    };
    onExit = (code, signal) => { clear(); reject(new Error(`relay exited (${code}, ${signal}): ${program.stderr}`)); };
    timer = setTimeout(() => { clear(); reject(new Error(`relay ${op} timed out`)); }, 10_000);
    program.child.on('message', onMessage); program.child.once('exit', onExit);
    program.child.send({ type: 'command', commandId, op, args }, (error) => { if (error) { clear(); reject(error); } });
  });
}
async function awaitForwarded(program) {
  let timer;
  try {
    return await bounded(new Promise((resolve, reject) => {
      const poll = () => {
        const events = program.lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
        const failed = events.find((event) => event.event === 'handler_failed');
        if (failed) { reject(new Error(JSON.stringify(failed))); return; }
        const proof = events.find((event) => event.event === 'forwarded');
        if (proof) { resolve(proof); return; }
        if (program.exited) { reject(new Error(`relay exited before forwarding: ${program.stderr}`)); return; }
        timer = setTimeout(poll, 10);
      };
      poll();
    }), 30_000, 'autonomous attachment forwarding');
  } finally { clearTimeout(timer); }
}
async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); return true; });
}

test('P5-B01 actual A/B/C/D programs relay a 6 MiB attachment through three Hub hops with independent provider copies and explicit retention decisions', { timeout: 90_000 }, async (t) => {
  const principals = ['flow.file.a', 'flow.file.b', 'flow.file.c', 'flow.file.d'];
  const topics = ['fixture/fifth/file/b', 'fixture/fifth/file/c', 'fixture/fifth/file/d'];
  const scene = await createScene(t, { principals });
  const owned = [];
  const stopOwned = async () => {
    const stopping = await Promise.allSettled(owned.map(async (program) => {
      const exit = await program.stop();
      assert.equal(exit.code, 0, `relay ${program.child.pid} must stop normally`);
      assert.equal(exit.signal, null);
      return { pid: program.child.pid, ...exit };
    }));
    scene.record('attachment-relay-process-exits', { programs: stopping.filter((result) => result.status === 'fulfilled').map((result) => result.value) });
    const failures = stopping.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'external attachment relay cleanup failed');
  };
  scene.ownCleanup(stopOwned);
  const acl = JSON.parse(await readFile(scene.configPath, 'utf8')).acl.bridges;
  const a = await scene.peer(principals[0]);
  const d = await scene.peer(principals[3]);
  await a.cmd('register', { channels: [{ name: topics[0], publish: true, subscribe: false }] });
  await d.cmd('register', { channels: [{ name: topics[2], publish: false, subscribe: true }] });
  await d.cmd('subscribe', { filters: [topics[2]], from: 0, operations: ['inject'] });
  for (const index of [1, 2]) {
    const configPath = join(scene.dir, `relay-${index}.json`);
    await writeFile(configPath, JSON.stringify({ name: principals[index], dir: scene.dir,
      url: scene.harness.endpoint, mod: { id: principals[index], token: acl[principals[index]].token },
      incomingTopic: topics[index - 1], outgoingTopic: topics[index], nextPrincipal: principals[index + 1] }));
    const program = await startOwnedProgram(script, { args: [configPath] });
    owned.push(program);
    assert.equal(program.ready.principal, principals[index]);
  }
  const [b, c] = owned;
  const pids = [scene.harness.hub.pid, a.pid, b.child.pid, c.child.pid, d.pid];
  assert.equal(new Set(pids).size, 5);
  assert.ok(pids.every((pid) => Number.isInteger(pid) && pid !== process.pid));
  const source = await a.cmd('generate', { path: join(scene.dir, 'original-a.bin'), size: BYTES, seed: 77 });
  const original = await a.cmd('upload', { path: source.path });
  const flowId = randomUUID();
  const first = await a.cmd('inject', { target: { principal: principals[1] }, topic: topics[0],
    body: { flowId, trace: [{ program: principals[0], pid: a.pid, outputObject: original.id, size: source.size, sha256: source.sha256 }] },
    attachments: [original.id], correlation: flowId });
  const proofs = await Promise.all([awaitForwarded(b), awaitForwarded(c)]);
  const [hopB, hopC] = proofs;
  assert.equal(hopB.inputSeq, first.seq);
  assert.equal(hopC.inputSeq, hopB.outgoingSeq);
  assert.ok(first.seq < hopB.outgoingSeq && hopB.outgoingSeq < hopC.outgoingSeq);
  assert.deepEqual(proofs.map((proof) => proof.pid), [b.child.pid, c.child.pid]);
  assert.deepEqual(proofs.map((proof) => proof.program), principals.slice(1, 3));
  assert.deepEqual(proofs.map((proof) => proof.inputPrincipal), principals.slice(0, 2));
  assert.deepEqual(proofs.map((proof) => proof.nextPrincipal), principals.slice(2));
  assert.equal(hopB.inputObject, original.id);
  assert.equal(hopC.inputObject, hopB.outputObject);
  const objectIds = [original.id, hopB.outputObject, hopC.outputObject];
  assert.equal(new Set(objectIds).size, 3, 'every forwarding program uploads its own new provider object');
  for (const proof of proofs) {
    assert.equal(proof.size, BYTES);
    assert.equal(proof.sha256, source.sha256);
    assert.equal(proof.provided.committed, true);
    assert.equal(proof.provided.released, false);
  }
  const final = (await d.wait((event) => event.kind === 'delivery' && event.message.seq === hopC.outgoingSeq)).message;
  assert.equal(final.operation, 'inject');
  assert.equal(final.fromPrincipal, principals[2]);
  assert.equal(final.target.principal, principals[3]);
  assert.equal(final.body.flowId, flowId);
  assert.deepEqual(final.body.trace.map((step) => step.program), principals.slice(0, 3));
  assert.deepEqual(final.body.trace.map((step) => step.pid), [a.pid, b.child.pid, c.child.pid]);
  assert.deepEqual(final.attachments, [{ id: hopC.outputObject, size: BYTES, sha256: source.sha256 }]);
  const destination = join(scene.dir, 'final-d.bin');
  await d.cmd('download', { messageSeq: final.seq, id: hopC.outputObject, path: destination });
  const downloaded = await d.cmd('fileHash', { path: destination });
  assert.equal(downloaded.size, BYTES);
  assert.equal(downloaded.sha256, source.sha256);

  // Ownership is proved with authenticated bridge operations, rather than a
  // program-supplied owner label: foreign providers cannot attach or release.
  await rejectsCode(control(b, 'inject', { target: { principal: principals[3] }, topic: topics[1], body: {}, attachments: [original.id] }), 'BLOB_DENIED');
  await rejectsCode(control(b, 'releaseBlob', { id: original.id }), 'BLOB_OWNER_DENIED');
  await rejectsCode(control(c, 'releaseBlob', { id: hopB.outputObject }), 'BLOB_OWNER_DENIED');
  await rejectsCode(a.cmd('releaseBlob', { id: hopC.outputObject }), 'BLOB_OWNER_DENIED');
  const status = await Promise.all([a.cmd('blobStatus', { id: original.id }),
    control(b, 'blobStatus', { id: hopB.outputObject }), control(c, 'blobStatus', { id: hopC.outputObject })]);
  assert.ok(status.every((object) => object.committed && !object.released));
  const state = await fetch(`${scene.harness.httpBase}/manage/api/state`).then((response) => response.json());
  assert.equal(state.log.protectedCount, 3);
  assert.equal(state.log.releasedCount, 0);
  assert.equal(status.filter((object) => !object.released).length, 3);
  const messages = (await scene.harness.log()).records.filter((record) => record.kind === 'message');
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((record) => record.seq), [first.seq, hopB.outgoingSeq, hopC.outgoingSeq]);
  assert.deepEqual(messages.map((record) => record.fromPrincipal), principals.slice(0, 3));
  assert.deepEqual(messages.map((record) => record.target.principal), principals.slice(1));
  assert.deepEqual(messages.map((record) => record.attachments[0].id), objectIds);

  // Each provider now explicitly chooses release. A's choice does not release
  // B's or C's newly provided copies; message and object choices are separate.
  await a.cmd('releaseBlob', { id: original.id });
  await a.cmd('release', { seq: [first.seq] });
  assert.equal((await control(b, 'blobStatus', { id: hopB.outputObject })).released, false);
  assert.equal((await control(c, 'blobStatus', { id: hopC.outputObject })).released, false);
  await control(b, 'releaseBlob', { id: hopB.outputObject });
  await control(b, 'release', { seq: [hopB.outgoingSeq] });
  assert.equal((await control(c, 'blobStatus', { id: hopC.outputObject })).released, false);
  await control(c, 'releaseBlob', { id: hopC.outputObject });
  await control(c, 'release', { seq: [hopC.outgoingSeq] });
  const after = await fetch(`${scene.harness.httpBase}/manage/api/state`).then((response) => response.json());
  assert.equal(after.log.protectedCount, 0);
  assert.equal(after.log.releasedCount, 3);
  const releasedObjects = await Promise.all([a.cmd('blobStatus', { id: original.id }),
    control(b, 'blobStatus', { id: hopB.outputObject }), control(c, 'blobStatus', { id: hopC.outputObject })]);
  assert.equal(releasedObjects.filter((object) => object.released).length, 3);
  scene.record('multi-hop-real-attachment-provider-copies', { flowId, bytes: BYTES, sha256: source.sha256,
    processes: { hub: pids[0], a: pids[1], b: pids[2], c: pids[3], d: pids[4] },
    original: { id: original.id, seq: first.seq, principal: principals[0] }, relayProofs: proofs,
    final: { seq: final.seq, principal: final.fromPrincipal, objectId: final.attachments[0].id, verified: downloaded },
    protectedBeforeExplicitRelease: { messages: state.log.protectedCount, objects: status.filter((object) => !object.released).length },
    releasedByEachProvider: { messages: after.log.releasedCount, objects: releasedObjects.filter((object) => object.released).length } });
});
