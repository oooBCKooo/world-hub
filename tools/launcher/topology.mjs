export function loopbackUrl(value, { rootOnly = false } = {}) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
      || (rootOnly && (url.pathname !== '/' || url.search || url.hash))) return null;
    return url;
  } catch { return null; }
}
// Whitelist transport observations. No client PID, secret or application health
// claim is promoted into Launcher process ownership.
export function observedBridge(bridge) {
  return { bridgeId: bridge.bridgeId, principal: bridge.principal, session: bridge.session, declaredId: bridge.declaredId,
    authenticated: bridge.authenticated === true, since: bridge.since, remoteAddress: bridge.remoteAddress,
    channels: (bridge.channels ?? []).map(channel => ({ name: channel.name, publish: channel.publish === true, subscribe: channel.subscribe === true })),
    subscriptions: [...(bridge.subscriptions ?? [])], published: bridge.published ?? 0, delivered: bridge.delivered ?? 0 };
}
export function managementApiLink({ hubUrl }) {
  const hub = loopbackUrl(hubUrl);
  return hub ? new URL('/manage/api', hub).href : null;
}
export function mapTopology({ instanceId, status, snapshot, launcherUrl }) {
  const hub = loopbackUrl(status.hub?.url), live = status.observation !== 'stale' && !status.stoppedAt && Boolean(hub);
  const components = status.components ?? [];
  const bridges = (snapshot?.bridges ?? []).map(bridge => {
    const matches = live ? components.filter(c => c.process === 'running' && c.principal === bridge.principal
      && c.expectedBridges?.includes(bridge.declaredId)) : [];
    const owner = matches.length === 1 ? matches[0] : null;
    const entry = { ...observedBridge(bridge), ownership: owner ? 'managed' : 'external',
      ...(owner ? { componentId: owner.id, moduleId: owner.module, pid: owner.pid, process: owner.process,
        health: owner.health, readiness: owner.readiness } : { process: 'unknown', readiness: 'unknown' }) };
    entry.managementApiUrl = live ? managementApiLink({ hubUrl: hub.href }) : null;
    return entry;
  });
  return { instanceId, runId: status.runId ?? null, observedAt: new Date().toISOString(), observation: live ? 'live' : 'unavailable',
    hub: hub ? { url: hub.origin, managementApiUrl: live ? managementApiLink({ hubUrl: hub.href }) : null,
      statusUrl: live ? new URL('/status', hub).href : null } : null, bridges };
}
