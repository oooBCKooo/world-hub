// Optional static templates and reviewed instance transactions. No Core business.
export function createCompletionUi(ctx) {
  const { api, el, button, say, panel, note, field, form, value, jsonView, reviewAction, operation, refresh, openImport, endpoint } = ctx;
  let templateDirectory = '';
  const inputJson = (f, key) => JSON.parse(value(f, key));
  const completed = async result => { await refresh({ explicit: true }); return result; };
  function templatePanel() {
    const results = el('div');
    const inspect = form([field('directory', say('模板目录', 'Template directory'), templateDirectory)], say('检查模板', 'Inspect template'), async f => {
      templateDirectory = value(f, 'directory'); const data = await api('/api/templates/inspect', { directory: templateDirectory });
      results.replaceChildren(jsonView(say('模板与参数', 'Template and parameters'), data.inspection, true), instantiateForm(templateDirectory, data.inspection));
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
    const defaults = Object.fromEntries((inspection.manifest.parameters ?? []).filter(parameter => Object.hasOwn(parameter, 'default')).map(parameter => [parameter.name, parameter.default]));
    return form([field('values', say('参数 JSON', 'Parameter values JSON'), JSON.stringify(defaults, null, 2), { multiline: true }), field('identity', say('新包身份 JSON（可选）', 'New pack identity JSON (optional)'), '', { multiline: true, required: false }), field('destination', say('新包目录', 'New pack directory'))], say('预览并生成新包', 'Preview and create pack'), async f => {
      const identity = value(f, 'identity'), input = { directory, values: inputJson(f, 'values'), ...(identity ? { identity: JSON.parse(identity) } : {}) };
      const review = await api('/api/templates/preview', input), destination = value(f, 'destination');
      reviewAction(say('生成新的锁定包', 'Create a new locked pack'), [jsonView(say('完整参数与锁预览', 'Complete parameters and lock preview'), review.preview, true)], say('我已审阅参数、来源、公开内容与再分发许可。', 'I reviewed parameters, sources, public contents, and redistribution licenses.'), async () => {
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
    const upgrade = form([field('candidate', say('候选锁定包目录', 'Candidate locked pack directory')), field('statePolicies', say('程序提供者的数据策略 JSON', 'Provider-defined state policies JSON'), '', { multiline: true })], say('预览升级', 'Preview upgrade'), async f => {
      const review = await api(endpoint(id, 'upgrade-plan'), { candidate: value(f, 'candidate'), statePolicies: inputJson(f, 'statePolicies') });
      reviewAction(say('升级已停止的实例', 'Upgrade the stopped instance'), [note(say('升级会保存私有完整快照。迁移代码由程序作者提供；审阅后执行，成功后仍需重新授权启动。', 'Upgrade saves a complete private snapshot. Program authors provide migration code; review it before execution. Starting afterward requires a fresh review.'), true), jsonView(say('旧包、新包、权限与数据策略', 'Previous and candidate packs, permissions, and state policy'), review.preview, true)], say('我已审阅候选代码和权限，确认提供者声明的数据兼容或迁移策略。', 'I reviewed candidate code and permissions and confirm the provider-defined data compatibility or migration policies.'), async () => {
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
    return [panel(say('升级与数据回滚', 'Upgrade and data rollback'), [note(say('先停止并确认进程退出。每个组件必须有提供者明确的数据策略；枢纽不定义业务数据格式。', 'Stop and confirm process exit first. Every component requires an explicit provider-defined data policy; the Hub does not define business data formats.')), upgrade, history, results])];
  }
  return { templatePanel, openTemplate, maintenance };
}
