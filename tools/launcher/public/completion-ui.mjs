// Optional static templates and reviewed instance transactions. No Core business.
export function createCompletionUi(ctx) {
  const { api, el, button, say, panel, note, field, form, value, jsonView, reviewAction, operation, refresh, openImport, endpoint, selectInstance } = ctx;
  let templateDirectory = '';
  const inputJson = (f, key) => JSON.parse(value(f, key));
  const completed = async result => { await refresh({ explicit: true }); return result; };
  function candidateSummary(preview) {
    const none = say('无', 'None'), list = rows => rows?.length ? rows.map(row => typeof row === 'string' ? row : `${row.id}@${row.version}`).join(', ') : none;
    const fields = value => value ? Object.entries(value).map(([key, item]) => `${key}: ${Array.isArray(item) ? list(item) : item}`).join('; ') || none : none;
    const moduleName = component => component ? `${component.module.id}@${component.module.version} · ${component.runtime.kind}` : none;
    const details = (preview.diff.components ?? []).map(component => {
      const after = component.after;
      return panel(component.id, [
        note(`${moduleName(component.before)} → ${moduleName(after)}`),
        note(`${say('代码新增', 'Code added')}: ${list(component.code.added)}; ${say('移除', 'Removed')}: ${list(component.code.removed)}; ${say('修改', 'Changed')}: ${list(component.code.changed)}`),
        note(`${say('提供契约', 'Provides')}: ${list(after?.contracts.provides)} · ${say('需要契约', 'Requires')}: ${list(after?.contracts.requires)}`),
        note(`${say('权限', 'Permissions')}: ${fields(after?.permissions)} · ${say('启动依赖', 'Startup dependencies')}: ${list(after?.dependencies)}`),
        note(`${say('平台', 'Platforms')}: ${list(after?.platforms)} · ${say('许可', 'License')}: ${after?.license ?? none}`),
      ]);
    });
    const interpreters = Object.entries(preview.diff.candidate.interpreters ?? {}).map(([kind, interpreter]) => note(`${kind} ${interpreter.version} · ${interpreter.executable} · ${say('SDK 依赖', 'SDK dependencies')}: ${fields(interpreter.packages)}`));
    return panel(say('候选试用摘要', 'Candidate trial summary'), [
      note(`${preview.instanceId} → ${preview.newInstanceId} · ${preview.current.pack.id}@${preview.current.pack.version} → ${preview.candidate.pack.id}@${preview.candidate.pack.version}`),
      note(`${say('私有备份', 'Private backup')}: ${preview.backupDestination} · ${preview.snapshot.files} ${say('文件', 'files')}`),
      note(say('声明已精确检查；实际业务尚未验证。原实例保留，候选使用全新数据。', 'Declarations checked exactly; application behavior is unverified. The old instance is retained and the candidate uses fresh data.')),
      ...details, ...interpreters,
    ]);
  }
  function templatePanel() {
    const results = el('div');
    const inspect = form([field('directory', say('模板目录', 'Template directory'), templateDirectory)], say('检查模板', 'Inspect template'), async f => {
      templateDirectory = value(f, 'directory'); const data = await api('/api/templates/inspect', { directory: templateDirectory });
      results.replaceChildren(note(`${data.inspection.manifest.title} · ${data.inspection.manifest.id}@${data.inspection.manifest.version} · Hub ${data.inspection.lock.hubVersion}`), jsonView(say('模板与参数', 'Template and parameters'), data.inspection), instantiateForm(templateDirectory, data.inspection));
    });
    const create = form([field('directory', say('完整锁定基包目录', 'Complete locked base pack directory')), field('template', say('模板声明 JSON', 'Template declaration JSON'), '', { multiline: true }), field('destination', say('新的模板目录', 'New template directory'))], say('审阅并创建模板', 'Review and create template'), async f => {
      const body = { directory: value(f, 'directory'), template: inputJson(f, 'template'), destination: value(f, 'destination'), redistributionAcknowledged: true };
      reviewAction(say('创建可分发模板', 'Create distributable template'), [note(say('模板包含完整基包与锁。仅公开声明允许调整的业务设置或具体主题；不执行模块。', 'Templates contain a complete base pack and lock. Only declared business settings or concrete topics can vary; modules are not executed.')), jsonView(say('模板声明', 'Template declaration'), body.template, true)], say('我已审阅公开内容、参数范围和再分发许可。', 'I reviewed the public contents, parameter scope, and redistribution licenses.'), async () => {
        await operation(await api('/api/templates/create', body), 'create-template', result => { templateDirectory = result.directory; results.replaceChildren(note(say(`已创建模板：${result.directory}`, `Template created: ${result.directory}`))); });
      });
    });
    return panel(say('可分发模板', 'Distributable templates'), [note(say('填入参数生成新的锁定包，再导入、审阅和启动。模板本身不启动程序。', 'Fill in parameters to create a new locked pack, then import, review, and start it. Templates do not start programs.')), inspect, results,
      el('details', { class: 'json-details' }, [el('summary', {}, say('从基包创建模板', 'Create template from a base pack')), create])]);
  }
  function instantiateForm(directory, inspection) {
    const parameters = inspection.manifest.parameters ?? [];
    const controls = parameters.map((parameter, index) => {
      const name = 'parameter_' + index, title = parameter.title ?? parameter.name;
      const choices = parameter.constraints?.enum ?? (parameter.type === 'boolean' ? [false, true] : null);
      if (choices) {
        const select = el('select', { name }, choices.map((choice, i) => el('option', { value: i }, String(choice))));
        select.value = String(Math.max(0, choices.findIndex(choice => choice === parameter.default)));
        return el('label', {}, [el('span', {}, title), select]);
      }
      const control = field(name, title, parameter.default ?? '', { type: ['integer', 'number'].includes(parameter.type) ? 'number' : 'text', multiline: parameter.type === 'string' && (parameter.constraints?.maxLength ?? 4096) > 256 });
      if (parameter.type === 'number') control.querySelector('input').setAttribute('step', 'any');
      return control;
    });
    return form([...controls, field('identity', say('新包身份 JSON（可选）', 'New pack identity JSON (optional)'), '', { multiline: true, required: false }), field('destination', say('新包目录', 'New pack directory'))], say('预览并生成新包', 'Preview and create pack'), async f => {
      const values = Object.fromEntries(parameters.map((parameter, index) => {
        const chosen = f.elements['parameter_' + index].value, choices = parameter.constraints?.enum ?? (parameter.type === 'boolean' ? [false, true] : null);
        return [parameter.name, choices ? choices[Number(chosen)] : ['number', 'integer'].includes(parameter.type) ? Number(chosen) : chosen];
      }));
      const identity = value(f, 'identity'), input = { directory, values, ...(identity ? { identity: JSON.parse(identity) } : {}) };
      const review = await api('/api/templates/preview', input), destination = value(f, 'destination');
      reviewAction(say('生成新的锁定包', 'Create a new locked pack'), [note(`${review.preview.pack.title} · ${review.preview.pack.id}@${review.preview.pack.version} · Hub ${review.preview.lock.hubVersion}`), jsonView(say('将写入的参数', 'Parameters to write'), review.preview.values, true), jsonView(say('完整参数与锁预览', 'Complete parameters and lock preview'), review.preview)], say('我已审阅参数、来源、公开内容与再分发许可。', 'I reviewed parameters, sources, public contents, and redistribution licenses.'), async () => {
        await operation(await api('/api/templates/instantiate', { previewId: review.previewId, destination, redistributionAcknowledged: true }), 'instantiate-template', result => {
          const notice = note(say(`已生成：${result.directory}`, `Created: ${result.directory}`));
          notice.append(button(say('导入生成的包', 'Import generated pack'), () => { openImport(); document.querySelector('#import-form').elements.directory.value = result.directory; }, 'button button-primary'));
          f.after(notice);
        });
      });
    });
  }
  async function openTemplate(directory) {
    const data = await api('/api/templates/inspect', { directory });
    const dialog = el('dialog', { class: 'dialog' }); document.body.append(dialog);
    dialog.append(el('div', { class: 'dialog-heading' }, [el('h2', {}, say('实例化共享模板', 'Instantiate shared template')), button('×', () => dialog.close(), 'icon-button')]), jsonView(say('模板声明', 'Template declaration'), data.inspection.manifest), instantiateForm(directory, data.inspection));
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal();
  }
  function maintenance(instance) {
    const id = instance.instanceId, results = el('div');
    const staged = form([field('candidate', say('候选锁定包目录', 'Candidate locked pack directory')),
      field('newInstanceId', say('新的候选实例 ID', 'New candidate instance ID'), `${id}-trial`),
      field('backupDestination', say('新的私有备份文件路径', 'New private backup file path'))], say('预览新实例试用（全新数据）', 'Preview candidate trial (fresh data)'), async f => {
      const review = await api(endpoint(id, 'staged-upgrade-plan'), { candidate: value(f, 'candidate'), newInstanceId: value(f, 'newInstanceId'), backupDestination: value(f, 'backupDestination'), statePolicy: 'fresh' });
      reviewAction(say('保留旧实例，准备候选实例', 'Keep the old instance and prepare a candidate'), [note(say('旧实例必须停止。先备份旧软件和持久数据，再以全新数据导入候选；不会复制业务状态、启动或切换实例。候选失败后旧实例仍可重新审阅启动。', 'The old instance must be stopped. Back up its software and persistent data, then import the candidate with fresh data. Preparation does not copy business state, start programs, or switch instances. The old instance remains available for a fresh execution review.'), true),
        note(say('健康检查和业务结果须在另行授权启动后验证。代码恢复无法撤销远程 API、设备动作、消息或其他程序的状态。需要复制或迁移数据时使用 CLI 的提供者策略路径。', 'Health and business results require a separately reviewed start. Code recovery cannot undo remote APIs, device actions, messages, or other programs\' state. Use the CLI provider-policy path to copy or migrate data.')),
        candidateSummary(review.preview), jsonView(say('完整预览与审阅摘要', 'Complete preview and review digest'), review.preview)],
        say('我已审阅候选差异、全新数据策略和私有备份范围。', 'I reviewed the candidate differences, fresh-data policy, and private backup scope.'), async () => {
          await operation(await api(endpoint(id, 'staged-upgrade'), { previewId: review.previewId, accepted: true }), 'staged-upgrade', async result => {
            await completed(result); await selectInstance(result.newInstanceId);
          });
        });
    });
    const upgrade = form([field('candidate', say('候选锁定包目录', 'Candidate locked pack directory')), field('statePolicies', say('程序提供者的数据策略 JSON', 'Provider-defined state policies JSON'), '', { multiline: true })], say('预览升级', 'Preview upgrade'), async f => {
      const review = await api(endpoint(id, 'upgrade-plan'), { candidate: value(f, 'candidate'), statePolicies: inputJson(f, 'statePolicies') });
      reviewAction(say('升级已停止的实例', 'Upgrade the stopped instance'), [note(say('升级会保存旧软件与持久数据快照，不包括运行日志和模块 tmp。迁移代码由程序作者提供；审阅后执行，成功后仍需重新授权启动。', 'Upgrade snapshots previous software and persistent data, excluding run logs and module tmp. Program authors provide migration code; review it before execution. Starting afterward requires a fresh review.'), true), jsonView(say('旧包、新包、权限与数据策略', 'Previous and candidate packs, permissions, and state policy'), review.preview, true)], say('我已审阅候选代码和权限，确认提供者声明的数据兼容或迁移策略。', 'I reviewed candidate code and permissions and confirm the provider-defined data compatibility or migration policies.'), async () => {
        await operation(await api(endpoint(id, 'upgrade'), { previewId: review.previewId, accepted: true }), 'upgrade', completed);
      });
    });
    const history = button(say('检查升级与恢复记录', 'Inspect upgrade and recovery history'), async () => {
      const data = await api(endpoint(id, 'upgrade-history')); results.replaceChildren(jsonView(say('事务记录', 'Transaction history'), data.history, true));
      for (const transaction of data.history.transactions ?? []) {
        if (!['committed', 'preparing', 'ready', 'committing', 'restoring', 'cleanup-incomplete', 'conflict'].includes(transaction.state)) continue;
        results.append(button(`${transaction.transactionId} · ${say('审阅回滚／恢复', 'Review rollback / recovery')}`, async () => {
          const review = await api(endpoint(id, 'rollback-plan'), { transactionId: transaction.transactionId }), recovery = review.preview.recoveryRequired;
          const title = recovery ? say('恢复中断事务', 'Recover interrupted transaction') : say('回滚软件与完整数据', 'Roll back software and complete data');
          reviewAction(title, [note(say('回滚恢复原始软件、程序数据与 Hub 数据。运行后的新数据可能被替换，工具先保存最新快照。不会自动启动。', 'Rollback restores original software, program data, and Hub data. Later data can be replaced; the tool first saves a latest-data snapshot. Programs are not started automatically.'), true), jsonView(title, review.preview, true)], say('我已审阅完整数据恢复范围与最新数据的处置，允许执行此事务。', 'I reviewed the complete data restoration scope and handling of latest data and authorize this transaction.'), async () => {
            await operation(await api(endpoint(id, recovery ? 'recover-upgrade' : 'rollback-upgrade'), { previewId: review.previewId, accepted: true }), recovery ? 'recover-upgrade' : 'rollback-upgrade', completed);
          });
        }, 'button button-quiet'));
      }
    }, 'button button-quiet');
    const candidateOrigin = instance.stagedFrom ? [note(say(`这是独立候选实例。旧实例 ${instance.stagedFrom} 保留；检查候选业务结果后自行决定是否切换。返回旧实例仍须重新审阅启动。`, `This is an independent candidate. Old instance ${instance.stagedFrom} is retained; decide whether to switch after checking candidate business results. Starting the old instance still requires a fresh review.`)),
      button(say('返回旧实例', 'Return to old instance'), async () => { await refresh({ explicit: true }); await selectInstance(instance.stagedFrom); }, 'button button-quiet')] : [];
    return [panel(say('保留旧实例的候选试用', 'Candidate trial with the old instance retained'), [...candidateOrigin, staged]), panel(say('升级与数据回滚', 'Upgrade and data rollback'), [note(say('先停止并确认进程退出。每个组件必须有提供者明确的数据策略；枢纽不定义业务数据格式。', 'Stop and confirm process exit first. Every component requires an explicit provider-defined data policy; the Hub does not define business data formats.')), upgrade, history, results])];
  }
  return { templatePanel, openTemplate, maintenance };
}
