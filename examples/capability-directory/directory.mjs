#!/usr/bin/env node
// An optional external catalog. The Hub neither loads nor interprets manifests.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPurposePeerMain } from '../purpose-demos/peer.mjs';
import { channel, openState } from '../purpose-demos/common.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const version = value => typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value);
const name = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const fault = (code, message) => Object.assign(new Error(message), { code });

function validateManifest(body, expectedModule, prefix) {
  if (!object(body) || body.manifestVersion !== 1 || Buffer.byteLength(JSON.stringify(body)) > 24000)
    throw fault('MANIFEST_INVALID', 'Expected a bounded manifestVersion 1 object.');
  if (body.principal !== undefined || body.session !== undefined || body.endpoint !== undefined)
    throw fault('IDENTITY_NOT_DECLARABLE', 'Catalog addresses come from authenticated communication envelopes.');
  if (!object(body.module) || body.module.id !== expectedModule || !version(body.module.version))
    throw fault('MODULE_IDENTITY_MISMATCH', 'The configured principal must register its own module identity.');
  if (!Number.isSafeInteger(body.leaseMs) || body.leaseMs < 300 || body.leaseMs > 10000)
    throw fault('MANIFEST_INVALID', 'leaseMs must be an integer from 300 to 10000.');
  if (!Array.isArray(body.capabilities) || !body.capabilities.length || body.capabilities.length > 8)
    throw fault('MANIFEST_INVALID', 'Expected 1 to 8 capabilities.');
  const ids = new Set();
  for (const capability of body.capabilities) {
    if (!object(capability) || !name(capability.id) || ids.has(capability.id) || !object(capability.contract)
        || !name(capability.contract.id) || !version(capability.contract.version)
        || !object(capability.inputSchema) || !object(capability.outputSchema)
        || typeof capability.semantics !== 'string' || capability.semantics.length > 200
        || typeof capability.topic !== 'string' || !capability.topic.startsWith(prefix)
        || capability.topic.length > 200 || /[#+\s]/u.test(capability.topic)
        || !['read-only', 'writes-state', 'external-effects'].includes(capability.effects)
        || !Array.isArray(capability.permissions) || capability.permissions.length > 16
        || capability.permissions.some(permission => !name(permission)))
      throw fault('MANIFEST_INVALID', 'Capability descriptors must include bounded contracts, schemas, semantics, effects and permissions.');
    ids.add(capability.id);
  }
  return { module: structuredClone(body.module), capabilities: structuredClone(body.capabilities), leaseMs: body.leaseMs };
}

export async function startDirectory(context) {
  if (context.profile.id !== 'capability-directory' || context.peer.id !== 'directory') throw new Error('This entry is the external capability directory.');
  let config = { providers: {
    'demo.capability-directory.metrics-a': 'metrics-a',
    'demo.capability-directory.metrics-b': 'metrics-b',
  } };
  try { config = JSON.parse(await readFile(join(context.stateDir, 'catalog-config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!object(config.providers) || Object.entries(config.providers).some(([principal, module]) => !name(principal) || !name(module)))
    throw new Error('catalog-config.json requires an explicit principal to module allowlist.');
  const epoch = randomUUID();
  const state = await openState(context.stateDir, 'directory-state.json', { version: 1, entries: [] });
  // Stored descriptors remain visible, but no previous incarnation's lease is valid.
  const entries = new Map(state.value.entries.map(entry => [entry.principal, { ...entry, expiresAt: 0 }]));
  await state.save({ version: 1, epoch, entries: [...entries.values()] });
  const register = context.topic('catalog/register'), query = context.topic('catalog/query');
  await context.openBridge('main', { channels: [channel(register, { subscribe: true }), channel(query, { subscribe: true })],
    filters: [register, query], operations: ['request'],
    onDelivery: async (message, bridge) => {
      try {
        if (message.topic === register) {
          const expected = config.providers[message.fromPrincipal];
          if (!expected) throw fault('REGISTRATION_DENIED', 'The catalog has not authorized this provider principal.');
          if (!message.senderSession) throw fault('REGISTRATION_DENIED', 'A communication session is required.');
          const descriptor = validateManifest(message.body, expected, context.topic(''));
          const receivedAt = Date.now();
          const entry = { module: descriptor.module, capabilities: descriptor.capabilities,
            principal: message.fromPrincipal, session: message.senderSession,
            registeredAt: receivedAt, expiresAt: receivedAt + descriptor.leaseMs };
          entries.set(entry.principal, entry);
          await state.save({ version: 1, epoch, entries: [...entries.values()] });
          await bridge.respond(message, { ok: true, kind: 'demo.capability-registration', epoch, entry: { ...entry, state: 'lease-valid' } });
        } else {
          if (!object(message.body) || (message.body.capability !== undefined && !name(message.body.capability)))
            throw fault('QUERY_INVALID', 'capability must be a capability identifier.');
          const at = Date.now();
          const listed = [...entries.values()].filter(entry => !message.body.capability
            || entry.capabilities.some(capability => capability.id === message.body.capability));
          await bridge.respond(message, { ok: true, kind: 'demo.capability-directory', epoch, queriedAt: at,
            entries: listed.map(entry => ({ ...entry, state: entry.expiresAt > at ? 'lease-valid' : 'lease-expired' })),
            note: 'A valid catalog lease is a provider advertisement, not proof of live execution or permission.' });
        }
      } catch (error) {
        await bridge.respond(message, { ok: false, kind: 'demo.capability-directory', epoch,
          status: 'failed', error: { code: error.code ?? 'CATALOG_FAILED', message: error.message, retryable: false } });
      }
    } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runPurposePeerMain(startDirectory);
