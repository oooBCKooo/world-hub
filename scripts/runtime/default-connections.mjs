// Optional deployment defaults resolve installed independent modules. They do
// not register Hub routes, grant bridge permissions, download code or start it.
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const version = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const validVersion = value => typeof value === 'string' && value.length <= 128 && version.test(value);
const contractKey = value => JSON.stringify([value.id, value.version]);
const validContract = value => closed(value, ['id', 'version']) && typeof value.id === 'string'
  && value.id.length > 0 && value.id.length <= 128 && !value.id.includes('\0') && validVersion(value.version);
const contract = value => ({ id: value.id, version: value.version });
const invalid = message => Object.assign(new Error(message), { code: 'DEFAULT_CONNECTION_INVALID', status: 409 });
const declarationInvalid = message => Object.assign(new Error(message), { code: 'DEPLOYMENT_INVALID' });
function closed(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function concreteTopic(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\s\0#+]/.test(value) && value.split('/').every(Boolean);
}

// Shared by uploaded-source validation and the local resolver, with no runtime
// probes or installed-program access required for source validation.
export function validateDefaultConnections(connections, manifest, deployment) {
  if (!Array.isArray(connections) || connections.length > 32) throw declarationInvalid('Declare at most 32 default connections');
  const ids = new Set(), aliases = new Set();
  for (const connection of connections) {
    if (!closed(connection, ['id', 'provider', 'contracts', 'topics']) || typeof connection.id !== 'string' || !identifier.test(connection.id)
        || ids.has(connection.id)) throw declarationInvalid('Default connections need unique IDs and only supported fields');
    ids.add(connection.id);
    if (!closed(connection.provider, ['moduleId', 'version']) || typeof connection.provider.moduleId !== 'string' || !identifier.test(connection.provider.moduleId)
        || !validVersion(connection.provider.version)) throw declarationInvalid('Pin each default connection to an exact provider module and version');
    if (!Array.isArray(connection.contracts) || connection.contracts.length > 32
        || connection.contracts.some(value => !validContract(value))
        || new Set(connection.contracts.map(contractKey)).size !== connection.contracts.length
        || manifest && connection.contracts.some(value => !manifest.requires.some(required => contractKey(required) === contractKey(value)))) {
      throw declarationInvalid('Default connection contracts must be distinct exact capabilities required by this module');
    }
    if (!plain(connection.topics) || Object.keys(connection.topics).length > 64
        || !connection.contracts.length && !Object.keys(connection.topics).length) throw declarationInvalid('A default connection must name a capability or communication topic');
    for (const [alias, target] of Object.entries(connection.topics)) {
      if (!identifier.test(alias) || typeof target !== 'string' || !identifier.test(target) || !Object.hasOwn(deployment?.topics ?? {}, alias)
          || aliases.has(alias)) throw declarationInvalid('Default connections must map distinct declared local aliases to provider aliases');
      aliases.add(alias);
    }
  }
  return connections;
}

function permits(bridges, alias, action) {
  return plain(bridges) && Object.values(bridges).some(rules => Array.isArray(rules?.[action]) && rules[action].includes(alias));
}
function complementary(consumerBridges, alias, providerBridges, providerAlias) {
  return permits(consumerBridges, alias, 'publish') && permits(providerBridges, providerAlias, 'subscribe')
    || permits(consumerBridges, alias, 'subscribe') && permits(providerBridges, providerAlias, 'publish');
}
function candidateFor(row, connection, deployment, programId) {
  return plain(row) && typeof row.programId === 'string' && identifier.test(row.programId) && row.programId !== programId
    && row.module?.id === connection.provider.moduleId && row.module?.version === connection.provider.version
    && Array.isArray(row.provides) && connection.contracts.every(required => row.provides.some(offered => offered?.id === required.id && offered?.version === required.version))
    && Object.entries(connection.topics).every(([alias, providerAlias]) => Object.hasOwn(row.topics ?? {}, providerAlias)
      && concreteTopic(row.topics[providerAlias]) && complementary(deployment.bridges, alias, row.bridges, providerAlias));
}

// Only exact compatible candidates can be selected. In particular, ambiguous
// installed instances are never resolved by list order, running state or title.
export function resolveDefaultConnections({ manifest, deployment, programs, selections = {}, topics, bindings = [], programId } = {}) {
  const declarations = deployment && Object.hasOwn(deployment, 'connections') ? deployment.connections : [];
  validateDefaultConnections(declarations, manifest, deployment);
  if (!Array.isArray(programs) || !plain(selections)
      || Object.keys(selections).some(id => !declarations.some(connection => connection.id === id))) throw invalid('Select only declared default connections');
  if (topics !== undefined && (!plain(topics) || Object.entries(topics).some(([alias, value]) => !identifier.test(alias) || !concreteTopic(value)))) {
    throw invalid('Explicit communication topics must be concrete alias mappings');
  }
  const resolvedTopics = { ...(topics ?? deployment?.topics ?? {}) };
  if (!Array.isArray(bindings) || bindings.length > 32 || bindings.some(binding => !closed(binding, ['providerId', 'contract'])
      || typeof binding.providerId !== 'string' || !identifier.test(binding.providerId) || !validContract(binding.contract)
      || manifest && !manifest.requires.some(required => contractKey(required) === contractKey(binding.contract)))) throw invalid('Explicit capability bindings must name required exact contracts');
  const resolvedBindings = [], bindingKeys = new Set(), selectedContracts = new Map();
  const appendBinding = binding => {
    const key = JSON.stringify([binding.providerId, binding.contract.id, binding.contract.version]);
    if (!bindingKeys.has(key)) { bindingKeys.add(key); resolvedBindings.push({ providerId: binding.providerId, contract: contract(binding.contract) }); }
  };
  bindings.forEach(appendBinding);
  const result = [];
  for (const connection of declarations) {
    for (const alias of Object.keys(connection.topics)) if (!Object.hasOwn(resolvedTopics, alias)) throw invalid(`Default connection ${connection.id} needs the local topic alias ${alias}`);
    const candidates = programs.filter(row => candidateFor(row, connection, deployment, programId));
    // A repeated registry instance is inconsistent and cannot become an implicit
    // duplicate choice or be resolved differently by a later lookup.
    if (new Set(candidates.map(row => row.programId)).size !== candidates.length) throw invalid('Installed default-connection candidates have duplicate program IDs');
    const selection = Object.hasOwn(selections, connection.id) ? selections[connection.id] : undefined;
    if (Object.hasOwn(selections, connection.id) && (typeof selection !== 'string' || !candidates.some(row => row.programId === selection))) {
      throw invalid(`The selected provider for ${connection.id} is not an exact compatible installed module`);
    }
    const provider = selection === undefined ? candidates.length === 1 ? candidates[0] : null : candidates.find(row => row.programId === selection);
    const item = { id: connection.id, provider: { ...connection.provider }, contracts: connection.contracts.map(contract), topics: { ...connection.topics },
      status: provider ? 'resolved' : candidates.length ? 'ambiguous' : 'missing',
      candidates: candidates.map(row => ({ programId: row.programId, module: { id: row.module.id, version: row.module.version }, state: row.state ?? 'unknown' })) };
    if (provider) {
      item.providerId = provider.programId;
      for (const [alias, providerAlias] of Object.entries(connection.topics)) {
        const target = provider.topics[providerAlias];
        if (topics !== undefined && resolvedTopics[alias] !== target) throw invalid(`Explicit topic ${alias} conflicts with default connection ${connection.id}`);
        resolvedTopics[alias] = target;
      }
      for (const required of connection.contracts) {
        const key = contractKey(required), selected = selectedContracts.get(key);
        if (selected && selected !== provider.programId || bindings.some(binding => contractKey(binding.contract) === key && binding.providerId !== provider.programId)) {
          throw invalid(`Capability ${required.id}@${required.version} has conflicting provider selections`);
        }
        selectedContracts.set(key, provider.programId);
        appendBinding({ providerId: provider.programId, contract: required });
      }
    }
    result.push(item);
  }
  if (resolvedBindings.length > 32) throw invalid('Default and explicit capability bindings exceed 32 entries');
  return { connections: result, topics: resolvedTopics, bindings: resolvedBindings, selectionRequired: result.some(item => item.status !== 'resolved') };
}
