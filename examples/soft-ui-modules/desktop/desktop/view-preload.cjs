'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('softUI', {
  onRender: callback => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('ui:render', (_event, view) => callback(view));
  },
  emit: payload => ipcRenderer.invoke('ui:event', payload)
});
