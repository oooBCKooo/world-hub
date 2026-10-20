// Observe communications; process ownership is proved from the Launcher registry.
import { hash } from '../../scripts/runtime/paths.mjs';
import { loopbackUrl, managementApiLink, observedBridge } from './topology.mjs';

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
    result.managementApiUrl = managementApiLink({ hubUrl: hubUrl.href });
    return result;
  });
  return { instanceId: 'launcher.default', runId: null, observedAt: new Date().toISOString(), observation: 'live',
    hub: { url: hubUrl.origin, managementApiUrl: managementApiLink({ hubUrl: hubUrl.href }),
      statusUrl: new URL('/status', hubUrl).href }, bridges };
}
