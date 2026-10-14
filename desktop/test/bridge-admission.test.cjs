// Self-authored Talos regressions. Real filesystem verification; spawn is always
// a fake. No Python/Docker execution and no real account recovery-state access.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createJudgeBridge } = require('../judge-bridge.cjs');
const { stageJudge } = require('../stage.cjs');
const names = ['bridge_cli.py', 'controller.py', 'edited_runner.py'];
const request = {source: 'not executed by this test', problemId: 'sum-array-v1'};
const judged = {status: 'JUDGED', verdict: 'ACCEPTED', reason: null, elapsed_s: 0.25};

function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-admission-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const assets = path.join(root, 'judge');
  stageJudge(assets);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const indexPath = path.join(root, 'index.html');
  const contents = new EventEmitter();
  contents.mainFrame = {url: pathToFileURL(indexPath).href};
  contents.getURL = () => contents.mainFrame.url;
  contents.isDestroyed = () => false;
  const launches = [];
  const bridge = createJudgeBridge({indexPath, cliPath: path.join(assets, 'bridge_cli.py'), home,
    isPackaged: true, platform: 'linux', optIn: '1',
    spawnImpl(...args) {
      launches.push(args);
      const child = new EventEmitter();
      for (const stream of ['stdin', 'stdout', 'stderr']) {
        child[stream] = new EventEmitter(); child[stream].destroy = () => {};
      }
      child.kill = () => true;
      child.stdin.end = () => setImmediate(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(judged) + '\n'));
        child.emit('close', 0, null);
      });
      return child;
    }, ...options});
  bridge.bind(contents);
  return {root, assets, home, bridge, launches, event: {sender: contents, senderFrame: contents.mainFrame}};
}

for (const [label, options, reason] of [
  ['unpackaged Linux', {isPackaged: false}, 'packaged_required'],
  ['missing packaged flag', {isPackaged: undefined}, 'packaged_required'],
  ['truthy nonboolean packaged flag', {isPackaged: 'true'}, 'packaged_required'],
  ['packaged macOS', {platform: 'darwin'}, 'linux_only'],
  ['packaged Windows', {platform: 'win32'}, 'linux_only'],
  ['no opt-in', {optIn: undefined}, 'opt_in_required'],
]) test(`${label} refuses admission before asset I/O, spawn or recovery`, async t => {
  const f = setup(t, options);
  const read = t.mock.method(fs, 'openSync', () => { assert.fail('gate must precede asset read'); });
  assert.deepEqual(f.bridge.capabilities(f.event), {enabled: false, reason});
  assert.equal((await f.bridge.run(f.event, request)).reason, reason);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(f.launches.length, 0);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('packaged Linux opt-in verifies authentic assets for each admitted mock run', async t => {
  const f = setup(t);
  assert.deepEqual(f.bridge.capabilities(f.event), {enabled: true, reason: 'experimental_opt_in_not_health'});
  assert.deepEqual(await f.bridge.run(f.event, request), judged);
  assert.equal(f.launches.length, 1);
  fs.appendFileSync(path.join(f.assets, 'controller.py'), '# changed after prior run');
  assert.equal((await f.bridge.run(f.event, request)).reason, 'assets_unverified');
  assert.equal(f.launches.length, 1);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

const defects = {
  missing: f => fs.unlinkSync(path.join(f.assets, 'controller.py')),
  modified: f => {
    const file = path.join(f.assets, 'controller.py'), bytes = fs.readFileSync(file);
    bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  },
  extra: f => fs.writeFileSync(path.join(f.assets, 'uuid.py'), '# inert extra file'),
  extra_directory: f => fs.mkdirSync(path.join(f.assets, '__pycache__')),
  file_symlink: f => {
    const file = path.join(f.assets, 'controller.py');
    fs.renameSync(file, path.join(f.root, 'original.py'));
    fs.symlinkSync(path.join(f.root, 'original.py'), file);
  },
  directory_symlink: f => {
    fs.renameSync(f.assets, f.assets + '-real'); fs.symlinkSync(f.assets + '-real', f.assets);
  },
  nonregular: f => {
    const file = path.join(f.assets, 'controller.py'); fs.unlinkSync(file); fs.mkdirSync(file);
  },
  oversized: f => fs.truncateSync(path.join(f.assets, 'controller.py'), 1024 * 1024),
  read_error: (_f, t) => t.mock.method(fs, 'readSync', () => { throw new Error('private read failure'); }),
};
for (const [name, damage] of Object.entries(defects)) test(`${name} fails closed and latches before ANY spawn/recovery`, async t => {
  const f = setup(t);
  damage(f, t);
  const result = await f.bridge.run(f.event, request);
  assert.deepEqual(result, {status: 'UNAVAILABLE', verdict: null, reason: 'assets_unverified', elapsed_s: null});
  assert.equal(f.launches.length, 0);
  assert.deepEqual(fs.readdirSync(f.home), []);
  assert.equal((await f.bridge.run(f.event, request)).reason, 'bridge_latched');
  assert.equal(f.launches.length, 0);
});

test('verified reads handle partial I/O with buffers bounded by app-bound size plus one', async t => {
  const f = setup(t);
  const {MANIFEST} = require('../judge-assets.cjs');
  const limits = Object.values(MANIFEST).map(pin => pin.size + 1);
  const original = fs.readSync;
  let transferred = 0;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    assert.ok(limits.includes(buffer.length));
    assert.ok(length <= buffer.length - offset);
    const count = original(fd, buffer, offset, Math.min(length, 511), position);
    transferred += count;
    return count;
  });
  assert.deepEqual(await f.bridge.run(f.event, request), judged);
  assert.equal(transferred, Object.values(MANIFEST).reduce((sum, pin) => sum + pin.size, 0));
});

test('oversized first asset is refused before opening or reading any file', async t => {
  const f = setup(t);
  fs.truncateSync(path.join(f.assets, 'bridge_cli.py'), 1024 * 1024);
  const open = t.mock.method(fs, 'openSync', () => { assert.fail('oversized file must not open'); });
  assert.equal((await f.bridge.run(f.event, request)).reason, 'assets_unverified');
  assert.equal(open.mock.callCount(), 0);
  assert.equal(f.launches.length, 0);
});

test('directory mutation during verification fails closed before spawn', async t => {
  const f = setup(t), original = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    if (!changed) {
      changed = true;
      fs.writeFileSync(path.join(f.assets, 'uuid.py'), '# inert mutation');
    }
    return original(...args);
  });
  assert.equal((await f.bridge.run(f.event, request)).reason, 'assets_unverified');
  assert.equal(f.launches.length, 0);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('staging rejects changed source before replacing the prior staged directory', t => {
  const f = setup(t), source = path.join(f.root, 'source');
  fs.mkdirSync(source);
  for (const name of names) fs.copyFileSync(path.join(f.assets, name), path.join(source, name));
  fs.appendFileSync(path.join(source, 'bridge_cli.py'), '# drift');
  const before = fs.readFileSync(path.join(f.assets, 'bridge_cli.py'));
  assert.throws(() => stageJudge(f.assets, source));
  assert.deepEqual(fs.readFileSync(path.join(f.assets, 'bridge_cli.py')), before);
});
