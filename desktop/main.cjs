const path = require('node:path');
const { userInfo } = require('node:os');
const { app, BrowserWindow, session, ipcMain } = require('electron');
const { browserPreferences, allowsNavigation } = require('./security.cjs');
const { createJudgeBridge } = require('./judge-bridge.cjs');

const indexPath = path.join(__dirname, 'workspace', 'index.html');
// Snapshot launch opt-in; capabilities deliberately do not probe Python/Docker.
const judge = createJudgeBridge({
  indexPath,
  cliPath: app.isPackaged ? path.join(process.resourcesPath, 'judge', 'bridge_cli.py')
    : path.resolve(__dirname, '..', 'prototypes', 'docker-engine', 'bridge_cli.py'),
  home: userInfo().homedir, platform: process.platform, optIn: process.env.MECODE_EXPERIMENTAL_JUDGE,
  isPackaged: app.isPackaged,
});
app.enableSandbox();

function createWindow() {
  const win = new BrowserWindow({
    title: 'MeCode', width: 1280, height: 820, minWidth: 960, minHeight: 650,
    backgroundColor: '#121716',
    webPreferences: { ...browserPreferences(), preload: path.join(__dirname, 'preload.cjs') },
  });
  judge.bind(win.webContents);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const event of ['will-navigate', 'will-redirect']) {
    win.webContents.on(event, (e, target) => {
      if (!allowsNavigation(target, indexPath)) e.preventDefault();
    });
  }
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.loadFile(indexPath);
  return win;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  ipcMain.handle('mecode:judge:capabilities', event => judge.capabilities(event));
  ipcMain.handle('mecode:judge:run', (event, request) => judge.run(event, request));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
let quitting = false;
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  judge.shutdown().then(() => { quitting = true; app.quit(); });
});
