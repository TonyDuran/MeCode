const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { browserPreferences, allowsNavigation } = require('./security.cjs');

const indexPath = path.join(__dirname, 'workspace', 'index.html');
app.enableSandbox();

function createWindow() {
  const win = new BrowserWindow({
    title: 'MeCode', width: 1280, height: 820, minWidth: 960, minHeight: 650,
    backgroundColor: '#121716',
    webPreferences: browserPreferences(),
  });
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
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
