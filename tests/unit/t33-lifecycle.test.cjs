'use strict';
// T33 (T32 R1 defects 1-2) regressions for src/main/backend.cjs.
// EVIDENCE LABEL: FAKE daemon + explicit promise barriers driving the ACTUAL Backend; the create-exit tests additionally run the REAL
// detached-create runner against REAL OS child processes (node as the "docker" binary) so the exit-code/signal shapes are real. NOT real Docker
// (that is tests/integration/docker.test.cjs) and NOT a forced real-daemon publication reproduction.
// Ported from the reviewer's T32 source diagnostics (t32-lifecycle-probes.cjs); the 16.4 s slow probe is replaced by an equivalent
// deterministic schedule: barrier-held individually-responsive commands and a small stopMs, no permanent slow test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Backend, dockerCreateDetached } = require('../../src/main/backend.cjs');

const INSTALL = '33333333-3333-4333-8333-333333333333';
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const nameOf = (args) => args[args.indexOf('--name') + 1];

/** Fake daemon with a visible-set, per-verb barriers (hold.version/image/ps/rm) and a command log. */
function rig(o = {}) {
  const calls = [];
  const state = { visible: new Set(), creates: [], starts: [], rm: [], inflight: 0 };
  const hold = {};
  const entered = {};
  for (const v of ['version', 'image', 'ps', 'rm', 'inspect']) {
    hold[v] = deferred();
    entered[v] = deferred();
  }
  const barrier = async (v) => {
    entered[v].resolve();
    if (o.hold && o.hold.includes(v)) await hold[v].promise;
  };
  const docker = async (args, timeoutMs) => {
    const verb = args[0];
    calls.push({ verb, args, timeoutMs });
    if (verb === 'create') {
      state.creates.push(nameOf(args));
      return o.createReply ? o.createReply(nameOf(args), state) : ok('ab'.repeat(32));
    }
    if (verb === 'version') {
      await barrier('version');
      return ok('29');
    }
    if (verb === 'image') {
      await barrier('image');
      return ok('sha256:fake');
    }
    if (verb === 'ps') {
      await barrier('ps');
      if (o.psTick) await o.psTick();
      const nm = args.find((x) => x.startsWith('name=^'));
      const ids = [...state.visible].filter((n) => !nm || `name=^${n}$` === nm);
      return ok(ids.map((n) => o.idOf(n)).join('\n'));
    }
    if (verb === 'inspect' || verb === 'kill') return { code: 1, stdout: '', stderr: 'Error: No such container' };
    if (verb === 'rm') {
      await barrier('rm');
      const target = args[args.length - 1];
      state.rm.push(target);
      if (state.visible.delete(target)) return ok(target);
      for (const n of [...state.visible])
        if (o.idOf(n) === target) {
          state.visible.delete(n);
          return ok(target);
        }
      return { code: 1, stdout: '', stderr: `Error: No such container: ${target}` };
    }
    throw new Error(`unmodeled docker verb ${verb}`);
  };
  o.idOf = o.idOf || ((n) => Buffer.from(n).toString('hex').slice(-12));
  const spawn = (_c, args) => {
    state.starts.push(args);
    throw new Error('unexpected start');
  };
  const backend = new Backend({ installId: INSTALL, docker, spawn, dockerCreate: o.dockerCreate, createMs: o.createMs || 400, cleanupMs: o.cleanupMs || 300, stopMs: o.stopMs || 600, readyMs: 400 });
  return { backend, calls, state, hold, entered };
}

// ---------- Defect 1: positive create exit is not authoritative no-creation proof ----------
for (const [label, script, expectCode] of [
  ['response-lost transport error (code 1)', "console.error('error during connect: unexpected EOF');process.exit(1)", 1],
  ['daemon-style error exit (code 125)', 'process.exit(125)', 125],
  ['handled-signal positive exit (128+SIGTERM=143)', "console.error('terminated');process.exit(143)", 143],
]) {
  test(`T33-1 REAL exit shape + FAKE daemon: ${label} => UNKNOWN creation, exact worker retained, late publication cannot be missed`, async () => {
    const late = deferred();
    let vis;
    const r = rig({
      dockerCreate: async (args) => {
        const name = nameOf(args);
        // MODEL: daemon accepted the request; the response was lost; publication is released only after the first receipt.
        late.promise.then(() => vis.add(name));
        return dockerCreateDetached(['-e', script], 1000, process.execPath);
      },
    });
    vis = r.state.visible;
    const st = await r.backend.start();
    assert.equal(st.state, 'cleanup-unconfirmed');
    assert.match(st.reason, /docker rm -f mecode-33333333-/);
    const receipt = await r.backend.stop();
    assert.deepEqual(receipt, { confirmed: false }, `SAFETY: client exit ${expectCode} is not daemon creation completion`);
    assert.equal(r.backend.workers.size, 1, 'exact worker/name retained');
    assert.equal(r.state.visible.size, 0, 'absence check ran before publication');
    late.resolve();
    await flush();
    assert.equal(r.state.visible.size, 1, 'model: object appears after the first receipt');
    assert.deepEqual(await r.backend.stop(), { confirmed: false }, 'repeated stop never upgrades');
    assert.equal(r.backend.workers.size, 1);
    assert.deepEqual(r.state.starts, []);
  });
}

test('T33-1b a SUCCESSFUL create (exit 0 + valid id) still starts and is removed with confirmation', async () => {
  // spawn is unmodeled in this rig, so assert the success classification via a stop between create reply and start (exact removal, confirmed)
  let ref;
  const rr = rig({
    dockerCreate: async (args) => {
      const p = Promise.resolve(ok('cd'.repeat(32)));
      rr.state.visible.add(nameOf(args));
      p.then(() => (ref = rr.backend.stop()));
      return p;
    },
  });
  await rr.backend.start();
  assert.deepEqual(await ref, { confirmed: true });
  assert.deepEqual(rr.state.starts, []);
  assert.equal(rr.state.visible.size, 0);
});

// ---------- Defect 2: one absolute stop budget ----------
test('T33-2a stop while the version preflight is blocked: returns inside stopMs, no image/create issued, truthful after expiry', async () => {
  const r = rig({ hold: ['version'], stopMs: 250 });
  const starting = r.backend.start();
  await r.entered.version.promise;
  const t0 = Date.now();
  const receipt = await r.backend.stop();
  assert.ok(Date.now() - t0 < 1500, 'bounded');
  assert.equal(receipt.confirmed, true, 'nothing was created and every strict check completed');
  r.hold.version.resolve();
  await starting;
  await flush();
  assert.deepEqual(
    r.calls.map((c) => c.verb),
    ['version', 'ps'],
    'only the shutdown final sweep ran after stop; no image/create',
  );
  assert.deepEqual(r.state.creates, []);
});

for (const verb of ['image', 'ps']) {
  test(`T33-2b stop while the ${verb} preflight is blocked: no further startup steps, no create`, async () => {
    const r = rig({ hold: [verb], stopMs: 400 });
    const starting = r.backend.start();
    await r.entered[verb].promise;
    // a shutdown final sweep also issues ps; for 'ps' the barrier would hold it too, so release only after expiry => confirmed:false
    const receipt = await r.backend.stop();
    r.hold[verb].resolve();
    await starting;
    await flush();
    assert.equal(receipt.confirmed, verb === 'image', verb === 'ps' ? 'the final strict sweep could not complete inside the budget => unconfirmed' : 'complete');
    assert.deepEqual(r.state.creates, [], 'never create after stop intent');
    assert.deepEqual(r.state.starts, []);
  });
}

test('T33-2c cumulative: every command is individually responsive (within its own cap) but the total exceeds the stop budget => bounded, unconfirmed, no create', async () => {
  const r = rig({ stopMs: 500, psTick: () => new Promise((res) => setTimeout(res, 180)) });
  // stop was requested BEFORE any preflight: a stopped backend never starts; run the final sweep with multiple owned rows each slow to remove
  for (let i = 0; i < 6; i++) r.state.visible.add(`mecode-33333333-0000000${i}`);
  const origRm = r.backend.docker;
  r.backend.docker = async (args, ms) => {
    if (args[0] === 'rm') await new Promise((res) => setTimeout(res, 180));
    return origRm(args, ms);
  };
  const t0 = Date.now();
  const receipt = await r.backend.stop();
  const elapsed = Date.now() - t0;
  assert.equal(receipt.confirmed, false, 'budget exhausted before strict final absence => truthful unconfirmed');
  assert.ok(elapsed < 900, `bounded by stopMs 500 (+scheduling): ${elapsed}`);
  assert.deepEqual(r.state.creates, []);
  await new Promise((res) => setTimeout(res, 250)); // lets the one already-issued, slow in-flight command land
  const seen = r.calls.length;
  await new Promise((res) => setTimeout(res, 700));
  assert.equal(r.calls.length, seen, 'no Docker command is issued after expiry (no late CLI)');
});

test('T33-2d nonempty final sweep with multiple exact-owned IDs: all removed, strict recheck, confirmed:true', async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) r.state.visible.add(`mecode-33333333-stale00${i}`);
  const receipt = await r.backend.stop();
  assert.deepEqual(receipt, { confirmed: true });
  assert.equal(r.state.rm.length, 3);
  assert.equal(r.state.visible.size, 0);
  assert.ok(r.calls.filter((c) => c.verb === 'ps').length >= 2, 'recheck ps issued');
  for (const c of r.calls) if (c.verb !== 'create') assert.ok(c.timeoutMs <= 600, `${c.verb} timeout is capped by the remaining stop budget`);
});

test('T33-2e expiry while a create is pending: create runner is ABORTED (task-owned CLI), unknown retained, never started', async () => {
  let aborted = 0;
  let signalSeen = null;
  const r = rig({
    stopMs: 300,
    dockerCreate: (args, _ms, _bin, signal) =>
      new Promise((res) => {
        signalSeen = signal;
        signal.addEventListener('abort', () => {
          aborted++;
          res({ code: -1, stdout: '', stderr: '', error: 'aborted' });
        });
      }),
  });
  const starting = r.backend.start();
  for (let i = 0; i < 50 && !signalSeen; i++) await flush();
  assert.ok(signalSeen, 'create runner receives an abort handle');
  const t0 = Date.now();
  const receipt = await r.backend.stop();
  assert.equal(receipt.confirmed, false);
  assert.ok(Date.now() - t0 < 1500);
  await starting;
  assert.equal(aborted, 1);
  assert.equal(r.backend.workers.size, 1, 'exact owned worker retained as uncertainty');
  assert.deepEqual(r.state.starts, []);
});

test('T33-2f cleanup already in flight (idle/retirement) when stop arrives: shared, bounded by the stop budget, no duplicate rm', async () => {
  const r = rig({ stopMs: 300, hold: ['rm'] });
  const w = { name: 'mecode-33333333-inflight0', child: null, createState: 'created', id: 'x' };
  r.backend.workers.add(w);
  r.state.visible.add(w.name);
  const retiring = r.backend._retire(w);
  await r.entered.rm.promise;
  const t0 = Date.now();
  const receipt = await r.backend.stop();
  assert.equal(receipt.confirmed, false, 'in-flight removal never answered inside the budget');
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(r.backend.workers.has(w), true, 'retained until confirmed');
  r.hold.rm.resolve();
  await retiring;
  assert.equal(r.calls.filter((c) => c.verb === 'rm').length, 1, 'no duplicate rm');
});

test('T33-2g the default stop budget sits inside the server 15000 ms emergency exit', () => {
  const b = new Backend({ installId: INSTALL });
  assert.ok(b.stopMs > 0 && b.stopMs <= 12000, `stopMs=${b.stopMs}`);
  assert.ok(15000 - b.stopMs >= 2000, 'margin for scheduling + server teardown');
});

test('T33-2h REAL create CLI: abort kills the task-owned process group and reports UNKNOWN; pre-aborted never launches', { skip: process.platform === 'win32' }, async () => {
  const ac = new AbortController();
  const p = dockerCreateDetached(['-e', 'setInterval(()=>{},1000)'], 20000, process.execPath, ac.signal);
  await new Promise((r) => setTimeout(r, 150));
  const t0 = Date.now();
  ac.abort();
  const res = await p;
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(res.code, -1);
  assert.equal(res.timedOut, false);
  const marker = require('node:path').join(process.env.TMPDIR || require('node:os').tmpdir(), `t33-preabort-${process.pid}`);
  const pre = await dockerCreateDetached(['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`], 5000, process.execPath, ac.signal);
  assert.equal(pre.code, -1);
  assert.equal(require('node:fs').existsSync(marker), false, 'CLI was never launched after abort');
});
