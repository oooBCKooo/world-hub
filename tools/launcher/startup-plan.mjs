// Launcher-owned startup selection and ordering. Hub Core never reads this plan.
import { safeId } from '../../scripts/runtime/package.mjs';
import { hash } from '../../scripts/runtime/paths.mjs';
import { resolveStartupOrder } from '../../scripts/runtime/startup-order.mjs';

export const STARTUP_PLAN_FORMAT = 'world-hub.launcher-startup-plan/v1';
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fault = message => Object.assign(new Error(message), { code: 'LOCAL_STARTUP_PLAN_INVALID', status: 409 });
export function startupPlan(value, ids) {
  const known = new Set(ids), supplied = new Map();
  if (!plain(value) || Object.keys(value).some(key => !['format','revision','members','onFailure','startupOrder'].includes(key))
      || value.format !== undefined && value.format !== STARTUP_PLAN_FORMAT
      || !Array.isArray(value.members) || value.members.length > 128
      || !['continue-independent','stop-plan'].includes(value.onFailure)) throw fault('Choose a startup plan with registered members and an explicit failure policy.');
  for (const row of value.members) {
    if (!plain(row) || Object.keys(row).some(key => !['programId','enabled','after'].includes(key))) throw fault('Startup members contain programId, enabled and after only.');
    safeId(row.programId, 'startup program ID');
    if (!known.has(row.programId) || supplied.has(row.programId) || typeof row.enabled !== 'boolean' || !Array.isArray(row.after)
        || row.after.length > 128 || new Set(row.after).size !== row.after.length || row.after.some(id => !known.has(id) || id === row.programId))
      throw fault('Startup members and prerequisites must refer to distinct registered programs.');
    supplied.set(row.programId, { programId: row.programId, enabled: row.enabled, after: [...row.after] });
  }
  const members = ids.map(programId => supplied.get(programId) ?? { programId, enabled: false, after: [] });
  if (Object.hasOwn(value, 'startupOrder') && value.startupOrder === undefined)
    throw Object.assign(new Error('Startup order must list every registered program exactly once.'), { code: 'STARTUP_ORDER_INVALID', status: 409 });
  let ordered;
  try { ordered = resolveStartupOrder(members.map(member => ({ id: member.programId, after: member.after })), value.startupOrder).map(row => row.id); }
  catch (error) { if (!Object.hasOwn(value, 'startupOrder')) throw fault(error.message); throw error; }
  const plan = { format: STARTUP_PLAN_FORMAT, members, onFailure: value.onFailure,
    ...(Object.hasOwn(value, 'startupOrder') ? { startupOrder: [...value.startupOrder] } : {}) };
  return { ...plan, revision: hash(JSON.stringify(plan)), order: ordered.filter(id => members.find(row => row.programId === id).enabled) };
}
export function publicStartupPlan(value, ids) { const { order, ...plan } = startupPlan(value, ids); return plan; }
