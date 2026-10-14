const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(reject = false, globals = {}) {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), {
    TextEncoder, TextDecoder, URL, window: { location: { href: 'file:///w/index.html' }, addEventListener() {} },
    document: { baseURI: 'file:///w/index.html' }, ...globals,
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'mecodeJudge'); api = value; } },
        ipcRenderer: { invoke(...args) {
          calls.push(args);
          return reject ? Promise.reject(new Error('private path')) : Promise.resolve({ test: 'reply' });
        } },
      };
    },
  });
  return { api, calls };
}

test('sandbox preload exports exactly two fixed RPCs, no event/IPC/argument passthrough', async () => {
  const { api, calls } = load();
  assert.deepEqual(Object.keys(api).sort(), ['capabilities', 'run']);
  assert.equal(Object.isFrozen(api), true);
  await api.capabilities('arbitrary-channel', { env: 'evil' });
  await api.run({ source: '', problemId: 'sum-array-v1' }, 'ignored');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [ ['mecode:judge:capabilities'],
    ['mecode:judge:run', { source: '', problemId: 'sum-array-v1' }] ]);
});

test('preload bounds input before IPC and rejects paths/env/options and malformed UTF-16', async () => {
  const { api, calls } = load();
  for (const request of [null, [], {}, { source: '', problemId: 'unknown' },
    { source: '', problemId: 'sum-array-v1', env: {} },
    { source: 'é'.repeat(8193), problemId: 'sum-array-v1' },
    { source: '\ud800', problemId: 'sum-array-v1' }]) {
    assert.equal((await api.run(request)).status, 'INVALID_INPUT');
  }
  assert.equal(calls.length, 0);
});

test('IPC rejection becomes a fixed unavailable response, never an exception path leak', async () => {
  const { api } = load(true);
  assert.deepEqual(JSON.parse(JSON.stringify(await api.capabilities())), { enabled: false, reason: 'bridge_transport_failed' });
  assert.deepEqual(JSON.parse(JSON.stringify(await api.run({ source: '', problemId: 'sum-array-v1' }))),
    { status: 'UNAVAILABLE', verdict: null, reason: 'bridge_transport_failed', elapsed_s: null });
});

test('validation exceptions resolve to INVALID_INPUT without IPC or private details', async () => {
  for (const globals of [{TextEncoder: undefined}, {TextDecoder: undefined},
    {TextEncoder: class { encode() { throw new Error('private encoder'); } }}]) {
    const {api, calls} = load(false, globals);
    let promise;
    assert.doesNotThrow(() => { promise = api.run({source: '', problemId: 'sum-array-v1'}); });
    assert.equal(typeof promise.then, 'function');
    assert.deepEqual(JSON.parse(JSON.stringify(await promise)),
      {status: 'INVALID_INPUT', verdict: null, reason: 'invalid_source_or_problem', elapsed_s: null});
    assert.equal(calls.length, 0);
  }
  const {api, calls} = load();
  const request = {problemId: 'sum-array-v1', get source() { throw new Error('private getter'); }};
  assert.equal((await api.run(request)).status, 'INVALID_INPUT');
  assert.equal(calls.length, 0);
});

test('valid Unicode including a leading BOM is preserved, not rejected or normalized', async () => {
  const { api, calls } = load();
  for (const source of ['\ufeffdef solve(nums): return sum(nums)', '😀'.repeat(4096), '\0'.repeat(16384)]) {
    await api.run({ source, problemId: 'sum-array-v1' });
    assert.equal(calls.at(-1)?.[1]?.source, source);
  }
  assert.equal(calls.length, 3);
});
