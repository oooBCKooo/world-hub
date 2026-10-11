// Local paths are selected through the authenticated Launcher, never through a browser upload.
export function pathPurpose(input) {
  if (input.dataset.pathPurpose) return input.dataset.pathPurpose;
  const name = input.name ?? '', title = input.closest?.('label')?.textContent ?? '';
  if (['nodePath', 'pythonPath', 'dockerPath', 'setprivPath'].includes(name)) return 'executable';
  if (name === 'moduleDirectory') return 'module';
  if (name === 'proposalDirectory') return 'proposal';
  if (name === 'backup') return 'backup';
  if (['evidencePath', 'artifactPath'].includes(name)) return 'file';
  if (name === 'source') return 'source';
  if (name === 'backupDestination') return 'save-file';
  if (name === 'destination') return /备份|backup|文件|file/i.test(title) ? 'save-file' : 'save-directory';
  if (name === 'candidate') return 'pack';
  if (name === 'directory') {
    if (/评论|comments|交换文件|exchange file/i.test(title)) return 'save-file';
    if (/模板目录|template directory/i.test(title)) return /新的|new/i.test(title) ? 'save-directory' : 'template';
    if (/包或模块|pack or module/i.test(title)) return 'directory';
    return 'pack';
  }
  return null;
}

export function createPathUi({ state, api, el, button, toast }) {
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  let dialog, target, purpose, listing, known, request = 0, scanId, scanTimer, busy = false;
  const controls = new Set(), checks = new WeakMap();
  function fail(error) { const node = dialog.querySelector('.path-error'); node.hidden = false; node.textContent = error.message; }
  function ensureDialog() {
    if (dialog) return;
    dialog = el('dialog', { id: 'path-picker-dialog', class: 'dialog path-picker-dialog', 'aria-labelledby': 'path-picker-title' });
    document.body.append(dialog);
    dialog.addEventListener('close', () => { request++; clearTimeout(scanTimer); scanId = null; target = null; });
  }
  function setValue(value) {
    if (!target) return;
    target.value = value; target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }));
    void api('/api/paths/remember', { path: value, purpose }).catch(() => {});
    const input = target; dialog.close(); input.focus();
  }
  async function choose(path) {
    if (busy) return;
    const selectedInput = target, selectedPurpose = purpose, epoch = request;
    try { const checked = await api('/api/paths/check', { path, purpose: selectedPurpose }); if (!dialog.open || target !== selectedInput || purpose !== selectedPurpose || request !== epoch) return; if (!checked.selectable) throw new Error(say('路径类型不匹配，或目标已存在。请选择有效来源或新的输出名称。', 'Path type does not match, or output already exists. Choose a valid source or a new output name.')); setValue(checked.path); }
    catch (error) { if (dialog.open && target === selectedInput && request === epoch) fail(error); }
  }
  function objectText(object) { const kinds = { pack: ['整合包', 'Pack'], module: ['模块', 'Module'], template: ['模板', 'Template'], proposal: ['提案', 'Proposal'], source: ['软件源', 'Source'], backup: ['备份候选', 'Backup candidate'], executable: ['解释器候选', 'Executable candidate'], comments: ['评论交换', 'Comment exchange'] }; return object ? `${kinds[object.kind] ? say(...kinds[object.kind]) : object.kind}${object.title ?? object.id ? ` · ${object.title ?? object.id}` : ''}${object.version ? ` @${object.version}` : ''}` : ''; }
  function renderListing() {
    if (!dialog.open || !listing) return;
    dialog.querySelector('[name=path-location]').value = listing.directory;
    const root = dialog.querySelector('.path-entries');
    root.replaceChildren(...listing.entries.map(entry => el('div', { class: 'path-entry' }, [
      entry.kind === 'directory' ? button(`▣ ${entry.name}`, () => void browse(entry.path), 'button button-quiet path-entry-name') : el('span', { class: 'path-entry-name' }, `${entry.kind === 'blocked' ? '⊘' : '◇'} ${entry.name}`),
      el('small', { class: 'subtle' }, objectText(entry.object)),
      entry.selectable && !purpose.startsWith('save-') ? button(say('选择', 'Select'), () => void choose(entry.path), 'button button-small') : null
    ])));
    if (!listing.entries.length) root.append(el('p', {}, say('目录为空。', 'This folder is empty.')));
    if (listing.nextOffset !== null) root.append(button(say('下一页', 'Next page'), () => void browse(listing.directory, listing.nextOffset), 'button button-quiet'));
    if (listing.offset) root.prepend(button(say('上一页', 'Previous page'), () => void browse(listing.directory, Math.max(0, listing.offset - 100)), 'button button-quiet'));
    dialog.querySelector('.path-up').disabled = busy || !listing.parent;
    const select = dialog.querySelector('.path-select-current'); select.hidden = purpose.startsWith('save-');
    select.disabled = true;
    const currentRequest = request;
    if (!purpose.startsWith('save-')) void api('/api/paths/check', { path: listing.directory, purpose }).then(checked => { if (currentRequest === request && dialog.open) select.disabled = !checked.selectable; }).catch(() => {});
    const newName = dialog.querySelector('[name=path-new-name]'); newName.parentElement.hidden = !purpose.startsWith('save-');
    dialog.querySelector('.path-save').hidden = !purpose.startsWith('save-'); dialog.querySelector('.path-save').disabled = busy;
    dialog.querySelector('.path-scan').disabled = busy || Boolean(scanId);
  }
  async function browse(directory, offset = 0) {
    const currentRequest = ++request; busy = true; dialog.querySelector('.path-entries').setAttribute('aria-busy', 'true');
    for (const selector of ['.path-up', '.path-select-current', '.path-save', '.path-scan']) dialog.querySelector(selector).disabled = true;
    try { const data = await api('/api/paths/browse', { ...(directory ? { directory } : {}), purpose, offset }); if (currentRequest !== request || !dialog.open) return; listing = data; busy = false; dialog.querySelector('.path-error').hidden = true; renderListing(); }
    catch (error) { if (currentRequest === request && dialog.open) fail(error); }
    finally { if (currentRequest === request) { busy = false; dialog.querySelector('.path-entries').setAttribute('aria-busy', 'false'); } }
  }
  function renderKnown() {
    const root = dialog.querySelector('.path-known'); root.replaceChildren();
    const placeNames = { desktop: ['桌面', 'Desktop'], documents: ['文档', 'Documents'], downloads: ['下载', 'Downloads'], examples: ['自带示例', 'Examples'], cache: ['软件缓存', 'Source cache'] };
    for (const place of [...(known?.places ?? []), ...(listing?.roots ?? []).map(root => ({ path: root.path, label: root.name }))]) root.append(button(placeNames[place.id] ? say(...placeNames[place.id]) : place.label, () => void browse(place.path), 'button button-small button-quiet'));
    for (const recent of (known?.recents ?? []).filter(row => row.exists && row.purpose === purpose).slice(0, 6)) root.append(button(`${say('最近', 'Recent')}: ${recent.path}`, () => void choose(recent.path), 'button button-small button-quiet'));
    renderObjects(known?.objects ?? [], dialog.querySelector('.path-candidates'));
  }
  function renderObjects(objects, root) {
    objects = objects.filter(object => !purpose.startsWith('save-') && (['directory', 'file'].includes(purpose) || object.kind === purpose || purpose === 'source' && object.kind === 'source-index'));
    root.replaceChildren();
    if (!objects.length) return;
    root.append(el('h3', {}, say('发现的候选（尚未审阅）', 'Discovered candidates (not reviewed)')));
    for (const object of objects) root.append(el('div', { class: 'path-entry' }, [el('div', {}, [el('strong', {}, objectText(object)), el('p', { class: 'mono' }, object.path), ...(object.warnings ?? []).map(text => el('small', {}, text))]), button(say('使用此路径', 'Use this path'), () => void choose(object.path), 'button button-small')]));
  }
  async function scan() {
    if (!listing || busy || scanId) return;
    const epoch = request, selectedInput = target;
    const status = dialog.querySelector('.path-scan-status'); status.textContent = say('正在识别所选目录内的候选…', 'Identifying candidates within this folder…');
    dialog.querySelector('.path-scan').disabled = true;
    try { const data = await api('/api/paths/discover', { directory: listing.directory }); if (!dialog.open || target !== selectedInput || request !== epoch) return; scanId = data.operationId; dialog.querySelector('.path-scan-cancel').hidden = false; void pollScan(scanId); }
    catch (error) { if (dialog.open && target === selectedInput && request === epoch) { status.textContent = ''; fail(error); dialog.querySelector('.path-scan').disabled = false; } }
  }
  async function pollScan(id) {
    try {
      const { operation } = await api(`/api/operations/${encodeURIComponent(id)}`);
      if (!dialog.open || scanId !== id) return;
      if (operation.state === 'running') { scanTimer = setTimeout(() => void pollScan(id), 600); return; }
      if (operation.state === 'failed') throw new Error(operation.error?.message ?? say('识别失败', 'Discovery failed'));
      const result = operation.result ?? {}; renderObjects(result.objects ?? [], dialog.querySelector('.path-candidates'));
      dialog.querySelector('.path-scan-status').textContent = `${result.cancelled ? say('已取消；显示已找到的部分结果。', 'Cancelled; partial results are shown.') : result.partial ? say('达到扫描边界；显示部分结果。', 'Discovery limit reached; partial results are shown.') : say('识别完成。', 'Discovery complete.')} ${say('不会导入或运行模块。', 'No modules were imported or started.')}`;
    } catch (error) { if (dialog.open && scanId === id) fail(error); }
    // A terminal result has no next poll.
    if (dialog.open && scanId === id) finishScan();
  }
  function finishScan() { clearTimeout(scanTimer); scanTimer = null; scanId = null; dialog.querySelector('.path-scan').disabled = false; dialog.querySelector('.path-scan-cancel').hidden = true; }
  async function open(input, specifiedPurpose) {
    ensureDialog(); clearTimeout(scanTimer); const epoch = ++request; target = input; purpose = specifiedPurpose ?? pathPurpose(input) ?? 'directory'; listing = null; scanId = null; busy = true;
    const close = button('×', () => dialog.close(), 'icon-button'); close.setAttribute('aria-label', say('关闭路径选择', 'Close path picker'));
    const location = el('input', { name: 'path-location', 'aria-label': say('当前目录', 'Current directory'), spellcheck: 'false' });
    const locationForm = el('form', { onsubmit: event => { event.preventDefault(); void browse(location.value.trim()); } }, el('div', { class: 'path-control-row' }, [location, el('button', { type: 'submit', class: 'button' }, say('前往', 'Go'))]));
    const saveName = el('input', { name: 'path-new-name', spellcheck: 'false', autocomplete: 'off' });
    const scanButton = button(say('识别当前目录', 'Discover in this folder'), () => void scan(), 'button path-scan', true);
    const cancelScan = button(say('取消识别', 'Cancel discovery'), async () => { try { await api(`/api/operations/${encodeURIComponent(scanId)}/cancel`, {}); } catch (error) { fail(error); } }, 'button path-scan-cancel'); cancelScan.hidden = true;
    const select = button(say('选择当前目录', 'Select current folder'), () => void choose(listing.directory), 'button button-primary path-select-current', true);
    const save = button(say('使用新路径', 'Use new path'), () => { const name = saveName.value, windows = /^[a-z]:/i.test(listing.directory); if (!name.trim() || /[/\\]/.test(name) || name === '.' || name === '..' || /[\u0000-\u001f]/.test(name) || windows && (/[<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name))) { fail(new Error(say('请输入有效的单个文件或目录名称。', 'Enter a valid single file or folder name.'))); return; } const separator = windows ? '\\' : '/'; void choose(`${listing.directory.replace(/[/\\]$/, '')}${separator}${name}`); }, 'button button-primary path-save');
    dialog.replaceChildren(el('div', { class: 'dialog-heading' }, [el('h2', { id: 'path-picker-title' }, say('选择本机路径', 'Choose a local path')), close]),
      el('p', { class: 'field-help' }, say('仅列举和识别文件。候选仍须审阅；不会执行、导入或修改。扫描限于选定目录。', 'Lists and identifies files only. Candidates need review; nothing is run, imported or modified. Discovery is limited to the selected folder.')),
      locationForm, el('div', { class: 'path-known' }), el('div', { class: 'path-control-row' }, [button(say('上级目录', 'Parent folder'), () => void browse(listing.parent), 'button button-quiet path-up'), scanButton, cancelScan]),
      el('div', { class: 'path-error notice notice-error', role: 'alert', hidden: true }), el('div', { class: 'path-entries', 'aria-busy': 'false' }), el('div', { class: 'path-scan-status', role: 'status' }), el('div', { class: 'path-candidates' }),
      el('label', {}, [el('span', {}, say('新的名称（目标必须尚不存在）', 'New name (output must not exist)')), saveName]), el('div', { class: 'dialog-footer' }, [button(say('取消', 'Cancel'), () => dialog.close(), 'button button-quiet'), select, save]));
    dialog.querySelector('.path-save').disabled = true; dialog.querySelector('.path-up').disabled = true;
    dialog.showModal();
    try { known = await api('/api/paths/known'); if (!dialog.open || target !== input || request !== epoch) return; } catch { known = null; }
    const value = input.value.trim(); let start;
    if (value && !/^https?:/i.test(value)) try { const check = await api('/api/paths/check', { path: value, purpose }); start = check.kind === 'directory' ? check.path : check.parent; if (purpose.startsWith('save-') && check.parent) saveName.value = value.split(/[/\\]/).at(-1); } catch {}
    if (!dialog.open || target !== input || request !== epoch) return;
    await browse(start); renderKnown();
  }
  function enhance(root = document) {
    for (const input of root.querySelectorAll('input[name]')) {
      if (input.dataset.pathEnhanced || input.closest?.('#path-picker-dialog')) continue;
      const kind = pathPurpose(input); if (!kind || input.type === 'checkbox' || input.type === 'number') continue;
      input.dataset.pathEnhanced = 'true';
      input.dataset.pathPurpose = kind;
      if (!input.getAttribute('aria-label') && !input.getAttribute('aria-labelledby')) input.setAttribute('aria-label', input.closest('label')?.textContent.trim() || input.name);
      const wrapper = el('div', { class: 'path-control' }), row = el('div', { class: 'path-control-row' }), select = button(say('选择…', 'Browse…'), () => void open(input), 'button button-quiet');
      const result = el('small', { class: 'path-check field-help', role: 'status' });
      input.parentElement.insertBefore(wrapper, input); row.append(input, select); wrapper.append(row, result);
      controls.add({ input, select, title: input.closest('label')?.querySelector('span') });
      let timer, sequence = 0;
      const check = () => { clearTimeout(timer); const stamp = ++sequence, value = input.value.trim(); result.textContent = ''; if (!value || /^https?:/i.test(value) || !state.auth?.token) return;
        timer = setTimeout(async () => { try { const data = await api('/api/paths/check', { path: value, purpose: pathPurpose(input) }); if (stamp !== sequence || !input.isConnected) return; result.textContent = data.selectable ? data.object ? `${objectText(data.object)} · ${say('尚未审阅', 'Not reviewed')}` : say('路径可用', 'Path available') : data.exists ? say('路径类型不匹配或输出目标已存在', 'Path type does not match, or output already exists') : say('路径不存在或父目录不可用', 'Path is missing or parent folder unavailable'); } catch (error) { if (stamp === sequence) result.textContent = error.message; } }, 650);
      };
      checks.set(input, check); input.addEventListener('input', check); input.addEventListener('change', check);
    }
    for (const row of controls) if (!row.input.isConnected) controls.delete(row);
  }
  const observer = new MutationObserver(() => enhance()); observer.observe(document.body, { childList: true, subtree: true }); enhance();
  return { open, enhance, languageChanged() { for (const { input, select, title } of controls) { select.textContent = say('选择…', 'Browse…'); if (title && !input.hasAttribute('aria-labelledby')) input.setAttribute('aria-label', title.textContent.trim()); } }, sessionReady() { enhance(); for (const { input } of controls) if (input.offsetParent !== null) checks.get(input)?.(); }, dispose() { observer.disconnect(); clearTimeout(scanTimer); } };
}
