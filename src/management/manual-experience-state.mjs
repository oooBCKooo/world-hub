// Browser-local UI state only: no program payload persistence or Hub policies.
const copy = value => structuredClone(value);
export class AnnotationDrafts {
  constructor(limit = 64) { this.limit = limit; this.entries = new Map(); this.version = 0; }
  edit(key, value) {
    const previous = this.entries.get(key);
    if (previous && JSON.stringify(previous.value) === JSON.stringify(value)) return previous;
    if (!previous && this.entries.size >= this.limit) {
      throw Object.assign(new Error(`已有 ${this.limit} 个主体的未保存草稿，请先保存或丢弃一份。`), { code: 'DRAFT_LIMIT' });
    }
    const draft = { value: copy(value), version: ++this.version };
    this.entries.set(key, draft); return draft;
  }
  get(key) { const draft = this.entries.get(key); return draft ? { value: copy(draft.value), version: draft.version } : null; }
  snapshot(key, fallback) { const draft = this.get(key); return { key, value: draft?.value ?? copy(fallback), version: draft?.version ?? 0 }; }
  settle(submitted) {
    const current = this.entries.get(submitted.key);
    if (!current) return true;
    if (current.version !== submitted.version) return false;
    this.entries.delete(submitted.key); return true;
  }
  discard(key) { this.entries.delete(key); }
}

export class LatestRead {
  constructor() { this.generation = 0; }
  begin() { return ++this.generation; }
  current(ticket) { return ticket === this.generation; }
  invalidate() { ++this.generation; }
}

export async function boundedJson(fetcher, path, options = {}, timeoutMs = 8000) {
  const controller = new AbortController(); let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error('本地管理等待已超时；提交结果可能未知，请刷新并核对，不会自动重发。'), { code: 'MANAGEMENT_TIMEOUT' });
      reject(error); controller.abort();
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await fetcher(path, { ...options, signal: controller.signal });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error?.message ?? `HTTP ${response.status}`), { code: value.error?.code ?? 'MANAGEMENT_FAILED' });
    return value;
  })();
  try { return await Promise.race([request, timeout]); }
  finally { clearTimeout(timer); }
}

export function matchesLog(item, direction = 'all', query = '') {
  return (direction === 'all' || item.direction === direction)
    && (!query.trim() || `${item.type}\n${item.raw}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
}

// Keep nodes for every retained entry, even when locally filtered out. Removing
// a node is reserved for actual eviction, never a new unrelated incoming frame.
export function reconcileRows({ container, cache, entries, create, update = () => {}, visible = () => true, empty, focusFallback, followBottom = false, prepend = false }) {
  const document = container.ownerDocument;
  const focused = document.activeElement, hadFocus = container.contains(focused);
  const oldTop = container.scrollTop, oldHeight = container.scrollHeight;
  const wasBottom = oldHeight - oldTop - container.clientHeight < 80;
  const retained = new Set(entries.map(item => item.localId)); let count = 0;
  for (const [key, row] of cache) if (!retained.has(key)) {
    if (row.contains(focused)) focusFallback?.focus({ preventScroll: true });
    row.remove(); cache.delete(key);
  }
  let next = container.firstElementChild;
  for (const item of entries) {
    let row = cache.get(item.localId);
    if (!row) { row = create(item); cache.set(item.localId, row); }
    update(row, item); const shown = visible(item); row.hidden = !shown;
    if (shown) count++;
    else if (row.contains(focused)) focusFallback?.focus({ preventScroll: true });
    if (row !== next) container.insertBefore(row, next);
    next = row.nextElementSibling;
  }
  empty.hidden = count > 0;
  if (empty.parentElement !== container) container.append(empty);
  if (followBottom && wasBottom && !hadFocus) container.scrollTop = container.scrollHeight;
  else container.scrollTop = prepend && entries.length && oldHeight ? oldTop + Math.max(0, container.scrollHeight - oldHeight) : oldTop;
  return count;
}
