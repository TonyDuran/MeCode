const path = require('node:path');
const { userInfo } = require('node:os');
const { app, BrowserWindow, session, ipcMain, Menu } = require('electron');
const { browserPreferences, allowsNavigation, createWorkspaceRecovery } = require('./security.cjs');
const { createJudgeBridge } = require('./judge-bridge.cjs');
const { createModalDialog } = require('./modal.cjs');

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

let recovery = null;
let mainWin = null; // the live workspace window: the explicit owner for Help (never a missing/foreign focus)
let modal = null; // main-owned fixed-HTML prompts; GTK native dialogs abort the packaged app (QA-FINAL-1)
const RECOVERY_HELP = {
  type: 'info', buttons: ['OK'], title: 'MeCode',
  message: 'Restore saved workspace',
  detail: 'If the window ever shows something other than the MeCode workspace, choose File > Restore saved workspace '
    + '(Ctrl+Shift+R). It reloads the bundled workspace with your LAST SAVED draft and theme. '
    + 'Unsaved edits made just before the page changed may be lost. A previous Run result is not restored.',
};

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      // Fixed action: ignores any menu/renderer arguments.
      { label: 'Restore saved workspace', accelerator: 'CmdOrCtrl+Shift+R', click: () => { if (recovery) recovery.restore(); } },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'Help', submenu: [
      // Owner is always the live workspace window; with none alive, choose() shows nothing.
      { label: 'About saved-workspace recovery', click: () => {
        if (modal && mainWin && !mainWin.isDestroyed()) modal.choose(mainWin, RECOVERY_HELP).catch(() => {});
      } },
    ] },
  ]));
}

function createWindow() {
  const win = new BrowserWindow({
    title: 'MeCode', width: 1280, height: 820, minWidth: 960, minHeight: 650,
    backgroundColor: '#121716',
    webPreferences: { ...browserPreferences(), preload: path.join(__dirname, 'preload.cjs') },
  });
  judge.bind(win.webContents);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Defense in depth only: these events are not delivered for every document replacement.
  for (const event of ['will-navigate', 'will-redirect']) {
    win.webContents.on(event, (e, target) => {
      if (!allowsNavigation(target, indexPath)) e.preventDefault();
    });
  }
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  recovery = createWorkspaceRecovery({ win, indexPath, modal });
  mainWin = win;
  win.loadFile(indexPath);
  return win;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  modal = createModalDialog({ BrowserWindow, ipcMain, htmlPath: path.join(__dirname, 'prompt.html'),
    preloadPath: path.join(__dirname, 'prompt-preload.cjs'),
    // Dedicated nonpersistent session (no 'persist:' prefix): never the workspace's default session.
    createSession: () => session.fromPartition('mecode-prompt') });
  ipcMain.handle('mecode:judge:capabilities', event => judge.capabilities(event));
  ipcMain.handle('mecode:judge:run', (event, request) => judge.run(event, request));
  installMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
let quitting = false; // the drain finished and the resumed quit was issued
let draining = false; // a drain is in flight: later requests share it instead of starting another
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  if (draining) return;
  draining = true;
  judge.shutdown().then(() => { quitting = true; app.quit(); });
});
