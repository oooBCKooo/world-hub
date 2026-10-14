'use strict';
/**
 * World Hub Soft UI Desktop (prototype).
 * Native window creation and its lifecycle stay outside Hub Core.
 * The trusted local host owns bridge credentials; renderer windows do not.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, screen } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const stateIndex = process.argv.indexOf('--ui-state-dir');
if (stateIndex > -1 && process.argv[stateIndex + 1]) {
  const desktopStateDirectory = path.resolve(process.argv[stateIndex + 1]);
  fs.mkdirSync(desktopStateDirectory, { recursive: true });
  app.setPath('userData', desktopStateDirectory);
}
const demo = false;
const mode = demo ? '演示' : 'World Hub';
let quitting = false;
let apiOrigin;
let token;
let tray;
let manager;
let tick;
let polling = false;
const windows = new Map();
let remembered = {};
let statePath;
let saveTimer;
let viewSequence = 0;
let hostReady = false;

const initialize = new Promise((resolve, reject) => {
  if (!process.send) return reject(new Error('A trusted spawning parent is required.'));
  const deadline = setTimeout(() => reject(new Error('Desktop initialization timed out.')), 10000);
  process.on('message', message => {
    if (message?.type !== 'soft-ui.initialize') return;
    const origin = new URL(message.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.origin !== message.origin
        || typeof message.token !== 'string' || !/^[0-9a-f]{48}$/.test(message.token)) return;
    apiOrigin = message.origin; token = message.token; clearTimeout(deadline); resolve();
  });
});
async function launchHost() {
  await initialize;
  const state = await api('/api/views');
  if (state.ready !== true) throw new Error('The authenticated Host is not ready.');
  hostReady = true;
}

async function api(endpoint, options = {}) {
  if (!apiOrigin || !token) throw new Error('UI Host not connected');
  const response = await fetch(new URL(endpoint, apiOrigin), {
    ...options,
    headers: { 'X-Soft-UI-Token': token, ...(options.headers || {}) },
    signal: AbortSignal.timeout(4500)
  });
  if (!response.ok) throw new Error(`UI Host HTTP ${response.status}`);
  return response.json();
}

function safeBounds(box) {
  if (!box || !Number.isInteger(box.x) || !Number.isInteger(box.y) ||
      !Number.isInteger(box.width) || !Number.isInteger(box.height) ||
      box.width < 300 || box.height < 220 || box.width > 4000 || box.height > 3000) return null;
  // Avoid restoring windows entirely outside the currently connected monitors.
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    Math.max(0, Math.min(box.x + box.width, a.x + a.width) - Math.max(box.x, a.x)) >= 120 &&
    Math.max(0, Math.min(box.y + box.height, a.y + a.height) - Math.max(box.y, a.y)) >= 80);
  return visible ? box : null;
}
function persistBounds() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(remembered, null, 2));
      fs.renameSync(tmp, statePath);
    } catch (error) { console.error('Could not save window bounds:', error.message); }
  }, 500);
}
function lockedDown(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}
function createView(view) {
  const num = ++viewSequence;
  const box = safeBounds(remembered[view.key]);
  const win = new BrowserWindow({
    width: view.window?.width ?? 620, height: view.window?.height ?? 460,
    ...(box ? { x: box.x, y: box.y, width: box.width, height: box.height } : {}),
    resizable: view.window?.resizable ?? true,
    minWidth: 340, minHeight: 250,
    title: view.title, backgroundColor: '#151f2d', autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'view-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, partition: `soft-ui-native-${num}-${randomUUID()}`
    }
  });
  lockedDown(win);
  const record = { win, view, hiddenByUser: false, loaded: false };
  windows.set(view.key, record);
  win.on('ready-to-show', () => { if (!win.isDestroyed() && !record.hiddenByUser) win.show(); });
  win.on('close', event => {
    if (!quitting) {
      // Closing a view hides it; it does not terminate the producer program.
      event.preventDefault(); record.hiddenByUser = true; win.hide(); publishList();
    }
  });
  win.on('closed', () => { windows.delete(view.key); publishList(); });
  for (const event of ['move', 'resize']) {
    win.on(event, () => {
      if (!win.isDestroyed() && !win.isMaximized() && !win.isMinimized()) {
        remembered[view.key] = win.getBounds(); persistBounds();
      }
    });
  }
  win.webContents.on('did-finish-load', () => {
    record.loaded = true;
    if (!win.isDestroyed()) win.webContents.send('ui:render', record.view);
  });
  void win.loadFile(path.join(__dirname, 'view.html')).catch(e => console.error('View load error:', e));
  publishList();
}
function showView(key) {
  const record = windows.get(key);
  if (!record || record.win.isDestroyed()) return false;
  record.hiddenByUser = false;
  if (record.win.isMinimized()) record.win.restore();
  record.win.show(); record.win.focus(); publishList();
  return true;
}
function toggleView(key) {
  const record = windows.get(key);
  if (!record) return false;
  if (record.win.isVisible()) { record.hiddenByUser = true; record.win.hide(); publishList(); return true; }
  return showView(key);
}
function listViews() {
  return [...windows.entries()].map(([key, rec]) => ({
    key, principal: rec.view.principal, viewId: rec.view.viewId,
    title: rec.view.title, revision: rec.view.revision, visible: rec.win.isVisible()
  }));
}
function publishList() {
  const list = listViews();
  if (manager && !manager.isDestroyed()) {
    manager.webContents.send('manager:views', list);
    manager.webContents.send('manager:status', { ready: hostReady, demo });
  }
  if (tray) {
    const menu = [
      { label: '窗口管理中心', click: showManager },
      { label: '显示全部窗口', click: () => { for (const key of windows.keys()) showView(key); } },
      { type: 'separator' },
      ...list.map(item => ({ label: `${item.visible ? '● ' : '○ '}${item.title} (${item.principal})`, click: () => showView(item.key) })),
      { type: 'separator' },
      { label: '退出 Soft UI Desktop', click: () => app.quit() }
    ];
    tray.setContextMenu(Menu.buildFromTemplate(menu));
  }
}
function showManager() {
  if (!manager || manager.isDestroyed()) return;
  if (manager.isMinimized()) manager.restore();
  manager.show(); manager.focus(); publishList();
}
function createManager() {
  manager = new BrowserWindow({
    width: 560, height: 520, minWidth: 380, minHeight: 330,
    title: 'World Hub Soft UI · 窗口管理',
    backgroundColor: '#151f2d', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'manager-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, partition: `soft-ui-manager-${randomUUID()}`
    }
  });
  lockedDown(manager);
  manager.on('close', event => {
    if (!quitting) { event.preventDefault(); manager.hide(); }
  });
  manager.webContents.on('did-finish-load', publishList);
  void manager.loadFile(path.join(__dirname, 'manager.html')).catch(console.error);
}

async function poll() {
  if (polling || quitting) return;
  polling = true;
  try {
    const result = await api('/api/views');
    hostReady = result.ready === true;
    const seen = new Set();
    for (const view of result.views || []) {
      seen.add(view.key);
      const record = windows.get(view.key);
      if (!record) createView(view);
      else if (view.revision !== record.view.revision || view.title !== record.view.title) {
        record.view = view;
        record.win.setTitle(view.title);
        if (record.loaded) record.win.webContents.send('ui:render', view);
      }
    }
    for (const [key, record] of windows) {
      if (!seen.has(key)) {
        windows.delete(key);
        if (!record.win.isDestroyed()) record.win.destroy();
      }
    }
    publishList();
  } catch (e) { hostReady = false; publishList(); console.error('Desktop synchronization failed:', e.message); }
  finally { polling = false; }
}

// Window contents cannot read the local API session secret or arbitrary OS paths.
ipcMain.handle('ui:event', async (event, data) => {
  const record = [...windows.values()].find(r => r.win.webContents.id === event.sender.id);
  if (!record || event.senderFrame !== record.win.webContents.mainFrame) throw new Error('Unknown sender');
  if (!data || !['click', 'change'].includes(data.action) || typeof data.elementId !== 'string') throw new Error('Invalid event');
  if (data.value !== undefined && (typeof data.value !== 'string' || data.value.length > 1000)) throw new Error('Invalid value');
  return api('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: record.view.key, action: data.action, elementId: data.elementId, value: data.value, revision: data.revision, eventId: data.eventId })
  });
});
ipcMain.handle('manager:list', e => {
  if (!manager || e.sender !== manager.webContents || e.senderFrame !== manager.webContents.mainFrame) return [];
  return listViews();
});
ipcMain.handle('manager:show', (e, key) => {
  if (!manager || e.sender !== manager.webContents || e.senderFrame !== manager.webContents.mainFrame || typeof key !== 'string') return false;
  return showView(key);
});
ipcMain.handle('manager:toggle', (e, key) => {
  if (!manager || e.sender !== manager.webContents || e.senderFrame !== manager.webContents.mainFrame || typeof key !== 'string') return false;
  return toggleView(key);
});

app.setName('World Hub Soft UI Desktop');
// An optional trusted spawning parent can request the same graceful exit as the
// tray menu. Renderer IPC never receives this process channel.
if (process.send) process.on('message', message => {
  if (message?.type === 'soft-ui.stop') app.quit();
});
app.on('before-quit', () => {
  quitting = true; clearInterval(tick); clearTimeout(saveTimer);
  try {
    if (statePath) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const temporary = `${statePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(remembered, null, 2)); fs.renameSync(temporary, statePath);
    }
  } catch (error) { console.error('Could not save final window bounds:', error.message); }
});
app.on('window-all-closed', () => { /* Remain available in the Windows tray. */ });
app.on('activate', showManager);
app.whenReady().then(async () => {
  statePath = path.join(app.getPath('userData'), 'window-bounds.json');
  try { remembered = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { remembered = {}; }
  try {
    await launchHost();
    tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
    tray.setToolTip(`World Hub Soft UI Desktop (${mode})`);
    tray.on('double-click', showManager);
    createManager();
    await poll();
    tick = setInterval(poll, 800);
    publishList();
    process.send?.({ type: 'soft-ui.ready' });
  } catch (e) {
    process.send?.({ type: 'soft-ui.failed' });
    dialog.showErrorBox('无法启动 Soft UI Desktop', `${e.message}\n请检查 Node.js、World Hub 连接和权限配置。`);
    app.quit();
  }
});
