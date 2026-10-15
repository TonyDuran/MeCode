// Main-owned replacement for dialog.showMessageBox (QA-FINAL-1: the GTK native dialog aborted the
// packaged app in the host icon/glycin loader). Shows fixed, main-authored text in a sandboxed
// child window that loads ONLY the bundled prompt.html, in a dedicated in-memory session that
// denies every permission and every request except that one document. Not a hostile-content
// boundary: the text, button set and mode come from main constants, the page has no scripts or
// links, and the only channels back are two payload-limited messages from that window's live main
// frame at the exact bundled URL: a one-time readiness ack, then one integer choice, accepted once.
// Anything unexpected (preload failure, no ack, child/parent document replacement, renderer loss,
// dead owner) settles Keep (cancelId); there is never a native-dialog or unparented fallback.
const { browserPreferences } = require('./security.cjs');
const { pathToFileURL } = require('node:url');

const INIT = 'mecode:prompt:init';
const READY = 'mecode:prompt:ready';
const CHOICE = 'mecode:prompt:choice';
const MAX_TEXT = 1000;

const text = value => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : '');
const index = (value, count) => (Number.isInteger(value) && value >= 0 && value < count ? value : 0);
const replaced = details => Boolean(details && details.isMainFrame && !details.isSameDocument);

function normalize(options) {
  const given = options && Array.isArray(options.buttons) ? options.buttons : [];
  const buttons = given.filter(label => typeof label === 'string' && label !== '').slice(0, 2)
    .map(label => label.slice(0, 120));
  if (buttons.length === 0) buttons.push('OK');
  return {
    message: text(options && options.message), detail: text(options && options.detail), buttons,
    defaultId: index(options && options.defaultId, buttons.length),
    cancelId: index(options && options.cancelId, buttons.length), // dismissal = this choice
    // Fixed main-only mode ('discard' outranks informational feedback). Never sent to the page.
    mode: options && options.mode === 'discard' ? 'discard' : 'info',
  };
}

function createModalDialog({ BrowserWindow, ipcMain, htmlPath, preloadPath, createSession, startupMs = 10000 }) {
  let active = null;
  let promptSession = null;
  const expectedUrl = pathToFileURL(htmlPath).href;
  const isExpected = value => { try { return new URL(value).href === expectedUrl; } catch { return false; } };
  const liveOwner = owner => {
    try { return Boolean(owner && typeof owner.isDestroyed === 'function' && !owner.isDestroyed() && typeof owner.on === 'function'); } catch { return false; }
  };

  // One dedicated, nonpersistent session: deny all permissions; allow only the bundled document.
  function dedicatedSession() {
    if (promptSession) return promptSession;
    if (typeof createSession !== 'function') throw new Error('no prompt session');
    const ses = createSession();
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isExpected(details && details.url) }));
    promptSession = ses;
    return ses;
  }

  // Authenticates an IPC event as coming from the active prompt's live main frame, at the exact
  // bundled document, with a live owner. Returns the prompt or null. Never consumes the prompt.
  function authentic(event) {
    const prompt = active;
    if (!prompt || !event || event.sender !== prompt.contents) return null;
    try {
      if (prompt.modal.isDestroyed()) return null;
      const frame = event.senderFrame;
      if (!frame || frame !== prompt.contents.mainFrame || frame.detached === true) return null;
      if (!isExpected(frame.url) || !isExpected(prompt.contents.getURL())) return null;
    } catch { return null; }
    if (!liveOwner(prompt.owner)) { prompt.keep(); return null; }
    return prompt;
  }

  ipcMain.on(READY, event => {
    const prompt = authentic(event);
    if (!prompt || !prompt.initSent || prompt.ready) return;
    prompt.becomeReady();
  });

  ipcMain.on(CHOICE, (event, choice) => {
    const prompt = authentic(event);
    if (!prompt || !prompt.ready) return;
    if (!Number.isInteger(choice) || choice < 0 || choice >= prompt.spec.buttons.length) return;
    prompt.finish(choice);
  });

  // Resolves {response}. Never rejects: any failure, crash or dismissal answers cancelId (Keep).
  function choose(owner, options) {
    const spec = normalize(options);
    const keepResult = Promise.resolve({ response: spec.cancelId });
    if (!liveOwner(owner)) return keepResult; // never an unparented prompt
    if (active) {
      // A close decision supersedes informational feedback; nothing else replaces a pending prompt.
      if (spec.mode === 'discard' && active.spec.mode !== 'discard') active.keep();
      else return keepResult;
    }
    return new Promise(resolve => {
      let done = false; let modal = null; let timer = null;
      const detach = [];
      const prompt = { spec, owner, modal: null, contents: null, initSent: false, ready: false, finish, keep: () => finish(spec.cancelId), becomeReady };
      active = prompt;
      const on = (emitter, name, fn) => {
        if (!emitter || typeof emitter.on !== 'function') return;
        emitter.on(name, fn);
        detach.push(() => { try { emitter.removeListener(name, fn); } catch { /* already gone */ } });
      };
      function finish(choice) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (active === prompt) active = null;
        for (const release of detach.splice(0)) release(); // only this prompt's own listeners
        try { if (modal && !modal.isDestroyed()) modal.destroy(); } catch { /* already gone */ }
        resolve({ response: choice });
      }
      function becomeReady() {
        prompt.ready = true;
        if (timer) { clearTimeout(timer); timer = null; } // reading time is never bounded into Discard
        try { modal.show(); } catch { finish(spec.cancelId); }
      }
      const keep = prompt.keep;
      try {
        const ses = dedicatedSession();
        modal = new BrowserWindow({
          parent: owner, modal: true,
          title: 'MeCode', width: 520, height: 300, show: false, resizable: false, minimizable: false,
          maximizable: false, fullscreenable: false, skipTaskbar: true, autoHideMenuBar: true,
          backgroundColor: '#121716',
          webPreferences: { ...browserPreferences(), preload: preloadPath, devTools: false, session: ses },
        });
        prompt.modal = modal;
        const contents = modal.webContents;
        prompt.contents = contents;
        if (typeof modal.removeMenu === 'function') modal.removeMenu();
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
          on(contents, name, event => event.preventDefault());
        }
        on(contents, 'did-fail-load', keep);
        on(contents, 'preload-error', keep);
        on(contents, 'render-process-gone', keep);
        on(contents, 'unresponsive', keep);
        // After the first load, any further main-frame document replacement of the child is terminal.
        let loadedOnce = false;
        on(contents, 'did-start-navigation', details => { if (loadedOnce && replaced(details)) keep(); });
        on(contents, 'did-finish-load', () => {
          if (done) return;
          if (loadedOnce) { keep(); return; }
          loadedOnce = true;
          // Shown only after the preload acknowledges that the fixed UI initialized (READY).
          try {
            const { mode: _mode, ...payload } = spec; // the mode stays in main
            contents.send(INIT, payload); prompt.initSent = true;
          } catch { keep(); }
        });
        on(modal, 'closed', keep); // title-bar close / WM close = dismissal = Keep
        // Consent belongs to the parent document it was asked about: owner loss, parent renderer
        // loss or any main-frame replacement (including a same-URL reload) settles Keep.
        on(owner, 'closed', keep);
        const parentContents = owner.webContents;
        on(parentContents, 'did-start-navigation', details => { if (replaced(details)) keep(); });
        on(parentContents, 'render-process-gone', keep);
        on(parentContents, 'destroyed', keep);
        timer = setTimeout(keep, startupMs); // bounded wait for load + readiness ack
        if (timer && typeof timer.unref === 'function') timer.unref();
        Promise.resolve(modal.loadFile(htmlPath)).catch(keep);
      } catch {
        keep();
      }
    });
  }
  return { choose };
}

module.exports = { createModalDialog, INIT, READY, CHOICE };
