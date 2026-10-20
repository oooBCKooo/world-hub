// Runtime observation helpers. Process lifecycle is excluded from design changes.
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
export function isFullPackDeclaration(pack) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  return Boolean(pack && object(pack.topics) && Array.isArray(pack.bindings) && object(pack.entry) && typeof pack.entry.component === 'string'
    && Array.isArray(pack.components) && pack.components.every(row => object(row) && typeof row.id === 'string' && typeof row.module === 'string'
      && Array.isArray(row.after) && object(row.settings) && object(row.bridges)));
}
function design(pack) {
  if (!isFullPackDeclaration(pack)) return null;
  return canonical({ topics: pack.topics ?? {}, bindings: pack.bindings ?? [], entry: pack.entry ?? null,
    packType: pack.packType ?? 'atomic', lifecyclePolicy: pack.lifecyclePolicy ?? (pack.packType === 'mesh' ? 'independent' : 'fail-fast'),
    startupOrder: pack.startupOrder ?? null,
    components: pack.components.map(row => ({ id: row.id, module: row.module, after: row.after ?? [], settings: row.settings ?? {}, bridges: row.bridges ?? {},
      topicAliases: row.topicAliases ?? null, autostart: row.autostart !== false, critical: row.critical === true })) });
}
export function runtimeDesignChange(assembly, savedPack) {
  const current = design(assembly?.pack), saved = design(savedPack);
  if (!current || !saved) return { known: false, changed: false };
  const before = new Set(savedPack.components.map(row => row.id));
  const now = new Set((assembly.pack.components ?? []).map(row => row.id));
  return { known: true, changed: JSON.stringify(current) !== JSON.stringify(saved) || Boolean(assembly.external?.length),
    added: [...now].filter(id => !before.has(id)), removed: [...before].filter(id => !now.has(id)) };
}
export function renderLivePermissionMatrix({ state, el }, assembly) {
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  const rows = [...(assembly.programs ?? []), ...(assembly.external ?? [])];
  const body = rows.flatMap(row => Object.entries(row.bridges ?? {}).map(([slot, grants]) => {
    const topic = alias => row.topics?.[alias] ?? assembly.pack?.topics?.[alias] ?? alias;
    return el('tr', {}, [el('td', { class: 'mono' }, row.componentId ?? row.id), el('td', { class: 'mono' }, slot),
      el('td', {}, (grants.publish ?? []).map(topic).join(', ') || '—'), el('td', {}, (grants.subscribe ?? []).map(topic).join(', ') || '—'),
      el('td', {}, (row.bindings ?? []).map(binding => `${binding.providerId ?? binding.from} → ${binding.contract?.id}@${binding.contract?.version}`).join(', ') || '—')]);
  }));
  const principals = new Map();
  for (const row of rows) {
    const principal = row.principal;
    if (!principal) continue;
    const union = principals.get(principal) ?? { publish: new Set(), subscribe: new Set() };
    for (const grants of Object.values(row.bridges ?? {})) for (const direction of ['publish', 'subscribe']) for (const alias of grants[direction] ?? []) union[direction].add(row.topics?.[alias] ?? assembly.pack?.topics?.[alias] ?? alias);
    principals.set(principal, union);
  }
  return el('section', { class: 'panel dynamic-permissions-matrix', 'data-live-permissions': '' }, [el('h3', {}, say('运行时模块桥权限与接线', 'Live module bridge permissions and wiring')),
    el('p', { class: 'field-help' }, say('这是当前运行中生效的通信授权声明，不等于已观察到的数据流或操作系统沙箱。外部进程由其所有者管理。', 'These are active communication grants for the current run, not observed traffic or an operating-system sandbox. External processes remain owner-managed.')),
    el('p', { class: 'field-help' }, say('下表按模块桥槽列出声明。Hub 对同一 principal 合并各槽授权，并不逐槽隔离；下方合并表由当前声明计算，不代表额外读取了 Hub ACL。', 'The table lists declarations by bridge slot. The Hub combines grants for the same principal rather than isolating each slot. The union below is computed from current declarations, not an additional observation of Hub ACL.')),
    body.length ? el('div', { class: 'table-scroll' }, el('table', { class: 'runtime-table' }, [el('thead', {}, el('tr', {}, [say('成员', 'Member'), say('模块桥槽', 'Bridge slot'), say('声明发送通道', 'Declared publish topics'), say('声明抽取通道', 'Declared subscribe topics'), say('能力提供者接线', 'Capability provider bindings')].map(title => el('th', {}, title)))), el('tbody', {}, body)])) : el('p', {}, say('当前没有模块桥授权。', 'No module bridge grants in this run.')),
    ...[...principals].map(([principal, grants]) => el('p', { class: 'mono', 'data-principal-grant-union': principal }, `${principal} · ${say('合并发送', 'Union publish')}: ${[...grants.publish].join(', ') || '—'} · ${say('合并抽取', 'Union subscribe')}: ${[...grants.subscribe].join(', ') || '—'}`))]);
}

export function renderObservedExternalSessions({ state, el }, instance, assembly) {
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  const topology = state.topology;
  if (!topology || topology.observation !== 'live' || topology.runId !== instance?.status?.runId || topology.instanceId !== (instance.instanceId ?? instance.id)) return null;
  const declared = new Set((assembly.external ?? []).map(row => row.principal).filter(Boolean));
  const rows = (topology.bridges ?? []).filter(row => row.ownership === 'external' && !declared.has(row.principal));
  if (!rows.length) return null;
  return el('section', { class: 'panel dynamic-observed-external' }, [el('h3', {}, say('其他已观测外部连接', 'Other observed external connections')),
    el('p', { class: 'field-help' }, say('仅显示当前运行已观测的连接身份；不推测进程 PID、地址或授权。无 Launcher 授权记录的连接不能作为受管进程启停。', 'Only observed connection identities for the current run are shown. Process IDs, addresses and grants are not inferred. Connections without a Launcher admission record cannot be controlled as managed processes.')),
    ...rows.map(row => el('p', { class: 'mono' }, `${row.principal ?? '—'} · ${row.declaredId ?? row.bridgeId ?? '—'} · session ${row.session ?? '—'}`))]);
}
