// Interstellar Industrial Inline SVG Icon System
// Pure programmatic SVG DOM creation - zero markup strings or execution sinks.

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgNode(name, attrs = {}) {
  let node;
  if (typeof document?.createElementNS === 'function') {
    node = document.createElementNS(SVG_NS, name);
  } else if (typeof document?.createElement === 'function') {
    node = document.createElement(name);
  } else {
    node = {
      tagName: name,
      attributes: {},
      children: [],
      setAttribute(k, v) { this.attributes[k] = String(v); },
      append(...items) { this.children.push(...items); }
    };
  }
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

const iconDefinitions = {
  logo: () => [
    svgNode('rect', { x: '3', y: '3', width: '18', height: '18', rx: '5', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('path', { d: 'M3 9h18M9 21V9', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('circle', { cx: '15', cy: '15', r: '2.5', fill: 'currentColor' }),
  ],
  packs: () => [
    svgNode('path', { d: 'M16.5 9.4 7.55 4.24a1.8 1.8 0 0 0-1.8 0L3.5 5.5a1.8 1.8 0 0 0-.9 1.56v9.88a1.8 1.8 0 0 0 .9 1.56l2.25 1.3a1.8 1.8 0 0 0 1.8 0l8.95-5.16a1.8 1.8 0 0 0 .9-1.56V11a1.8 1.8 0 0 0-.9-1.56z', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('polyline', { points: '3 6 12 11 21 6', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('line', { x1: '12', y1: '11', x2: '12', y2: '21', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  overview: () => [
    svgNode('rect', { x: '3', y: '3', width: '7', height: '9', rx: '2', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '14', y: '3', width: '7', height: '5', rx: '2', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '14', y: '12', width: '7', height: '9', rx: '2', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '3', y: '16', width: '7', height: '5', rx: '2', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  hubs: () => [
    svgNode('circle', { cx: '12', cy: '12', r: '3', stroke: 'currentColor', 'stroke-width': '2', fill: 'currentColor' }),
    svgNode('circle', { cx: '12', cy: '12', r: '8', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-dasharray': '3 3' }),
    svgNode('circle', { cx: '12', cy: '3', r: '1.5', fill: 'currentColor' }),
    svgNode('circle', { cx: '21', cy: '12', r: '1.5', fill: 'currentColor' }),
    svgNode('circle', { cx: '12', cy: '21', r: '1.5', fill: 'currentColor' }),
    svgNode('circle', { cx: '3', cy: '12', r: '1.5', fill: 'currentColor' }),
  ],
  workbench: () => [
    svgNode('rect', { x: '3', y: '4', width: '18', height: '16', rx: '3', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('polyline', { points: '7 9 10 12 7 15', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '13', y1: '15', x2: '17', y2: '15', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  modules: () => [
    svgNode('rect', { x: '3', y: '3', width: '8', height: '8', rx: '2', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '13', y: '3', width: '8', height: '8', rx: '2', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '13', y: '13', width: '8', height: '8', rx: '2', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '3', y: '13', width: '8', height: '8', rx: '2', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('circle', { cx: '7', cy: '7', r: '1.2', fill: 'currentColor' }),
    svgNode('circle', { cx: '17', cy: '7', r: '1.2', fill: 'currentColor' }),
    svgNode('circle', { cx: '17', cy: '17', r: '1.2', fill: 'currentColor' }),
    svgNode('circle', { cx: '7', cy: '17', r: '1.2', fill: 'currentColor' }),
  ],
  templates: () => [
    svgNode('path', { d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '8', y: '2', width: '8', height: '4', rx: '1', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('line', { x1: '8', y1: '11', x2: '16', y2: '11', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('line', { x1: '8', y1: '16', x2: '13', y2: '16', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  sources: () => [
    svgNode('path', { d: 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('path', { d: 'M12 12v9m0 0-3-3m3 3 3-3', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  creator: () => [
    svgNode('rect', { x: '2', y: '5', width: '6', height: '6', rx: '1.5', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '16', y: '3', width: '6', height: '6', rx: '1.5', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '14', y: '15', width: '7', height: '6', rx: '1.5', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('path', { d: 'M8 8h4a2 2 0 0 1 2 2v1m0 0v2a2 2 0 0 0 2 2h2m-6-4h2', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  environment: () => [
    svgNode('rect', { x: '4', y: '4', width: '16', height: '16', rx: '3', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '8', y: '8', width: '8', height: '8', rx: '1.5', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('path', { d: 'M1 9h3m-3 6h3m16-6h3m-3 6h3M9 1v3m6-3v3m-6 16v3m6-3v3', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  refresh: () => [
    svgNode('path', { d: 'M3 12a9 9 0 0 1 15.5-6.36L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.36L3 16m0 5v-5h5', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  search: () => [
    svgNode('circle', { cx: '11', cy: '11', r: '7', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '16.5', y1: '16.5', x2: '21.5', y2: '21.5', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  play: () => [
    svgNode('polygon', { points: '6 4 20 12 6 20 6 4', fill: 'currentColor' }),
  ],
  stop: () => [
    svgNode('rect', { x: '5', y: '5', width: '14', height: '14', rx: '2.5', fill: 'currentColor' }),
  ],
  restart: () => [
    svgNode('path', { d: 'M3 12a9 9 0 1 0 2.6-6.3L2 9', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('polyline', { points: '2 4 2 9 7 9', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  arrowRight: () => [
    svgNode('path', { d: 'M5 12h14m-6-6 6 6-6 6', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  arrowLeft: () => [
    svgNode('path', { d: 'M19 12H5m6 6-6-6 6-6', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  plus: () => [
    svgNode('line', { x1: '12', y1: '5', x2: '12', y2: '19', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '5', y1: '12', x2: '19', y2: '12', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  close: () => [
    svgNode('line', { x1: '18', y1: '6', x2: '6', y2: '18', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '6', y1: '6', x2: '18', y2: '18', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  copy: () => [
    svgNode('rect', { x: '9', y: '9', width: '13', height: '13', rx: '2', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  check: () => [
    svgNode('polyline', { points: '20 6 9 17 4 12', stroke: 'currentColor', 'stroke-width': '2.5' }),
  ],
  alert: () => [
    svgNode('path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '12', y1: '9', x2: '12', y2: '13', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('circle', { cx: '12', cy: '17', r: '1', fill: 'currentColor' }),
  ],
  folder: () => [
    svgNode('path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  file: () => [
    svgNode('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('polyline', { points: '14 2 14 8 20 8', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  task: () => [
    svgNode('path', { d: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '9', y: '3', width: '6', height: '4', rx: '1', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('polyline', { points: '9 14 11 16 15 11', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  themeDark: () => [
    svgNode('path', { d: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z', stroke: 'currentColor', 'stroke-width': '2', fill: 'currentColor' }),
  ],
  themeLight: () => [
    svgNode('circle', { cx: '12', cy: '12', r: '5', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '12', y1: '1', x2: '12', y2: '3', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '12', y1: '21', x2: '12', y2: '23', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '4.22', y1: '4.22', x2: '5.64', y2: '5.64', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '18.36', y1: '18.36', x2: '19.78', y2: '19.78', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '1', y1: '12', x2: '3', y2: '12', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '21', y1: '12', x2: '23', y2: '12', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '4.22', y1: '19.78', x2: '5.64', y2: '18.36', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '18.36', y1: '5.64', x2: '19.78', y2: '4.22', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  grid: () => [
    svgNode('rect', { x: '3', y: '3', width: '7', height: '7', rx: '1.5', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '14', y: '3', width: '7', height: '7', rx: '1.5', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '14', y: '14', width: '7', height: '7', rx: '1.5', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('rect', { x: '3', y: '14', width: '7', height: '7', rx: '1.5', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  list: () => [
    svgNode('line', { x1: '8', y1: '6', x2: '21', y2: '6', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '8', y1: '12', x2: '21', y2: '12', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '8', y1: '18', x2: '21', y2: '18', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '3', y1: '6', x2: '4', y2: '6', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '3', y1: '12', x2: '4', y2: '12', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '3', y1: '18', x2: '4', y2: '18', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  database: () => [
    svgNode('ellipse', { cx: '12', cy: '5', rx: '9', ry: '3', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('path', { d: 'M21 12c0 1.66-4 3-9 3s-9-1.34-9-3', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('path', { d: 'M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  shield: () => [
    svgNode('path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  sparkle: () => [
    svgNode('path', { d: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  link: () => [
    svgNode('path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  unlink: () => [
    svgNode('path', { d: 'm18.84 12.25 1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('path', { d: 'm5.16 11.75-1.72 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '2', y1: '2', x2: '22', y2: '22', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  undo: () => [
    svgNode('path', { d: 'M3 7v6h6', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('path', { d: 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  save: () => [
    svgNode('path', { d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('polyline', { points: '17 21 17 13 7 13 7 21', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('polyline', { points: '7 3 7 8 15 8', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  inspect: () => [
    svgNode('path', { d: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('circle', { cx: '12', cy: '12', r: '3', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  clock: () => [
    svgNode('circle', { cx: '12', cy: '12', r: '10', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('polyline', { points: '12 6 12 12 16 14', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  menu: () => [
    svgNode('line', { x1: '3', y1: '12', x2: '21', y2: '12', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '3', y1: '6', x2: '21', y2: '6', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('line', { x1: '3', y1: '18', x2: '21', y2: '18', stroke: 'currentColor', 'stroke-width': '2' }),
  ],
  trash: () => [
    svgNode('path', { d: 'M3 6h18', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('line', { x1: '10', y1: '11', x2: '10', y2: '17', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgNode('line', { x1: '14', y1: '11', x2: '14', y2: '17', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
  settings: () => [
    svgNode('circle', { cx: '12', cy: '12', r: '3', stroke: 'currentColor', 'stroke-width': '2' }),
    svgNode('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z', stroke: 'currentColor', 'stroke-width': '1.8' }),
  ],
};

export function createIcon(name, className = 'icon') {
  const svg = svgNode('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    class: className,
  });

  const factory = iconDefinitions[name];
  if (factory) {
    for (const child of factory()) svg.append(child);
  } else {
    // Fallback simple square mark
    svg.append(svgNode('rect', { x: '4', y: '4', width: '16', height: '16', rx: '2', stroke: 'currentColor', 'stroke-width': '2' }));
  }
  return svg;
}

export function renderSquareArt({ icon, fallbackIcon = 'packs', tone = 'cyan', alt = '', moduleId = '' } = {}) {
  let art;
  if (typeof document?.createElement === 'function') {
    art = document.createElement('div');
  } else {
    art = { tagName: 'div', attributes: {}, className: '', children: [], setAttribute(k, v) { this.attributes[k] = v; }, append(...items) { this.children.push(...items); } };
  }
  art.className = `card-square-art tone-${tone}`;
  art.setAttribute('aria-hidden', 'true');

  function makeFallback() {
    let iconName = fallbackIcon;
    if (moduleId === 'demo.desk') iconName = 'workbench';
    else if (moduleId === 'demo.source') iconName = 'file';
    else if (moduleId === 'demo.stats') iconName = 'task';

    let symbolWrap;
    if (typeof document?.createElement === 'function') {
      symbolWrap = document.createElement('div');
    } else {
      symbolWrap = { tagName: 'div', attributes: {}, className: '', children: [], setAttribute(k, v) { this.attributes[k] = v; }, append(...items) { this.children.push(...items); } };
    }
    symbolWrap.className = 'card-square-symbol';
    symbolWrap.append(createIcon(iconName, 'icon-art'));
    return symbolWrap;
  }

  if (icon && typeof icon === 'string' && icon.trim()) {
    if (typeof document?.createElement === 'function') {
      const img = document.createElement('img');
      img.className = 'card-square-img';
      img.src = icon;
      img.alt = alt || '';
      img.loading = 'lazy';
      img.onerror = () => {
        if (typeof art.replaceChildren === 'function') art.replaceChildren(makeFallback());
      };
      art.append(img);
    } else {
      art.append(makeFallback());
    }
  } else {
    art.append(makeFallback());
  }

  return art;
}
