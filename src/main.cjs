'use strict';
// OPTIONAL Electron wrapper (the shipped, host-verified runtime is the local web server: src/web/server.cjs).
// Thin IPC adapter over the shared service layer. NOT exercised on this host (native sandbox helper fails to launch).
const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { createServices, invoke } = require('./main/services.cjs');

if (process.env.MECODE_USER_DATA) app.setPath('userData', process.env.MECODE_USER_DATA);
else app.setPath('userData', path.join(app.getPath('appData'), 'MeCode-V2'));

async function boot() {
  const svc = await createServices({ userData: app.getPath('userData'), appRoot: path.join(__dirname, '..') });
  const handlers = {
    ...svc.handlers,
    'packs.openFolder': async () => {
      const e = await shell.openPath(svc.catalog.packsDir);
      if (e) throw new Error(e);
      return {};
    },
  };
  for (const ch of Object.keys(handlers)) ipcMain.handle(ch, (_e, arg) => invoke(handlers, ch, arg));
  return svc;
}

function createWindow() {
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'MeCode V2',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(async () => {
    let svc;
    try {
      svc = await boot();
    } catch (e) {
      console.error('boot failed', e);
      app.exit(1);
      return;
    }
    createWindow();
    let quitting = false;
    app.on('before-quit', (ev) => {
      // serialized, awaited container removal before the process exits
      if (quitting) return;
      quitting = true;
      ev.preventDefault();
      svc.shutdown().finally(() => app.exit(0));
    });
  });
  app.on('window-all-closed', () => app.quit());
}
