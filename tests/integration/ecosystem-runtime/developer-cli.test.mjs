import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace, samplePackage, environment, save, ROOT, expectedText, analyze } from '../launcher/helpers.mjs';
import { startInstance, logsInstance } from '../../../scripts/runtime/index.mjs';
const execute = promisify(execFile), cliPath = join(ROOT, 'bin/world-hub-pack.mjs');
const envArgs = ['--node', environment.nodePath, '--python', environment.pythonPath];
const licenses = ['--acknowledge-licenses', 'true'];
async function cli(args) { const result = await execute(process.execPath, [cliPath, ...args], { cwd: ROOT, windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 }); return JSON.parse(result.stdout); }
test('AUTHOR-CLI-01 public generation, publication, discovery, retrieval and replacement deliver exact results in both languages', { timeout: 120000 }, async t => {
  const app = await workspace(t), source = await samplePackage(app), original = await cli(['authoring', source, ...envArgs]);
  const oldSource = await readFile(join(source, 'modules/source/program.mjs')), oldDesk = await readFile(join(source, 'modules/desk/program.mjs'));
  let firstRun;
  for (const runtime of ['node', 'python']) {
    const directory = join(app.directory, `author-${runtime}`), id = `author.${runtime}`;
    await cli(['init-module', directory, '--id', id, '--runtime', runtime]);
    assert.equal((await cli(['validate-module', directory])).ok, true); assert.equal((await cli(['doctor-module', directory, ...envArgs])).ok, true);
    const published = await cli(['publish', directory, '--destination', join(app.directory, `published-${runtime}`), '--kind', 'module', ...licenses]);
    const index = await cli(['source', published.indexPath]); assert.equal(index.index.entries[0].id, id);
    const fetched = await cli(['fetch-source', published.indexPath, '--index-digest', index.digest, '--entry', index.index.entries[0].entryId, '--cache', join(app.directory, 'cache')]);
    const preview = await cli(['preview-replacement', source, '--component', 'stats', '--module', fetched.directory, ...envArgs]); assert.equal(preview.compatible, true); assert.equal(preview.businessValidated, false);
    const manifestFile = join(app.directory, `pack-${runtime}.json`), replacementFile = join(app.directory, `replacement-${runtime}.json`);
    await save(manifestFile, original.pack); await save(replacementFile, [{ componentId: 'stats', moduleDirectory: fetched.directory }]);
    const derived = await cli(['derive', source, '--destination', join(app.directory, `derived-${runtime}`), '--manifest', manifestFile, '--replacements', replacementFile, '--revision', original.revision, ...licenses, ...envArgs]);
    const imported = await cli(['import', derived.directory, '--root', app.root, '--instance', runtime, ...envArgs]);
    const session = await startInstance({ root: app.root, instanceId: runtime, trust: imported.digest, ...environment }); app.cleanups.push(() => session.close());
    const state = app.observe(await session.status());
    if (!firstRun) firstRun = state.runId; else assert.notEqual(state.runId, firstRun);
    const text = '模块任意 🌍\r\n e\u0301 '; const response = await analyze(session.ready.entryUrl, text);
    assert.equal(response.result.provider, id); assert.deepEqual(response.result.output, expectedText(text));
    const logs = await logsInstance({ root: app.root, instanceId: runtime }); assert.equal(logs.runId, state.runId); assert.ok(Number.isFinite(Date.parse(logs.observedAt)));
    await session.close(); const historical = await logsInstance({ root: app.root, instanceId: runtime }); assert.equal(historical.runId, state.runId);
    assert.deepEqual(await readFile(join(source, 'modules/source/program.mjs')), oldSource); assert.deepEqual(await readFile(join(source, 'modules/desk/program.mjs')), oldDesk);
    assert.equal((await cli(['authoring', source, ...envArgs])).revision, original.revision);
    app.record(`generated-${runtime}-publication-replacement`, { provider: response.result.provider, output: response.result.output, runId: state.runId, sourceAndConsumerUnchanged: true, humanThirdPartyAcceptance: false });
  }
});
test('AUTHOR-CLI-02 help, version, completion and actionable nonzero diagnostic output remain scriptable', async () => {
  const version = await execute(process.execPath, [cliPath, '--version']); assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
  for (const shell of ['powershell', 'bash', 'zsh', 'fish']) assert.match((await execute(process.execPath, [cliPath, 'completion', shell])).stdout, /world-hub-pack/);
  await assert.rejects(cli(['validate-module', 'definitely-absent-directory']), error => { assert.equal(error.code, 1); const value = JSON.parse(error.stdout); assert.equal(value.ok, false); assert.ok(value.issues[0].remedy); assert.equal(error.stderr, ''); return true; });
});
