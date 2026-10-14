// PRIVATE-LINUX-FINISH-1: ordinary-link prevention (preload) and manual saved-workspace
// recovery (main). This is click/keyboard TRIGGER prevention plus recovery, NOT confinement:
// scripted document replacement (location.assign etc.) can still commit; see README.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { browserPreferences } = require('../security.cjs');

const DESKTOP = path.resolve(__dirname, '..');
const INDEX = path.join(DESKTOP, 'workspace', 'index.html');
const INDEX_URL = pathToFileURL(INDEX).href;

// ---------------------------------------------------------------- preload harness
function loadPreload({ href = INDEX_URL } = {}) {
  const listeners = [];
  const appended = [];
  const timers = [];
  const document = {
    baseURI: href,
    body: { appendChild(node) { appended.push(node); } },
    createElement(tag) { return { tag, style: {}, textContent: '', setAttribute(k, v) { this[k] = v; }, remove() { this.removed = true; } }; },
  };
  const window = { location: { href }, addEventListener(type, fn, opts) { listeners.push({ type, fn, opts }); } };
  vm.runInNewContext(fs.readFileSync(path.join(DESKTOP, 'preload.cjs'), 'utf8'), {
    TextEncoder, TextDecoder, URL, window, document, setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    require() { return { contextBridge: { exposeInMainWorld() {} }, ipcRenderer: { invoke() {} } }; },
  });
  const fire = (type, event) => {
    const e = { type, defaultPrevented: false, button: 0, ctrlKey: false, metaKey: false, shiftKey: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...event };
    for (const l of listeners.filter(x => x.type === type)) l.fn(e);
    return e;
  };
  return { listeners, appended, timers, fire };
}
const anchor = (href, extra = {}) => ({ localName: 'a', getAttribute: n => (n === 'href' ? href : null), ...extra });
const plain = (name = 'button') => ({ localName: name, getAttribute: () => null });
const pathEvent = (...nodes) => ({ target: nodes[0], composedPath: () => nodes });

test('preload registers capture-phase click, auxclick and keydown listeners', () => {
  const { listeners } = loadPreload();
  for (const type of ['click', 'auxclick', 'keydown']) {
    const l = listeners.filter(x => x.type === type);
    assert.equal(l.length, 1, type);
    assert.ok(l[0].opts === true || l[0].opts?.capture === true, `${type} must be capture`);
  }
});

test('foreign primary, middle, modified and keyboard link activation is canceled', () => {
  const { fire } = loadPreload();
  const foreign = ['https://example.org/', 'file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)',
    'about:blank', 'index.html', 'other.html#x', `${INDEX_URL}.evil/x`, `https://example.org/#${INDEX_URL}`, 'http://[bad'];
  for (const href of foreign) {
    const a = anchor(href);
    assert.equal(fire('click', pathEvent(a)).defaultPrevented, true, `click ${href}`);
    assert.equal(fire('auxclick', { ...pathEvent(a), button: 1 }).defaultPrevented, true, `aux ${href}`);
    assert.equal(fire('click', { ...pathEvent(a), ctrlKey: true }).defaultPrevented, true, `ctrl ${href}`);
    assert.equal(fire('click', { ...pathEvent(a), shiftKey: true, metaKey: true }).defaultPrevented, true, `shift ${href}`);
    assert.equal(fire('keydown', { ...pathEvent(a), key: 'Enter' }).defaultPrevented, true, `enter ${href}`);
  }
});

test('nested, composed-path, area and SVG link targets are covered', () => {
  const { fire } = loadPreload();
  const a = anchor('https://example.org/');
  assert.equal(fire('click', pathEvent(plain('span'), plain('strong'), a, plain('body'))).defaultPrevented, true);
  assert.equal(fire('click', { target: plain('div'), composedPath: () => [plain('b'), { nodeType: 11 }, a] }).defaultPrevented, true);
  assert.equal(fire('click', pathEvent({ localName: 'area', getAttribute: n => (n === 'href' ? 'https://example.org/' : null) })).defaultPrevented, true);
  const svg = { localName: 'a', getAttribute: n => (n === 'xlink:href' ? 'https://example.org/' : null) };
  assert.equal(fire('click', pathEvent(plain('path'), svg)).defaultPrevented, true);
});

test('same-document hash link keeps working, including other hashes of the workspace', () => {
  const { fire, appended } = loadPreload();
  for (const href of ['#draft', `${INDEX_URL}#draft`, 'index.html#other']) {
    const base = href === 'index.html#other' ? loadPreload({ href: INDEX_URL }) : { fire, appended };
    for (const [type, extra] of [['click', {}], ['keydown', { key: 'Enter' }]]) {
      assert.equal(base.fire(type, { ...pathEvent(plain('span'), anchor(href)), ...extra }).defaultPrevented, false, `${type} ${href}`);
    }
  }
  assert.equal(appended.length, 0, 'no notice for allowed links');
});

test('nonlink editor actions are never canceled', () => {
  const { fire } = loadPreload();
  assert.equal(fire('click', pathEvent(plain('button'))).defaultPrevented, false);
  assert.equal(fire('click', pathEvent(plain('textarea'), plain('main'))).defaultPrevented, false);
  assert.equal(fire('keydown', { ...pathEvent(plain('textarea')), key: 'Enter' }).defaultPrevented, false);
  assert.equal(fire('keydown', { ...pathEvent(anchor('https://example.org/')), key: 'a' }).defaultPrevented, false);
  assert.equal(fire('click', pathEvent(anchor(null))).defaultPrevented, false, 'anchor without href');
  assert.equal(fire('click', { target: plain('button') }).defaultPrevented, false, 'no composedPath');
});

test('blocking shows one minimal actionable notice naming the recovery menu action', () => {
  const { fire, appended, timers } = loadPreload();
  fire('click', pathEvent(anchor('https://example.org/')));
  fire('click', pathEvent(anchor('https://example.org/2')));
  assert.equal(appended.length, 1, 'notices coalesce');
  assert.equal(appended[0].role, 'status');
  assert.match(appended[0].textContent, /blocked/i);
  assert.match(appended[0].textContent, /Restore saved workspace/);
  assert.ok(timers.length >= 1 && timers[0].ms <= 15000, 'notice is bounded');
});

test('the two-method judge bridge is unchanged', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'preload.cjs'), 'utf8');
  assert.equal((src.match(/exposeInMainWorld/g) || []).length, 1);
  assert.equal(/openExternal|shell\b/.test(src), false);
});

// ---------------------------------------------------------------- main harness
function loadMain({ loadFile } = {}) {
  const ipc = {}; const appEvents = {}; const dialogCalls = []; const loads = [];
  let ready; let template; let applied; let currentURL = INDEX_URL; let destroyed = false;
  const winEvents = {}; const wcEvents = {}; let openHandler; let windowOptions;
  const win = {
    isDestroyed: () => destroyed,
    on(name, fn) { winEvents[name] = fn; },
    loadFile(file, ...rest) {
      loads.push([file, ...rest]);
      return loadFile ? loadFile(loads.length) : Promise.resolve();
    },
    webContents: {
      on(name, fn) { wcEvents[name] = fn; }, setWindowOpenHandler(fn) { openHandler = fn; },
      getURL: () => currentURL, isDestroyed: () => destroyed,
    },
  };
  const electron = {
    app: { isPackaged: false, enableSandbox() {}, whenReady: () => ({ then(fn) { ready = fn; } }),
      on(n, fn) { appEvents[n] = fn; }, quit() {} },
    ipcMain: { handle(n, fn) { ipc[n] = fn; } },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
    BrowserWindow: class { constructor(o) { windowOptions = o; return win; } static getAllWindows() { return []; } },
    Menu: { buildFromTemplate(t) { template = t; return { template: t }; }, setApplicationMenu(m) { applied = m; } },
    dialog: { showMessageBox(...args) { dialogCalls.push(args); return Promise.resolve({ response: 0 }); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(DESKTOP, 'main.cjs'), 'utf8'), {
    __dirname: DESKTOP, process: { platform: 'linux', resourcesPath: '/r', env: {} }, console,
    require(name) {
      if (name === 'node:path') return path;
      if (name === 'node:os') return { userInfo: () => ({ homedir: '/account/home' }) };
      if (name === './judge-bridge.cjs') return { createJudgeBridge: () => ({ bind() {}, capabilities() {}, run() {}, shutdown: () => Promise.resolve() }) };
      if (name === './security.cjs') return require('../security.cjs');
      assert.equal(name, 'electron');
      return electron;
    },
  });
  ready();
  const find = (items, re) => {
    for (const item of items || []) {
      if (re.test(item.label || '')) return item;
      const inner = find(item.submenu, re);
      if (inner) return inner;
    }
    return null;
  };
  return {
    win, loads, dialogCalls, ipc, winEvents, wcEvents, windowOptions, openHandler,
    template: () => template, applied: () => applied,
    restore: () => find(template, /^Restore saved workspace$/),
    help: () => find(template, /recovery/i),
    setURL(u) { currentURL = u; }, destroy() { destroyed = true; },
  };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('drag/drop navigation is pinned off alongside the sandbox settings', () => {
  const p = browserPreferences();
  assert.equal(p.navigateOnDragDrop, false);
  assert.equal(p.sandbox, true); assert.equal(p.contextIsolation, true);
});

test('native menu exposes "Restore saved workspace" with an accelerator, installed as app menu', () => {
  const m = loadMain();
  const item = m.restore();
  assert.ok(item, 'menu item present');
  assert.equal(typeof item.click, 'function');
  assert.match(item.accelerator, /Shift\+R$/);
  assert.notEqual(item.enabled, false, 'must stay available when the document is foreign');
  assert.ok(m.applied(), 'menu installed');
});

test('help text states LAST SAVED draft only and unsaved edits may be lost', async () => {
  const m = loadMain();
  const help = m.help();
  assert.ok(help, 'help item present');
  help.click({}, m.win);
  await flush();
  assert.equal(m.dialogCalls.length, 1);
  const text = JSON.stringify(m.dialogCalls[0]);
  assert.match(text, /last saved/i); assert.match(text, /unsaved/i);
  assert.equal(m.loads.length, 1, 'help never loads anything');
});

test('restore off-workspace calls win.loadFile(indexPath) only, ignoring any menu/renderer arguments', async () => {
  const m = loadMain();
  assert.equal(m.loads.length, 1);
  m.setURL('about:blank');
  m.restore().click({ url: 'https://example.org/' }, m.win, { url: 'file:///etc/passwd' });
  await flush();
  assert.equal(m.loads.length, 2);
  assert.deepEqual(m.loads[1], [INDEX]);
  assert.deepEqual(Object.keys(m.ipc).sort(), ['mecode:judge:capabilities', 'mecode:judge:run']);
});

test('restore is a no-op while already on the workspace, including its hash', async () => {
  const m = loadMain();
  for (const u of [INDEX_URL, `${INDEX_URL}#draft`]) { m.setURL(u); m.restore().click({}, m.win); }
  await flush();
  assert.equal(m.loads.length, 1);
});

test('repeated activation coalesces to one in-flight load; later manual recovery works again', async () => {
  const pending = [];
  const m = loadMain({ loadFile: n => (n === 1 ? Promise.resolve() : new Promise(r => pending.push(r))) });
  m.setURL('about:blank');
  for (let i = 0; i < 5; i++) m.restore().click({}, m.win);
  await flush();
  assert.equal(m.loads.length, 2, 'initial + exactly one recovery');
  pending[0](); await flush();
  m.setURL('about:blank');            // foreign again
  m.restore().click({}, m.win); await flush();
  assert.equal(m.loads.length, 3, 'second recovery allowed after the first settled');
  assert.equal(m.dialogCalls.length, 0);
});

test('failed load gives one bounded native error, no retry loop, no error text leak, and can be retried manually', async () => {
  const m = loadMain({ loadFile: n => (n === 1 ? Promise.resolve() : Promise.reject(new Error('/home/secret/path ERR_FAILED'))) });
  m.setURL('about:blank');
  m.restore().click({}, m.win); await flush();
  await new Promise(r => setImmediate(r));
  assert.equal(m.loads.length, 2, 'no automatic retry');
  assert.equal(m.dialogCalls.length, 1);
  const text = JSON.stringify(m.dialogCalls[0]);
  assert.doesNotMatch(text, /secret|ERR_FAILED/);
  assert.match(text, /error/i);
  m.restore().click({}, m.win); await flush();
  assert.equal(m.loads.length, 3, 'in-flight flag cleared after failure');
});

test('closing or destroyed window makes restore a silent no-op (also no dialog after close-during-failure)', async () => {
  let m = loadMain();
  m.setURL('about:blank'); m.winEvents.close({ preventDefault() { assert.fail('close must not be vetoed'); } });
  m.restore().click({}, m.win); await flush();
  assert.equal(m.loads.length, 1);
  m = loadMain(); m.setURL('about:blank'); m.destroy();
  m.restore().click({}, m.win); await flush();
  assert.equal(m.loads.length, 1);
  let reject;
  m = loadMain({ loadFile: n => (n === 1 ? Promise.resolve() : new Promise((_, r) => { reject = r; })) });
  m.setURL('about:blank'); m.restore().click({}, m.win); await flush();
  m.winEvents.close({}); reject(new Error('x')); await flush(); await new Promise(r => setImmediate(r));
  assert.equal(m.dialogCalls.length, 0);
});

test('defense in depth is retained: popup denied, foreign will-navigate/will-redirect canceled, workspace allowed', () => {
  const m = loadMain();
  assert.equal(m.openHandler().action, 'deny');
  for (const name of ['will-navigate', 'will-redirect']) {
    let prevented = false;
    m.wcEvents[name]({ preventDefault() { prevented = true; } }, 'https://example.org/');
    assert.equal(prevented, true, name);
    m.wcEvents[name]({ preventDefault() { assert.fail('workspace allowed'); } }, `${INDEX_URL}#draft`);
  }
});

test('main source has no unconditional unload veto, stop(), openExternal or renderer-controlled load', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'main.cjs'), 'utf8') + fs.readFileSync(path.join(DESKTOP, 'security.cjs'), 'utf8')
    + fs.readFileSync(path.join(DESKTOP, 'preload.cjs'), 'utf8');
  assert.doesNotMatch(src, /openExternal|\.stop\(\)|will-prevent-unload|beforeunload|loadURL/);
});
