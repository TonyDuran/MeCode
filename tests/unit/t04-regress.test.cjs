'use strict';
// T04 regression tests for Talos T03 findings. Written BEFORE the corresponding fixes (RED recorded in logs/t04-red.log).
// Fake engine / stub docker = MOCK evidence; runner.py runs on the HOST here (not in a container).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Backend, DEFAULT_LIMITS, validateLimits } = require('../../src/main/backend.cjs');
const { Executor } = require('../../src/main/exec.cjs');
const { Catalog } = require('../../src/main/catalog.cjs');
const { Store } = require('../../src/main/store.cjs');
const { judge, compare } = require('../../src/main/judge.cjs');

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'm4-'));
const okControls = (l = DEFAULT_LIMITS) => ({ memoryMax: String(l.memoryMiB * 1048576), pidsMax: String(l.pids), cpuMax: `${Math.round(l.cpus * 100000)} 100000`, uid: 65534 });
function fakeSpawn(script, spawned = []) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { setImmediate(() => { child.stdout.end(); child.emit('close', 137); }); };
    const send = (o) => child.stdout.write(`${JSON.stringify({ v: 1, ...o })}\n`);
    let buf = '';
    child.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); script.onRun && script.onRun(l, send, child); } });
    setImmediate(() => { if (!script.noReady) send({ type: 'ready', languages: [{ id: 'python', version: 'fake' }], controls: script.controls || okControls() }); script.afterReady && script.afterReady(child, send); });
    spawned.push(child);
    return child;
  };
}
const dockerOk = (log = [], o = {}) => async (args) => {
  log.push(args.join(' '));
  if (o.fn) { const r = o.fn(args); if (r) return r; }
  if (args[0] === 'inspect') return { code: 0, stdout: 'false\n', stderr: '' };
  if (args[0] === 'ps') return { code: 0, stdout: '', stderr: '' };
  return { code: 0, stdout: 'x\n', stderr: '' };
};
async function rig(script, dockerFn = dockerOk(), extra = {}) {
  const d = tmp();
  const store = new Store(d, extra.storeOpts); await store.init();
  const catalog = new Catalog(path.join(d, 'packs'), path.join(d, 'lg.json'), { seedDir: path.join(__dirname, '../../packs') }); await catalog.init();
  const backend = new Backend({ installId: store.installId, docker: dockerFn, spawn: fakeSpawn(script, extra.spawned), readyMs: 300, cleanupMs: 200, ...extra.backend });
  await backend.start();
  const exec = new Executor({ catalog, store, backend });
  const key = 'mecode-core/beacon-pairs';
  return { exec, backend, store, catalog, key, hash: catalog.getInternal(key).problem.contentHash, d };
}
const wait = async (exec, id) => { for (let i = 0; i < 150; i++) { const g = exec.get(id); if (g.state === 'done') return g.result; await new Promise((r) => setTimeout(r, 20)); } throw new Error('job never finished'); };
const caseF = (jobId, id, stdout, x = {}) => ({ type: 'case', jobId, id, stdout, stderr: '', exitCode: 0, signal: null, elapsedMs: 1, timedOut: false, outputLimit: false, ...x });
const startJob = (r, mode = 'submit') => r.exec.start({ key: r.key, contentHash: r.hash, language: 'python', source: 'x', mode, customInput: 'a' });
const allDone = (run, send, extra = {}) => { for (const c of run.cases) send(caseF(run.jobId, c.id, '2')); send({ type: 'done', jobId: run.jobId, reason: 'complete', ...extra }); };

// ---- P1-1 lifecycle
test('P1-1 stop(): no reprepare after shutdown; owned container removed; Run rejected', async () => {
  const spawned = []; const log = [];
  const r = await rig({ onRun: (run, send) => allDone(run, send) }, dockerOk(log), { spawned });
  assert.equal(typeof r.backend.stop, 'function');
  await r.backend.stop();
  const n = spawned.length;
  await r.backend.start();
  assert.equal(spawned.length, n, 'no new engine after stop');
  assert.notEqual(r.backend.getStatus().state, 'ready');
  assert.ok(log.some((l) => l.startsWith('rm -f mecode-')), 'owned container removed');
  assert.throws(() => startJob(r), (e) => e.code === 'BACKEND_UNAVAILABLE');
});
test('P1-1 stop() during a running job leaves no reprepare', async () => {
  const spawned = [];
  const r = await rig({ onRun: () => {} }, dockerOk(), { spawned });
  const { jobId } = startJob(r);
  await r.backend.stop();
  await wait(r.exec, jobId);
  await new Promise((x) => setTimeout(x, 50));
  assert.equal(spawned.length, 1, 'no replacement engine started after stop');
});
test('P1-1 stale-removal failure at startup disables Run (cleanup-unconfirmed)', async () => {
  const fn = (a) => (a[0] === 'ps' && a.join(' ').includes('label=mecode.install') ? { code: 0, stdout: 'abc123def\n', stderr: '' } : a[0] === 'rm' ? { code: 1, stdout: '', stderr: 'denied' } : null);
  const b = new Backend({ installId: 'a'.repeat(36), docker: dockerOk([], { fn }), spawn: fakeSpawn({}), readyMs: 200, cleanupMs: 100 });
  const s = await b.start();
  assert.equal(s.state, 'cleanup-unconfirmed');
});
test('P1-1 idle expiry removal failure keeps cleanup-unconfirmed, not ready', async () => {
  const fn = (a) => (a[0] === 'rm' ? { code: 1, stdout: '', stderr: 'nope' } : null);
  const r = await rig({}, dockerOk([], { fn }), { backend: { idleMs: 50 } });
  await new Promise((x) => setTimeout(x, 300));
  assert.equal(r.backend.getStatus().state, 'cleanup-unconfirmed');
});

// ---- P1-2 dead worker / EPIPE
test('P1-2 engine dies after ready: readiness invalidated immediately', async () => {
  const r = await rig({ afterReady: (child) => setTimeout(() => child.kill(), 10) });
  await new Promise((x) => setTimeout(x, 100));
  assert.notEqual(r.backend.getStatus().state, 'ready');
  assert.throws(() => startJob(r), (e) => e.code === 'BACKEND_UNAVAILABLE');
});
test('P1-2 async stdin EPIPE does not crash and the job settles INFRA_ERROR', async () => {
  const r = await rig({ afterReady: (child) => { child.stdin.write = (d, cb) => { setImmediate(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))); return true; }; } });
  const res = await wait(r.exec, startJob(r).jobId);
  assert.equal(res.verdict, 'INFRA_ERROR');
  assert.equal(r.exec.active, null);
});
test('P1-2 injected cleanup rejection still settles the job', async () => {
  let n = 0;
  const fn = (a) => { if (a[0] === 'inspect' && ++n >= 1) throw new Error('boom'); return null; };
  const r = await rig({ onRun: (run, send) => allDone(run, send) }, dockerOk([], { fn }));
  const res = await wait(r.exec, startJob(r).jobId);
  assert.ok(typeof res.verdict === 'string');
  assert.equal(r.exec.active, null);
});

// ---- P1-3 limits
test('P1-3 ready with mismatched / unlimited controls fails closed', async () => {
  for (const controls of [{}, { ...okControls(), memoryMax: 'max' }, { ...okControls(), pidsMax: 'max' }, { ...okControls(), uid: 0 }, { ...okControls(), cpuMax: 'max 100000' }]) {
    const b = new Backend({ installId: 'c'.repeat(36), docker: dockerOk(), spawn: fakeSpawn({ controls }), readyMs: 200 });
    const s = await b.start();
    assert.equal(s.state, 'unavailable', JSON.stringify(controls));
  }
});
test('P1-3 updateLimits: persists first, rejects while busy, applies to next container', async () => {
  const r = await rig({ onRun: () => {} });
  await assert.rejects(() => r.backend.updateLimits({ memoryMiB: 256 }, async () => { throw new Error('disk full'); }));
  assert.equal(r.backend.limits.memoryMiB, 512, 'failed persistence leaves effective limits');
  startJob(r, 'examples');
  await assert.rejects(() => r.backend.updateLimits({ memoryMiB: 256 }, async () => {}), (e) => e.code === 'BUSY');
  r.exec.cancel([...r.exec.jobs.keys()][0]);
});
test('P1-3 limit validation: integer-only where required; inherited keys rejected', () => {
  assert.throws(() => validateLimits({ pids: 40.5 }));
  assert.throws(() => validateLimits({ constructor: 1 }));
  assert.throws(() => validateLimits({ toString: 1 }));
  assert.equal(validateLimits({ pids: 40 }).pids, 40);
});

// ---- P1-4 output/job limits + verdict precedence
function hostRun(lang, source, cases, limits = {}) {
  const wd = tmp();
  const p = cp.spawnSync('python3', [path.join(__dirname, '../../engine/runner.py')], {
    input: `${JSON.stringify({ v: 1, type: 'run', jobId: 'j1', language: lang, source, cases, limits: { caseMs: 1000, compileMs: 10000, jobMs: 10000, outputBytes: 4096, ...limits } })}\n`,
    env: { ...process.env, MECODE_WORKDIR: wd }, encoding: 'utf8', timeout: 60000 });
  return p.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
test('P1-4 mixed stdout+stderr never exceed the combined byte budget; multibyte counted in bytes', () => {
  let fr = hostRun('python', 'import sys\nsys.stdout.write("a"*3000)\nsys.stderr.write("b"*3000)\n', [{ id: 'x', stdin: '' }], { outputBytes: 4096 });
  let c = fr.find((f) => f.type === 'case');
  assert.ok(Buffer.byteLength(c.stdout) + Buffer.byteLength(c.stderr) <= 4096);
  assert.equal(c.outputLimit, true);
  fr = hostRun('python', 'print("é"*3000)', [{ id: 'x', stdin: '' }], { outputBytes: 4096 });
  c = fr.find((f) => f.type === 'case');
  assert.ok(Buffer.byteLength(c.stdout) + Buffer.byteLength(c.stderr) <= 4096);
});
test('P1-4 aggregate output overflow reports output-limit and judge never ACCEPTS it', () => {
  const tests = [{ id: 'a', expected: '1' }, { id: 'b', expected: '1' }];
  const engine = { reason: 'output-limit', cases: [{ id: 'a', stdout: '1', stderr: '', exitCode: 0, signal: null, elapsedMs: 1 }, { id: 'b', stdout: '1', stderr: '', exitCode: 0, signal: null, elapsedMs: 1 }] };
  assert.equal(judge({ mode: 'submit', comparison: 'tokens', tests, engine }).verdict, 'OUTPUT_LIMIT');
  assert.equal(judge({ mode: 'submit', comparison: 'tokens', tests, engine: { ...engine, reason: 'job-timeout' } }).verdict, 'TIME_LIMIT');
});
test('P1-4 compile uses remaining job budget (compileMs > jobMs) and is distinguished from case timeout', () => {
  const fr = hostRun('cpp', '#include <bits/stdc++.h>\nint main(){return 0;}', [{ id: 'x', stdin: '' }], { compileMs: 30000, jobMs: 1 });
  const done = fr.at(-1);
  assert.equal(done.type, 'done');
  assert.notEqual(done.reason, 'complete');
});
test('P1-4 final-case aggregate: runner stops emitting past the aggregate budget', () => {
  const cases = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, stdin: '' }));
  const fr = hostRun('python', 'print("x"*900)', cases, { outputBytes: 1024, aggregateBytes: 2048 });
  const total = fr.filter((f) => f.type === 'case').reduce((n, c) => n + Buffer.byteLength(c.stdout) + Buffer.byteLength(c.stderr), 0);
  assert.ok(total <= 2048, `aggregate ${total}`);
  assert.equal(fr.at(-1).reason, 'output-limit');
});

// ---- P1-5 protocol boundary
test('P1-5 unknown done reason, oversize case, bad status fields => INFRA_ERROR never ACCEPTED', async () => {
  for (const mk of [
    (run, send) => { for (const c of run.cases) send(caseF(run.jobId, c.id, '2')); send({ type: 'done', jobId: run.jobId, reason: 'whatever' }); },
    (run, send) => { send(caseF(run.jobId, run.cases[0].id, 'x'.repeat(200000))); },
    (run, send) => { send(caseF(run.jobId, run.cases[0].id, '2', { exitCode: 'zero' })); },
    (run, send) => { send(caseF(run.jobId, run.cases[0].id, '2', { timedOut: 'yes' })); },
    (run, send) => { send({ type: 'compile', jobId: run.jobId, ok: true }); send({ type: 'compile', jobId: run.jobId, ok: true }); },
  ]) {
    const r = await rig({ onRun: mk }, dockerOk(), { backend: {} });
    const res = await wait(r.exec, startJob(r).jobId);
    assert.equal(res.verdict, 'INFRA_ERROR');
  }
});
test('P1-5 frame flood is bounded', async () => {
  const r = await rig({ onRun: (run, send, child) => { const line = `${JSON.stringify({ v: 1, type: 'x' })}\n`; child.stdout.write(line.repeat(50000)); } });
  const res = await wait(r.exec, startJob(r).jobId);
  assert.equal(res.verdict, 'INFRA_ERROR');
});
test('P1-5 completed job retention is bounded', async () => {
  const r = await rig({ onRun: (run, send) => allDone(run, send) });
  r.exec.maxRetained = 3;
  for (let i = 0; i < 6; i++) { const id = startJob(r, 'examples').jobId; await wait(r.exec, id); for (let k = 0; k < 100 && r.backend.getStatus().state !== 'ready'; k++) await new Promise((x) => setTimeout(x, 20)); }
  assert.ok(r.exec.jobs.size <= 4, `jobs retained ${r.exec.jobs.size}`);
});

// ---- P1-8 persistence truth
test('P1-8 failed state write leaves memory unchanged; result reports persistence failed', async () => {
  const fsx = { ...fs.promises, rename: async (a, b) => { if (String(b).endsWith('state.json') && globalThis.__failRename) throw new Error('inject'); return fs.promises.rename(a, b); } };
  const ans = { 'example-1': '2', 'example-2': '6', 'check-single': '0', 'check-all-equal': '15', 'check-negatives': '2' };
  const r = await rig({ onRun: (run, send) => { for (const c of run.cases) send(caseF(run.jobId, c.id, ans[c.id])); send({ type: 'done', jobId: run.jobId, reason: 'complete' }); } }, dockerOk(), { storeOpts: { fsx } });
  globalThis.__failRename = true;
  const res = await wait(r.exec, startJob(r).jobId);
  globalThis.__failRename = false;
  assert.equal(res.verdict, 'ACCEPTED');
  assert.equal(res.persistence, 'failed');
  assert.equal(r.store.statusOf(r.key, r.hash), 'unsolved', 'in-memory state must not claim solved');
  assert.equal(r.store.state.attempts.length, 0);
});

// ---- P2
test('P2-9 store: valid-JSON bad shape falls back to backup; bad draft/size/revision rejected', async () => {
  const d = tmp(); const s = new Store(d); await s.init();
  fs.copyFileSync(path.join(d, 'state.json'), path.join(d, 'state.json.bak'));
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ schemaVersion: 1, installId: s.installId, progress: {} })); // missing attempts
  const s2 = new Store(d); await s2.init();
  assert.ok(s2.warning, 'warned about recovery'); assert.ok(Array.isArray(s2.state.attempts));
  await assert.rejects(() => s2.saveDraft('k/p', 'python', 'x'.repeat(200 * 1024), 0), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => s2.saveDraft('k/p', 'python', 'x', -1), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => s2.saveDraft('k/p', 'python', 'x', 1.5), (e) => e.code === 'INVALID_INPUT');
});
test('P2-10 import by pack ID replaces bundled core.json with confirmation; snapshot failure visible', async () => {
  const d = tmp();
  const cat = new Catalog(path.join(d, 'packs'), path.join(d, 'lg.json'), { seedDir: path.join(__dirname, '../../packs') }); await cat.init();
  const text = fs.readFileSync(path.join(__dirname, '../../packs/core.json'), 'utf8');
  const c = await cat.import(text, false); assert.equal(c.error.code, 'CONFLICT');
  const ok = await cat.import(text, true);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(fs.readdirSync(path.join(d, 'packs')).length, 1);
  const bad = new Catalog(path.join(d, 'packs'), path.join(d, 'nodir', 'x', 'lg.json'));
  bad._snapshot = async () => { throw new Error('snap'); };
  await bad.init();
  const r = await bad.import(text.replace('mecode-core', 'other-pack'), false);
  assert.equal(r.ok, true); assert.match(String(r.warning || ''), /snapshot/);
});
test('P2-11 comparator trims only ASCII whitespace (NBSP stays significant)', () => {
  assert.equal(compare('tokens', '\u00a0 1', '1'), false);
  assert.equal(compare('tokens', ' 1\r\n', '1'), true);
});
