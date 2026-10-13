// A small inert DOM exercises the actual UI handlers without executing any pack or browser content.
export class Element {
  constructor(tag = '#text', text = '') {
    this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.text = text;
    this.dataset = new Proxy({}, { set: (target, key, value) => { target[key] = String(value); this.attributes['data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())] = String(value); return true; } });
  }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = value; if (name === 'id') this.id = value; if (name === 'value') this.value = String(value); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; }
  append(...items) { for (let child of items) { if (child === null || child === undefined) continue; if (!(child instanceof Element)) child = new Element('#text', String(child)); child.parent = this; this.children.push(child); } if (this.tagName === 'select' && !this.value) this.value = this.children[0]?.value ?? ''; }
  replaceChildren(...items) { this.children = []; this.text = ''; this.append(...items); }
  prepend(...items) { const old = this.children; this.children = []; this.append(...items); this.children.push(...old); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  insertBefore(child, next) { child.parent = this; const index = this.children.indexOf(next); this.children.splice(index < 0 ? this.children.length : index, 0, child); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get name() { return this.attributes.name ?? ''; }
  get parentElement() { return this.parent ?? null; }
  get type() { return this.attributes.type ?? (this.tagName === 'input' ? 'text' : ''); }
  get options() { return this.children.filter(child => child.tagName === 'option'); }
  get classList() { return { add: (...names) => { this.className = [...new Set([...(this.className ?? '').split(' ').filter(Boolean), ...names])].join(' '); } }; }
  get elements() { const rows = this.querySelectorAll('[name]'), values = Object.fromEntries(rows.map(child => [child.attributes.name, child])); Object.defineProperty(values, Symbol.iterator, { value: () => rows[Symbol.iterator]() }); return values; }
  matches(selector) { const compound = selector.match(/^([a-z]+)(\[.*\])$/); if (compound) return this.tagName === compound[1] && this.matches(compound[2]); if (selector.startsWith('#')) return this.id === selector.slice(1); if (selector.startsWith('.')) return this.className?.split(' ').includes(selector.slice(1)); if (selector.startsWith('[')) { const [, name, value] = selector.match(/^\[([^=\]]+)(?:=([^\]]+))?\]$/) ?? []; return value ? this.attributes[name] === value.replaceAll('"', '') : name in this.attributes; } return this.tagName === selector; }
  querySelectorAll(selector) { const segments = selector.split(' '), found = []; const visit = node => { for (const child of node.children) { if (child.matches(segments.at(-1)) && (segments.length === 1 || hasAncestor(child, segments[0]))) found.push(child); visit(child); } }; visit(this); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(kind, action) { (this.listeners[kind] ??= []).push(action); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
  focus() { document.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  scrollIntoView() {}
  dispatchEvent(event) { for (const action of this.listeners[event.type] ?? []) action({ preventDefault() {}, target: this }); return true; }
  async dispatch(kind) { if (kind === 'click' && this.disabled) return; for (const action of this.listeners[kind] ?? []) await action({ preventDefault() {}, stopPropagation() {}, target: this }); }
  showModal() { this.open = true; }
  close() { this.open = false; for (const action of this.listeners.close ?? []) action({}); }
}
function hasAncestor(element, selector) { for (let ancestor = element.parent; ancestor; ancestor = ancestor.parent) if (ancestor.matches(selector)) return true; return false; }
export function element(tag, attributes = {}, children = []) {
  const node = new Element(tag);
  for (const [key, value] of Object.entries(attributes)) { if (value === false || value === undefined || value === null) continue; if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else if (['checked', 'disabled', 'hidden'].includes(key)) node[key] = value; else node.setAttribute(key, value); }
  node.append(...(Array.isArray(children) ? children : [children])); return node;
}
