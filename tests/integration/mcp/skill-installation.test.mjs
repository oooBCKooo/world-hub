import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSkillCli, SKILL_FILES } from '../../../bin/world-hub-skill.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function temporary(t) {
  const parent = resolve(tmpdir()), path = await mkdtemp(join(parent, 'world-hub-skill-'));
  t.after(async () => { assert.equal(dirname(path), parent); assert.ok(path.startsWith(parent + sep)); await rm(path, { recursive: true, force: true }); });
  return path;
}
function execute(entry, args, cwd) {
  const result = spawnSync(process.execPath, [join(root, 'bin', entry), ...args], { cwd, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); return result;
}

test('packaged Skill installs to an explicit new client directory with exact content and portable references', async t => {
  const cwd = await temporary(t), destination = join(cwd, 'my-agent/.agents/skills/world-hub');
  const result = execute('world-hub-skill.mjs', ['--install', destination], cwd);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout); assert.equal(report.installed, true); assert.equal(report.startsPrograms, false);
  assert.equal(report.destination, destination); assert.deepEqual(report.files.map(row => row.path), SKILL_FILES);
  for (const entry of report.files) {
    const bytes = await readFile(join(destination, entry.path));
    assert.equal(digest(bytes), entry.sha256); assert.deepEqual(bytes, await readFile(join(root, 'skills/world-hub', entry.path)));
    for (const match of bytes.toString('utf8').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(match[1])) continue;
      const target = resolve(dirname(join(destination, entry.path)), match[1]);
      assert.ok(target.startsWith(destination + sep), 'copied Skill references must remain within the installed Skill');
      await readFile(target);
    }
  }
  for (const file of ['LICENSE', 'NOTICE']) assert.deepEqual(await readFile(join(destination, file)), await readFile(join(root, file)));
  assert.match(await readFile(join(destination, 'SKILL.md'), 'utf8'), /^license: Apache-2\.0$/m);
  assert.deepEqual(await readdir(cwd), ['my-agent']);
});

test('a pre-existing Skill destination is preserved byte for byte on attempted reinstall', async t => {
  const cwd = await temporary(t), destination = join(cwd, 'world-hub');
  await runSkillCli(['--install', destination], { output() {} });
  const marker = join(destination, 'SKILL.md'); await writeFile(marker, 'user-owned skill content\n');
  const result = execute('world-hub-skill.mjs', ['--install', destination], cwd);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /already exists/);
  assert.equal(await readFile(marker, 'utf8'), 'user-owned skill content\n');
});

test('Skill inspection and optional MCP help are read-only from an unrelated directory', async t => {
  const cwd = await temporary(t);
  const checked = execute('world-hub-skill.mjs', ['--check'], cwd); assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).installed, false);
  const path = execute('world-hub-skill.mjs', ['--path'], cwd); assert.equal(path.status, 0);
  assert.equal(resolve(path.stdout.trim()), join(root, 'skills/world-hub'));
  const help = execute('world-hub-mcp.mjs', ['--help'], cwd); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /stdio/);
  const invalid = execute('world-hub-skill.mjs', ['--install'], cwd); assert.notEqual(invalid.status, 0);
  assert.deepEqual(await readdir(cwd), []);
});
