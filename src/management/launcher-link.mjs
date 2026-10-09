// Optional navigation only. A fragment is a hint, never Runtime ownership or authority.
const text = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const keys = new Set(['launcher', 'instanceId', 'runId', 'hubOrigin', 'principal', 'bridgeId', 'session', 'workbench']);

function localRoot(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

export function parseLauncherContext(location) {
  try {
    const current = new URL(typeof location === 'string' ? location : location.href);
    const params = new URLSearchParams(current.hash.slice(1));
    if (!params.has('launcher')) return null;
    if ([...params.keys()].some(key => !keys.has(key) || params.getAll(key).length !== 1)) return null;
    const launcher = localRoot(params.get('launcher')), hub = localRoot(params.get('hubOrigin'));
    const instanceId = params.get('instanceId'), runId = params.get('runId');
    if (!launcher || !hub || hub.origin !== current.origin || params.has('instanceId') !== params.has('runId')) return null;
    const standalone = !params.has('instanceId');
    if (!standalone && (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(instanceId ?? '') || !text(runId))) return null;
    if (standalone && ['principal', 'bridgeId', 'session'].some(key => params.has(key))) return null;
    for (const key of ['principal', 'bridgeId', 'session']) if (params.has(key) && !text(params.get(key))) return null;
    if (params.has('bridgeId') !== params.has('session')) return null;
    if (params.has('workbench') && params.get('workbench') !== '1') return null;
    return { launcher: launcher.href, instanceId, runId, hubOrigin: hub.origin, standalone,
      principal: params.get('principal'), bridgeId: params.get('bridgeId'), session: params.get('session'), workbench: params.get('workbench') === '1' };
  } catch { return null; }
}

export function launcherReturnUrl(context, connection = null) {
  const base = localRoot(context?.launcher), hub = localRoot(context?.hubOrigin);
  if (!base || !hub) return null;
  const url = new URL(base.href);
  if (context.standalone && !context.instanceId && !context.runId) {
    if (connection) return null;
    url.hash = 'hubs'; return url.href;
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(context?.instanceId ?? '') || !text(context?.runId)) return null;
  url.searchParams.set('instance', context.instanceId);
  url.searchParams.set('runId', context.runId);
  url.searchParams.set('hubOrigin', hub.origin);
  if (connection) {
    if (!text(connection.bridgeId) || !text(connection.session)) return null;
    url.searchParams.set('bridgeId', connection.bridgeId);
    url.searchParams.set('session', connection.session);
    url.hash = 'logs';
  }
  return url.href;
}

export function findLauncherBridge(context, bridges) {
  if (!context || !Array.isArray(bridges)) return null;
  if (context.bridgeId) {
    return bridges.find(bridge => Array.isArray(bridge.instances) && bridge.instances.some(connection =>
      connection.bridgeId === context.bridgeId && connection.session === context.session))?.key ?? null;
  }
  return context.principal ? bridges.find(bridge => bridge.key === context.principal)?.key ?? null : null;
}

export function createLauncherNavigation({ document, location, getLanguage }) {
  const context = parseLauncherContext(location);
  let signature = '', openedWorkbench = false;
  const label = (zh, en) => getLanguage() === 'en' ? en : zh;
  function link(href, content, className = '') {
    const node = document.createElement('a'); node.href = href; node.textContent = content;
    node.className = className; node.rel = 'noopener noreferrer'; return node;
  }
  return { context, target: bridges => findLauncherBridge(context, bridges), openWorkbench() {
    if (context?.workbench && !openedWorkbench) { openedWorkbench = true; document.getElementById('btn-manual-console')?.click(); }
  }, update({ bridge = null, fresh = false } = {}) {
    if (!context) return;
    const next = JSON.stringify([getLanguage(), fresh, bridge?.key, bridge?.instances]);
    if (next === signature) return; signature = next;
    const home = document.getElementById('launcher-home-link'), section = document.getElementById('launcher-links');
    if (home) {
      home.href = launcherReturnUrl(context); home.rel = 'noopener noreferrer';
      home.textContent = context.standalone ? label('返回 World Hub', 'Back to World Hub') : label('整合包管理', 'Pack management'); home.classList.remove('hidden');
    }
    if (!section) return;
    section.classList.toggle('hidden', !bridge); section.replaceChildren();
    if (!bridge) return;
    const title = document.createElement('h3'); title.textContent = context.standalone
      ? label('本机管理导航', 'Local management navigation') : label('整合包实例与日志', 'Pack instance and logs'); section.append(title);
    const note = document.createElement('p'); note.className = 'action-help-text';
    note.textContent = fresh
      ? label('回到 Launcher 核对本次连接归属；连接不证明业务就绪。', 'Return to Launcher to verify ownership of this connection; connectivity does not prove business readiness.')
      : label('通信快照已过期，请刷新后核对归属。', 'The communication snapshot is stale. Refresh before verifying ownership.');
    section.append(note);
    if (!fresh) return;
    if (context.standalone) {
      note.textContent = label('此 Hub 独立于整合包实例；外部程序运行状态未知。', 'This Hub is separate from pack instances; external process state is unknown.');
      return;
    }
    let count = 0;
    for (const connection of Array.isArray(bridge.instances) ? bridge.instances : []) {
      const href = launcherReturnUrl(context, connection); if (!href) continue;
      const row = document.createElement('p'), identity = document.createElement('span'); identity.className = 'mono';
      identity.textContent = `${connection.bridgeId} · ${connection.session}`;
      row.append(identity, document.createElement('br'), link(href, label('核对归属与查看日志 →', 'Verify ownership and view logs →'), 'action-btn'));
      section.append(row); count++;
    }
    if (!count) {
      const unknown = document.createElement('p'); unknown.className = 'action-help-text';
      unknown.textContent = label('当前没有可核对的连接；外部程序运行状态未知。', 'No current connection is available to verify; external process state is unknown.');
      section.append(unknown);
    }
  } };
}
