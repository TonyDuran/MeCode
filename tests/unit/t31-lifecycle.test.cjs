'use strict';
// T31 (R1) creation-completion / shutdown-truthfulness regressions for src/main/backend.cjs.
// EVIDENCE LABEL: FAKE daemon + FAKE clients (explicit promise barriers, no sleep-driven races) driving the ACTUAL Backend source, plus two
// tests that run the REAL detached-create runner against real OS processes (node as the "docker" binary). Real Docker: tests/integration/docker.test.cjs.
// Ported from the reviewer's T30 schedule (request pending -> cancel -> client close -> failed rm -> empty ps -> receipt -> late publication),
// with the old-bug expectations inverted. The same file is RED against f6e81b9 (legacy `docker run` is modeled so old code reaches the assertions).
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Backend, buildRunArgs, buildCreateArgs, dockerCreateDetached, DEFAULT_LIMITS } = require('../../src/main/backend.cjs');

const INSTALL = '11111111-1111-4111-8111-111111111111';
const ID = 'cd'.repeat(32);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const okControls = (l = DEFAULT_LIMITS) => ({ memoryMax: String(l.memoryMiB * 1048576), pidsMax: String(l.pids), cpuMax: `${Math.round(l.cpus * 100000)} 100000`, uid: 65534 });

/** Fake daemon: a container becomes visible only when its create is PUBLISHED. hold.create/hold.run are barriers; opts.createReply overrides the create reply. */
function rig(o = {}) {
  const log = [];
  const state = { visible: new Set(), creates: [], starts: [], runs: [], rm: [] };
  const entered = deferred();
  const publish = deferred();
  let readyNow = o.ready !== false;
  const children = [];
  const nameOf = (args) => args[args.indexOf('--name') + 1];
  const docker = async (args) => {
    log.push(args.join(' '));
    const a0 = args[0];
    if (o.versionFail && a0 === 'version') return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
    if (a0 === 'version') return { code: 0, stdout: '29', stderr: '' };
    if (a0 === 'image') return { code: 0, stdout: 'sha256:fake\n', stderr: '' };
    if (a0 === 'create') {
      const name = nameOf(args);
      state.creates.push(name);
      entered.resolve(name);
      if (o.createReply) {
        const r = await o.createReply(name, args, state);
        return r;
      }
      if (o.holdCreate) await publish.promise;
      state.visible.add(name);
      return { code: 0, stdout: `${ID}\n`, stderr: '' };
    }
    if (a0 === 'ps') {
      const nm = args.find((x) => x.startsWith('name=^'));
      const ids = [...state.visible].filter((n) => !nm || `name=^${n}$` === nm);
      return { code: 0, stdout: ids.map(() => 'abcdef123456').join('\n'), stderr: '' };
    }
    if (a0 === 'inspect' || a0 === 'kill') return state.visible.has(args[args.length - 1]) ? { code: 0, stdout: 'false\n', stderr: '' } : { code: 1, stdout: '', stderr: 'Error: No such container' };
    if (a0 === 'rm') {
      const n = args[args.length - 1];
      state.rm.push(n);
      if (o.rmFail) return { code: 1, stdout: '', stderr: 'permission denied' };
      if (state.visible.delete(n)) return { code: 0, stdout: n, stderr: '' };
      return { code: 1, stdout: '', stderr: `Error: No such container: ${n}` };
    }
    throw new Error(`unmodeled docker argv ${args}`);
  };
  const spawn = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    let closed = false;
    child.kill = () => {
      if (closed) return true;
      closed = true;
      setImmediate(() => {
        child.stdout.end();
        child.emit('close', 137);
      });
      return true;
    };
    children.push(child);
    if (args[0] === 'start') {
      state.starts.push(args[args.length - 1]);
      if (readyNow) setImmediate(() => child.stdout.write(`${JSON.stringify({ v: 1, type: 'ready', languages: [{ id: 'python', version: 'fake' }], controls: okControls() })}\n`));
    } else if (args[0] === 'run') {
      // legacy (pre-T31) single-step `docker run`: create is pending inside the daemon; it only becomes visible when the barrier is released
      const name = nameOf(args);
      state.runs.push(name);
      entered.resolve(name);
      publish.promise.then(() => state.visible.add(name));
    } else throw new Error(`unmodeled spawn argv ${args}`);
    return child;
  };
  const backend = new Backend({ installId: INSTALL, docker, spawn, readyMs: o.readyMs || 400, cleanupMs: 300, createMs: o.createMs || 400 });
  return { backend, log, state, entered, release: publish.resolve, children };
}

test('T31-1 held create: shutdown cannot confirm before release; release -> exact removal, no start, no reprepare', async () => {
  const r = rig({ holdCreate: true });
  const starting = r.backend.start();
  const name = await r.entered.promise;
  let settled = false;
  const stopping = r.backend.stop().then((x) => ((settled = true), x));
  await flush();
  assert.equal(settled, false, 'LIFECYCLE: shutdown must not report a receipt while the create is unresolved');
  assert.deepEqual(r.state.rm, [], 'nothing removed before the create reply');
  r.release();
  const receipt = await stopping;
  await starting;
  assert.equal(receipt.confirmed, true);
  assert.deepEqual(r.state.starts, [], 'LIFECYCLE: no start after stop intent');
  assert.deepEqual(r.state.runs, []);
  assert.deepEqual(r.state.rm, [name], 'exact Created object removed exactly once');
  assert.equal(r.state.visible.size, 0);
  assert.equal(r.state.creates.length, 1, 'no reprepare');
  assert.equal(r.backend.getStatus().state, 'unavailable');
});

test('T31-2 unknown create outcome + late publication (T30 model): empty ps and failed rm can never produce confirmed:true', async () => {
  const late = deferred();
  const r = rig({
    createReply: async (name, _a, st) => {
      late.promise.then(() => st.visible.add(name)); // daemon publishes AFTER the receipt
      return { code: -1, stdout: '', stderr: '', timedOut: true, error: 'docker create timed out' };
    },
  });
  await r.backend.start();
  const stopped = await r.backend.stop();
  assert.equal(stopped.confirmed, false, 'SAFETY: unresolved creation must not be reported as confirmed shutdown');
  assert.equal(r.state.visible.size, 0, 'absence check happened before publication');
  late.resolve();
  await flush();
  assert.equal(r.state.visible.size, 1, 'model: object appears after the receipt');
  const again = await r.backend.stop();
  assert.equal(again.confirmed, false, 'idempotent stop never upgrades to success');
  assert.equal(r.backend.getStatus().state, 'cleanup-unconfirmed');
});

test('T31-2b legacy-schedule safety (client killed mid-create): stop discards neither failed retirement nor pending creation', async () => {
  const r = rig({ holdCreate: true });
  const starting = r.backend.start();
  await r.entered.promise;
  const stopped = await r.backend.stop();
  // New code: waits for the create reply (barrier never released => bounded by createMs => unknown => unconfirmed). Old code: confirms immediately.
  await starting;
  assert.equal(stopped.confirmed, false, 'SAFETY REGRESSION: unresolved startup create must not be reported as confirmed shutdown');
  r.release();
});

test('T31-3 stop between create reply and start: no start, exact removal, absence confirmed', async () => {
  const stopRef = {};
  const r = rig({
    createReply: (name, _a, st) => {
      st.visible.add(name);
      const p = Promise.resolve({ code: 0, stdout: `${ID}\n`, stderr: '' });
      p.then(() => (stopRef.p = r.backend.stop())); // runs before _start resumes
      return p;
    },
  });
  await r.backend.start();
  const receipt = await stopRef.p;
  assert.equal(receipt.confirmed, true);
  assert.deepEqual(r.state.starts, [], 'no late launch after stop');
  assert.equal(r.state.rm.length, 1);
  assert.equal(r.state.visible.size, 0);
});

test('T31-4 stop during attached startup: client killed, one exact removal (no duplicate-retire failure), no new create', async () => {
  const r = rig({ ready: false, readyMs: 5000 });
  const starting = r.backend.start();
  for (let i = 0; i < 200 && !r.state.starts.length; i++) await flush();
  assert.equal(r.state.starts.length, 1);
  const receipt = await r.backend.stop();
  await starting;
  assert.equal(receipt.confirmed, true);
  assert.equal(r.state.rm.length, 1, 'exactly one rm of the owned name');
  assert.equal(r.state.creates.length, 1);
  assert.equal(r.state.visible.size, 0);
  const second = r.backend.stop();
  assert.equal(second, r.backend.stop(), 'repeated stop shares the same settled receipt');
  assert.deepEqual(await second, { confirmed: true });
  await r.backend.start();
  assert.equal(r.state.creates.length, 1, 'no worker creation after a successful stop');
});

test('T31-5 failed startup retirement survives cur being cleared: shutdown combines it even though ps is empty', async () => {
  const r = rig({ ready: false, readyMs: 60, rmFail: true });
  await r.backend.start(); // never ready -> retire -> rm denied -> unconfirmed; cur cleared
  assert.equal(r.backend.cur, null);
  assert.equal(r.backend.getStatus().state, 'cleanup-unconfirmed');
  r.state.visible.clear(); // an empty ps must not erase the failed retirement
  const receipt = await r.backend.stop();
  assert.equal(receipt.confirmed, false);
});

test('T31-6 (T33-adjusted) positive create exit (code 125 "daemon error"): UNKNOWN, no start, exact name named, shutdown confirmed:false (a CLI exit is not proof of nothing created)', async () => {
  const r = rig({ createReply: async () => ({ code: 125, stdout: '', stderr: 'docker: Error response from daemon: boom' }) });
  const st = await r.backend.start();
  assert.equal(st.state, 'cleanup-unconfirmed');
  assert.match(st.reason, /docker rm -f mecode-11111111-/);
  assert.deepEqual(r.state.starts, []);
  assert.deepEqual(await r.backend.stop(), { confirmed: false });
});

test('T31-6b create timeout: unknown outcome => cleanup-unconfirmed, names the exact object, shutdown confirmed:false', async () => {
  const r = rig({ createReply: async () => ({ code: -1, stdout: '', stderr: '', timedOut: true, error: 'timed out' }) });
  const st = await r.backend.start();
  assert.equal(st.state, 'cleanup-unconfirmed');
  assert.match(st.reason, /docker rm -f mecode-11111111-/);
  assert.deepEqual(r.state.starts, []);
  assert.deepEqual(await r.backend.stop(), { confirmed: false });
});

test('T31-6c create reply with unreadable id is unknown, daemon unavailable creates nothing, removal failure is unconfirmed', async () => {
  const a = rig({ createReply: async () => ({ code: 0, stdout: 'not-an-id\n', stderr: '' }) });
  await a.backend.start();
  assert.deepEqual(await a.backend.stop(), { confirmed: false });
  const b = rig({ versionFail: true });
  assert.equal((await b.backend.start()).state, 'unavailable');
  assert.deepEqual(b.state.creates, []);
  assert.deepEqual(await b.backend.stop(), { confirmed: true });
  const c = rig({ rmFail: true });
  await c.backend.start();
  assert.equal(c.state.starts.length, 1);
  assert.deepEqual(await c.backend.stop(), { confirmed: false });
});

test('T31-7 argv: create keeps the EXACT sandbox/security/resource flags of the old run argv; start attaches by exact name', async () => {
  const o = { name: 'mecode-x', installId: 'iid', image: 'mecode-engine:v2', limits: DEFAULT_LIMITS };
  assert.deepEqual(buildCreateArgs(o), ['create', ...buildRunArgs(o).slice(1)]);
  assert.equal(buildCreateArgs(o)[buildCreateArgs(o).indexOf('--network') + 1], 'none');
  const r = rig();
  await r.backend.start();
  assert.deepEqual(r.state.starts.length, 1);
  assert.match(
    r.log.find((l) => l.startsWith('create ')),
    /--network none .*--cap-drop ALL --security-opt no-new-privileges/,
  );
  await r.backend.stop();
});

// ---- REAL OS processes (node used as the docker binary): process-group isolation and bounded timeout
const pgidOf = (pid) => Number(cp.execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
test('T31-8 REAL: pending create CLI runs in its own process group and survives TERM of the parent group; completes to its reply', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't31-'));
  const pidFile = path.join(dir, 'pid');
  const release = path.join(dir, 'release');
  const done = path.join(dir, 'done');
  const kid = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const t0=Date.now();const w=()=>{if(fs.existsSync(${JSON.stringify(release)})||Date.now()-t0>20000){fs.writeFileSync(${JSON.stringify(done)},'x');console.log('ab'.repeat(32));}else setTimeout(w,20)};w();`;
  const harness = `require(${JSON.stringify(path.join(__dirname, '../../src/main/backend.cjs'))}).dockerCreateDetached(['-e', ${JSON.stringify(kid)}], 30000, process.execPath).then((r)=>console.log(JSON.stringify(r)));`;
  const h = cp.spawn(process.execPath, ['-e', harness], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  h.stdout.on('data', (d) => (out += d));
  let kidPid = 0;
  try {
    for (let i = 0; i < 500 && !kidPid; i++) {
      try {
        kidPid = Number(fs.readFileSync(pidFile, 'utf8'));
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.ok(kidPid > 0, 'create CLI started');
    assert.equal(pgidOf(h.pid), h.pid, 'harness leads its own group');
    assert.equal(pgidOf(kidPid), kidPid, 'create CLI leads a DIFFERENT, task-owned group');
    assert.notEqual(pgidOf(kidPid), pgidOf(h.pid));
    process.kill(-h.pid, 'SIGTERM'); // the harness/terminal group TERM
    await new Promise((r) => h.once('exit', r));
    process.kill(kidPid, 0); // throws if the create CLI died with the group
    assert.equal(fs.existsSync(done), false, 'still pending');
    fs.writeFileSync(release, '');
    for (let i = 0; i < 500 && !fs.existsSync(done); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(done), 'create ran to completion after the parent group was TERMed');
  } finally {
    if (kidPid > 0)
      try {
        process.kill(-kidPid, 'SIGKILL');
      } catch {
        /* gone */
      }
    if (h.pid > 0)
      try {
        process.kill(-h.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T31-9 REAL: create timeout kills the task-owned group, is bounded, and reports an UNKNOWN outcome', { skip: process.platform === 'win32' }, async () => {
  const t0 = Date.now();
  const r = await dockerCreateDetached(['-e', 'setInterval(()=>{},1000)'], 300, process.execPath);
  assert.equal(r.timedOut, true);
  assert.equal(r.code, -1);
  assert.ok(Date.now() - t0 < 3000);
  const ok = await dockerCreateDetached(['-e', "console.log('ab'.repeat(32))"], 5000, process.execPath);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), 'ab'.repeat(32));
  const bad = await dockerCreateDetached(['-e', 'process.exit(125)'], 5000, process.execPath);
  assert.equal(bad.code, 125);
  assert.equal(bad.timedOut, false);
});
