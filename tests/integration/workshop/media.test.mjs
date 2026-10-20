import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, unlink, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { request } from 'node:http';
import { hash } from '../../../scripts/runtime/paths.mjs';
import { WorkshopStore, MAX_UPLOAD } from '../../../tools/workshop/store.mjs';
import { createWorkshopServer } from '../../../tools/workshop/server.mjs';
import { inspectMedia, validatePresentation, assertPresentation, MAX_PRESENTATION_REQUEST } from '../../../tools/workshop/media.mjs';
import { workshopCall, registerMember } from './phase18-helpers.mjs';

const password = 'local-media-acceptance-password-2026';
const crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
function chunk(type, data) { const bytes = Buffer.alloc(12 + data.length); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8); let crc = 0xffffffff; for (const byte of bytes.subarray(4, bytes.length - 4)) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes; }
function png(width = 2, height = 3, padding = 0, extra = []) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...extra, ...(padding ? [chunk('tEXt', Buffer.alloc(padding, 65))] : []), chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3)))), chunk('IEND', Buffer.alloc(0))]);
}
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDmqKKK+sPnj//Z', 'base64');
const webp = Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAADwAQCdASoCAAMAAUAmJaACdLoB+AAEgwAA/vAb3/89M15g/yc/+Uq8Fjc3wAAA', 'base64');
const upload = (bytes = png(), mimeType = 'image/png', alt = 'Module screenshot') => ({ mimeType, base64: bytes.toString('base64'), alt });
function moduleArtifact(version = '1.0.0', content = '// A community module, never executed here.\n') {
  const manifest = { format: 'world-hub.module/v1', id: 'test.media-widget', version, license: 'MIT', platforms: ['linux-x64', 'win32-x64'], runtime: { kind: 'node', entry: 'program.mjs' }, bridges: ['main'], provides: [], requires: [], permissions: { filesystem: 'instance-state', network: ['hub-loopback'], processes: 'none' } };
  const files = { 'module.json': Buffer.from(JSON.stringify(manifest)), 'program.mjs': Buffer.from(content) };
  return { format: 'world-hub.source-artifact/v1', kind: 'module', id: manifest.id, version, files: Object.entries(files).map(([path, data]) => ({ path, sha256: hash(data), base64: data.toString('base64') })), provenance: { redistributionAcknowledged: true } };
}
async function directory() { const parent = resolve('.artifacts/workshop-media-tests'); await mkdir(parent, { recursive: true }); return mkdtemp(join(parent, 'case-')); }
async function fixture(t) {
  const root = await directory(), store = await WorkshopStore.open({ root }); await store.initializeAdmin('admin', password); await store.close();
  const service = await createWorkshopServer({ root, baseURL: 'http://127.0.0.1:0/workshop', port: 0, allowInsecureLoopback: true, secureCookie: false }); t.after(() => service.close());
  const login = await workshopCall(service, 'api/login', { username: 'admin', password });
  return { root, service, actor: { ...login.data, cookie: login.cookie } };
}

test('media sniffing accepts actual PNG/JPEG/WebP, rejects mismatches, animation, invalid dimensions and base64', () => {
  for (const [bytes, mimeType] of [[png(), 'image/png'], [jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
    const inspected = inspectMedia(bytes); assert.equal(inspected.mimeType, mimeType); assert.equal(inspected.width, 2); assert.equal(inspected.height, 3);
    const normalized = validatePresentation({ icon: upload(bytes, mimeType) }); assertPresentation(normalized.presentation);
  }
  for (const value of [upload(jpeg, 'image/png'), upload(Buffer.from('<svg><script/></svg>'), 'image/png'), { ...upload(), base64: upload().base64 + '\n' }, { ...upload(), url: 'https://private.example/picture' }, upload(png(4097, 1)), upload(png(0, 1)), upload(png(1, 1, 0, [chunk('acTL', Buffer.alloc(8))])), upload(png().subarray(0, -1)), upload(png(2, 3, 520 * 1024))]) {
    assert.throws(() => validatePresentation({ icon: value }), { code: 'INVALID_PRESENTATION' });
  }
  assert.throws(() => validatePresentation({ icon: { sha256: '0'.repeat(64) } }), { code: 'INVALID_PRESENTATION' });
  assert.throws(() => validatePresentation({ screenshots: Array(7).fill(upload()) }), { code: 'INVALID_PRESENTATION' });
  assert.throws(() => validatePresentation({ cover: upload(png(2, 3, 900 * 1024)), screenshots: Array(5).fill(upload(png(2, 3, 900 * 1024))) }), { code: 'INVALID_PRESENTATION' });
  const animated = Buffer.from(webp); animated.write('ANIM', 12); assert.throws(() => inspectMedia(animated), { code: 'INVALID_PRESENTATION' });
  assert.throws(() => inspectMedia(jpeg.subarray(0, -2)), { code: 'INVALID_PRESENTATION' });
  const corrupt = png(); corrupt[29] ^= 1; assert.throws(() => inspectMedia(corrupt), { code: 'INVALID_PRESENTATION' });
});

test('publication images serve verified bytes and updates preserve source/artifact identity; old versions retain their own images', async t => {
  const { service, actor } = await fixture(t);
  const published = (await workshopCall(service, 'api/publications', { artifact: moduleArtifact(), redistributionAcknowledged: true, presentation: { icon: upload(), cover: upload(jpeg, 'image/jpeg'), screenshots: [upload(webp, 'image/webp')] } }, actor, 201)).data;
  const p = published.publication, indexBefore = service.store.index(service.baseURL);
  assert.equal(p.presentation.icon.alt, 'Module screenshot'); assert.match(p.presentation.cover.url, /^\/workshop\/media\/[a-f0-9]{64}\.jpg$/);
  for (const [asset, bytes] of [[p.presentation.icon, png()], [p.presentation.cover, jpeg], [p.presentation.screenshots[0], webp]]) {
    const response = await fetch(new URL(asset.url, service.url)); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), asset.mimeType); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const head = await fetch(new URL(asset.url, service.url), { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(new URL(asset.url.replace(/\.[a-z]+$/, '.webp'), service.url))).status, asset.mimeType === 'image/webp' ? 200 : 404);
  }
  const update = (await workshopCall(service, `api/publications/${p.entryId}/presentation`, { presentation: { icon: { sha256: p.presentation.icon.sha256, alt: 'New icon text' }, screenshots: [{ sha256: p.presentation.screenshots[0].sha256 }] } }, actor)).data.publication;
  assert.equal(update.sha256, p.sha256); assert.equal(update.version, p.version); assert.equal(update.presentation.icon.alt, 'New icon text'); assert.equal(update.presentation.cover, undefined);
  assert.deepEqual(service.store.index(service.baseURL), indexBefore);
  assert.equal((await fetch(new URL(p.presentation.cover.url, service.url))).status, 404, 'an unreferenced old cover is not public');
  const latest = (await workshopCall(service, 'api/publications', { artifact: moduleArtifact('2.0.0'), redistributionAcknowledged: true, presentation: { icon: upload(png(3, 2), 'image/png', 'Version 2') } }, actor, 201)).data.publication;
  const detail = (await workshopCall(service, `api/publications/${latest.entryId}`)).data;
  assert.deepEqual(detail.versions.map(item => item.version), ['2.0.0', '1.0.0']); assert.equal(detail.versions[1].presentation.icon.alt, 'New icon text');
  assert.equal((await fetch(new URL(p.presentation.icon.url, service.url))).status, 200, 'historical public versions retain images');
  await workshopCall(service, `api/publications/${p.entryId}/presentation`, { presentation: {} }, actor); assert.equal((await fetch(new URL(p.presentation.icon.url, service.url))).status, 404);
});

test('presentation route enforces account ownership, CSRF, visibility and current publication references', async t => {
  const { service, actor } = await fixture(t), owner = await registerMember(service, actor, 'owner', password), stranger = await registerMember(service, actor, 'stranger', password);
  const p = (await workshopCall(service, 'api/publications', { artifact: moduleArtifact(), redistributionAcknowledged: true, presentation: { icon: upload() } }, owner, 201)).data.publication;
  const path = `api/publications/${p.entryId}/presentation`, body = { presentation: { icon: upload(jpeg, 'image/jpeg') } };
  await workshopCall(service, path, body, null, 401); await workshopCall(service, path, body, { cookie: owner.cookie }, 403); await workshopCall(service, path, body, stranger, 403);
  await workshopCall(service, path, { presentation: { icon: { sha256: 'a'.repeat(64) } } }, owner, 400);
  await workshopCall(service, path, body, actor); // Administrators may maintain presentation only.
  await workshopCall(service, `api/publications/${p.entryId}/visibility`, { hidden: true }, actor);
  assert.equal((await fetch(new URL(p.presentation.icon.url, service.url))).status, 404); assert.equal((await workshopCall(service, 'api/catalog')).data.total, 0);
  const hidden = (await workshopCall(service, `api/publications/${p.entryId}`, undefined, owner)).data.publication;
  assert.equal((await fetch(new URL(hidden.presentation.icon.url, service.url))).status, 404);
  await workshopCall(service, `api/publications/${p.entryId}/visibility`, { hidden: false }, actor);
  assert.equal((await fetch(new URL(hidden.presentation.icon.url, service.url))).status, 200);
  const oversized = await new Promise((resolveResponse, reject) => {
    const req = request(new URL(path, service.url), { method: 'POST', headers: { origin: service.origin, cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json', 'content-length': MAX_PRESENTATION_REQUEST + 1 } }, response => { response.resume(); response.on('end', () => resolveResponse(response.statusCode)); });
    req.on('error', reject); req.end('{');
  });
  assert.equal(oversized, 413);
});

test('restart and private export preserve image bytes and fail closed for missing or corrupt referenced images', async t => {
  const root = await directory(), store = await WorkshopStore.open({ root }), actor = await store.initializeAdmin('admin', password);
  const p = (await store.publish(actor, { artifact: moduleArtifact(), redistributionAcknowledged: true, presentation: { icon: upload() } })).publication; await store.close();
  const reopened = await WorkshopStore.open({ root }); const exported = join(await directory(), 'export');
  const report = await reopened.exportTo(exported); assert.equal(report.media, 1); assert.equal(report.bytes, reopened.totalArtifactBytes); await reopened.close();
  const migrated = await WorkshopStore.open({ root: exported }); assert.deepEqual(migrated.detail(p.entryId).publication.presentation, p.presentation); assert.deepEqual((await migrated.mediaBytes(p.presentation.icon.sha256)).bytes, png()); await migrated.close();
  const imagePath = join(root, 'media', `${p.presentation.icon.sha256}.png`); await writeFile(imagePath, Buffer.from('bad'));
  await assert.rejects(WorkshopStore.open({ root }), { code: 'INVALID_STORE' }); await writeFile(imagePath, png()); await unlink(imagePath);
  await assert.rejects(WorkshopStore.open({ root }), { code: 'INVALID_STORE' }); await writeFile(imagePath, png());
  const healthy = await WorkshopStore.open({ root }); t.after(() => healthy.close()); assert.equal(healthy.catalog().total, 1);
});

test('artifact plus media quota is checked before writes and identical assets are stored once', async t => {
  const root = await directory(), store = await WorkshopStore.open({ root, diskQuota: MAX_UPLOAD }); t.after(() => store.close()); const actor = await store.initializeAdmin('admin', password);
  // Previously retained content still consumes quota even when no publication references it.
  await store.storeArtifact(Buffer.alloc(MAX_UPLOAD - 500 * 1024));
  const filesBefore = await readdir(join(root, 'artifacts'));
  await assert.rejects(store.publish(actor, { artifact: moduleArtifact(), redistributionAcknowledged: true, presentation: { cover: upload(png(2, 3, 900 * 1024)) } }), { code: 'ARTIFACT_QUOTA' });
  assert.equal(store.state.publications.length, 0); assert.deepEqual(await readdir(join(root, 'artifacts')), filesBefore); assert.deepEqual(await readdir(join(root, 'media')), []);
  const p = (await store.publish(actor, { artifact: moduleArtifact(), redistributionAcknowledged: true, presentation: { icon: upload(), cover: upload(), screenshots: [upload()] } })).publication;
  assert.equal(store.media.size, 1); assert.equal((await readdir(join(root, 'media'))).length, 1);
  const before = store.totalArtifactBytes; await store.updatePresentation(actor, p.entryId, { icon: upload() }); assert.equal(store.totalArtifactBytes, before);
  const imagePath = join(root, 'media', `${p.presentation.icon.sha256}.png`); await writeFile(imagePath, png(3, 2));
  await assert.rejects(store.updatePresentation(actor, p.entryId, { icon: { sha256: p.presentation.icon.sha256 } }), { code: 'MEDIA_CORRUPT' });
});
