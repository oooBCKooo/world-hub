// Lineage records describe the source of a composition, not publisher verification.
export function packLineageLabels(pack = {}, language = 'en') {
  const say = (zh, en) => language === 'zh' ? zh : en;
  const version = value => `v${String(value ?? '—').replace(/^v/, '')}`;
  const lineage = pack.lineage;
  if (lineage?.format === 'world-hub.pack-lineage/v1' && lineage.kind === 'customized' && lineage.base?.version) {
    return [
      { kind: 'source', text: `${say('来源基线', 'Source baseline')} ${version(lineage.base.version)}`, title: `${lineage.base.id ?? pack.id ?? ''} · ${lineage.base.sourceDigest ?? ''}` },
      { kind: 'custom', text: `${say('本地改装', 'Local customization')} ${version(pack.version)}${Number.isInteger(lineage.revision) ? say(` · 修订 ${lineage.revision}`, ` · Rev ${lineage.revision}`) : ''}`, title: lineage.customizedAt ?? '' }
    ];
  }
  return [{ kind: lineage?.format === 'world-hub.pack-lineage/v1' && lineage.kind === 'self-created' ? 'self-created' : 'source', text: `${lineage?.format === 'world-hub.pack-lineage/v1' && lineage.kind === 'self-created' ? say('自建', 'Self-created') : say('来源版本', 'Source version')} ${version(pack.version)}` }];
}

export function renderPackLineage(el, pack, language) {
  return el('span', { class: 'pack-lineage', 'data-pack-lineage': '' }, packLineageLabels(pack, language).map(row => el('span', { class: `pack-version-pill ${row.kind}`, title: row.title ?? '' }, row.text)));
}

export function createCustomizationUi(ctx) {
  const { state, api, el, button, definition, note, jsonView, reviewAction, operation, idOf, endpoint, replaceInstance, date, toast } = ctx;
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  function changeSummary(diff) {
    if (!Array.isArray(diff?.components)) return null;
    const members = diff.components, retained = members.filter(row => row.before && row.after);
    const ids = rows => rows.map(row => row.id).join(', ') || say('无', 'None');
    const sourceChanges = retained.filter(row => row.before.codeSha256 !== row.after.codeSha256
      || row.before.module?.id !== row.after.module?.id || row.before.module?.version !== row.after.module?.version);
    const declarations = retained.filter(row => row.changedDimensions?.some(dimension => dimension !== 'module'));
    const changed = value => value === true ? say('有变化', 'Changed') : value === false ? say('无变化', 'Unchanged') : say('未提供', 'Not provided');
    return el('section', { class: 'customization-change-summary' }, [el('h3', {}, say('本次改装差异', 'Customization changes')), definition([
      [say('新增模块', 'Added modules'), ids(members.filter(row => row.change === 'added'))],
      [say('移除模块', 'Removed modules'), ids(members.filter(row => row.change === 'removed'))],
      [say('源码替换', 'Source replacements'), ids(sourceChanges)],
      [say('配置与声明变化', 'Configuration and declaration changes'), ids(declarations)],
      [say('能力接线', 'Capability wiring'), changed(diff.bindings?.changed)],
      [say('主题映射', 'Topic mappings'), changed(diff.topics?.changed)],
      [say('执行顺序', 'Execution order'), diff.startupOrder ? `${diff.startupOrder.before?.join(' → ') || say('无', 'None')} ⇒ ${diff.startupOrder.after?.join(' → ') || say('无', 'None')}` : say('未提供', 'Not provided')],
      [say('运行预设与故障策略', 'Runtime preset and failure policy'), changed(diff.lifecycle?.changed)]
    ])]);
  }
  const previewContents = (preview, restoring = false) => [
    note(restoring
      ? say('恢复前会为当前内容创建新的快照。所选快照的程序、配置与私有数据将替换当前内容，之后新增的数据也会被替换。外部系统副作用无法撤销。先停止实例；恢复后不会自动启动。', 'A new snapshot of current contents is created first. The selected snapshot replaces current code, configuration and private data, including later data changes. External side effects cannot be undone. Stop the instance first; restoration does not start it automatically.')
      : say('请先停止实例。本次应用前将保存软件与持久数据快照，再就地更新；不自动停机或启动。程序数据顶层 tmp 与生成的运行配置不在快照范围；Hub 持久日志仍保留。保留的是不透明数据字节，不代表应用的新旧数据格式兼容。', 'Stop the instance first. A snapshot of software and persistent data is saved before applying in place. Top-level program tmp directories and generated runtime configuration are excluded; persistent Hub logs are retained. Nothing stops or starts automatically. Preserved opaque bytes do not establish application data compatibility.'), true),
    renderPackLineage(el, preview.current?.pack, state.language),
    el('p', { class: 'field-help' }, say('应用后的版本', 'Version after applying')),
    renderPackLineage(el, preview.candidate?.pack ?? preview.restores?.pack ?? preview.target?.pack, state.language),
    restoring ? null : changeSummary(preview.diff),
    definition([[say('快照摘要', 'Snapshot digest'), preview.snapshot?.digest ?? preview.snapshot?.sha256 ?? '—'], [say('文件数', 'Files'), preview.snapshot?.files ?? '—'], [say('字节数', 'Bytes'), preview.snapshot?.bytes ?? '—']]),
    jsonView(say('精确差异与数据处理', 'Exact differences and data handling'), preview)
  ].filter(Boolean);

  async function save(instance, body, runtimeSnapshot = false) {
    const { previewId, preview } = await api(endpoint(idOf(instance), runtimeSnapshot ? 'assembly/save-preview' : 'customization/preview'), body);
    reviewAction(say('保存改装并直接升级', 'Save customization and apply in place'), previewContents(preview), say('我已审阅差异、软件与持久数据快照和数据保留边界，确认应用此改装。', 'I reviewed the differences, software and persistent-data snapshot and data-preservation limits, and confirm applying this customization.'), async () => {
      await operation(await api(endpoint(idOf(instance), runtimeSnapshot ? 'assembly/save-apply' : 'customization/apply'), { previewId, accepted: true }), 'customization', async result => {
        if (result.instance) replaceInstance(result.instance, { selectVersion: true });
        const followup = await ctx.onApplied(result, instance);
        toast(followup?.warning ?? say('改装版本已保存，旧版快照已保留。启动前请重新审阅。', 'Customization saved and the old snapshot retained. Review again before starting.'));
      });
    });
  }

  async function restore(instance, transaction) {
    const { previewId, preview } = await api(endpoint(idOf(instance), 'customization/restore-preview'), { transactionId: transaction.transactionId });
    reviewAction(say('恢复改装历史与私有数据', 'Restore customization history and private data'), previewContents(preview, true), say('我理解当前版本与之后产生的数据将被快照替换，并确认恢复。', 'I understand that the snapshot replaces the current version and later data, and confirm restoration.'), async () => {
      await operation(await api(endpoint(idOf(instance), 'customization/restore'), { previewId, accepted: true }), 'customization-restore', async result => {
        if (result.instance) replaceInstance(result.instance, { selectVersion: true });
        await ctx.onRestored?.(result, instance);
        toast(say('快照已恢复；实例保持停止，请重新审阅启动。', 'Snapshot restored. The instance remains stopped; review it before starting.'));
      });
    });
  }

  function historyButton(instance, disabled = false) {
    let pending = false;
    const control = button(say('改装历史与恢复', 'Customization history & restore'), async () => {
      if (pending) return;
      pending = true; control.disabled = true;
      try {
        const data = await api(endpoint(idOf(instance), 'customization/history'));
        const dialog = el('dialog', { class: 'dialog customization-history-dialog', 'aria-label': say('改装历史与恢复', 'Customization history & restore') });
        const choose = row => async () => { dialog.close(); dialog.remove(); await restore(instance, row); };
        const rows = data.history?.transactions ?? [];
        dialog.append(...[el('div', { class: 'dialog-heading' }, [el('h2', {}, say('改装历史与恢复', 'Customization history & restore')), button(say('关闭', 'Close'), () => { dialog.close(); dialog.remove(); }, 'button button-quiet')]),
          note(say('恢复须先停止实例。仅能恢复本机实际保留且检查可用的快照；数据也会回到快照时点，恢复后需重新审阅启动。', 'Stop the instance before restoring. Only checked, retained local snapshots can be restored. Private data returns to the snapshot time; review execution afterward.')),
          data.baseline?.restorable === true ? el('div', { class: 'customization-baseline' }, [renderPackLineage(el, data.baseline.pack, state.language), button(say('恢复来源基线快照', 'Restore source baseline snapshot'), choose(data.baseline), 'button button-quiet', disabled)]) : el('p', { class: 'field-help' }, say('当前没有可用的来源基线快照，可选择下方实际保留的历史快照。', 'No source baseline snapshot is currently available; choose a retained history snapshot below.')),
          ...rows.map(row => el('article', { class: 'customization-history-row' }, [el('h3', {}, `${row.current?.pack?.version ?? row.current?.version ?? '—'} → ${row.target?.pack?.version ?? row.target?.version ?? '—'}`), el('p', { class: 'field-help' }, `${date(row.createdAt)} · ${row.state}`), el('code', {}, row.transactionId), button(say('恢复此快照', 'Restore this snapshot'), choose(row), 'button button-small button-quiet', disabled || row.restorable !== true), row.snapshotError ? el('p', { class: 'notice notice-error' }, row.snapshotError.message ?? String(row.snapshotError)) : null].filter(Boolean))),
          ...(!rows.length ? [el('p', { class: 'field-help' }, say('尚无可保留的改装事务快照。', 'No retained customization transaction snapshots yet.'))] : [])].filter(Boolean));
        document.body.append(dialog); dialog.showModal();
      } finally { pending = false; control.disabled = false; }
    }, 'button button-quiet');
    return control;
  }
  return { save, historyButton };
}
