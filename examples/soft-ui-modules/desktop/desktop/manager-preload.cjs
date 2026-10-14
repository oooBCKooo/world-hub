'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('softUIManager', {
  list: () => ipcRenderer.invoke('manager:list'),
  show: key => ipcRenderer.invoke('manager:show', key),
  toggle: key => ipcRenderer.invoke('manager:toggle', key),
  onStatus: callback => { if (typeof callback === 'function') ipcRenderer.on('manager:status', (_event, status) => callback(status)); },
  onChange: callback => {
    if (typeof callback === 'function') ipcRenderer.on('manager:views', (_event, list) => callback(list));
  }
});
