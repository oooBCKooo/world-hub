import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackage } from './verify-package.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function verifyDemoPackage(root = defaultRoot) {
  root = resolve(root);
  const profile = JSON.parse(await readFile(resolve(root, 'demo-profile.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  if (profile.schemaVersion !== 1 || typeof profile.profile !== 'string'
    || profile.profile !== manifest.purposeProfile || profile.version !== manifest.version
    || manifest.mutable?.length !== 1 || manifest.mutable[0] !== 'data/**') {
    throw new Error('Invalid or mismatched demo package profile');
  }
  return verifyPackage(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--root' || !args[1].trim() || args[1].startsWith('--'))) {
      throw new Error('Use verify-demo-package.mjs [--root <package directory>]; configuration-change bypass is not supported');
    }
    const result = await verifyDemoPackage(args.length ? args[1] : defaultRoot);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
