import { ManualBridge } from './manual-bridge.mjs';
import { AnnotationDrafts, LatestRead, boundedJson, matchesLog, reconcileRows } from './manual-experience-state.mjs';

// This page is one ordinary external mod. Management permission does not lend
// it another program's transport identity, subscription or release permission.
const MAX_LOG_ITEMS = 160;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_DELIVERY_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const tabs = [['message', '发送信息', '01'], ['subscription', '订阅与抽取', '02'], ['channel', '通道声明', '03'], ['attachment', '大体积附件', '04'], ['raw', '原始帧', '05'], ['management', '接入管理', '06']];
const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M7 4l-3 3 3 3m13 7H4m13-3 3 3-3 3"/></svg>';
const dialog = document.createElement('dialog');
dialog.id = 'manual-console';
dialog.className = 'mc-dialog';
dialog.setAttribute('aria-labelledby', 'mc-title');
dialog.innerHTML = `
  <div class="mc-shell">
    <header class="mc-header"><div class="mc-title-icon">${icon}</div><div><p class="mc-eyebrow">WORLD HUB · MANUAL MOD</p><h2 id="mc-title">手动通讯工作台</h2></div><span id="mc-status" class="mc-badge">未连接</span><button type="button" class="mc-close" id="mc-close" aria-label="关闭工作台" title="关闭工作台；已连接的桥继续在后台通讯">×</button></header>
    <div class="mc-scroll">
      <section class="mc-connection" aria-label="自己的 mod 连接">
        <div class="mc-section-heading"><div><h3>以自己的 mod 接入</h3><p>通过当前枢纽通讯。管理画布仍能看到这条桥的真实信息流。</p></div><button id="mc-disconnect" type="button" class="mc-button mc-subtle" disabled>断开连接</button></div>
        <form id="mc-connect-form" class="mc-connect-grid">
          <label class="mc-url">当前枢纽地址<input id="mc-url" readonly aria-readonly="true" placeholder="正在读取通讯地址…"></label>
          <label>桥标识 bridge<input id="mc-bridge" required maxlength="64" pattern="[a-z0-9][a-z0-9._\\-]{0,63}" title="1–64 个字符，以小写字母或数字开头；其后可用小写字母、数字、点、下划线和连字符" autocomplete="off" placeholder="你配置的桥标识"></label>
          <label>凭据标识 credential · 可选<input id="mc-credential" maxlength="64" pattern="[a-z0-9][a-z0-9._\\-]{0,63}" title="可留空；填写时须为 1–64 个字符，以小写字母或数字开头；其后可用小写字母、数字、点、下划线和连字符" autocomplete="off" placeholder="凭据模式时填写"></label>
          <label>认证 token · 可选<input id="mc-token" type="password" autocomplete="new-password" placeholder="仅用于这次连接"></label>
          <button id="mc-connect" class="mc-button mc-primary" type="submit">连接自己的 mod</button>
        </form>
        <p class="mc-note">token 只用于本次握手，不保存；连接尝试结束后清空输入。无 token 接入将如实标为未认证。同名单身份连接会接管旧连接，桥标识请使用你自己的配置。</p>
        <dl id="mc-identity" class="mc-identity"><div><dt>稳定身份 principal</dt><dd>—</dd></div><div><dt>本次 session</dt><dd>—</dd></div><div><dt>认证 / 水位</dt><dd>—</dd></div><div><dt>协商能力 features</dt><dd>—</dd></div></dl>
        <p id="mc-identity-status" class="mc-note mc-state-note">尚无连接身份。</p>
        <details class="mc-limits"><summary id="mc-limits-title">查看当前连接的通讯限制</summary><pre id="mc-limits">连接后显示 welcome.limits 与 blobLimits。</pre></details>
      </section>
      <div id="mc-notice" class="mc-notice" role="status" aria-live="polite">填写你自己的桥身份，然后连接。关闭工作台不会断开桥。</div>
      <div class="mc-workspace">
        <section class="mc-operation-area" aria-label="手动通讯操作"><nav class="mc-tabs" role="tablist" aria-label="通讯功能">${tabs.map(([key, label, number], index) => `<button type="button" role="tab" id="mc-tab-${key}" aria-controls="mc-panel-${key}" aria-selected="${index === 0}" tabindex="${index === 0 ? '0' : '-1'}" data-tab="${key}"><span>${number}</span>${label}</button>`).join('')}</nav>
          <div class="mc-panel" id="mc-panel-message" role="tabpanel" aria-labelledby="mc-tab-message">
            <div class="mc-panel-heading"><h3>发送任意主题的信息</h3><p>正文由程序约定；枢纽只处理通讯、寻址与留存。</p></div>
            <form id="mc-message-form" class="mc-form">
              <label>通讯动作<select id="mc-operation"><option value="publish">发布 · 供订阅者抽取</option><option value="request">请求 · 请求对方提供信息</option><option value="inject">注入 · 向对方发送信息</option><option value="respond">回应 · 回应已接纳的请求</option></select></label>
              <div id="mc-target-fields" class="mc-grid-two" hidden><label>目标 principal<input id="mc-target-principal" autocomplete="off" placeholder="受信配置中的稳定身份"></label><label>目标 session · 可选<input id="mc-target-session" autocomplete="off" placeholder="留空：该身份下匹配的实例"></label></div>
              <label id="mc-topic-field">主题 topic<input id="mc-topic" required autocomplete="off" placeholder="填写双方约定的具体主题，不含 + / #"></label>
              <label id="mc-request-field" hidden>原请求序号 requestSeq<input id="mc-request-seq" type="number" min="1" step="1" placeholder="这条桥有权回应的请求序号"></label>
              <label>JSON 对象正文 · 原文发送<textarea id="mc-body" rows="7" spellcheck="false" required>{}</textarea></label>
              <p class="mc-note">数值写法、转义与内部空白按原文传递。发送请求前自行建立原主题的回应订阅；回应被枢纽接纳，不等于请求方已收到。</p>
              <details class="mc-extra"><summary>关联标识与附件 · 可选</summary><div class="mc-grid-two"><label>id<input id="mc-message-id" maxlength="512" autocomplete="off"></label><label>correlation<input id="mc-correlation" maxlength="512" autocomplete="off"></label><label>replyTo<input id="mc-reply-to" maxlength="512" autocomplete="off"></label></div><label>附件对象 id 数组 · JSON<textarea id="mc-message-attachments" rows="3" spellcheck="false" placeholder='["对象 UUID"]'></textarea></label><p class="mc-note">发送 id 字符串数组；枢纽校验后生成可信描述符。只能引用当前提供者已提交且未释放的附件；正文中写 id 不会授予读取权。</p></details>
              <button type="submit" class="mc-button mc-primary" data-needs-connection>发送并等待枢纽接纳</button>
            </form>
            <div class="mc-rule"></div><form id="mc-release-form" class="mc-form"><h4>提供者手动释放消息留存</h4><label>自己的消息序号 · 逗号或空白分隔<input id="mc-release-seqs" placeholder="1, 2, 3" required></label><p class="mc-note">仅你自己的稳定身份可释放。released 只是允许以后回收，消息不会立即删除；抽取、ACK 和回应都不会替你释放。</p><button type="submit" class="mc-button mc-warning" data-needs-connection>允许回收自己的消息</button></form>
          </div>
          <div class="mc-panel" id="mc-panel-subscription" role="tabpanel" aria-labelledby="mc-tab-subscription" hidden>
            <div class="mc-panel-heading"><h3>订阅，也可抽取历史</h3><p>每条订阅有独立回执、投递与确认游标。</p></div>
            <form id="mc-subscribe-form" class="mc-form"><label>主题过滤器 · 每行一个<textarea id="mc-filters" rows="3" required spellcheck="false" placeholder="填写约定的主题或过滤器"></textarea></label><div class="mc-grid-two"><label>开始位置 from<select id="mc-from-mode"><option value="now">订阅处理时的当前水位之后</option><option value="number">指定序号之后 · 历史抽取</option></select></label><label id="mc-from-number-field" hidden>非负安全整数序号<input id="mc-from-number" type="number" min="0" step="1" value="0"></label></div><fieldset class="mc-fieldset"><legend>通讯动作过滤 · 不勾选则不限</legend><div class="mc-checks">${['publish', 'request', 'inject', 'response'].map(value => `<label><input type="checkbox" name="mc-op-filter" value="${value}">${value}</label>`).join('')}</div></fieldset><button type="submit" class="mc-button mc-primary" data-needs-connection>建立订阅 / 抽取</button></form>
            <div class="mc-rule"></div><h4 id="mc-subscriptions-title">本次连接的订阅</h4><p class="mc-note">subscribed 是订阅建立回执；caught_up.through 是扫描水位，cursor 是确认位置。两者都不证明业务完成。未 ACK 时历史扫描可能等待窗口腾出。</p><div id="mc-subscriptions" class="mc-subscription-list"><p class="mc-empty">尚未建立订阅。</p></div>
            <form id="mc-ack-form" class="mc-form mc-compact"><label>subscription<input id="mc-ack-subscription" required autocomplete="off" placeholder="点击下方收到的信息可填入"></label><label>已实际收到的 seq · 逗号或空白分隔<input id="mc-ack-seqs" required></label><p class="mc-note">ACK 只发送确认，不自动处理业务、不释放留存。有效 ACK 无成功回执；协议错误会显示在记录中。</p><button type="submit" class="mc-button" data-needs-connection>手动发送 ACK</button></form>
            <h4 class="mc-delivery-heading">收到的信息 <span id="mc-delivery-count">0</span></h4><div id="mc-deliveries" class="mc-delivery-list"><p class="mc-empty">收到 delivery 后在这里显示。每条订阅分别确认。</p></div>
          </div>
          <div class="mc-panel" id="mc-panel-channel" role="tabpanel" aria-labelledby="mc-tab-channel" hidden>
            <div class="mc-panel-heading"><h3>声明 mod 的任意通道</h3><p>声明通讯接口方向；不创建订阅或业务处理器。</p></div><form id="mc-register-form" class="mc-form"><label>通道名称或订阅过滤器<input id="mc-channel-name" required autocomplete="off" placeholder="你约定的主题 / 过滤器"></label><fieldset class="mc-fieldset"><legend>方向 · 至少一个</legend><div class="mc-checks"><label><input id="mc-channel-publish" type="checkbox">声明发布方向</label><label><input id="mc-channel-subscribe" type="checkbox">声明订阅方向</label></div></fieldset><p class="mc-note">发布方向必须是具体主题。注册不会扩大现有 ACL；同名声明合并方向，通道名称不内置枚举。</p><button type="submit" class="mc-button mc-primary" data-needs-connection>注册通道</button></form><h4 class="mc-delivery-heading">枢纽确认的声明</h4><pre id="mc-channels" class="mc-json-view">尚未收到 registered。</pre>
          </div>
          <div class="mc-panel" id="mc-panel-attachment" role="tabpanel" aria-labelledby="mc-tab-attachment" hidden>
            <div class="mc-panel-heading"><h3>大体积附件</h3><p>有界分块、接纳进度和 SHA-256 校验。对象与消息各自释放。</p></div><form id="mc-upload-form" class="mc-form"><label>选择本地文件<input id="mc-upload-file" type="file" required></label><div class="mc-button-row"><button type="submit" class="mc-button mc-primary" data-needs-connection>分块上传并提交</button><button id="mc-blob-cancel" type="button" class="mc-button mc-subtle" disabled>取消当前传输</button></div></form><div class="mc-progress-box"><progress id="mc-blob-progress" value="0" max="1"></progress><p id="mc-blob-progress-text" role="status" aria-live="polite">尚未开始传输。</p></div><pre id="mc-blob-descriptor" class="mc-json-view">上传成功后显示可信附件描述符。</pre><button id="mc-use-attachment" type="button" class="mc-button mc-subtle" disabled>将描述符加入待发送信息</button><p class="mc-note">上传完成不等于已发布。取消或发布失败后不自动释放对象；你可查询状态、继续使用或显式释放。</p>
            <div class="mc-rule"></div><form id="mc-download-form" class="mc-form"><h4>读取并校验附件</h4><label>对象 id<input id="mc-download-id" required autocomplete="off"></label><div class="mc-grid-two"><label>引用消息 messageSeq · 非提供者必填<input id="mc-download-seq" type="number" min="1" step="1"></label><label>字节数 size<input id="mc-download-size" type="number" min="0" step="1" required></label></div><label>SHA-256<input id="mc-download-sha" required pattern="[a-fA-F0-9]{64}" maxlength="64" spellcheck="false"></label><label>保存文件名<input id="mc-download-name" value="hub-attachment.bin" autocomplete="off"></label><button type="submit" class="mc-button mc-primary" data-needs-connection>下载、校验后保存</button><p class="mc-note">只有长度和 SHA-256 都匹配才提供保存。本浏览器桥上传 / 下载每对象最多 64 MiB，以本地有界内存处理；枢纽限制另看 welcome，超限可用外部程序的文件桥。</p></form>
            <div class="mc-rule"></div><form id="mc-blob-state-form" class="mc-form"><h4>自己的对象状态 / 释放</h4><label>对象 id<input id="mc-own-blob-id" required autocomplete="off"></label><div class="mc-button-row"><button type="submit" class="mc-button" data-needs-connection>查询 blob_status</button><button id="mc-blob-release" type="button" class="mc-button mc-warning" data-needs-connection>允许回收自己的对象</button></div><p class="mc-note">blob_release 不释放引用它的消息；只有提供者有权操作自己的对象。</p></form>
          </div>
          <div class="mc-panel" id="mc-panel-raw" role="tabpanel" aria-labelledby="mc-tab-raw" hidden>
            <div class="mc-panel-heading"><h3>高级：原始通讯帧</h3><p>按当前线协议发送完整 JSON 帧，适用于已知通讯操作。</p></div><form id="mc-raw-form" class="mc-form"><label>原始 JSON 帧<textarea id="mc-raw-frame" rows="12" spellcheck="false" required placeholder='{"type":"…"}'></textarea></label><p class="mc-note">此处只报告已发送到套接字；观察收帧才能判断枢纽是否接纳。hello 请用上方连接区，避免 token 进入记录。不会自动 ACK、释放或重连。</p><button type="submit" class="mc-button mc-primary" data-needs-connection>发送原始帧</button></form>
          </div>
          <div class="mc-panel" id="mc-panel-management" role="tabpanel" aria-labelledby="mc-tab-management" hidden>
            <div class="mc-panel-heading"><h3>管理真实接入与程序注记</h3><p>本机管理操作与上方自己的 mod 通讯相互独立。</p></div>
            <div class="mc-management-toolbar"><label>通讯主体<select id="mc-managed-key"></select></label><button id="mc-management-refresh" type="button" class="mc-button mc-subtle">刷新状态</button></div>
            <p id="mc-management-status" class="mc-note mc-state-note" role="status" aria-live="polite">尚未读取管理状态。</p>
            <p id="mc-managed-summary" class="mc-note"></p><div class="mc-button-row mc-management-actions"><button id="mc-managed-pause" type="button" class="mc-button mc-warning">暂停主体通讯</button><button id="mc-managed-resume" type="button" class="mc-button">恢复主体通讯</button></div>
            <p class="mc-note">暂停 / 恢复作用于该主体的所有实例，不替程序 ACK 或释放。单实例断开只关闭所选连接，程序可按自己的策略再次接入。</p>
            <h4 class="mc-delivery-heading">当前连接实例与订阅诊断</h4><div id="mc-managed-instances" class="mc-managed-instances"><p class="mc-empty">刷新后显示真实连接。</p></div>
            <div class="mc-rule"></div><form id="mc-annotation-form" class="mc-form"><h4>编辑画布注记</h4><label>桥显示名称 · 可留空<input id="mc-annotation-name" maxlength="120" autocomplete="off"></label><div class="mc-card-heading"><label>关联的程序 · 最多 16 项</label><button id="mc-annotation-add" type="button" class="mc-icon-button">＋ 添加程序注记</button></div><div id="mc-annotation-rows" class="mc-annotation-rows"></div><p class="mc-note">id 和名称都是运维注记，均不超过 120 字符；id 不重复。程序注记可以一对多，不作为寻址、来源证明或权限，保存完整列表会替换原注记。</p><p id="mc-annotation-dirty" class="mc-note" role="status">草稿仅在当前页面内存保留，最多 64 个主体；刷新页面后清空。</p><div class="mc-button-row"><button id="mc-annotation-save" type="submit" class="mc-button mc-primary">保存完整注记</button><button id="mc-annotation-discard" type="button" class="mc-button mc-subtle">丢弃此主体草稿</button></div></form><div class="mc-rule"></div><button id="mc-open-capacity" type="button" class="mc-button mc-subtle">查看枢纽留存与容量</button>
          </div>
        </section>
        <aside class="mc-log-area" aria-label="真实收发记录"><div class="mc-log-heading"><div><h3>收发记录</h3><p id="mc-log-meter">0 条 · 0 B</p></div><div class="mc-button-row"><button id="mc-export" type="button" class="mc-icon-button" title="导出全部当前保留记录，不受筛选影响">导出</button><button id="mc-clear" type="button" class="mc-icon-button" title="清空当前记录">清空</button></div></div><div class="mc-log-legend"><span><i class="mc-dot mc-dot-send"></i>本地发送</span><span><i class="mc-dot mc-dot-receive"></i>真实收帧</span><span>只保留最近 160 条 / 2 MiB</span></div><div class="mc-log-filter"><label>方向<select id="mc-log-direction"><option value="all">全部</option><option value="send">本地发送</option><option value="receive">真实收帧</option><option value="note">本地记录</option></select></label><label>筛选帧文本<input id="mc-log-query" type="search" maxlength="512" autocomplete="off" placeholder="类型 / 主题 / 原文"></label></div><div id="mc-log" class="mc-log"><p class="mc-empty">连接后记录真实通讯帧。正文安全作为文本显示。</p></div><p class="mc-log-footer">已发送 ≠ 枢纽接纳 ≠ 对方业务完成。筛选只改变本地显示；导出包含全部保留记录。记录仅在当前页面内存中保留，刷新后清空。</p></aside>
      </div>
    </div>
  </div>`;
document.body.append(dialog);

const $ = id => dialog.querySelector(`#mc-${id}`);
const textValue = id => $(id).value.trim();
const notice = (message, error = false) => { $('notice').textContent = message; $('notice').classList.toggle('mc-notice-error', error); };
const errorLabels = { NOT_CONNECTED: '请先连接自己的 mod', FEATURE_UNSUPPORTED: '当前枢纽未协商这项能力', TIMEOUT: '本地等待已超时；操作可能已被枢纽接纳，请查阅收发记录，不自动重发', ABORTED: '本地传输已取消；枢纽中的对象或消息未自动释放', SOCKET_ERROR: '套接字连接失败，请检查地址和浏览器安全限制', DISCONNECTED: '桥已断开，不会自动重连', MANAGEMENT_STATE_STALE: '管理状态已过期，请先手动刷新并核对' };
const safeError = error => `${error?.code ? `${error.code} · ` : ''}${errorLabels[error?.code] ? `${errorLabels[error.code]}。` : ''}${error?.message ?? String(error)}`;
const positiveSequence = (value, zero = false) => { const number = Number(value); if (!String(value).trim() || !Number.isSafeInteger(number) || number < (zero ? 0 : 1)) throw new Error(`需要${zero ? '非负' : '正'}安全整数序号`); return number; };
const sequences = value => { const list = value.trim().split(/[,，\s]+/).filter(Boolean).map(item => positiveSequence(item)); if (!list.length || list.length > 128) throw new Error('请填写 1–128 个序号'); return [...new Set(list)]; };
const jsonObject = raw => { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('正文需要 JSON 对象'); return value; };
const bytesLabel = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;
const format = value => JSON.stringify(value, null, 2);
let transportUrl = '';
let logItems = [], logBytes = 0, discarded = 0;
let deliveries = [], deliveryBytes = 0, subscriptions = new Map(), latestDescriptor = null, transferAbort = null;
let managementState = null, managementFresh = false, managementMutation = false, annotationKey = null, annotationBase = null, lastWelcome = null;
let localId = 0;
const drafts = new AnnotationDrafts(64), managementReads = new LatestRead();
const logRows = new Map(), deliveryRows = new Map(), managedRows = new Map();
let managedRowsKey = null;
const logEmpty = document.createElement('p'), deliveryEmpty = document.createElement('p'), managedEmpty = document.createElement('p');
logEmpty.className = deliveryEmpty.className = managedEmpty.className = 'mc-empty';
logEmpty.textContent = '没有匹配的保留记录。'; deliveryEmpty.textContent = '当前投递列表为空。';
managedEmpty.textContent = '该主体当前没有在线连接。';
$('log').replaceChildren(logEmpty); $('deliveries').replaceChildren(deliveryEmpty);
$('managed-instances').replaceChildren(managedEmpty);
let restoringFocus = null, connecting = false;
const busyButtons = new Set();

function selectTab(name, focus = false) {
  for (const [key] of tabs) {
    const active = key === name, tab = $(`tab-${key}`);
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    $(`panel-${key}`).hidden = !active;
    if (active && focus) tab.focus();
  }
}
function updateControls() {
  dialog.querySelectorAll('[data-needs-connection]').forEach(button => { button.disabled = !bridge.connected; });
  $('disconnect').disabled = !bridge.connected && !connecting;
  $('connect').disabled = connecting || bridge.connected || !transportUrl;
  for (const id of ['bridge', 'credential', 'token']) $(id).disabled = connecting || bridge.connected;
  const hasDirected = bridge.welcome?.features?.includes('directed-v1');
  for (const option of $('operation').options) if (option.value !== 'publish') option.disabled = !hasDirected;
  $('use-attachment').disabled = !latestDescriptor;
  const entry = managedEntry();
  $('management-refresh').disabled = managementMutation;
  $('managed-pause').disabled = !managementFresh || !entry?.manageable || entry.paused;
  $('managed-resume').disabled = !managementFresh || !entry?.manageable || !entry.paused;
  $('annotation-save').disabled = !managementFresh || !entry;
  $('annotation-discard').disabled = managementMutation || !entry || (!drafts.get(entry.key) && JSON.stringify(annotationValue()) === JSON.stringify(annotationBase));
  dialog.querySelectorAll('[data-management-action]').forEach(button => { button.disabled = !managementFresh || !button.dataset.connectionId; });
  for (const button of busyButtons) button.disabled = true;
}
function addLog(direction, raw, frame = null) {
  const source = String(raw), size = encoder.encode(source).byteLength;
  const item = { localId: ++localId, at: new Date().toISOString(), direction, type: frame?.type ?? 'local', raw: source, bytes: size };
  if (size > MAX_LOG_BYTES) { item.raw = `${source.slice(0, 1200)}\n…本帧超过记录空间，仅显示开头。通讯本身未截断。`; item.bytes = encoder.encode(item.raw).byteLength; item.truncated = true; }
  logItems.push(item); logBytes += item.bytes;
  while (logItems.length > MAX_LOG_ITEMS || logBytes > MAX_LOG_BYTES) { const first = logItems.shift(); logBytes -= first.bytes; discarded++; }
  renderLog();
}
function renderLog() {
  const count = reconcileRows({ container: $('log'), cache: logRows, entries: logItems, empty: logEmpty, focusFallback: $('log-query'), followBottom: true,
    visible: item => matchesLog(item, $('log-direction').value, $('log-query').value), create(item) {
    const row = document.createElement('details'); row.className = `mc-log-item mc-log-${item.direction}`;
    const summary = document.createElement('summary');
    const badge = document.createElement('span'); badge.className = 'mc-log-direction'; badge.textContent = item.direction === 'send' ? '发' : item.direction === 'receive' ? '收' : '记';
    const title = document.createElement('strong'); title.textContent = item.type;
    const time = document.createElement('time'); time.textContent = new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false }); time.dateTime = item.at;
    summary.append(badge, title, time);
    const pre = document.createElement('pre'); pre.textContent = item.raw;
    row.append(summary, pre); return row;
  } });
  $('log-meter').textContent = `${count} / ${logItems.length} 条 · ${bytesLabel(logBytes)}${discarded ? ` · 已轮出 ${discarded} 条` : ''}`;
}
function renderSubscriptions() {
  const container = $('subscriptions'); container.replaceChildren();
  if (!subscriptions.size) { const empty = document.createElement('p'); empty.className = 'mc-empty'; empty.textContent = '本次连接尚未建立订阅。'; container.append(empty); }
  for (const [id, entry] of subscriptions) {
    const card = document.createElement('article'); card.className = 'mc-subscription-card';
    const header = document.createElement('div'); header.className = 'mc-card-heading';
    const title = document.createElement('strong'); title.textContent = id;
    const buttons = document.createElement('div'); buttons.className = 'mc-button-row';
    const fill = document.createElement('button'); fill.type = 'button'; fill.className = 'mc-icon-button'; fill.textContent = '填入 ACK'; fill.disabled = !bridge.connected; fill.onclick = () => { if (!bridge.connected) return; $('ack-subscription').value = id; $('ack-seqs').focus(); };
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'mc-icon-button'; cancel.textContent = '取消订阅'; cancel.disabled = !bridge.connected; cancel.onclick = () => perform(cancel, async () => { const receipt = await bridge.unsubscribe(id); addLog('note', format(receipt)); subscriptions.delete(id); renderSubscriptions(); notice(`订阅 ${id} 已取消；留存消息不释放。`); });
    buttons.append(fill, cancel); header.append(title, buttons);
    const detail = document.createElement('p'); detail.className = 'mc-note'; detail.textContent = `${bridge.connected ? '' : '上次连接 · 已失效 · '}${entry.filters?.join(' · ') ?? ''} · 最近回执 cursor ${entry.cursor ?? '—'} · ${entry.barrier ? `${entry.barrier.type} through ${entry.barrier.through ?? '—'}` : '等待历史扫描水位'}`;
    card.append(header, detail);
    if (entry.barrier?.type === 'catchup_truncated') {
      const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'mc-button mc-warning'; resume.textContent = '接受已报告的历史缺口并继续'; resume.disabled = !bridge.connected;
      resume.onclick = () => perform(resume, async () => { bridge.resume(id); notice('已发送 resume；观察后续历史投递和水位。'); }); card.append(resume);
    }
    container.append(card);
  }
}
function renderDeliveries() {
  $('delivery-count').textContent = String(deliveries.length);
  reconcileRows({ container: $('deliveries'), cache: deliveryRows, entries: [...deliveries].reverse(), empty: deliveryEmpty, focusFallback: $('ack-subscription'), prepend: true,
    update(card, entry) { const current = bridge.connected && entry.generation === bridge.generation;
      card.querySelector('.mc-note').textContent = `${current ? '本次连接' : '上次连接 · 已失效'} · ${entry.frame.subscription} · 来源 ${entry.frame.fromPrincipal ?? entry.frame.from ?? '—'} · ${entry.frame.operation ?? 'publish'}`;
      card.querySelector('button').disabled = !current;
    }, create(entry) {
    const card = document.createElement('article'); card.className = 'mc-delivery-card';
    const title = document.createElement('strong'); title.textContent = `#${entry.frame.seq} · ${entry.frame.topic ?? ''}`;
    const meta = document.createElement('p'); meta.className = 'mc-note'; meta.textContent = `${entry.frame.subscription} · 来源 ${entry.frame.fromPrincipal ?? entry.frame.from ?? '—'} · ${entry.frame.operation ?? 'publish'}`;
    const raw = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '查看接收原始帧'; const pre = document.createElement('pre'); pre.textContent = entry.raw; raw.append(summary, pre);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'mc-button mc-subtle'; button.textContent = '填入这条订阅与序号'; button.onclick = () => { if (!bridge.connected || entry.generation !== bridge.generation) return; $('ack-subscription').value = entry.frame.subscription; $('ack-seqs').value = String(entry.frame.seq); $('ack-seqs').focus(); };
    card.append(title, meta, raw, button); return card;
  } });
}
function receive(raw, frame) {
  addLog('receive', raw, frame);
  if (frame?.type === 'subscribed') { subscriptions.set(frame.subscription, { ...frame }); renderSubscriptions(); notice(`订阅 ${frame.subscription} 已建立；等待历史扫描水位。`); }
  if (['caught_up', 'catchup_truncated'].includes(frame?.type)) { const entry = subscriptions.get(frame.subscription); if (entry) { entry.barrier = frame; entry.cursor = frame.cursor; renderSubscriptions(); } }
  if (frame?.type === 'unsubscribed') { subscriptions.delete(frame.subscription); renderSubscriptions(); }
  if (frame?.type === 'registered') $('channels').textContent = format(frame.channels);
  if (frame?.type === 'delivery') {
    let retainedRaw = raw;
    if (encoder.encode(retainedRaw).byteLength > MAX_DELIVERY_BYTES) retainedRaw = `${String(raw).slice(0, 1200)}\n…此帧超出投递列表空间，只显示开头；通讯原文未截断。`;
    const metadata = Object.fromEntries(['seq', 'topic', 'subscription', 'fromPrincipal', 'from', 'operation'].filter(key => frame[key] !== undefined).map(key => [key, frame[key]]));
    const size = encoder.encode(retainedRaw).byteLength; deliveries.push({ localId: ++localId, generation: bridge.generation, raw: retainedRaw, frame: metadata, bytes: size }); deliveryBytes += size;
    while (deliveries.length > 40 || deliveryBytes > MAX_DELIVERY_BYTES) deliveryBytes -= deliveries.shift().bytes;
    renderDeliveries();
  }
  if (['error', 'denied', 'overflow'].includes(frame?.type)) notice(`${frame.code ?? frame.type} · ${frame.message ?? frame.reason ?? '查看真实收帧诊断。'}`, true);
}
const bridge = new ManualBridge({ onFrame: receive, onSend(raw, frame) { addLog('send', raw, frame); }, onState(state) {
  const labels = { connecting: '连接中', connected: '已连接', closed: '已断开', error: '连接错误' };
  $('status').textContent = labels[state.status] ?? state.status; $('status').dataset.state = state.status;
  const launcher = document.querySelector('#btn-manual-console');
  if (launcher) {
    launcher.textContent = state.status === 'connected' ? '↗ 通讯工作台 · 已连接' : state.status === 'connecting' ? '↗ 通讯工作台 · 连接中' : '↗ 通讯工作台';
    launcher.title = state.status === 'connected' ? '工作台自己的 mod 仍在后台连接；打开后可手动断开' : '用界面自己的 mod 手动操作通讯';
  }
  connecting = state.status === 'connecting';
  if (state.status === 'connected') {
    const welcome = state.welcome ?? bridge.welcome;
    lastWelcome = welcome;
    const values = [welcome.principal ?? welcome.bridge, welcome.session ?? '—', `${welcome.authenticated ? '已认证' : '未认证'} / lastSeq ${welcome.lastSeq}`, welcome.features?.join(' · ') || '基础通讯'];
    $('identity').querySelectorAll('dd').forEach((dd, index) => { dd.textContent = values[index]; });
    $('limits').textContent = format({ limits: welcome.limits, blobLimits: welcome.blobLimits, localBrowser: { maxFrameBytes: 4 * 1024 * 1024, maxBlobBytes: 64 * 1024 * 1024 } });
    notice('连接已建立。使用左侧功能手动通讯；不会自动 ACK、释放或重连。');
  }
  if (state.status === 'error') { notice(safeError(state), true); addLog('note', safeError(state), { type: '连接错误' }); }
  if (state.status === 'closed') { transferAbort?.abort(); notice(state.message ? `连接已关闭：${state.message}` : '连接已关闭；已接纳消息仍按提供者策略留存。'); }
  $('identity-status').textContent = bridge.connected ? '当前连接身份与握手水位。' : lastWelcome ? '上次连接的身份与握手水位 · 当前未连接；不能用于当前操作。' : '尚无已建立的连接身份。';
  $('identity').dataset.historical = String(!bridge.connected && Boolean(lastWelcome));
  $('identity').querySelectorAll('dt')[1].textContent = bridge.connected ? '本次 session' : '上次 session';
  $('limits-title').textContent = bridge.connected ? '查看当前连接的通讯限制' : lastWelcome ? '查看上次连接的通讯限制 · 当前未连接' : '连接后查看通讯限制';
  $('subscriptions-title').textContent = bridge.connected ? '本次连接的订阅' : '上次连接的订阅 · 当前已失效';
  updateControls(); renderSubscriptions(); renderDeliveries();
} });
async function perform(button, callback) {
  if (button?.disabled) return;
  if (button) { busyButtons.add(button); button.disabled = true; }
  try { await callback(); } catch (error) { notice(safeError(error), true); addLog('note', safeError(error), { type: '本地错误' }); }
  finally { if (button) { busyButtons.delete(button); button.disabled = false; } updateControls(); }
}
function requireFeature(feature) { if (!bridge.welcome?.features?.includes(feature)) throw new Error(`当前枢纽未协商 ${feature} 能力`); }
async function command(type, fields, options = {}) {
  return bridge.command(type, fields, options);
}

for (const [name] of tabs) $(`tab-${name}`).onclick = () => selectTab(name);
dialog.querySelector('.mc-tabs').addEventListener('keydown', event => {
  const current = tabs.findIndex(([key]) => $(`tab-${key}`) === document.activeElement); if (current < 0) return;
  let next; if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % tabs.length;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current + tabs.length - 1) % tabs.length;
  if (event.key === 'Home') next = 0; if (event.key === 'End') next = tabs.length - 1;
  if (next !== undefined) { event.preventDefault(); selectTab(tabs[next][0], true); }
});
function updateMessageFields() {
  const operation = $('operation').value, directed = ['request', 'inject'].includes(operation), responding = operation === 'respond';
  $('target-fields').hidden = !directed; $('target-principal').required = directed;
  $('topic-field').hidden = responding; $('topic').required = !responding;
  $('request-field').hidden = !responding; $('request-seq').required = responding;
}
$('operation').onchange = updateMessageFields;
$('from-mode').onchange = () => { $('from-number-field').hidden = $('from-mode').value !== 'number'; };
$('connect-form').onsubmit = event => {
  event.preventDefault(); const button = $('connect');
  perform(button, async () => {
    const token = $('token').value;
    subscriptions.clear(); deliveries = []; deliveryBytes = 0; latestDescriptor = null; $('own-blob-id').value = ''; $('blob-descriptor').textContent = '上传成功后显示可信附件描述符。'; $('channels').textContent = '尚未收到 registered。'; $('blob-progress').value = 0; $('blob-progress-text').textContent = '尚未开始本次连接的传输。'; renderSubscriptions(); renderDeliveries();
    try { await bridge.connect({ url: transportUrl, bridge: textValue('bridge'), ...(textValue('credential') ? { credential: textValue('credential') } : {}), ...(token ? { token } : {}) }); }
    finally { $('token').value = ''; }
  });
};
$('disconnect').onclick = () => { transferAbort?.abort(); bridge.close(); };
$('message-form').onsubmit = event => {
  event.preventDefault(); perform(event.submitter, async () => {
    const type = $('operation').value; if (type !== 'publish') requireFeature('directed-v1');
    const fields = {}, bodyRaw = $('body').value; jsonObject(bodyRaw);
    if (type === 'respond') fields.requestSeq = positiveSequence(textValue('request-seq'));
    else fields.topic = textValue('topic');
    if (['request', 'inject'].includes(type)) fields.target = { principal: textValue('target-principal'), ...(textValue('target-session') ? { session: textValue('target-session') } : {}) };
    for (const [id, field] of [['message-id', 'id'], ['correlation', 'correlation'], ['reply-to', 'replyTo']]) if (textValue(id)) fields[field] = textValue(id);
    if (textValue('message-attachments')) { const attachments = JSON.parse(textValue('message-attachments')); if (!Array.isArray(attachments) || attachments.some(id => typeof id !== 'string')) throw new Error('附件需要对象 id 字符串的 JSON 数组'); if (attachments.length) { requireFeature('blob-v1'); fields.attachments = attachments; } }
    const receipt = await command(type, fields, { bodyRaw }); notice(`枢纽已接纳 ${type}：seq ${receipt.seq}。这不是对方业务完成回执。`);
  });
};
$('release-form').onsubmit = event => { event.preventDefault(); perform(event.submitter, async () => { const receipt = await command('release', { seq: sequences(textValue('release-seqs')) }); notice(`已获 released：${receipt.seq?.join(', ')}。允许之后回收，未立即删除。`); }); };
$('register-form').onsubmit = event => { event.preventDefault(); perform(event.submitter, async () => { const publish = $('channel-publish').checked, subscribe = $('channel-subscribe').checked; if (!publish && !subscribe) throw new Error('请至少选一个通道方向'); await command('register', { channels: [{ name: textValue('channel-name'), publish, subscribe }] }); notice('枢纽已确认通道声明。它不会自动建立订阅。'); }); };
$('subscribe-form').onsubmit = event => { event.preventDefault(); perform(event.submitter, async () => {
  const filters = $('filters').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean); if (!filters.length) throw new Error('至少填写一个主题过滤器');
  const operations = [...dialog.querySelectorAll('input[name="mc-op-filter"]:checked')].map(input => input.value);
  if (operations.length) requireFeature('directed-v1');
  const fields = { filters, from: $('from-mode').value === 'now' ? 'now' : positiveSequence(textValue('from-number'), true), delivery: 'bounded_ack', ...(operations.length ? { operations } : {}) };
  notice('订阅请求已发送；收到 subscribed 后即可检查并手动 ACK。');
  try {
    const receipt = await bridge.subscribe(fields); if (receipt.barrier) notice(`订阅 ${receipt.subscription}：${receipt.barrier.type}，扫描 through ${receipt.barrier.through ?? '—'}，确认 cursor ${receipt.barrier.cursor ?? '—'}。`);
  } catch (error) {
    if (error.code === 'TIMEOUT') error.message = `${error.message}。若已显示 subscribed，订阅继续保留；可手动 ACK、接受已报告的历史缺口或取消订阅，不会自动取消。`;
    throw error;
  }
}); };
$('ack-form').onsubmit = event => { event.preventDefault(); perform(event.submitter, async () => { const fields = { subscription: textValue('ack-subscription'), seq: sequences(textValue('ack-seqs')) }; bridge.ack(fields.subscription, fields.seq); notice('ACK 已发送到套接字；有效确认没有成功回执。未释放任何消息。'); }); };

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const managedEntry = () => managementState?.bridges?.find(entry => entry.key === $('managed-key').value);
function annotationValue() {
  return { bridgeName: $('annotation-name').value, programs: [...$('annotation-rows').children].map(row => Object.fromEntries([...row.querySelectorAll('input')].map(input => [input.dataset.field, input.value]))) };
}
function renderDraftStatus() {
  const dirty = annotationKey && drafts.get(annotationKey);
  $('annotation-dirty').textContent = dirty ? `未保存的本页草稿 · ${drafts.entries.size} / 64 个主体；切换主体仍保留。` : '草稿仅在当前页面内存保留，最多 64 个主体；刷新页面后清空。';
  $('annotation-dirty').classList.toggle('mc-dirty', Boolean(dirty));
  updateControls();
}
function captureAnnotation() {
  if (!annotationKey) return;
  const value = annotationValue();
  // A return to the old baseline while a save is pending is still a newer edit.
  // Preserve its version so the successful older save cannot remove that intent.
  if (drafts.get(annotationKey) || JSON.stringify(value) !== JSON.stringify(annotationBase)) drafts.edit(annotationKey, value);
  renderDraftStatus();
}
function editAnnotation() {
  try { captureAnnotation(); } catch (error) { notice(safeError(error), true); }
}
function showAnnotation(entry) {
  annotationKey = entry?.key ?? null;
  annotationBase = entry ? { bridgeName: entry.annotation?.bridgeName ?? entry.label ?? '', programs: structuredClone(entry.programs ?? []) } : { bridgeName: '', programs: [] };
  const value = drafts.get(annotationKey)?.value ?? annotationBase;
  $('annotation-name').value = value.bridgeName;
  $('annotation-rows').replaceChildren(); for (const program of value.programs) addAnnotationRow(program);
  renderDraftStatus();
}
function addAnnotationRow(program = {}) {
  const container = $('annotation-rows');
  if (container.children.length >= 16) { notice('程序注记最多 16 项。', true); return; }
  const row = document.createElement('div'); row.className = 'mc-annotation-row';
  for (const [field, title] of [['id', '程序注记 id'], ['name', '显示名称']]) {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement('input'); input.dataset.field = field; input.value = program[field] ?? ''; input.required = true; input.maxLength = 120; input.autocomplete = 'off';
    label.append(input); row.append(label);
  }
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'mc-icon-button'; remove.textContent = '移除'; remove.setAttribute('aria-label', '移除这项程序注记'); remove.onclick = () => { row.remove(); editAnnotation(); };
  row.append(remove); container.append(row);
}
function renderManagedEntry(resetAnnotation = false) {
  const entry = managedEntry(), container = $('managed-instances');
  if (managedRowsKey !== entry?.key) {
    if (container.contains(document.activeElement)) $('managed-key').focus({ preventScroll: true });
    managedRows.clear(); container.replaceChildren(managedEmpty); managedRowsKey = entry?.key;
  }
  const exists = Boolean(entry);
  $('managed-pause').disabled = !managementFresh || !entry?.manageable || entry.paused;
  $('managed-resume').disabled = !managementFresh || !entry?.manageable || !entry.paused;
  $('annotation-save').disabled = !managementFresh || !exists;
  $('annotation-add').disabled = !exists;
  $('annotation-name').disabled = !exists;
  if (!entry) { $('managed-summary').textContent = '当前没有可展示的通讯主体。'; showAnnotation(null); return; }
  $('managed-summary').textContent = `${entry.key} · ${entry.kind} · ${entry.paused ? '已暂停' : '未暂停'} · ${entry.instances?.length ?? 0} 个在线实例${entry.manageable ? '' : ' · 仅注记主体，无可管理连接'}`;
  if (resetAnnotation || annotationKey !== entry.key) showAnnotation(entry);
  reconcileRows({ container, cache: managedRows, entries: (entry.instances ?? []).map(instance => ({ localId: instance.connectionId ?? instance.bridgeId, instance })), empty: managedEmpty, focusFallback: $('managed-key'),
    update(card, item) {
      const { instance } = item, parts = card.mcParts;
      card.mcCurrent = { entry, instance };
      parts.title.textContent = instance.bridgeId;
      parts.disconnect.disabled = !managementFresh || !instance.connectionId || !entry.manageable;
      parts.disconnect.dataset.connectionId = entry.manageable ? instance.connectionId ?? '' : '';
      [instance.connectionId, instance.session, instance.authenticated ? '已认证' : '未认证', instance.since].forEach((value, index) => { parts.values[index].textContent = value ?? '—'; });
      const subscriptionRecords = managementState.hub?.subscriptions?.filter(record => record.bridgeId === instance.bridgeId) ?? [];
      parts.summary.textContent = `通道与订阅诊断 · ${subscriptionRecords.length} 条订阅`;
      parts.pre.textContent = format({ channels: instance.channels ?? [], subscriptions: subscriptionRecords.map(record => Object.fromEntries(['id', 'filters', 'operations', 'cursor', 'pending', 'queued', 'sentUpTo', 'scannedUpTo', 'catchUp', 'catchUpTarget', 'effectiveBatchLimit', 'windowLimit', 'lastProgressAt'].filter(key => record[key] !== undefined).map(key => [key, record[key]]))) });
    }, create() {
    const card = document.createElement('article'); card.className = 'mc-instance-card';
    const header = document.createElement('div'); header.className = 'mc-card-heading';
    const title = document.createElement('strong');
    const disconnect = document.createElement('button'); disconnect.type = 'button'; disconnect.className = 'mc-icon-button'; disconnect.textContent = '只断开此实例';
    disconnect.dataset.managementAction = 'disconnect';
    disconnect.onclick = () => perform(disconnect, async () => {
      const { entry, instance } = card.mcCurrent;
      const receipt = await managementPost('/manage/api/bridge', { key: entry.key, action: 'disconnect', connectionIds: [instance.connectionId] });
      await refreshManagement(false); notice(`管理断开完成：${receipt.disconnected} 个所选连接。留存与其他实例未被释放。`);
    });
    header.append(title, disconnect); card.append(header);
    const identifiers = document.createElement('dl'); identifiers.className = 'mc-instance-identity'; const values = [];
    for (const name of ['connectionId', 'session', '认证', '连接于']) {
      const div = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; values.push(dd); div.append(dt, dd); identifiers.append(div);
    }
    card.append(identifiers);
    const details = document.createElement('details'); details.className = 'mc-instance-diagnostics';
    const summary = document.createElement('summary'), pre = document.createElement('pre');
    details.append(summary, pre); card.append(details);
    card.mcParts = { title, disconnect, values, summary, pre }; return card;
  } });
}
function applyManagementState(state, resetAnnotation = false) {
  captureAnnotation();
  managementState = state;
  managementFresh = true;
  $('management-status').textContent = `已同步管理状态 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  $('management-status').classList.remove('mc-state-stale');
  const select = $('managed-key'), previous = select.value; select.replaceChildren();
  for (const entry of state.bridges ?? []) { const option = document.createElement('option'); option.value = entry.key; option.textContent = `${entry.label || entry.key} · ${entry.key}`; select.append(option); }
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  renderManagedEntry(resetAnnotation || previous !== select.value);
  updateControls();
}
function staleManagement(error) {
  managementFresh = false;
  $('management-status').textContent = `管理状态已过期 · ${safeError(error)} · 请手动刷新并核对；不会自动重发。`;
  $('management-status').classList.add('mc-state-stale');
  updateControls();
}
async function refreshManagement(resetAnnotation = false) {
  if (managementMutation) return null;
  const ticket = managementReads.begin();
  try {
    const state = await boundedJson(fetch, '/manage/api/state', { cache: 'no-store', credentials: 'same-origin' });
    if (!managementReads.current(ticket)) return null;
    applyManagementState(state, resetAnnotation); return state;
  } catch (error) { if (managementReads.current(ticket)) { staleManagement(error); throw error; } return null; }
}
async function managementPost(path, value) {
  if (managementMutation || !managementFresh || !managementState?.csrfToken) throw Object.assign(new Error('请先刷新当前管理状态再操作。'), { code: 'MANAGEMENT_STATE_STALE' });
  managementReads.invalidate(); managementMutation = true; managementFresh = false; updateControls();
  $('management-status').textContent = '管理操作正在等待回执；结果未确认，不会自动重发。';
  try {
    const result = await boundedJson(fetch, path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-management-token': managementState.csrfToken }, body: JSON.stringify(value) });
    addLog('note', format({ operation: '本机接入管理', ...value, ...result }), { type: '管理回执' }); return result;
  } catch (error) { managementReads.invalidate(); staleManagement(error); throw error; }
  finally { managementMutation = false; updateControls(); }
}
$('managed-key').onchange = () => { try { captureAnnotation(); renderManagedEntry(true); } catch (error) { $('managed-key').value = annotationKey; notice(safeError(error), true); } };
$('management-refresh').onclick = () => perform($('management-refresh'), async () => { if (await refreshManagement(false)) notice('已刷新真实连接与订阅诊断；每主体的本页草稿继续保留。'); });
for (const action of ['pause', 'resume']) $(`managed-${action}`).onclick = () => perform($(`managed-${action}`), async () => {
  const entry = managedEntry(); if (!entry?.manageable) throw new Error('当前主体没有可管理连接');
  await managementPost('/manage/api/bridge', { key: entry.key, action }); await refreshManagement(false); notice(`${entry.key} 的主体通讯已${action === 'pause' ? '暂停' : '恢复'}；所有实例适用，不影响留存保护。`);
});
$('annotation-form').addEventListener('input', editAnnotation);
$('annotation-add').onclick = () => { addAnnotationRow(); editAnnotation(); };
$('annotation-discard').onclick = () => { if (!annotationKey) return; drafts.discard(annotationKey); showAnnotation(managedEntry()); notice('已丢弃当前主体的本页草稿，未改枢纽注记。'); };
$('annotation-form').onsubmit = event => { event.preventDefault(); perform(event.submitter, async () => {
  const entry = managedEntry(); if (!entry) throw new Error('请先选择通讯主体');
  captureAnnotation(); const submitted = drafts.snapshot(entry.key, annotationValue());
  const programs = submitted.value.programs.map(program => ({ id: program.id.trim(), name: program.name.trim() }));
  if (programs.some(program => !program.id || !program.name)) throw new Error('每项程序注记都需要 id 和名称');
  if (new Set(programs.map(program => program.id)).size !== programs.length) throw new Error('程序注记 id 不能重复');
  await managementPost('/manage/api/annotation', { key: entry.key, bridgeName: submitted.value.bridgeName.trim(), programs });
  const unchanged = drafts.settle(submitted);
  if (unchanged && annotationKey === submitted.key) annotationBase = submitted.value;
  // Refresh the saved metadata without rebuilding another subject's form or a
  // newer draft. Its existing inputs keep focus, selection and composing text.
  await refreshManagement(false); renderDraftStatus();
  notice(unchanged ? '已保存提交时的完整注记。注记不改变通讯身份或权限。' : '已保存提交时的注记；提交后继续编辑的草稿仍保留，尚未保存。');
}); };
$('open-capacity').onclick = () => { dialog.close(); document.querySelector('#btn-retention-toggle')?.click(); };
function progress(value) {
  const bytes = value.bytes ?? value.loaded ?? value.offset ?? 0, total = value.total ?? value.size ?? 0;
  $('blob-progress').max = total || 1; $('blob-progress').value = bytes;
  $('blob-progress-text').textContent = `${value.stage ?? '传输'} · ${bytesLabel(bytes)}${total ? ` / ${bytesLabel(total)}` : ''}${value.id ? ` · id ${value.id}` : ''}`;
}
async function transfer(callback) {
  requireFeature('blob-v1'); if (transferAbort) throw new Error('已有附件传输进行中，请先完成或取消');
  transferAbort = new AbortController(); $('blob-cancel').disabled = false;
  try { return await callback(transferAbort.signal); }
  finally { transferAbort = null; $('blob-cancel').disabled = true; }
}
$('blob-cancel').onclick = () => { transferAbort?.abort(); notice('已请求取消当前传输。对象仍保留；由提供者自行决定是否释放。'); };
$('upload-form').onsubmit = event => { event.preventDefault(); perform(event.submitter, async () => { const file = $('upload-file').files[0]; if (!file) throw new Error('请先选择文件'); const descriptor = await transfer(signal => bridge.uploadFile(file, value => { progress(value); if (value.id) $('own-blob-id').value = value.id; }, { signal })); latestDescriptor = descriptor; $('blob-descriptor').textContent = format(descriptor); $('own-blob-id').value = descriptor.id; $('use-attachment').disabled = false; $('blob-progress-text').textContent = `上传已提交并校验 · ${bytesLabel(descriptor.size)} · ${descriptor.id}`; notice('附件已提交。可把对象 id 加入信息，再手动发布。'); }); };
$('use-attachment').onclick = () => { if (!latestDescriptor) return; perform($('use-attachment'), async () => { const current = textValue('message-attachments') ? JSON.parse(textValue('message-attachments')) : []; if (!Array.isArray(current) || current.some(id => typeof id !== 'string')) throw new Error('待发送附件需要对象 id 字符串的 JSON 数组'); if (!current.includes(latestDescriptor.id)) current.push(latestDescriptor.id); $('message-attachments').value = format(current); selectTab('message'); $('message-attachments').closest('details').open = true; notice('已加入待发送附件 id；请手动发送信息。'); }); };
$('download-form').onsubmit = event => { event.preventDefault(); perform(event.submitter, async () => { const descriptor = { id: textValue('download-id'), size: positiveSequence(textValue('download-size'), true), sha256: textValue('download-sha').toLowerCase(), ...(textValue('download-seq') ? { messageSeq: positiveSequence(textValue('download-seq')) } : {}) }; const blob = await transfer(signal => bridge.downloadBlob(descriptor, progress, { signal })); downloadFile(blob, textValue('download-name') || 'hub-attachment.bin'); $('blob-progress-text').textContent = `下载长度与 SHA-256 校验通过 · ${bytesLabel(blob.size)}`; notice('附件校验通过，已交由浏览器保存。'); }); };
$('blob-state-form').onsubmit = event => { event.preventDefault(); perform(event.submitter, async () => { requireFeature('blob-v1'); const receipt = await command('blob_status', { id: textValue('own-blob-id') }); $('blob-descriptor').textContent = format(receipt); notice('已收到自己的对象状态。'); }); };
$('blob-release').onclick = () => perform($('blob-release'), async () => { requireFeature('blob-v1'); const id = textValue('own-blob-id'); if (!id) throw new Error('请填写自己的对象 id'); await command('blob_release', { id }); notice('对象已允许之后回收；引用消息的保护状态不改变。'); });
$('raw-form').onsubmit = event => { event.preventDefault(); perform(event.submitter, async () => { const raw = $('raw-frame').value, frame = jsonObject(raw); if (frame.type === 'hello') throw new Error('hello 请使用上方连接区，避免认证 token 进入记录'); bridge.sendRaw(raw); notice('原始帧已发送到套接字；请观察真实收帧判断枢纽结果。'); }); };
$('clear').onclick = () => { logItems = []; logBytes = 0; discarded = 0; deliveries = []; deliveryBytes = 0; renderLog(); renderDeliveries(); notice('已清空本页收发记录和投递列表；不会 ACK 或释放消息。'); };
$('log-query').addEventListener('input', renderLog);
$('log-direction').addEventListener('change', renderLog);
$('export').onclick = () => downloadFile(new Blob([logItems.map(item => JSON.stringify({ ...item, bytes: undefined })).join('\n') + '\n'], { type: 'application/x-ndjson;charset=utf-8' }), `hub-manual-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
$('close').onclick = () => dialog.close();
dialog.addEventListener('close', () => restoringFocus?.focus());
window.addEventListener('beforeunload', () => { transferAbort?.abort(); bridge.close(); });

async function refreshTransport() {
  try {
    const state = await refreshManagement(); if (!state) return;
    const path = state.transport?.path;
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[?#]/.test(path)) throw new Error('管理状态缺少合法通讯路径，请检查当前管理服务版本');
    const url = new URL(path, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (url.host !== location.host) throw new Error('手动工作台只连接当前枢纽');
    transportUrl = url.href; $('url').value = transportUrl;
    if (state.bridges?.some(entry => entry.key === 'ui.manual' && entry.kind === 'credential') && !textValue('bridge') && !textValue('credential')) {
      $('bridge').value = `manual.${crypto.randomUUID().slice(0, 8)}`; $('credential').value = 'ui.manual';
      notice('已填入专用本机工作台凭据 ui.manual；可以直接连接自己的 mod。token 不保存。');
    }
  } catch (error) { transportUrl = ''; $('url').value = ''; notice(safeError(error), true); }
  updateControls();
}
document.querySelector('#btn-manual-console')?.addEventListener('click', async () => {
  restoringFocus = document.activeElement; if (!dialog.open) dialog.showModal();
  if (!bridge.connected && !connecting) await refreshTransport();
});
updateControls();
