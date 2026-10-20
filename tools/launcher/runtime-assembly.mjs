// Optional Launcher adapter for a Runtime-owned live composition. This layer
// never adopts external processes and never sends its private control token to UI.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { instancePath, validatePack, createLock, inspectPackage, safeId } from '../../scripts/runtime/package.mjs';
import { deploymentTopics, validateDeploymentSettings } from '../../scripts/runtime/deployment.mjs';
import { ordinaryPath, readBounded, privateJson, hash } from '../../scripts/runtime/paths.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { effectivePackType, effectiveLifecyclePolicy, componentAutostarts } from '../../scripts/runtime/pack-paradigms.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fault = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const json = async file => JSON.parse((await readBounded(file, 4 * 1024 * 1024)).toString('utf8'));
const deploymentOf = source => source?.deployment && Object.hasOwn(source.deployment, 'deployment') ? source.deployment.deployment : source?.deployment ?? null;
function componentSource(snapshot, component) {
  const module = snapshot.modules.find(source => source.manifest.id === component.module);
  const selected = snapshot.componentSources?.find(source => source.componentId === component.id);
  if (!module || !selected || selected.moduleId !== component.module || typeof selected.directory !== 'string'
      || !Array.isArray(selected.files) || !same(selected.files, module.files))
    throw fault('RUNTIME_ASSEMBLY_SOURCE_MISSING', 'An exact managed component source inventory is unavailable. Load its current Runtime composition again.');
  return { ...module, directory: selected.directory, files: selected.files };
}

export async function runtimeAssemblyRequest(options, path = '/assembly', body, expectedRunId) {
  const directory = await ordinaryPath(instancePath(options.root, options.instanceId));
  const [control, status] = await Promise.all([json(join(directory, 'control.json')), json(join(directory, 'status.json'))]);
  if (control.format !== 'world-hub.runtime-control/v1' || typeof control.runId !== 'string' || control.runId !== status.runId
      || expectedRunId !== undefined && status.runId !== expectedRunId)
    throw fault('RUNTIME_ASSEMBLY_STALE_RUN', 'This Runtime run changed. Load its current composition again.');
  if (status.stoppedAt || ['stopped', 'failed'].includes(status.state))
    throw fault('RUNTIME_ASSEMBLY_NOT_RUNNING', 'Start this instance before changing its live composition.');
  if (typeof control.token !== 'string' || control.token.length < 32 || control.token.length > 256)
    throw fault('RUNTIME_CONTROL_INVALID', 'Invalid private Runtime authorization.');
  const target = new URL(control.url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password
      || target.pathname !== '/' || target.search || target.hash || !['/assembly', '/assembly/preview', '/assembly/apply'].includes(path))
    throw fault('RUNTIME_CONTROL_INVALID', 'Invalid private local Runtime control endpoint.');
  const response = await fetch(new URL(path, target), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { authorization: 'Bearer ' + control.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    signal: options.signal ?? AbortSignal.timeout(body === undefined ? 10000 : 120000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw fault('RUNTIME_CONTROL_LIMIT', 'Runtime response exceeded its bound.');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!response.ok || value.ok === false) throw fault(value.error?.code ?? 'RUNTIME_ASSEMBLY_FAILED', value.error?.message ?? 'Runtime composition operation failed.');
  const current = await json(join(directory, 'status.json'));
  if (current.runId !== control.runId || value.runId !== undefined && value.runId !== control.runId)
    throw fault('RUNTIME_ASSEMBLY_STALE_RUN', 'Runtime restarted during this operation. Inspect the current run.');
  return value;
}

export function publicRuntimeAssembly(snapshot) {
  const externalIds = new Set((snapshot.external ?? []).map(row => row.component.id));
  const programs = snapshot.pack.components.filter(component => !externalIds.has(component.id)).map(component => {
    const source = componentSource(snapshot, component);
    const deployment = deploymentOf(source);
    const topics = deploymentTopics(snapshot.pack, component, deployment);
    const aliases = component.topicAliases ?? Object.fromEntries(Object.keys(topics).map(alias => [alias,
      Object.keys(snapshot.pack.topics).find(key => snapshot.pack.topics[key] === topics[alias])]));
    const bridges = Object.fromEntries(Object.entries(component.bridges).map(([slot, grants]) => [slot,
      Object.fromEntries(['publish', 'subscribe'].map(action => [action, grants[action].map(key => Object.keys(aliases).find(alias => aliases[alias] === key))]))]));
    return { programId: component.id, componentId: component.id, module: { id: source.manifest.id, version: source.manifest.version },
      manifest: clone(source.manifest), sourceDirectory: source.directory, sourceFiles: clone(source.files), sourceFileCount: source.files.length,
      deployment: clone(deployment), settings: clone(component.settings), topics, bridges, after: clone(component.after),
      autostart: component.autostart ?? true, initialAutostart: snapshot.startupMode !== 'hub-only' && componentAutostarts(snapshot.pack,component), critical: component.critical === true,
      bindings: snapshot.pack.bindings.filter(binding => binding.to === component.id).map(binding => ({ providerId: binding.from, contract: clone(binding.contract) })),
      ownership: 'managed', ...(snapshot.components?.find(row => row.id === component.id) ?? {}) };
  });
  const external = (snapshot.external ?? []).map(row => {
    const component = row.component, declaration = row.declaration;
    return { componentId: component.id, module: { id: declaration.id }, title: declaration.title ?? component.id,
      topics: Object.fromEntries(Object.entries(component.topicAliases ?? snapshot.pack.topics).map(([alias, key]) => [alias, snapshot.pack.topics[key] ?? key])),
      bridges: clone(component.bridges), provides: clone(declaration.provides), requires: clone(declaration.requires),
      bindings: snapshot.pack.bindings.filter(binding => binding.to === component.id).map(binding => ({ providerId: binding.from, contract: clone(binding.contract) })),
      ownership: 'external', state: 'unknown', communication: 'unknown', declaration: clone(declaration) };
  });
  return { ...snapshot, packType: effectivePackType(snapshot.pack), lifecyclePolicy: effectiveLifecyclePolicy(snapshot.pack), programs, external };
}

// Translate an author-facing per-program configuration into exact pack aliases.
// No topic or capability is assigned meaning by the Launcher or the Hub.
export async function runtimeAssemblyOperation({ snapshot, input, inspectModule }) {
  const action = input.action;
  if (['start', 'stop', 'remove'].includes(action)) { safeId(input.componentId, 'component ID'); return { kind: action, ids: [input.componentId], ...(input.entry ? { entry: { component: input.entry } } : {}) }; }
  if (action === 'set-policy') return { kind: action, policy: clone(input.policy) };
  if (action === 'revoke-external') return { kind: action, ids: [input.componentId ?? input.externalId] };
  if (!['add', 'configure', 'admit-external'].includes(action)) throw fault('RUNTIME_ASSEMBLY_ACTION', 'Choose a supported composition operation.');
  safeId(input.componentId, 'component ID');
  const pack = snapshot.pack, existing = pack.components.find(component => component.id === input.componentId);
  if (['add', 'admit-external'].includes(action) && existing || action === 'configure' && !existing)
    throw fault('RUNTIME_ASSEMBLY_COMPONENT', action === 'add' ? 'This component ID already exists.' : 'Unknown managed component.');
  const inspected = action === 'add' ? await inspectModule(input.directory) : null;
  const source = action === 'admit-external' ? { manifest: { id: input.componentId } }
    : inspected ? { manifest: inspected.manifest, directory: inspected.directory, deployment: inspected.deploymentReview?.deployment }
      : componentSource(snapshot, existing);
  const deployment = deploymentOf(source);
  const current = existing ? publicRuntimeAssembly(snapshot).programs.find(program => program.programId === existing.id) : null;
  const topics = clone(input.topics ?? current?.topics ?? deployment?.topics ?? {});
  if (!Object.keys(topics).length) throw fault('RUNTIME_ASSEMBLY_DEFAULTS_REQUIRED', 'The module author must supply deployment defaults, or select explicit communication topics and bridge grants.');
  const allTopics = clone(pack.topics), topicAliases = {};
  for (const [alias, topic] of Object.entries(topics)) {
    safeId(alias, 'program topic alias');
    let key = Object.keys(allTopics).find(candidate => allTopics[candidate] === topic);
    if (!key) { let index = 0; while (Object.hasOwn(allTopics, 'dynamic' + index)) index++; key = 'dynamic' + index; allTopics[key] = topic; }
    topicAliases[alias] = key;
  }
  const grants = clone(input.bridges ?? current?.bridges ?? deployment?.bridges ?? {});
  const bridges = Object.fromEntries(Object.entries(grants).map(([slot, rules]) => [slot, Object.fromEntries(['publish', 'subscribe'].map(direction => {
    if (!Array.isArray(rules?.[direction])) throw fault('RUNTIME_ASSEMBLY_GRANTS', 'Declare publish and subscribe grants for each bridge.');
    return [direction, rules[direction].map(alias => {
      if (!Object.hasOwn(topicAliases, alias)) throw fault('RUNTIME_ASSEMBLY_GRANTS', 'Bridge grants refer to an unknown program topic alias.');
      return topicAliases[alias];
    })];
  }))]));
  const settings = clone(input.settings ?? current?.settings ?? Object.fromEntries((deployment?.settings ?? []).map(field => [field.key, field.default])));
  validateDeploymentSettings(deployment, settings, { publicSource: true });
  const unchangedImplicitCommunication = existing && !Object.hasOwn(existing,'topicAliases')
    && same(topics,current.topics) && same(grants,current.bridges);
  const component = unchangedImplicitCommunication ? { ...clone(existing), after: clone(input.after ?? existing.after), settings }
    : { id: input.componentId, module: source.manifest.id, after: clone(input.after ?? existing?.after ?? []), settings, bridges, topicAliases };
  for (const key of ['autostart','critical']) {
    if (Object.hasOwn(input,key)) component[key]=input[key];
    else if (existing && Object.hasOwn(existing,key)) component[key]=existing[key];
  }
  const bindings = clone(input.bindings ?? current?.bindings ?? []).map(binding => ({ from: binding.providerId, to: component.id, contract: binding.contract }));
  if (action === 'configure') return { kind: action, components: [component],
    topics: allTopics, bindings: [...pack.bindings.filter(binding => binding.to !== component.id), ...bindings] };
  if (action === 'admit-external') return { kind: action, component, topics: allTopics, bindings,
    external: { id: component.module, ...(input.title ? { title: input.title } : {}), bridges: Object.keys(bridges), provides: clone(input.provides ?? []), requires: clone(input.requires ?? []) } };
  return { kind: action, component, topics: allTopics, bindings, directory: source.directory,
    ...(inspected?.environment?.python ? { pythonPath: inspected.environment.python.executable } : {}) };
}

export async function createRuntimeAssemblySnapshot({ root, snapshot, environment, signal }) {
  const pack = clone(snapshot.pack), externalIds = new Set((snapshot.external ?? []).map(row => row.component.id));
  pack.components = pack.components.filter(component => !externalIds.has(component.id));
  if (pack.startupOrder) pack.startupOrder = pack.startupOrder.filter(id => !externalIds.has(id));
  pack.bindings = pack.bindings.filter(binding => !externalIds.has(binding.to));
  const ids = new Set(pack.components.map(component => component.id));
  if (pack.bindings.some(binding => !ids.has(binding.from) || !ids.has(binding.to)))
    throw fault('RUNTIME_ASSEMBLY_EXTERNAL_DEPENDENCY', 'Choose managed source providers for external capability bindings before exporting a self-contained pack.');
  if (!ids.has(pack.entry.component) || pack.components.some(component => component.after.some(id => !ids.has(id))))
    throw fault('RUNTIME_ASSEMBLY_EXTERNAL_DEPENDENCY', 'Select a managed entry and managed startup dependencies before exporting a self-contained pack.');
  validatePack(pack);
  const componentSources = pack.components.map(component => ({ component, source: componentSource(snapshot, component) }));
  const verifySources = async () => {
    for (const { source } of componentSources) {
      if (signal?.aborted) throw fault('RUNTIME_ASSEMBLY_CANCELLED', 'Composition snapshot cancelled.');
      if (!same(await collectSourceFiles(source.directory), source.files)) throw fault('RUNTIME_ASSEMBLY_SOURCE_CHANGED', 'A managed component source changed after its live review.');
    }
  };
  for (const component of pack.components) {
    const source = componentSource(snapshot, component);
    validateDeploymentSettings(deploymentOf(source), component.settings, { publicSource: true });
  }
  // Identical modules may have several independently owned source copies.
  // Validate every component's actual source before deduplicating distribution.
  await verifySources();
  const destination = await ordinaryPath(join(root, 'compositions', pack.id + '-' + randomUUID()), { allowMissing: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  try {
    await privateJson(join(destination, 'pack.json'), pack, { exclusive: true });
    for (const source of snapshot.modules.filter(module => pack.components.some(component => component.module === module.manifest.id))) {
      if (!same(await collectSourceFiles(source.directory), source.files)) throw fault('RUNTIME_ASSEMBLY_SOURCE_CHANGED', 'A managed module source changed after its live review.');
      for (const file of source.files) {
        if (signal?.aborted) throw fault('RUNTIME_ASSEMBLY_CANCELLED', 'Composition snapshot cancelled.');
        const bytes = await readBounded(join(source.directory, file.path), 8 * 1024 * 1024);
        if (hash(bytes) !== file.sha256) throw fault('RUNTIME_ASSEMBLY_SOURCE_CHANGED', 'A managed source changed during copying.');
        const target = join(destination, 'modules', source.manifest.id, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      }
    }
    await verifySources();
    await createLock(destination, environment); const reviewed = await inspectPackage(destination, environment);
    await verifySources();
    return { directory: destination, pack, digest: reviewed.digest, source: 'runtime-assembly', runId: snapshot.runId,
      revision: snapshot.revision, baselineDigest: snapshot.baselineDigest, startsModules: false, altersPrograms: false, includesPrivateState: false, includesExternalBridges: false };
  } catch (issue) { issue.incompleteDestination = destination; throw issue; }
}
