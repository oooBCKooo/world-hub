import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Hub } from '../../src/hub/lib/hub.mjs';
import { normalizeConfig } from '../../src/hub/lib/store.mjs';
import { createManagementHttp } from '../../src/management/management-http.mjs';
import { Harness, until } from '../helpers/hub-harness.mjs';

const ASSETS = [
  ['/ui/language.mjs', /^(?:text|application)\/javascript(?:;|$)/],
  ['/manage/canvas-i18n.mjs', /^(?:text|application)\/javascript(?:;|$)/],
  ['/manage/manual-i18n.mjs', /^(?:text|application)\/javascript(?:;|$)/],
  ['/manage/manual-bridge.mjs', /^(?:text|application)\/javascript(?:;|$)/],
  ['/manage/manual-console.mjs', /^(?:text|application)\/javascript(?:;|$)/],
  ['/manage/manual-experience-state.mjs', /^(?:text|application)\/javascript(?:;|$)/],
  ['/manage/manual-console.css', /^text\/css(?:;|$)/],
];
const SECRET = 'phase8-management-test-private-credential';
const acl = () => ({
  bridges: { source: { token: 'phase8-private-source', allow: { publish: ['manual/#'], subscribe: [] } } },
  credentials: { fleet: { token: SECRET, maxConnections: 4, allow: { publish: ['manual/#'], subscribe: ['manual/#'] } } },
});

function temporary() {
  return mkdtempSync(join(tmpdir(), 'hub-manual-management-'));
}
function removeTemporary(directory) {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  rmSync(directory, { recursive: true, force: true });
}

async function realFixture(t, path = '/custom-manual-wire') {
  const directory = temporary();
  const configPath = join(directory, 'hub.config.json');
  writeFileSync(configPath, JSON.stringify({ transport: { path }, acl: acl(),
    log: { dir: join(directory, 'log') }, management: { stateFile: join(directory, 'management.json') } }));
  const harness = new Harness({ logDir: join(directory, 'log'), keepTmp: true });
  const peers = [];
  t.after(async () => {
    await Promise.all(peers.map(peer => peer.close()));
    await harness.stop();
    removeTemporary(directory);
  });
  await harness.startHub({ configPath, isolateLog: false });
  return {
    harness,
    async state() {
      const response = await fetch(`${harness.httpBase}/manage/api/state`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      return response.json();
    },
    async post(body) {
      const state = await this.state();
      const response = await fetch(`${harness.httpBase}/manage/api/bridge`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: harness.httpBase,
          'x-management-token': state.csrfToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    },
    async connect(bridge, credential = 'fleet') {
      const ws = new WebSocket(`${harness.httpBase.replace(/^http:/, 'ws:')}${path}`);
      const frames = [];
      let closeInfo = null;
      const peer = {
        ws, frames, get closed() { return closeInfo; }, welcome: null,
        send(frame) { ws.send(JSON.stringify(frame)); },
        async close() {
          if (ws.readyState === WebSocket.CLOSED) return;
          const done = new Promise(done => ws.addEventListener('close', done, { once: true }));
          ws.close();
          await Promise.race([done, new Promise(done => setTimeout(done, 1500))]);
        },
      };
      peers.push(peer);
      await new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(new Error('test peer handshake timeout')), 5000);
        ws.addEventListener('open', () => peer.send({ type: 'hello', wire: '0.1', bridge, credential, token: SECRET }));
        ws.addEventListener('message', event => {
          const frame = JSON.parse(event.data); frames.push(frame);
          if (frame.type === 'welcome') { clearTimeout(timer); peer.welcome = frame; accept(); }
          if (frame.type === 'denied' && !peer.welcome) { clearTimeout(timer); reject(new Error(frame.code)); }
        });
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('test peer socket error')); });
        ws.addEventListener('close', event => {
          closeInfo = { code: event.code, reason: event.reason };
          if (!peer.welcome) { clearTimeout(timer); reject(new Error('test peer closed before welcome')); }
        });
      });
      return peer;
    },
  };
}

async function pureFixture(t) {
  const directory = temporary();
  const config = normalizeConfig({ acl: acl(), transport: { path: '/private-custom-path' },
    log: { enabled: false, dir: directory }, management: { stateFile: join(directory, 'management.json') } }, null);
  const hub = await Hub.create(config);
  t.after(async () => { await hub.stop(); removeTemporary(directory); });
  return createManagementHttp(hub, config);
}

async function invoke(management, { path = '/manage', remote = '127.0.0.1', host = '127.0.0.1:8790', headers = {} } = {}) {
  const req = Readable.from([]);
  Object.assign(req, { method: 'GET', headers: { host, ...headers }, socket: { remoteAddress: remote, localPort: 8790 } });
  const result = { status: null, headers: {}, text: '' };
  const res = { writeHead(status, headers) { result.status = status; result.headers = headers; }, end(text) { result.text = text; } };
  assert.equal(await management.handle(req, res, new URL(path, 'http://127.0.0.1:8790')), true);
  return result;
}
function directive(csp, name) {
  const text = csp.split(';').map(item => item.trim()).find(item => item.startsWith(name + ' '));
  assert.ok(text, `missing CSP ${name}`);
  return text.split(/\s+/).slice(1);
}

test('phase8 manual form: cooked HTML patterns compile with browser v semantics and enforce stable identities', () => {
  const source = readFileSync(new URL('../../src/management/manual-console.mjs', import.meta.url), 'utf8');
  const assignment = 'dialog.innerHTML = ';
  const start = source.indexOf(assignment);
  const end = source.indexOf('\ndocument.body.append(dialog)', start);
  assert.ok(start >= 0 && end > start, 'locate the actual dialog HTML assignment');
  const expression = source.slice(start + assignment.length, end).trim();
  assert.ok(expression.startsWith('`') && expression.endsWith('`;'), 'evaluate only the repository static template expression');
  // Evaluate the JS template first: a single source backslash can disappear in
  // cooked HTML. Compiling the source literal alone would miss this defect.
  const html = runInNewContext(expression.slice(0, -1), { tabs: [], icon: '' }, { timeout: 100 });
  assert.equal(typeof html, 'string');
  const decodeAttribute = (value) => value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[entity.toLowerCase()] !== undefined) return named[entity.toLowerCase()];
    return String.fromCodePoint(entity[2].toLowerCase() === 'x' ? Number.parseInt(entity.slice(3, -1), 16) : Number.parseInt(entity.slice(2, -1), 10));
  });
  const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map(([tag]) => {
    const attributes = new Map([...tag.matchAll(/\b([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, key, double, single]) => [key, decodeAttribute(double ?? single)]));
    return { tag, attributes };
  });
  const patterned = inputs.filter(({ attributes }) => attributes.has('pattern'));
  assert.ok(patterned.length >= 3, 'identity and SHA-256 constraints must be present in cooked HTML');
  for (const { attributes } of patterned) assert.doesNotThrow(() => new RegExp(`^(?:${attributes.get('pattern')})$`, 'v'), `invalid runtime pattern on ${attributes.get('id')}`);
  for (const id of ['mc-bridge', 'mc-credential']) {
    const input = inputs.find(({ attributes }) => attributes.get('id') === id);
    assert.ok(input?.attributes.has('pattern'), `${id} retains its actual HTML constraint`);
    const pattern = new RegExp(`^(?:${input.attributes.get('pattern')})$`, 'v');
    for (const valid of ['a', '0', 'source.sensor-a', 'manual_mod.bridge-1', 'a'.repeat(64)]) assert.equal(pattern.test(valid), true, `${id} must allow ${valid}`);
    for (const invalid of ['BAD_ID', '.abc', '_abc', '-abc', 'a b', 'a/b', '中文', 'a'.repeat(65)]) assert.equal(pattern.test(invalid), false, `${id} must reject ${invalid}`);
    assert.equal(input.attributes.get('maxlength'), '64');
  }
  const bridge = inputs.find(({ attributes }) => attributes.get('id') === 'mc-bridge');
  const credential = inputs.find(({ attributes }) => attributes.get('id') === 'mc-credential');
  assert.match(bridge.tag, /\brequired(?:\s|>)/, 'bridge identity cannot be empty');
  assert.doesNotMatch(credential.tag, /\brequired(?:\s|>)/, 'optional credential permits empty input under browser validation');
  // Browser checkValidity/reportValidity for empty optional fields is verified
  // through the real UI; a RegExp empty-string match does not model required.
});

test('phase8 management assets: real HTTP serves only explicit modules/styles with safe MIME and cache headers', async t => {
  const run = await realFixture(t);
  for (const [path, mime] of ASSETS) {
    const response = await fetch(run.harness.httpBase + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') ?? '', mime, path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
    assert.ok((await response.text()).trim().length > 0, path);
  }
  for (const path of ['/manage/unknown-module.mjs', '/manage/lib/hub.mjs', '/manage/manual-console.css.map']) {
    const response = await fetch(run.harness.httpBase + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error.code, 'MANAGEMENT_ROUTE_UNKNOWN');
  }
});

test('phase8 management assets: loopback, Host and Origin gates apply to every new asset', async t => {
  const management = await pureFixture(t);
  const cases = [
    { remote: '192.0.2.7', code: 'MANAGEMENT_LOCAL_ONLY' },
    { remote: '192.0.2.7', headers: { 'x-forwarded-for': '127.0.0.1' }, code: 'MANAGEMENT_LOCAL_ONLY' },
    { host: 'foreign.example:8790', code: 'HOST_REJECTED' },
    { host: '127.0.0.1:8791', code: 'HOST_REJECTED' },
    { headers: { origin: 'http://foreign.example:8790' }, code: 'ORIGIN_REJECTED' },
    { headers: { origin: 'http://127.0.0.1:8791' }, code: 'ORIGIN_REJECTED' },
    { headers: { 'sec-fetch-site': 'cross-site' }, code: 'ORIGIN_REJECTED' },
  ];
  for (const [path] of ASSETS) for (const { code, ...input } of cases) {
    const response = await invoke(management, { path, ...input });
    assert.equal(response.status, 403, `${path}: ${code}`);
    assert.equal(JSON.parse(response.text).error.code, code);
  }
  for (const [path] of ASSETS) {
    assert.equal((await invoke(management, { path, remote: '::1', host: '[::1]:8790', headers: { origin: 'http://[::1]:8790' } })).status, 200);
  }
});

test('phase8 management page: CSP permits same-origin modules and only its precise WebSocket origin', async t => {
  const management = await pureFixture(t);
  for (const host of ['127.0.0.1:8790', 'localhost:8790', '[::1]:8790']) {
    const response = await invoke(management, { host });
    assert.equal(response.status, 200);
    const csp = response.headers['content-security-policy'];
    assert.equal(typeof csp, 'string');
    assert.ok(directive(csp, 'script-src').includes("'self'"));
    const connections = directive(csp, 'connect-src');
    assert.ok(connections.includes(`ws://${host}`), `CSP must name exact endpoint origin for ${host}`);
    assert.ok(connections.includes("'self'"));
    assert.ok(connections.every(value => value === "'self'" || value === `ws://${host}` || value === `wss://${host}`),
      'no wildcard, scheme-wide or foreign endpoint permission');
    assert.deepEqual(directive(csp, 'frame-ancestors'), ["'none'"]);
  }
});

test('phase8 management state: configured transport path is accurate and never exposes ACL tokens', async t => {
  const path = '/arbitrary/eighth-phase-bridge';
  const run = await realFixture(t, path);
  const state = await run.state();
  assert.equal(state.transport.path, path);
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes('phase8-private-source'), false);
  const peer = await run.connect('custom-path-client');
  assert.equal(peer.welcome.principal, 'fleet', 'the advertised path accepts an actual credential handshake');
  assert.equal(peer.welcome.authenticated, true);
});

test('phase8 selected disconnect: one connection closes, peers keep delivering, and a stale ID cannot close replacements', async t => {
  const run = await realFixture(t);
  const one = await run.connect('manual-one'), two = await run.connect('manual-two');
  two.send({ type: 'subscribe', token: 'untouched-peer', filters: ['manual/#'], from: 0 });
  await until(() => two.frames.some(frame => frame.type === 'subscribed' && frame.token === 'untouched-peer'));
  const before = await run.state();
  const fleet = before.bridges.find(bridge => bridge.key === 'fleet');
  assert.equal(fleet.instances.length, 2);
  const selected = fleet.instances.find(instance => instance.bridgeId === one.welcome.bridge);
  const peerConnection = fleet.instances.find(instance => instance.bridgeId === two.welcome.bridge).connectionId;
  const result = await run.post({ key: 'fleet', action: 'disconnect', connectionIds: [selected.connectionId] });
  assert.equal(result.status, 200); assert.equal(result.body.disconnected, 1);
  await until(() => one.closed);
  assert.equal(two.closed, null);
  const replacement = await run.connect('manual-one');
  const stale = await run.post({ key: 'fleet', action: 'disconnect', connectionIds: [selected.connectionId] });
  assert.equal(stale.status, 200); assert.equal(stale.body.disconnected, 0);
  replacement.send({ type: 'publish', requestToken: 'after-stale-disconnect', topic: 'manual/remaining-peer', body: { live: true } });
  await until(() => replacement.frames.some(frame => frame.type === 'published' && frame.requestToken === 'after-stale-disconnect')
    && two.frames.some(frame => frame.type === 'delivery' && frame.body?.live === true));
  const after = await run.state();
  const current = after.bridges.find(bridge => bridge.key === 'fleet');
  assert.equal(current.instances.length, 2);
  assert.ok(current.instances.some(instance => instance.connectionId === peerConnection), 'untouched peer keeps its connection identity');
  assert.equal(current.paused, false);
  assert.equal(replacement.closed, null);
  assert.equal(two.closed, null);
});
