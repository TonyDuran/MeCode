const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

test('desktop denies both permission requests and checks before loading the document', () => {
  const calls = [];
  const handlers = {};
  let ready;
  const session = { defaultSession: {
    setPermissionRequestHandler(fn) { handlers.request = fn; calls.push('request'); },
    setPermissionCheckHandler(fn) { handlers.check = fn; calls.push('check'); },
  } };
  const electron = {
    app: { enableSandbox() { calls.push('sandbox'); }, whenReady() { return { then(fn) { ready = fn; } }; }, on() {} },
    BrowserWindow: class {
      constructor(options) { this.options = options; this.webContents = { setWindowOpenHandler() {}, on() {} }; }
      loadFile(file) { calls.push('load'); assert.equal(path.basename(file), 'index.html'); }
      static getAllWindows() { return []; }
    },
    session,
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
    assert.deepEqual(calls, ['sandbox', 'request', 'check', 'load']);
  } finally {
    Module._load = original;
    delete require.cache[require.resolve('../main.cjs')];
  }
});
