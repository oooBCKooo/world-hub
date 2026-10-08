import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startOwnedProgram } from '../../tests/helpers/owned-program.mjs';

export async function startFlow(scene, name, options = {}) {
  const hubConfig = JSON.parse(await readFile(scene.configPath, 'utf8'));
  const bridges = (options.bridges ?? [{ id: name }]).map((bridge) => ({ ...bridge,
    token: bridge.token ?? (bridge.credential ? hubConfig.acl.credentials[bridge.credential]?.token : hubConfig.acl.bridges[bridge.id]?.token) }));
  const journal = options.journal ? resolve(scene.dir, options.journal) : undefined;
  if (journal && !journal.startsWith(resolve(scene.dir) + sep)) throw new Error('flow journal must be inside scene directory');
  const configPath = join(scene.dir, `${randomUUID()}.flow.json`);
  await writeFile(configPath, JSON.stringify({ name, url: scene.harness.endpoint, bridges, rules: options.rules ?? [], journal }));
  const owned = await startOwnedProgram(fileURLToPath(new URL('./flow-program.mjs', import.meta.url)), { args: [configPath] });
  const events = (kind) => owned.lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((item) => item && (!kind || item.event === kind));
  const wait = async (predicate, { timeoutMs = 12000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events().find(predicate); if (found) return found;
      if (owned.exited) throw new Error(`${name} exited: ${JSON.stringify(owned.exited)} ${owned.stderr}`);
      if (Date.now() >= deadline) throw new Error(`${name} event timed out: ${JSON.stringify(events().slice(-3))}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
  };
  let stopped;
  const stop = async () => {
    stopped ??= owned.stop(); const exit = await stopped;
    assert.deepEqual(exit, { code: 0, signal: null }, `${name}: ${owned.stderr}`);
    assert.equal(events('fatal').length, 0, `${name} fatal event`);
    return exit;
  };
  scene.ownCleanup(async () => {
    const exit = await stop();
    scene.record('external-flow-program-exit', { name, pid: owned.child.pid, exit,
      events: events().filter((item) => item.event !== 'result').map((item) => ({ event: item.event, inputSeq: item.inputSeq,
        receivedSeq: item.message?.seq, fromPrincipal: item.message?.fromPrincipal, target: item.message?.target,
        receipts: item.receipts, error: item.error })) });
  });
  return { name, pid: owned.child.pid, events, wait, stop,
    async cmd(op, args = {}) {
      const id = randomUUID(); owned.child.send({ type: 'command', id, op, args });
      const result = await wait((event) => event.event === 'result' && event.id === id, { timeoutMs: (args.timeoutMs ?? 12000) + 2000 });
      if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      return result.value;
    },
  };
}
