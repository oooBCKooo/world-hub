// Presentation groups projects; every operation still addresses one exact artifact or instance.
const value = item => typeof item === 'string' && item.length ? item : null;
const jsonKey = parts => JSON.stringify(parts);
const kinds = new Set(['pack', 'module', 'template']);

function semver(text) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(text ?? '');
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
  return { numbers: match.slice(1, 4).map(BigInt), prerelease };
}

// Descending display order only. This never changes a remembered selection.
export function compareAssetVersions(a, b) {
  if (a === b) return 0;
  const first = semver(a), second = semver(b);
  if (first && second) {
    for (let i = 0; i < 3; i++) if (first.numbers[i] !== second.numbers[i]) return first.numbers[i] > second.numbers[i] ? -1 : 1;
    if (!first.prerelease.length || !second.prerelease.length) {
      if (!first.prerelease.length && second.prerelease.length) return -1;
      if (first.prerelease.length && !second.prerelease.length) return 1;
      return 0; // Build metadata does not affect SemVer precedence.
    }
    for (let i = 0; i < Math.max(first.prerelease.length, second.prerelease.length); i++) {
      const x = first.prerelease[i], y = second.prerelease[i];
      if (x === y) continue;
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
      if (xn && yn) return BigInt(x) > BigInt(y) ? -1 : 1;
      if (xn !== yn) return xn ? 1 : -1;
      return x > y ? -1 : 1;
    }
    return 0;
  }
  // Legacy labels stay selectable instead of being coerced to a different version.
  if (first) return -1;
  if (second) return 1;
  return String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true });
}

/**
 * Rows are not manifests to be merged. Local directories, source entries and
 * installed instances are separate selection scopes even when they share an ID.
 */
export function groupAssets(rows, { mode = 'local', kind } = {}) {
  if (!['local', 'source', 'instance'].includes(mode)) throw new TypeError('Choose local, source, or instance assets.');
  const groups = new Map();
  for (const [index, row] of (rows ?? []).entries()) {
    if (!row || typeof row !== 'object') continue;
    const manifest = mode === 'instance' ? row.pack : row.manifest ?? row;
    const assetKind = mode === 'instance' ? 'pack' : value(kind) ?? value(row.kind);
    if (!kinds.has(assetKind)) continue;
    const id = value(manifest?.id), version = value(manifest?.version) ?? value(row.version);
    const path = value(row.path) ?? value(row.packageDirectory) ?? value(row.directory);
    const instanceId = mode === 'instance' ? value(row.instanceId) ?? value(row.id) : null;
    const sourceId = value(row.sourceId) ?? value(row.sourceReceipt?.sourceId);
    const entryId = value(row.entryId) ?? value(row.sourceReceipt?.entryId);
    const source = value(row.source) ?? value(row.sourceReceipt?.source);
    const sha256 = value(row.sha256) ?? value(row.sourceReceipt?.artifactSha256);
    const origin = value(row.origin);
    const locator = mode === 'instance' ? [instanceId, path]
      : mode === 'source' ? [sourceId, source, entryId, sha256, value(row.indexDigest)]
        : [path, sha256, sourceId, entryId];
    // An absent project ID never causes unrelated/legacy rows to become one project.
    const identity = id ?? jsonKey(['unidentified', locator, index]);
    const groupKey = jsonKey([mode, assetKind, identity]);
    const optionKey = jsonKey([groupKey, version, locator, ...(!locator.some(Boolean) ? [index] : [])]);
    let group = groups.get(groupKey);
    if (!group) {
      group = { key: groupKey, mode, kind: assetKind, id, title: value(manifest?.title) ?? value(row.title) ?? id, options: [], versions: [] };
      groups.set(groupKey, group);
    }
    // Exact repeated observations are one option. Same version, different
    // directory/source/digest/instance is always preserved as another option.
    if (!group.options.some(option => option.key === optionKey)) group.options.push({
      key: optionKey, version, row, path, sourceId, entryId, source, sha256, instanceId, origin
    });
  }
  for (const group of groups.values()) {
    group.options.sort((a, b) => compareAssetVersions(a.version, b.version));
    group.versions = [...new Set(group.options.map(option => option.version))];
  }
  return [...groups.values()];
}

/** A disappearing selected item is unavailable, never a request to upgrade. */
export function createAssetVersionSelection({storage,storageKey='world-hub.asset-version-selection/v1'}={}) {
  if(storage===undefined)try{storage=globalThis.sessionStorage;}catch{}
  const selected = new Map();
  try {
    const raw=storage?.getItem(storageKey);if(raw&&raw.length<=512*1024){const rows=JSON.parse(raw);if(Array.isArray(rows)&&rows.length<=256)for(const row of rows)if(Array.isArray(row)&&row.length===2&&row.every(value=>typeof value==='string'&&value.length<=8192))selected.set(...row);}
  }catch{}
  const persist=()=>{while(selected.size>256)selected.delete(selected.keys().next().value);try{storage?.setItem(storageKey,JSON.stringify([...selected]));}catch{}};
  return {
    get(group) {
      if (!group?.options?.length) return null;
      if (!selected.has(group.key)) {selected.set(group.key, group.options[0].key);persist();}
      return group.options.find(option => option.key === selected.get(group.key)) ?? null;
    },
    select(group, key) {
      if (!group?.options?.some(option => option.key === key)) return false;
      selected.set(group.key, key);
      persist();
      return true;
    },
    key(group) { return selected.get(group?.key) ?? null; },
    clear(group) { const removed=selected.delete(group?.key);persist();return removed; }
  };
}

export function assetOptionLabel(option, say = (zh, en) => en) {
  const version = option.version ? `v${option.version}` : say('版本未标明', 'Version unspecified');
  if (option.instanceId) return `${version} · ${say('实例', 'Instance')}: ${option.instanceId}${option.path ? ` · ${option.path}` : ''}`;
  const source = option.sourceId ?? option.source ?? (option.origin === 'builtin' ? say('内置', 'Built-in') : option.origin === 'cache' ? say('缓存', 'Cache') : say('本机', 'Local'));
  const details = [version, source, option.path ?? option.entryId, option.sha256 ? `SHA-256: ${option.sha256}` : null].filter(Boolean);
  return details.join(' · ');
}

/**
 * Integration calls selection.get(group)?.row for all card actions. onChange
 * should rerender the card so its facts, review and actions use that exact row.
 */
export function renderAssetVersionSelector(ctx, group, selection, { onChange = () => {}, alwaysShow = true } = {}) {
  const { el, say = (zh, en) => en } = ctx;
  if (!alwaysShow && group.options.length < 2) return null;
  const chosen = selection.get(group);
  const label = say('版本、来源与实例', 'Version, source and instance');
  const select = el('select', { class: 'asset-version-select', 'aria-label': label, 'data-asset-project': group.key }, [
    ...(!chosen ? [el('option', { value: '', disabled: true, selected: true }, say('原选项已不可用，请重新选择', 'Previous selection unavailable; choose again'))] : []),
    ...group.options.map(option => el('option', { value: option.key, selected: option.key === chosen?.key }, assetOptionLabel(option, say)))
  ]);
  select.value = chosen?.key ?? '';
  select.addEventListener('change', () => {
    if (!selection.select(group, select.value)) { select.value = chosen?.key ?? ''; return; }
    onChange(selection.get(group), group);
  });
  return el('label', { class: 'asset-version-picker' }, [
    el('span', { class: 'field-label' }, label), select,
    el('span', { class: 'field-help' }, say(`${group.versions.length} 个版本 · ${group.options.length} 个选项；操作仅针对所选项。`, `${group.versions.length} versions · ${group.options.length} options; actions target only the selected item.`))
  ]);
}
