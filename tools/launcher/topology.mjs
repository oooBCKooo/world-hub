export function loopbackUrl(value, { rootOnly = false } = {}) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
      || (rootOnly && (url.pathname !== '/' || url.search || url.hash))) return null;
    return url;
  } catch { return null; }
}
export function managementLink({ hubUrl, launcherUrl, instanceId, runId, bridge, principal, workbench = false }) {
  const hub = loopbackUrl(hubUrl), launcher = loopbackUrl(launcherUrl, { rootOnly: true });
  if (!hub || !launcher) return null;
  const link = new URL('/manage', hub);
  const params = new URLSearchParams({ launcher: launcher.href, hubOrigin: hub.origin + '/' });
  if (instanceId && runId) { params.set('instanceId', instanceId); params.set('runId', runId); }
  if (bridge) { params.set('bridgeId', bridge.bridgeId); params.set('session', bridge.session); }
  else if (principal) params.set('principal', principal);
  // Workbench is already part of the existing Hub console; no duplicate editor.
  if (workbench) params.set('workbench', '1');
  link.hash = params.toString(); return link.href;
}
export function mapTopology({ instanceId, status, snapshot, launcherUrl }) {
  const hub = loopbackUrl(status.hub?.url), live = status.observation !== 'stale' && !status.stoppedAt && Boolean(hub);
  const components = status.components ?? [];
  const bridges = (snapshot?.bridges ?? []).map(bridge => {
    const matches = live ? components.filter(c => c.process === 'running' && c.principal === bridge.principal
      && c.expectedBridges?.includes(bridge.declaredId)) : [];
    const owner = matches.length === 1 ? matches[0] : null;
    const entry = { bridgeId: bridge.bridgeId, session: bridge.session, principal: bridge.principal,
      declaredId: bridge.declaredId, ownership: owner ? 'managed' : 'external',
      ...(owner ? { componentId: owner.id, moduleId: owner.module, pid: owner.pid, process: owner.process,
        health: owner.health, readiness: owner.readiness } : { process: 'unknown', readiness: 'unknown' }) };
    entry.managementUrl = live ? managementLink({ hubUrl: hub.href, launcherUrl, instanceId, runId: status.runId, bridge: entry }) : null;
    return entry;
  });
  return { instanceId, runId: status.runId ?? null, observedAt: new Date().toISOString(), observation: live ? 'live' : 'unavailable',
    hub: hub ? { url: hub.origin, managementUrl: live ? managementLink({ hubUrl: hub.href, launcherUrl, instanceId, runId: status.runId }) : null,
      workbenchUrl: live ? managementLink({ hubUrl: hub.href, launcherUrl, instanceId, runId: status.runId, workbench: true }) : null } : null, bridges };
}
