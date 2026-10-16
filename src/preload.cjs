'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const CHANNELS = [
  'catalog.list',
  'catalog.get',
  'packs.import',
  'packs.reload',
  'packs.openFolder',
  'draft.load',
  'draft.save',
  'backend.status',
  'backend.retry',
  'settings.get',
  'settings.update',
  'execution.start',
  'execution.get',
  'execution.cancel',
  'execution.active',
];
const api = {};
for (const ch of CHANNELS) {
  const [ns, m] = ch.split('.');
  (api[ns] = api[ns] || {})[m] = (arg) => ipcRenderer.invoke(ch, arg);
}
contextBridge.exposeInMainWorld('mecode', Object.freeze(api));
