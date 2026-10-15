// Node-only unit tests for the main-owned fixed-HTML modal that replaces GTK native dialogs
// (QA-FINAL-1). These use fake Electron objects with real EventEmitter semantics: they are NOT
// proof of native behavior.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createModalDialog } = require('../modal.cjs');

const DESKTOP = path.resolve(__dirname, '..');
const HTML = path.join(DESKTOP, 'prompt.html');
const PRELOAD = path.join(DESKTOP, 'prompt-preload.cjs');
const ASSET = pathToFileURL(HTML).href;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const tick = async () => { await flush(); await new Promise(r => setImmediate(r)); await flush(); };
const NAV = { isMainFrame: true, isSameDocument: false };

const SPEC = {
  type: 'warning', buttons: ['Keep editing', 'Discard unsaved changes and quit'], defaultId: 0, cancelId: 0,
  mode: 'discard', title: 'MeCode', message: 'MeCode has unsaved changes.', detail: 'Fixed detail.',
};
const INFO = { type: 'info', buttons: ['OK'], title: 'MeCode', message: 'help', detail: 'd' };

const emitters = em => new Proxy({}, { get: (_t, name) => (...a) => em.emit(name, ...a) });

function makeParent() {
  const parent = new EventEmitter();
  parent.dead = false;
  parent.isDestroyed = () => parent.dead;
  parent.webContents = new EventEmitter();
  parent.destroy = () => { parent.dead = true; parent.emit('closed'); };
  return parent;
}
const counts = parent => ({
  closed: parent.listenerCount('closed'),
  nav: parent.webContents.listenerCount('did-start-navigation'),
  gone: parent.webContents.listenerCount('render-process-gone'),
  destroyed: parent.webContents.listenerCount('destroyed'),
});

function fakeSession() {
  const ses = { id: 'prompt-session' };
  ses.setPermissionRequestHandler = fn => { ses.request = fn; };
  ses.setPermissionCheckHandler = fn => { ses.check = fn; };
  ses.webRequest = { onBeforeRequest: fn => { ses.before = fn; } };
  return ses;
}

function harness({ loadFile, throwOnCreate, startupMs, createSession } = {}) {
  const windows = []; const handlers = {}; const session = fakeSession(); const sessionCalls = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      if (throwOnCreate) throw new Error('no display');
      this.options = options; this.destroyed = false; this.shown = 0; this.menuRemoved = 0;
      this.sent = []; this.loads = [];
      const self = this;
      const wc = new EventEmitter();
      wc.mainFrame = { id: 'main', get url() { return self.frameUrl === undefined ? wc.getURL() : self.frameUrl; } };
      wc.getURL = () => (self.url === undefined ? ASSET : self.url);
      wc.setWindowOpenHandler = fn => { self.openHandler = fn; };
      wc.send = (...args) => { self.sent.push(args); };
      this.webContents = wc; this.wcEvents = emitters(wc); this.events = emitters(this);
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    removeMenu() { this.menuRemoved += 1; }
    show() { this.shown += 1; }
    loadFile(file, ...rest) { this.loads.push([file, ...rest]); return loadFile ? loadFile(this) : Promise.resolve(); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  }
  const ipcMain = { on(n, fn) { handlers[n] = fn; } };
  const modal = createModalDialog({
    BrowserWindow: FakeWindow, ipcMain, htmlPath: HTML, preloadPath: PRELOAD, startupMs,
    createSession: createSession === undefined ? () => { sessionCalls.push(1); return session; } : createSession,
  });
  const parent = makeParent();
  const evt = (w, over) => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame, ...over });
  // Simulate a renderer-sent choice / readiness ack with an Electron-like IpcMainEvent.
  const send = (w, choice, over = {}) => handlers['mecode:prompt:choice'](evt(w, over), choice);
  const ack = (w, over = {}) => { if (handlers['mecode:prompt:ready']) handlers['mecode:prompt:ready'](evt(w, over)); };
  const finishLoad = w => { w.wcEvents['did-finish-load'](); };
  const loaded = w => { finishLoad(w); ack(w); }; // healthy preload: INIT rendered, ready acknowledged
  return { windows, modal, parent, send, ack, finishLoad, loaded, session, sessionCalls, raw: () => handlers['mecode:prompt:choice'], handlers };
}
const pending = p => { const box = { settled: false, value: undefined }; p.then(v => { box.settled = true; box.value = v; }); return box; };

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
  const box = pending(q);
  await flush(); assert.equal(box.settled, false, 'stale sender cannot answer a later prompt');
  h.send(w2, 0);
  assert.deepEqual(await q, { response: 0 });
});

test('choices from a wrong sender, a subframe, or with invalid values are ignored', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, SPEC);
  const w = h.windows[0]; h.loaded(w);
  const box = pending(p);
  h.send(w, 1, { sender: { mainFrame: {} } });                    // another webContents
  h.send(w, 1, { senderFrame: { id: 'subframe', url: ASSET } });  // not the main frame
  for (const bad of [2, -1, 1.5, '1', null, undefined, {}, [1], NaN, true]) h.send(w, bad);
  h.raw()({}, 1); h.raw()(undefined, 1);
  await flush(); assert.equal(box.settled, false);
  h.send(w, 0);
  assert.deepEqual(await p, { response: 0 });
});

test('Help-style single button accepts only index 0', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, INFO);
  const w = h.windows[0]; h.loaded(w);
  h.send(w, 1);
  const box = pending(p); await flush(); assert.equal(box.settled, false);
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
  assert.equal('mode' in payload, false, 'the mode is main-only and never sent to the page');
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

function runPreload({ spec, breakCreate = false } = {}) {
  const sent = []; const listeners = {}; let initHandler;
  const els = {};
  const make = () => ({
    children: [], textContent: '', listeners: {}, focused: 0, type: '',
    appendChild(c) { this.children.push(c); }, focus() { this.focused += 1; },
    addEventListener(n, fn) { this.listeners[n] = fn; },
  });
  for (const id of ['message', 'detail', 'buttons']) els[id] = make();
  const document = {
    readyState: 'complete', getElementById: id => els[id],
    createElement: () => { if (breakCreate) throw new Error('boom'); return make(); },
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
  return { els, sent, listeners, click: (b, isTrusted = true) => b.listeners.click({ isTrusted }) };
}
const READY = ['mecode:prompt:ready'];
const GOOD = { message: 'm', detail: 'd', buttons: ['Keep', 'Discard'], defaultId: 0, cancelId: 0 };

test('preload renders the text with textContent only and sends exactly one integer choice per prompt', () => {
  const r = runPreload({ spec: { ...GOOD, message: '<b>m</b>' } });
  assert.equal(r.els.message.textContent, '<b>m</b>');
  assert.equal(r.els.buttons.children.length, 2);
  assert.equal(r.els.buttons.children[0].focused, 1, 'default button focused');
  r.click(r.els.buttons.children[1], false);
  assert.deepEqual(r.sent, [READY], 'untrusted (script-generated) click ignored');
  r.click(r.els.buttons.children[1]);
  r.click(r.els.buttons.children[0]);
  assert.deepEqual(r.sent, [READY, ['mecode:prompt:choice', 1]], 'single use');
});

test('preload Escape sends the cancel index (Keep); other keys do nothing; malformed init is ignored', () => {
  const r = runPreload({ spec: GOOD });
  r.listeners.keydown({ key: 'Enter', isTrusted: true });
  r.listeners.keydown({ key: 'Escape', isTrusted: false });
  assert.deepEqual(r.sent, [READY]);
  r.listeners.keydown({ key: 'Escape', isTrusted: true });
  assert.deepEqual(r.sent, [READY, ['mecode:prompt:choice', 0]]);
  const bad = runPreload({ spec: { message: 1, buttons: 'x' } });
  assert.equal(bad.els.buttons.children.length, 0);
});

test('MF-3 preload acknowledges readiness only after the fixed UI initialized; failures send no ack', () => {
  const ok = runPreload({ spec: GOOD });
  assert.deepEqual(ok.sent, [READY], 'one payload-free ack after rendering');
  assert.equal(ok.els.buttons.children[0].focused, 1, 'ack follows focus');
  assert.deepEqual(runPreload({ spec: { message: 1, buttons: 'x' } }).sent, [], 'malformed init: no ack');
  assert.deepEqual(runPreload({ spec: GOOD, breakCreate: true }).sent, [], 'initialization exception: no ack');
  assert.deepEqual(runPreload({ spec: { ...GOOD, defaultId: 7 } }).sent, [], 'no focusable default: no ack');
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
  const box = pending(p);
  w.url = 'file:///etc/passwd'; h.send(w, 1);
  w.url = `${ASSET}?x=1`; h.send(w, 1);
  await flush(); assert.equal(box.settled, false);
  w.url = undefined; h.send(w, 0);
  assert.deepEqual(await p, { response: 0 });
});

test('a page that never becomes ready times out to Keep (bounded startup); reading time is not bounded', async () => {
  const stuck = harness({ startupMs: 5, loadFile: () => new Promise(() => {}) });
  const stuckResult = stuck.modal.choose(stuck.parent, SPEC);
  // Production unrefs its startup timer; keep this test's clock referenced on Node 22 CI.
  await new Promise(r => setTimeout(r, 15));
  assert.deepEqual(await stuckResult, { response: 0 });
  assert.equal(stuck.windows[0].destroyed, true);
  const reading = harness({ startupMs: 5 });
  const p = reading.modal.choose(reading.parent, SPEC);
  reading.loaded(reading.windows[0]);
  const box = pending(p);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(box.settled, false, 'ready prompt waits for the user');
  reading.send(reading.windows[0], 1);
  assert.deepEqual(await p, { response: 1 });
});

test('a closing parent settles the pending prompt as Keep', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, SPEC);
  h.loaded(h.windows[0]);
  h.parent.destroy();
  assert.deepEqual(await p, { response: 0 });
  assert.equal(h.windows[0].destroyed, true);
});

// ---------------------------------------------------------------- MF-1 frame authentication
test('MF-1 a missing, stale, detached or wrong-URL sender frame never answers; rejected input is not consumed', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, SPEC);
  const w = h.windows[0]; h.loaded(w);
  const box = pending(p);
  h.send(w, 1, { senderFrame: null });
  h.send(w, 1, { senderFrame: undefined });
  h.send(w, 1, { senderFrame: {} });
  h.send(w, 1, { senderFrame: { id: 'main', url: ASSET } });                 // a different (stale) frame object
  w.webContents.mainFrame.detached = true; h.send(w, 1); w.webContents.mainFrame.detached = false;
  w.frameUrl = 'https://example.org/'; h.send(w, 1);                          // frame URL differs, document URL still matches
  w.frameUrl = `${ASSET}?x=1`; h.send(w, 1);
  w.frameUrl = undefined;
  await flush(); assert.equal(box.settled, false);
  h.send(w, 1);                                                               // the genuine live main frame still works
  assert.deepEqual(await p, { response: 1 });
});

test('MF-1 a choice or ready ack before readiness, or replayed after settling, is ignored', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, SPEC);
  const w = h.windows[0]; h.finishLoad(w);
  const box = pending(p);
  h.send(w, 1);                                                               // not ready yet
  await flush(); assert.equal(box.settled, false, 'choice before ready ack is ignored');
  h.ack(w, { senderFrame: null }); h.ack(w, { sender: {} });
  assert.equal(w.shown, 0, 'spoofed acks do not show the prompt');
  h.ack(w);
  assert.equal(w.shown, 1);
  h.ack(w); assert.equal(w.shown, 1, 'replayed ready does not re-show');
  h.send(w, 1);
  assert.deepEqual(await p, { response: 1 });
  h.ack(w); h.send(w, 1);                                                      // replay after settle: nothing active
});

// ---------------------------------------------------------------- MF-3 readiness / failure
test('MF-3 the prompt is shown only after the preload acknowledges; missing acknowledgment times out to Keep', async () => {
  const h = harness({ startupMs: 15 });
  const p = h.modal.choose(h.parent, SPEC);
  const w = h.windows[0];
  h.finishLoad(w);
  assert.equal(w.sent.length, 1, 'INIT sent');
  assert.equal(w.shown, 0, 'not shown on did-finish-load alone');
  assert.deepEqual(await p, { response: 0 });                                  // no ack: bounded startup still applies
  assert.equal(w.destroyed, true); assert.equal(w.shown, 0);
});

test('MF-3 preload-error settles Keep and disposes the child even if the page later finishes loading', async () => {
  const h = harness({ startupMs: 15 });
  const p = h.modal.choose(h.parent, SPEC);
  const w = h.windows[0];
  w.wcEvents['preload-error']({}, PRELOAD, new Error('missing'));
  assert.deepEqual(await p, { response: 0 });
  assert.equal(w.destroyed, true);
  h.loaded(w); assert.equal(w.shown, 0);
});

test('MF-3 unexpected child document replacement, a second load, or renderer loss after readiness is Keep', async () => {
  const cases = {
    navigation: w => w.wcEvents['did-start-navigation'](NAV),
    reload: w => w.wcEvents['did-finish-load'](),
    gone: w => w.wcEvents['render-process-gone'](),
  };
  for (const [name, act] of Object.entries(cases)) {
    const h = harness();
    const p = h.modal.choose(h.parent, SPEC);
    const w = h.windows[0]; h.loaded(w);
    act(w);
    assert.deepEqual(await p, { response: 0 }, name);
    assert.equal(w.destroyed, true, name);
    h.send(w, 1);
  }
  const h = harness();
  const p = h.modal.choose(h.parent, SPEC);
  const w = h.windows[0]; h.loaded(w);
  w.wcEvents['did-start-navigation']({ isMainFrame: true, isSameDocument: true });
  w.wcEvents['did-start-navigation']({ isMainFrame: false, isSameDocument: false });
  const box = pending(p); await flush(); assert.equal(box.settled, false, 'same-document / subframe events are not replacement');
  h.send(w, 0); await p;
});

// ---------------------------------------------------------------- MF-2 parent generation
test('MF-2 a main-frame parent navigation (including same-URL reload) settles Keep; same-document changes do not', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, SPEC);
  const w = h.windows[0]; h.loaded(w);
  h.parent.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  h.parent.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  const box = pending(p); await flush(); assert.equal(box.settled, false);
  h.parent.webContents.emit('did-start-navigation', { ...NAV, url: 'file:///same/url/reload' });
  assert.deepEqual(await p, { response: 0 });
  assert.equal(w.destroyed, true);
  h.send(w, 1);
  const q = h.modal.choose(h.parent, SPEC); h.windows[1].destroy(); await q;
});

test('MF-2 parent renderer loss or webContents destruction settles Keep', async () => {
  for (const name of ['render-process-gone', 'destroyed']) {
    const h = harness();
    const p = h.modal.choose(h.parent, SPEC);
    h.loaded(h.windows[0]);
    h.parent.webContents.emit(name);
    assert.deepEqual(await p, { response: 0 }, name);
    assert.equal(h.windows[0].destroyed, true);
  }
});

// ---------------------------------------------------------------- MF-4 listener lifecycle / owner
test('MF-4 every settle path detaches only this prompt\'s listeners (real EventEmitter counts)', async () => {
  const paths = {
    keep: (h, w) => h.send(w, 0),
    discard: (h, w) => h.send(w, 1),
    x: (h, w) => w.destroy(),
    failure: (h, w) => w.wcEvents['did-fail-load'](),
    crash: (h, w) => w.wcEvents['render-process-gone'](),
    navigation: (h, w) => h.parent.webContents.emit('did-start-navigation', NAV),
    timeout: () => {},
  };
  for (const [name, act] of Object.entries(paths)) {
    const h = harness({ startupMs: 5 });
    h.parent.on('closed', () => {}); // an unrelated owner listener (e.g. recovery) must survive
    const before = counts(h.parent);
    for (let round = 0; round < 3; round++) {
      const p = h.modal.choose(h.parent, SPEC);
      const w = h.windows[h.windows.length - 1];
      if (name !== 'timeout') h.loaded(w);
      act(h, w);
      await p;
      assert.equal(w.listenerCount('closed'), 0, `${name}: child window listeners released`);
      assert.equal(w.webContents.listenerCount('did-finish-load'), 0, `${name}: child contents listeners released`);
    }
    assert.deepEqual(counts(h.parent), before, `${name}: parent listener counts back to baseline after repeats`);
    assert.equal(h.parent.listenerCount('closed'), 1, `${name}: unrelated owner listener preserved`);
  }
});

test('MF-4 a missing or destroyed owner never creates an unparented prompt window', async () => {
  const h = harness();
  assert.deepEqual(await h.modal.choose(undefined, SPEC), { response: 0 });
  assert.deepEqual(await h.modal.choose(null, SPEC), { response: 0 });
  const dead = makeParent(); dead.dead = true;
  assert.deepEqual(await h.modal.choose(dead, SPEC), { response: 0 });
  assert.deepEqual(await h.modal.choose({}, SPEC), { response: 0 });
  assert.deepEqual(await h.modal.choose(undefined, { ...SPEC, buttons: ['Discard', 'Keep'], cancelId: 1 }), { response: 1 });
  assert.equal(h.windows.length, 0, 'no window of any kind');
});

test('MF-4 owner destroyed during startup or before the decision is Keep, never Discard', async () => {
  const h = harness();
  const p = h.modal.choose(h.parent, SPEC);
  h.parent.destroy();
  assert.deepEqual(await p, { response: 0 });
  assert.equal(h.windows[0].destroyed, true);
  const owner = makeParent();
  const q = h.modal.choose(owner, SPEC);
  const w = h.windows[1]; h.loaded(w);
  owner.dead = true;                                                              // dies without an event reaching us first
  h.send(w, 1);
  assert.deepEqual(await q, { response: 0 }, 'decision-time owner liveness check');
  assert.equal(w.destroyed, true);
});

// ---------------------------------------------------------------- MF-5 discard precedence
test('MF-5 a Discard request supersedes pending Help/error feedback with exactly one live child', async () => {
  const h = harness();
  const help = h.modal.choose(h.parent, INFO);
  const hw = h.windows[0]; h.loaded(hw);
  const discard = h.modal.choose(h.parent, SPEC);
  assert.deepEqual(await help, { response: 0 }, 'information is dismissed');
  assert.equal(hw.destroyed, true);
  assert.equal(h.windows.length, 2);
  const dw = h.windows[1]; h.loaded(dw);
  assert.equal(dw.sent[0][1].buttons[1], SPEC.buttons[1]);
  h.send(hw, 0);                                                                  // stale help child cannot answer
  const box = pending(discard); await flush(); assert.equal(box.settled, false);
  h.send(dw, 1);
  assert.deepEqual(await discard, { response: 1 });
});

test('MF-5 information never replaces a pending Discard; repeated Discard requests coalesce', async () => {
  const h = harness();
  const discard = h.modal.choose(h.parent, SPEC);
  const dw = h.windows[0]; h.loaded(dw);
  assert.deepEqual(await h.modal.choose(h.parent, INFO), { response: 0 });
  assert.deepEqual(await h.modal.choose(h.parent, SPEC), { response: 0 });
  assert.equal(h.windows.length, 1); assert.equal(dw.destroyed, false);
  h.send(dw, 1);
  assert.deepEqual(await discard, { response: 1 });
});

test('MF-5 the mode is main-supplied only: a renderer value cannot turn feedback into a discard', async () => {
  const h = harness();
  const help = h.modal.choose(h.parent, { ...INFO, mode: 'info' });
  const w = h.windows[0]; h.loaded(w);
  h.send(w, 1);                                                                   // info prompt has a single button
  const box = pending(help); await flush(); assert.equal(box.settled, false);
  h.send(w, 0); assert.deepEqual(await help, { response: 0 });
});

// ---------------------------------------------------------------- MF-6 session isolation
test('MF-6 the prompt uses one dedicated session with deny-all permissions and exact-resource requests, configured before load', async () => {
  let configuredBeforeLoad = false;
  const h = harness({ loadFile: () => { configuredBeforeLoad = Boolean(h.session.request && h.session.check && h.session.before); return Promise.resolve(); } });
  const p = h.modal.choose(h.parent, SPEC);
  const w = h.windows[0];
  assert.equal(w.options.webPreferences.session, h.session);
  assert.equal(configuredBeforeLoad, true);
  assert.equal(w.options.webPreferences.partition, undefined);
  let allowed = 'unset'; h.session.request({}, 'notifications', v => { allowed = v; });
  assert.equal(allowed, false); assert.equal(h.session.check({}, 'media'), false);
  const blocked = url => { let out; h.session.before({ url }, v => { out = v; }); return out.cancel === true; };
  assert.equal(blocked(ASSET), false, 'the bundled prompt document is allowed');
  for (const url of ['https://example.org/', 'file:///etc/passwd', `${ASSET}?x=1`, 'data:text/html,hi', 'file:///other/prompt.html', 'wss://x/', '']) {
    assert.equal(blocked(url), true, `blocked: ${url}`);
  }
  h.windows[0].destroy(); await p;
  const q = h.modal.choose(h.parent, SPEC); h.windows[1].destroy(); await q;
  assert.equal(h.sessionCalls.length, 1, 'the dedicated session is created once and reused');
});

test('MF-6 a session that cannot be created or configured fails closed to Keep with no window and no default-session fallback', async () => {
  const missing = harness({ createSession: null });
  assert.deepEqual(await missing.modal.choose(missing.parent, SPEC), { response: 0 });
  assert.equal(missing.windows.length, 0);
  const throwing = harness({ createSession: () => { throw new Error('no session'); } });
  assert.deepEqual(await throwing.modal.choose(throwing.parent, SPEC), { response: 0 });
  assert.equal(throwing.windows.length, 0);
  const broken = harness({ createSession: () => ({ setPermissionRequestHandler() { throw new Error('x'); } }) });
  assert.deepEqual(await broken.modal.choose(broken.parent, SPEC), { response: 0 });
  assert.equal(broken.windows.length, 0);
});

// ---------------------------------------------------- real lifecycle (security.cjs) + real modal.cjs
function lifecycle({ loadFile } = {}) {
  const { createWorkspaceRecovery } = require('../security.cjs');
  const h = harness();
  const closes = []; const loads = []; let url = 'file:///x';
  const win = new EventEmitter();
  win.dead = false; win.isDestroyed = () => win.dead;
  win.close = () => { closes.push(1); win.emit('close', {}); };
  win.loadFile = f => { loads.push(f); return loadFile ? loadFile(loads.length) : Promise.resolve(); };
  win.webContents = new EventEmitter();
  win.webContents.getURL = () => url; win.webContents.isDestroyed = () => false;
  const INDEX = path.join(DESKTOP, 'workspace', 'index.html');
  const recovery = createWorkspaceRecovery({ win, indexPath: INDEX, modal: h.modal });
  const winEvents = emitters(win);
  const bypass = () => { let n = 0; win.webContents.emit('will-prevent-unload', { preventDefault() { n += 1; } }); return n; };
  const navigate = target => { if (target) url = target; win.webContents.emit('did-start-navigation', { ...NAV, url }); };
  return { h, win, closes, loads, winEvents, recovery, bypass, navigate, setURL: u => { url = u; } };
}

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

test('real lifecycle: first-choice Discard re-closes exactly once; the closing guard is retained', async () => {
  const l = lifecycle();
  l.setURL('about:blank');
  l.winEvents.close({}); assert.equal(await l.recovery.restore(), 'skipped', 'close pending: Restore skipped');
  assert.equal(l.bypass(), 0, 'original veto honored'); await tick();
  const w = l.h.windows[0]; l.h.loaded(w);
  l.h.send(w, 1); await tick();                       // FIRST prompt, Discard
  assert.equal(l.closes.length, 1, 'exactly one re-issued close');
  assert.equal(l.bypass(), 1, 'only that close overrides the unload veto');
  assert.equal(l.bypass(), 0, 'allowance consumed');
  assert.equal(await l.recovery.restore(), 'skipped', 'closing guard retained until closed');
  assert.equal(w.destroyed, true, 'modal disposed before the close was re-issued');
});

test('MF-2 Restore is suppressed while a prompt is open and eligible again after Keep', async () => {
  const l = lifecycle();
  l.setURL('about:blank');
  l.winEvents.close({}); l.bypass(); await tick();
  const w = l.h.windows[0]; l.h.loaded(w);
  assert.equal(await l.recovery.restore(), 'skipped', 'prompting: Restore must not replace the document');
  assert.equal(l.loads.length, 0);
  l.h.send(w, 0); await tick();
  assert.equal(await l.recovery.restore(), 'restored', 'Keep restores eligibility');
  assert.equal(l.loads.length, 1);
});

test('MF-2 parent document replacement invalidates the open prompt: the old Discard closes nothing and the new document keeps its veto', async () => {
  const l = lifecycle();
  l.winEvents.close({}); l.bypass(); await tick();
  const w = l.h.windows[0]; l.h.loaded(w);
  l.navigate('about:blank');                                  // main-owned or scripted replacement
  await tick();
  assert.equal(w.destroyed, true, 'stale prompt dismissed');
  l.h.send(w, 1); await tick();
  assert.equal(l.closes.length, 0, 'stale Discard cannot close');
  l.winEvents.close({});
  assert.equal(l.bypass(), 0, 'replacement document veto honored');
  await tick();
  assert.equal(l.h.windows.length, 2, 'the replacement gets its own fresh prompt');
});

test('MF-2 navigation between the Discard answer and the re-issued close cancels the discard', async () => {
  const l = lifecycle();
  l.winEvents.close({}); l.bypass(); await tick();
  const w = l.h.windows[0]; l.h.loaded(w);
  l.h.send(w, 1);                                             // answer settles synchronously
  l.navigate('about:blank');                                  // document replaced before main acts on it
  await tick();
  assert.equal(l.closes.length, 0, 'generation recheck before reissuing close');
});

test('MF-2 an armed Discard allowance does not survive a parent document replacement', async () => {
  const l = lifecycle();
  l.winEvents.close({}); l.bypass(); await tick();
  const w = l.h.windows[0]; l.h.loaded(w); l.h.send(w, 1); await tick();
  assert.equal(l.closes.length, 1);
  l.navigate('about:blank');                                  // replacement lands before the old document answered unload
  assert.equal(l.bypass(), 0, 'the replacement document is not overridden by the old consent');
});

test('MF-2 a Restore failure that completes after the prompt was dismissed shows no late feedback', async () => {
  let reject;
  const l = lifecycle({ loadFile: () => new Promise((_, r) => { reject = r; }) });
  l.setURL('about:blank');
  const restoring = l.recovery.restore(); await flush();
  l.winEvents.close({}); l.bypass(); await tick();           // close vetoed: prompt opens
  const w = l.h.windows[0]; l.h.loaded(w); l.h.send(w, 0); await tick(); // Keep
  reject(new Error('late')); assert.equal(await restoring, 'failed'); await tick();
  assert.equal(l.h.windows.length, 1, 'no late error window from the stale Restore');
});

// P2: Restore feedback is bound to the Restore attempt's own load. Its own main-frame navigation
// (to the workspace index) keeps feedback; a different/later main-frame navigation or renderer loss
// supersedes it.
function startRestore() {
  let reject;
  const l = lifecycle({ loadFile: n => (n === 1 ? new Promise((_, r) => { reject = r; }) : Promise.resolve()) });
  l.setURL('about:blank');
  const restoring = l.recovery.restore();
  return { l, restoring, reject: e => reject(e) };
}
const INDEX_HREF = pathToFileURL(path.join(DESKTOP, 'workspace', 'index.html')).href;

test('P2 an unrelated main-frame replacement before the Restore rejection shows no late feedback', async () => {
  const { l, restoring, reject } = startRestore(); await flush();
  l.win.webContents.emit('did-start-navigation', { ...NAV, url: INDEX_HREF }); // Restore's own load
  l.win.webContents.emit('did-start-navigation', { ...NAV, url: 'about:blank' }); // superseding replacement
  reject(new Error('late')); assert.equal(await restoring, 'failed'); await tick();
  assert.equal(l.h.windows.length, 0, 'no stale modal on the replaced document');
});

test('P2 a foreign replacement that arrives before any own navigation also suppresses feedback', async () => {
  const { l, restoring, reject } = startRestore(); await flush();
  l.win.webContents.emit('did-start-navigation', { ...NAV, url: 'about:blank' });
  reject(new Error('late')); assert.equal(await restoring, 'failed'); await tick();
  assert.equal(l.h.windows.length, 0);
});

test('P2 renderer loss before the Restore rejection shows no late feedback', async () => {
  const { l, restoring, reject } = startRestore(); await flush();
  l.win.webContents.emit('did-start-navigation', { ...NAV, url: INDEX_HREF });
  l.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  reject(new Error('late')); assert.equal(await restoring, 'failed'); await tick();
  assert.equal(l.h.windows.length, 0, 'no stale modal on the lost document');
});

test('P2 the Restore attempt\'s own navigation failure still shows feedback and Restore can be retried', async () => {
  const { l, restoring, reject } = startRestore(); await flush();
  l.win.webContents.emit('did-start-navigation', { ...NAV, url: INDEX_HREF });
  reject(new Error('own failure')); await tick();
  assert.equal(l.h.windows.length, 1, 'normal failure feedback retained');
  l.h.loaded(l.h.windows[0]); l.h.send(l.h.windows[0], 0); await tick();
  assert.equal(await restoring, 'failed');
  assert.equal(await l.recovery.restore(), 'restored', 'retry eligible: a new attempt runs');
  assert.equal(l.loads.length, 2);
});

test('MF-4/MF-5 recovery keeps its own closed listener; repeated Keep prompts do not accumulate listeners', async () => {
  const l = lifecycle();
  const base = { closed: l.win.listenerCount('closed'), nav: l.win.webContents.listenerCount('did-start-navigation') };
  for (let i = 0; i < 4; i++) {
    l.winEvents.close({}); l.bypass(); await tick();
    const w = l.h.windows[l.h.windows.length - 1]; l.h.loaded(w); l.h.send(w, 0); await tick();
  }
  assert.deepEqual({ closed: l.win.listenerCount('closed'), nav: l.win.webContents.listenerCount('did-start-navigation') }, base);
  assert.ok(base.closed >= 1, 'recovery listener still attached');
});

test('MF-5 an unsaved-close request dismisses pending Help and its Discard still works once', async () => {
  const l = lifecycle();
  const help = l.h.modal.choose(l.win, INFO);
  const hw = l.h.windows[0]; l.h.loaded(hw);
  l.winEvents.close({}); assert.equal(l.bypass(), 0); await tick();
  assert.deepEqual(await help, { response: 0 });
  assert.equal(hw.destroyed, true);
  assert.equal(l.h.windows.length, 2);
  const dw = l.h.windows[1]; l.h.loaded(dw);
  assert.equal(dw.sent[0][1].buttons.length, 2, 'the close decision is shown, not buried behind Help');
  l.h.send(dw, 1); await tick();
  assert.equal(l.closes.length, 1);
});

test('real lifecycle: modal X / failure is Keep and never discards', async () => {
  for (const act of [w => w.destroy(), w => w.wcEvents['did-fail-load'](), w => w.wcEvents['render-process-gone']()]) {
    const l = lifecycle();
    l.winEvents.close({}); l.bypass(); await tick();
    act(l.h.windows[0]); await tick();
    assert.equal(l.closes.length, 0);
  }
});

test('real lifecycle: Restore failure feedback uses the modal; a later close request takes precedence', async () => {
  const l = lifecycle({ loadFile: () => Promise.reject(new Error('/secret ERR')) });
  l.setURL('about:blank');
  const pendingRestore = l.recovery.restore(); await tick();
  assert.equal(l.h.windows.length, 1);
  assert.doesNotMatch(JSON.stringify(l.h.windows[0].sent || []), /secret|ERR/);
  l.h.loaded(l.h.windows[0]);
  assert.match(JSON.stringify(l.h.windows[0].sent), /Could not restore/);
  l.winEvents.close({}); l.bypass(); await tick();
  assert.equal(await pendingRestore, 'failed');
  assert.equal(l.h.windows.length, 2, 'feedback dismissed; the close decision replaces it');
  assert.equal(l.h.windows[0].destroyed, true);
  const dw = l.h.windows[1]; l.h.loaded(dw);
  assert.equal(dw.sent[0][1].buttons.length, 2);
});

// ------------------------------------------------------- MF-7 child ordering during an app quit
test('quit traversal with a pending child: parent-first and child-first orders never discard or loop', async () => {
  // Parent first: the close/veto coalesces into the existing prompt, then the child is closed.
  const a = lifecycle();
  a.winEvents.close({}); a.bypass(); await tick();
  const aw = a.h.windows[0]; a.h.loaded(aw);
  a.winEvents.close({}); assert.equal(a.bypass(), 0); await tick();
  aw.destroy(); await tick();
  assert.equal(a.closes.length, 0); assert.equal(a.h.windows.length, 1);
  // Child first: the child is dismissed (Keep), then the parent's veto in a later task re-prompts ONCE.
  const b = lifecycle();
  b.winEvents.close({}); b.bypass(); await tick();
  const bw = b.h.windows[0]; b.h.loaded(bw);
  bw.destroy(); await tick();
  b.winEvents.close({}); assert.equal(b.bypass(), 0); await tick();
  assert.equal(b.h.windows.length, 2);
  const fresh = b.h.windows[1]; b.h.loaded(fresh); b.h.send(fresh, 0); await tick();
  assert.equal(b.closes.length, 0, 'Keep on the fresh prompt discards nothing');
  await tick(); assert.equal(b.h.windows.length, 2, 'no automatic re-prompt loop');
  assert.equal(fresh.destroyed, true);
});
