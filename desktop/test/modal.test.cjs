// Node-only unit tests for the main-owned fixed-HTML modal that replaces GTK native dialogs
// (QA-FINAL-1). These use fake Electron objects: they are NOT proof of native behavior.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createModalDialog } = require('../modal.cjs');

const DESKTOP = path.resolve(__dirname, '..');
const HTML = path.join(DESKTOP, 'prompt.html');
const PRELOAD = path.join(DESKTOP, 'prompt-preload.cjs');
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

const SPEC = {
  type: 'warning', buttons: ['Keep editing', 'Discard unsaved changes and quit'], defaultId: 0, cancelId: 0,
  title: 'MeCode', message: 'MeCode has unsaved changes.', detail: 'Fixed detail.',
};

function harness({ loadFile, throwOnCreate, startupMs } = {}) {
  const windows = []; let handler;
  class FakeWindow {
    constructor(options) {
      if (throwOnCreate) throw new Error('no display');
      this.options = options; this.events = {}; this.destroyed = false; this.shown = 0; this.menuRemoved = 0;
      this.wcEvents = {}; this.sent = []; this.loads = [];
      const self = this;
      this.webContents = {
        mainFrame: { id: 'main' },
        getURL: () => (self.url === undefined ? pathToFileURL(HTML).href : self.url),
        on(n, fn) { self.wcEvents[n] = fn; },
        setWindowOpenHandler(fn) { self.openHandler = fn; },
        send(...args) { self.sent.push(args); },
      };
      windows.push(this);
    }
    on(n, fn) { this.events[n] = fn; }
    isDestroyed() { return this.destroyed; }
    removeMenu() { this.menuRemoved += 1; }
    show() { this.shown += 1; }
    loadFile(file, ...rest) { this.loads.push([file, ...rest]); return loadFile ? loadFile(this) : Promise.resolve(); }
    destroy() { if (this.destroyed) return; this.destroyed = true; if (this.events.closed) this.events.closed(); }
  }
  const ipcMain = { on(n, fn) { assert.equal(n, 'mecode:prompt:choice'); handler = fn; } };
  const modal = createModalDialog({ BrowserWindow: FakeWindow, ipcMain, htmlPath: HTML, preloadPath: PRELOAD, startupMs });
  const parent = { isDestroyed: () => false };
  // Simulate a renderer-sent choice with an Electron-like IpcMainEvent.
  const send = (w, choice, over = {}) => handler({ sender: w.webContents, senderFrame: w.webContents.mainFrame, ...over }, choice);
  const loaded = w => { w.wcEvents['did-finish-load'](); };
  return { windows, modal, parent, send, loaded, raw: () => handler };
}

test('modal is a parented, sandboxed window loading only the fixed bundled HTML with a narrow preload', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, SPEC);
  assert.equal(h.windows.length, 1);
  const w = h.windows[0];
  assert.equal(w.options.parent, h.parent);
  assert.equal(w.options.modal, true);
  assert.equal(w.options.show, false, 'not shown until the fixed page and text are ready');
  const prefs = w.options.webPreferences;
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webviewTag, false);
  assert.equal(prefs.preload, PRELOAD);
  assert.deepEqual(w.loads, [[HTML]], 'only the fixed bundled file, no query/URL');
  assert.equal(w.menuRemoved, 1);
  assert.equal(w.openHandler().action, 'deny');
  for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
    let prevented = false; w.wcEvents[name]({ preventDefault() { prevented = true; } }, 'https://example.org/');
    assert.equal(prevented, true, name);
  }
  h.loaded(w);
  assert.equal(w.shown, 1);
  assert.deepEqual(w.sent, [['mecode:prompt:init', {
    message: SPEC.message, detail: SPEC.detail, buttons: SPEC.buttons, defaultId: 0, cancelId: 0,
  }]]);
  h.send(w, 0);
  assert.deepEqual(await p, { response: 0 });
});

test('Discard (index 1) resolves once; the modal window is destroyed; replays are ignored', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, SPEC);
  const w = h.windows[0]; h.loaded(w);
  h.send(w, 1);
  assert.deepEqual(await p, { response: 1 });
  assert.equal(w.destroyed, true);
  // Single use: later choices (even valid ones) do nothing and cannot affect a NEW prompt.
  const q = h.modal.choose(h.parent, SPEC);
  const w2 = h.windows[1]; h.loaded(w2);
  h.send(w, 1);
  let settled = false; q.then(() => { settled = true; });
  await flush(); assert.equal(settled, false, 'stale sender cannot answer a later prompt');
  h.send(w2, 0);
  assert.deepEqual(await q, { response: 0 });
});

test('choices from a wrong sender, a subframe, or with invalid values are ignored', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, SPEC);
  const w = h.windows[0]; h.loaded(w);
  let settled = false; p.then(() => { settled = true; });
  h.send(w, 1, { sender: { mainFrame: {} } });                    // another webContents
  h.send(w, 1, { senderFrame: { id: 'subframe' } });              // not the main frame
  for (const bad of [2, -1, 1.5, '1', null, undefined, {}, [1], NaN, true]) h.send(w, bad);
  h.raw()({}, 1); h.raw()(undefined, 1);
  await flush(); assert.equal(settled, false);
  h.send(w, 0);
  assert.deepEqual(await p, { response: 0 });
});

test('Help-style single button accepts only index 0', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, { type: 'info', buttons: ['OK'], title: 'MeCode', message: 'm', detail: 'd' });
  const w = h.windows[0]; h.loaded(w);
  h.send(w, 1);
  let settled = false; p.then(() => { settled = true; }); await flush(); assert.equal(settled, false);
  h.send(w, 0);
  assert.deepEqual(await p, { response: 0 });
});

test('dismissal, window close, load failure, renderer crash and creation failure all fail closed to Keep', async () => {
  const cases = {
    closed: (h, w) => w.destroy(),
    didFailLoad: (h, w) => w.wcEvents['did-fail-load'](),
    gone: (h, w) => w.wcEvents['render-process-gone'](),
    unresponsive: (h, w) => w.wcEvents.unresponsive(),
  };
  for (const [name, act] of Object.entries(cases)) {
    const h = harness();
    const p = h.modal.choose(h.parent, SPEC);
    act(h, h.windows[0]);
    assert.deepEqual(await p, { response: 0 }, name);
    assert.equal(h.windows[0].destroyed, true, `${name}: window cleaned up`);
  }
  const rejected = harness({ loadFile: () => Promise.reject(new Error('ERR_FILE_NOT_FOUND')) });
  assert.deepEqual(await rejected.modal.choose(rejected.parent, SPEC), { response: 0 }, 'loadFile rejection');
  const broken = harness({ throwOnCreate: true });
  assert.deepEqual(await broken.modal.choose(broken.parent, SPEC), { response: 0 }, 'constructor throws');
  // cancelId is honored (not hard-coded) for a dismissal.
  const h = harness();
  const p = h.modal.choose(h.parent, { ...SPEC, buttons: ['Discard', 'Keep'], cancelId: 1 });
  h.windows[0].destroy();
  assert.deepEqual(await p, { response: 1 });
});

test('a second request while one is open coalesces to Keep without opening another window', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, SPEC);
  const second = await h.modal.choose(h.parent, { ...SPEC, message: 'other' });
  assert.deepEqual(second, { response: 0 });
  assert.equal(h.windows.length, 1);
  h.loaded(h.windows[0]); h.send(h.windows[0], 1);
  assert.deepEqual(await p, { response: 1 }, 'the first prompt is unaffected');
  // After it settles a new prompt is allowed again.
  const third = h.modal.choose(h.parent, SPEC);
  assert.equal(h.windows.length, 2);
  h.windows[1].destroy(); await third;
});

test('destroyed or missing parent: no modal parenting is attempted against a dead window', async () => {
  const h = harness();
  const p = h.modal.choose({ isDestroyed: () => true }, SPEC);
  assert.equal(h.windows[0].options.parent, undefined);
  assert.equal(h.windows[0].options.modal, undefined);
  h.windows[0].destroy(); await p;
  const q = h.modal.choose(undefined, SPEC);
  assert.equal(h.windows[1].options.parent, undefined);
  h.windows[1].destroy(); await q;
});

test('only fixed text is forwarded: non-strings are dropped, lengths bounded, buttons capped at two', async () => {
  const h = harness();
  const long = 'x'.repeat(5000);
  const p = h.modal.choose(h.parent, { buttons: ['A', 'B', 'C', 7], message: long, detail: { toString() { return 'evil'; } }, defaultId: 9, cancelId: -4 });
  const w = h.windows[0]; h.loaded(w);
  const payload = w.sent[0][1];
  assert.deepEqual(payload.buttons, ['A', 'B']);
  assert.ok(payload.message.length <= 1000);
  assert.equal(payload.detail, '');
  assert.equal(payload.defaultId, 0); assert.equal(payload.cancelId, 0);
  w.destroy(); await p;
});

test('no buttons at all still yields a safe single OK-less Keep result', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, { message: 'm' });
  const w = h.windows[0]; h.loaded(w);
  assert.deepEqual(w.sent[0][1].buttons, ['OK']);
  h.send(w, 0);
  assert.deepEqual(await p, { response: 0 });
});

// ------------------------------------------------------------ fixed page + preload
test('prompt.html is a script-free, network-free, CSP-locked fixed page', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'none'/);
  assert.doesNotMatch(html, /<script|<link|<img|<iframe|<form|<a\b|\bsrc=|\bhref=|\son\w+=/i);
  assert.match(html, /id="message"/); assert.match(html, /id="detail"/); assert.match(html, /id="buttons"/);
});

function runPreload({ spec, trusted = true } = {}) {
  const sent = []; const listeners = {}; let initHandler;
  const els = {};
  const make = () => ({
    children: [], textContent: '', listeners: {}, focused: 0, type: '',
    appendChild(c) { this.children.push(c); }, focus() { this.focused += 1; },
    addEventListener(n, fn) { this.listeners[n] = fn; },
  });
  for (const id of ['message', 'detail', 'buttons']) els[id] = make();
  const document = {
    readyState: 'complete', getElementById: id => els[id], createElement: () => make(),
    addEventListener(n, fn) { listeners[n] = fn; },
  };
  vm.runInNewContext(fs.readFileSync(PRELOAD, 'utf8'), {
    document,
    require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer: { once(n, fn) { assert.equal(n, 'mecode:prompt:init'); initHandler = fn; }, send(...a) { sent.push(a); } } };
    },
  });
  if (spec) initHandler({}, spec);
  return { els, sent, listeners, trusted, click: (b, isTrusted = true) => b.listeners.click({ isTrusted }) };
}

test('preload renders the text with textContent only and sends exactly one integer choice per prompt', () => {
  const r = runPreload({ spec: { message: '<b>m</b>', detail: 'd', buttons: ['Keep', 'Discard'], defaultId: 0, cancelId: 0 } });
  assert.equal(r.els.message.textContent, '<b>m</b>');
  assert.equal(r.els.buttons.children.length, 2);
  assert.equal(r.els.buttons.children[0].focused, 1, 'default button focused');
  r.click(r.els.buttons.children[1], false);
  assert.deepEqual(r.sent, [], 'untrusted (script-generated) click ignored');
  r.click(r.els.buttons.children[1]);
  r.click(r.els.buttons.children[0]);
  assert.deepEqual(r.sent, [['mecode:prompt:choice', 1]], 'single use');
});

test('preload Escape sends the cancel index (Keep); other keys do nothing; malformed init is ignored', () => {
  const r = runPreload({ spec: { message: 'm', detail: 'd', buttons: ['Keep', 'Discard'], defaultId: 0, cancelId: 0 } });
  r.listeners.keydown({ key: 'Enter', isTrusted: true });
  r.listeners.keydown({ key: 'Escape', isTrusted: false });
  assert.deepEqual(r.sent, []);
  r.listeners.keydown({ key: 'Escape', isTrusted: true });
  assert.deepEqual(r.sent, [['mecode:prompt:choice', 0]]);
  const bad = runPreload({ spec: { message: 1, buttons: 'x' } });
  assert.equal(bad.els.buttons.children.length, 0);
});

test('preload exposes no API to the page', () => {
  const src = fs.readFileSync(PRELOAD, 'utf8');
  assert.doesNotMatch(src, /contextBridge|exposeInMainWorld|invoke\(|openExternal|require\((?!'electron')/);
});

test('every main-process module and prompt file the app loads is in the packaging allowlist', () => {
  const { ignoreAppPath } = require('../package-assets.cjs');
  const main = fs.readFileSync(path.join(DESKTOP, 'main.cjs'), 'utf8');
  const names = new Set(['prompt.html', 'prompt-preload.cjs']);
  for (const file of ['main.cjs', 'modal.cjs', 'security.cjs']) {
    for (const [, name] of fs.readFileSync(path.join(DESKTOP, file), 'utf8').matchAll(/require\('\.\/([^']+)'\)/g)) names.add(name);
  }
  for (const name of ['prompt.html', 'prompt-preload.cjs']) assert.match(main, new RegExp(name.replace('.', '\\.')));
  for (const name of names) assert.equal(ignoreAppPath(`/${name}`), false, `${name} would be missing from app.asar`);
});

test('a choice is ignored once the modal no longer shows the exact bundled document', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, SPEC);
  const w = h.windows[0]; h.loaded(w);
  let settled = false; p.then(() => { settled = true; });
  w.url = 'file:///etc/passwd'; h.send(w, 1);
  w.url = `${pathToFileURL(HTML).href}?x=1`; h.send(w, 1);
  await flush(); assert.equal(settled, false);
  w.url = undefined; h.send(w, 0);
  assert.deepEqual(await p, { response: 0 });
});

test('a page that never becomes ready times out to Keep (bounded startup); reading time is not bounded', async () => {
  const stuck = harness({ startupMs: 5, loadFile: () => new Promise(() => {}) });
  assert.deepEqual(await stuck.modal.choose(stuck.parent, SPEC), { response: 0 });
  assert.equal(stuck.windows[0].destroyed, true);
  const reading = harness({ startupMs: 5 });
  const p = reading.modal.choose(reading.parent, SPEC);
  reading.loaded(reading.windows[0]);
  let settled = false; p.then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(settled, false, 'ready prompt waits for the user');
  reading.send(reading.windows[0], 1);
  assert.deepEqual(await p, { response: 1 });
});

test('a closing parent settles the pending prompt as Keep', async () => {
  const h = harness();
  let parentClosed; const parent = { isDestroyed: () => false, on(n, fn) { if (n === 'closed') parentClosed = fn; } };
  const p = h.modal.choose(parent, SPEC);
  h.loaded(h.windows[0]);
  parentClosed();
  assert.deepEqual(await p, { response: 0 });
  assert.equal(h.windows[0].destroyed, true);
});

// ---------------------------------------------------- real lifecycle (security.cjs) + real modal.cjs
function lifecycle() {
  const { createWorkspaceRecovery } = require('../security.cjs');
  const h = harness();
  const closes = []; const loads = []; const winEvents = {}; const wcEvents = {}; let url = 'file:///x';
  const win = {
    isDestroyed: () => false, on(n, fn) { winEvents[n] = fn; },
    close() { closes.push(1); winEvents.close({}); },
    loadFile(f) { loads.push(f); return Promise.resolve(); },
    webContents: { on(n, fn) { wcEvents[n] = fn; }, getURL: () => url, isDestroyed: () => false },
  };
  const INDEX = path.join(DESKTOP, 'workspace', 'index.html');
  const recovery = createWorkspaceRecovery({ win, indexPath: INDEX, modal: h.modal });
  const bypass = () => { let n = 0; wcEvents['will-prevent-unload']({ preventDefault() { n += 1; } }); return n; };
  return { h, win, closes, loads, winEvents, recovery, bypass, setURL: u => { url = u; } };
}
const tick = async () => { await flush(); await new Promise(r => setImmediate(r)); await flush(); };

test('real lifecycle: repeated close requests open ONE modal; Keep leaves the window and Restore usable', async () => {
  const l = lifecycle();
  for (let i = 0; i < 3; i++) { l.winEvents.close({}); l.bypass(); }
  await tick();
  assert.equal(l.h.windows.length, 1, 'coalesced to one prompt window');
  assert.equal(l.h.windows[0].options.parent, l.win);
  l.h.loaded(l.h.windows[0]);
  assert.deepEqual(l.h.windows[0].sent[0][1].buttons, ['Keep editing', 'Discard unsaved changes and quit']);
  l.h.send(l.h.windows[0], 0); await tick();
  assert.equal(l.closes.length, 0, 'Keep never closes');
  l.setURL('about:blank');
  assert.equal(await l.recovery.restore(), 'restored', 'Restore eligible after Keep');
});

test('real lifecycle: pending close suppresses Restore; first-choice Discard re-closes exactly once', async () => {
  const l = lifecycle();
  l.setURL('about:blank');
  l.winEvents.close({}); assert.equal(await l.recovery.restore(), 'skipped', 'close pending: Restore skipped');
  assert.equal(l.bypass(), 0, 'original veto honored'); await tick();
  const w = l.h.windows[0]; l.h.loaded(w);
  assert.equal(await l.recovery.restore(), 'restored', 'veto reset pending close while the prompt is open');
  l.h.send(w, 1); await tick();                       // FIRST prompt, Discard
  assert.equal(l.closes.length, 1, 'exactly one re-issued close');
  assert.equal(l.bypass(), 1, 'only that close overrides the unload veto');
  assert.equal(l.bypass(), 0, 'allowance consumed');
  assert.equal(await l.recovery.restore(), 'skipped', 'closing guard retained until closed');
  assert.equal(w.destroyed, true, 'modal disposed before the close was re-issued');
});

test('real lifecycle: modal X / failure is Keep and never discards', async () => {
  for (const act of [w => w.destroy(), w => w.wcEvents['did-fail-load'](), w => w.wcEvents['render-process-gone']()]) {
    const l = lifecycle();
    l.winEvents.close({}); l.bypass(); await tick();
    act(l.h.windows[0]); await tick();
    assert.equal(l.closes.length, 0);
  }
});

test('real lifecycle: Restore failure feedback uses the modal and does not stack with a close prompt', async () => {
  const { createWorkspaceRecovery } = require('../security.cjs');
  const h = harness();
  const winEvents = {}; const wcEvents = {};
  const win = { isDestroyed: () => false, on(n, fn) { winEvents[n] = fn; }, close() {},
    loadFile: () => Promise.reject(new Error('/secret ERR')),
    webContents: { on(n, fn) { wcEvents[n] = fn; }, getURL: () => 'about:blank', isDestroyed: () => false } };
  const recovery = createWorkspaceRecovery({ win, indexPath: path.join(DESKTOP, 'workspace', 'index.html'), modal: h.modal });
  const pending = recovery.restore(); await tick();
  assert.equal(h.windows.length, 1);
  assert.doesNotMatch(JSON.stringify(h.windows[0].sent || []), /secret|ERR/);
  h.loaded(h.windows[0]);
  assert.match(JSON.stringify(h.windows[0].sent), /Could not restore/);
  winEvents.close({}); wcEvents['will-prevent-unload']({ preventDefault() {} }); await tick();
  assert.equal(h.windows.length, 1, 'no second window while feedback is open');
  h.send(h.windows[0], 0);
  assert.equal(await pending, 'failed');
});
