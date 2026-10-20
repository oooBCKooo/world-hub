import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, lstat, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { probe, discoverEnvironment } from '../../../tools/launcher/environment.mjs';
import { environment, workspace } from '../launcher/helpers.mjs';

async function withPath(value, operation) {
  const before = process.env.PATH;
  process.env.PATH = value;
  try { return await operation(); }
  finally { if (before === undefined) delete process.env.PATH; else process.env.PATH = before; }
}

async function runtimeAliases(directory) {
  const node = await realpath(process.execPath);
  // The operating system can resolve its normal python3 alias even when a
  // candidate-discovery regression incorrectly filters that alias out.
  const python = await realpath(execFileSync(environment.pythonPath,
    ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true }).trim());
  const names = process.platform === 'win32' ? { node: 'node.exe', python: 'python.exe' } : { node: 'node', python: 'python3' };
  const aliases = {};
  if (process.platform === 'win32') {
    // Directory junctions need no Windows file-symlink privilege. Linux below
    // exercises the actual file-symlink layout used by setup-python and /usr/bin.
    for (const [kind, executable] of Object.entries({ node, python })) {
      const home = join(directory, `${kind}-home`);
      await symlink(dirname(executable), home, 'junction');
      assert.equal((await lstat(home)).isSymbolicLink(), true);
      aliases[kind] = join(home, names[kind]);
    }
  } else {
    for (const [kind, executable] of Object.entries({ node, python })) {
      aliases[kind] = join(directory, names[kind]);
      await symlink(executable, aliases[kind], 'file');
      assert.equal((await lstat(aliases[kind])).isSymbolicLink(), true);
    }
  }
  return { targets: { node, python }, aliases, names, path: [...new Set(Object.values(aliases).map(dirname))].join(delimiter) };
}

test('interpreter PATH aliases discover and probe actual Node and Python canonical files', async t => {
  const app = await workspace(t), aliases = await runtimeAliases(app.directory);
  await withPath(aliases.path, async () => {
    for (const kind of ['node', 'python']) {
      const result = await probe(aliases.names[kind], kind);
      assert.equal(result.available, true, JSON.stringify(result));
      assert.equal(result.executable, aliases.targets[kind]);
      assert.match(result.version, /^\d+\.\d+\.\d+$/);
      const explicit = await probe(aliases.aliases[kind], kind);
      assert.deepEqual(explicit, result);
    }
    const found = await discoverEnvironment({ nodePath: join(app.directory, 'not-selected') });
    for (const kind of ['node', 'python']) {
      const target = found[kind].find(row => row.path === aliases.targets[kind]);
      assert.ok(target, `${kind} PATH alias must be discoverable`);
      assert.equal(target.source, 'PATH');
      assert.equal(target.probed, false);
      assert.equal(found[kind].filter(row => row.path === aliases.targets[kind]).length, 1);
    }
  });
  app.record('real-interpreter-aliases', { linkType: process.platform === 'win32' ? 'directory-junction' : 'file-symlink', canonicalNode: true, canonicalPython: true });
});

test('interpreter discovery and probing reject non-file targets and broken aliases', async t => {
  const app = await workspace(t), names = process.platform === 'win32' ? ['node.exe', 'python.exe'] : ['node', 'python3'];
  const directoryTarget = join(app.directory, 'not-an-executable'); await mkdir(directoryTarget);
  if (process.platform === 'win32') {
    await symlink(directoryTarget, join(app.directory, names[0]), 'junction');
    await symlink(join(app.directory, 'absent-target'), join(app.directory, names[1]), 'junction');
  } else {
    await symlink(directoryTarget, join(app.directory, names[0]), 'dir');
    await symlink(join(app.directory, 'absent-target'), join(app.directory, names[1]), 'file');
  }
  await withPath(app.directory, async () => {
    assert.equal((await probe(names[0], 'node')).available, false);
    assert.equal((await probe(names[1], 'python')).available, false);
    const found = await discoverEnvironment({ nodePath: join(app.directory, names[0]), pythonPath: join(app.directory, names[1]) });
    assert.equal(found.node.length, 0);
    assert.ok(found.python.every(row => !row.path.startsWith(app.directory)));
  });
  app.record('non-executable-aliases-rejected', { directoriesRejected: true, danglingLinksRejected: true });
});

// POSIX supports executable script wrappers with no compiler or extra tools.
// Register this actual wrapper fixture only on that platform, without skipped tests.
if (process.platform !== 'win32') test('discovery does not execute candidates and probing rejects a wrapper-reported different executable', async t => {
  const app = await workspace(t), marker = join(app.directory, 'executed'), wrapper = join(app.directory, 'wrapper.sh');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const response = JSON.stringify({ executable: await realpath(process.execPath), version: process.versions.node, arch: process.arch, packages: {} });
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' probe-ran >> ${quote(marker)}\nprintf '%s\\n' ${quote(response)}\n`, { mode: 0o700 });
  await symlink(wrapper, join(app.directory, 'node'), 'file');
  await withPath(app.directory, async () => {
    const found = await discoverEnvironment({ nodePath: join(app.directory, 'not-selected') });
    assert.ok(found.node.some(row => row.path === wrapper && row.probed === false));
    await assert.rejects(access(marker), { code: 'ENOENT' });
    const result = await probe('node', 'node');
    assert.equal(result.available, false);
    assert.match(result.error, /Interpreter wrappers are unsupported/);
    await access(marker);
  });
  app.record('discovery-does-not-execute-and-wrapper-refused', { discoveryReadOnly: true, differentReportedExecutableRejected: true });
});
