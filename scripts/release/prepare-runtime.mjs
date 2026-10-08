import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NODE_VERSION = '22.23.2';
export async function prepareRuntime({ node = process.execPath, download = false, output }) {
  if (!download && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('A supplied executable must be verified on Windows x64; use --download to prepare the Windows package on another host');
  const directory = resolve(output);
  await mkdir(directory, { recursive: false });
  const checksumUrl = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`;
  const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`;
  const get = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Official runtime metadata download failed: ${response.status} ${url}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const checksums = await get(checksumUrl);
  const expected = checksums.toString('utf8').split(/\r?\n/).find(line => /^\w{64}\s+win-x64\/node\.exe$/.test(line.trim()))?.split(/\s+/)[0];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Official win-x64/node.exe checksum missing');
  const executableUrl = `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`;
  const executable = download ? await get(executableUrl) : await readFile(resolve(node));
  const sha256 = createHash('sha256').update(executable).digest('hex');
  if (sha256 !== expected) throw new Error(`Node executable does not match official v${NODE_VERSION} checksum`);
  // Never execute the supplied binary until it matches the official checksum.
  if (!download) {
    const actualVersion = execFileSync(resolve(node), ['--version'], { windowsHide: true, encoding: 'utf8' }).trim();
    if (actualVersion !== `v${NODE_VERSION}`) throw new Error('Runtime reports an unexpected version');
  }
  const license = await get(licenseUrl);
  if (!license.toString('utf8').startsWith('Node.js is licensed for use as follows:') || license.length < 100000) throw new Error('Incomplete official Node license/notices');
  await writeFile(join(directory, 'node.exe'), executable, { flag: 'wx' });
  await writeFile(join(directory, 'LICENSE'), license, { flag: 'wx' });
  await writeFile(join(directory, 'SHASUMS256.txt'), checksums, { flag: 'wx' });
  const provenance = { version: NODE_VERSION, platform: 'win32', arch: 'x64', sha256, checksumUrl, executableUrl, licenseUrl, licenseSha256: createHash('sha256').update(license).digest('hex'), verifiedAt: new Date().toISOString(), verification: 'Binary checksum matches official HTTPS SHASUMS256; no signed checksum verification claimed' };
  await writeFile(join(directory, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
  return { directory, ...provenance };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--node') options.node = args[++i];
    else if (args[i] === '--download') options.download = true;
    else if (args[i] === '--output') options.output = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!options.output) throw new Error('Use --output <new runtime directory> [--download | --node <installed official node.exe>]');
  if (options.download && options.node) throw new Error('--download and --node are alternatives');
  try { console.log(JSON.stringify(await prepareRuntime(options))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
