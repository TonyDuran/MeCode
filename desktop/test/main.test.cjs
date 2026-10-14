const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

test('desktop denies both permission requests and checks before loading the document', () => {
  const calls = [];
  const handlers = {};
  let ready;
  const ipc = {};
  const appHandlers = {};
  let windowOptions;
  const session = { defaultSession: {
    setPermissionRequestHandler(fn) { handlers.request = fn; calls.push('request'); },
    setPermissionCheckHandler(fn) { handlers.check = fn; calls.push('check'); },
  } };
  const electron = {
    app: { enableSandbox() { calls.push('sandbox'); }, whenReady() { return { then(fn) { ready = fn; } }; },
      on(name, fn) { appHandlers[name] = fn; } },
    ipcMain: { handle(name, fn) { ipc[name] = fn; calls.push(name); } },
    BrowserWindow: class {
      constructor(options) { windowOptions = options; this.webContents = { setWindowOpenHandler() {}, on() {} }; }
      on() {} isDestroyed() { return false; }
      loadFile(file) { calls.push('load'); assert.equal(path.basename(file), 'index.html'); }
      static getAllWindows() { return []; }
    },
    session, Menu: { buildFromTemplate: t => t, setApplicationMenu() {} }, dialog: {},
  };
  const original = Module._load;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return electron;
      return original.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../main.cjs')];
    require('../main.cjs');
    ready();
    assert.equal(handlers.check(null, 'notifications'), false);
    let allowed;
    handlers.request(null, 'notifications', value => { allowed = value; });
    assert.equal(allowed, false);
    assert.deepEqual(calls, ['sandbox', 'request', 'check', 'mecode:judge:capabilities', 'mecode:judge:run', 'load']);
    assert.deepEqual(Object.keys(ipc).sort(), ['mecode:judge:capabilities', 'mecode:judge:run']);
    assert.equal(windowOptions.webPreferences.preload, path.resolve(__dirname, '../preload.cjs'));
    assert.equal(windowOptions.webPreferences.sandbox, true);
    assert.equal(windowOptions.webPreferences.contextIsolation, true);
    assert.equal(windowOptions.webPreferences.nodeIntegration, false);
    assert.equal(typeof appHandlers['before-quit'], 'function');
  } finally {
    Module._load = original;
    delete require.cache[require.resolve('../main.cjs')];
  }
});

test('main selects trusted development/packaged CLI, forwards only the fixed RPC payload and waits on quit', async () => {
  const dirname = path.resolve(__dirname, '..');
  for (const isPackaged of [false, true]) {
    const ipc = {}; const events = {};
    let options; let ready; let quit = 0; let release;
    const draining = new Promise(resolve => { release = resolve; });
    const event = {}; const request = { source: '', problemId: 'sum-array-v1' };
    const judge = {
      bind() {}, capabilities: value => { assert.equal(value, event); return 'capability-result'; },
      run: (...args) => { assert.deepEqual(args, [event, request]); return 'run-result'; },
      shutdown: () => draining,
    };
    vm.runInNewContext(fs.readFileSync(path.join(dirname, 'main.cjs'), 'utf8'), {
      __dirname: dirname,
      process: { platform: 'linux', resourcesPath: '/installed/resources',
        env: { MECODE_EXPERIMENTAL_JUDGE: '1', HOME: '/not-used', PYTHONPATH: '/not-used' } },
      require(name) {
        if (name === 'node:path') return path;
        if (name === 'node:os') return { userInfo: () => ({ homedir: '/account/home' }) };
        if (name === './judge-bridge.cjs') return { createJudgeBridge(value) { options = value; return judge; } };
        if (name === './security.cjs') return require('../security.cjs');
        assert.equal(name, 'electron');
        return {
          app: { isPackaged, enableSandbox() {}, whenReady: () => ({ then(fn) { ready = fn; } }),
            on(name, fn) { events[name] = fn; }, quit() { quit += 1; } },
          ipcMain: { handle(name, fn) { ipc[name] = fn; } },
          session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
          Menu: { buildFromTemplate: t => t, setApplicationMenu() {} }, dialog: {},
          BrowserWindow: class {
            constructor() { this.webContents = { on() {}, setWindowOpenHandler() {} }; }
            on() {}
            loadFile() {}
          },
        };
      },
    });
    assert.equal(options.cliPath, isPackaged ? '/installed/resources/judge/bridge_cli.py'
      : path.resolve(dirname, '../prototypes/docker-engine/bridge_cli.py'));
    assert.equal(options.isPackaged, isPackaged);
    assert.equal(options.home, '/account/home');
    assert.equal(options.optIn, '1');
    assert.equal(options.platform, 'linux');
    ready();
    assert.equal(ipc['mecode:judge:capabilities'](event, 'ignored'), 'capability-result');
    assert.equal(ipc['mecode:judge:run'](event, request, 'ignored'), 'run-result');
    let prevented = false;
    events['before-quit']({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(quit, 0);
    release(); await draining; await Promise.resolve();
    assert.equal(quit, 1);
    events['before-quit']({ preventDefault() { assert.fail('second quit must be allowed'); } });
  }
});
