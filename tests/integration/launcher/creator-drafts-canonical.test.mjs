import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, toNamespacedPath } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CreatorDrafts } from '../../../tools/launcher/creator-drafts.mjs';
import { workspace } from './helpers.mjs';

const draft = (directory, selection = 'provider') => ({
  format: 'world-hub.creator-draft/v1', directory, baseRevision: 'a'.repeat(64),
  pack: { format: 'world-hub.pack/v1', id: 'draft.identity', components: [] },
  replacements: [], formValues: {}, selection, updatedAt: new Date().toISOString(),
});

test('DRAFT-CANONICAL-01 a missing source can be discarded, other sources survive, and write failures retain the draft', async t => {
  const app = await workspace(t), source = join(app.directory, 'SourceMixedCaseLongDirectory'), other = source + '-other';
  await mkdir(source); await mkdir(other);
  let registry = new CreatorDrafts(app.root); await registry.initialize();
  const saved = await registry.save(draft(source)), retained = await registry.save(draft(other));
  assert.equal(saved.draft.directory, await realpath(source));
  const stored = JSON.parse(await readFile(registry.file, 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['drafts', 'format']);
  assert.deepEqual(Object.keys(saved.draft).sort(), Object.keys(draft(source)).sort());
  await assert.rejects(registry.save({ ...draft(source), reviewId: 'forbidden-authority' }), { code: 'DRAFT_INVALID' });

  await rm(source, { recursive: true });
  registry = new CreatorDrafts(app.root); await registry.initialize();
  assert.equal((await registry.list()).drafts.length, 2);
  await registry.delete(saved.draft.directory);
  assert.deepEqual((await registry.list()).drafts, [retained.draft]);

  const write = registry.write;
  registry.write = async () => { throw Object.assign(new Error('Private registry write denied'), { code: 'EACCES' }); };
  await assert.rejects(registry.delete(retained.draft.directory), { code: 'EACCES' });
  assert.deepEqual((await registry.list()).drafts, [retained.draft]);
  registry.write = write;
  await registry.delete(retained.draft.directory);
  assert.equal((await registry.list()).drafts.length, 0);
  app.record('draft-identity-missing-source', { sourceGone: true, otherDraftPreserved: true, writeFailurePropagated: true, queueRecovered: true });
});

test('DRAFT-CANONICAL-02 aliases never follow links or remove a different source; the exact saved record remains discardable', async t => {
  const app = await workspace(t), source = join(app.directory, 'source'), other = join(app.directory, 'other'), linked = join(app.directory, 'linked');
  await mkdir(source); await mkdir(other);
  const registry = new CreatorDrafts(app.root); await registry.initialize();
  const saved = await registry.save(draft(source)), retained = await registry.save(draft(other));
  await symlink(other, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(registry.delete(linked), /Symbolic links or reparse paths are not accepted/);
  assert.equal((await registry.list()).drafts.length, 2);
  await rm(source, { recursive: true });
  await symlink(other, source, process.platform === 'win32' ? 'junction' : 'dir');
  await registry.delete(saved.draft.directory);
  assert.deepEqual((await registry.list()).drafts, [retained.draft]);
  assert.equal(await realpath(source), retained.draft.directory);
  app.record('draft-discard-is-registry-only', { linkedAliasRefused: true, replacedSourceRecordDiscarded: true, linkedTargetPreserved: true });
});

test('DRAFT-CANONICAL-03 Windows case, real 8.3 aliases and namespace paths share a draft identity', { skip: process.platform !== 'win32' }, async t => {
  const app = await workspace(t), source = join(app.directory, 'SourceMixedCaseLongDirectory'), other = source + '-other', replacement = join(source, 'ReplacementMixedCaseLongDirectory');
  await mkdir(replacement, { recursive: true }); await mkdir(other);
  const canonical = await realpath(source), canonicalReplacement = await realpath(replacement);
  const script = "$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $fso = New-Object -ComObject Scripting.FileSystemObject; [Console]::Out.Write($fso.GetFolder($env:WH_DRAFT_ALIAS_TEST).ShortPath)";
  // A cold Windows PowerShell/COM startup can exceed five seconds on a hosted
  // runner. This bounds only the path fixture, not a program or Hub operation.
  const shortPath = value => execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, WH_DRAFT_ALIAS_TEST: value }, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const shortSource = shortPath(source), shortReplacement = shortPath(replacement);
  const distinctShortAlias = shortSource.toLowerCase() !== canonical.toLowerCase();
  if (!distinctShortAlias) t.diagnostic('This volume has no distinct 8.3 alias; case and namespace identity still run.');
  const aliases = [source.toLowerCase(), shortSource, toNamespacedPath(source)];
  let registry = new CreatorDrafts(app.root); await registry.initialize();
  const retained = await registry.save(draft(other));
  for (const device of ['\\\\.\\pipe\\world-hub-draft', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\draft', '\\\\?\\UNC\\server', '\\\\?\\UNC\\server\\..\\draft', '\\\\?\\C:relative']) {
    await assert.rejects(registry.save(draft(device)), { code: 'DRAFT_INVALID' });
    await assert.rejects(registry.delete(device), { code: 'DRAFT_INVALID' });
  }
  assert.deepEqual((await registry.list()).drafts, [retained.draft]);
  for (const [index, alias] of aliases.entries()) {
    await registry.save(draft(source));
    const input = { ...draft(alias, `alias-${index}`), replacements: [{ componentId: 'provider', moduleDirectory: shortReplacement, candidateDigest: 'b'.repeat(64) }] };
    const saved = await registry.save(input);
    assert.equal(saved.draft.directory, canonical);
    assert.equal(saved.draft.replacements[0].moduleDirectory, canonicalReplacement);
    assert.equal(saved.draft.replacements[0].candidateDigest, 'b'.repeat(64));
    assert.equal((await registry.list()).drafts.length, 2, 'Saving an alias must replace its existing draft');
    registry = new CreatorDrafts(app.root); await registry.initialize();
    assert.equal((await registry.list()).drafts[0].selection, `alias-${index}`);
    const deleted = await registry.delete(alias);
    assert.equal(deleted.deleted, true); assert.equal(deleted.directory, canonical);
    assert.deepEqual((await registry.list()).drafts, [retained.draft], 'Discard must keep the distinct source with a shared path prefix');
  }
  // Also resolve a remaining short-name parent when the source itself is gone.
  await registry.save(draft(shortSource));
  const shortParent = shortPath(app.directory), missingAlias = join(shortParent, 'SourceMixedCaseLongDirectory');
  await rm(source, { recursive: true });
  await registry.delete(missingAlias);
  assert.deepEqual((await registry.list()).drafts, [retained.draft]);
  // Reading/discarding this private record must not contact an unavailable
  // UNC source. Both spellings still identify the same saved source.
  const uncRoot = join(app.root, 'unc-record'), uncNamespace = '\\\\?\\UNC\\draft-host.invalid\\share\\source', uncOrdinary = '\\\\draft-host.invalid\\share\\source';
  await mkdir(uncRoot);
  const uncRegistry = new CreatorDrafts(uncRoot);
  await writeFile(uncRegistry.file, JSON.stringify({ format: 'world-hub.creator-drafts/v1', drafts: [draft(uncNamespace)] }));
  await uncRegistry.initialize();
  assert.equal((await uncRegistry.list()).drafts[0].directory, uncOrdinary);
  assert.equal((await uncRegistry.delete(uncNamespace)).directory, uncOrdinary);
  assert.equal((await uncRegistry.list()).drafts.length, 0);
  app.record('draft-windows-path-identity', { caseInsensitive: true, namespaceAccepted: true, uncNamespaceDiscarded: true, realShortAlias: distinctShortAlias, missingSourceParentResolved: true });
});
