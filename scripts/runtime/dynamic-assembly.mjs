// Run-scoped deployment overlay. Hub Core remains a communication service.
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validatePack, safeId } from './package.mjs';
import { doctorModule } from './developer.mjs';
import { collectSourceFiles } from './source-guidance.mjs';
import { inspectDeployment, deploymentTopics, validateDeploymentSettings } from './deployment.mjs';
import { ordinaryPath, readBounded, privateJson, hash } from './paths.mjs';
import { effectivePackType, effectiveLifecyclePolicy, summarizePack } from './pack-paradigms.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const issue = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const contract = (a, b) => a.id === b.id && a.version === b.version;
const principal = id => { const value = `runtime.${id}`; return value.length <= 64 ? value : value.slice(0, 47) + '.' + hash(value).slice(0, 16); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

export class DynamicAssembly {
  constructor({ plan, stateDir, runDir, runId, state, peers, tokens, secrets, start, stop, credentials, persist, isClosing, hasOwnedProcess, signal }) {
    Object.assign(this, { plan, stateDir, runDir, runId, state, peers, tokens, secrets, start, stop, credentials, persist, isClosing, hasOwnedProcess, signal });
    this.pack = clone(plan.pack); this.revision = 0; this.reviews = new Map(); this.queue = Promise.resolve(); this.closed = false; this.retired = new Set();
    this.records = new Map(plan.pack.components.map(component => {
      const source = plan.modules.find(module => module.manifest.id === component.module);
      return [component.id, { component: clone(component), module: { ...clone(source), directory: join(stateDir, 'package', source.source), environment: clone(plan.environment) }, ownership: 'managed', origin: 'baseline' }];
    }));
    this.sync();
  }
  sync() {
    this.state.pack = summarizePack(this.pack);
    this.state.assembly = { format: 'world-hub.runtime-assembly/v1', runId: this.runId, revision: this.revision,
      persistence: 'current-run', scope: 'current-run', baselineDigest: this.plan.digest, packType: effectivePackType(this.pack), failurePolicy: effectiveLifecyclePolicy(this.pack), baseline: { id: this.plan.pack.id, version: this.plan.pack.version },
      components: [...this.records.values()].map(record => ({ id: record.component.id, ownership: record.ownership, origin: record.origin,
        autostart: record.component.autostart ?? true, critical: record.component.critical ?? false })) };
    for (const row of this.state.components) {
      const record = this.records.get(row.id);
      if (record) { row.autostart = record.component.autostart ?? true; row.critical = record.component.critical ?? false; }
    }
  }
  enqueue(action) { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  async shutdown() { this.closed = true; this.reviews.clear(); await this.queue; }
  check(input) {
    if (this.closed || this.isClosing() || this.signal.aborted) throw issue('ASSEMBLY_STOPPING', 'This Runtime is stopping; no new module operation was accepted.');
    if (this.state.executionProfile !== 'trusted-local') throw issue('ASSEMBLY_ISOLATION_UNSUPPORTED', 'Dynamic deployment requires its own isolation review; this isolated run is unchanged.');
    if (input.runId !== this.runId || input.revision !== this.revision) throw issue('ASSEMBLY_CHANGED', 'The run or assembly revision changed. Refresh and review the operation again.');
  }
  active(id) { return this.hasOwnedProcess?.(id) || ['starting', 'running', 'stopping'].includes(this.state.components.find(row => row.id === id)?.process); }
  record(id) { safeId(id); const found = this.records.get(id); if (!found) throw issue('ASSEMBLY_COMPONENT_MISSING', `Unknown assembly member: ${id}`); return found; }
  async inspect(directory, environment = {}) {
    const result = await doctorModule({ directory, nodePath: this.plan.environment.node.executable, pythonPath: this.plan.environment.python?.executable ?? environment.pythonPath });
    if (!result.ok) throw Object.assign(issue('ASSEMBLY_MODULE_INVALID', 'The selected source or interpreter failed module validation.'), { issues: result.issues });
    const files = await collectSourceFiles(result.directory), deployment = await inspectDeployment({ directory: result.directory, manifest: result.manifest });
    const runtime = result.interpreter; runtime.sha256 = hash(await readBounded(runtime.executable, 1024 * 1024 * 1024));
    if (deployment.dependencies?.recipes.includes('electron') && (Number(runtime.version.split('.')[0]) < 22 || runtime.version.startsWith('22.') && Number(runtime.version.split('.')[1]) < 12)) throw issue('ASSEMBLY_MODULE_INVALID', 'The Electron deployment recipe requires Node 22.12.0 or newer.');
    return { directory: result.directory, manifest: result.manifest, files, deployment, environment: { [result.manifest.runtime.kind]: runtime } };
  }
  validate(pack, records) {
    validatePack(pack);
    for (const component of pack.components) {
      const record = records.get(component.id), manifest = record.module.manifest;
      if (component.module !== manifest.id || manifest.bridges.length !== Object.keys(component.bridges).length || manifest.bridges.some(slot => !Object.hasOwn(component.bridges, slot)))
        throw issue('ASSEMBLY_BRIDGES_INVALID', `Module identity or bridge slots differ from the declaration: ${component.id}`);
      deploymentTopics(pack, component, record.module.deployment?.deployment);
      validateDeploymentSettings(record.module.deployment?.deployment, component.settings, { publicSource: true });
      for (const required of manifest.requires) if (!pack.bindings.some(binding => binding.to === component.id && contract(binding.contract, required)))
        throw issue('ASSEMBLY_PROVIDER_REQUIRED', `Select an exact provider for ${component.id}/${required.id}@${required.version}.`);
    }
    for (const binding of pack.bindings) {
      if (!records.get(binding.from).module.manifest.provides.some(item => contract(item, binding.contract)) || !records.get(binding.to).module.manifest.requires.some(item => contract(item, binding.contract)))
        throw issue('ASSEMBLY_CONTRACT_INVALID', 'The selected provider and consumer do not declare this exact capability contract.');
    }
    const versions = new Map();
    for (const record of records.values()) if (record.ownership === 'managed') {
      const value = hash(JSON.stringify({ manifest: record.module.manifest, files: record.module.files }));
      if (versions.has(record.module.manifest.id) && versions.get(record.module.manifest.id) !== value) throw issue('ASSEMBLY_MODULE_COLLISION', 'Two different sources have the same module ID; publish distinct IDs before combining them.');
      versions.set(record.module.manifest.id, value);
    }
  }
  requireStopped(ids) {
    const active = [...new Set(ids)].filter(id => this.active(id));
    if (active.length) throw issue('ASSEMBLY_RESTART_REQUIRED', `Stop these affected modules, then review this change: ${active.join(', ')}. Existing programs retain their launch-time configuration.`);
  }
  affected(before, after) {
    const ids = new Set();
    for (const component of after.components) {
      const previous = before.components.find(row => row.id === component.id);
      if (!previous) continue;
      if (!equal(previous, component)) { ids.add(component.id); continue; }
      const deployment = this.records.get(component.id).module.deployment?.deployment;
      const oldTopics = deploymentTopics(before, previous, deployment);
      let newTopics;
      try { newTopics = deploymentTopics(after, component, deployment); }
      catch {
        // A new pack key can collide with an existing author-defined alias.
        // Retire that program's old configuration before validating a repair;
        // stopping it does not bypass the subsequent alias validation.
        ids.add(component.id); continue;
      }
      // Programs retain their launch-time configuration. A new independent
      // topic is not an edit to that snapshot or its existing bridge grants.
      if (Object.entries(oldTopics).some(([alias, topic]) => !Object.hasOwn(newTopics, alias) || newTopics[alias] !== topic)) ids.add(component.id);
    }
    for (const binding of [...before.bindings.filter(item => !after.bindings.some(next => equal(item, next))), ...after.bindings.filter(item => !before.bindings.some(previous => equal(item, previous)))]) { ids.add(binding.from); ids.add(binding.to); }
    return [...ids].filter(id => this.records.has(id));
  }
  async prepare(operation) {
    if (!plain(operation) || typeof operation.kind !== 'string') throw issue('ASSEMBLY_OPERATION_INVALID', 'Choose a supported assembly operation.');
    const fields = { add: ['kind', 'directory', 'component', 'topics', 'bindings', 'pythonPath'], configure: ['kind', 'components', 'topics', 'bindings', 'entry'],
      start: ['kind', 'ids'], stop: ['kind', 'ids'], remove: ['kind', 'ids', 'entry'], 'admit-external': ['kind', 'external', 'component', 'topics', 'bindings'],
      'revoke-external': ['kind', 'ids'], 'set-policy': ['kind', 'policy'] }[operation.kind];
    if (!fields || Object.keys(operation).some(key => !fields.includes(key))) throw issue('ASSEMBLY_OPERATION_INVALID', 'Unknown dynamic assembly operation or unsupported fields.');
    if (Object.hasOwn(operation, 'pythonPath') && (typeof operation.pythonPath !== 'string' || !operation.pythonPath || operation.pythonPath.length > 32768 || operation.pythonPath.includes('\0'))) throw issue('ASSEMBLY_OPERATION_INVALID', 'Select a valid reviewed Python executable.');
    const next = clone(this.pack), records = new Map([...this.records].map(([id, record]) => [id, { ...record, component: clone(record.component) }]));
    const affected = []; let inspected = null;
    if (operation.kind === 'add' || operation.kind === 'admit-external') {
      const component = clone(operation.component); safeId(component?.id);
      if (records.has(component.id)) throw issue('ASSEMBLY_COMPONENT_EXISTS', 'This component ID already exists in this run.');
      if (Object.values(this.peers).some(peer => peer.principal === principal(component.id))) throw issue('ASSEMBLY_IDENTITY_COLLISION', 'This ID collides with an existing shortened principal. Choose another component ID.');
      if (this.retired.has(component.id)) throw issue('ASSEMBLY_STATE_POLICY_REQUIRED', 'This component ID was removed from the current run. Use a fresh ID; reusing program state requires a reviewed baseline save and its explicit state policy.');
      if (records.size >= 32) throw issue('ASSEMBLY_LIMIT', 'This optional Runtime supports at most 32 assembly members.');
      if (operation.kind === 'add') {
        const state = await ordinaryPath(join(this.stateDir, 'programs', component.id), { allowMissing: true });
        try { await lstat(state); throw issue('ASSEMBLY_STATE_POLICY_REQUIRED', 'This ID already has retained program state. Choose a fresh ID or review its state policy when saving a new baseline.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        inspected = await this.inspect(operation.directory, { pythonPath: operation.pythonPath });
        if (process.platform === 'win32' && inspected.manifest.runtime.kind === 'node'
            && inspected.files.some(file => file.path.split('/').at(-1).toLowerCase() === 'package.json'
              && join(this.runDir, 'sources', component.id, '0'.repeat(36), file.path).length >= 248))
          throw issue('NODE_PACKAGE_PATH_TOO_LONG', 'This Windows source copy would put package.json beyond Node\'s native package path limit. Use a shorter instance root or component ID; program state is not moved.');
      }
      else {
        const external = operation.external;
        if (!plain(external) || Object.keys(external).some(key => !['id', 'title', 'bridges', 'provides', 'requires'].includes(key)) || external.id !== component.module
            || external.title !== undefined && (typeof external.title !== 'string' || external.title.length > 256 || external.title.includes('\0'))
            || !Array.isArray(external.bridges) || !external.bridges.length || external.bridges.length > 8
            || !Array.isArray(external.provides) || external.provides.length > 32 || !Array.isArray(external.requires) || external.requires.length > 32)
          throw issue('ASSEMBLY_EXTERNAL_INVALID', 'Declare the external identity, bridge slots and exact offered/required contracts; no program code is adopted.');
        safeId(external.id); external.bridges.forEach(slot => safeId(slot));
        if (new Set(external.bridges).size !== external.bridges.length) throw issue('ASSEMBLY_EXTERNAL_INVALID', 'External bridge slots must be unique.');
        // Reuse contract validation without prescribing an external executable.
        const checked = clone(next); checked.components.push(component);
        if (checked.startupOrder) checked.startupOrder.push(component.id);
        Object.assign(checked.topics, operation.topics ?? {}); checked.bindings.push(...clone(operation.bindings ?? []));
        validatePack(checked);
        for (const item of [...external.provides, ...external.requires]) {
          if (!plain(item) || Object.keys(item).sort().join(',') !== 'id,version' || typeof item.id !== 'string' || !item.id || item.id.length > 128 || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(item.version)) throw issue('ASSEMBLY_EXTERNAL_INVALID', 'External capabilities require exact contract IDs and versions.');
        }
        for (const declarations of [external.provides, external.requires]) if (new Set(declarations.map(item => `${item.id}@${item.version}`)).size !== declarations.length) throw issue('ASSEMBLY_EXTERNAL_INVALID', 'External capability declarations must be unique.');
        inspected = { manifest: { id: external.id, version: 'external', bridges: external.bridges, provides: external.provides, requires: external.requires }, directory: null, files: [], deployment: null };
      }
      if (component.module !== inspected.manifest.id) throw issue('ASSEMBLY_MODULE_INVALID', 'The component must select the reviewed module ID.');
      for (const [alias, topic] of Object.entries(operation.topics ?? {})) if (Object.hasOwn(next.topics, alias) && next.topics[alias] !== topic) throw issue('ASSEMBLY_TOPIC_COLLISION', 'Adding a module cannot silently change an existing topic alias.');
      Object.assign(next.topics, clone(operation.topics ?? {})); next.components.push(component); next.bindings.push(...clone(operation.bindings ?? []));
      if (next.startupOrder) next.startupOrder.push(component.id);
      records.set(component.id, { component, module: inspected, ownership: operation.kind === 'add' ? 'managed' : 'external', origin: 'added' });
      affected.push(...this.affected(this.pack, next)); this.requireStopped(affected);
    } else if (operation.kind === 'configure') {
      if (!Array.isArray(operation.components) || operation.components.length > 32) throw issue('ASSEMBLY_OPERATION_INVALID', 'Supply the full edited component declarations.');
      for (const component of operation.components) {
        const record = records.get(component.id); if (!record || record.ownership !== 'managed' || component.module !== record.component.module) throw issue('ASSEMBLY_OPERATION_INVALID', 'Configure existing managed members; source replacement requires remove and add.');
        next.components[next.components.findIndex(row => row.id === component.id)] = clone(component); record.component = clone(component);
      }
      if (operation.topics !== undefined) next.topics = clone(operation.topics);
      if (operation.bindings !== undefined) next.bindings = clone(operation.bindings);
      if (operation.entry !== undefined) next.entry = clone(operation.entry);
      affected.push(...this.affected(this.pack, next)); this.requireStopped(affected);
    } else if (['start', 'stop', 'remove', 'revoke-external'].includes(operation.kind)) {
      if (!Array.isArray(operation.ids) || !operation.ids.length || operation.ids.length > 32 || new Set(operation.ids).size !== operation.ids.length) throw issue('ASSEMBLY_OPERATION_INVALID', 'Select distinct assembly member IDs.');
      operation.ids.forEach(id => this.record(id)); affected.push(...operation.ids);
      if (['remove', 'revoke-external'].includes(operation.kind)) {
        this.requireStopped(operation.ids);
        const externals = operation.kind === 'revoke-external';
        if (operation.ids.some(id => (records.get(id).ownership === 'external') !== externals)) throw issue('ASSEMBLY_OWNERSHIP_INVALID', 'External identities are revoked; only managed modules can be removed.');
        const remaining = next.components.filter(component => !operation.ids.includes(component.id));
        const references = next.bindings.filter(binding => operation.ids.includes(binding.from) && !operation.ids.includes(binding.to));
        if (references.length || remaining.some(component => component.after.some(id => operation.ids.includes(id)))) throw issue('ASSEMBLY_DEPENDENTS', 'Rewire dependent modules and remove their launch dependencies before removing this member.');
        next.components = remaining; next.bindings = next.bindings.filter(binding => !operation.ids.includes(binding.from) && !operation.ids.includes(binding.to));
        if (next.startupOrder) next.startupOrder = next.startupOrder.filter(id => !operation.ids.includes(id));
        operation.ids.forEach(id => records.delete(id));
        if (operation.entry !== undefined) next.entry = clone(operation.entry);
        if (operation.ids.includes(next.entry.component)) throw issue('ASSEMBLY_ENTRY_REQUIRED', 'Choose a remaining primary entry before removing the current entry module.');
      } else if (operation.kind === 'start') {
        inspected = { sources: [] };
        for (const id of operation.ids) {
          const record = this.record(id); if (record.ownership !== 'managed') throw issue('ASSEMBLY_EXTERNAL_UNMANAGED', 'An external program controls its own process; Runtime only grants or revokes communication access.');
          if (this.active(id)) throw issue('ASSEMBLY_ALREADY_RUNNING', `Module is already running: ${id}`);
          const refreshed = await this.inspect(record.module.directory, { pythonPath: record.module.environment.python?.executable }), kind = refreshed.manifest.runtime.kind;
          if (!equal(refreshed.files, record.module.files) || !equal(refreshed.manifest, record.module.manifest)
              || refreshed.environment[kind].sha256 !== record.module.environment[kind].sha256) throw issue('ASSEMBLY_SOURCE_CHANGED', 'Registered source bytes or the reviewed interpreter changed. Remove and add this module from a fresh review.');
          inspected.sources.push({ id, ...refreshed });
          const dependencies = record.component.after;
          for (const dependency of dependencies) if (!operation.ids.includes(dependency)) {
            const row = this.state.components.find(row => row.id === dependency);
            const available = row?.ownership === 'external' ? row.communication === 'connected' : row?.process === 'running' && row.readiness === 'ready' && row.health.ready === true && row.communication === 'connected';
            if (!available) throw issue('ASSEMBLY_PROVIDER_STOPPED', `Start required provider first: ${dependency}`);
          }
        }
      } else if (operation.ids.some(id => this.record(id).ownership !== 'managed')) throw issue('ASSEMBLY_EXTERNAL_UNMANAGED', 'Runtime does not signal externally owned programs. Revoke their access explicitly.');
    } else if (operation.kind === 'set-policy') {
      if (!['independent', 'fail-fast'].includes(operation.policy)) throw issue('ASSEMBLY_POLICY_INVALID', 'Choose independent or fail-fast module failure handling.');
      next.lifecyclePolicy = operation.policy;
    } else throw issue('ASSEMBLY_OPERATION_INVALID', 'Unknown dynamic assembly operation.');
    this.validate(next, records);
    return { next, records, affected: [...new Set(affected)], inspected };
  }
  preview(input) { return this.enqueue(async () => {
    this.check(input); const operation = clone(input.operation), prepared = await this.prepare(operation); this.check(input);
    const digest = hash(JSON.stringify({ runId: this.runId, revision: this.revision, operation, inspected: prepared.inspected, pack: prepared.next }));
    const review = { format: 'world-hub.runtime-assembly-review/v1', digest, runId: this.runId, revision: this.revision, operation, affected: prepared.affected,
      module: prepared.inspected?.manifest ?? null, sourceFiles: prepared.inspected?.files ?? [], environment: prepared.inspected?.environment ?? {},
      packType: effectivePackType(prepared.next), failurePolicy: effectiveLifecyclePolicy(prepared.next), startsModules: operation.kind === 'start', sandbox: false,
      expiresAt: new Date(Date.now() + 10 * 60000).toISOString() };
    this.reviews.set(digest, { review, prepared }); while (this.reviews.size > 32) this.reviews.delete(this.reviews.keys().next().value);
    return clone(review);
  }); }
  apply(input) { return this.enqueue(async () => {
    this.check(input); if (input.accepted !== true) throw issue('TRUST_REQUIRED', 'Accept the displayed code, permissions, operation and communication wiring.');
    const saved = this.reviews.get(input.digest);
    if (!saved || saved.review.revision !== this.revision || Date.now() > Date.parse(saved.review.expiresAt)) throw issue('ASSEMBLY_REVIEW_REQUIRED', 'Review this exact assembly operation again.');
    const operation = saved.review.operation, prepared = await this.prepare(operation); this.check(input);
    const digest = hash(JSON.stringify({ runId: this.runId, revision: this.revision, operation, inspected: prepared.inspected, pack: prepared.next }));
    if (digest !== input.digest) throw issue('ASSEMBLY_REVIEW_CHANGED', 'Reviewed code, interpreter, permissions or wiring changed. Review again.');
    this.reviews.delete(input.digest);
    if (operation.kind === 'add') {
      const target = join(this.runDir, 'sources', operation.component.id, randomUUID()); await mkdir(target, { recursive: true, mode: 0o700 });
      for (const file of prepared.inspected.files) {
        const bytes = await readBounded(join(prepared.inspected.directory, file.path), 8 * 1024 * 1024);
        if (hash(bytes) !== file.sha256) throw issue('ASSEMBLY_REVIEW_CHANGED', 'Source bytes changed during installation.');
        const destination = join(target, file.path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      }
      if (!equal(await collectSourceFiles(target), prepared.inspected.files)) throw issue('ASSEMBLY_REVIEW_CHANGED', 'Copied source inventory differs from the review.');
      prepared.records.get(operation.component.id).module.directory = await ordinaryPath(target);
    }
    if (['remove', 'revoke-external'].includes(operation.kind)) {
      await this.credentials({ remove: operation.ids.map(id => this.peers[id].principal), credentials: {} });
      operation.ids.forEach(id => { if (this.records.get(id).ownership === 'managed') this.retired.add(id); delete this.peers[id]; this.tokens.delete(id); const index = this.state.components.findIndex(row => row.id === id); if (index >= 0) this.state.components.splice(index, 1); });
    }
    this.pack = prepared.next; this.records = prepared.records;
    try {
    let admission = null;
    if (['add', 'admit-external'].includes(operation.kind)) {
      const id = operation.component.id, token = randomUUID(); this.tokens.set(id, token); this.secrets.push(token); this.peers[id] = { principal: principal(id) };
      const record = this.records.get(id);
      this.state.components.push({ id, module: record.component.module, pid: null, principal: this.peers[id].principal,
        ownership: record.ownership, origin: 'added', neverStarted: true, process: record.ownership === 'external' ? 'unmanaged' : 'stopped', communication: 'disconnected', readiness: 'not-ready',
        expectedBridges: Object.keys(record.component.bridges).map(slot => principal(`${id}.${slot}`)), health: { ready: false, lastCheckedAt: null }, bridges: [] });
      if (record.ownership === 'external') { await this.authorize(id); admission = this.externalConfiguration(id); }
    }
    if (operation.kind === 'configure') {
      for (const id of prepared.affected) {
        const row = this.state.components.find(row => row.id === id); if (row) { row.readiness = 'not-ready'; row.health.ready = false; delete row.entryUrl; }
      }
    }
    if (operation.kind === 'stop') for (const id of [...operation.ids].reverse()) await this.stop(id);
    if (operation.kind === 'start') {
      const order = validatePack(this.pack).map(component => component.id).filter(id => operation.ids.includes(id));
      for (const id of order) { if (this.closed || this.signal.aborted || this.isClosing()) throw issue('ASSEMBLY_STOPPING', 'Runtime stopped before this module could start.'); await this.authorize(id); await this.start(this.records.get(id).component, this.records.get(id).module, this.pack); }
    }
      return { ok: true, runId: this.runId, revision: this.revision + 1, ...(admission ? { admission } : {}) };
    } finally {
      // Once any mutation begins, even a failed start invalidates every older
      // review. Its owned handle and failed status remain available for Stop.
      this.state.entryUrl = this.state.components.find(row => row.id === this.pack.entry.component)?.entryUrl ?? null;
      this.revision++; this.reviews.clear(); this.sync(); await this.persistOverlay(); await this.persist();
    }
  }); }
  grant(id) {
    const record = this.record(id), component = record.component;
    return { token: this.tokens.get(id), maxConnections: Object.keys(component.bridges).length, allow: Object.fromEntries(['publish', 'subscribe'].map(direction => [direction, [...new Set(Object.values(component.bridges).flatMap(bridge => bridge[direction].map(alias => this.pack.topics[alias])))]])) };
  }
  authorize(id) { return this.credentials({ remove: [], credentials: { [this.peers[id].principal]: this.grant(id) } }); }
  externalConfiguration(id) {
    const record = this.record(id), component = record.component;
    return { format: 'world-hub.external-admission/v1', runId: this.runId, componentId: id, principal: this.peers[id].principal,
      endpoint: this.state.hub.endpoint, settings: clone(component.settings), topics: deploymentTopics(this.pack, component), peers: clone(this.peers), bindings: clone(this.pack.bindings),
      bridges: Object.entries(component.bridges).map(([slot, rules]) => ({ slot, endpoint: this.state.hub.endpoint, bridgeId: principal(`${id}.${slot}`), credential: this.peers[id].principal, principal: this.peers[id].principal, token: this.tokens.get(id),
        publish: rules.publish.map(alias => this.pack.topics[alias]), subscribe: rules.subscribe.map(alias => this.pack.topics[alias]) })) };
  }
  async persistOverlay() { await privateJson(join(this.runDir, 'assembly.json'), { format: 'world-hub.runtime-overlay/v1', runId: this.runId, revision: this.revision, pack: this.pack,
    sources: [...this.records.values()].filter(record => record.ownership === 'managed').map(record => ({ id: record.component.id, directory: record.module.directory, files: record.module.files })),
    external: [...this.records.values()].filter(record => record.ownership === 'external').map(record => ({ component: record.component, manifest: record.module.manifest })) }); }
  snapshot() {
    const externals = [...this.records.values()].filter(record => record.ownership === 'external');
    return { format: 'world-hub.runtime-assembly-snapshot/v1', runId: this.runId, revision: this.revision, startupMode: this.state.startupMode, baselineDigest: this.plan.digest, pack: clone(this.pack),
      modules: [...new Map([...this.records.values()].filter(record => record.ownership === 'managed').map(record => [record.module.manifest.id, record.module])).values()].map(module => clone(module)),
      componentSources: [...this.records.values()].filter(record => record.ownership === 'managed').map(record => ({ componentId: record.component.id,
        moduleId: record.module.manifest.id, directory: record.module.directory, files: clone(record.module.files) })),
      external: externals.map(record => ({ component: clone(record.component), declaration: clone(record.module.manifest) })),
      exportable: externals.length === 0, exportBoundary: externals.length ? 'External source and credentials are unavailable. Remove external declarations and rewire their dependents before exporting a self-contained pack.' : null,
      includesRuntimeState: false, includesCredentials: false, persistence: 'current-run' };
  }
}
