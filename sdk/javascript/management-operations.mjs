// Public management operations shared by the CLI, MCP adapter and other clients.
// These are local deployment controls; they do not interpret bridge message bodies.
const api = '/manage/api';
const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: true });
const string = { type: 'string', minLength: 1 };
const id = { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' };
const review = { reviewId: string, accepted: { const: true } };
const operation = (name, command, method, path, description, extra = {}) => ({
  name, command: command.split(' '), method, path: path.startsWith('/status') || path === '/log' ? path : api + path,
  description, readOnly: method === 'GET', schema: objectSchema(), ...extra,
});
const post = (name, command, path, description, extra = {}) => operation(name, command, 'POST', path, description, extra);
const readPost = (name, command, path, description, extra = {}) => post(name, command, path, description, { readOnly: true, ...extra });
const accepted = (extra = {}) => ({ requiresAcceptance: true, schema: objectSchema({ accepted: { const: true } }, ['accepted']), ...extra });
const reviewed = (extra = {}) => ({ requiresReview: true, requiresAcceptance: true, schema: objectSchema({ ...review }, ['reviewId', 'accepted']), ...extra });
const withProgram = (extra = {}) => ({ params: ['programId'], ...extra });
const entries = [
  operation('hub.status', 'status', 'GET', '/status', 'Show Hub runtime and transport status.'),
  operation('hub.state', 'state', 'GET', '/state', 'Show management state with credentials removed.'),
  operation('hub.log', 'log', 'GET', '/log', 'Read retained communications log.', { query: ['limit'], schema: objectSchema({ limit: { type: 'integer', minimum: 1, maximum: 500 } }) }),
  operation('messages.get', 'message get', 'GET', '/message', 'Read one retained message by sequence.', { query: ['seq'], schema: objectSchema({ seq: { type: 'integer', minimum: 1 } }, ['seq']) }),
  post('bridges.control', 'bridge control', '/bridge', 'Pause, resume or disconnect a known bridge.', { schema: objectSchema({ key: string, action: { enum: ['pause', 'resume', 'disconnect'] }, connectionIds: { type: 'array', items: string } }, ['key', 'action']) }),
  post('annotations.save', 'annotation save', '/annotation', 'Save a human-readable bridge annotation.', { schema: objectSchema({ key: string, bridgeName: { type: 'string' }, programs: { type: 'array' } }, ['key']) }),
  operation('programs.list', 'module list', 'GET', '/programs', 'List installed module instances, wiring and startup plan.'),
  readPost('programs.inspect', 'module inspect', '/programs/inspect', 'Inspect a module directory without registering or starting it.', { schema: objectSchema({ directory: string }, ['directory']) }),
  readPost('programs.preview', 'module preview', '/programs/preview', 'Review an independent module registration.'),
  post('programs.register', 'module register', '/programs/register', 'Register the exact reviewed module without starting it.', reviewed()),
  readPost('programs.review', 'module review', '/programs/:programId/review', 'Review this module instance before execution.', withProgram()),
  post('programs.start', 'module start', '/programs/:programId/start', 'Start the exact reviewed module instance.', withProgram(reviewed())),
  post('programs.stop', 'module stop', '/programs/:programId/stop', 'Stop an owned module instance.', withProgram()),
  operation('programs.logs', 'module logs', 'GET', '/programs/:programId/logs', 'Read module process logs.', withProgram()),
  readPost('programs.configuration.preview', 'module configuration preview', '/programs/:programId/configuration/preview', 'Review module configuration changes.', withProgram()),
  post('programs.configuration.apply', 'module configuration apply', '/programs/:programId/configuration/apply', 'Apply an explicit configuration review; never create or accept a review automatically.', withProgram(reviewed())),
  post('programs.execution.save', 'module execution save', '/programs/:programId/execution-policy', 'Save resident/on-demand policy with its expected revision.', withProgram()),
  operation('execution.status', 'execution status', 'GET', '/execution/status', 'Show demand lifecycle and active execution status.'),
  operation('startup.get', 'startup get', 'GET', '/programs/startup-plan', 'Read the global startup plan.'),
  operation('startup.status', 'startup status', 'GET', '/programs/startup-plan/status', 'Read startup progress.'),
  post('startup.save', 'startup save', '/programs/startup-plan/save', 'Save a precise startup plan with its expected revision.'),
  readPost('startup.review', 'startup review', '/programs/startup-plan/review', 'Review the current global startup plan.'),
  post('startup.start', 'startup start', '/programs/startup-plan/start', 'Execute the accepted startup plan review.', reviewed()),
  operation('groups.list', 'group list', 'GET', '/groups', 'List local reference groups; groups do not duplicate module bodies.'),
  post('groups.save', 'group save', '/groups/save', 'Save local group membership and startup configuration.'),
  post('groups.remove', 'group dissolve', '/groups/:groupId/remove', 'Dissolve only the local reference group; keep its modules running, data intact and group record available for restore.', { params: ['groupId'], schema: objectSchema({ expectedRevision: string }, ['expectedRevision']) }),
  readPost('groups.review', 'group review', '/groups/:groupId/review', 'Review the current local group startup plan and members.', { params: ['groupId'], schema: objectSchema({ expectedRevision: string }, ['expectedRevision']) }),
  post('groups.start', 'group start', '/groups/:groupId/start', 'Start a reviewed local group.', { params: ['groupId'], ...reviewed() }),
  readPost('groups.stop.preview', 'group stop-preview', '/groups/:groupId/stop-preview', 'Review shared consumers and group members before choosing which instances to stop.', { params: ['groupId'], schema: objectSchema({ expectedRevision: string }, ['expectedRevision']) }),
  post('groups.stop', 'group stop', '/groups/:groupId/stop-apply', 'Stop only the explicitly selected members of the exact accepted group review.', { params: ['groupId'], ...reviewed({ schema: objectSchema({ ...review, programIds: { type: 'array', uniqueItems: true, items: id } }, ['reviewId', 'accepted', 'programIds']) }) }),
  post('groups.restore', 'group restore', '/groups/:groupId/restore', 'Restore a dissolved local reference group.', { params: ['groupId'] }),
  post('groups.discard', 'group discard', '/groups/:groupId/discard', 'Discard a dissolved group record.', { params: ['groupId'] }),
  readPost('wiring.defaults.preview', 'wiring defaults preview', '/wiring/defaults/preview', 'Review restoring author-provided default wiring.'),
  post('wiring.defaults.apply', 'wiring defaults apply', '/wiring/defaults/apply', 'Apply the reviewed default wiring.', reviewed()),
  operation('resources.list', 'resource list', 'GET', '/resources', 'List shared module bodies, saved configurations and application data.'),
  post('resources.bodies.import', 'resource body import', '/resources/bodies/import', 'Import a module body or a local body set; never execute it.', { schema: objectSchema({ path: string }, ['path']) }),
  post('resources.bodies.export', 'resource body export', '/resources/bodies/export', 'Export distinct module bodies for global or selected scope.'),
  post('resources.profiles.import', 'resource configuration import', '/resources/profiles/import', 'Import a saved configuration; never execute modules.', { schema: objectSchema({ path: string }, ['path']) }),
  post('resources.profiles.capture', 'resource configuration capture', '/resources/profiles/capture', 'Capture a versioned global or local configuration.'),
  post('resources.profiles.retain', 'resource configuration retain', '/resources/profiles/retain', 'Choose configurations that protect shared modules from cleanup.'),
  post('resources.profiles.deactivate', 'resource configuration deactivate', '/resources/profiles/deactivate', 'Deactivate configuration references without deleting module data.', accepted()),
  post('resources.profiles.export', 'resource configuration export', '/resources/profiles/export', 'Export one saved configuration version.'),
  readPost('resources.profiles.preview', 'resource configuration preview', '/resources/profiles/preview', 'Review switching or combining saved configurations.'),
  post('resources.profiles.apply', 'resource configuration apply', '/resources/profiles/apply', 'Apply the exact reviewed configuration selection.', reviewed()),
  post('resources.profiles.prepare', 'resource configuration prepare', '/resources/profiles/prepare', 'Download exact missing module bodies with explicit acceptance; never execute them.', accepted()),
  readPost('resources.cleanup.preview', 'resource cleanup preview', '/resources/cleanup/preview', 'Review modules outside the chosen retained configuration closure.'),
  post('resources.cleanup.apply', 'resource cleanup apply', '/resources/cleanup/apply', 'Apply the accepted retention-based cleanup review.', reviewed()),
  post('resources.data.import', 'resource data import', '/resources/data/import', 'Import an opaque application dataset or private backup.', { schema: objectSchema({ path: string }, ['path']) }),
  post('resources.data.export', 'resource data export', '/resources/data/export', 'Export stopped module state as private backup or explicitly acknowledged public dataset.'),
  readPost('resources.data.preview', 'resource data preview', '/resources/data/preview', 'Review restoring data into exact target instances.'),
  post('resources.data.apply', 'resource data apply', '/resources/data/apply', 'Restore the exact reviewed dataset; require stopped affected modules.', reviewed()),
  post('resources.data.recover', 'resource data recover', '/resources/data/recover', 'Recover an interrupted data restoration transaction.', accepted()),
  operation('paths.known', 'path known', 'GET', '/paths/known', 'List known resource and module directories.'),
  readPost('paths.browse', 'path browse', '/paths/browse', 'List candidate local directories without opening a native picker.'),
  post('environment.detect', 'environment detect', '/environment', 'Probe selected interpreters by executing their version checks and discover environment candidates.'),
  operation('sources.list', 'source list', 'GET', '/workshop/sources', 'List configured software sources.'),
  post('sources.save', 'source save', '/resources/sources/save', 'Save a software source and its explicit network policy.'),
  post('sources.remove', 'source remove', '/resources/sources/remove', 'Remove a configured software source.', { schema: objectSchema({ sourceId: string }, ['sourceId']) }),
  post('workshop.inspect', 'workshop inspect', '/workshop/inspect', 'Inspect a software source index and save its observation without granting execution authority.'),
  operation('workshop.cache', 'workshop cache', 'GET', '/workshop/cache', 'List cached verified community artifacts.'),
  post('workshop.cache.delete', 'workshop cache delete', '/workshop/cache/delete', 'Delete one cached artifact by SHA-256.', { schema: objectSchema({ sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' } }, ['sha256']) }),
  post('workshop.fetch', 'workshop fetch', '/workshop/fetch', 'Download one exact indexed artifact and import it into the matching resource pool.'),
  post('artifacts.preview', 'artifact preview', '/artifacts/preview', 'Import artifact metadata as needed and review installation.'),
  post('artifacts.apply', 'artifact apply', '/artifacts/apply', 'Apply an accepted artifact installation review.', reviewed()),
  post('artifacts.import', 'artifact import', '/artifacts/import', 'Import a local artifact into the library without starting it.'),
  operation('external.list', 'external list', 'GET', '/external', 'List external client grants and revision.'),
  readPost('external.preview', 'external preview', '/external/preview', 'Review admission, grant changes or revocation for an external program.'),
  post('external.apply', 'external apply', '/external/apply', 'Apply an external grant review. Credentials are omitted unless a trusted caller explicitly requests private delivery.', reviewed()),
  post('creator.scaffold', 'creator scaffold', '/creator/scaffold', 'Create standalone module starter files without registering or executing them.'),
  post('creator.package', 'creator package', '/creator/package', 'Package module/configuration/public data files with redistribution acknowledgement.'),
];

for (const collection of ['modules', 'groups']) {
  const singular = collection === 'modules' ? 'module' : 'group';
  const param = collection === 'modules' ? 'programId' : 'groupId';
  const base = `/versions/${collection}/:${param}`;
  entries.push(operation(`versions.${collection}.list`, `version ${singular} list`, 'GET', base, `Read ${singular} version history.`, { params: [param] }));
  for (const [action, suffix] of [['preview', 'preview'], ['rollback-preview', 'rollback-preview'], ['apply', 'apply'], ['recover', 'recover']]) {
    entries.push(post(`versions.${collection}.${action}`, `version ${singular} ${action}`, `${base}/${suffix}`, `Perform ${singular} version ${action}.`, {
      params: [param], ...(action.endsWith('preview') ? { readOnly: true } : action === 'apply' ? reviewed() : accepted()),
    }));
  }
  for (const action of ['preview', 'apply']) entries.push(post(`uninstall.${collection}.${action}`, `uninstall ${singular} ${action}`, `/uninstall/${collection}/:${param}/${action}`, `Review or apply ${singular} uninstall while preserving shared references and data.`, {
    params: [param], ...(action === 'preview' ? { readOnly: true } : reviewed()),
  }));
}

// Public input documentation also powers command help and MCP discovery. Keep
// bodies open for the backend's advanced fields; required fields below are the
// ones required for every request, not conditional choices such as local scope.
const text = description => ({ ...string, description });
const boolean = description => ({ type: 'boolean', description });
const choice = (values, description) => ({ type: 'string', enum: values, description });
const array = (items, description) => ({ type: 'array', items, uniqueItems: true, description });
const map = (items, description) => ({ type: 'object', additionalProperties: items, description });
const revision = text('Observed opaque revision from the corresponding current overview; do not invent or numerically coerce it.');
const ids = description => array(id, description);
const contract = objectSchema({ id: text('Exact application capability contract ID.'), version: text('Exact contract semantic version.') }, ['id', 'version']);
const bindings = array(objectSchema({ providerId: id, contract }, ['providerId', 'contract']), 'Exact capability providers. Application semantics remain defined by the contract.');
const settings = map({}, 'Public module settings defined by its deployment declaration.');
const topics = map(string, 'Deployment topic alias to concrete topic name.');
const bridges = map(objectSchema({ publish: array(string, 'Published topic aliases.'), subscribe: array(string, 'Subscribed topic aliases.') }), 'Bridge slot to explicit topic alias grants.');
const runtimeSelection = { nodePath: text('Explicit trusted Node executable; inspection runs its probe.'), pythonPath: text('Explicit trusted Python executable; inspection runs its probe.') };
const configuration = { settings, topics, bridges, bindings, ...runtimeSelection };
const plan = objectSchema({ format: { const: 'world-hub.launcher-startup-plan/v1' }, members: array(objectSchema({ programId: id, enabled: boolean('Select for resident startup.'), after: ids('Prerequisite instance IDs.') }, ['programId', 'enabled', 'after']), 'Selected members; omitted registered members are disabled.'), startupOrder: ids('When supplied, list every registered member exactly once.'), onFailure: choice(['continue-independent', 'stop-plan'], 'Failure handling for this startup plan.') }, ['members', 'onFailure']);
const exportFields = { scope: choice(['global', 'local'], 'Global includes all installed instances; local requires programIds.'), programIds: ids('Selected registered instances for local scope.'), destination: text('New destination directory on the Hub machine; defaults to a generated export directory.'), id, title: string, version: text('Semantic version of the exported configuration or dataset.'), license: text('Redistribution license; default MIT.') };
const stopOwned = boolean('Explicitly allow stopping the exact affected owned instances identified by the review.');
function describe(name, properties = {}, required = [], extra = {}) {
  const entry = entries.find(value => value.name === name);
  if (!entry) throw new Error(`Unknown management schema target: ${name}`);
  entry.schema = { ...entry.schema, properties: { ...entry.schema.properties, ...properties },
    required: [...new Set([...(entry.schema.required ?? []), ...required])], ...extra };
}
describe('programs.inspect', runtimeSelection);
describe('programs.preview', { programId: id, directory: text('Complete module source directory on the Hub machine.'), ...configuration }, ['programId', 'directory']);
describe('programs.configuration.preview', { expectedRevision: revision, ...configuration }, ['expectedRevision']);
describe('programs.execution.save', { expectedRevision: revision, policy: objectSchema({ mode: choice(['resident', 'on-demand'], 'Resident participates in startup plans; on-demand wakes for allowed callers.'), idleTimeoutMs: { type: 'integer', minimum: 1000, maximum: 86400000 }, allowedCallers: ids('Other registered instances permitted to wake this module.') }, ['mode', 'idleTimeoutMs', 'allowedCallers']) }, ['expectedRevision', 'policy']);
describe('startup.save', { expectedRevision: revision, plan }, ['expectedRevision', 'plan']);
describe('groups.save', { expectedRevision: { ...revision, description: 'Required only when updating an existing group; omit for a new group.' }, group: objectSchema({ id, title: string, memberProgramIds: ids('References to already registered instances; bodies are not duplicated.'), startupPlan: plan }, ['id', 'title', 'memberProgramIds']) }, ['group']);
describe('wiring.defaults.preview', { scope: choice(['all', 'group', 'module'], 'Author wiring scope.'), targetId: text('Required for module or group scope; omit for all.'), groupSources: map(string, 'Legacy local group ID to exact author source directory when no retained baseline exists.'), connectionSelections: map(map(string, 'Author connection ID to selected installed provider.'), 'Module instance ID to explicit author connection choices.') }, ['scope']);
describe('resources.bodies.export', exportFields, ['scope']);
describe('resources.profiles.capture', { ...exportFields, groupId: text('Optional existing local reference group whose members and plan are captured.'), expectedRevision: revision }, ['scope', 'id', 'title', 'version']);
describe('resources.profiles.retain', { profileIds: array(string, 'Complete set of saved configuration versions to protect during cleanup.'), expectedRevision: revision }, ['profileIds']);
describe('resources.profiles.deactivate', { profileIds: array(string, 'Currently active configuration versions to detach; applied settings and application data are retained.'), expectedRevision: revision }, ['profileIds']);
describe('resources.profiles.export', { profileId: string, destination: exportFields.destination }, ['profileId']);
describe('resources.profiles.preview', { profileId: text('Imported or captured saved configuration version ID.'), mapping: map(id, 'Logical configuration member ID to desired local instance ID; use new IDs for parallel instances.'), groupId: text('Select an exact matching local group if more than one group has the same complete member set.'), replaceProfileIds: array(string, 'Active configuration versions this selection replaces. Omit to use the documented scope defaults.'), expectedRevision: revision }, ['profileId']);
describe('resources.profiles.apply', { stopOwned });
describe('resources.profiles.prepare', { profileId: text('Saved configuration whose exact missing body versions are to be downloaded.') }, ['profileId']);
describe('resources.cleanup.preview', { keepProfileIds: array(string, 'Additional configurations to retain, in addition to every active/retained configuration.'), keepProgramIds: ids('Additional module instances to protect; required provider closure is retained.'), removeUnreferencedBodies: boolean('Also propose deleting unused cached module bodies; default false.') });
describe('resources.cleanup.apply', { stopOwned });
describe('resources.data.export', { ...exportFields, purpose: choice(['backup', 'dataset'], 'Private backup or intentionally redistributable dataset.'), publicDataAcknowledged: boolean('Required true for a public dataset; never inferred from backup selection.'), dataFormat: objectSchema({ id: string, version: string }, ['id', 'version']) }, ['scope', 'id', 'title', 'version', 'purpose']);
describe('resources.data.preview', { dataId: text('Imported/captured dataset version ID.'), mapping: map(id, 'Map every logical dataset instance to a stopped local instance of the exact required body version.') }, ['dataId']);
describe('resources.data.apply', { dataCompatibilityAcknowledged: { const: true, description: 'Explicitly acknowledge module-defined data compatibility; the Hub does not migrate business data.' } }, ['dataCompatibilityAcknowledged']);
describe('paths.browse', { directory: text('Absolute directory on the Hub machine; defaults to the management data root.'), purpose: choice(['module', 'configuration', 'data', 'source', 'executable', 'directory', 'file', 'save-directory', 'save-file'], 'Selection purpose; default directory.'), offset: { type: 'integer', minimum: 0, maximum: 100000, description: 'Next offset from the previous bounded directory page.' } });
describe('environment.detect', runtimeSelection);
describe('sources.save', { id: text('Existing registered source ID when updating; omit to create.'), name: text('Human-readable source name.'), source: text('Local source-index path or HTTPS 443 index URL.'), enabled: boolean('Allow this source to participate in acquisition.'), priority: { type: 'integer', minimum: 0, maximum: 1000 }, revision: { type: 'integer', minimum: 1, description: 'Observed registered source revision when updating.' }, expectedSha256: text('Optional pinned index SHA-256.'), allowPrivateNetwork: boolean('Explicit trusted private-network acquisition policy; default false.') }, ['name', 'source']);
describe('workshop.inspect', { source: text('Local index path or HTTPS index URL, matching a registered address when configured; defaults to the official Workshop index.'), allowPrivateNetwork: boolean('Explicit private-network policy for unregistered sources.') });
describe('workshop.fetch', { source: text('Exact selected index path or HTTPS index URL, matching a registered address when configured.'), digest: text('Index digest returned by workshop inspect.'), entryId: text('Exact selected entryId from that observed index.'), allowPrivateNetwork: boolean('Explicit private-network policy for unregistered sources.') }, ['source', 'digest', 'entryId']);
describe('artifacts.preview', { path: text('Local module/configuration/data artifact JSON, ZIP or source directory.'), directory: text('Alternative to path for a source directory.'), kind: choice(['module', 'configuration', 'data'], 'Optional expected artifact kind.'), programId: text('New instance ID for module installation; omit for a generated ID.'), connectionSelections: map(string, 'Author connection ID to exact selected installed provider.'), ...configuration }, [], { anyOf: [{ required: ['path'] }, { required: ['directory'] }] });
describe('artifacts.apply', { kind: { const: 'module', description: 'Configurations and data use their dedicated resource previews/apply operations.' } }, ['kind']);
describe('artifacts.import', { path: text('Local independent resource artifact to import without starting modules.'), kind: choice(['module', 'configuration', 'data'], 'Optional expected artifact kind.') }, ['path']);
describe('external.preview', { action: choice(['admit', 'revoke', 'disconnect'], 'Admit a communication declaration, revoke its issued grant, or disconnect exact observed sessions.'), expectedRunId: text('Current runId from external list.'), expectedRevision: { type: 'integer', minimum: 0, description: 'Current numeric external-grant revision from external list.' }, programId: text('Required for admit/revoke; external ID of at most 48 safe characters.'), title: string, bridges: array(objectSchema({ slot: id, publish: array(string, 'Exact concrete publish topics.'), subscribe: array(string, 'Exact concrete subscribe topics.') }, ['slot', 'publish', 'subscribe']), 'One to eight bridge declarations for admit.'), provides: array(contract, 'Offered exact capability contracts for admit.'), requires: array(contract, 'Required exact capability contracts for admit.'), bindings, principal: text('Observed unmanaged principal for disconnect.'), connectionIds: array(string, 'Exact current connection IDs for disconnect; never guessed from prior runs.') }, ['action', 'expectedRunId', 'expectedRevision']);
describe('creator.scaffold', { id, directory: text('Source directory to create; defaults to the management module workspace.'), title: string, description: string, runtime: choice(['node', 'python'], 'Starter interpreter; default node.'), entry: text('Entry filename relative to source directory.'), publish: array(string, 'Concrete publish topics; default <id>/data.'), subscribe: array(string, 'Concrete subscribe topics; default system/alert.'), executionDefaults: objectSchema({ mode: choice(['resident', 'on-demand'], 'Author default lifetime; local policy still controls actual callers.'), idleTimeoutMs: { type: 'integer', minimum: 1000, maximum: 86400000 } }, ['mode']) }, ['id']);
entries.find(entry => entry.name === 'creator.scaffold').description = 'Create starter source files, probe the selected runtime and register the new module without starting it.';
describe('creator.package', { directory: text('Source directory containing a module, saved configuration or public data manifest.'), destination: text('New distribution output directory.'), redistributionAcknowledged: { const: true, description: 'Explicitly confirm redistribution rights for every included source/data file.' } }, ['directory', 'destination', 'redistributionAcknowledged']);
for (const collection of ['modules', 'groups']) {
  describe(`versions.${collection}.preview`, { expectedRevision: revision, path: text('Exact author source or supported artifact of the same source identity.'), dataPolicy: choice(['preserve', 'fresh'], 'Retain private application data or start with fresh state; default preserve.'), configurationPolicy: choice(['preserve', 'author'], 'Preserve local public configuration or apply author defaults; default preserve.'), establishOrigin: boolean('Explicitly establish a publisher baseline for a local group without one.') }, ['expectedRevision', 'path']);
  describe(`versions.${collection}.rollback-preview`, { expectedRevision: revision, transactionId: text('Completed transaction ID from this exact target version history.'), dataPolicy: choice(['preserve', 'restore'], 'Retain current data or restore the transaction snapshot; default preserve.') }, ['expectedRevision', 'transactionId']);
  describe(`versions.${collection}.apply`, { dataAcknowledged: { const: true, description: 'Explicitly acknowledge that private application-data compatibility was considered.' } }, ['dataAcknowledged']);
  describe(`uninstall.${collection}.preview`, { programIds: ids('Optional explicit member selection. Group default protects shared members and retained consumers.') });
  describe(`uninstall.${collection}.apply`, { stopOwned });
}
// Runtime probes execute a selected interpreter before interpreting its reply.
// Metadata read permission must not silently authorize that process execution.
for (const entry of entries) if (['programs.inspect', 'programs.preview', 'programs.review', 'programs.configuration.preview', 'startup.review', 'groups.review', 'resources.profiles.preview', 'resources.data.preview'].includes(entry.name)
  || /^versions\.(?:modules|groups)\.(?:preview|rollback-preview)$/u.test(entry.name)) {
  entry.readOnly = false;
}

function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
for (const entry of entries) {
  for (const param of entry.params ?? []) { entry.schema.properties[param] = id; entry.schema.required = [...new Set([...(entry.schema.required ?? []), param])]; }
}
export const MANAGEMENT_OPERATIONS = freeze(entries);
const byName = new Map(MANAGEMENT_OPERATIONS.map(entry => [entry.name, entry]));
export function getManagementOperation(name) { return byName.get(name); }
