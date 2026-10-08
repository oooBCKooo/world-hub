// Local control-plane settings. They never transform or release messages.
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isValidBridgeId } from '../hub/lib/acl.mjs';

const fault = (code, message) => Object.assign(new Error(message), { code });
export function validateAnnotation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.bridgeName !== 'string'
    || value.bridgeName.length > 120 || !Array.isArray(value.programs) || value.programs.length > 16) throw fault('ANNOTATION_INVALID', '桥名称不超过120字符，程序注记最多16项');
  const ids = new Set();
  for (const program of value.programs) {
    if (!program || typeof program.id !== 'string' || !program.id || program.id.length > 120
      || typeof program.name !== 'string' || !program.name || program.name.length > 120 || ids.has(program.id)) throw fault('ANNOTATION_INVALID', '每项程序注记需要不同的id及名称，均不超过120字符');
    ids.add(program.id);
  }
  return { bridgeName: value.bridgeName, programs: value.programs.map(({ id, name }) => ({ id, name })) };
}

function validateState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.paused) || value.paused.length > 1024
    || value.paused.some(id => !isValidBridgeId(id)) || new Set(value.paused).size !== value.paused.length
    || !value.annotations || typeof value.annotations !== 'object' || Array.isArray(value.annotations)
    || Object.keys(value.annotations).length > 1024) throw fault('MANAGEMENT_STATE_CORRUPT', '管理设置无效；拒绝猜测接入策略');
  const annotations = Object.create(null);
  for (const [key, annotation] of Object.entries(value.annotations)) {
    if (!isValidBridgeId(key)) throw fault('MANAGEMENT_STATE_CORRUPT', '管理注记主体无效');
    annotations[key] = validateAnnotation(annotation);
  }
  return { version: 1, paused: [...value.paused], annotations };
}

export class ManagementState {
  #file; #value; #queue = Promise.resolve();
  constructor(file, value) { this.#file = file; this.#value = value; }
  static async open(file, annotations = {}) {
    let value;
    try { value = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') value = { version: 1, paused: [], annotations };
      else throw fault('MANAGEMENT_STATE_CORRUPT', `管理设置无法读取：${error.message}`);
    }
    try { return new ManagementState(file, validateState(value)); }
    catch (error) { throw fault('MANAGEMENT_STATE_CORRUPT', error.message); }
  }
  get value() { return structuredClone(this.#value); }
  update(change, afterCommit) {
    const task = this.#queue.then(async () => {
      const next = this.value; change(next); const checked = validateState(next);
      const temporary = `${this.#file}.${randomUUID()}.tmp`; let handle;
      try {
        await mkdir(dirname(this.#file), { recursive: true });
        handle = await open(temporary, 'wx');
        await handle.writeFile(JSON.stringify(checked), 'utf8'); await handle.sync(); await handle.close(); handle = null;
        await rename(temporary, this.#file);
        this.#value = checked;
        afterCommit?.(this.value);
        return this.value;
      } finally {
        if (handle) await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
      }
    });
    this.#queue = task.catch(() => {});
    return task;
  }
}
