'use strict';
const container = document.getElementById('views');
const count = document.getElementById('count');
function update(list) {
  count.textContent = `窗口：${list.length}`;
  container.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('p'); empty.className='empty';
    empty.textContent = '尚无窗口：等待模块发送 view.open。'; container.append(empty); return;
  }
  for (const view of list) {
    const row = document.createElement('article');
    const meta = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = view.title;
    const detail = document.createElement('small'); detail.textContent = `${view.principal} / ${view.viewId} · revision ${view.revision}`;
    meta.append(title, detail);
    const controls = document.createElement('div'); controls.className = 'controls';
    const show = document.createElement('button'); show.textContent = '打开窗口';
    show.addEventListener('click', () => window.softUIManager.show(view.key));
    const toggle = document.createElement('button'); toggle.className = 'muted';
    toggle.textContent = view.visible ? '隐藏窗口' : '已隐藏';
    toggle.addEventListener('click', () => window.softUIManager.toggle(view.key));
    controls.append(show, toggle); row.append(meta, controls); container.append(row);
  }
}
window.softUIManager.onChange(update);
window.softUIManager.onStatus(status => { document.getElementById('connection').textContent = status.ready ? (status.demo ? '演示模式（无需 Hub）' : 'Hub 已连接') : 'Hub 连接中断；等待重连，暂不能发送操作'; });
window.softUIManager.list().then(update).catch(console.error);
