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

// Shown only when the user explicitly tries to close/quit and the renderer vetoes unload for
// unsaved text. Fixed text; it does not claim anything was saved. Default and cancel keep editing.
const DISCARD_PROMPT = {
  type: 'warning', buttons: ['Keep editing', 'Discard unsaved changes and quit'], defaultId: 0, cancelId: 0,
  noLink: true, title: 'MeCode', message: 'MeCode has unsaved changes.',
  detail: 'Your latest edits are not confirmed saved on this computer. Keep editing to stay in the window, '
    + 'or discard those unsaved changes and quit. Your last saved draft is kept.',
};

// Manual, main-owned recovery plus the unsaved-close choice. Loads ONLY the fixed bundled
// document; takes no URL/path from any caller. Not confinement: it replaces whatever document
// is currently shown.
function createWorkspaceRecovery({ win, indexPath, modal }) {
  let closePending = false; // 'close' emitted; renderer unload not yet decided. Reset on veto.
  let closed = false;       // actually closed: terminal, never resurrected.
  let inFlight = false;
  let prompting = false;
  let armed = false;        // set only by the explicit Discard choice, consumed by the next 'close'
  let closeDiscards = false; // the CURRENT pending close was explicitly chosen to discard
  let permitted = false;     // the explicit Discard override was applied: the close is completing
  win.on('close', () => { closePending = true; closeDiscards = armed; permitted = false; armed = false; });
  win.on('closed', () => { closed = true; closePending = false; closeDiscards = false; permitted = false; armed = false; });
  const destroyed = () => closed || win.isDestroyed() || win.webContents.isDestroyed();
  const gone = () => closePending || destroyed();

  // Fires only when the renderer vetoed unload (navigation or close). Never vetoes anything
  // itself; calls preventDefault (= let unload proceed) only for a close the user explicitly
  // chose to discard. The event carries no navigation/close identity: an ordinary navigation
  // receives no override because no close is pending, but a navigation veto coinciding with a
  // pending explicit-discard close cannot be told apart (accepted residual, not confinement).
  win.webContents.on('will-prevent-unload', event => {
    if (destroyed() || !closePending || permitted) return;
    if (closeDiscards) {
      // preventDefault = ignore the veto and let unload proceed. The close is NOT canceled, so
      // closePending stays true (Restore and late error prompts stay suppressed) until 'closed'.
      closeDiscards = false; permitted = true; event.preventDefault(); return;
    }
    closePending = false; // the close was truly vetoed: the window lives on
    if (prompting) return; // repeated close requests coalesce
    prompting = true;
    askDiscard();
  });

  async function askDiscard() {
    let choice = 0;
    try {
      const result = await modal.choose(win, DISCARD_PROMPT);
      choice = result && result.response;
    } catch { /* treated as Keep editing */ }
    prompting = false;
    if (choice !== 1 || destroyed() || closePending) return;
    armed = true;
    try { win.close(); } catch { /* window gone */ } finally { armed = false; }
  }

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
        try { await modal.choose(win, FAILURE_MESSAGE); } catch { /* bounded feedback only */ }
      }
      return 'failed';
    } finally {
      inFlight = false;
    }
  }
  return { restore };
}

module.exports = { browserPreferences, allowsNavigation, createWorkspaceRecovery };
