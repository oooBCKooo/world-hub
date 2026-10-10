import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { privateJson, readBounded } from '../../../scripts/runtime/paths.mjs';

async function journal(t) {
  const directory = await mkdtemp(join(tmpdir(), 'world-hub-launcher-journal-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('world-hub-launcher-journal-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file: join(directory, 'status.json') };
}

test('LAUNCHER-JOURNAL-01 concurrent status polling observes only complete atomic generations', { timeout: 30000 }, async t => {
  const { directory, file } = await journal(t), payload = 'status-observation-'.repeat(4096);
  await privateJson(file, { generation: 0, payload });
  let done = false, reads = 0;
  const readers = Array.from({ length: 6 }, async () => {
    while (!done) {
      const value = JSON.parse((await readBounded(file)).toString('utf8'));
      assert.ok(Number.isInteger(value.generation)); assert.ok(value.generation >= 0 && value.generation <= 80);
      assert.equal(value.payload, payload); reads++;
    }
  });
  try {
    for (let generation = 1; generation <= 80; generation++) await privateJson(file, { generation, payload });
  } finally { done = true; await Promise.all(readers); }
  assert.ok(reads >= 80, `Only ${reads} concurrent reads were observed`);
  assert.equal(JSON.parse((await readBounded(file)).toString('utf8')).generation, 80);
  assert.deepEqual(await readdir(directory), ['status.json']);
});

if (process.platform === 'win32') for (const { id, holdMs, persistent } of [
  { id: '02', holdMs: 300, persistent: false },
  { id: '03', holdMs: 1500, persistent: false },
  { id: '04', holdMs: 5500, persistent: true },
]) test(`LAUNCHER-JOURNAL-${id} ${persistent ? 'persistent Windows denial preserves the previous generation and removes only its temporary write' : 'a transient Windows read handle permits atomic replacement after its release'}`,
  { timeout: 30000 }, async t => {
    const { directory, file } = await journal(t); await privateJson(file, { generation: 0 });
    // FileShare.ReadWrite deliberately omits Delete, reproducing a Windows
    // reader that temporarily prevents an otherwise valid atomic replacement.
    const script = `$stream = [System.IO.File]::Open($env:WORLD_HUB_TEST_ATOMIC_FILE, 'Open', 'Read', 'ReadWrite'); try { [Console]::Out.WriteLine('locked'); Start-Sleep -Milliseconds ${holdMs} } finally { $stream.Dispose() }`;
    const reader = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WORLD_HUB_TEST_ATOMIC_FILE: file } });
    let exited = false, stderr = '';
    const exit = new Promise((yes, no) => { reader.once('error', no); reader.once('close', (code, signal) => { exited = true; yes({ code, signal }); }); });
    t.after(async () => { if (!exited) reader.kill(); await exit; });
    reader.stderr.on('data', bytes => { stderr += bytes; });
    for (const stream of [reader.stdout, reader.stderr]) stream.on('error', error => { stderr += error.message; });
    await new Promise((yes, no) => {
      let output = '';
      reader.once('error', no);
      reader.stdout.on('data', bytes => { output += bytes; if (output.includes('locked')) yes(); });
      reader.once('close', code => { if (!output.includes('locked')) no(new Error(`Windows lock fixture failed (${code}): ${stderr}`)); });
    });
    const started = Date.now();
    if (persistent) await assert.rejects(privateJson(file, { generation: 1 }), error => ['EPERM', 'EACCES'].includes(error.code));
    else await privateJson(file, { generation: 1 });
    assert.ok(Date.now() - started >= (persistent ? 3800 : holdMs - 100), 'Replacement must wait for release or the bounded retry deadline');
    assert.deepEqual(await exit, { code: 0, signal: null }, stderr);
    assert.deepEqual(JSON.parse((await readBounded(file)).toString('utf8')), { generation: persistent ? 0 : 1 });
    assert.deepEqual(await readdir(directory), ['status.json']);
  });
