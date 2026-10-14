const { pathToFileURL } = require('node:url');

function browserPreferences() {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    // Dropped files must never navigate the workspace document.
    navigateOnDragDrop: false,
  };
}

function allowsNavigation(target, indexPath) {
  try {
    const actual = new URL(target);
    actual.hash = '';
    return actual.href === pathToFileURL(indexPath).href;
  } catch {
    return false;
  }
}

const FAILURE_MESSAGE = {
  type: 'error', buttons: ['OK'], title: 'MeCode',
  message: 'Could not restore the saved workspace.',
  detail: 'Try Restore saved workspace again, or quit and reopen MeCode. Your last saved draft is kept on this computer.',
};

// Manual, main-owned recovery. Loads ONLY the fixed bundled document; takes no URL/path
// from any caller. Not confinement: it replaces whatever document is currently shown.
function createWorkspaceRecovery({ win, indexPath, dialog }) {
  let closing = false;
  let inFlight = false;
  win.on('close', () => { closing = true; });
  win.on('closed', () => { closing = true; });
  const gone = () => closing || win.isDestroyed() || win.webContents.isDestroyed();

  async function restore() {
    if (gone() || inFlight) return 'skipped';
    let url;
    try { url = win.webContents.getURL(); } catch { return 'skipped'; }
    if (allowsNavigation(url, indexPath)) return 'at_workspace';
    inFlight = true; // set before awaiting so repeated activation coalesces
    try {
      await win.loadFile(indexPath);
      return 'restored';
    } catch {
      if (!gone()) {
        try { await dialog.showMessageBox(win, FAILURE_MESSAGE); } catch { /* bounded feedback only */ }
      }
      return 'failed';
    } finally {
      inFlight = false;
    }
  }
  return { restore };
}

module.exports = { browserPreferences, allowsNavigation, createWorkspaceRecovery };
