// Private authoring records; restored content conveys no execution approval.
import { join, isAbsolute, resolve } from 'node:path';
import { ordinaryPath, privateJson, readBounded } from '../../scripts/runtime/paths.mjs';
import { validatePackLineage } from '../../scripts/runtime/pack-lineage.mjs';

const fault = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = ['format', 'directory', 'baseRevision', 'pack', 'replacements', 'formValues', 'selection', 'updatedAt', 'origin'];
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const path = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0') || !isAbsolute(value)) throw fault('DRAFT_INVALID', 'Draft directory must be an absolute local path.', 400);
  // Native Windows callers may use the extended-length spelling of a drive
  // or UNC path. Keep its identity ordinary for the checked ancestor walk.
  if (process.platform === 'win32') {
    if (value.startsWith('\\\\.\\')) throw fault('DRAFT_INVALID', 'Draft directory must be an absolute local path.', 400);
    if (value.startsWith('\\\\?\\')) {
      const unc = /^\\\\\?\\UNC\\([^\\/]+)\\([^\\/]+)(?:\\|$)/i.exec(value);
      if (/^\\\\\?\\[a-z]:\\/i.test(value)) value = value.slice(4);
      else if (unc && unc.slice(1).every(part => !['.', '..'].includes(part) && !/[<>:"|?*\x00-\x1f]/.test(part))) value = '\\\\' + value.slice(8);
      else throw fault('DRAFT_INVALID', 'Draft directory must be an absolute local path.', 400);
    }
  }
  return resolve(value);
};
function validate(value) {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key)) || value.format !== 'world-hub.creator-draft/v1'
    || !/^[a-f0-9]{64}$/.test(value.baseRevision ?? '') || !object(value.pack) || !object(value.formValues)
    || !Array.isArray(value.replacements) || value.replacements.length > 32 || typeof value.selection !== 'string' || value.selection.length > 256
    || typeof value.updatedAt !== 'string' || value.updatedAt.length > 64) throw fault('DRAFT_INVALID', 'Unsupported Creator draft.', 400);
  const directory = path(value.directory), replacements = value.replacements.map(row => {
    if (!object(row) || Object.keys(row).some(key => !['componentId', 'moduleDirectory', 'candidateDigest'].includes(key)) || typeof row.componentId !== 'string' || !row.componentId || row.componentId.length > 256
        || (row.candidateDigest !== undefined && !/^[a-f0-9]{64}$/.test(row.candidateDigest)))
      throw fault('DRAFT_INVALID', 'Unsupported module replacement in draft.', 400);
    return { componentId: row.componentId, moduleDirectory: path(row.moduleDirectory), ...(row.candidateDigest ? { candidateDigest: row.candidateDigest } : {}) };
  });
  if (value.origin !== undefined) {
    const origin=value.origin, composition=origin?.composition;
    if(origin?.kind==='pack-runtime'){
      const target=origin.target;
      if(Object.keys(origin).sort().join(',')!=='kind,stateRequirements,target'||!object(target)||Object.keys(target).some(key=>!['source','targetInstanceId','runId','revision','baselineDigest'].includes(key))
          ||target.source!=='runtime-assembly'||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(target.targetInstanceId??'')||!/^[a-f0-9-]{36}$/.test(target.runId??'')||!Number.isSafeInteger(target.revision)||target.revision<0
          ||!/^[a-f0-9]{64}$/.test(target.baselineDigest??'')||!Array.isArray(origin.stateRequirements)||origin.stateRequirements.length>128
          ||origin.stateRequirements.some(row=>!object(row)||Object.keys(row).sort().join(',')!=='componentId,hasState,inCandidate'||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(row.componentId??'')||typeof row.hasState!=='boolean'||typeof row.inCandidate!=='boolean'))
        throw fault('DRAFT_INVALID','Invalid runtime composition origin.',400);
    }else if (!object(origin) || Object.keys(origin).some(key=>!['composition','kind','startupPlan','savedStartupPlan'].includes(key)) || origin.kind!=='global-hub'
        || !object(composition) || Object.keys(composition).some(key=>!['id','version','revision','title','lineage'].includes(key))
        || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(composition.id??'') || !/^\d+\.\d+\.\d+$/.test(composition.version??'')
        || !/^[a-f0-9]{64}$/.test(composition.revision??'') || composition.title !== undefined && (typeof composition.title!=='string' || composition.title.length>256))
      throw fault('DRAFT_INVALID','Invalid global Hub composition origin.',400);
    else {
      try { validatePackLineage(composition); } catch { throw fault('DRAFT_INVALID', 'Invalid global Hub composition lineage.', 400); }
      for (const key of ['startupPlan', 'savedStartupPlan']) if (origin[key] !== undefined && (!object(origin[key]) || Object.keys(origin[key]).sort().join(',') !== 'onFailure'
          || !['continue-independent','stop-plan'].includes(origin[key].onFailure)))
        throw fault('DRAFT_INVALID', 'Invalid global Hub startup failure policy.', 400);
    }
  }
  return { ...structuredClone(value), directory, replacements };
}
export class CreatorDrafts {
  constructor(root) { this.file = join(root, 'creator-drafts.json'); this.drafts = []; this.queue = Promise.resolve(); }
  async initialize() {
    try {
      const data = JSON.parse((await readBounded(this.file, 2 * 1024 * 1024)).toString('utf8'));
      if (data.format !== 'world-hub.creator-drafts/v1' || !Array.isArray(data.drafts) || data.drafts.length > 32) throw fault('DRAFT_REGISTRY_INVALID', 'Inspect the private Creator draft registry.');
      this.drafts = data.drafts.map(validate);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async list() { await this.queue; return { drafts: structuredClone(this.drafts) }; }
  async write(drafts) {
    const value = { format: 'world-hub.creator-drafts/v1', drafts };
    if (Buffer.byteLength(JSON.stringify(value, null, 2) + '\n') > 2 * 1024 * 1024) throw fault('DRAFT_LIMIT', 'Private drafts exceed 2 MiB. Remove an older draft before saving.');
    await privateJson(this.file, value); this.drafts = drafts;
  }
  async save(value) {
    const draft = validate(value);
    draft.directory = await ordinaryPath(draft.directory, { allowMissing: true });
    for (const replacement of draft.replacements) replacement.moduleDirectory = await ordinaryPath(replacement.moduleDirectory, { allowMissing: true });
    draft.updatedAt = new Date().toISOString();
    const action = this.queue.then(async () => {
      const drafts = [draft, ...this.drafts.filter(old => !same(old.directory, draft.directory))];
      if (drafts.length > 32) throw fault('DRAFT_LIMIT', 'At most 32 source drafts can be retained. Remove an older draft before saving.');
      await this.write(drafts); return { draft: structuredClone(draft) };
    }); this.queue = action.catch(() => {}); return action;
  }
  async delete(directory) {
    const chosen = path(directory), action = this.queue.then(async () => {
      // Stored paths are canonicalized when saved. Resolve an incoming alias
      // the same way, including existing parents when the source is gone.
      // An exact stored identity can always be discarded without accessing
      // its source again; source availability conveys no deletion authority.
      const stored = this.drafts.find(draft => same(draft.directory, chosen));
      const identity = stored ? stored.directory : await ordinaryPath(chosen, { allowMissing: true });
      await this.write(this.drafts.filter(draft => !same(draft.directory, identity)));
      return { deleted: true, directory: identity };
    }); this.queue = action.catch(() => {}); return action;
  }
}
