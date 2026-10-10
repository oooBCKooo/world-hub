import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace, environment, json, save } from '../launcher/helpers.mjs';
import { initModule, validateModuleDirectory, doctorModule } from '../../../scripts/runtime/developer.mjs';
const execute = promisify(execFile);
test('AUTHOR-01 generated Node/Python samples are complete, self-test separately and doctor never launches entries', { timeout: 60000 }, async t => {
  const app = await workspace(t);
  for (const runtime of ['node', 'python']) {
    const directory = join(app.directory, runtime); const generated = await initModule({ directory, id: `author.${runtime}`, runtime });
    assert.equal(generated.startsModules, false); assert.equal(generated.installsDependencies, false);
    assert.equal((await validateModuleDirectory({ directory })).ok, true);
    const entry = join(directory, generated.manifest.runtime.entry), original = await readFile(entry);
    await writeFile(entry, runtime === 'node' ? 'throw new Error("Doctor executed code");' : 'raise Exception("Doctor executed code")');
    assert.equal((await doctorModule({ directory, ...environment })).ok, true);
    await writeFile(entry, original);
    await execute(runtime === 'node' ? process.execPath : environment.pythonPath, runtime === 'node' ? ['--test', 'logic.test.mjs'] : ['-B', '-m', 'unittest', 'test_logic.py'], { cwd: directory, windowsHide: true });
    await assert.rejects(initModule({ directory, id: 'author.another', runtime }), /EEXIST/);
    await unlink(entry); const missing = await validateModuleDirectory({ directory }); assert.equal(missing.ok, false); assert.ok(missing.issues.some(issue => issue.code === 'MODULE_ENTRY_MISSING' && issue.path === generated.manifest.runtime.entry && issue.remedy));
    const manifest = await json(join(directory, 'module.json')); delete manifest.runtime; await save(join(directory, 'module.json'), manifest);
    assert.equal((await validateModuleDirectory({ directory })).issues[0].code, 'MODULE_MANIFEST_INVALID');
  }
  const bad = await doctorModule({ directory: join(app.directory, 'absent') }); assert.equal(bad.ok, false); assert.equal(bad.issues[0].code, 'MODULE_PATH_INVALID');
});
