// Public, read-only projections of validated immutable distribution bytes.
// No extraction, interpreter probing, dependency installation or module execution.
import { validateArtifactBytes } from '../../scripts/runtime/sources.mjs';
import { validateDeployment, validateDeploymentSettings } from '../../scripts/runtime/deployment.mjs';
import { initialExecutionPolicy } from '../../scripts/runtime/execution-defaults.mjs';
import { hash, relativePath } from '../../scripts/runtime/paths.mjs';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const clone = value => structuredClone(value);
function json(files, path) {
  const file = files.find(item => item.path === path);
  if (!file) return null;
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
  if (!plain(value)) fail('Configuration source must contain a JSON object.');
  return { value, sha256: hash(file.bytes), path };
}
function dependencyMap(value) {
  if (value === undefined) return {};
  if (!plain(value) || Object.keys(value).length > 256) fail('Dependency declarations exceed their bound.');
  return Object.fromEntries(Object.entries(value).map(([name, version]) => {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || typeof version !== 'string' || !version || version.length > 1024 || /[\0\r\n]/.test(version)) fail('Invalid package dependency declaration.');
    // Registry credentials are not a public dependency version. A URL with
    // credentials is never copied into a preview or public information page.
    if (/^(?:git\+)?https?:\/\//i.test(version)) {
      const url = new URL(version.replace(/^git\+/, ''));
      if (url.username || url.password || url.search) fail('Dependency URLs cannot contain credentials or query parameters.');
    }
    return [name, version];
  }));
}
function inspectDependencies(files, deployment) {
  const pkg = json(files, 'package.json'), lock = json(files, 'package-lock.json');
  let npm = null;
  if (pkg) {
    npm = { path: pkg.path, sha256: pkg.sha256,
      ...Object.fromEntries(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].map(key => [key, dependencyMap(pkg.value[key])])),
      lock: lock ? { path: lock.path, sha256: lock.sha256, lockfileVersion: lock.value.lockfileVersion ?? null,
        packageCount: plain(lock.value.packages) ? Math.max(0, Object.keys(lock.value.packages).length - 1) : null } : null };
  }
  if (deployment?.dependencies) {
    if (!pkg || !lock || lock.value.lockfileVersion !== 3 || !plain(lock.value.packages) || !plain(lock.value.packages['']) || Object.keys(lock.value.packages).length > 257) fail('An installation recipe requires a complete bounded npm lock v3.');
    for (const [path, item] of Object.entries(lock.value.packages)) {
      if (!path) continue;
      relativePath(path);
      if (!/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/i.test(path) || !plain(item) || item.link) fail('Dependency must be an ordinary registry package.');
      const url = new URL(item.resolved);
      if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.tgz') || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity ?? '')) fail('Installation dependencies require registry URLs and SHA-512 integrity.');
    }
    const wanted = { ...npm.dependencies, ...npm.devDependencies };
    if (JSON.stringify(wanted) !== JSON.stringify({ ...lock.value.packages[''].dependencies, ...lock.value.packages[''].devDependencies })) fail('Manifest and lock dependencies differ.');
    for (const [name, version] of Object.entries(wanted)) if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || lock.value.packages['node_modules/' + name]?.version !== version) fail('Pin every installation dependency to an exact locked version.');
    if (deployment.dependencies.recipes.includes('electron') && wanted.electron !== '44.7.1') fail('Unsupported Electron recipe version.');
  }
  const python = [], unparsed = [];
  for (const file of files) {
    if (/^(?:requirements(?:[-.][a-zA-Z0-9_-]+)?\.txt)$/.test(file.path)) {
      const lines = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
      if (lines.length > 512) fail('Python dependency declarations exceed their bound.');
      // This describes safe simple declarations only; URL, include and command
      // lines remain explicitly unparsed instead of being inferred or executed.
      const requirements = lines.filter(line => line.length <= 1024 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\[[a-zA-Z0-9_,.-]+\])?(?:\s*(?:===|==|!=|~=|<=|>=|<|>)\s*[a-zA-Z0-9.*+!_-]+(?:\s*,\s*(?:===|==|!=|~=|<=|>=|<|>)\s*[a-zA-Z0-9.*+!_-]+)*)?(?:\s*;\s*[a-zA-Z0-9_ .<>=!()'"-]+)?$/.test(line));
      python.push({ path: file.path, sha256: hash(file.bytes), requirements, unsupportedCount: lines.length - requirements.length });
    } else if (['pyproject.toml', 'Pipfile', 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'setup.cfg', 'setup.py'].includes(file.path)) unparsed.push({ path: file.path, sha256: hash(file.bytes) });
  }
  if (!npm && !python.length && !unparsed.length && !deployment?.dependencies) return null;
  return { installation: clone(deployment?.dependencies ?? null), npm, python, unparsed };
}
function moduleConfiguration(manifest, files, member = null) {
  const input = json(files, 'deployment.json');
  const deployment = input ? validateDeployment(input.value, manifest) : null;
  const override = member?.configuration.executionDefaults;
  const declared = override ?? deployment?.executionDefaults ?? null;
  const source = override !== undefined ? 'module-group' : deployment?.executionDefaults !== undefined ? 'module' : 'system';
  const settings = Object.fromEntries((deployment?.settings ?? []).map(field => [field.key, field.default]));
  validateDeploymentSettings(deployment, settings, { publicSource: true });
  const effectiveConfiguration = member ? clone(member.configuration) : {
    topics: clone(deployment?.topics ?? {}), bridges: clone(deployment?.bridges ?? {}), settings, bindings: []
  };
  delete effectiveConfiguration.executionDefaults;
  return { manifest: clone(manifest), deployment: clone(deployment),
    executionDefaults: { declared: clone(declared), effective: initialExecutionPolicy(deployment, override), source },
    dependencies: inspectDependencies(files, deployment), effectiveConfiguration,
    configurationSources: Object.fromEntries(['topics', 'bridges', 'settings', 'bindings'].map(key => [key, member ? 'module-group' : deployment && key !== 'bindings' ? 'module' : 'system'])) };
}
export function configurationFromValidatedArtifact(validated) {
  const { artifact, manifest, decoded, modules, entry } = validated;
  const identity = { format: 'world-hub.workshop-configuration/v1', sha256: entry.sha256, kind: artifact.kind, id: artifact.id, version: artifact.version };
  if (artifact.kind === 'module') return { ...identity, ...moduleConfiguration(manifest, decoded) };
  return { ...identity, manifest: clone(manifest), deployment: null, executionDefaults: null, dependencies: null,
    modules: modules.map(({ member, manifest: child, files }) => {
      const configuration = moduleConfiguration(child, files, member);
      // validateModuleGroupFiles already checked exact identities, bindings and
      // public settings. The author declaration is separate from its group copy.
      return { memberId: member.id, path: member.path, configuration: clone(member.configuration), ...configuration };
    }), startupPlan: clone(manifest.startupPlan) };
}
export function artifactConfiguration(input) { return configurationFromValidatedArtifact(validateArtifactBytes(input)); }
