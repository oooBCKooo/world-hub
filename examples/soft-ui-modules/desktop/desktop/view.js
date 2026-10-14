'use strict';
// The program sends only validated component data; no custom program HTML/JS is executed.
const app = document.getElementById('app');
const info = document.getElementById('info');
let lastRevision = -1;
const emit = (elementId, action, value) => {
  window.softUI.emit({ elementId, action, value, revision: lastRevision, eventId: crypto.randomUUID() }).catch(e => {
    info.textContent = `操作未送达：${e?.message || '连接异常'}`;
  });
};
function renderNode(node) {
  let el;
  switch (node.type) {
    case 'column': case 'row': case 'card':
      el = document.createElement('section'); el.className = node.type;
      for (const child of node.children || []) el.append(renderNode(child));
      break;
    case 'text':
      el = document.createElement('p'); el.className = 'text'; el.textContent = node.text;
      break;
    case 'metric': {
      el = document.createElement('div'); el.className = 'metric';
      const label = document.createElement('small'); label.textContent = node.text;
      const big = document.createElement('strong'); big.textContent = String(node.value ?? '');
      el.append(label, big); break;
    }
    case 'button':
      el = document.createElement('button'); el.type = 'button'; el.textContent = node.text;
      el.addEventListener('click', () => emit(node.id, 'click')); break;
    case 'input': {
      el = document.createElement('label'); el.textContent = node.text;
      const input = document.createElement('input'); input.value = String(node.value ?? '');
      input.addEventListener('change', () => emit(node.id, 'change', input.value));
      el.append(input); break;
    }
    case 'divider': el = document.createElement('hr'); break;
    default: el = document.createTextNode('不支持的组件');
  }
  return el;
}
window.softUI.onRender(view => {
  if (!view || !view.root || !Number.isInteger(view.revision) || view.revision === lastRevision) return;
  lastRevision = view.revision;
  document.title = view.title;
  app.replaceChildren(renderNode(view.root));
  info.textContent = `${view.principal} · ${view.viewId} · 修订 ${view.revision}`;
});
