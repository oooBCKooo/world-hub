// 调试入口：一张只读的接线图 + 实时流水。
//
// 只显示通讯诊断：桥、mod通道声明、订阅与近期消息。

export function debugPageHtml({ hubId, wireVersion }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>世界枢纽 · ${escapeHtml(hubId)}</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --ink:#e6edf3; --dim:#8b949e; --accent:#58a6ff; --ok:#3fb950; --warn:#d29922; --bad:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:13px/1.55 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace; }
  header { padding:14px 18px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:.02em; }
  .tag { color:var(--dim); font-size:12px; }
  .tag b { color:var(--ink); font-weight:600; }
  main { display:grid; grid-template-columns: minmax(280px, 1fr) minmax(420px, 1.4fr); gap:0; height:calc(100vh - 52px); }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; height:auto; } }
  section { overflow:auto; padding:14px 18px; }
  section + section { border-left:1px solid var(--line); }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:0 0 10px; font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { text-align:left; padding:5px 8px 5px 0; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:500; }
  .mono { font-family:inherit; }
  .pill { display:inline-block; padding:1px 6px; border-radius:9px; border:1px solid var(--line); color:var(--dim); font-size:11px; }
  .pill.ok { color:var(--ok); border-color:#1f6f34; }
  .pill.warn { color:var(--warn); border-color:#6b4c00; }
  .pill.bad { color:var(--bad); border-color:#7d2620; }
  .empty { color:var(--dim); font-style:italic; padding:8px 0; }
  .stream { display:flex; flex-direction:column-reverse; }
  .row { display:grid; grid-template-columns: 78px 1fr; gap:10px; padding:4px 0; border-bottom:1px solid #21262d; }
  .seq { color:var(--dim); text-align:right; }
  .topic { color:var(--accent); }
  .from { color:var(--dim); }
  .body { color:var(--ink); word-break:break-all; }
  .bar { display:flex; gap:16px; flex-wrap:wrap; margin:0 0 12px; }
  .bar div { color:var(--dim); } .bar b { color:var(--ink); }
  footer { grid-column:1/-1; padding:8px 18px; border-top:1px solid var(--line); color:var(--dim); font-size:11px; }
</style>
</head>
<body>
<header>
  <h1>世界枢纽</h1>
  <a href="/manage" style="color:var(--accent)">打开管理界面 →</a>
  <span class="tag">hub <b>${escapeHtml(hubId)}</b></span>
  <span class="tag">wire <b>${escapeHtml(wireVersion)}</b></span>
  <span class="tag" id="conn">连接中…</span>
</header>
<main>
  <section>
    <h2>接线图 · 桥</h2>
    <div id="bridges"><div class="empty">还没有桥接上来</div></div>
    <h2 style="margin-top:18px">接线图 · mod 通道声明</h2>
    <div id="channels"><div class="empty">还没有通道声明</div></div>
    <h2 style="margin-top:18px">接线图 · 订阅</h2>
    <div id="subs"><div class="empty">还没有订阅</div></div>
  </section>
  <section>
    <h2>流水账</h2>
    <div class="bar" id="counters"></div>
    <div class="stream" id="stream"><div class="empty">还没有消息</div></div>
  </section>
</main>
<footer>本机只读通讯诊断：桥、通道声明、订阅、近期消息。通道声明不扩大权限；枢纽不持有业务状态。</footer>
<script>
const $ = (id) => document.getElementById(id);
let lastSeq = -1;
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function pill(text, cls) { return '<span class="pill ' + (cls || '') + '">' + esc(text) + '</span>'; }

async function poll() {
  try {
    const snap = await (await fetch('/status', { cache: 'no-store' })).json();
    $('conn').innerHTML = '在线 · seq <b>' + snap.lastSeq + '</b>';
    $('counters').innerHTML = [
      ['已接受', snap.counters.accepted], ['已投递', snap.counters.delivered],
      ['被拒', snap.counters.denied], ['实时缺口', snap.counters.dropped],
    ].map(([k, v]) => '<div>' + k + ' <b>' + v + '</b></div>').join('');

    $('bridges').innerHTML = snap.bridges.length === 0
      ? '<div class="empty">还没有桥接上来</div>'
      : '<table><tr><th>桥</th><th>角色</th><th>认证</th><th>发/收</th><th>接入</th></tr>' +
        snap.bridges.map((b) => '<tr><td>' + esc(b.bridgeId) + '<br><span class="from">' + esc(b.displayName || '') + '</span></td>' +
          '<td>' + esc(b.role || '—') + '</td>' +
          '<td>' + (b.authenticated ? pill('token', 'ok') : pill('loopback', 'warn')) + '</td>' +
          '<td>' + b.published + ' / ' + b.delivered + '</td>' +
          '<td class="from">' + esc((b.since || '').slice(11, 19)) + '</td></tr>').join('') + '</table>';

    const channels = snap.bridges.flatMap((b) => (b.channels || []).map((c) => ({ ...c, bridge: b.bridgeId })));
    $('channels').innerHTML = channels.length === 0
      ? '<div class="empty">还没有通道声明</div>'
      : '<table><tr><th>桥</th><th>通道 / 过滤器</th><th>方向</th></tr>' +
        channels.map((c) => '<tr><td>' + esc(c.bridge) + '</td><td class="topic">' + esc(c.name) + '</td><td>' +
          [c.publish ? '发布' : '', c.subscribe ? '订阅' : ''].filter(Boolean).join(' / ') + '</td></tr>').join('') + '</table>';

    $('subs').innerHTML = snap.subscriptions.length === 0
      ? '<div class="empty">还没有订阅</div>'
      : '<table><tr><th>订阅</th><th>桥</th><th>主题</th><th>游标</th><th>窗口</th></tr>' +
        snap.subscriptions.map((s) => '<tr><td>' + esc(s.id) + '</td><td>' + esc(s.bridgeId) + '</td>' +
          '<td class="topic">' + esc(s.filters.join(', ')) + '</td>' +
          '<td>' + s.cursor + (s.catchUp ? ' ' + pill('补课中', 'warn') : '') + '</td>' +
          '<td>' + s.pending + (s.queued ? ' +' + s.queued + 'q' : '') + '</td></tr>').join('') + '</table>';
  } catch (e) {
    $('conn').innerHTML = pill('枢纽不可达', 'bad');
  }
}

async function pollLog() {
  try {
    const data = await (await fetch('/log?limit=60', { cache: 'no-store' })).json();
    const rows = data.records.filter((r) => r.kind === 'message' || r.kind === 'gap').reverse();
    if (rows.length === 0) return;
    const newest = rows[0].seq ?? -1;
    if (newest === lastSeq) return;
    lastSeq = newest;
    $('stream').innerHTML = rows.map((r) => r.kind === 'gap'
      ? '<div class="row"><div class="seq">gap</div><div><span class="pill bad">缺口</span> ' + esc(r.subscriptionId) + ' 丢了 ' + r.from + '–' + r.to + '（' + esc(r.reason) + '）</div></div>'
      : '<div class="row"><div class="seq">#' + r.seq + '</div><div><span class="topic">' + esc(r.topic) + '</span> <span class="from">← ' + esc(r.from) + ' · ' + r.bytes + 'B · ' + esc((r.at || '').slice(11, 19)) + '</span><div class="body">' + esc(JSON.stringify(r.body)) + '</div></div></div>'
    ).join('');
  } catch {}
}

poll(); pollLog();
setInterval(poll, 1200);
setInterval(pollLog, 700);
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
