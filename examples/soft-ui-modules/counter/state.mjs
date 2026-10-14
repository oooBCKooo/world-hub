import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Application snapshots are separate from the Hub's communication log / ACK cursor.
export function statePath(directory, role, identity, endpoint, deployment) {
  const key = createHash('sha256').update(JSON.stringify([identity, endpoint, deployment])).digest('hex').slice(0, 20);
  return join(directory, `${role}-${key}.json`);
}
export function loadState(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw new Error(`Cannot read application snapshot ${file}: ${error.message}`); }
}
export function saveState(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
