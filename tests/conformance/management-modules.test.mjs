import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Hub } from '../../src/hub/lib/hub.mjs';
import { normalizeConfig } from '../../src/hub/lib/store.mjs';
import { createManagementHttp } from '../../src/management/management-http.mjs';
import { Readable } from 'node:stream';

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'hub-mgmt-modules-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function invoke(management, { method = 'GET', path = '/manage/api/programs', remote = '127.0.0.1', host = '127.0.0.1:8790', headers = {}, body = null } = {}) {
  const rawBody = body ? JSON.stringify(body) : '';
  const req = Readable.from([Buffer.from(rawBody)]);
  Object.assign(req, {
    method,
    headers: { host, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    socket: { remoteAddress: remote, localPort: 8790 }
  });
  const result = { status: null, headers: {}, text: '' };
  const res = {
    writeHead(status, responseHeaders) { result.status = status; result.headers = responseHeaders; },
    end(text) { result.text = text; }
  };
  const handled = await management.handle(req, res, new URL(path, 'http://127.0.0.1:8790'));
  assert.equal(handled, true);
  result.body = result.text ? JSON.parse(result.text) : null;
  return result;
}

test('management modules: serves programs, groups, wiring, and persists canvas layout', async t => {
  const root = temporary(t);
  const config = normalizeConfig({
    acl: { bridges: {}, credentials: {} },
    log: { enabled: false, dir: root },
    management: { stateFile: join(root, 'management.json'), explicitStateFile: true }
  }, null);

  const hub = await Hub.create(config);
  t.after(() => hub.stop());

  const management = await createManagementHttp(hub, config);
  const token = management.snapshot().csrfToken;

  // 1. GET /manage/api/programs
  const programsRes = await invoke(management, {
    method: 'GET',
    path: '/manage/api/programs'
  });
  assert.equal(programsRes.status, 200);
  assert.ok(Array.isArray(programsRes.body.programs));
  assert.ok(programsRes.body.startupPlan);
  assert.ok(Array.isArray(programsRes.body.groups));
  assert.ok(programsRes.body.wiring);
  assert.ok(programsRes.body.layout);

  // 2. POST /manage/api/layout (Save coordinates)
  const layoutSaveRes = await invoke(management, {
    method: 'POST',
    path: '/manage/api/layout',
    headers: { 'x-management-token': token },
    body: {
      nodes: {
        'test-node-1': { x: 120, y: -45 },
        'test-node-2': { x: 450, y: 200 }
      },
      modes: {
        static: { 'test-node-1': { x: 0, y: 0 } },
        runtime: { 'test-node-1': { x: 120, y: -45 } },
        wiring: { 'test-node-1': { x: -280, y: 0 } },
        orchestration: { 'test-node-1': { x: -440, y: 35 } }
      }
    }
  });
  assert.equal(layoutSaveRes.status, 200);
  assert.equal(layoutSaveRes.body.ok, true);
  assert.equal(layoutSaveRes.body.layout.nodes['test-node-1'].x, 120);
  assert.equal(layoutSaveRes.body.layout.nodes['test-node-1'].y, -45);
  assert.equal(layoutSaveRes.body.layout.modes.static['test-node-1'].x, 0);
  assert.equal(layoutSaveRes.body.layout.modes.runtime['test-node-1'].x, 120);
  assert.equal(layoutSaveRes.body.layout.modes.wiring['test-node-1'].x, -280);
  assert.equal(layoutSaveRes.body.layout.modes.orchestration['test-node-1'].x, -440);

  // 3. GET /manage/api/layout (Retrieve coordinates)
  const layoutGetRes = await invoke(management, {
    method: 'GET',
    path: '/manage/api/layout'
  });
  assert.equal(layoutGetRes.status, 200);
  assert.equal(layoutGetRes.body.layout.nodes['test-node-1'].x, 120);
  assert.equal(layoutGetRes.body.layout.nodes['test-node-2'].y, 200);
  assert.equal(layoutGetRes.body.layout.modes.static['test-node-1'].x, 0);
  assert.equal(layoutGetRes.body.layout.modes.runtime['test-node-1'].x, 120);
  assert.equal(layoutGetRes.body.layout.modes.wiring['test-node-1'].x, -280);
  assert.equal(layoutGetRes.body.layout.modes.orchestration['test-node-1'].x, -440);

  // 4. GET /manage/api/groups
  const groupsRes = await invoke(management, {
    method: 'GET',
    path: '/manage/api/groups'
  });
  assert.equal(groupsRes.status, 200);
  assert.ok(Array.isArray(groupsRes.body.groups));

  // 5. GET and POST /manage/api/programs/startup-plan (Not swallowed by parameterized routes)
  const planGetRes = await invoke(management, {
    method: 'GET',
    path: '/manage/api/programs/startup-plan'
  });
  assert.equal(planGetRes.status, 200);
  assert.ok(planGetRes.body.plan);

  const planStartRes = await invoke(management, {
    method: 'POST',
    path: '/manage/api/programs/startup-plan/start',
    headers: { 'x-management-token': token },
    body: {}
  });
  assert.equal(planStartRes.status, 202);
  assert.equal(planStartRes.body.ok, true);

  const planStatusRes = await invoke(management, {
    method: 'GET',
    path: '/manage/api/programs/startup-plan/status',
    headers: { 'x-management-token': token }
  });
  assert.equal(planStatusRes.status, 200);
  assert.equal(planStatusRes.body.ok, true);
  assert.ok(planStatusRes.body.status !== undefined);
});

test('management modules: dissolving a group archives it to dissolvedGroups and allows restore and discard', async t => {
  const root = temporary(t);
  const config = normalizeConfig({
    acl: { bridges: {}, credentials: {} },
    log: { enabled: false, dir: root },
    management: { stateFile: join(root, 'management.json'), explicitStateFile: true }
  }, null);

  const hub = await Hub.create(config);
  t.after(() => hub.stop());

  const management = await createManagementHttp(hub, config);
  const token = management.snapshot().csrfToken;

  // 1. Create a module group
  const createRes = await invoke(management, {
    method: 'POST',
    path: '/manage/api/groups/save',
    headers: { 'x-management-token': token },
    body: {
      group: {
        id: 'test-dissolve-group',
        title: 'Dissolve Test Group',
        memberProgramIds: []
      }
    }
  });
  assert.equal(createRes.status, 200);
  assert.equal(createRes.body.group.id, 'test-dissolve-group');

  // 2. Initial state: active group exists, dissolved list is empty
  let groupsRes = await invoke(management, { method: 'GET', path: '/manage/api/groups' });
  assert.equal(groupsRes.status, 200);
  assert.equal(groupsRes.body.groups.length, 1);
  assert.deepEqual(groupsRes.body.dissolvedGroups, []);

  // 3. Dissolve (remove) group
  const removeRes = await invoke(management, {
    method: 'POST',
    path: '/manage/api/groups/test-dissolve-group/remove',
    headers: { 'x-management-token': token },
    body: { expectedRevision: createRes.body.group.revision }
  });
  assert.equal(removeRes.status, 200);
  assert.equal(removeRes.body.removed, true);
  assert.equal(removeRes.body.dissolved, true);

  // 4. Group is now dissolved: not in active groups, present in dissolvedGroups
  groupsRes = await invoke(management, { method: 'GET', path: '/manage/api/groups' });
  assert.equal(groupsRes.body.groups.length, 0);
  assert.equal(groupsRes.body.dissolvedGroups.length, 1);
  assert.equal(groupsRes.body.dissolvedGroups[0].id, 'test-dissolve-group');
  assert.equal(groupsRes.body.dissolvedGroups[0].title, 'Dissolve Test Group');
  assert.ok(groupsRes.body.dissolvedGroups[0].dissolvedAt);

  // Also visible in /manage/api/programs
  const progRes = await invoke(management, { method: 'GET', path: '/manage/api/programs' });
  assert.equal(progRes.body.groups.length, 0);
  assert.equal(progRes.body.dissolvedGroups.length, 1);

  // 5. Restore (Undo dissolve)
  const restoreRes = await invoke(management, {
    method: 'POST',
    path: '/manage/api/groups/test-dissolve-group/restore',
    headers: { 'x-management-token': token },
    body: {}
  });
  assert.equal(restoreRes.status, 200, JSON.stringify(restoreRes.body));
  assert.equal(restoreRes.body.ok, true);
  assert.equal(restoreRes.body.restored, true);
  assert.equal(restoreRes.body.group.id, 'test-dissolve-group');

  // Active again, dissolved cleared
  groupsRes = await invoke(management, { method: 'GET', path: '/manage/api/groups' });
  assert.equal(groupsRes.body.groups.length, 1);
  assert.equal(groupsRes.body.groups[0].title, 'Dissolve Test Group');
  assert.deepEqual(groupsRes.body.dissolvedGroups, []);

  // 6. Dissolve again, then permanently discard
  const secondRemove = await invoke(management, {
    method: 'POST',
    path: '/manage/api/groups/test-dissolve-group/remove',
    headers: { 'x-management-token': token },
    body: { expectedRevision: restoreRes.body.group.revision }
  });
  assert.equal(secondRemove.status, 200);

  const discardRes = await invoke(management, {
    method: 'POST',
    path: '/manage/api/groups/test-dissolve-group/discard',
    headers: { 'x-management-token': token },
    body: {}
  });
  assert.equal(discardRes.status, 200);
  assert.equal(discardRes.body.discarded, true);

  // Both empty now
  groupsRes = await invoke(management, { method: 'GET', path: '/manage/api/groups' });
  assert.equal(groupsRes.body.groups.length, 0);
  assert.deepEqual(groupsRes.body.dissolvedGroups, []);
});
