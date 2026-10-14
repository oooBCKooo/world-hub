// Application-level example contract, deliberately not a World Hub core protocol.
const NODE_TYPES = new Set(['column', 'row', 'card', 'text', 'button', 'input', 'metric', 'divider']);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
export const COMMAND_TOPIC = 'ui/v1/commands';
export const EVENT_TOPIC = 'ui/v1/events';

export function validateTree(node, depth = 0, budget = { count: 0 }) {
  if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 12 || ++budget.count > 180) return false;
  if (!NODE_TYPES.has(node.type)) return false;
  if (node.id !== undefined && (typeof node.id !== 'string' || !SAFE_ID.test(node.id))) return false;
  if (['text', 'button', 'input', 'metric'].includes(node.type) && typeof node.text !== 'string') return false;
  if (node.text?.length > 1000) return false;
  if (node.value !== undefined && !['string', 'number', 'boolean'].includes(typeof node.value)) return false;
  if (['button', 'input'].includes(node.type) && !node.id) return false;
  if (node.children !== undefined) {
    if (!['column', 'row', 'card'].includes(node.type) || !Array.isArray(node.children) || node.children.length > 60) return false;
    for (const child of node.children) if (!validateTree(child, depth + 1, budget)) return false;
  }
  return true;
}

function validateWindowSpec(spec) {
  if (spec === undefined) return true;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return false;
  const keys = Object.keys(spec);
  if (keys.some(key => !['width', 'height', 'resizable'].includes(key))) return false;
  if (spec.width !== undefined && (!Number.isSafeInteger(spec.width) || spec.width < 360 || spec.width > 1600)) return false;
  if (spec.height !== undefined && (!Number.isSafeInteger(spec.height) || spec.height < 260 || spec.height > 1200)) return false;
  if (spec.resizable !== undefined && typeof spec.resizable !== 'boolean') return false;
  return true;
}

export function applyCommand(views, principal, body, revisions = new Map()) {
  if (typeof principal !== 'string' || !principal || !body || typeof body !== 'object') return false;
  if (body.protocol !== 'soft-ui/1' || !SAFE_ID.test(body.viewId ?? '')) return false;
  const key = `${principal}\u0000${body.viewId}`;
  const prev = views.get(key);
  const previousRevision = Math.max(prev?.revision ?? 0, revisions.get(key) ?? 0);
  if (!Number.isSafeInteger(body.revision) || body.revision < 1 || body.revision <= previousRevision) return false;
  if (body.kind === 'view.close') {
    // A tombstone also blocks delayed open messages after close / host restart.
    views.delete(key); revisions.set(key, body.revision); return true;
  }
  if (!['view.open', 'view.update'].includes(body.kind)) return false;
  if (!Number.isSafeInteger(body.revision) || body.revision < 1 || (prev && body.revision <= prev.revision)) return false;
  if (typeof body.title !== 'string' || !body.title || body.title.length > 120 || !validateTree(body.root) || !validateWindowSpec(body.window)) return false;
  if (body.kind === 'view.update' && !prev) return false;
  const elements = new Set();
  const walk = node => { if (node.id) { if (elements.has(node.id)) throw Error('DUPLICATE_ELEMENT_ID'); elements.add(node.id); } for (const c of node.children ?? []) walk(c); };
  try { walk(body.root); } catch { return false; }
  views.set(key, { key, principal, viewId: body.viewId, title: body.title, revision: body.revision, root: structuredClone(body.root), window: structuredClone(body.window ?? prev?.window ?? {}) });
  revisions.set(key, body.revision);
  return true;
}
