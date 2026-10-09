import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLauncherContext, launcherReturnUrl, findLauncherBridge } from '../../../src/management/launcher-link.mjs';

const origin = 'http://127.0.0.1:32123';
const fields = { launcher: 'http://127.0.0.1:32200/', instanceId: 'desk-one', runId: 'run-one', hubOrigin: origin };
const contextUrl = (changes = {}) => `${origin}/manage#${new URLSearchParams({ ...fields, ...changes })}`;

test('LAUNCHER-NAV-01 management links bind navigation to the selected instance, run and actual connection tuple', () => {
  const url = contextUrl({ principal: 'runtime.desk', bridgeId: 'runtime.desk:actual/main', session: 'session-current' });
  const context = parseLauncherContext(url);
  assert.equal(context.launcher, fields.launcher); assert.equal(context.instanceId, 'desk-one');
  assert.equal(context.runId, 'run-one'); assert.equal(context.hubOrigin, origin);
  assert.equal(parseLauncherContext(contextUrl({ workbench: '1' })).workbench, true);
  const returned = new URL(launcherReturnUrl(context, { bridgeId: context.bridgeId, session: context.session }));
  assert.equal(returned.origin, 'http://127.0.0.1:32200');
  assert.equal(returned.searchParams.get('instance'), 'desk-one');
  assert.equal(returned.searchParams.get('runId'), 'run-one');
  assert.equal(returned.searchParams.get('hubOrigin'), origin);
  assert.equal(returned.searchParams.get('bridgeId'), 'runtime.desk:actual/main');
  assert.equal(returned.searchParams.get('session'), 'session-current'); assert.equal(returned.hash, '#logs');
  const rows = [
    { key: 'runtime.desk', programs: [{ id: 'desk', name: 'Desk' }], instances: [] },
    { key: 'old-connection', instances: [{ bridgeId: context.bridgeId, session: 'session-old' }] },
    { key: 'exact-connection', instances: [{ bridgeId: context.bridgeId, session: context.session }] },
  ];
  assert.equal(findLauncherBridge(context, rows), 'exact-connection');
  assert.equal(findLauncherBridge(context, rows.slice(0, 2)), null, 'Annotations and old sessions cannot resolve a current bridge tuple');
  assert.equal(findLauncherBridge(parseLauncherContext(contextUrl({ principal: 'runtime.desk' })), rows), 'runtime.desk');
  const standaloneUrl = `${origin}/manage#${new URLSearchParams({ launcher: fields.launcher, hubOrigin: origin, workbench: '1' })}`;
  const standalone = parseLauncherContext(standaloneUrl);
  assert.equal(standalone.standalone, true); assert.equal(standalone.workbench, true);
  assert.equal(launcherReturnUrl(standalone), fields.launcher + '#hubs');
  assert.equal(launcherReturnUrl(standalone, { bridgeId: 'actual', session: 'current' }), null);
  assert.equal(findLauncherBridge(standalone, rows), null);
});

test('LAUNCHER-NAV-02 malformed or foreign hints do not produce a trusted local return target', () => {
  const invalid = [
    contextUrl({ launcher: 'https://external.invalid/' }), contextUrl({ launcher: 'http://localhost:32200/' }),
    contextUrl({ launcher: 'http://user:password@127.0.0.1:32200/' }),
    contextUrl({ launcher: 'http://127.0.0.1:32200/path' }), contextUrl({ launcher: 'http://127.0.0.1:32200/?token=x' }),
    contextUrl({ launcher: 'http://127.0.0.1:32200/#token' }),
    contextUrl({ hubOrigin: 'http://127.0.0.1:32124/' }),
    contextUrl({ instanceId: '../desk' }), contextUrl({ runId: 'run\nother' }),
    contextUrl({ bridgeId: 'actual-without-session' }), contextUrl({ session: 'session-without-bridge' }),
    contextUrl({ workbench: '0' }), contextUrl({ workbench: 'execute' }), contextUrl({ workbench: '1' }) + '&workbench=1',
    contextUrl() + '&launcher=http%3A%2F%2F127.0.0.1%3A32200%2F', contextUrl() + '&unknown=action',
    `${origin}/manage#${new URLSearchParams({ launcher: fields.launcher, hubOrigin: origin, instanceId: 'desk-one' })}`,
    `${origin}/manage#${new URLSearchParams({ launcher: fields.launcher, hubOrigin: origin, runId: 'run-one' })}`,
    `${origin}/manage#${new URLSearchParams({ launcher: fields.launcher, hubOrigin: origin, bridgeId: 'actual', session: 'current' })}`,
    origin + '/manage#launcher=%',
  ];
  for (const url of invalid) assert.equal(parseLauncherContext(url), null, url);
  assert.equal(launcherReturnUrl({ ...fields, launcher: 'http://external.invalid:32200/' }), null);
  assert.equal(launcherReturnUrl(fields, { bridgeId: 'actual-without-session' }), null);
  assert.equal(findLauncherBridge(null, []), null);
});
