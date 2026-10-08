import { loadSettings, isMain } from './lib/program-kit.mjs';
import { startOwnedProgram } from '../../tests/helpers/owned-program.mjs';
import { createDshFixture } from '../../tests/fixtures/dsh/dsh-fixture.mjs';
import { requireDshInstall } from '../../tests/fixtures/dsh/installed-runtime.mjs';
import { providerSettings } from './context-provider.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export async function startPhase2({ configFile, fixture = false, hubConfigFile, fixtureOptions = {} } = {}) {
  const settings = loadSettings(configFile ? ['--config', configFile] : []);
  settings.harness.installRoot = requireDshInstall(settings.harness?.installRoot).installRoot;
  const runDir = fixture ? mkdtempSync(join(tmpdir(), 'peros-phase2-demo-')) : settings.stateDir;
  mkdirSync(runDir, { recursive: true });
  const hubConfig = JSON.parse(readFileSync(hubConfigFile ?? join(here, './hub.config.json'), 'utf8'));
  // Materialized launcher configuration is separate from business programs.
  hubConfig.log.dir = fixture ? join(runDir, 'hub-log') : resolve(here, hubConfig.log.dir);
  if (fixture) hubConfig.transport.port = 0;
  const hubPath = join(runDir, 'hub.runtime.json');
  writeFileSync(hubPath, JSON.stringify(hubConfig));
  let modelFixture;
  if (fixture) {
    modelFixture = await createDshFixture({ ...fixtureOptions, installRoot: settings.harness.installRoot, tempRoot: runDir });
    settings.stateDir = join(runDir, 'program-state'); settings.ui.port = 0;
    settings.harness = { installRoot: settings.harness.installRoot, home: modelFixture.home, cwd: modelFixture.workspace,
      profile: 'sdk-minimal', patch: modelFixture.patchPath, provider: 'peros-test', model: 'fixture',
      nodeArgs: ['--import', pathToFileURL(modelFixture.guardPath).href], inheritEnv: false, env: modelFixture.env };
  }
  const children = [];
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    for (const child of [...children].reverse()) await child.stop();
  };
  try {
    const hub = await startOwnedProgram(join(here, './hub-process.mjs'), { args: ['--config', hubPath, '--quiet'] });
    children.push(hub); settings.hub.url = hub.ready.endpoint;
    const programPath = join(runDir, 'programs.runtime.json');
    writeFileSync(programPath, JSON.stringify(settings));
    const contexts = [];
    const providers = settings.contextProviders ?? [{ id: 'context', peer: 'context', context: settings.context }];
    for (const provider of providers) {
      const providerPath = join(runDir, `provider-${provider.id}.runtime.json`);
      writeFileSync(providerPath, JSON.stringify(providerSettings(settings, provider)));
      const process = await startOwnedProgram(join(here, './context-program.mjs'), { args: ['--config', providerPath] });
      contexts.push(process); children.push(process);
    }
    const harness = await startOwnedProgram(join(here, './harness-program.mjs'), { args: ['--config', programPath] }); children.push(harness);
    const ui = await startOwnedProgram(join(here, './ui-program.mjs'), { args: ['--config', programPath] }); children.push(ui);
    return { children, hub, contexts, context: contexts[0], harness, ui, close, runDir, modelFixture, settings };
  } catch (err) { await close(); throw err; }
}

if (isMain(import.meta.url)) {
  let fixture = false, configFile, hubConfigFile;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--fixture') fixture = true;
    else if (process.argv[i] === '--config' && process.argv[i + 1]) configFile = resolve(process.argv[++i]);
    else if (process.argv[i] === '--hub-config' && process.argv[i + 1]) hubConfigFile = resolve(process.argv[++i]);
    else throw new Error(`unknown option: ${process.argv[i]}`);
  }
  const run = await startPhase2({ fixture, configFile, hubConfigFile });
  console.log(JSON.stringify({ event: 'ready', pid: process.pid, url: run.ui.ready.url, hub: run.hub.ready.endpoint,
    mode: fixture ? 'real-dsh-test-model' : 'configured-dsh-model', evidenceDir: run.runDir,
    pids: [...run.children.map(record => record.child.pid), run.harness.ready.dshPid] }));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await run.close(); if (process.connected) process.disconnect(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  if (process.send) {
    process.on('message', (message) => { if (message?.type === 'stop') void stop(); });
    process.on('disconnect', () => { void stop(); });
  }
  // If a service dies unexpectedly, close all children owned by this launcher.
  for (const record of run.children) record.child.on('exit', () => { if (!stopping) { process.exitCode = 1; void stop(); } });
}
