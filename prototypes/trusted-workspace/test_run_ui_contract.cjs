'use strict';
// Cross-boundary regression: the real (read-only) Talos bridge produces replies that the real
// run-ui.js renders; malformed combinations must be rejected by BOTH sides. No Python, Docker,
// network or learner-source evaluation: the bridge child process is a mock.
// Env: MECODE_DESKTOP_DIR (producer, default this repository's desktop directory),
//      MECODE_RUN_UI_JS (renderer under test, default ./run-ui.js; used for red-before-fix runs).
// Prax-authored test; repository-relative default integrated by Talos.
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {pathToFileURL} = require('node:url');

const desktop = process.env.MECODE_DESKTOP_DIR || path.resolve(__dirname, '../../desktop');
const {createJudgeBridge} = require(path.join(desktop, 'judge-bridge.cjs'));
const {stageJudge} = require(path.join(desktop, 'stage.cjs'));
const rendererSource = fs.readFileSync(process.env.MECODE_RUN_UI_JS || path.join(__dirname, 'run-ui.js'), 'utf8');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-ui-contract-'));
after(() => fs.rmSync(root, {recursive: true, force: true}));
const cliPath = path.join(stageJudge(path.join(root, 'judge')), 'bridge_cli.py');
const indexPath = '/trusted/workspace/index.html';
const request = {source: 'def solve(nums): return sum(nums)', problemId: 'sum-array-v1'};

// Drive the real bridge; `stdout`/`code` are what the mocked Python child emits.
async function producer({stdout, code = 0, options = {}, req = request}) {
  const contents = new EventEmitter();
  contents.mainFrame = {url: pathToFileURL(indexPath).href};
  contents.getURL = () => contents.mainFrame.url;
  contents.isDestroyed = () => false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.end = () => setImmediate(() => {
    if (stdout !== undefined) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code, null);
  });
  for (const s of [child.stdin, child.stdout, child.stderr]) s.destroy = () => {};
  child.kill = () => true;
  const bridge = createJudgeBridge({indexPath, cliPath, home: '/account/home', platform: 'linux', optIn: '1',
    isPackaged: true, spawnImpl: () => child, ...options});
  bridge.bind(contents);
  return bridge.run({sender: contents, senderFrame: contents.mainFrame}, req);
}
const line = r => JSON.stringify(r) + '\n';

async function renderer(reply, {editDuringRun = false} = {}) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, {value: 'draft', textContent: '', dataset: {}, disabled: true,
      listeners: {}, addEventListener(n, f) { this.listeners[n] = f; }, setAttribute() {}});
    return nodes.get(id);
  };
  get('execution-note').textContent = 'Run and Submit are unavailable in this prototype.';
  let finish;
  const bridge = {capabilities: async () => ({enabled: true, reason: 'experimental_opt_in_not_health'}),
    run: () => new Promise(resolve => { finish = resolve; })};
  vm.runInNewContext(rendererSource, {document: {getElementById: get}, window: {mecodeJudge: bridge}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('run-draft').disabled, false);
  const pending = get('run-draft').listeners.click();
  if (editDuringRun) { get('draft').value = 'edited'; get('draft').listeners.input(); }
  finish(reply);
  await pending;
  const out = get('run-result');
  return {state: out.dataset.state, text: out.textContent, runDisabled: get('run-draft').disabled};
}

const judgedJson = {status: 'JUDGED', verdict: 'ACCEPTED', reason: null, elapsed_s: 0.25};

test('real bridge JUDGED replies render their verdicts', async () => {
  for (const verdict of ['ACCEPTED', 'WRONG_ANSWER', 'RUNTIME_ERROR']) {
    const reply = await producer({stdout: line({...judgedJson, verdict})});
    assert.deepEqual(reply, {...judgedJson, verdict});
    const ui = await renderer(reply);
    assert.equal(ui.state, 'judged');
    assert.match(ui.text, new RegExp(verdict));
  }
});

test('real bridge UNAVAILABLE / INVALID_INPUT replies render without verdict or private code', async () => {
  const unavailableReplies = [
    await producer({stdout: line(judgedJson), options: {platform: 'darwin'}}),
    await producer({stdout: '', code: 1}),
    await producer({stdout: 'not json\n'}),
  ];
  const invalidReply = await producer({stdout: '', req: {...request, problemId: 'other'}});
  assert.equal(invalidReply.status, 'INVALID_INPUT');
  for (const reply of unavailableReplies) {
    assert.equal(reply.status, 'UNAVAILABLE');
    const ui = await renderer(reply);
    assert.equal(ui.state, 'error');
    assert.equal(ui.runDisabled, true);
    assert.doesNotMatch(ui.text, /ACCEPTED|WRONG_ANSWER|RUNTIME_ERROR|linux_only|process_failed|invalid_protocol/);
    const stale = await renderer(reply, {editDuringRun: true});
    assert.equal(stale.runDisabled, true);
    assert.doesNotMatch(stale.text, /Run again/);
    assert.match(stale.text, /No verdict/);
  }
  const ui = await renderer(invalidReply);
  assert.equal(ui.state, 'error');
  assert.equal(ui.runDisabled, false);
  assert.doesNotMatch(ui.text, /ACCEPTED|WRONG_ANSWER|RUNTIME_ERROR|invalid_source_or_problem/);
});

// Same malformed producer outputs: the bridge must refuse them (invalid_protocol), and a
// renderer given them directly must also refuse, so neither side can drift alone.
const malformed = {
  'JUDGED null elapsed': {...judgedJson, elapsed_s: null},
  'JUDGED non-null reason': {...judgedJson, reason: 'engine_unavailable'},
  'JUDGED elapsed 29': {...judgedJson, elapsed_s: 29},
  'JUDGED negative elapsed': {...judgedJson, elapsed_s: -1},
  'JUDGED null verdict': {...judgedJson, verdict: null},
  'UNAVAILABLE with verdict': {status: 'UNAVAILABLE', verdict: 'ACCEPTED', reason: 'engine_unavailable', elapsed_s: null},
  'UNAVAILABLE with elapsed': {status: 'UNAVAILABLE', verdict: null, reason: 'engine_unavailable', elapsed_s: 0.1},
  'UNAVAILABLE null reason': {status: 'UNAVAILABLE', verdict: null, reason: null, elapsed_s: null},
  'INVALID_INPUT other reason': {status: 'INVALID_INPUT', verdict: null, reason: 'engine_unavailable', elapsed_s: null},
};
for (const [name, bad] of Object.entries(malformed)) {
  test(`both sides reject ${name}`, async () => {
    const fromBridge = await producer({stdout: line(bad)});
    assert.deepEqual(fromBridge, {status: 'UNAVAILABLE', verdict: null, reason: 'invalid_protocol', elapsed_s: null});
    const ui = await renderer(bad);
    assert.equal(ui.state, 'error');
    assert.doesNotMatch(ui.text, /ACCEPTED|WRONG_ANSWER|RUNTIME_ERROR|engine_unavailable|invalid_source/);
  });
}

test('renderer also rejects unexpected keys and private reason strings', async () => {
  for (const bad of [{...judgedJson, extra: 1},
    {status: 'UNAVAILABLE', verdict: null, reason: 'PRIVATE /home/x SOURCE', elapsed_s: null}]) {
    const ui = await renderer(bad);
    assert.equal(ui.state, 'error');
    assert.doesNotMatch(ui.text, /PRIVATE|ACCEPTED/);
  }
});
