'use strict';
// T08 behavioral regressions for Talos T07 F1 (special-file reads block) and F2 (backup overwritten by invalid primary).
// Written BEFORE the fixes. F1 uses REAL FIFOs with no writer and REAL child processes with a bounded parent timeout (only the task's own child is killed).
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../src/main/store.cjs');

const root = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't8-'));
const mkfifo = (p) => cp.execFileSync('mkfifo', [p]);
const ID = '11111111-2222-3333-4444-555555555555';
const att = { key: 'k', contentHash: 'h', mode: 'submit', language: 'python', verdict: 'ACCEPTED', sourceHash: 's', at: '2026-01-01T00:00:00.000Z' };
const good = { schemaVersion: 1, installId: ID, progress: { k: { lastVerdict: 'ACCEPTED', acceptedContentHash: 'h' } }, attempts: [att] };

/** Run `body` (async JS, `dir` and `root` in scope) in a child; it must print one JSON line and exit promptly. Returns {timedOut, out, ms}. */
function child(dir, body, limitMs = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = cp.spawn(
      process.execPath,
      [
        '-e',
        `(async()=>{const dir=${JSON.stringify(dir)},root=${JSON.stringify(root)};${body}})().then(()=>process.exit(0),e=>{console.log(JSON.stringify({err:e.code||String(e)}));process.exit(0)})`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    c.stdout.on('data', (d) => {
      out += d;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      c.kill('SIGKILL');
    }, limitMs);
    c.on('exit', () => {
      clearTimeout(timer);
      resolve({ timedOut, out: out.trim(), ms: Date.now() - t0 });
    });
  });
}

test('F1 state.json FIFO (no writer): Store.init rejects IO_ERROR promptly, FIFO untouched', async () => {
  const d = tmp();
  mkfifo(path.join(d, 'state.json'));
  const r = await child(d, `const {Store}=require(root+'/src/main/store.cjs');await new Store(dir).init();console.log(JSON.stringify({err:'RESOLVED'}));`);
  assert.equal(r.timedOut, false, 'init blocked on FIFO');
  assert.equal(JSON.parse(r.out).err, 'IO_ERROR');
  assert.ok(fs.lstatSync(path.join(d, 'state.json')).isFIFO());
  assert.deepEqual(fs.readdirSync(d), ['state.json']);
});

test('F1 draft FIFO (no writer): loadDraft and saveDraft reject IO_ERROR promptly, no residue', async () => {
  const d = tmp();
  const s = new Store(d);
  await s.init();
  fs.mkdirSync(path.join(d, 'drafts'));
  mkfifo(s._draftFile('k/p', 'python'));
  for (const call of ["loadDraft('k/p','python')", "saveDraft('k/p','python','x',0)"]) {
    const r = await child(d, `const {Store}=require(root+'/src/main/store.cjs');const s=new Store(dir);await s.init();await s.${call};console.log(JSON.stringify({err:'RESOLVED'}));`);
    assert.equal(r.timedOut, false, `${call} blocked on FIFO`);
    assert.equal(JSON.parse(r.out).err, 'IO_ERROR');
  }
  assert.ok(fs.lstatSync(s._draftFile('k/p', 'python')).isFIFO());
  assert.deepEqual(fs.readdirSync(path.join(d, 'drafts')).length, 1, 'no temp residue');
});

test('F1 server.lock FIFO (no writer): startWeb rejects LOCKED promptly, no owned-lock residue, sentinel unmodified', async () => {
  const d = tmp();
  const lock = path.join(d, 'server.lock');
  mkfifo(lock);
  fs.writeFileSync(path.join(d, 'sentinel.txt'), 'SENTINEL');
  const r = await child(d, `const web=require(root+'/src/web/server.cjs');await web.startWeb({userData:dir,appRoot:root,autostart:false});console.log(JSON.stringify({err:'RESOLVED'}));`);
  assert.equal(r.timedOut, false, 'lock inspection blocked on FIFO');
  assert.equal(JSON.parse(r.out).err, 'LOCKED');
  assert.ok(fs.lstatSync(lock).isFIFO(), 'FIFO not replaced/removed');
  assert.deepEqual(fs.readdirSync(d).sort(), ['sentinel.txt', 'server.lock']);
  assert.equal(fs.readFileSync(path.join(d, 'sentinel.txt'), 'utf8'), 'SENTINEL');
});

test('F1 regular missing/symlink behavior preserved (ENOENT = absent; symlink = IO_ERROR)', async () => {
  const d = tmp();
  const s = new Store(d);
  await s.init();
  assert.equal((await s.loadDraft('a', 'python')).source, null);
  fs.mkdirSync(path.join(d, 'drafts'));
  fs.symlinkSync('/etc/hostname', s._draftFile('a', 'python'));
  await assert.rejects(s.loadDraft('a', 'python'), (e) => e.code === 'IO_ERROR');
});

test('F2 corrupt primary + valid backup: primary-rename failure after recovery keeps accepted progress recoverable', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'state.json'), '{corrupt');
  fs.writeFileSync(path.join(d, 'state.json.bak'), JSON.stringify(good));
  let fail = true;
  const fsx = { ...fs.promises };
  Object.assign(fsx, {
    rename: async (a, b) => {
      if (fail && path.basename(b) === 'state.json') {
        const e = new Error('injected');
        e.code = 'EIO';
        throw e;
      }
      return fs.promises.rename(a, b);
    },
  });
  const s = new Store(d, { fsx });
  await s.init();
  assert.match(s.warning, /backup/);
  const before = JSON.stringify(s.state);
  await assert.rejects(s.recordAttempt({ key: 'k', contentHash: 'h2', mode: 'submit', language: 'python', verdict: 'WRONG_ANSWER', sourceHash: 's2' }), (e) => e.code === 'IO_ERROR');
  assert.equal(JSON.stringify(s.state), before, 'in-memory state unmodified');
  const s2 = new Store(d);
  await s2.init();
  assert.equal(s2.state.progress.k.acceptedContentHash, 'h', 'previously accepted progress recoverable on a new Store');
  assert.equal(s2.state.attempts.length, 1);
  fail = false;
  await s.recordAttempt({ key: 'k', contentHash: 'h2', mode: 'submit', language: 'python', verdict: 'WRONG_ANSWER', sourceHash: 's2' });
  assert.equal((await new Store(d).init()).attempts.length, 2, 'normal persistence resumes');
});
