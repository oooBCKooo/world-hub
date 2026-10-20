// Read-only presentation of the server's validated, exact-artifact projection.
// No source parsing, local Hub access, execution, or authorization occurs here.
const words = {
  zh: {
    title:'配置与接入', unavailable:'此版本的配置尚未读取。', loading:'正在验证并读取此制品的配置…', boundary:'这里显示制品声明及新实例的初始值。下载不启动模块；接入、运行与调用授权由本机独立审阅。',
    runtime:'运行环境', interpreter:'解释器', entry:'程序入口', platforms:'支持平台', noVersion:'清单未指定解释器版本', execution:'运行策略', resident:'常驻运行', 'on-demand':'按需运行', idle:'空闲停止', seconds:'{value} 秒', policySource:'策略来源',
    'source.configuration':'模块配置声明', 'source.module':'模块声明', 'source.system':'系统初始值（作者未声明）', inherited:'继承模块声明', undeclared:'作者未声明', idleDefault:'未声明空闲时间，采用系统初始值 60 秒。', idleOnly:'空闲停止时间仅用于按需运行。', callers:'调用唤醒授权', callersNone:'初始为空，由本机选择允许的调用方。',
    contracts:'能力契约', provides:'提供能力', requires:'需要提供者', contractsNote:'能力契约指定模块之间的通信能力，与安装包依赖不同。', none:'未声明', empty:'无',
    dependencies:'安装依赖', installRecipe:'依赖准备方式', recipes:'准备配方', npm:'npm 包', production:'运行依赖', development:'开发依赖', optional:'可选依赖', peer:'宿主依赖', package:'包名', requestedVersion:'声明版本', lock:'锁文件', lockVersion:'锁格式', packageCount:'锁定包数', python:'Python 依赖', requirement:'依赖声明', unsupported:'另有 {count} 条声明无法结构化展示，请在本地审阅文件。', unparsed:'仅识别到依赖文件，未解析依赖列表', dependencyEmpty:'未声明安装依赖。', dependencyNote:'展示制品中声明的依赖，不执行下载或安装；锁文件摘要与数量不代表兼容性或安全认证。',
    settings:'默认参数', setting:'参数', type:'类型', defaultValue:'初始值', effectiveValue:'配置值', redacted:'敏感值不公开展示', range:'范围', configurationSource:'配置来源',
    connections:'默认接线', provider:'指定提供者', providerVersion:'提供者版本', connection:'连接', topicMapping:'主题映射', bindings:'已指定能力提供者', bindingEmpty:'未指定能力提供者；导入时按能力契约选择。', connectionsEmpty:'未声明指定模块的默认接线。',
    communication:'主题与枢纽桥', topic:'实际主题', alias:'主题别名', bridge:'枢纽桥槽位', publish:'可发送', subscribe:'可接收', communicationNote:'这些是来源声明的接入默认值；本机连接和收发授权仍需独立审阅。',
    permissions:'声明的资源范围', filesystem:'文件系统', network:'网络', processes:'子进程', 'permission.instance-state':'实例状态目录', 'permission.hub-loopback':'本机 Hub 通信', 'permission.loopback-listen':'本机回环监听', 'permission.none':'不声明子进程', 'permission.owned-children':'自有子进程',
    startup:'启动计划', startupNote:'启动计划启用项与常驻／按需策略共同决定编排启动；按需成员保留调用唤醒策略。', order:'执行顺序', member:'成员', enabled:'参与编排', yes:'启用', no:'不参与', after:'先于本成员完成启动', onFailure:'启动失败策略', 'failure.stop-plan':'停止本次计划', 'failure.continue-independent':'继续独立成员',
    members:'成员配置', memberCount:'{count} 个成员', group:'模块配置', sourceSettings:'参数初始值来自模块声明；配置独立保存具体值。', noDeployment:'此模块未提供 deployment.json 接入默认值。', runtimeCount:'{count} 个运行环境', policyCount:'{count} 个按需成员', source:'来源', declared:'已声明',
    boolTrue:'是', boolFalse:'否', notProvided:'未提供', missingDefault:'未声明初始值', summary:'配置摘要', groupValues:'配置值', jsonObject:'对象', jsonArray:'列表', authorDescription:'作者说明'
  },
  en: {
    title:'Configuration & integration', unavailable:'Configuration for this version has not been loaded.', loading:'Validating and reading this artifact’s configuration…', boundary:'Artifact declarations and initial values for new instances. Downloading starts no modules; integration, execution, and caller permission are reviewed independently on your computer.',
    runtime:'Runtime environment', interpreter:'Interpreter', entry:'Program entry', platforms:'Supported platforms', noVersion:'The manifest does not specify an interpreter version', execution:'Execution policy', resident:'Resident', 'on-demand':'On demand', idle:'Idle stop', seconds:'{value} seconds', policySource:'Policy source',
    'source.configuration':'Configuration declaration', 'source.module':'Module declaration', 'source.system':'System initial values (author did not declare)', inherited:'Inherited module declaration', undeclared:'Author did not declare', idleDefault:'No idle timeout declared; the system initial value is 60 seconds.', idleOnly:'Idle stopping applies to on-demand execution.', callers:'Caller wake authorization', callersNone:'Initially empty. Choose allowed callers locally.',
    contracts:'Capability contracts', provides:'Provides', requires:'Needs a provider', contractsNote:'Capability contracts describe communication between modules. They are separate from installation dependencies.', none:'Not declared', empty:'None',
    dependencies:'Installation dependencies', installRecipe:'Dependency preparation', recipes:'Preparation recipes', npm:'npm packages', production:'Runtime dependencies', development:'Development dependencies', optional:'Optional dependencies', peer:'Peer dependencies', package:'Package', requestedVersion:'Declared version', lock:'Lock file', lockVersion:'Lock format', packageCount:'Locked package count', python:'Python dependencies', requirement:'Requirement', unsupported:'{count} more declarations cannot be displayed structurally; review the file locally.', unparsed:'Dependency files identified without a parsed dependency list', dependencyEmpty:'No installation dependencies declared.', dependencyNote:'Declarations from the artifact only. Nothing is downloaded or installed here; lock digests and counts do not certify compatibility or safety.',
    settings:'Default settings', setting:'Setting', type:'Type', defaultValue:'Initial value', effectiveValue:'Configured value', redacted:'Sensitive value is not displayed publicly', range:'Range', configurationSource:'Configuration source',
    connections:'Default wiring', provider:'Specified provider', providerVersion:'Provider version', connection:'Connection', topicMapping:'Topic mapping', bindings:'Selected capability providers', bindingEmpty:'No provider selected. Choose providers for required contracts during local import.', connectionsEmpty:'No default wiring to a specific module declared.',
    communication:'Topics & hub bridges', topic:'Concrete topic', alias:'Topic alias', bridge:'Hub bridge slot', publish:'Can send', subscribe:'Can receive', communicationNote:'These are source integration defaults. Review local connections and send/receive authorization independently.',
    permissions:'Declared resource scope', filesystem:'Filesystem', network:'Network', processes:'Child processes', 'permission.instance-state':'Instance state directory', 'permission.hub-loopback':'Local Hub communication', 'permission.loopback-listen':'Loopback listening', 'permission.none':'No child processes declared', 'permission.owned-children':'Owned child processes',
    startup:'Startup plan', startupNote:'Enabled plan entries and resident/on-demand policies jointly determine orchestrated startup. On-demand members retain their caller wake policy.', order:'Execution order', member:'Member', enabled:'Orchestrated startup', yes:'Enabled', no:'Not included', after:'Start after', onFailure:'Startup failure policy', 'failure.stop-plan':'Stop this plan', 'failure.continue-independent':'Continue independent members',
    members:'Member configuration', memberCount:'{count} members', group:'Module configuration', sourceSettings:'Initial settings come from module declarations; configurations independently record values.', noDeployment:'This module does not provide deployment.json integration defaults.', runtimeCount:'{count} runtimes', policyCount:'{count} on-demand members', source:'Source', declared:'Declared',
    boolTrue:'Yes', boolFalse:'No', notProvided:'Not provided', missingDefault:'No initial value declared', summary:'Configuration summary', groupValues:'Configured values', jsonObject:'Object', jsonArray:'List', authorDescription:'Author description'
  }
};

const list = value => Array.isArray(value) ? value : [];
Object.assign(words.zh, { 'source.configuration':'模块配置声明', title:'资源声明与接入', scope:'范围', global:'全局', local:'局部', members:'逻辑实例与模块本体依赖', memberCount:'{count} 个逻辑实例', startup:'启动计划',
  moduleReference:'适配模块本体', digest:'模块本体摘要', inheritedPolicy:'未在配置中指定；导入时审阅精确模块本体的默认运行策略。', settings:'参数', effectiveValue:'配置值',
  dataset:'现成数据集', backup:'私有备份', dataPurpose:'数据用途', dataFormat:'业务数据格式', instance:'逻辑实例', files:'业务文件数', bytes:'业务数据大小', file:'业务文件', fileDigest:'文件摘要', data:'模块数据', dataReference:'引用的数据版本',
  pinnedSource:'配置只引用精确模块本体，不包含模块源码。导入时需备齐相同版本与摘要的模块本体。', dataBoundary:'业务文件保持原始字节。社区不解析、执行或迁移业务数据；适配关系与数据格式由作者声明，导入前仍需本机核对。', sourceSettings:'配置独立保存逻辑实例的接线、参数和默认运行策略。' });
Object.assign(words.en, { 'source.configuration':'Configuration declaration', title:'Resource declarations & integration', scope:'Scope', global:'Global', local:'Local', members:'Logical instances & pinned module bodies', memberCount:'{count} logical instances', startup:'Startup plan',
  moduleReference:'Compatible module body', digest:'Module body digest', inheritedPolicy:'Not specified by this configuration. Review the pinned module body defaults during local import.', settings:'Settings', effectiveValue:'Configured value',
  dataset:'Ready-to-use dataset', backup:'Private backup', dataPurpose:'Data purpose', dataFormat:'Business data format', instance:'Logical instance', files:'Business files', bytes:'Business data size', file:'Business file', fileDigest:'File digest', data:'Module data', dataReference:'Referenced data version',
  pinnedSource:'Configurations reference exact module bodies without embedding source code. Import requires matching module body versions and digests.', dataBoundary:'Business files retain their original bytes. The community does not parse, execute, or migrate business data. Authors declare compatibility and data formats; review them locally before import.', sourceSettings:'A configuration independently records logical instance wiring, settings, and default execution policies.' });
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const entries = value => Object.entries(object(value));
const isSensitive = key => /(?:password|passwd|secret|token|credential|private.?key|api.?key|authorization)/i.test(key);
function createNode(document) { return function node(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') element.textContent = String(value);
    else if (key === 'class') element.className = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [children].flat()) {
    if (child === undefined || child === null) continue;
    element.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return element;
}; }

export function renderArtifactConfiguration(configuration, { language = 'zh', document = globalThis.document } = {}) {
  const node = createNode(document);
  const dictionary = words[language === 'en' ? 'en' : 'zh'];
  const t = (key, variables = {}) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(variables[name] ?? ''));
  const localized = value => typeof value === 'string' ? value : object(value)[language] ?? object(value).en ?? object(value).zh ?? '';
  const empty = key => node('p', { class:'config-empty', text:t(key) });
  const note = key => node('p', { class:'config-note', text:t(key) });
  const code = value => node('code', { class:'config-code', text:value ?? t('none') });
  const chips = values => node('div', { class:'config-chips' }, values.map(value => node('span', { class:'config-chip', text:value })));
  const scalar = value => typeof value === 'boolean' ? t(value ? 'boolTrue' : 'boolFalse') : value === null ? 'null' : typeof value === 'string' || typeof value === 'number' ? String(value) : t('notProvided');
  function valueView(value, key = '', depth = 0) {
    if (isSensitive(key)) return node('span', { class:'config-redacted', text:t('redacted') });
    if (!value || typeof value !== 'object') return node('span', { class:'config-value-text', text:scalar(value) });
    if (depth >= 5) return node('span', { class:'config-value-text', text:t(Array.isArray(value) ? 'jsonArray' : 'jsonObject') });
    const rows = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item]) : Object.entries(value);
    if (!rows.length) return node('span', { class:'config-value-text', text:t('empty') });
    return node('dl', { class:'config-value-list' }, rows.flatMap(([name, item]) => [node('dt', { text:name }), node('dd', {}, valueView(item, name, depth + 1))]));
  }
  function facts(rows) {
    return node('dl', { class:'config-facts' }, rows.map(([name, value]) => node('div', { class:'config-fact' }, [node('dt', { class:'config-label', text:name }), node('dd', { class:'config-value' }, value ?? t('none'))])));
  }
  function table(headers, rows) {
    return node('div', { class:'config-table-wrap' }, node('table', { class:'config-table' }, [node('thead', {}, node('tr', {}, headers.map(text => node('th', { scope:'col', text })))), node('tbody', {}, rows.map(row => node('tr', {}, row.map(value => node('td', {}, value ?? t('none'))))))]));
  }
  function section(key, children, { open = false, count } = {}) {
    return node('details', { class:'config-section', open }, [node('summary', { class:'config-section-heading' }, [node('span', { text:t(key) }), count === undefined ? null : node('span', { class:'config-section-count', text:count })]), node('div', { class:'config-section-body' }, children)]);
  }
  function sourceName(source, inherited = false) { return source === 'module' && inherited ? t('inherited') : t(`source.${['module','configuration','system'].includes(source) ? source : 'system'}`); }
  const contractText = contract => `${contract?.id ?? '—'}@${contract?.version ?? '—'}`;
  function contractsView(manifest) {
    const rows = ['provides','requires'].map(key => [t(key), list(manifest[key]).length ? node('ul', { class:'config-list' }, list(manifest[key]).map(contract => node('li', {}, code(contractText(contract))))) : t('none')]);
    return section('contracts', [facts(rows), note('contractsNote')]);
  }
  function executionView(config, member = false) {
    const policy = object(config.executionDefaults), effective = object(policy.effective), declared = policy.declared;
    const mode = effective.mode;
    if (!['resident','on-demand'].includes(mode)) return section('execution', [empty(config.module ? 'inheritedPolicy' : 'none')], { open:true });
    const timeout = effective.idleTimeoutMs;
    return section('execution', [
      chips([t(mode), sourceName(policy.source, member)]),
      facts([[t('idle'), typeof timeout === 'number' ? t('seconds', { value:timeout / 1000 }) : t('none')], [t('callers'), t('callersNone')]]),
      declared?.idleTimeoutMs === undefined && timeout === 60000 ? note('idleDefault') : null,
      mode === 'resident' ? note('idleOnly') : null
    ], { open:true });
  }
  function runtimeView(manifest) {
    const runtime = object(manifest.runtime), permission = object(manifest.permissions);
    const permissionValue = value => typeof value === 'string' ? t(`permission.${value}`) : t('none');
    return section('runtime', [facts([[t('interpreter'), runtime.kind ? `${runtime.kind === 'node' ? 'Node.js' : runtime.kind === 'python' ? 'Python' : runtime.kind} · ${t('noVersion')}` : t('none')], [t('entry'), runtime.entry ? code(runtime.entry) : t('none')], [t('platforms'), list(manifest.platforms).length ? chips(manifest.platforms) : t('none')]]),
      node('h4', { text:t('permissions') }), facts([[t('filesystem'), permissionValue(permission.filesystem)], [t('network'), list(permission.network).length ? permission.network.map(permissionValue).join(' · ') : t('none')], [t('processes'), permissionValue(permission.processes)]])]);
  }
  function dependenciesView(dependencies) {
    if (!dependencies) return section('dependencies', [empty('dependencyEmpty')]);
    const contents = [], installation = object(dependencies.installation), npm = dependencies.npm;
    if (installation.kind) contents.push(facts([[t('installRecipe'), code(installation.kind)], [t('recipes'), list(installation.recipes).join(', ') || t('none')]]));
    if (npm) {
      contents.push(node('h4', { text:t('npm') }));
      for (const [key, label] of [['dependencies','production'],['devDependencies','development'],['optionalDependencies','optional'],['peerDependencies','peer']]) {
        const packages = entries(npm[key]);
        if (packages.length) contents.push(node('h5', { text:t(label) }), table([t('package'), t('requestedVersion')], packages.map(([name, version]) => [code(name), scalar(version)])));
      }
      if (!['dependencies','devDependencies','optionalDependencies','peerDependencies'].some(key => entries(npm[key]).length)) contents.push(empty('dependencyEmpty'));
      if (npm.lock) contents.push(facts([[t('lock'), code(npm.lock.path)], [t('lockVersion'), scalar(npm.lock.lockfileVersion)], [t('packageCount'), scalar(npm.lock.packageCount)]]));
    }
    for (const python of list(dependencies.python)) {
      contents.push(node('h4', { text:t('python') }), code(python.path), list(python.requirements).length ? node('ul', { class:'config-list' }, python.requirements.map(value => node('li', {}, code(value)))) : empty('none'));
      if (python.unsupportedCount) contents.push(node('p', { class:'config-note', text:t('unsupported', { count:python.unsupportedCount }) }));
    }
    if (list(dependencies.unparsed).length) contents.push(node('h4', { text:t('unparsed') }), node('ul', { class:'config-list' }, dependencies.unparsed.map(file => node('li', {}, code(file.path)))));
    if (!contents.length) contents.push(empty('dependencyEmpty'));
    contents.push(note('dependencyNote'));
    return section('dependencies', contents);
  }
  function settingsView(config, member) {
    const definitions = list(config.deployment?.settings), effective = member ? object(config.effectiveConfiguration?.settings) : Object.fromEntries(definitions.map(setting => [setting.key, setting.default]));
    const keys = [...new Set([...definitions.map(setting => setting.key), ...Object.keys(effective)])];
    if (!keys.length) return section('settings', [empty('none')]);
    const rows = keys.map(key => {
      const definition = definitions.find(setting => setting.key === key), type = definition?.type ?? (effective[key] === null ? 'null' : Array.isArray(effective[key]) ? t('jsonArray') : typeof effective[key]);
      const name = definition ? localized(definition.label) : '';
      const range = definition && (definition.min !== undefined || definition.max !== undefined) ? node('small', { class:'config-note', text:`${t('range')}: ${definition.min ?? '−∞'} – ${definition.max ?? '∞'}` }) : null;
      return [node('div', {}, [code(key), name && name !== key ? node('span', { class:'config-setting-label', text:name }) : null]), node('div', {}, [type, range]), definition ? valueView(definition.default, key) : t('missingDefault'), ...(member ? [valueView(effective[key], key)] : [])];
    });
    return section('settings', [member ? note('sourceSettings') : null, table([t('setting'), t('type'), t('defaultValue'), ...(member ? [t('effectiveValue')] : [])], rows)], { count:keys.length });
  }
  function connectionsView(config, member) {
    const connections = list(config.deployment?.connections), bindings = member ? list(config.effectiveConfiguration?.bindings) : [];
    const contents = [];
    if (connections.length) contents.push(table([t('connection'), t('provider'), t('contracts'), t('topicMapping')], connections.map(connection => [code(connection.id), code(`${connection.provider?.moduleId ?? '—'}@${connection.provider?.version ?? '—'}`), list(connection.contracts).length ? list(connection.contracts).map(contractText).join(', ') : t('none'), entries(connection.topics).length ? node('ul', { class:'config-list' }, entries(connection.topics).map(([from, to]) => node('li', {}, [code(from), ' → ', code(to)]))) : t('none')])));
    else contents.push(empty('connectionsEmpty'));
    if (member) contents.push(node('h4', { text:t('bindings') }), bindings.length ? table([t('provider'), t('contracts')], bindings.map(binding => [code(binding.providerId), code(contractText(binding.contract))])) : empty('bindingEmpty'));
    return section('connections', contents, { count:connections.length + bindings.length });
  }
  function communicationView(config, member) {
    const effective = member ? object(config.effectiveConfiguration) : object(config.deployment), topics = entries(effective.topics), bridges = entries(effective.bridges), contents = [];
    if (topics.length) contents.push(table([t('alias'), t('topic')], topics.map(([alias, topic]) => [code(alias), code(topic)])));
    else contents.push(empty('none'));
    if (bridges.length) contents.push(table([t('bridge'), t('publish'), t('subscribe')], bridges.map(([slot, access]) => [code(slot), list(access.publish).length ? list(access.publish).join(', ') : t('empty'), list(access.subscribe).length ? list(access.subscribe).join(', ') : t('empty')])));
    if (member && config.configurationSources) contents.push(facts(['topics','bridges','settings','bindings'].map(key => [t(key === 'topics' ? 'topic' : key === 'bridges' ? 'bridge' : key), sourceName(config.configurationSources[key], true)])));
    contents.push(note('communicationNote'));
    return section('communication', contents);
  }
  function moduleView(config, member = false) {
    const description = localized(config.deployment?.description);
    const contents = [description ? node('p', {class:'config-description',text:description}) : null,executionView(config, member), runtimeView(object(config.manifest)), contractsView(object(config.manifest)), dependenciesView(config.dependencies), settingsView(config, member), connectionsView(config, member), communicationView(config, member)].filter(Boolean);
    if (!config.deployment) contents.push(note('noDeployment'));
    return contents;
  }
  function startupView(plan) {
    if (!plan) return section('startup', [empty('none')], { open:true });
    const order = list(plan.startupOrder), members = list(plan.members), arranged = [...order.map(id => members.find(member => member.programId === id)).filter(Boolean), ...members.filter(member => !order.includes(member.programId))];
    return section('startup', [note('startupNote'), facts([[t('onFailure'), ['stop-plan','continue-independent'].includes(plan.onFailure) ? t(`failure.${plan.onFailure}`) : t('none')]]), arranged.length ? table([t('order'), t('member'), t('enabled'), t('after')], arranged.map(member => [order.includes(member.programId) ? String(order.indexOf(member.programId) + 1) : '—', code(member.programId), node('span', { class:`config-status${member.enabled ? ' is-enabled' : ''}`, text:t(member.enabled ? 'yes' : 'no') }), list(member.after).length ? member.after.join(', ') : t('empty')])) : empty('none')], { open:true });
  }
  const root = node('section', { class:'config-view', 'data-testid':'artifact-configuration', 'aria-label':t('title') });
  root.append(node('div', { class:'config-header' }, node('h3', { text:t('title') })));
  if (!configuration || configuration.format !== 'world-hub.workshop-configuration/v1') {
    root.append(node('p', { class:'config-empty', role:configuration?.status === 'loading' ? 'status' : undefined, text:t(configuration?.status === 'loading' ? 'loading' : 'unavailable') }));
    return root;
  }
  root.setAttribute('data-artifact-sha256', typeof configuration.sha256 === 'string' ? configuration.sha256 : '');
  root.append(note('boundary'));
  if (configuration.scope) root.append(chips([`${t('scope')}: ${t(configuration.scope)}`]));
  if (configuration.kind === 'configuration') {
    const members = list(configuration.modules);
    root.append(chips([t('memberCount', { count:members.length })]), note('pinnedSource'));
    root.append(startupView(configuration.startupPlan ?? configuration.manifest?.startupPlan));
    root.append(contractsView(object(configuration.manifest)));
    root.append(node('div', { class:'config-members' }, [node('h4', { text:t('members') }), ...members.map(member => node('details', { class:'config-member', open:true }, [node('summary', { class:'config-member-heading' }, [code(member.memberId), node('span', { text:`${member.module?.id ?? '—'}@${member.module?.version ?? '—'}` })]), node('div', { class:'config-member-body' }, [facts([[t('moduleReference'), code(`${member.module?.id}@${member.module?.version}`)], [t('digest'), code(member.module?.digest)]]), executionView(member, true), section('settings', [entries(member.effectiveConfiguration?.settings).length ? table([t('setting'), t('effectiveValue')], entries(member.effectiveConfiguration.settings).map(([key,value]) => [code(key), valueView(value,key)])) : empty('none')]), connectionsView(member, true), communicationView(member, true)])]))]));
    if (list(configuration.data).length) root.append(section('dataReference', [table([t('instance'), t('dataReference'), t('fileDigest')], configuration.data.map(reference => [code(reference.instanceId), code(`${reference.id}@${reference.version}`), code(reference.sha256)]))]));
  } else if (configuration.kind === 'data') {
    root.append(facts([[t('dataPurpose'), t(configuration.purpose)], [t('files'), String(configuration.fileCount ?? 0)], [t('bytes'), `${configuration.byteSize ?? 0} B`]]), note('dataBoundary'));
    root.append(node('div', { class:'config-members' }, list(configuration.instances).map(instance => node('details', { class:'config-member', open:true }, [node('summary', { class:'config-member-heading' }, [code(instance.id), code(`${instance.module?.id}@${instance.module?.version}`)]), node('div', { class:'config-member-body' }, [facts([[t('moduleReference'), code(`${instance.module?.id}@${instance.module?.version}`)], [t('digest'), code(instance.module?.digest)], [t('dataFormat'), code(`${instance.dataFormat?.id}@${instance.dataFormat?.version}`)], [t('files'), String(instance.fileCount ?? 0)], [t('bytes'), `${instance.byteSize ?? 0} B`]]), table([t('file'), t('bytes'), t('fileDigest')], list(instance.files).map(file => [code(file.path), `${file.byteSize} B`, code(file.sha256)]))])]))));
  } else root.append(...moduleView(configuration));
  return root;
}
