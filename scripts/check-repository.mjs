#!/usr/bin/env node
// Inspect the exact Git index before publishing; inspect the source allowlist before Git initialization.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directories = ['bin', 'src', 'sdk', 'config', 'examples', 'tests', 'scripts', 'tools', 'docs', '.github'];
const rootFiles = ['README.md', 'README.en.md', 'LICENSE', 'package.json', '.gitignore', '.gitattributes'];
const required = [...rootFiles, 'config/hub.json', 'src/hub/hub-server.mjs', 'src/hub/ws-server.mjs',
  'src/management/console.html', 'sdk/javascript/bridge-kit.mjs', 'sdk/javascript/blob-client.mjs',
  'src/ui/language.mjs', 'src/management/canvas-i18n.mjs', 'src/management/manual-i18n.mjs',
  'sdk/python/hub_bridge.py', 'sdk/python/requirements.txt', 'sdk/powershell/HubBridge.psm1',
  'sdk/powershell/HubBridge.cs', 'docs/specs/index.md', 'docs/onboarding.md',
  'bin/world-hub.mjs', 'tools/launcher/cli.mjs', 'tools/launcher/server.mjs', 'tools/launcher/public/index.html',
  'src/management/launcher-link.mjs', 'docs/ecosystem/launcher.md',
  'scripts/launcher.mjs', 'scripts/verify.mjs', 'scripts/release/build-package.mjs', '.github/workflows/ci.yml'];
const extensions = new Set(['.mjs', '.js', '.html', '.css', '.json', '.md', '.py', '.txt', '.psm1', '.cs', '.ps1', '.yml', '.yaml']);
const forbiddenSegments = new Set(['.local', '.artifacts', 'dist', 'data', 'world-hub-data', '.hub', '.state', 'node_modules', '__pycache__', '.venv']);
const screenshotPath = /^docs\/images\/[a-z0-9][a-z0-9._-]*\.(?:png|jpg)$/;
const ecosystemLock = 'examples/ecosystem-pack/pack.lock';
const ecosystemLicenses = new Set(['source', 'stats', 'desk'].map(name => `examples/ecosystem-pack/modules/${name}/LICENSE`));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegStartOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failures = [];
const reject = (path, reason) => failures.push({ path, reason });
const exists = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const posix = path => path.replaceAll('\\', '/');

function screenshotDimensions(path, bytes) {
  if (path.endsWith('.png')) {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngSignature)
        || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('Screenshot PNG has an invalid signature or dimension header');
    }
    if (bytes.length < 45 || bytes.readUInt32BE(bytes.length - 12) !== 0
        || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') {
      throw new Error('Screenshot PNG has no final IEND marker');
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) {
    throw new Error('Screenshot JPEG has an invalid start or end marker');
  }
  let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) throw new Error('Screenshot JPEG has an invalid marker');
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new Error('Screenshot JPEG has a truncated marker');
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) throw new Error('Screenshot JPEG has an invalid marker length');
    if (jpegStartOfFrame.has(marker)) {
      if (size < 8) throw new Error('Screenshot JPEG has a truncated dimension header');
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += size;
  }
  throw new Error('Screenshot JPEG has no supported dimension header');
}

async function collect(directory = '') {
  const result = [];
  for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory ? directory + '/' + item.name : item.name;
    if (!directory && !rootFiles.includes(item.name) && !directories.includes(item.name)) continue;
    if (forbiddenSegments.has(item.name)) continue;
    if (item.isDirectory()) result.push(...await collect(path));
    else result.push(path);
  }
  return result;
}

const indexed = Boolean(await exists(join(root, '.git')));
let paths = indexed
  ? execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean)
  : await collect();
paths = paths.sort();
const pathSet = new Set(paths);
const cases = new Map();
const entries = [];
for (const path of required) if (!pathSet.has(path)) reject(path, 'Required source file is absent from the publish set');

async function checkReference(path, target, label) {
  if (!target.startsWith('.')) return;
  const absolute = resolve(dirname(join(root, path)), decodeURIComponent(target.split(/[?#]/)[0]));
  const local = posix(relative(root, absolute));
  if (local.startsWith('../') || local === '..') { reject(path, label + ' escapes the repository'); return; }
  // Evidence directories are intentionally created at runtime and excluded from Git.
  if (local === '.artifacts' || local.startsWith('.artifacts/')) return;
  if (!await exists(absolute)) reject(path, label + ' is missing: ' + local);
  else if (!pathSet.has(local) && !(await exists(absolute)).isDirectory()) reject(path, label + ' is excluded from the publish set: ' + local);
}

for (const path of paths) {
  const segments = path.split('/');
  if (!rootFiles.includes(path) && !directories.includes(segments[0])) reject(path, 'Outside the final repository allowlist');
  if (segments.some(segment => forbiddenSegments.has(segment)) || /(?:\.bak|\.tmp|\.log|\.zip|\.py[co]|\.local\.json)$/i.test(path)
      || /(?:^|\/)(?:\.env(?:\..*)?|smoke-results\.json|self-check-result\.json|local[^/]*\.json)$/i.test(path)) reject(path, 'Local, generated or private file');
  if (path.startsWith('config/') && path !== 'config/hub.json') reject(path, 'Only the reference configuration can be published');
  const screenshot = screenshotPath.test(path);
  if (!rootFiles.includes(path) && !extensions.has(extname(path)) && !screenshot
      && path !== ecosystemLock && !ecosystemLicenses.has(path)) reject(path, 'Unexpected source file type');
  const key = path.toLowerCase();
  if (cases.has(key)) reject(path, 'Filename conflicts on case-insensitive filesystems');
  cases.set(key, path);
  const stat = await exists(join(root, path));
  if (!stat?.isFile() || stat.isSymbolicLink()) { reject(path, 'Publish entries must be regular files'); continue; }
  const bytes = await readFile(join(root, path));
  entries.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  if (bytes.length > 2 * 1024 * 1024) reject(path, 'Unexpectedly large source file');
  if (screenshot) {
    try {
      const { width, height } = screenshotDimensions(path, bytes);
      if (!width || !height || width > 8192 || height > 8192 || width * height > 32 * 1024 * 1024) {
        reject(path, 'Screenshot dimensions exceed the publication limit');
      }
    } catch (error) { reject(path, error.message); }
    continue;
  }
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { reject(path, 'Source is not UTF-8 text'); continue; }
  if (content.includes('\0')) reject(path, 'Binary data in source');
  if (ecosystemLicenses.has(path) && hash(bytes) !== hash(await readFile(join(root, 'LICENSE')))) reject(path, 'Sample module license differs from the project MIT license');
  if (path === ecosystemLock) {
    try {
      const lock = JSON.parse(content);
      if (lock.format !== 'world-hub.pack-lock/v1' || !Array.isArray(lock.modules)
          || lock.modules.length !== 3 || !lock.modules.every(module => ['modules/source', 'modules/stats', 'modules/desk'].includes(module.source))) {
        reject(path, 'Only the public three-module sample lock is accepted');
      }
    } catch { reject(path, 'Sample pack.lock is not a JSON deployment lock'); }
  }
  // Report filenames only. Never echo a matched credential into logs.
  if (/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{80,}?-----END)/.test(content)) reject(path, 'Possible real credential; review privately');
  if (/[A-Za-z]:[\\/](?:Users[\\/]|PerosProject[\\/]|AntigravityProject[\\/])/i.test(content)) reject(path, 'Personal machine path');
  if (extname(path) === '.mjs' || extname(path) === '.js') {
    for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g)) {
      // initModule copies this public SDK next to the generated author program.
      // Resolve only that exact materialized import; other template imports
      // must still refer to a real published source file.
      if (path === 'scripts/runtime/templates/node/program.mjs' && match[1] === './bridge-kit.mjs') {
        await checkReference(path, '../../../../sdk/javascript/bridge-kit.mjs', 'Generated SDK source');
      } else await checkReference(path, match[1], 'Relative import');
    }
    for (const match of content.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) await checkReference(path, match[1], 'Module URL');
  }
  if (extname(path) === '.md') {
    const prose = content.replace(/```[\s\S]*?```/g, '');
    for (const match of prose.matchAll(/\[[^\]]*\]\((<?[^)]+>?)\)/g)) {
      const target = match[1].replace(/^<|>$/g, '');
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      await checkReference(path, target.startsWith('.') ? target : './' + target, 'Documentation link');
    }
  }
}

const report = { mode: indexed ? 'git-index' : 'source-allowlist', passed: failures.length === 0,
  files: entries.length, bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
  manifestSha256: hash(entries.map(entry => entry.path + '\0' + entry.sha256 + '\n').join('')),
  failures, ...(process.argv.includes('--json') ? { entries } : {}) };
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (!report.passed) process.exitCode = 1;
