const $ = id => document.getElementById(id);
let current, selection = null, busy = false, programsKey = '', eventsKey = '', renderedResult = 0;
const format = value => JSON.stringify(value, null, 2);
const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };

function chooseAction() {
  selection = current.profile.actions.find(action => action.id === $('action').value);
  if (!selection) return;
  $('body').value = format(selection.body); $('action-description').textContent = selection.description;
  $('route').textContent = `界面 → mod → 枢纽 → ${selection.target.principal}\n${selection.operation} · ${selection.topic}`;
  $('message').textContent = ''; $('message').classList.remove('error');
}

function render(state) {
  current = state;
  $('title').textContent = state.profile.title; document.title = `${state.profile.title} · World Hub`;
  $('description').textContent = state.profile.description;
  $('manage').href = state.managementUrl; $('endpoint').textContent = state.endpoint;
  $('profile').textContent = `PROFILE / ${state.profile.id}`;
  $('connection').textContent = state.explorer.connected && !state.hubStatusError ? 'mod 已连接' : '通讯中断';
  $('connection').classList.toggle('off', !state.explorer.connected || Boolean(state.hubStatusError));
  $('count').textContent = state.hubStatus?.lastSeq ?? state.events.at(-1)?.seq ?? 0;
  const live = state.hubStatus?.bridges ?? [];
  $('hub-count').textContent = `${live.length} 个桥连接`;
  const peers = [...state.profile.peers, { id: 'explorer', label: '用途探索界面', bridges: [{ id: 'web', label: '双向界面桥' }] }];
  const key = format(live.map(bridge => [bridge.principal, bridge.bridgeId]));
  if (key !== programsKey || !$('programs').children.length) {
    programsKey = key; $('programs').replaceChildren();
    for (const peer of peers) {
      const principal = `demo.${state.profile.id}.${peer.id}`;
      const card = text('div', '', 'program'); card.append(text('strong', peer.label), text('div', principal, 'principal'));
      for (const bridge of peer.bridges) {
        const name = `${principal}.${bridge.id}`;
        const online = live.some(item => item.principal === principal && (item.declaredId === name || item.bridge === name || item.id === name || item.id?.startsWith(`${name}~`)));
        const row = text('div', bridge.label, `bridge${online ? '' : ' off'}`); row.title = name; card.append(row);
      }
      $('programs').append(card);
    }
  }
  if (!selection) {
    $('action').replaceChildren(...state.profile.actions.map(action => { const option = text('option', action.label); option.value = action.id; return option; }));
    chooseAction();
  }
  const result = state.results.at(-1);
  if (result && result.index !== renderedResult) {
    renderedResult = result.index; $('result-label').textContent = result.label;
    $('result').textContent = format(result.response?.body ?? result);
  }
  const eventKey = state.events.map(event => event.seq).join(',');
  if (eventKey !== eventsKey) {
    const expanded = new Set([...$('events').querySelectorAll('details[open]')].map(node => node.dataset.seq));
    eventsKey = eventKey; $('events').replaceChildren();
    for (const event of [...state.events].reverse()) {
      const details = document.createElement('details'); details.dataset.seq = String(event.seq); details.open = expanded.has(String(event.seq));
      const summary = document.createElement('summary');
      summary.append(text('span', `#${event.seq}`, 'seq'), text('span', event.operation ?? 'publish', 'op'),
        text('span', event.fromPrincipal ?? event.from ?? '', 'from'), text('span', event.topic, 'topic'),
        text('span', new Date(event.receivedAt).toLocaleTimeString('zh-CN', { hour12: false }), 'time'));
      details.append(summary, text('pre', format(event))); $('events').append(details);
    }
    if (!state.events.length) $('events').append(text('p', '等待外部程序发布信息，或从上方发起一个操作。'));
  }
  $('failures').textContent = state.failures.at(-1)?.message ?? state.hubStatusError ?? '';
  $('send').disabled = busy || state.active;
}

async function refresh() {
  try {
    const response = await fetch('/api/state'); if (!response.ok) throw new Error(`状态请求失败 ${response.status}`);
    render(await response.json());
  } catch (error) { $('connection').textContent = '会话已停止'; $('connection').classList.add('off'); $('failures').textContent = error.message; $('send').disabled = true; }
}

$('action').addEventListener('change', chooseAction);
$('send').addEventListener('click', async () => {
  if (busy || !selection) return;
  let body;
  try { body = JSON.parse($('body').value); } catch { $('message').textContent = '请先修正 JSON 格式。'; $('message').classList.add('error'); return; }
  busy = true; $('send').disabled = true; $('message').classList.remove('error'); $('message').textContent = '信息已从界面程序发出，等待目标程序…';
  try {
    const response = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-token': current.operationToken }, body: JSON.stringify({ id: selection.id, body }) });
    const value = await response.json(); if (!response.ok || !value.ok) throw new Error(value.error ?? '操作失败');
    $('message').textContent = value.result.note; $('result').textContent = format(value.result.response?.body ?? value.result);
    $('result-label').textContent = value.result.label; renderedResult = value.result.index;
  } catch (error) { $('message').textContent = error.message; $('message').classList.add('error'); }
  finally { busy = false; await refresh(); }
});
await refresh(); setInterval(refresh, 1200);
