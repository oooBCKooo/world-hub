import { createI18n } from '../ui/language.mjs';
import { manualEnglish } from './manual-i18n.mjs';

// Resources are independent of the canvas and manual bridge connection. A
// saved configuration references bodies; applying it never starts a program.
export class ResourceConsole {
  constructor({ document: doc = globalThis.document, fetch: request = globalThis.fetch?.bind(globalThis), environment = globalThis } = {}) {
    this.document = doc; this.fetch = request; this.environment = environment;
    this.i18n = createI18n(manualEnglish, { environment });
    this.state = null; this.token = ''; this.fresh = false; this.busy = false; this.review = null;
    this.labels = new Map(); this.mappingInputs = new Map(); this.dataMappingInputs = new Map(); this.retainInputs = new Map(); this.inputStates = new Map();
    this.dialog = doc.createElement('dialog'); this.dialog.id = 'resource-console'; this.dialog.className = 'mc-dialog rc-dialog';
    this.dialog.setAttribute('aria-labelledby', 'rc-title');
    this.dialog.innerHTML = `
      <div class="mc-shell"><header class="mc-header"><div><p class="mc-eyebrow">WORLD HUB · RESOURCES</p><h2 id="rc-title" data-i18n="模块资源">模块资源</h2></div><button type="button" class="mc-button mc-subtle" id="rc-refresh" data-i18n="刷新资源">刷新资源</button><button type="button" class="mc-close" id="rc-close" aria-label="关闭资源管理" data-i18n-aria-label="关闭资源管理">×</button></header>
      <div class="mc-scroll"><p class="mc-note" data-i18n="模块本体、模块配置与模块数据分别管理。保存或保留配置不会同时运行它们；切换配置默认保留数据。">模块本体、模块配置与模块数据分别管理。保存或保留配置不会同时运行它们；切换配置默认保留数据。</p>
      <p id="rc-status" class="mc-notice" role="status" aria-live="polite"></p>
      <section id="rc-recovery" class="rc-review" aria-labelledby="rc-recovery-title" hidden><h3 id="rc-recovery-title" data-i18n="需要恢复中断的数据事务">需要恢复中断的数据事务</h3><p class="mc-note" data-i18n="上次数据写入未完成。先恢复事务记录中的原数据，再继续管理受影响实例。">上次数据写入未完成。先恢复事务记录中的原数据，再继续管理受影响实例。</p><p id="rc-recovery-programs" class="mc-note"></p><label class="rc-check"><input id="rc-recovery-ack" type="checkbox"><span data-i18n="我确认恢复这些实例的中断数据事务。">我确认恢复这些实例的中断数据事务。</span></label><button id="rc-recovery-apply" type="button" class="mc-button mc-warning" disabled data-i18n="恢复中断的数据事务">恢复中断的数据事务</button></section>
      <nav class="mc-tabs rc-tabs" role="tablist" aria-label="资源类别" data-i18n-aria-label="资源类别">
        <button id="rc-tab-configurations" type="button" role="tab" aria-controls="rc-panel-configurations" aria-selected="true" tabindex="0" data-resource-tab="configurations"><span>01</span><span data-i18n="模块配置">模块配置</span></button>
        <button id="rc-tab-bodies" type="button" role="tab" aria-controls="rc-panel-bodies" aria-selected="false" tabindex="-1" data-resource-tab="bodies"><span>02</span><span data-i18n="模块本体">模块本体</span></button>
        <button id="rc-tab-data" type="button" role="tab" aria-controls="rc-panel-data" aria-selected="false" tabindex="-1" data-resource-tab="data"><span>03</span><span data-i18n="模块数据">模块数据</span></button>
        <button id="rc-tab-cleanup" type="button" role="tab" aria-controls="rc-panel-cleanup" aria-selected="false" tabindex="-1" data-resource-tab="cleanup"><span>04</span><span data-i18n="保留与清理">保留与清理</span></button>
      </nav>
      <section id="rc-panel-configurations" role="tabpanel" aria-labelledby="rc-tab-configurations" class="rc-panel">
        <div class="rc-grid"><div><div class="mc-panel-heading"><h3 data-i18n="已保存的配置">已保存的配置</h3><p data-i18n="已保存、已保留、当前生效分别显示。当前生效配置始终保留。">已保存、已保留、当前生效分别显示。当前生效配置始终保留。</p></div><div id="rc-profiles" class="rc-list"></div><button id="rc-save-retained" type="button" class="mc-button" data-i18n="保存保留集合">保存保留集合</button></div>
        <div class="mc-form"><h3 data-i18n="切换所选配置">切换所选配置</h3><label><span data-i18n="选择已保存配置">选择已保存配置</span><select id="rc-profile"></select></label><div id="rc-profile-summary" class="mc-note"></div><div id="rc-profile-mapping" class="mc-form"></div><p class="mc-note" data-i18n="逻辑实例可映射到本机已有实例；留空由预览决定新建。先核对差异、冲突与停止范围，再应用。">逻辑实例可映射到本机已有实例；留空由预览决定新建。先核对差异、冲突与停止范围，再应用。</p><fieldset class="mc-fieldset"><legend data-i18n="本次替换的生效配置">本次替换的生效配置</legend><div id="rc-replace-profiles"></div><p class="mc-note" data-i18n="勾选替换，取消勾选则尝试叠加。保留集合不会随替换选择改变。">勾选替换，取消勾选则尝试叠加。保留集合不会随替换选择改变。</p></fieldset><div class="mc-button-row"><button type="button" id="rc-profile-preview" class="mc-button mc-primary" data-i18n="预览配置切换">预览配置切换</button><button type="button" id="rc-profile-prepare" class="mc-button" data-i18n="从可信源补齐本体">从可信源补齐本体</button></div><p class="mc-note" data-i18n="补齐仅使用已配置的可信软件源下载本体，不运行模块；完成后重新预览。">补齐仅使用已配置的可信软件源下载本体，不运行模块；完成后重新预览。</p></div></div>
        <div class="mc-rule"></div><div class="rc-grid"><form id="rc-profile-import" class="mc-form"><h3 data-i18n="导入配置">导入配置</h3><label><span data-i18n="本机配置目录路径">本机配置目录路径</span><input name="path" required autocomplete="off"></label><button type="submit" class="mc-button" data-i18n="导入并保存配置">导入并保存配置</button><p class="mc-note" data-i18n="导入只保存配置，不应用、不启动、不导入数据。">导入只保存配置，不应用、不启动、不导入数据。</p></form>
        <div class="mc-form"><form id="rc-profile-export" class="mc-form"><h3 data-i18n="导出所选已保存配置">导出所选已保存配置</h3><p class="mc-note" data-i18n="导出上方选中的配置版本，不重新捕获当前实例。">导出上方选中的配置版本，不重新捕获当前实例。</p><label><span data-i18n="导出目标目录 · 可留空自动创建">导出目标目录 · 可留空自动创建</span><input name="destination" autocomplete="off"></label><button type="submit" class="mc-button" data-i18n="导出所选配置版本">导出所选配置版本</button></form><form id="rc-profile-capture" class="mc-form"><h3 data-i18n="导出当前配置">导出当前配置</h3><div id="rc-profile-capture-fields"></div><button type="submit" class="mc-button" data-i18n="保存并导出配置">保存并导出配置</button><p class="mc-note" data-i18n="配置仅含本体引用、参数与连接，不包含本体文件、凭据或模块数据。">配置仅含本体引用、参数与连接，不包含本体文件、凭据或模块数据。</p></form></div></div>
      </section>
      <section id="rc-panel-bodies" role="tabpanel" aria-labelledby="rc-tab-bodies" class="rc-panel" hidden><div class="mc-panel-heading"><h3 data-i18n="统一模块本体库">统一模块本体库</h3><p data-i18n="同一版本与摘要的本体可供多配置引用；实例身份和数据独立保留。">同一版本与摘要的本体可供多配置引用；实例身份和数据独立保留。</p></div><div id="rc-bodies" class="rc-list"></div><div class="mc-rule"></div><div class="rc-grid"><form id="rc-body-import" class="mc-form"><h3 data-i18n="导入本体到统一库">导入本体到统一库</h3><label><span data-i18n="本机模块目录、本体集合目录或制品路径">本机模块目录、本体集合目录或制品路径</span><input name="path" required autocomplete="off"></label><button type="submit" class="mc-button" data-i18n="导入本体，不创建实例">导入本体，不创建实例</button></form><form id="rc-body-export" class="mc-form"><h3 data-i18n="导出模块本体">导出模块本体</h3><div id="rc-body-export-fields"></div><button type="submit" class="mc-button" data-i18n="导出所选范围本体">导出所选范围本体</button><p class="mc-note" data-i18n="仅导出本体清单与文件；配置和数据分别导出。">仅导出本体清单与文件；配置和数据分别导出。</p></form></div></section>
      <section id="rc-panel-data" role="tabpanel" aria-labelledby="rc-tab-data" class="rc-panel" hidden><div class="mc-panel-heading"><h3 data-i18n="备份与数据集">备份与数据集</h3><p data-i18n="模块数据与配置独立。恢复前停止选定实例并创建快照备份；兼容性需要明确确认。">模块数据与配置独立。恢复前停止选定实例并创建快照备份；兼容性需要明确确认。</p></div><div class="rc-grid"><div class="mc-form"><div id="rc-data-list" class="rc-list"></div><form id="rc-data-import" class="mc-form"><label><span data-i18n="本机数据目录路径">本机数据目录路径</span><input name="path" required autocomplete="off"></label><button type="submit" class="mc-button" data-i18n="导入并保存数据">导入并保存数据</button></form><label><span data-i18n="选择待恢复数据">选择待恢复数据</span><select id="rc-data"></select></label><div id="rc-data-mapping" class="mc-form"></div><button type="button" id="rc-data-preview" class="mc-button mc-warning" data-i18n="预览数据恢复">预览数据恢复</button></div>
        <form id="rc-data-export" class="mc-form"><h3 data-i18n="导出模块数据">导出模块数据</h3><div id="rc-data-export-fields"></div><div class="mc-grid-two"><label><span data-i18n="数据格式标识">数据格式标识</span><input name="formatId" required></label><label><span data-i18n="数据格式版本">数据格式版本</span><input name="formatVersion" value="1.0.0" required></label></div><label><span data-i18n="数据用途">数据用途</span><select name="purpose"><option value="backup" data-i18n="私人备份">私人备份</option><option value="dataset" data-i18n="可分发数据集">可分发数据集</option></select></label><label class="rc-check"><input type="checkbox" name="publicDataAcknowledged"><span data-i18n="作为数据集导出时，我已核对数据可公开分发。">作为数据集导出时，我已核对数据可公开分发。</span></label><button type="submit" class="mc-button" data-i18n="导出数据">导出数据</button></form></div></section>
      <section id="rc-panel-cleanup" role="tabpanel" aria-labelledby="rc-tab-cleanup" class="rc-panel" hidden><div class="mc-panel-heading"><h3 data-i18n="按保留集合清理">按保留集合清理</h3><p data-i18n="清理以已保存的保留集合为基础。当前生效配置与所有保留配置保护其引用，保留多个配置不会同时运行它们。">清理以已保存的保留集合为基础。当前生效配置与所有保留配置保护其引用，保留多个配置不会同时运行它们。</p></div><p id="rc-cleanup-retained" class="mc-note"></p><form id="rc-cleanup-preview" class="mc-form"><label><span data-i18n="额外保留的实例 ID · 逗号或空白分隔">额外保留的实例 ID · 逗号或空白分隔</span><input name="keepProgramIds" autocomplete="off" list="rc-program-options"></label><label class="rc-check"><input name="removeUnreferencedBodies" type="checkbox"><span data-i18n="同时清理零引用的本体缓存">同时清理零引用的本体缓存</span></label><button type="submit" class="mc-button mc-warning" data-i18n="预览清理范围">预览清理范围</button></form><p class="mc-notice" data-i18n="清理只注销可清理实例、按选择移除零引用本体缓存。模块数据保留，不包含删除数据操作。">清理只注销可清理实例、按选择移除零引用本体缓存。模块数据保留，不包含删除数据操作。</p></section>
      <section id="rc-review" class="rc-review" aria-labelledby="rc-review-title" hidden><h3 id="rc-review-title"></h3><div id="rc-review-content" class="rc-list"></div><label class="rc-check"><input id="rc-review-stop" type="checkbox"><span data-i18n="允许停止预览中列出的本机自有进程">允许停止预览中列出的本机自有进程</span></label><label class="rc-check"><input id="rc-review-compatibility" type="checkbox"><span data-i18n="我已核对源数据格式、模块版本与目标实例的数据兼容性。">我已核对源数据格式、模块版本与目标实例的数据兼容性。</span></label><label class="rc-check"><input id="rc-review-ack" type="checkbox"><span data-i18n="已核对本次预览的影响范围，确认应用。">已核对本次预览的影响范围，确认应用。</span></label><button id="rc-review-apply" type="button" class="mc-button mc-warning" disabled data-i18n="确认应用预览">确认应用预览</button></section>
      <details id="rc-receipt-box" class="mc-extra" hidden><summary data-i18n="操作回执与原始诊断">操作回执与原始诊断</summary><pre id="rc-receipt"></pre></details><datalist id="rc-program-options"></datalist>
      </div></div>`;
    doc.body.append(this.dialog);
    this.installFields('profile-capture', true); this.installFields('body-export', false); this.installFields('data-export', true);
    this.bind(); this.i18n.onChange(() => this.translate()); this.translate();
    environment.addEventListener?.('world-hub:resource-import', event => {
      const { kind, path } = event.detail || {};
      if (['configuration', 'data'].includes(kind) && typeof path === 'string' && path) this.importPath(kind, path);
    });
  }

  $(id) { return this.dialog.querySelector(`#rc-${id}`); }
  t(source, params) { return this.i18n.t(source, params); }
  text(element, source, params) { this.labels.set(element, { source, params }); element.textContent = this.t(source, params); return element; }
  node(tag, text = '') { const node = this.document.createElement(tag); node.textContent = text; return node; }
  displayTitle(value) { return value && typeof value === 'object' ? value[this.i18n.language === 'en' ? 'en' : 'zh'] || value.en || value.zh || '' : value || ''; }
  label(tag, source, params) { return this.text(this.node(tag), source, params); }
  translate() {
    this.i18n.apply(this.dialog); this.dialog.lang = this.i18n.language;
    for (const [node, binding] of this.labels) {
      if (!node.isConnected) { this.labels.delete(node); continue; }
      node.textContent = this.t(binding.source, binding.params);
    }
    const launcher = this.document.getElementById('btn-resource-console'); if (launcher) launcher.textContent = this.t('模块资源');
  }
  installFields(prefix, metadata) {
    this.$(`${prefix}-fields`).innerHTML = `<div class="mc-form"><div class="mc-grid-two"><label><span data-i18n="资源范围">资源范围</span><select name="scope"><option value="global" data-i18n="全局 · 所有本机实例">全局 · 所有本机实例</option><option value="local" data-i18n="局部 · 所选实例">局部 · 所选实例</option></select></label><label><span data-i18n="局部实例 ID · 逗号或空白分隔">局部实例 ID · 逗号或空白分隔</span><input name="programIds" autocomplete="off" list="rc-program-options" disabled></label></div>${metadata ? '<div class="mc-grid-two"><label><span data-i18n="资源标识">资源标识</span><input name="id" required pattern="[a-zA-Z0-9][a-zA-Z0-9._\\-]*" autocomplete="off"></label><label><span data-i18n="资源版本">资源版本</span><input name="version" value="1.0.0" required></label></div><label><span data-i18n="资源名称">资源名称</span><input name="title" required></label>' : ''}<label><span data-i18n="导出目标目录 · 可留空自动创建">导出目标目录 · 可留空自动创建</span><input name="destination" autocomplete="off"></label></div>`;
    const form = this.$(prefix), scope = form.elements.namedItem('scope'), ids = form.elements.namedItem('programIds');
    scope.addEventListener('change', () => { ids.disabled = scope.value !== 'local'; ids.required = scope.value === 'local'; });
  }
  bind() {
    const sources = this.node('section'); sources.className = 'mc-form';
    sources.innerHTML = `<h3 data-i18n="补齐本体的软件源">补齐本体的软件源</h3><p data-i18n="保存来源只用于下载完整性核对，不授予模块执行权限。">保存来源只用于下载完整性核对，不授予模块执行权限。</p><div id="rc-sources" class="rc-list"></div><form id="rc-source-save" class="mc-form"><label><span data-i18n="来源名称">来源名称</span><input name="name" required></label><label><span data-i18n="来源索引 HTTPS 地址或本机绝对路径">来源索引 HTTPS 地址或本机绝对路径</span><input name="source" required value="https://peros.cn/workshop/index.json"></label><label class="rc-check"><input type="checkbox" name="allowPrivateNetwork"><span data-i18n="我信任此来源及代理，允许私网解析地址。">我信任此来源及代理，允许私网解析地址。</span></label><button type="submit" class="mc-button" data-i18n="保存并启用来源">保存并启用来源</button></form>`;
    this.$('panel-bodies').append(sources);
    this.$('source-save').addEventListener('submit', event => {
      event.preventDefault(); const form = event.currentTarget;
      this.run(async () => {
        await this.mutate('/sources/save', { name: form.elements.namedItem('name').value.trim(), source: form.elements.namedItem('source').value.trim(), allowPrivateNetwork: form.elements.namedItem('allowPrivateNetwork').checked, enabled: true });
        await this.refresh();
      });
    });
    for (const input of this.dialog.querySelectorAll('input[name="path"], input[name="destination"]')) {
      const output = input.name === 'destination', row = this.node('div'); row.className = 'mc-button-row';
      for (const file of output ? [false] : [false, true]) {
        const button = this.label('button', output ? '选择输出父目录' : file ? '选择制品文件' : '选择资源目录'); button.type = 'button'; button.className = 'mc-button';
        button.addEventListener('click', () => this.run(async () => {
          const selected = await this.request('/manage/api/paths/native-pick', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Management-Token': this.token }, body: JSON.stringify({ purpose: file ? 'source' : 'directory', ...(input.value ? { initialPath: input.value } : {}) }) });
          if (selected.cancelled) return;
          input.value = output ? `${selected.path.replace(/[\\/]+$/, '')}/world-hub-export-${Date.now()}` : selected.path;
          this.clearReview();
        })); row.append(button);
      }
      input.closest('label').after(row);
    }
    this.$('close').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => this.launcher?.focus());
    this.$('refresh').addEventListener('click', () => this.run(() => this.refresh(), true));
    this.$('recovery-ack').addEventListener('change', () => this.updateControls());
    this.$('recovery-apply').addEventListener('click', () => this.run(async () => {
      if (!this.state.recoveryRequired || !this.$('recovery-ack').checked) return;
      await this.mutate('/data/recover', { accepted: true }); await this.refresh(); this.status('中断的数据事务已恢复。请重新预览后续操作。');
    }));
    const tabs = [...this.dialog.querySelectorAll('[data-resource-tab]')];
    tabs.forEach((button, index) => {
      button.addEventListener('click', () => this.selectTab(button.dataset.resourceTab));
      button.addEventListener('keydown', event => {
        let next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
        if (next >= 0) { event.preventDefault(); this.selectTab(tabs[next].dataset.resourceTab); tabs[next].focus(); }
      });
    });
    this.$('profile').addEventListener('change', () => { this.clearReview(); this.renderProfile(); });
    this.$('data').addEventListener('change', () => { this.clearReview(); this.renderDataMapping(); });
    this.$('save-retained').addEventListener('click', () => this.run(async () => {
      const profileIds = [...this.retainInputs].filter(([, input]) => input.checked).map(([id]) => id);
      await this.mutate('/profiles/retain', { profileIds, expectedRevision: this.state.revision }); await this.refresh(); this.status('已保存保留集合；当前运行状态未改变。');
    }));
    this.$('profile-preview').addEventListener('click', () => this.run(async () => {
      const replaceProfileIds = [...this.$('replace-profiles').querySelectorAll('input:checked')].map(input => input.value);
      const result = await this.post('/profiles/preview', { profileId: this.selectedProfileId(), mapping: this.mapping(this.mappingInputs), replaceProfileIds, expectedRevision: this.state.revision }); this.showReview('configuration', result);
    }));
    this.$('profile-prepare').addEventListener('click', () => this.run(async () => {
      await this.mutate('/profiles/prepare', { profileId: this.selectedProfileId(), accepted: true }); await this.refresh(); this.status('缺失本体准备完成。请重新预览配置切换。');
    }));
    this.$('profile-export').addEventListener('submit', event => {
      event.preventDefault(); const destination = event.currentTarget.elements.namedItem('destination').value.trim();
      this.run(async () => {
        const result = await this.mutate('/profiles/export', { profileId: this.selectedProfileId(), ...(destination ? { destination } : {}) });
        this.status('已导出到本机目录：{path}', { path: result.directory || result.artifactPath || result.path || '—' });
      });
    });
    for (const kind of ['profile', 'data', 'body']) this.$(`${kind}-import`).addEventListener('submit', event => {
      event.preventDefault(); this.run(async () => {
        await this.mutate(kind === 'profile' ? '/profiles/import' : kind === 'body' ? '/bodies/import' : '/data/import', { path: event.currentTarget.elements.namedItem('path').value.trim() });
        await this.refresh(); this.status(kind === 'profile' ? '配置已保存，尚未应用。' : kind === 'body' ? '本体已保存到统一库；未创建或启动实例。' : '数据已保存，尚未恢复。');
      });
    });
    for (const [formId, endpoint] of [['profile-capture', '/profiles/capture'], ['body-export', '/bodies/export'], ['data-export', '/data/export']]) {
      this.$(formId).addEventListener('submit', event => {
        event.preventDefault(); const form = event.currentTarget;
        this.run(async () => {
          const body = this.exportFields(form);
          if (formId === 'data-export') {
            body.dataFormat = { id: form.elements.namedItem('formatId').value.trim(), version: form.elements.namedItem('formatVersion').value.trim() };
            body.purpose = form.elements.namedItem('purpose').value;
            if (body.purpose === 'dataset' && !form.elements.namedItem('publicDataAcknowledged').checked) throw new Error(this.t('请先确认数据可以公开分发。'));
            body.publicDataAcknowledged = form.elements.namedItem('publicDataAcknowledged').checked;
          }
          const result = await this.mutate(endpoint, body); await this.refresh();
          this.status('已导出到本机目录：{path}', { path: result.artifactPath || result.directory || result.path || result.profile?.path || result.data?.path || '—' });
        });
      });
    }
    this.$('data-preview').addEventListener('click', () => this.run(async () => {
      const dataId = this.$('data').value; if (!dataId) throw new Error(this.t('请先选择数据。'));
      const mapping = this.mapping(this.dataMappingInputs);
      if (this.dataMappingInputs.size !== Object.keys(mapping).length) throw new Error(this.t('请为每项数据指定目标实例。'));
      this.showReview('data', await this.post('/data/preview', { dataId, mapping }));
    }));
    this.$('cleanup-preview').addEventListener('submit', event => {
      event.preventDefault(); const form = event.currentTarget;
      this.run(async () => this.showReview('cleanup', await this.post('/cleanup/preview', {
        keepProfileIds: (this.state.profiles || []).filter(row => row.retained || row.active).map(row => this.profileKey(row)),
        keepProgramIds: this.ids(form.elements.namedItem('keepProgramIds').value), removeUnreferencedBodies: form.elements.namedItem('removeUnreferencedBodies').checked
      })));
    });
    for (const id of ['review-stop', 'review-compatibility', 'review-ack']) this.$(id).addEventListener('change', () => this.updateApply());
    this.$('review-apply').addEventListener('click', () => this.run(() => this.applyReview()));
    // Changing a target or cleanup selection invalidates any previous consent.
    for (const id of ['profile-mapping', 'replace-profiles', 'data-mapping', 'cleanup-preview']) this.$(id).addEventListener('input', () => this.clearReview());
  }
  ids(value) { return [...new Set(String(value).split(/[\s,]+/).filter(Boolean))]; }
  mapping(inputs) { return Object.fromEntries([...inputs].map(([id, input]) => [id, input.value.trim()]).filter(([, value]) => value)); }
  exportFields(form) {
    const value = key => form.elements.namedItem(key)?.value.trim(), body = { scope: value('scope') };
    if (body.scope === 'local') { body.programIds = this.ids(value('programIds')); if (!body.programIds.length) throw new Error(this.t('局部范围需要至少一个实例。')); }
    for (const key of ['id', 'title', 'version', 'destination']) if (value(key)) body[key] = value(key);
    return body;
  }
  profileKey(row) { return row.profileId || row.id; }
  dataKey(row) { return row.dataId || row.id; }
  selectedProfileId() { const id = this.$('profile').value; if (!id) throw new Error(this.t('请先选择配置。')); return id; }
  selectTab(key) {
    this.dialog.querySelectorAll('[data-resource-tab]').forEach(button => {
      const selected = button.dataset.resourceTab === key; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      this.$(`panel-${button.dataset.resourceTab}`).hidden = !selected;
    });
    this.clearReview();
  }
  status(source, params = {}, error = false) { this.text(this.$('status'), source, params); this.$('status').classList.toggle('mc-notice-error', error); }
  receipt(value) { this.$('receipt-box').hidden = false; this.$('receipt').textContent = JSON.stringify(value, null, 2); }
  async request(path, init = {}) {
    const abort = new AbortController(), timeout = this.environment.setTimeout(() => abort.abort(), 30000);
    try {
      const response = await this.fetch(path, { cache: 'no-store', credentials: 'same-origin', ...init, signal: abort.signal });
      const value = await response.json();
      if (!response.ok) { const error = new Error(value?.error?.message || value?.message || value?.error || `HTTP ${response.status}`); error.detail = value; throw error; }
      return value;
    } finally { this.environment.clearTimeout(timeout); }
  }
  async post(path, body) {
    if (!this.fresh || !this.token) throw new Error(this.t('请先刷新资源状态。'));
    return this.request(`/manage/api/resources${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Management-Token': this.token }, body: JSON.stringify(body) });
  }
  async mutate(path, body) {
    this.clearReview();
    try { const result = await this.post(path, body); this.receipt(result); return result; }
    catch (error) { this.fresh = false; throw error; }
  }
  async run(callback, allowStale = false) {
    if (this.busy) return;
    if (!allowStale && !this.fresh) { this.status('请先刷新资源状态。', {}, true); return; }
    this.busy = true; this.updateControls();
    try { await callback(); }
    catch (error) { this.clearReview(); this.status('资源操作未确认；请检查回执并刷新状态。不会自动重发。', {}, true); this.receipt(error.detail || { message: error.message }); }
    finally { this.busy = false; this.updateControls(); }
  }
  updateControls() {
    for (const input of this.dialog.querySelectorAll('input, select, textarea')) {
      if (this.busy) { if (!this.inputStates.has(input)) this.inputStates.set(input, input.disabled); input.disabled = true; }
      else if (this.inputStates.has(input)) { input.disabled = this.inputStates.get(input); this.inputStates.delete(input); }
    }
    for (const input of this.inputStates.keys()) if (!input.isConnected) this.inputStates.delete(input);
    this.dialog.querySelectorAll('button').forEach(button => {
      if (button.id === 'rc-close') return;
      if (button.dataset.resourceTab) { button.disabled = this.busy; return; }
      button.disabled = this.busy || (button.id !== 'rc-refresh' && !this.fresh);
    });
    this.$('profile-preview').disabled ||= !this.$('profile').value;
    this.$('profile-prepare').disabled ||= !this.$('profile').value;
    this.$('data-preview').disabled ||= !this.$('data').value;
    this.$('profile-export').querySelector('button[type="submit"]').disabled ||= !this.$('profile').value;
    this.$('recovery-apply').disabled ||= !this.state?.recoveryRequired || !this.$('recovery-ack').checked;
    this.updateApply();
  }
  async refresh() {
    this.clearReview(); this.fresh = false;
    const [state, management] = await Promise.all([this.request('/manage/api/resources'), this.request('/manage/api/state')]);
    if (state.format !== 'world-hub.resource-state/v1' || !Array.isArray(state.profiles) || !management.csrfToken) throw new Error(this.t('资源状态格式不完整。'));
    this.state = state; this.token = management.csrfToken; this.fresh = true; this.renderState(); this.status('资源状态已刷新；保存、保留与生效状态如下。');
    this.updateControls();
  }
  option(select, value, text) { const option = this.node('option', text); option.value = value; select.append(option); return option; }
  renderState() {
    this.$('recovery').hidden = !this.state.recoveryRequired; this.$('recovery-ack').checked = false;
    this.text(this.$('recovery-programs'), '受影响的实例：{ids}', { ids: (this.state.recoveryProgramIds || []).join(', ') });
    const previousProfile = this.$('profile').value, previousData = this.$('data').value;
    this.$('profile').replaceChildren(); this.$('data').replaceChildren(); this.$('profiles').replaceChildren(); this.$('bodies').replaceChildren(); this.$('data-list').replaceChildren(); this.$('program-options').replaceChildren(); this.retainInputs.clear();
    this.text(this.option(this.$('profile'), '', ''), '选择已保存配置'); this.text(this.option(this.$('data'), '', ''), '选择待恢复数据');
    for (const program of this.state.programs || []) this.option(this.$('program-options'), program.id || program.programId, `${this.displayTitle(program.title || program.name)} · ${program.id || program.programId}`);
    for (const profile of this.state.profiles) {
      const key = this.profileKey(profile), card = this.node('article'); card.className = 'rc-card';
      const heading = this.node('div'); heading.className = 'mc-card-heading'; heading.append(this.node('strong', `${profile.title || profile.id} · ${profile.version}`));
      const badges = this.node('span'); badges.className = 'rc-badges';
      for (const [source, show] of [['已保存', true], ['已保留', profile.retained || profile.active], ['当前生效', profile.active]]) if (show) { const badge = this.label('span', source); badge.className = `rc-badge${profile.active && source === '当前生效' ? ' rc-active' : ''}`; badges.append(badge); }
      heading.append(badges); card.append(heading, this.node('code', profile.id), this.label('p', profile.scope === 'local' ? '局部配置' : '全局配置'));
      const check = this.node('label'); check.className = 'rc-check'; const input = this.node('input'); input.type = 'checkbox'; input.checked = Boolean(profile.retained || profile.active); input.disabled = Boolean(profile.active);
      check.append(input, this.label('span', profile.active ? '当前生效，自动保留' : '保留此配置及其引用')); this.retainInputs.set(key, input); input.addEventListener('change', () => this.clearReview()); card.append(check);
      if (profile.missingModules?.length) card.append(this.label('p', '缺少 {count} 个本体引用', { count: profile.missingModules.length }));
      if (profile.active) {
        const deactivate = this.label('button', '取消生效，保留当前运行与数据'); deactivate.type = 'button'; deactivate.className = 'mc-button';
        deactivate.addEventListener('click', () => this.run(async () => {
          await this.mutate('/profiles/deactivate', { profileIds: [key], accepted: true, expectedRevision: this.state.revision }); await this.refresh();
          this.status('配置已取消生效；实例仍保留。请取消保留后预览清理。');
        })); card.append(deactivate);
      }
      this.$('profiles').append(card); this.option(this.$('profile'), key, `${profile.title || profile.id} · ${profile.version}`);
    }
    if (!this.state.profiles.length) this.$('profiles').append(this.label('p', '尚无已保存配置。可导入配置或导出当前配置。'));
    for (const body of this.state.bodies || []) {
      const card = this.node('article'); card.className = 'rc-card'; card.append(this.node('strong', `${body.id} · ${body.version}`), this.node('pre', body.digest || ''), this.label('p', '引用实例：{ids}', { ids: (body.programIds || []).join(', ') || '—' })); this.$('bodies').append(card);
    }
    if (!this.state.bodies?.length) this.$('bodies').append(this.label('p', '本体库中暂无条目。'));
    this.$('sources').replaceChildren();
    for (const source of this.state.sources || []) {
      const card = this.node('article'); card.className = 'rc-card'; card.append(this.node('strong', source.name), this.node('code', source.source));
      const toggle = this.label('button', source.enabled ? '停用来源' : '启用来源'); toggle.type = 'button'; toggle.className = 'mc-button';
      toggle.addEventListener('click', () => this.run(async () => { await this.mutate('/sources/save', { ...source, enabled: !source.enabled }); await this.refresh(); }));
      const remove = this.label('button', '移除来源'); remove.type = 'button'; remove.className = 'mc-button';
      remove.addEventListener('click', () => this.run(async () => { await this.mutate('/sources/remove', { sourceId: source.id }); await this.refresh(); }));
      card.append(toggle, remove); this.$('sources').append(card);
    }
    for (const data of this.state.data || []) {
      const card = this.node('article'); card.className = 'rc-card'; card.append(this.node('strong', `${data.title || data.id} · ${data.version}`), this.node('code', data.id), this.label('p', data.purpose === 'dataset' ? '可分发数据集' : '私人备份'), this.label('p', data.scope === 'local' ? '局部数据' : '全局数据')); this.$('data-list').append(card); this.option(this.$('data'), this.dataKey(data), `${data.title || data.id} · ${data.version}`);
    }
    if (!this.state.data?.length) this.$('data-list').append(this.label('p', '尚无已保存数据。'));
    this.$('profile').value = this.state.profiles.some(row => this.profileKey(row) === previousProfile) ? previousProfile : this.state.profiles.length ? this.profileKey(this.state.profiles.find(row => row.active) || this.state.profiles[0]) : '';
    this.$('data').value = this.state.data?.some(row => this.dataKey(row) === previousData) ? previousData : this.state.data?.length ? this.dataKey(this.state.data[0]) : '';
    this.renderProfile(); this.renderDataMapping();
    this.$('replace-profiles').replaceChildren();
    for (const profile of this.state.profiles.filter(row => row.active)) {
      const label = this.node('label'), check = this.node('input'); label.className = 'rc-check'; check.type = 'checkbox'; check.value = this.profileKey(profile); check.checked = true;
      label.append(check, this.node('span', `${profile.title || profile.id} · ${profile.version}`)); this.$('replace-profiles').append(label);
    }
    this.text(this.$('cleanup-retained'), '受保护的配置：{titles}', { titles: this.state.profiles.filter(row => row.retained || row.active).map(row => row.title || row.id).join(', ') || '—' });
  }
  renderMapping(target, modules, mapping, inputs) {
    target.replaceChildren(); inputs.clear();
    for (const row of modules || []) {
      const id = row.id || row.logicalId, label = this.node('label'), input = this.node('input'); if (!id) continue;
      label.append(this.node('span', `${id} · ${row.module?.id || ''} ${row.module?.version || ''}`));
      if (row.dataFormat) label.append(this.label('span', '数据格式：{id} @ {version}', row.dataFormat));
      input.value = mapping?.[id] || ''; input.setAttribute('list', 'rc-program-options'); input.setAttribute('autocomplete', 'off'); label.append(input); target.append(label); inputs.set(id, input);
    }
  }
  renderProfile() {
    const profile = this.state?.profiles.find(row => this.profileKey(row) === this.$('profile').value);
    this.text(this.$('profile-summary'), profile?.scope === 'local' ? '局部配置' : '全局配置');
    this.renderMapping(this.$('profile-mapping'), profile?.manifest?.modules, profile?.mapping, this.mappingInputs);
  }
  renderDataMapping() {
    const data = this.state?.data?.find(row => this.dataKey(row) === this.$('data').value);
    this.renderMapping(this.$('data-mapping'), data?.manifest?.instances, {}, this.dataMappingInputs);
  }
  clearReview() { this.review = null; this.$('review').hidden = true; this.$('review-apply').disabled = true; }
  showReview(kind, result) {
    this.clearReview(); if (!result.reviewId || !result.review) throw new Error(this.t('预览回执格式不完整。'));
    this.review = { kind, ...result }; this.$('review').hidden = false;
    this.text(this.$('review-title'), kind === 'configuration' ? '核对配置切换' : kind === 'data' ? '核对数据恢复' : '核对清理范围');
    const content = this.$('review-content'); content.replaceChildren(); const review = result.review;
    const list = (source, values) => {
      if (!Array.isArray(values) || !values.length) return;
      const box = this.node('div'); box.className = 'rc-review-group'; box.append(this.label('strong', source));
      const items = this.node('ul'); for (const value of values) items.append(this.node('li', typeof value === 'string' ? value : [value.programId || value.id || value.logicalId || value.profileId || value.module?.id, value.code, value.reason].filter(Boolean).join(' · ') || JSON.stringify(value))); box.append(items); content.append(box);
    };
    list('实例映射', Object.entries(review.mapping || {}).map(([source, target]) => `${source} → ${target}`));
    list('数据恢复目标', review.entries); list('缺失的模块本体', review.missingModules); list('冲突', review.conflicts); list('新增实例', review.adds); list('重新登记并保留原数据的实例', review.restores); list('移除或注销实例', review.removes); list('配置变更', review.changes); list('需要停止的实例', review.requiresStop); list('受保护并保留', review.retained); list('可清理项目', review.removable); list('可清理本体缓存', review.removableBodies); list('继续保留的运行实例', review.protectedRunningInstances); list('阻止原因', review.blockers);
    content.append(this.label('p', kind === 'configuration' ? '应用只切换配置，不自动启动实例，不删除模块数据。' : kind === 'data' ? '恢复会停止目标实例、创建快照备份，再写入数据；不会自动启动。' : '清理不会删除模块数据。'));
    if (review.blocked || review.conflicts?.length || review.missingModules?.length) content.append(this.label('p', '预览包含阻止项，暂不能应用。'));
    this.$('review-ack').checked = false; this.$('review-stop').checked = false; this.$('review-compatibility').checked = false;
    this.$('review-stop').parentElement.hidden = kind === 'data' || !review.requiresStop?.length;
    this.$('review-compatibility').parentElement.hidden = kind !== 'data';
    this.receipt(result); this.updateApply(); this.$('review').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }
  canApply() {
    if (!this.review || !this.fresh) return false;
    if (this.review.expiresAt && Date.parse(this.review.expiresAt) <= Date.now()) return false;
    const { kind, review } = this.review;
    return !review.blocked && !review.conflicts?.length && !review.missingModules?.length && this.$('review-ack').checked
      && (kind === 'data' ? this.$('review-compatibility').checked : !review.requiresStop?.length || this.$('review-stop').checked);
  }
  updateApply() { this.$('review-apply').disabled = this.busy || !this.canApply(); }
  async applyReview() {
    if (!this.canApply()) return;
    const { kind, reviewId } = this.review, body = { reviewId, accepted: true };
    if (kind === 'data') body.dataCompatibilityAcknowledged = true; else body.stopOwned = this.$('review-stop').checked;
    await this.mutate(kind === 'configuration' ? '/profiles/apply' : kind === 'data' ? '/data/apply' : '/cleanup/apply', body);
    await this.refresh(); this.status(kind === 'configuration' ? '配置已应用；模块数据保留，实例尚未自动启动。' : kind === 'data' ? '数据恢复已完成；回执中可核对恢复前快照。' : '清理已完成；模块数据保留。');
    this.environment.dispatchEvent?.(new this.environment.CustomEvent('world-hub:resources-changed'));
  }
  async open(launcher) {
    this.launcher = launcher || this.document.activeElement; if (!this.dialog.open) this.dialog.showModal();
    await this.run(() => this.refresh(), true);
  }
  async importPath(kind, path) {
    this.launcher = this.document.getElementById('btn-resource-console'); if (!this.dialog.open) this.dialog.showModal();
    await this.run(async () => {
      await this.refresh(); await this.mutate(kind === 'configuration' ? '/profiles/import' : '/data/import', { path }); await this.refresh();
      this.selectTab(kind === 'configuration' ? 'configurations' : 'data'); this.status(kind === 'configuration' ? '配置已保存，尚未应用。' : '数据已保存，尚未恢复。');
    }, true);
  }
}

if (typeof document !== 'undefined') {
  const launcher = document.getElementById('btn-resource-console');
  if (launcher) { const resources = new ResourceConsole(); launcher.addEventListener('click', () => resources.open(launcher)); }
}
