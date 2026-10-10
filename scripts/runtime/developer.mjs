// Optional author conveniences, independent of the Hub communication protocol.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { repository, validateModule, safeId } from './package.mjs';
import { ordinaryPath, collectFiles, readBounded, privateJson, hash } from './paths.mjs';
import { probe } from '../../tools/launcher/environment.mjs';

export const AUTHOR_TEMPLATE_FILES = Object.freeze(['scripts/runtime/templates/node/program.mjs', 'scripts/runtime/templates/node/logic.mjs',
  'scripts/runtime/templates/node/logic.test.mjs', 'scripts/runtime/templates/python/program.py', 'scripts/runtime/templates/python/logic.py', 'scripts/runtime/templates/python/test_logic.py']);
const issue = (path, stage, code, message, remedy) => ({ path, stage, code, message, remedy });
const base = directory => ({ format: 'world-hub.module-check/v1', directory, ok: true, issues: [], startsModules: false, installsDependencies: false, behaviorValidated: false });

export async function initModule({ directory, id, runtime }) {
  safeId(id, 'module ID');
  if (!['node', 'python'].includes(runtime)) throw new Error('Choose --runtime node or python');
  const target = await ordinaryPath(directory, { allowMissing: true });
  const files = runtime === 'node' ? ['program.mjs', 'logic.mjs', 'logic.test.mjs'] : ['program.py', 'logic.py', 'test_logic.py'];
  const sdkFiles = runtime === 'node' ? ['bridge-kit.mjs', 'blob-client.mjs'] : ['hub_bridge.py', 'requirements.txt'];
  const inputs = new Map();
  for (const file of files) inputs.set(file, await readBounded(join(repository, 'scripts/runtime/templates', runtime, file)));
  for (const file of sdkFiles) inputs.set(file, await readBounded(join(repository, 'sdk', runtime === 'node' ? 'javascript' : 'python', file)));
  inputs.set('LICENSE', await readBounded(join(repository, 'LICENSE')));
  inputs.set('text-statistics.contract.json', await readBounded(join(repository, 'docs/modules/text-statistics.contract.json')));
  const manifest = { format: 'world-hub.module/v1', id, version: '1.0.0', license: 'MIT',
    platforms: ['win32-x64', 'linux-x64', 'darwin-arm64'], runtime: { kind: runtime, entry: runtime === 'node' ? 'program.mjs' : 'program.py' },
    bridges: ['main'], provides: [{ id: 'text.statistics', version: '1.0.0' }], requires: [],
    permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } };
  validateModule(manifest);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o700 }); // Existing directories are never overwritten.
  try {
    for (const [file, bytes] of inputs) await writeFile(join(target, file), bytes, { flag: 'wx', mode: 0o600 });
    if (runtime === 'node') await privateJson(join(target, 'package.json'), { private: true, type: 'module', scripts: { test: 'node --test logic.test.mjs' } }, { exclusive: true });
    await privateJson(join(target, 'module.json'), manifest, { exclusive: true });
    await privateJson(join(target, 'author-sample.json'), { format: 'world-hub.author-sample/v1', profile: 'text.statistics/1.0.0',
      requiredFiles: [...inputs.keys()], contractSha256: hash(inputs.get('text-statistics.contract.json')) }, { exclusive: true });
    await writeFile(join(target, 'README.md'), `# ${id}\n\nOptional ${runtime} text.statistics 1.0.0 author sample. You own its business logic; this is not a required application shape.\n\n` +
      `Validate: world-hub-pack validate-module "${target}"\nDoctor: world-hub-pack doctor-module "${target}"\nSelf-test: ${runtime === 'node' ? 'node --test logic.test.mjs' : 'python -B -m unittest test_logic.py'}\n\n` +
      'The optional Runtime supplies --runtime-config. Public settings topicKey (default stats) and callerId (default desk) select the topic alias and authorized peer. No endpoints, private tokens or live state are distributed.\n\n' +
      'Read docs/ecosystem/developer.md, docs/modules/provider-contract.md and the SDK documentation. Validation is static; self-tests exercise this sample only. Use a real consumer to verify business interoperability. No dependencies are installed or code executed by generation. Permissions are declarations, not OS enforcement.\n', { flag: 'wx', mode: 0o600 });
    return { format: 'world-hub.module-init/v1', directory: target, manifest, startsModules: false, installsDependencies: false, behaviorValidated: false };
  } catch (error) { error.incompleteDestination = target; throw error; }
}

export async function validateModuleDirectory({ directory }) {
  const result = base(directory);
  let root, manifest, files;
  try { root = await ordinaryPath(directory); result.directory = root; files = await collectFiles(root); }
  catch (error) { result.issues.push(issue(directory, 'files', 'MODULE_PATH_INVALID', error.message, 'Select an ordinary directory with bounded regular files; remove links and generated caches.')); }
  if (root && files) {
    try { manifest = JSON.parse((await readBounded(join(root, 'module.json'))).toString('utf8')); validateModule(manifest); result.manifest = manifest; }
    catch (error) { manifest = null; result.issues.push(issue('module.json', 'manifest', 'MODULE_MANIFEST_INVALID', error.message, 'Correct module.json against the optional Runtime module schema.')); }
    if (manifest && !files.some(file => file.path === manifest.runtime.entry)) result.issues.push(issue(manifest.runtime.entry, 'entry', 'MODULE_ENTRY_MISSING', 'Declared runtime entry is absent.', 'Provide the declared entry file or correct runtime.entry.'));
    if (manifest && !manifest.platforms.includes(`${process.platform}-${process.arch}`)) result.issues.push(issue('module.json/platforms', 'platform', 'MODULE_PLATFORM_UNSUPPORTED', 'This machine is outside the declared platforms.', 'Use a supported machine; declare another platform only after validating it.'));
    if (files.some(file => file.path === 'author-sample.json')) {
      try {
        const sample = JSON.parse((await readBounded(join(root, 'author-sample.json'))).toString());
        if (sample.format !== 'world-hub.author-sample/v1' || sample.profile !== 'text.statistics/1.0.0' || !Array.isArray(sample.requiredFiles) || sample.requiredFiles.length > 32 || !/^[a-f0-9]{64}$/.test(sample.contractSha256)) throw new Error('Invalid sample metadata');
        for (const file of sample.requiredFiles) if (!files.some(item => item.path === file)) result.issues.push(issue(file, 'sample', 'SAMPLE_FILE_MISSING', 'Author sample file is absent.', 'Restore the SDK, contract or sample file; remove the optional sample marker when adopting a different layout.'));
        const contract = files.find(file => file.path === 'text-statistics.contract.json');
        if (contract && contract.sha256 !== sample.contractSha256) result.issues.push(issue(contract.path, 'contract', 'SAMPLE_CONTRACT_CHANGED', 'The bundled sample contract changed.', 'Use the agreed immutable contract version; changing a digest does not establish compatibility.'));
      } catch (error) { result.issues.push(issue('author-sample.json', 'sample', 'SAMPLE_METADATA_INVALID', error.message, 'Repair the optional sample metadata or remove it when adopting another layout.')); }
    }
    result.contentDigest = hash(JSON.stringify(files));
  }
  result.ok = result.issues.length === 0; return result;
}
export async function doctorModule(input) {
  const result = await validateModuleDirectory(input);
  if (!result.manifest) return result;
  const kind = result.manifest.runtime.kind, executable = kind === 'node' ? input.nodePath ?? process.execPath : input.pythonPath ?? (process.platform === 'win32' ? 'python.exe' : 'python3');
  result.interpreter = await probe(executable, kind); result.runsFixedInterpreterProbe = true;
  if (!result.interpreter.available) result.issues.push(issue(executable, 'environment', 'INTERPRETER_UNAVAILABLE', result.interpreter.error, `Select an installed trusted ${kind} interpreter with --${kind === 'node' ? 'node' : 'python'}.`));
  else if (kind === 'node' && (Number(result.interpreter.version.split('.')[0]) < 22 || result.interpreter.version.startsWith('22.') && Number(result.interpreter.version.split('.')[1]) < 4)) result.issues.push(issue(executable, 'environment', 'INTERPRETER_VERSION', 'Node 22.4.0 or newer is required by this SDK.', 'Choose a supported trusted Node interpreter.'));
  if (kind === 'python' && result.interpreter.available) {
    let requirement;
    try { requirement = (await readBounded(join(result.directory, 'requirements.txt'))).toString(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const version = requirement?.match(/^websockets==([0-9.]+)$/m)?.[1];
    if (version && result.interpreter.packages?.websockets !== version) result.issues.push(issue('requirements.txt', 'dependency', 'DEPENDENCY_MISMATCH', `Requires websockets ${version}; selected interpreter has ${result.interpreter.packages?.websockets ?? 'none'}.`, 'Prepare the declared dependency in your chosen private environment; doctor does not install it.'));
    result.otherDependenciesChecked = false;
  }
  result.ok = result.issues.length === 0; return result;
}
