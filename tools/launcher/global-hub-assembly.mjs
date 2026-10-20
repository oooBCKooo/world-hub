// Optional Launcher authoring and observation of its independently managed
// programs. Hub Core does not read module manifests or assemble applications.
import { join } from 'node:path';
import { readBounded, hash } from '../../scripts/runtime/paths.mjs';
import { collectSourceFiles } from '../../scripts/runtime/source-guidance.mjs';
import { deploymentTopics } from '../../scripts/runtime/deployment.mjs';
import { previewComposition, createComposition } from './composition.mjs';
import { loopbackUrl, managementLink, observedBridge } from './topology.mjs';
import { globalAssemblyComposition } from './global-hub-update.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const error = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Call inside LocalPrograms.enqueue: registration/removal and source selection
// must describe one authoritative registry snapshot, never browser-supplied rows.
export async function createGlobalHubAssembly({ root, localPrograms, environment, entry }) {
  if (localPrograms.closing) throw error('LAUNCHER_STOPPING', 'Launcher is stopping.');
  const rows = [...localPrograms.records.values()];
  if (!rows.length) throw error('GLOBAL_ASSEMBLY_EMPTY', 'Register at least one managed module on the local Hub before assembling a pack. External bridge sessions do not supply module source.');
  if (rows.length > 32) throw error('GLOBAL_ASSEMBLY_LIMIT', 'A pack supports at most 32 managed program instances. This Hub has more registrations; no partial selection was exported.');
  const observedEntries = rows.filter(row => row.entryUrl);
  const composition = globalAssemblyComposition(localPrograms);
  const startupPlan = localPrograms.getStartupPlan();
  const input = { id: composition.id, version: composition.version, title: composition.title, lineage: composition.lineage ?? null,
    ...(Object.hasOwn(startupPlan, 'startupOrder') ? { startupOrder: [...startupPlan.startupOrder] } : {}),
    entry: entry ?? (observedEntries.length === 1 ? observedEntries[0].programId : rows[0].programId), modules: [] };
  for (const row of rows) {
    const directory = localPrograms.path(row.programId, 'module');
    const files = await collectSourceFiles(directory);
    const manifest = JSON.parse(await readBounded(join(directory, 'module.json')));
    if (!same(files, row.files) || !same(manifest, row.manifest))
      throw error('LOCAL_INSTALLED_CODE_CHANGED', `Installed source changed for ${row.programId}. Register reviewed source again before assembling it.`);
    localPrograms.validateBindings(row.programId, row.manifest, row.bindings);
    const startup = startupPlan.members.find(member => member.programId === row.programId);
    input.modules.push({ directory, componentId: row.programId, settings: clone(row.settings), after: [...startup.after], autostart: startup.enabled,
      topics: clone(row.topics), bridges: clone(row.bridges),
      providers: row.bindings.map(binding => ({ from: binding.providerId, contract: clone(binding.contract) })) });
  }
  const preview = await previewComposition(input);
  for (const row of rows) {
    const component = preview.pack.components.find(candidate => candidate.id === row.programId);
    const topics = deploymentTopics(preview.pack, component, row.deployment);
    if (Object.entries(row.topics).some(([alias, value]) => topics[alias] !== value))
      throw error('GLOBAL_ASSEMBLY_TOPICS_CHANGED', `The assembly could not preserve topic aliases for ${row.programId}.`);
    for (const [slot, rules] of Object.entries(row.bridges)) for (const direction of ['publish', 'subscribe'])
      if (!same(rules[direction].map(alias => row.topics[alias]), component.bridges[slot][direction].map(alias => preview.pack.topics[alias])))
        throw error('GLOBAL_ASSEMBLY_TOPICS_CHANGED', `The assembly could not preserve bridge grants for ${row.programId}.`);
  }
  const result = await createComposition({ root, input, preview, environment });
  return { ...result, composition, startupPlan, source: 'launcher.default', scope: 'managed-source-only', snapshotAt: new Date().toISOString(),
    programs: rows.map(row => ({ programId: row.programId, module: clone(row.module), state: row.state })),
    startsModules: false, altersPrograms: false, includesPrivateState: false, includesExternalBridges: false };
}

export async function observeGlobalHubPrograms({ hub, localPrograms, launcherUrl }) {
  const hubUrl = hub && !hub.exit ? loopbackUrl(hub.url, { rootOnly: true }) : null;
  const unavailable = () => ({ instanceId: 'launcher.default', runId: null, observedAt: new Date().toISOString(),
    observation: 'unavailable', hub: null, bridges: [] });
  if (!hubUrl) return unavailable();
  let snapshot;
  try {
    const response = await fetch(new URL('/status', hubUrl), { signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (!response.ok) return unavailable();
    snapshot = await response.json();
    if (!Array.isArray(snapshot.bridges) || snapshot.bridges.length > 4096) return unavailable();
  } catch { return unavailable(); }
  const bridges = snapshot.bridges.map(bridge => {
    const matches = bridge.authenticated === true ? [...localPrograms.records.values()].filter(row => {
      const handle = localPrograms.handles.get(row.programId), identity = localPrograms.identities.get(row.programId);
      return handle && !handle.exit && !handle.cleanupIncomplete && identity?.principal === bridge.principal
        && row.manifest.bridges.some(slot => `local.${hash(row.programId + ':' + slot).slice(0, 24)}` === bridge.declaredId);
    }) : [];
    const owner = matches.length === 1 ? matches[0] : null;
    const result = { ...observedBridge(bridge),
      ownership: owner ? 'managed' : 'external', process: owner ? 'running' : 'unknown', readiness: 'unknown',
      ...(owner ? { componentId: owner.programId, moduleId: owner.module.id, pid: localPrograms.handles.get(owner.programId).pid } : {}) };
    result.managementUrl = managementLink({ hubUrl: hubUrl.href, launcherUrl, bridge: result });
    return result;
  });
  return { instanceId: 'launcher.default', runId: null, observedAt: new Date().toISOString(), observation: 'live',
    hub: { url: hubUrl.origin, managementUrl: managementLink({ hubUrl: hubUrl.href, launcherUrl }),
      workbenchUrl: managementLink({ hubUrl: hubUrl.href, launcherUrl, workbench: true }) }, bridges };
}
