'use strict';
// T06 regression tests for Talos T05 findings R1 R3 R4 R5 R6 R7. Written BEFORE the fixes (RED in logs/t06-red.log).
// Fake engine / stub docker = MOCK evidence. R6 uses real separate OS processes. R1 uses real filesystem symlinks (sentinels in task temp dirs).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const cp = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Backend, DEFAULT_LIMITS } = require('../../src/main/backend.cjs');
const { Executor } = require('../../src/main/exec.cjs');
const { Catalog } = require('../../src/main/catalog.cjs');
const { Store } = require('../../src/main/store.cjs');
const { createServices } = require('../../src/main/services.cjs');
const web = require('../../src/web/server.cjs');

const root = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't6-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = 'SENTINEL-SECRET-DO-NOT-LEAK';

let lastCreateArgs = []; // limits now travel in the `docker create` argv (start -ai carries only the name)
function controlsFromArgs(args) {
  const g = (f) => args[args.indexOf(f) + 1];
  return { memoryMax: String(parseInt(g('--memory'), 10) * 1048576), pidsMax: g('--pids-limit'), cpuMax: `${Math.round(Number(g('--cpus')) * 100000)} 100000`, uid: 65534 };
}
function fakeSpawn(script = {}, spawned = []) {
  return (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = 0;
    child.kill = () => {
      child.killed += 1;
      setImmediate(() => {
        child.stdout.end();
        child.emit('close', 137);
      });
    };
    const send = (o) => child.stdout.write(`${JSON.stringify({ v: 1, ...o })}\n`);
    child.send = send;
    child.raw = (s) => child.stdout.write(s);
    if (script.holdWrites) {
      const w = child.stdin.write.bind(child.stdin);
      child.stdin.write = (d, cb) => {
        child.heldWrite = () => w(d, cb);
        return false;
      };
    }
    let buf = '';
    child.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        script.onRun && script.onRun(l, send, child);
      }
    });
    setImmediate(() => {
      if (script.noReady) return;
      send({ type: 'ready', languages: [{ id: 'python', version: 'fake' }], controls: controlsFromArgs(lastCreateArgs), ...(script.ready || {}) });
    });
    spawned.push(child);
    return child;
  };
}
const dockerOk =
  (log = [], o = {}) =>
  async (args) => {
    log.push({ t: Date.now(), a: args.join(' ') });
    if (args[0] === 'create') lastCreateArgs = args;
    if (o.delay) await sleep(o.delay);
    if (args[0] === 'inspect') return { code: 0, stdout: 'false\n', stderr: '' };
    if (args[0] === 'ps') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: args[0] === 'create' ? `${'ab'.repeat(32)}\n` : 'x\n', stderr: '' };
  };
const caseF = (jobId, id, stdout, x = {}) => ({ type: 'case', jobId, id, stdout, stderr: '', exitCode: 0, signal: null, elapsedMs: 1, timedOut: false, outputLimit: false, ...x });
const LIM = { caseMs: 2000, compileMs: 10000, jobMs: 5000, outputBytes: 262144 };
const mkBackend = (script, o = {}) => {
  const spawned = [];
  const log = [];
  const b = new Backend({ installId: '11111111-2222-3333-4444-555555555555', docker: o.docker || dockerOk(log), spawn: fakeSpawn(script, spawned), readyMs: 300, cleanupMs: 200, ...o.opts });
  return { b, spawned, log };
};

// ===================== R1 managed storage =====================
async function sentinelDir() {
  const d = tmp();
  const f = path.join(d, 'sentinel.txt');
  fs.writeFileSync(f, SECRET);
  return { d, f, snap: () => ({ files: fs.readdirSync(d).sort(), text: fs.readFileSync(f, 'utf8') }) };
}

test('R1 drafts directory symlinked outside: save refused, nothing written outside', async () => {
  const out = await sentinelDir();
  const before = out.snap();
  const d = tmp();
  const s = new Store(d);
  await s.init();
  fs.symlinkSync(out.d, path.join(d, 'drafts'));
  await assert.rejects(s.saveDraft('k/p', 'python', 'print(1)', 0), (e) => e.code === 'IO_ERROR' && !String(e.message).includes(SECRET));
  assert.deepEqual(out.snap(), before);
});
test('R1 draft leaf symlink to outside secret: load refused, secret not returned or logged', async () => {
  const out = await sentinelDir();
  const d = tmp();
  const s = new Store(d);
  await s.init();
  fs.mkdirSync(path.join(d, 'drafts'));
  fs.symlinkSync(out.f, s._draftFile('k/p', 'python'));
  await assert.rejects(s.loadDraft('k/p', 'python'), (e) => e.code === 'IO_ERROR' && !JSON.stringify(e).includes(SECRET));
  await assert.rejects(s.saveDraft('k/p', 'python', 'x', 0), (e) => e.code === 'IO_ERROR');
  assert.equal(fs.readFileSync(out.f, 'utf8'), SECRET);
});
test('R1 state.json.bak symlink: backup never overwrites the target; state.json symlink refused', async () => {
  const out = await sentinelDir();
  const d = tmp();
  const s = new Store(d);
  await s.init();
  fs.symlinkSync(out.f, path.join(d, 'state.json.bak'));
  await assert.rejects(s.recordAttempt({ key: 'k', contentHash: 'h', mode: 'submit', language: 'python', verdict: 'WRONG_ANSWER', sourceHash: 's' }), (e) => e.code === 'IO_ERROR');
  assert.equal(fs.readFileSync(out.f, 'utf8'), SECRET);
  const d2 = tmp();
  fs.symlinkSync(out.f, path.join(d2, 'state.json'));
  await assert.rejects(new Store(d2).init(), (e) => e.code === 'IO_ERROR' && !JSON.stringify(e).includes(SECRET));
  assert.equal(fs.readFileSync(out.f, 'utf8'), SECRET);
});
test('R1 symlinked data root refused', async () => {
  const out = await sentinelDir();
  const link = path.join(tmp(), 'root-link');
  fs.symlinkSync(out.d, link);
  await assert.rejects(new Store(link).init(), (e) => e.code === 'IO_ERROR');
  assert.deepEqual(fs.readdirSync(out.d), ['sentinel.txt']);
});
test('R1 packs dir / pack leaf / snapshot symlinks: no outside read, no outside write', async () => {
  const seed = path.join(root, 'packs');
  // packs dir is a symlink to an external dir holding a VALID pack: it must not be loaded
  const ext = tmp();
  for (const f of fs.readdirSync(seed)) fs.copyFileSync(path.join(seed, f), path.join(ext, f));
  const d = tmp();
  fs.symlinkSync(ext, path.join(d, 'packs'));
  const c = new Catalog(path.join(d, 'packs'), path.join(d, 'last-good.json'));
  const r = await c.init();
  assert.equal(r.ok, false);
  assert.equal(c.problemCount(), 0);
  const before = fs.readdirSync(ext).sort();
  const imp = await c.import(fs.readFileSync(path.join(seed, fs.readdirSync(seed)[0]), 'utf8'), true);
  assert.equal(imp.ok, false);
  assert.deepEqual(fs.readdirSync(ext).sort(), before);
  // pack leaf symlink to external file
  const d2 = tmp();
  fs.mkdirSync(path.join(d2, 'packs'));
  const first = fs.readdirSync(seed)[0];
  fs.symlinkSync(path.join(ext, first), path.join(d2, 'packs', first));
  const c2 = new Catalog(path.join(d2, 'packs'), path.join(d2, 'last-good.json'));
  assert.equal((await c2.init()).ok, false);
  assert.equal(c2.problemCount(), 0);
  // snapshot leaf symlink: sentinel unchanged
  const out = await sentinelDir();
  const d3 = tmp();
  fs.symlinkSync(out.f, path.join(d3, 'last-good.json'));
  const c3 = new Catalog(path.join(d3, 'packs'), path.join(d3, 'last-good.json'), { seedDir: seed });
  await c3.init();
  assert.equal(fs.readFileSync(out.f, 'utf8'), SECRET);
  assert.ok(c3.lastError && /snapshot|IO_ERROR/i.test(JSON.stringify(c3.lastError)));
});
test('R1 settings.json symlink: not read, not written', async () => {
  const out = await sentinelDir();
  fs.writeFileSync(out.f, JSON.stringify({ limits: { memoryMiB: 256 } }));
  const d = tmp();
  fs.symlinkSync(out.f, path.join(d, 'settings.json'));
  const svc = await createServices({ userData: d, appRoot: root, autostart: false });
  svc.backend.status = { state: 'unavailable', languages: [] };
  assert.equal(svc.backend.limits.memoryMiB, DEFAULT_LIMITS.memoryMiB, 'symlinked settings must not be read');
  await assert.rejects(svc.handlers['settings.update']({ limits: { memoryMiB: 300 } }), (e) => e.code === 'IO_ERROR');
  assert.equal(JSON.parse(fs.readFileSync(out.f, 'utf8')).limits.memoryMiB, 256);
  await svc.shutdown();
});
test('R1 launchFile: permissive pre-existing file tightened to 0600; symlink refused without leaking token', async () => {
  const d = tmp();
  const lf = path.join(tmp(), 'launch.txt');
  fs.writeFileSync(lf, 'old', { mode: 0o666 });
  fs.chmodSync(lf, 0o666);
  const w = await web.startWeb({ userData: d, appRoot: root, autostart: false, launchFile: lf });
  try {
    assert.equal(fs.statSync(lf).mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(lf, 'utf8').includes(w.token));
  } finally {
    await w.close();
  }
  const out = await sentinelDir();
  const lf2 = path.join(tmp(), 'launch2.txt');
  fs.symlinkSync(out.f, lf2);
  const d2 = tmp();
  await assert.rejects(web.startWeb({ userData: d2, appRoot: root, autostart: false, launchFile: lf2 }), (e) => !String(e.message).match(/[0-9a-f]{64}/));
  assert.equal(fs.readFileSync(out.f, 'utf8'), SECRET);
  assert.equal(fs.existsSync(path.join(d2, 'server.lock')), false, 'lock released after failed launch-file');
});

// ===================== R3 settings lifecycle =====================
test('R3 deferred persist: Run/Retry/second update/rejected while settings transition holds; accepted job never killed; stop wins', async () => {
  const { b, spawned } = mkBackend({
    onRun: (run, send) => {
      setTimeout(() => {
        for (const c of run.cases) send(caseF(run.jobId, c.id, '2'));
        send({ type: 'done', jobId: run.jobId, reason: 'complete' });
      }, 80);
    },
  });
  await b.start();
  assert.equal(b.getStatus().state, 'ready');
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const up = b.updateLimits({ memoryMiB: 256 }, () => gate);
  assert.notEqual(b.getStatus().state, 'ready', 'readiness must drop synchronously when the settings transition starts');
  const run = await b.run({ jobId: 'j1', language: 'python', source: 'x', cases: [{ id: 'a', stdin: '' }], limits: LIM });
  assert.equal(run.kind, 'BACKEND_UNAVAILABLE');
  let called = false;
  await assert.rejects(
    b.updateLimits({ memoryMiB: 300 }, async () => {
      called = true;
    }),
    (e) => e.code === 'BUSY',
  );
  assert.equal(called, false);
  release();
  await up;
  assert.equal(b.limits.memoryMiB, 256);
  assert.equal(b.getStatus().state, 'ready');
  assert.equal(spawned[1].killed, 0);
  // an accepted job is NOT killed by a later (rejected) update
  const jp = b.run({ jobId: 'j2', language: 'python', source: 'x', cases: [{ id: 'a', stdin: '' }], limits: LIM });
  await assert.rejects(
    b.updateLimits({ memoryMiB: 200 }, async () => {}),
    (e) => e.code === 'BUSY',
  );
  const done = await jp;
  assert.equal(done.ok, true);
  await b.stop();
});
test('R3 failed persist restores prior readiness and settings; stop during persist prevents adoption', async () => {
  const { b } = mkBackend({});
  await b.start();
  await assert.rejects(
    b.updateLimits({ memoryMiB: 256 }, async () => {
      throw new Error('disk full');
    }),
  );
  assert.equal(b.limits.memoryMiB, DEFAULT_LIMITS.memoryMiB);
  assert.equal(b.getStatus().state, 'ready');
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const up = b.updateLimits({ memoryMiB: 256 }, () => gate);
  const stopped = b.stop();
  release();
  await assert.rejects(up, (e) => e.code === 'BACKEND_UNAVAILABLE');
  await stopped;
  assert.equal(b.limits.memoryMiB, DEFAULT_LIMITS.memoryMiB);
  assert.equal(b.getStatus().state, 'unavailable');
});
test('R3 executor takes limits from the enforced worker snapshot', async () => {
  const { b } = mkBackend({});
  await b.start();
  const d = tmp();
  const store = new Store(d);
  await store.init();
  const catalog = new Catalog(path.join(d, 'packs'), path.join(d, 'lg.json'), { seedDir: path.join(root, 'packs') });
  await catalog.init();
  const key = 'mecode-core/beacon-pairs';
  const ex = new Executor({ catalog, store, backend: b });
  b.limits = { ...b.limits, memoryMiB: 999 }; // requested value drifts from what the running worker enforces
  const { jobId } = ex.start({ key, contentHash: catalog.getInternal(key).problem.contentHash, language: 'python', source: 'x', mode: 'examples' });
  assert.equal(ex.jobs.get(jobId).limits.memoryMiB, DEFAULT_LIMITS.memoryMiB);
  await b.stop();
});

// ===================== R4 deadlines =====================
test('R4 blocked stdin write: independent job deadline fires, single settlement, owned cleanup', async () => {
  const { b, log } = mkBackend({ holdWrites: true }, { opts: { watchdogGraceMs: 50 } });
  await b.start();
  const t0 = Date.now();
  const r = await b.run({ jobId: 'j', language: 'python', source: 'x'.repeat(1000), cases: [{ id: 'a', stdin: '' }], limits: { ...LIM, jobMs: 200 } });
  assert.equal(r.kind, 'WATCHDOG');
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
  assert.ok(
    log.some((l) => l.a.startsWith('rm -f mecode-')),
    'owned container removed',
  );
  await b.stop();
});
test('R4 stop during never-ready startup kills the spawned worker immediately', async () => {
  const spawned = [];
  const { b } = mkBackend({ noReady: true }, { opts: { readyMs: 15000 } });
  b.spawn = fakeSpawn({ noReady: true }, spawned);
  const st = b.start();
  await sleep(60);
  assert.equal(spawned.length, 1);
  const t0 = Date.now();
  const r = await b.stop();
  await st;
  assert.ok(Date.now() - t0 < 2000, `stop took ${Date.now() - t0}ms`);
  assert.ok(spawned[0].killed >= 1);
  assert.equal(r.confirmed, true);
});
test('R4 cleanup budget is strict: slow-but-responding docker gets no renewed minimum after expiry', async () => {
  const log = [];
  const { b } = mkBackend({}, { docker: dockerOk(log, { delay: 400 }), opts: { cleanupMs: 150 } });
  b.cur = null;
  const w = { name: 'mecode-test-x', child: { kill() {} } };
  const t0 = Date.now();
  const c = await b._cleanup(w);
  const took = Date.now() - t0;
  assert.equal(c.confirmed, false);
  assert.ok(took < 330, `cleanup took ${took}ms for a 150ms budget`);
  await sleep(500);
  assert.ok(log.filter((l) => l.t - t0 > 160 && !l.a.startsWith('kill')).length === 0, `docker command issued after budget expiry: ${JSON.stringify(log.map((l) => [l.t - t0, l.a]))}`);
});

// ===================== R5 protocol =====================
async function runWith(script, cases = [{ id: 'a', stdin: '' }], limits = LIM) {
  const { b } = mkBackend(script);
  await b.start();
  try {
    return await b.run({ jobId: 'j', language: 'python', source: 'x', cases, limits });
  } finally {
    await b.stop();
  }
}
const okRun = (run, send, extra = {}) => {
  for (const c of run.cases) send(caseF(run.jobId, c.id, '2'));
  send({ type: 'done', jobId: run.jobId, reason: 'complete', ...extra });
};
test('R5 ready with wrong protocol version is not ready', async () => {
  const { b } = mkBackend({ ready: { v: 2 } });
  await b.start();
  assert.equal(b.getStatus().state, 'unavailable');
  await b.stop();
});
test('R5 compile frame consistency: ok+timedOut, timedOut without limit, bad elapsed', async () => {
  for (const bad of [
    { ok: true, timedOut: true, limit: 'job' },
    { ok: false, timedOut: true },
    { ok: true, timedOut: false, limit: 'job' },
    { ok: true, timedOut: false, elapsedMs: -5 },
    { ok: true, timedOut: false, limit: 'bogus' },
  ]) {
    const r = await runWith({
      onRun: (run, send) => {
        send({ type: 'compile', jobId: run.jobId, output: '', elapsedMs: 1, ...bad });
        okRun(run, send);
      },
    });
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.equal(r.kind, 'INFRA_ERROR');
  }
  const good = await runWith({
    onRun: (run, send) => {
      send({ type: 'compile', jobId: run.jobId, ok: true, timedOut: false, output: '', elapsedMs: 1, limit: null });
      okRun(run, send);
    },
  });
  assert.equal(good.ok, true);
  const to = await runWith({
    onRun: (run, send) => {
      send({ type: 'compile', jobId: run.jobId, ok: false, timedOut: true, output: '', elapsedMs: 9, limit: 'compile' });
      send({ type: 'done', jobId: run.jobId, reason: 'compile-error' });
    },
  });
  assert.equal(to.ok, true);
  assert.equal(to.engine.compile.limit, 'compile', 'compile-vs-job reason is surfaced');
});
test('R5 buffered trailing/duplicate/malformed frames after done are rejected', async () => {
  for (const tail of [`${JSON.stringify({ v: 1, type: 'done', jobId: 'j', reason: 'complete' })}\n`, 'not json\n', `${JSON.stringify({ v: 1, type: 'case', jobId: 'j', id: 'zz' })}\n`]) {
    const r = await runWith({
      onRun: (run, _s, child) => {
        const lines = run.cases.map((c) => JSON.stringify({ v: 1, ...caseF(run.jobId, c.id, '2') }));
        lines.push(JSON.stringify({ v: 1, type: 'done', jobId: run.jobId, reason: 'complete' }));
        child.raw(`${lines.join('\n')}\n${tail}`); // ONE chunk
      },
    });
    assert.equal(r.ok, false, `accepted tail ${tail.slice(0, 20)}`);
    assert.equal(r.kind, 'INFRA_ERROR');
  }
});
test('R5 queue bytes are decremented on consumption: streamed JSON-escaped output within caps is not INFRA_ERROR', async () => {
  const big = '\u0000'.repeat(200000); // 200 KB raw -> ~1.2 MB JSON-escaped per frame; 5 frames ~6 MB cumulative > 4 MiB, 1 MB aggregate <= cap
  const cases = [0, 1, 2, 3, 4].map((i) => ({ id: `c${i}`, stdin: '' }));
  const r = await runWith(
    {
      onRun: async (run, send) => {
        for (const c of run.cases) {
          send(caseF(run.jobId, c.id, big));
          await sleep(60);
        }
        send({ type: 'done', jobId: run.jobId, reason: 'complete' });
      },
    },
    cases,
  );
  assert.equal(r.ok, true, r.message);
  assert.equal(r.engine.cases.length, 5);
});
test('R5 aggregate output above the declared 1 MiB cap is rejected exactly', async () => {
  const body = 'a'.repeat(262144);
  const cases = [0, 1, 2, 3, 4].map((i) => ({ id: `c${i}`, stdin: '' }));
  const mk = (n) =>
    runWith(
      {
        onRun: async (run, send) => {
          for (const c of run.cases.slice(0, n)) {
            send(caseF(run.jobId, c.id, body));
            await sleep(30);
          }
          send({ type: 'done', jobId: run.jobId, reason: n === 5 ? 'complete' : 'output-limit' });
        },
      },
      cases,
    );
  const four = await mk(4);
  assert.equal(four.ok, true, four.message);
  const five = await mk(5);
  assert.equal(five.ok, false);
  assert.equal(five.kind, 'INFRA_ERROR');
});

// ===================== R6 lock =====================
const LOCKER = `
const web = require(${JSON.stringify(path.join(root, 'src/web/server.cjs'))});
const fs = require('fs'); const [dir, goAt, hold] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
while (Date.now() < goAt) {}
let l; try { l = web.acquireLock(dir); } catch (e) { console.log('LOCKED'); process.exit(0); }
console.log('OWNER');
const t = Date.now() + hold; while (Date.now() < t) {}
let intact = false; try { intact = fs.readFileSync(l.file || l, 'utf8').includes(String(process.pid)); } catch {}
console.log(intact ? 'INTACT' : 'LOST');
web.releaseLock(l);
`;
function raceLockers(dir, n = 6, hold = 400) {
  const goAt = Date.now() + 500;
  const script = path.join(tmp(), 'locker.cjs');
  fs.writeFileSync(script, LOCKER);
  return Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise((resolve) => {
          let out = '';
          const c = cp.spawn(process.execPath, [script, dir, String(goAt), String(hold)]);
          c.stdout.on('data', (d) => {
            out += d;
          });
          c.on('close', () => resolve(out.trim().split('\n')));
        }),
    ),
  );
}
test('R6 incomplete (empty/garbage) lock fails closed and is never unlinked', () => {
  for (const content of ['', '{', 'garbage', '{"pid":"x"}']) {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'server.lock'), content);
    assert.throws(
      () => web.acquireLock(d),
      (e) => e.code === 'LOCKED',
    );
    assert.equal(fs.readFileSync(path.join(d, 'server.lock'), 'utf8'), content);
  }
});
test('R6 simultaneous acquisition in 6 real processes: exactly one owner', async () => {
  for (let round = 0; round < 3; round++) {
    const res = await raceLockers(tmp());
    assert.equal(res.filter((r) => r[0] === 'OWNER').length, 1, JSON.stringify(res));
    assert.ok(res.filter((r) => r[0] === 'OWNER').every((r) => r[1] === 'INTACT'));
  }
});
test('R6 simultaneous stale takeover: exactly one owner, replacement never removed', async () => {
  for (let round = 0; round < 4; round++) {
    const d = tmp();
    const dead = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
    fs.writeFileSync(path.join(d, 'server.lock'), JSON.stringify({ pid: Number(dead), nonce: 'old' }));
    const res = await raceLockers(d);
    assert.equal(res.filter((r) => r[0] === 'OWNER').length, 1, JSON.stringify(res));
    assert.ok(
      res.filter((r) => r[0] === 'OWNER').every((r) => r[1] === 'INTACT'),
      JSON.stringify(res),
    );
  }
});
test('R6 release never unlinks a replacement owner', () => {
  const d = tmp();
  const l = web.acquireLock(d);
  fs.rmSync(path.join(d, 'server.lock'));
  fs.writeFileSync(path.join(d, 'server.lock'), JSON.stringify({ pid: process.pid, nonce: 'someone-else' }));
  web.releaseLock(l);
  assert.ok(fs.existsSync(path.join(d, 'server.lock')));
});
test('R6 post-lock startup failures (assets, listen, launch file) stop services and release only our lock', async () => {
  const mkRoot = () => {
    const r = tmp();
    fs.mkdirSync(path.join(r, 'src', 'renderer'), { recursive: true });
    fs.cpSync(path.join(root, 'src', 'renderer'), path.join(r, 'src', 'renderer'), { recursive: true });
    fs.cpSync(path.join(root, 'packs'), path.join(r, 'packs'), { recursive: true });
    return r;
  };
  const cases = {
    assets: async () => {
      const r = mkRoot();
      fs.rmSync(path.join(r, 'src', 'renderer', 'app.js'));
      return { appRoot: r };
    },
    listen: async () => {
      const s = net.createServer();
      await new Promise((res) => s.listen(0, '127.0.0.1', res));
      return { appRoot: root, port: s.address().port, after: () => s.close() };
    },
    launchFile: async () => ({ appRoot: root, launchFile: path.join(tmp(), 'no', 'such', 'dir', 'l.txt') }),
  };
  for (const [name, mk] of Object.entries(cases)) {
    const spawned = [];
    const log = [];
    const d = tmp();
    const o = await mk();
    await assert.rejects(
      web.startWeb({
        userData: d,
        appRoot: o.appRoot,
        port: o.port || 0,
        launchFile: o.launchFile || null,
        backendOpts: { docker: dockerOk(log), spawn: fakeSpawn({}, spawned), readyMs: 300, cleanupMs: 200 },
      }),
      undefined,
      name,
    );
    if (o.after) o.after();
    assert.equal(fs.existsSync(path.join(d, 'server.lock')), false, `${name}: lock residue`);
    assert.ok(
      spawned.every((c) => c.killed >= 1),
      `${name}: owned worker not stopped`,
    );
  }
});

// ===================== R7 persisted data =====================
test('R7 missing draft = absent; every valid-JSON non-record draft is a visible IO_ERROR, never a starter', async () => {
  const d = tmp();
  const s = new Store(d);
  await s.init();
  assert.equal((await s.loadDraft('k/p', 'python')).source, null);
  fs.mkdirSync(path.join(d, 'drafts'), { recursive: true });
  const good = { key: 'k/p', lang: 'python', source: 'x', revision: 1, updatedAt: '2026-01-01T00:00:00.000Z' };
  const bad = [
    'null',
    'false',
    '0',
    '""',
    '[]',
    '{}',
    '"str"',
    '7',
    JSON.stringify({ ...good, source: 5 }),
    JSON.stringify({ ...good, revision: -1 }),
    JSON.stringify({ ...good, revision: 1.5 }),
    JSON.stringify({ ...good, updatedAt: 5 }),
    JSON.stringify({ ...good, source: 'x'.repeat(128 * 1024 + 1) }),
    JSON.stringify({ ...good, key: 'other' }),
    JSON.stringify({ ...good, extra: 1 }),
  ];
  for (const text of bad) {
    fs.writeFileSync(s._draftFile('k/p', 'python'), text);
    await assert.rejects(s.loadDraft('k/p', 'python'), (e) => e.code === 'IO_ERROR', `accepted ${text.slice(0, 40)}`);
    await assert.rejects(s.saveDraft('k/p', 'python', 'new', 0), (e) => e.code === 'IO_ERROR', `overwrote ${text.slice(0, 40)}`);
    assert.equal(fs.readFileSync(s._draftFile('k/p', 'python'), 'utf8'), text, 'corrupt draft preserved for recovery');
  }
  fs.writeFileSync(s._draftFile('k/p', 'python'), JSON.stringify(good));
  assert.equal((await s.loadDraft('k/p', 'python')).source, 'x');
});
test('R7 nested state records are validated; invalid nested state recovers from a valid backup or fails visibly', async () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const base = { schemaVersion: 1, installId: id, progress: {}, attempts: [] };
  const att = { key: 'k', contentHash: 'h', mode: 'submit', language: 'python', verdict: 'ACCEPTED', sourceHash: 's', at: '2026-01-01T00:00:00.000Z' };
  const bads = [
    { ...base, progress: { k: 'x' } },
    { ...base, progress: { k: 5 } },
    { ...base, progress: { k: [] } },
    { ...base, progress: { k: { lastVerdict: 5 } } },
    { ...base, progress: { k: { lastVerdict: 'x'.repeat(5000) } } },
    { ...base, attempts: [5] },
    { ...base, attempts: [null] },
    { ...base, attempts: [{ ...att, mode: 'bogus' }] },
    { ...base, attempts: [{ ...att, key: 7 }] },
    { ...base, attempts: [{ ...att, verdict: 'x'.repeat(100) }] },
  ];
  for (const b of bads) {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(b));
    await assert.rejects(new Store(d).init(), (e) => e.code === 'IO_ERROR', `adopted ${JSON.stringify(b).slice(0, 60)}`);
    const d2 = tmp();
    fs.writeFileSync(path.join(d2, 'state.json'), JSON.stringify(b));
    fs.writeFileSync(path.join(d2, 'state.json.bak'), JSON.stringify({ ...base, attempts: [att] }));
    const s2 = new Store(d2);
    await s2.init();
    assert.ok(s2.warning && /backup/.test(s2.warning));
    assert.equal(s2.state.attempts.length, 1);
    await s2.recordAttempt({ key: 'k', contentHash: 'h', mode: 'submit', language: 'python', verdict: 'WRONG_ANSWER', sourceHash: 's' }); // subsequent persistence not poisoned
    const d3 = tmp();
    fs.writeFileSync(path.join(d3, 'state.json'), JSON.stringify(b));
    fs.writeFileSync(path.join(d3, 'state.json.bak'), JSON.stringify(b));
    await assert.rejects(new Store(d3).init(), (e) => e.code === 'IO_ERROR', 'invalid backup must not be adopted');
  }
  const d4 = tmp();
  fs.writeFileSync(path.join(d4, 'state.json'), JSON.stringify({ ...base, progress: { k: { lastVerdict: 'ACCEPTED', acceptedContentHash: 'h' } }, attempts: [att] }));
  const s4 = new Store(d4);
  await s4.init();
  assert.equal(s4.state.attempts.length, 1);
});
