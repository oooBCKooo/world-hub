#!/usr/bin/env node
import { mkdir, copyFile, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ordinaryPath } from '../runtime/paths.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
export const authorKitFiles = Object.freeze(['LICENSE', 'docs/modules/provider-contract.md', 'docs/modules/text-statistics.contract.json',
  'docs/specs/protocol.md', 'docs/specs/reliability-access.md', 'docs/specs/directed-and-bulk.md', 'docs/onboarding.md', 'docs/npm.md', 'docs/verification.md', 'sdk/javascript/bridge-kit.mjs', 'sdk/javascript/blob-client.mjs', 'sdk/javascript/README.md',
  'sdk/python/hub_bridge.py', 'sdk/python/requirements.txt', 'sdk/python/README.md']);
export async function buildIndependentAuthorKit(output) {
  const directory = resolve(output); await ordinaryPath(directory, { allowMissing: true });
  try { await lstat(directory); throw new Error('Choose a new destination; existing content is retained'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(directory, { recursive: false });
  for (const path of authorKitFiles) {
    await ordinaryPath(join(root, path)); await mkdir(dirname(join(directory, path)), { recursive: true }); await copyFile(join(root, path), join(directory, path));
  }
  await writeFile(join(directory, 'README.md'), `# Independent author acceptance kit / 独立作者资料包\n\nRead the provider contract, machine-readable contract and chosen SDK documentation. Implement a provider from scratch without existing providers, author templates or hidden-test source. The operator supplies a disposable endpoint, identity/credential, module id, directory topic, business topic and authorized caller. Record help and failures as well as success. Never publish credentials.\n\n请只阅读提供者契约、机器契约与所选语言的 SDK 文档，从头实现提供者。部署方另行提供专用通信地址、身份／凭据、模块 ID、目录主题、业务主题和授权调用方。记录求助和失败，勿公开凭据。\n\nThis kit does not claim that a human participant has completed acceptance. 本资料包不表示真人已经验收通过。\n`);
  await writeFile(join(directory, 'acceptance-record.json'), JSON.stringify({ format: 'world-hub.independent-author-record/v1', status: 'not-executed',
    participantAlias: null, participatedInProjectDevelopment: null, previousProjectExperience: null,
    allowedMaterials: authorKitFiles, language: null, runtimeVersion: null, startedAt: null, finishedAt: null,
    checkpoints: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'].map(id => ({ id, status: 'not-executed', evidence: [], helpRequired: [], failures: [] })),
    credentialsExcluded: true, sourceHashes: {}, artifactHashes: {}, operatorVerified: false }, null, 2) + '\n');
  return { directory, files: [...authorKitFiles, 'README.md', 'acceptance-record.json'], humanAcceptanceCompleted: false, containsExistingProvider: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output' || !args[1]) throw new Error('Use --output <new-existing-parent-directory>');
  console.log(JSON.stringify(await buildIndependentAuthorKit(args[1])));
}
