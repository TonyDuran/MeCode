// Main-owned replacement for dialog.showMessageBox (QA-FINAL-1: the GTK native dialog aborted the
// packaged app in the host icon/glycin loader). Shows fixed, main-authored text in a sandboxed
// child window that loads ONLY the bundled prompt.html. Not a security boundary beyond that: the
// text and button set come from main constants, the page has no scripts or links, and the only
// channel back is one integer from the modal's own main frame, accepted once.
const { browserPreferences } = require('./security.cjs');
const { pathToFileURL } = require('node:url');

const INIT = 'mecode:prompt:init';
const CHOICE = 'mecode:prompt:choice';
const MAX_TEXT = 1000;

const text = value => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : '');
const index = (value, count) => (Number.isInteger(value) && value >= 0 && value < count ? value : 0);

function normalize(options) {
  const given = options && Array.isArray(options.buttons) ? options.buttons : [];
  const buttons = given.filter(label => typeof label === 'string' && label !== '').slice(0, 2)
    .map(label => label.slice(0, 120));
  if (buttons.length === 0) buttons.push('OK');
  return {
    message: text(options && options.message), detail: text(options && options.detail), buttons,
    defaultId: index(options && options.defaultId, buttons.length),
    cancelId: index(options && options.cancelId, buttons.length), // dismissal = this choice
  };
}

function createModalDialog({ BrowserWindow, ipcMain, htmlPath, preloadPath, startupMs = 10000 }) {
  let active = null;
  const expectedUrl = pathToFileURL(htmlPath).href;

  // The single decision channel. Accepts one integer from the active modal's own main frame,
  // while it still shows the exact bundled document.
  ipcMain.on(CHOICE, (event, choice) => {
    const prompt = active;
    if (!prompt || !event || event.sender !== prompt.contents) return;
    if (event.senderFrame && event.senderFrame !== prompt.contents.mainFrame) return;
    try { if (prompt.contents.getURL() !== expectedUrl) return; } catch { return; }
    if (!Number.isInteger(choice) || choice < 0 || choice >= prompt.spec.buttons.length) return;
    prompt.finish(choice);
  });

  // Resolves {response}. Never rejects: any failure, crash or dismissal answers cancelId (Keep).
  function choose(parent, options) {
    const spec = normalize(options);
    if (active) return Promise.resolve({ response: spec.cancelId }); // coalesce: no second window
    return new Promise(resolve => {
      let done = false; let modal = null; let timer = null;
      const prompt = { spec, contents: null, finish };
      active = prompt;
      function finish(choice) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (active === prompt) active = null;
        try { if (modal && !modal.isDestroyed()) modal.destroy(); } catch { /* already gone */ }
        resolve({ response: choice });
      }
      const keep = () => finish(spec.cancelId);
      try {
        const attached = parent && typeof parent.isDestroyed === 'function' && !parent.isDestroyed();
        modal = new BrowserWindow({
          ...(attached ? { parent, modal: true } : {}),
          title: 'MeCode', width: 520, height: 300, show: false, resizable: false, minimizable: false,
          maximizable: false, fullscreenable: false, skipTaskbar: true, autoHideMenuBar: true,
          backgroundColor: '#121716',
          webPreferences: { ...browserPreferences(), preload: preloadPath, devTools: false },
        });
        const contents = modal.webContents;
        prompt.contents = contents;
        if (typeof modal.removeMenu === 'function') modal.removeMenu();
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
          contents.on(name, event => event.preventDefault());
        }
        contents.on('did-fail-load', keep);
        contents.on('render-process-gone', keep);
        contents.on('unresponsive', keep);
        modal.on('closed', keep); // title-bar close / WM close = dismissal = Keep
        // A closing parent takes its child with it; settle Keep rather than leave a pending record.
        if (attached && typeof parent.on === 'function') parent.on('closed', keep);
        contents.on('did-finish-load', () => {
          if (done) return;
          if (timer) { clearTimeout(timer); timer = null; } // reading time is never bounded into Discard
          try { contents.send(INIT, spec); modal.show(); } catch { keep(); }
        });
        timer = setTimeout(keep, startupMs); // bounded wait for the fixed page to become ready
        if (timer && typeof timer.unref === 'function') timer.unref();
        Promise.resolve(modal.loadFile(htmlPath)).catch(keep);
      } catch {
        keep();
      }
    });
  }
  return { choose };
}

module.exports = { createModalDialog, INIT, CHOICE };
