/**
 * Bridge segura (contextIsolation) entre o setup e o processo principal.
 * O renderer só enxerga `window.dsf.*`; nada de Node solto.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsf', {
  getConfig: () => ipcRenderer.invoke('cfg:get'),
  resolveSave: (input) => ipcRenderer.invoke('cfg:resolve-save', input),
  authenticate: (password) => ipcRenderer.invoke('cfg:authenticate', password),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  play: () => ipcRenderer.invoke('app:play'),
  openSetup: () => ipcRenderer.invoke('app:setup'),
  quit: () => ipcRenderer.invoke('app:quit'),
  uninstall: () => ipcRenderer.invoke('app:uninstall'),
  favList: () => ipcRenderer.invoke('fav:list'),
  favAdd: (fav) => ipcRenderer.invoke('fav:add', fav),
  favRemove: (url) => ipcRenderer.invoke('fav:remove', url),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', on),
  autostartStatus: () => ipcRenderer.invoke('autostart:status'),
  setOffline: (on) => ipcRenderer.invoke('offline:set', on),
  setInterval: (m) => ipcRenderer.invoke('interval:set', m),
  setDomain: (v) => ipcRenderer.invoke('domain:set', v),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  onSyncStatus: (cb) => ipcRenderer.on('sync:status', (_e, s) => cb(s)),
});
