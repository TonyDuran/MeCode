'use strict';
// T35 (T34 residual REDs 1-2) regressions for src/main/backend.cjs.
// EVIDENCE LABEL: ACTUAL Backend. Test A uses a FAKE daemon. Tests B-D use the REAL default dockerExec / execFile / OS children: a task-owned
// FAKE `docker` executable (a node script placed first on PATH of a task-owned parent process) blocks like a CLI awaiting a daemon reply.
// Parent exit is server-style (process.exit). Assertions are on ACTUAL PID absence (/proc), not on promise shapes. NOT real Docker.
// Ported from the reviewer's t34-lifecycle-probes.cjs (read-only reference).
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Backend } = require('../../src/main/backend.cjs');

const INSTALL = '35353535-3535-4535-8535-353535353535';
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKEND = path.resolve(__dirname, '../../src/main/backend.cjs');
const linux = { skip: process.platform !== 'linux' };

function live(pid) {
  try {
    return !/\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
async function gone(pid, ms = 1500) {
  const end = Date.now() + ms;
  while (live(pid) && Date.now() < end) await sleep(20);
  return !live(pid);
}

test('T35-1 a stop issued by a SYNCHRONOUS "starting" observer forbids create (zero create calls, no worker, no attach)', async () => {
  const creates = [];
  let starts = 0;
  let stopping;
  const b = new Backend({
    installId: INSTALL,
    docker: async (args) => {
      if (args[0] === 'version') return ok('29');
      if (args[0] === 'image') return ok('sha256:fake');
      if (args[0] === 'ps') return ok();
      if (args[0] === 'inspect') return ok('false');
      if (args[0] === 'rm') return ok();
      throw new Error(`unmodeled command ${args[0]}`);
    },
    dockerCreate: async (args) => {
      creates.push(args);
      return ok('ab'.repeat(32));
    },
    spawn: () => {
      starts++;
      throw new Error('unexpected attach');
    },
  });
  b.on('status', (s) => {
    if (s.state === 'starting' && !stopping) stopping = b.stop(); // reentrant, inside _set
  });
  await b.start();
  assert.ok(stopping, 'observer ran');
  const r = await stopping;
  assert.equal(creates.length, 0, 'no create after stop intent recorded inside the starting notification');
  assert.equal(starts, 0);
  assert.equal(b.workers.size, 0, 'no worker allocated');
  assert.equal(r.confirmed, true);
});

// ---- real-process fixtures -------------------------------------------------------------------------------------------------------------
/** Task-owned fixture: tmp dir + fake `docker` (node script). MODE env: 'block-version' blocks `version`; 'block-ps' answers everything but blocks `ps`. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't35-'));
  const bin = path.join(dir, 'docker');
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const verb = process.argv[2];
const block = process.env.T35_MODE === 'block-' + verb;
fs.appendFileSync(process.env.T35_PIDS, verb + ' ' + process.pid + '\\n');
if (block) setInterval(() => {}, 1000); // a CLI waiting for a daemon reply
else process.exit(0);
`,
    { mode: 0o755 },
  );
  const pids = path.join(dir, 'pids');
  fs.writeFileSync(pids, '');
  const owned = new Set();
  const read = () =>
    fs
      .readFileSync(pids, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [verb, pid] = l.split(' ');
        owned.add(Number(pid));
        return { verb, pid: Number(pid) };
      });
  return {
    dir,
    pids,
    read,
    owned,
    cleanup() {
      read();
      for (const p of owned)
        if (live(p))
          try {
            process.kill(p, 'SIGKILL');
          } catch {
            /* gone */
          }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run `body` in a task-owned parent that uses the REAL default docker runner; returns { exit, messages }. */
async function runParent(fx, mode, body, extra = {}) {
  const script = `
    const { Backend } = require(${JSON.stringify(BACKEND)});
    const b = new Backend({ installId: ${JSON.stringify(INSTALL)}, ${extra.opts || ''} });
    const fs = require('node:fs');
    const waitFor = async (verb) => { while (!fs.readFileSync(process.env.T35_PIDS, 'utf8').split('\\n').some((l) => l.startsWith(verb + ' '))) await new Promise((r) => setTimeout(r, 10)); };
    (async () => { ${body} })();`;
  const parent = cp.spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, PATH: `${fx.dir}${path.delimiter}${process.env.PATH}`, T35_MODE: mode, T35_PIDS: fx.pids },
  });
  const messages = [];
  let err = '';
  parent.on('message', (m) => messages.push(m));
  parent.stderr.on('data', (d) => (err += d));
  try {
    const exit = await Promise.race([
      new Promise((res, rej) => {
        parent.on('exit', (code, signal) => res({ code, signal }));
        parent.on('error', rej);
      }),
      sleep(6000).then(() => {
        throw new Error('parent did not exit in time');
      }),
    ]);
    return { exit, messages, err };
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
  }
}

test('T35-2 cancellation: stop while a REAL read-only preflight CLI child blocks, then server-style immediate exit => child PID absent', linux, async () => {
  const fx = fixture();
  try {
    const { exit, messages } = await runParent(fx, 'block-version', `b.start(); await waitFor('version'); const r = await b.stop(); process.send({ r }, () => process.exit(r.confirmed ? 0 : 3));`);
    const procs = fx.read();
    const pre = procs.find((p) => p.verb === 'version');
    assert.ok(pre, 'blocking preflight child was started');
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(messages[0].r.confirmed, true);
    assert.equal(await gone(pre.pid), true, 'preflight CLI child still running after parent exit');
    assert.deepEqual(
      procs.map((p) => p.verb),
      ['version', 'ps'],
      'no image/create after stop; only the shutdown sweep',
    );
  } finally {
    fx.cleanup();
  }
});

test('T35-3 stop() itself terminates the cancelled preflight child BEFORE the receipt (parent still alive)', linux, async () => {
  const fx = fixture();
  try {
    const { messages } = await runParent(
      fx,
      'block-version',
      `b.start(); await waitFor('version'); const r = await b.stop(); const pid = Number(fs.readFileSync(process.env.T35_PIDS, 'utf8').split('\\n')[0].split(' ')[1]);
       let alive = true; try { process.kill(pid, 0); alive = fs.readFileSync('/proc/' + pid + '/stat', 'utf8').indexOf(') Z ') < 0; } catch { alive = false; }
       process.send({ r, alive }, () => process.exit(0));`,
    );
    assert.equal(messages[0].r.confirmed, true);
    assert.equal(messages[0].alive, false, 'child must be dead when stop() resolves');
  } finally {
    fx.cleanup();
  }
});

test('T35-4 expiry: stop budget spent while the REAL shutdown-sweep CLI child blocks => unconfirmed receipt, abort kills child, PID absent after exit', linux, async () => {
  const fx = fixture();
  try {
    const { exit, messages } = await runParent(fx, 'block-ps', `const r = await b.stop(); process.send({ r }, () => process.exit(r.confirmed ? 0 : 3));`, { opts: 'stopMs: 600' });
    const procs = fx.read();
    assert.ok(procs.length >= 1, 'blocking sweep child was started');
    assert.equal(messages[0].r.confirmed, false, 'expiry is never a confirmed absence');
    assert.equal(exit.code, 3);
    for (const p of procs) assert.equal(await gone(p.pid), true, `${p.verb} child ${p.pid} still running after parent exit`);
  } finally {
    fx.cleanup();
  }
});

test('T35-5 emergency: parent exits (server 15 s timer analogue) while stop is mid-sweep with a REAL blocking CLI child => exit hook kills it', linux, async () => {
  const fx = fixture();
  try {
    const { exit } = await runParent(
      fx,
      'block-ps',
      `b.stop(); await waitFor('ps'); process.exit(2);`, // no receipt: emergency exit, stop budget (12 s default) NOT spent
    );
    const procs = fx.read();
    assert.ok(procs.length >= 1);
    assert.equal(exit.code, 2);
    for (const p of procs) assert.equal(await gone(p.pid), true, `${p.verb} child ${p.pid} survived emergency exit`);
  } finally {
    fx.cleanup();
  }
});
