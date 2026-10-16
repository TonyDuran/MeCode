'use strict';
// T06 R2: deterministic deferred-response tests for the REAL src/renderer/app.js, run in node:vm with a minimal DOM harness (not a browser;
// the actual-browser run is recorded separately in the T06 receipt). Written BEFORE the renderer fix (RED in logs/t06-red.log).
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const rdir = path.join(__dirname, '..', '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(rdir, 'index.html'), 'utf8');
const code = fs.readFileSync(path.join(rdir, 'app.js'), 'utf8');
const tick = async (n = 12) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

class El {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.open = false;
    this.children = [];
    this.ls = {};
    this.dataset = {};
    this.files = [];
    this.checked = false;
  }
  addEventListener(t, fn) {
    (this.ls[t] = this.ls[t] || []).push(fn);
  }
  replaceChildren(...c) {
    this.children = c;
    if (!c.length) this.textContent = '';
  }
  append(...c) {
    this.children.push(...c);
  }
  querySelectorAll() {
    return this.children.filter((c) => c instanceof El);
  }
  fire(t) {
    for (const fn of this.ls[t] || []) fn({ target: this, preventDefault() {} });
  }
  /** what a user can do: a disabled control receives nothing */
  type(text) {
    if (this.disabled) return false;
    this.value = text;
    this.fire('input');
    return true;
  }
  click() {
    if (this.disabled) return false;
    this.fire('click');
    return true;
  }
  choose(v) {
    if (this.disabled) return false;
    this.value = v;
    this.fire('change');
    return true;
  }
}

const PROB = (name, hash) => ({
  key: name,
  contentHash: hash,
  title: name,
  difficulty: 'easy',
  patterns: ['p'],
  provenance: { kind: 'original', license: 'MIT' },
  examples: [],
  checkCount: 0,
  statement: `statement ${name}`,
  inputFormat: '',
  outputFormat: '',
  constraints: [],
  starters: { python: `# starter ${name} py`, javascript: `// starter ${name} js` },
  status: 'unsolved',
});

function boot() {
  const els = new Map();
  for (const m of html.matchAll(/id="([^"]+)"/g)) els.set(m[1], new El(m[1]));
  const document = { getElementById: (id) => els.get(id), createElement: () => new El('x') };
  const pending = [];
  const calls = [];
  const hold = new Set();
  const auto = {};
  const call = (name) => (args) => {
    calls.push({ name, args });
    if (!hold.has(name) && auto[name]) return Promise.resolve(auto[name](args));
    return new Promise((resolve) => pending.push({ name, args, resolve }));
  };
  const ns = (n, ms) => Object.fromEntries(ms.map((m) => [m, call(`${n}.${m}`)]));
  const api = {
    catalog: ns('catalog', ['list', 'get']),
    draft: ns('draft', ['load', 'save']),
    backend: ns('backend', ['status', 'retry']),
    packs: ns('packs', ['import', 'reload']),
    settings: ns('settings', ['get', 'update']),
    execution: ns('execution', ['start', 'get', 'cancel', 'active']),
  };
  const ok = (value) => ({ ok: true, value });
  const store = { drafts: new Map(), revs: new Map() };
  auto['catalog.list'] = () =>
    ok({ problems: ['A', 'B', 'C'].map((k) => ({ key: k, title: k, difficulty: 'easy', patterns: ['p'], status: 'unsolved' })), error: null, warning: null, packsDir: '/x' });
  auto['backend.status'] = () => ok({ state: 'ready', languages: [{ id: 'python', version: '3' }], effectiveLimits: {} });
  auto['execution.active'] = () => ok({ active: null });
  auto['draft.save'] = (a) => {
    const k = `${a.key}|${a.language}`;
    store.drafts.set(k, a.source);
    const r = (store.revs.get(k) || 0) + 1;
    store.revs.set(k, r);
    return ok({ revision: r, updatedAt: 'now' });
  };
  const hashes = { A: 'ha', B: 'hb', C: 'hc' };
  const ctx = { window: null, document, setTimeout, clearTimeout, setInterval: () => 0, console };
  ctx.window = { mecode: api, addEventListener() {}, confirm: () => true };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const find = (name, pred = () => true) => pending.find((p) => p.name === name && !p.done && pred(p));
  const settle = async (p, v) => {
    p.done = true;
    p.resolve(v);
    await tick();
  };
  return { els, api, pending, calls, hold, auto, ok, store, hashes, find, settle, $: (id) => els.get(id), callsOf: (n) => calls.filter((c) => c.name === n) };
}
async function ready(t, withLoads = true) {
  await tick();
  t.auto['catalog.get'] = ({ key }) => t.ok(PROB(key, t.hashes[key]));
  t.auto['draft.load'] = () => t.ok({ source: null, revision: 0, updatedAt: null });
  void withLoads;
}
async function open(t, key) {
  t.$('list')
    .children.find((li) => li.dataset.key === key)
    .fire('click');
  await tick();
}

test('R2 typing, Save, Run and language change are impossible while catalog.get is pending; edits are saved to the OLD key first', async () => {
  const t = boot();
  await ready(t);
  await open(t, 'A');
  assert.equal(t.$('editor').value, '# starter A py');
  t.$('editor').type('edited-A'); // dirty
  t.hold.add('catalog.get');
  await open(t, 'B'); // flushSave -> draft.save A, then catalog.get B held
  assert.deepEqual(
    t.callsOf('draft.save').map((c) => [c.args.key, c.args.source]),
    [['A', 'edited-A']],
  );
  assert.equal(t.$('editor').disabled, true, 'editor must not be editable during the transition');
  for (const id of ['save', 'runEx', 'runCustom', 'submit']) assert.equal(t.$(id).disabled, true, `${id} must be disabled during transition`);
  assert.equal(t.$('lang').disabled, true);
  const nSaves = t.callsOf('draft.save').length,
    nStarts = t.callsOf('execution.start').length;
  t.$('editor').type('stale-typed');
  t.$('save').click();
  t.$('runEx').click();
  t.$('lang').choose('javascript');
  await tick();
  assert.equal(t.callsOf('draft.save').length, nSaves, 'no cross-key save');
  assert.equal(t.callsOf('execution.start').length, nStarts, 'no run of the stale buffer');
  t.hold.delete('catalog.get');
  await t.settle(t.find('catalog.get'), t.ok(PROB('B', 'hb')));
  assert.equal(t.$('editor').value, '# starter B py');
  assert.equal(t.$('editor').disabled, false);
  t.$('editor').type('b-edit');
  t.$('save').click();
  await tick();
  assert.deepEqual({ ...t.callsOf('draft.save').at(-1).args }, { key: 'B', language: 'python', source: 'b-edit', baseRevision: 0 });
  assert.equal(t.store.drafts.get('A|python'), 'edited-A', 'A was not overwritten');
});
test('R2 draft.load pending: new key is not adopted until its draft arrives; the old buffer is never writable under the new key', async () => {
  const t = boot();
  await ready(t);
  await open(t, 'A');
  t.$('editor').type('a1');
  t.hold.add('draft.load');
  await open(t, 'B');
  await tick();
  assert.equal(t.$('editor').disabled, true);
  t.$('editor').type('x');
  t.$('save').click();
  t.$('submit').click();
  await tick();
  assert.deepEqual(
    t.callsOf('draft.save').map((c) => c.args.key),
    ['A'],
  );
  assert.equal(t.callsOf('execution.start').length, 0);
  t.hold.delete('draft.load');
  await t.settle(
    t.find('draft.load', (p) => p.args.key === 'B'),
    t.ok({ source: 'saved-B', revision: 3, updatedAt: 'x' }),
  );
  assert.equal(t.$('editor').value, 'saved-B');
  assert.equal(t.$('editor').disabled, false);
});
test('R2 language change: old language saved first, editor locked until the new draft loads, no cross-language write', async () => {
  const t = boot();
  await ready(t);
  await open(t, 'A');
  t.$('editor').type('py-edit');
  t.hold.add('draft.load');
  t.$('lang').choose('javascript');
  await tick();
  assert.deepEqual(
    t.callsOf('draft.save').map((c) => [c.args.language, c.args.source]),
    [['python', 'py-edit']],
  );
  assert.equal(t.$('editor').disabled, true);
  t.$('editor').type('zzz');
  t.$('save').click();
  await tick();
  assert.equal(t.callsOf('draft.save').length, 1);
  t.hold.delete('draft.load');
  await t.settle(
    t.find('draft.load', (p) => p.args.language === 'javascript'),
    t.ok({ source: null, revision: 0, updatedAt: null }),
  );
  assert.equal(t.$('editor').value, '// starter A js');
  assert.equal(t.$('editor').disabled, false);
});
test('R2 second navigation supersedes the first; late first response is ignored', async () => {
  const t = boot();
  await ready(t);
  await open(t, 'A');
  t.hold.add('catalog.get');
  await open(t, 'B');
  await open(t, 'C');
  const pb = t.find('catalog.get', (p) => p.args.key === 'B'),
    pc = t.find('catalog.get', (p) => p.args.key === 'C');
  t.hold.delete('catalog.get');
  await t.settle(pc, t.ok(PROB('C', 'hc')));
  assert.equal(t.$('title').textContent, 'C');
  assert.equal(t.$('editor').value, '# starter C py');
  assert.equal(t.$('editor').disabled, false);
  await t.settle(pb, t.ok(PROB('B', 'hb')));
  assert.equal(t.$('title').textContent, 'C', 'stale B response must not repaint');
  assert.equal(t.$('editor').value, '# starter C py');
  t.$('editor').type('c-edit');
  t.$('save').click();
  await tick();
  assert.equal(t.callsOf('draft.save').at(-1).args.key, 'C');
});
test('R2 failed catalog.get keeps the old context editable; failed draft.load disables editing and never shows a starter', async () => {
  const t = boot();
  await ready(t);
  await open(t, 'A');
  t.$('editor').type('keep-me');
  t.auto['catalog.get'] = () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'gone' } });
  await open(t, 'B');
  assert.equal(t.$('editor').disabled, false, 'old context must be usable again');
  assert.equal(t.$('title').textContent, 'A');
  assert.equal(t.$('editor').value, 'keep-me');
  t.$('save').click();
  await tick();
  assert.equal(t.callsOf('draft.save').at(-1).args.key, 'A');
  t.auto['catalog.get'] = ({ key }) => t.ok(PROB(key, t.hashes[key]));
  t.auto['draft.load'] = () => ({ ok: false, error: { code: 'IO_ERROR', message: 'corrupt' } });
  await open(t, 'C');
  assert.equal(t.$('editor').disabled, true);
  assert.equal(t.$('editor').value, '');
  assert.match(t.$('saveState').textContent, /DRAFT LOAD FAILED/);
  const n = t.callsOf('draft.save').length;
  t.$('save').click();
  t.$('runEx').click();
  await tick();
  assert.equal(t.callsOf('draft.save').length, n);
});
test('R2 Run: editor locked while starting; delayed start response never paints Running onto a different context; failed start error not painted onto another problem', async () => {
  const t = boot();
  await ready(t);
  await open(t, 'A');
  t.$('editor').type('run-me');
  t.hold.add('execution.start');
  t.$('runEx').click();
  await tick();
  assert.equal(t.callsOf('execution.start').length, 1);
  assert.equal(t.callsOf('execution.start')[0].args.source, 'run-me');
  assert.equal(t.$('editor').disabled, true, 'source being sent must not change under the user');
  await open(t, 'B');
  await tick();
  assert.equal(t.$('title').textContent, 'B');
  t.hold.delete('execution.start');
  await t.settle(t.find('execution.start'), { ok: false, error: { code: 'BUSY', message: 'busy' } });
  assert.doesNotMatch(t.$('verdict').textContent, /BUSY|Could not start/, 'stale error painted onto B');
  assert.equal(t.$('editor').disabled, false);
  assert.equal(t.$('editor').value, '# starter B py');
  // success path on another context
  t.hold.add('execution.start');
  t.$('runEx').click();
  await tick();
  await open(t, 'C');
  t.hold.delete('execution.start');
  await t.settle(t.find('execution.start'), t.ok({ jobId: 'j1' }));
  assert.notEqual(t.$('verdict').textContent, 'Running…', 'Running painted onto C although the job belongs to B');
});
test('R2 save failure blocks navigation and keeps the draft editable', async () => {
  const t = boot();
  await ready(t);
  await open(t, 'A');
  t.$('editor').type('precious');
  t.auto['draft.save'] = () => ({ ok: false, error: { code: 'IO_ERROR', message: 'disk' } });
  await open(t, 'B');
  assert.equal(t.$('title').textContent, 'A');
  assert.equal(t.$('editor').value, 'precious');
  assert.equal(t.$('editor').disabled, false);
  assert.match(t.$('saveState').textContent, /SAVE FAILED/);
});
