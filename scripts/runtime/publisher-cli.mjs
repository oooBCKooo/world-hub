// Explicit local publisher tooling. Private keys are never returned in receipts.
import { open, lstat, mkdir, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { generatePublisherKey, signPublisherEvidence, parsePublisherJson, parsePublisherEvidence, PublisherEvidenceError } from './publisher-trust.mjs';
import { readPublisherTrust, previewPublisherTrustChange, applyPublisherTrustChange, verifyStoredPublisherEvidence } from './publisher-store.mjs';
import { ordinaryPath } from './paths.mjs';

export const publisherCommands = ['publisher-keygen', 'publisher-sign', 'publisher-verify', 'publisher-trust', 'publisher-anchor-plan', 'publisher-anchor', 'publisher-update-plan', 'publisher-update'];
export const publisherHelp = `
  world-hub-pack publisher-keygen --private-key new-private.pem --public-key new-public.json
  world-hub-pack publisher-sign --payload payload.json --private-key private.pem [--second-private-key other-private.pem] --destination new-publisher-evidence.json
  world-hub-pack publisher-trust --root directory
  world-hub-pack publisher-anchor-plan --root directory --change change.json
  world-hub-pack publisher-anchor --root directory --change change.json --review-digest reviewed-digest
  world-hub-pack publisher-verify --root directory --evidence publisher-evidence.json [--artifact artifact.json] [--source-status online|offline]
  world-hub-pack publisher-update-plan --root directory --evidence publisher-evidence.json [--artifact artifact.json] [--source-status online|offline]
  world-hub-pack publisher-update --root directory --evidence publisher-evidence.json --review-digest reviewed-digest [--artifact artifact.json] [--source-status online|offline]

Publisher verification is optional and never grants execution permission.
Key generation and signing are explicit local operations; receipts contain only public data.
publisher-verify is read-only; publisher-update records valid public evidence in the local trust store.
Anchors require a separate review digest. Offline verification cannot rule out new revocations or notices.
`;
export const help = publisherHelp;
export function parsePublisherArgs(argv) {
  const command = argv[0]; if (!publisherCommands.includes(command)) throw new Error('Unknown publisher operation');
  if (argv.length === 2 && ['--help', '-h'].includes(argv[1])) return { help: true };
  const mapping = { '--root': 'root', '--private-key': 'privateKeyFile', '--second-private-key': 'secondPrivateKeyFile', '--public-key': 'publicKeyFile', '--payload': 'payloadFile', '--destination': 'destination', '--change': 'changeFile', '--review-digest': 'reviewDigest', '--evidence': 'evidenceFile', '--artifact': 'artifactFile', '--source-status': 'sourceStatus' };
  const accepted = { 'publisher-keygen': ['--private-key', '--public-key'], 'publisher-sign': ['--payload', '--private-key', '--second-private-key', '--destination'], 'publisher-trust': ['--root'], 'publisher-anchor-plan': ['--root', '--change'], 'publisher-anchor': ['--root', '--change', '--review-digest'], 'publisher-verify': ['--root', '--evidence', '--artifact', '--source-status'], 'publisher-update-plan': ['--root', '--evidence', '--artifact', '--source-status'], 'publisher-update': ['--root', '--evidence', '--artifact', '--source-status', '--review-digest'] }[command];
  const options = {}, seen = new Set();
  for (let n = 1; n < argv.length; n += 2) { const flag = argv[n], value = argv[n + 1]; if (!accepted.includes(flag) || seen.has(flag) || !value || value.startsWith('--')) throw new Error('Unknown, duplicate or incomplete option: ' + flag); seen.add(flag); options[mapping[flag]] = value; }
  const required = { 'publisher-keygen': ['privateKeyFile', 'publicKeyFile'], 'publisher-sign': ['payloadFile', 'privateKeyFile', 'destination'], 'publisher-trust': ['root'], 'publisher-anchor-plan': ['root', 'changeFile'], 'publisher-anchor': ['root', 'changeFile', 'reviewDigest'], 'publisher-verify': ['root', 'evidenceFile'], 'publisher-update-plan': ['root', 'evidenceFile'], 'publisher-update': ['root', 'evidenceFile', 'reviewDigest'] }[command];
  for (const flag of required) if (!options[flag]) throw new Error('Required publisher option is missing: ' + flag);
  if (options.sourceStatus && !['online', 'offline'].includes(options.sourceStatus)) throw new Error('--source-status must be online or offline');
  if (options.reviewDigest && !/^[a-f0-9]{64}$/.test(options.reviewDigest)) throw new Error('--review-digest must be an exact reviewed SHA-256');
  return { command, options };
}
async function bounded(file, max = 262144) {
  const path = await ordinaryPath(resolve(file)); const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new PublisherEvidenceError('INVALID_LOCAL_FILE', 'Input must be a bounded regular local file.');
  const h = await open(path, 'r'); try { const bytes = await h.readFile(); if (bytes.length > max) throw new PublisherEvidenceError('INVALID_LOCAL_FILE', 'Input grew beyond its bound.'); return bytes; } finally { await h.close(); }
}
async function newFile(path, content, mode = 0o600) {
  const absolute = resolve(path); await ordinaryPath(dirname(absolute), { allowMissing: true }); await mkdir(dirname(absolute), { recursive: true, mode: 0o700 }); await ordinaryPath(absolute, { allowMissing: true }); const handle = await open(absolute, 'wx', mode);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  return absolute;
}
export async function runPublisher({ command, options }) {
  if (command === 'publisher-keygen') {
    if (resolve(options.privateKeyFile) === resolve(options.publicKeyFile)) throw new PublisherEvidenceError('KEY_PATH_COLLISION', 'Private and public files must be separate.');
    const key = generatePublisherKey(); const privatePath = await newFile(options.privateKeyFile, key.privateKeyPem); let publicPath;
    try { publicPath = await newFile(options.publicKeyFile, JSON.stringify({ format: 'world-hub.publisher-public-key/v1', keyId: key.keyId, publicKey: key.publicKey }, null, 2) + '\n'); }
    catch (error) { await unlink(privatePath); throw error; }
    return { generated: true, keyId: key.keyId, publicKey: key.publicKey, publicPath, privatePath, privateKeyInReceipt: false, startsModules: false, grantsExecution: false };
  }
  if (command === 'publisher-sign') {
    const payload = parsePublisherJson(await bounded(options.payloadFile));
    const keys = [await bounded(options.privateKeyFile, 16384)]; if (options.secondPrivateKeyFile) keys.push(await bounded(options.secondPrivateKeyFile, 16384));
    const evidence = signPublisherEvidence({ payload, privateKeys: keys });
    const destination = await newFile(options.destination, JSON.stringify(evidence, null, 2) + '\n'); return { signed: true, destination, issuer: payload.issuer, type: payload.type, keyIds: evidence.signatures.map(s => s.keyId), privateKeyInReceipt: false, startsModules: false, grantsExecution: false };
  }
  if (command === 'publisher-trust') return readPublisherTrust(options);
  if (command === 'publisher-anchor-plan' || command === 'publisher-anchor') {
    const change = parsePublisherJson(await bounded(options.changeFile)); return command === 'publisher-anchor-plan' ? previewPublisherTrustChange({ ...options, change }) : applyPublisherTrustChange({ ...options, change });
  }
  if (command === 'publisher-verify' || command === 'publisher-update-plan' || command === 'publisher-update') {
    const evidenceBytes = await bounded(options.evidenceFile); const evidence = parsePublisherEvidence(evidenceBytes);
    if (command !== 'publisher-verify' && evidence.payload.type === 'artifact' && !options.artifactFile) throw new PublisherEvidenceError('ARTIFACT_IDENTITY_REQUIRED', 'Artifact observation requires exact independently checked artifact identity.');
    const artifact = options.artifactFile ? parsePublisherJson(await bounded(options.artifactFile)) : undefined;
    const sourceStatus = options.sourceStatus ?? 'offline';
    const preview = await verifyStoredPublisherEvidence({ ...options, artifact, evidenceBytes, observe: false, sourceStatus });
    if (command === 'publisher-verify') return preview;
    const evidenceSha256 = createHash('sha256').update(evidenceBytes).digest('hex');
    const reviewDigest = createHash('sha256').update('WORLD-HUB-PUBLISHER-UPDATE-REVIEW/1\n' + JSON.stringify({ revision: preview.revision, evidenceSha256, artifact: artifact ?? null, sourceStatus })).digest('hex');
    if (command === 'publisher-update-plan') return { ...preview, evidenceSha256, reviewDigest };
    if (options.reviewDigest !== reviewDigest) throw new PublisherEvidenceError('PUBLISHER_REVIEW_CHANGED', 'Evidence bytes, artifact identity, or trust state changed after the review.');
    return verifyStoredPublisherEvidence({ ...options, artifact, evidenceBytes, observe: true, expectedRevision: preview.revision, sourceStatus });
  }
  throw new Error('Unknown publisher operation');
}
