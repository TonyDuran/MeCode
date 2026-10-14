const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {stageJudge} = require('../stage.cjs');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createJudgeBridge, DEADLINE_MS, GRACE_MS } = require('../judge-bridge.cjs');

const indexPath = '/trusted/workspace/index.html';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-bridge-unit-'));
after(() => fs.rmSync(root, {recursive: true, force: true}));
const cliPath = path.join(stageJudge(path.join(root, 'judge')), 'bridge_cli.py');
const source = 'def solve(nums): return sum(nums)';
const request = { source, problemId: 'sum-array-v1' };
const judged = { status: 'JUDGED', verdict: 'ACCEPTED', reason: null, elapsed_s: 0.25 };

function setup(options = {}) {
  const launches = [];
  const contents = new EventEmitter();
  contents.mainFrame = { url: pathToFileURL(indexPath).href };
  contents.getURL = () => contents.mainFrame.url;
  contents.isDestroyed = () => false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = data => { child.input = data; };
  child.stdin.destroy = () => {};
  child.stdout.destroy = () => {};
  child.stderr.destroy = () => {};
  child.kill = signal => { (child.signals ??= []).push(signal); return true; };
  const bridge = createJudgeBridge({ indexPath, cliPath, home: '/account/home',
    platform: 'linux', optIn: '1', isPackaged: true,
    spawnImpl: (...args) => { launches.push(args); return child; }, ...options });
  bridge.bind(contents);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const finish = (result = judged, code = 0) => {
    child.stdout.emit('data', Buffer.from(JSON.stringify(result) + '\n'));
    child.emit('close', code, null);
  };
  return { bridge, contents, event, launches, child, finish };
}

test('Linux explicit opt-in only; capabilities do not launch or claim health', async () => {
  for (const [platform, optIn, enabled] of [ ['linux', '1', true], ['linux', undefined, false],
    ['linux', 'true', false], ['darwin', '1', false], ['win32', '1', false] ]) {
    const f = setup({ platform, optIn });
    assert.deepEqual(f.bridge.capabilities(f.event), { enabled,
      reason: platform !== 'linux' ? 'linux_only' : enabled ? 'experimental_opt_in_not_health' : 'opt_in_required' });
    if (!enabled) assert.equal((await f.bridge.run(f.event, request)).status, 'UNAVAILABLE');
    assert.equal(f.launches.length, 0);
  }
});

test('exact webContents, main-frame identity and document URL authorize both methods', async () => {
  const mutations = [f => { f.event.sender = {}; }, f => { f.event.senderFrame = { ...f.contents.mainFrame }; },
    f => { f.contents.mainFrame.url += '#hash'; }, f => { f.contents.mainFrame.url += '?query'; },
    f => { f.contents.mainFrame.url = 'file:///evil/index.html'; },
    f => { f.contents.getURL = () => 'https://example.invalid'; },
    f => { f.contents.isDestroyed = () => true; }, f => { f.event.senderFrame = null; }];
  for (const mutate of mutations) {
    const f = setup(); mutate(f);
    assert.deepEqual(f.bridge.capabilities(f.event), { enabled: false, reason: 'untrusted_frame' });
    assert.equal((await f.bridge.run(f.event, request)).reason, 'untrusted_frame');
    assert.equal(f.launches.length, 0);
  }
});

test('strict schema and UTF-8 cap before launch; no lossy surrogate replacement', async () => {
  const f = setup();
  for (const invalid of [null, [], {}, { ...request, argv: [] }, { ...request, problemId: 'sum-array-v2' },
    { ...request, source: 1 }, { ...request, source: '\ud800' }, { ...request, source: '\udc00' },
    { ...request, source: 'é'.repeat(8193) }, { ...request, source: 'x'.repeat(16385) }]) {
    assert.equal((await f.bridge.run(f.event, invalid)).status, 'INVALID_INPUT');
  }
  assert.equal(f.launches.length, 0);
});

test('fixed absolute argv and sanitized env; source only on bounded stdin; one active call', async () => {
  const f = setup();
  const promise = f.bridge.run(f.event, request);
  assert.equal((await f.bridge.run(f.event, request)).reason, 'busy');
  const [command, args, options] = f.launches[0];
  assert.equal(command, '/usr/bin/python3');
  assert.deepEqual(args, ['-I', '-B', cliPath]);
  assert.deepEqual(options, { cwd: path.dirname(cliPath), shell: false, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'], env: { HOME: '/account/home', PATH: '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C.UTF-8' } });
  assert.deepEqual(JSON.parse(f.child.input), request);
  assert.ok(Buffer.byteLength(f.child.input) <= 100000);
  f.finish();
  assert.deepEqual(await promise, judged);
  const again = f.bridge.run(f.event, { ...request, source: '😀'.repeat(4096) });
  f.finish();
  assert.deepEqual(await again, judged);
});

test('deadline TERM then bounded KILL; latch survives late success and missing close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup();
  const promise = f.bridge.run(f.event, request);
  t.mock.timers.tick(DEADLINE_MS);
  assert.deepEqual(f.child.signals, ['SIGTERM']);
  assert.equal((await f.bridge.run(f.event, request)).reason, 'bridge_latched');
  t.mock.timers.tick(GRACE_MS);
  assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal((await promise).reason, 'bridge_timeout');
  f.finish();
  assert.equal((await f.bridge.run(f.event, request)).reason, 'bridge_latched');
  assert.equal(f.launches.length, 1);
});

test('late result is suppressed when main frame changes', async () => {
  const f = setup();
  const promise = f.bridge.run(f.event, request);
  f.contents.mainFrame = { ...f.contents.mainFrame };
  f.finish();
  assert.equal((await promise).reason, 'stale_frame');
  assert.equal((await f.bridge.run({ sender: f.contents, senderFrame: f.contents.mainFrame }, request)).reason, 'bridge_latched');
});

test('same-URL reload, renderer death and shutdown cancel rather than release concurrency', async () => {
  for (const cancel of [f => f.contents.emit('did-start-navigation', {isMainFrame: true, isSameDocument: false}),
    f => f.contents.emit('render-process-gone'), f => f.contents.emit('destroyed'), f => f.bridge.shutdown()]) {
    const f = setup();
    const promise = f.bridge.run(f.event, request);
    cancel(f);
    assert.deepEqual(f.child.signals, ['SIGTERM']);
    f.finish();
    assert.equal((await promise).status, 'UNAVAILABLE');
    assert.equal((await f.bridge.run(f.event, request)).status, 'UNAVAILABLE');
  }
});

test('malformed, overcap, stderr, failure and cleanup-unavailable all fail closed without raw output', async () => {
  const failures = [f => f.child.stdout.emit('data', Buffer.from('private malformed')),
    f => f.child.stdout.emit('data', Buffer.alloc(1025, 120)),
    f => f.child.stderr.emit('data', Buffer.from('private secret')),
    f => f.child.stdout.emit('data', Buffer.from('{"status":"JUDGED","status":"JUDGED","verdict":"ACCEPTED","reason":null,"elapsed_s":0.25}\n')),
    f => f.child.stdout.emit('data', Buffer.from(JSON.stringify({ ...judged, stderr: 'secret' }))),
    f => f.child.stdout.emit('data', Buffer.from(JSON.stringify({ ...judged, elapsed_s: -1 }))),
    f => f.child.stdout.emit('data', Buffer.from(JSON.stringify({ status: 'UNAVAILABLE', verdict: null, reason: 'engine_unavailable', elapsed_s: null })))];
  for (const fail of failures) {
    const f = setup(); const promise = f.bridge.run(f.event, request);
    fail(f); f.child.emit('close', 0, null);
    const result = await promise;
    assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.verdict, null);
    assert.doesNotMatch(JSON.stringify(result), /private|secret/);
    assert.equal((await f.bridge.run(f.event, request)).reason, 'bridge_latched');
  }
});

test('Electron 44 details-only navigation cancels full main-document reload', async () => {
  const f = setup(); const promise = f.bridge.run(f.event, request);
  f.contents.emit('did-start-navigation', {isMainFrame: false, isSameDocument: false});
  f.contents.emit('did-start-navigation', {isMainFrame: true, isSameDocument: true});
  assert.equal(f.child.signals, undefined);
  f.contents.emit('did-start-navigation', {isMainFrame: true, isSameDocument: false});
  // Close the mock even on the pre-fix path, avoiding a real deadline wait.
  f.finish();
  assert.deepEqual(f.child.signals, ['SIGTERM']);
  assert.equal((await promise).reason, 'stale_frame');
});

test('spawn errors, pipe failures and nonzero exit are sanitized', async () => {
  const f = setup({ spawnImpl() { throw new Error('/private/python'); } });
  assert.equal((await f.bridge.run(f.event, request)).reason, 'launch_failed');
  for (const fail of [f => f.child.emit('error', new Error('secret')),
    f => f.child.stdin.emit('error', new Error('secret')),
    f => f.child.stdout.emit('error', new Error('secret')),
    f => f.child.stderr.emit('error', new Error('secret'))]) {
    const f = setup(); const promise = f.bridge.run(f.event, request);
    fail(f); f.child.emit('close', 1, null);
    assert.equal((await promise).status, 'UNAVAILABLE');
  }
  const g = setup(); const promise = g.bridge.run(g.event, request);
  g.finish(judged, 1); assert.equal((await promise).reason, 'process_failed');
});
