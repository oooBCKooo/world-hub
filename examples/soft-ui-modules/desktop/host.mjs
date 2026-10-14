// The external program owns view validation, snapshots and the local desktop API.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Bridge } from './bridge-kit.mjs';
import { applyCommand } from './model.mjs';
import { loadState, saveState } from './state.mjs';
import { boundPrincipals } from './config.mjs';

export async function startHost(config, diagnostic = () => {}) {
  const connection = config.bridges.find(item => item.slot === 'main');
  const commandTopic = config.topics.commands, eventTopic = config.topics.events;
  if (!connection.publish.includes(eventTopic) || !connection.subscribe.includes(commandTopic)) throw new Error('Soft UI bridge permissions do not match its deployment');
  const allowed = new Set(boundPrincipals(config, 'provider'));
  const snapshotFile = join(config.stateDir, 'views.json');
  const snapshot = loadState(snapshotFile, { version: 1, views: [], revisions: [] });
  if (snapshot.version !== 1 || !Array.isArray(snapshot.views) || !Array.isArray(snapshot.revisions)) throw new Error('Invalid Host snapshot; preserve it and select a new instance');
  let views = new Map(snapshot.views), revisions = new Map(snapshot.revisions), authenticated = false, subscribed = false, stopping = false;
  const token = randomBytes(24).toString('hex');
  const bridge = new Bridge({ url: connection.endpoint, bridgeId: connection.bridgeId, credential: connection.credential,
    token: connection.token, cursorFile: join(config.stateDir, 'bridge-cursor.json'), instanceId: 'soft-ui-host', autoAck: true });
  const ready = () => !stopping && authenticated && subscribed && bridge.connected;
  bridge.on('error', info => {
    diagnostic(info.code ?? 'BRIDGE_ERROR');
    if (['DELIVERY_HANDLER_FAILED', 'RESTORE_FAILED', 'CATCHUP_TRUNCATED'].includes(info.code)) subscribed = false;
  });
  bridge.on('denied', info => diagnostic(info.code ?? 'BRIDGE_DENIED'));
  bridge.on('open', welcome => {
    authenticated = welcome.authenticated === true && welcome.principal === connection.principal;
    if (!authenticated) void bridge.close('Unexpected Host identity');
  });
  bridge.on('close', () => { authenticated = false; subscribed = false; });
  bridge.on('subscribed', info => { if (info.filters?.length === 1 && info.filters[0] === commandTopic) subscribed = true; });
  bridge.on('delivery', message => {
    if (message.operation !== 'inject' || message.topic !== commandTopic || !allowed.has(message.fromPrincipal)) return;
    const nextViews = new Map(views), nextRevisions = new Map(revisions);
    if (!applyCommand(nextViews, message.fromPrincipal, message.body, nextRevisions)) return;
    // Durable application snapshot precedes SDK cursor persistence and ACK.
    saveState(snapshotFile, { version: 1, views: [...nextViews], revisions: [...nextRevisions] });
    views = nextViews; revisions = nextRevisions;
  });
  const json = (res, code, value) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: 'Unexpected Host header' });
    if (req.headers['x-soft-ui-token'] !== token) return json(res, 401, { error: 'Missing UI session key' });
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Forbidden origin' });
    if (req.method === 'GET' && req.url === '/api/views') return json(res, 200, { ready: ready(), views: [...views.values()].filter(view => allowed.has(view.principal)) });
    if (req.method !== 'POST' || req.url !== '/api/event') return json(res, 404, { error: 'Not found' });
    let event;
    try {
      const parts = []; let size = 0;
      for await (const part of req) { size += part.length; if (size > 8192) throw new Error('Too large'); parts.push(part); }
      event = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch { return json(res, 400, { error: 'Invalid event JSON or size' }); }
    const view = views.get(event?.key);
    if (!view || !allowed.has(view.principal) || typeof event.elementId !== 'string') return json(res, 400, { error: 'Invalid view/action' });
    if (event.revision !== view.revision) return json(res, 409, { error: 'The displayed view is stale; wait for refresh' });
    const controls = new Map();
    const visit = node => { if (['button', 'input'].includes(node.type)) controls.set(node.id, node.type); for (const child of node.children ?? []) visit(child); }; visit(view.root);
    if (!((event.action === 'click' && controls.get(event.elementId) === 'button') || (event.action === 'change' && controls.get(event.elementId) === 'input'))
        || (event.value !== undefined && (typeof event.value !== 'string' || event.value.length > 1000))
        || (event.eventId !== undefined && (typeof event.eventId !== 'string' || !/^[0-9a-f-]{36}$/i.test(event.eventId)))) return json(res, 400, { error: 'Unknown or invalid control/action' });
    if (!ready()) return json(res, 503, { error: 'Hub disconnected or subscription stopped' });
    try {
      const receipt = await bridge.sendTo({ principal: view.principal }, eventTopic, { protocol: 'soft-ui/1', kind: 'ui.event',
        eventId: event.eventId ?? randomUUID(), viewId: view.viewId, elementId: event.elementId, action: event.action, value: event.value ?? null, revision: view.revision });
      return json(res, 200, { accepted: true, hubSeq: receipt.seq });
    } catch (error) { return json(res, 502, { error: 'Hub acceptance is unknown', code: error.code ?? 'HUB_WAIT_FAILED' }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  let closing;
  const close = () => closing ??= (async () => {
    stopping = true;
    await bridge.close('Soft UI Host stopped');
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  })();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const welcome = await bridge.connect();
    if (welcome.principal !== connection.principal || welcome.authenticated !== true) throw new Error('Unexpected or unauthenticated Host identity');
    await bridge.registerChannels([{ name: commandTopic, subscribe: true }, { name: eventTopic, publish: true }]);
    await bridge.subscribe([commandTopic], { from: 'resume', operations: ['inject'] });
    subscribed = true;
    return { origin: `http://127.0.0.1:${server.address().port}`, token, ready, close };
  } catch (error) { await close(); throw error; }
}
