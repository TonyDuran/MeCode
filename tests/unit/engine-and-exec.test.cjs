'use strict';
// Protocol/lifecycle tests with a FAKE engine process (mock, not container execution) + HOST-run runner tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Backend } = require('../../src/main/backend.cjs');
const { Executor } = require('../../src/main/exec.cjs');
const { Catalog } = require('../../src/main/catalog.cjs');
const { Store } = require('../../src/main/store.cjs');

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mc-'));

/** fake `docker run` child: script(frameWriter, onLine) */
function fakeSpawn(script) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      setImmediate(() => {
        child.stdout.end();
        child.emit('close', 137);
      });
    };
    const send = (o) => child.stdout.write(`${JSON.stringify({ v: 1, ...o })}\n`);
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
      if (!script.noReady) send({ type: 'ready', languages: [{ id: 'python', version: 'fake' }], controls: { memoryMax: String(512 * 1048576), pidsMax: '64', cpuMax: '100000 100000', uid: 65534 } });
    });
    return child;
  };
}
const dockerOk =
  (log = [], { oom = 'false', leftover = '' } = {}) =>
  async (args) => {
    log.push(args.join(' '));
    if (args[0] === 'inspect') return { code: 0, stdout: `${oom}\n`, stderr: '' };
    if (args[0] === 'ps') return { code: 0, stdout: args.join(' ').includes('name=^') ? leftover : '', stderr: '' };
    return { code: 0, stdout: args[0] === 'create' ? `${'ab'.repeat(32)}\n` : 'x\n', stderr: '' };
  };

async function rig(script, dockerFn = dockerOk()) {
  const d = tmp();
  const store = new Store(d);
  await store.init();
  const catalog = new Catalog(path.join(d, 'packs'), path.join(d, 'lg.json'), { seedDir: path.join(__dirname, '../../packs') });
  await catalog.init();
  const backend = new Backend({ installId: store.installId, docker: dockerFn, spawn: fakeSpawn(script), readyMs: 300, cleanupMs: 200 });
  await backend.start();
  const exec = new Executor({ catalog, store, backend });
  const key = 'mecode-core/beacon-pairs';
  const hash = catalog.getInternal(key).problem.contentHash;
  return { exec, backend, store, catalog, key, hash };
}
const wait = async (exec, id) => {
  for (let i = 0; i < 100; i++) {
    const g = exec.get(id);
    if (g.state === 'done') return g.result;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job never finished');
};
const caseFrame = (jobId, id, stdout, extra = {}) => ({ type: 'case', jobId, id, stdout, stderr: '', exitCode: 0, signal: null, elapsedMs: 1, timedOut: false, outputLimit: false, ...extra });

test('protocol: engine output judged HOST-side; wrong answer vs accepted; progress awarded only on submit+ACCEPTED', async () => {
  // the fake engine answers every stored case of the bundled beacon-pairs problem with that case's stored answer
  const answers = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(__dirname, '../../packs/core.json'), 'utf8')).problems[0].tests.map((t) => [t.id, t.expected.trim()]));
  let wrong = false;
  const r = await rig({
    onRun: (run, send) => {
      assert.equal(JSON.stringify(run).includes('expected'), false, 'expected answers must not reach the engine');
      for (const c of run.cases) send(caseFrame(run.jobId, c.id, wrong && c.id === 'check-negatives' ? '9' : (answers[c.id] ?? 'echo')));
      send({ type: 'done', jobId: run.jobId, reason: 'complete' });
    },
  });
  const common = { key: r.key, contentHash: r.hash, language: 'python', source: 'x' };
  let res = await wait(r.exec, r.exec.start({ ...common, mode: 'submit' }).jobId);
  assert.equal(res.verdict, 'ACCEPTED');
  assert.equal(res.cleanup.confirmed, true);
  assert.equal(r.store.statusOf(r.key, r.hash), 'solved');
  await r.backend.start();
  wrong = true;
  res = await wait(r.exec, r.exec.start({ ...common, mode: 'submit' }).jobId);
  assert.equal(res.verdict, 'WRONG_ANSWER');
  await r.backend.start();
  res = await wait(r.exec, r.exec.start({ ...common, mode: 'custom', customInput: '1 1\n1\n' }).jobId);
  assert.equal(res.verdict, 'EXECUTED');
});

test('custom run on an unsolved problem never marks it solved', async () => {
  const r = await rig({
    onRun: (run, send) => {
      for (const c of run.cases) send(caseFrame(run.jobId, c.id, '2'));
      send({ type: 'done', jobId: run.jobId, reason: 'complete' });
    },
  });
  await wait(r.exec, r.exec.start({ key: r.key, contentHash: r.hash, language: 'python', source: 'x', mode: 'custom', customInput: 'a' }).jobId);
  assert.equal(r.store.statusOf(r.key, r.hash), 'unsolved');
});

test('stale content hash is refused; busy; backend not ready; language missing', async () => {
  const r = await rig({ onRun: () => {} });
  assert.throws(
    () => r.exec.start({ key: r.key, contentHash: 'deadbeef', language: 'python', source: 'x', mode: 'submit' }),
    (e) => e.code === 'CONFLICT',
  );
  assert.throws(
    () => r.exec.start({ key: r.key, contentHash: r.hash, language: 'cpp', source: 'x', mode: 'submit' }),
    (e) => e.code === 'BACKEND_UNAVAILABLE',
  );
  const { jobId } = r.exec.start({ key: r.key, contentHash: r.hash, language: 'python', source: 'x', mode: 'examples' });
  assert.throws(
    () => r.exec.start({ key: r.key, contentHash: r.hash, language: 'python', source: 'x', mode: 'examples' }),
    (e) => e.code === 'BUSY' || e.code === 'BACKEND_UNAVAILABLE',
  );
  r.exec.cancel(jobId);
  const res = await wait(r.exec, jobId);
  assert.equal(res.verdict, 'CANCELLED');
});

test('cancel vs completion race yields exactly one terminal result', async () => {
  const r = await rig({
    onRun: (run, send) => {
      for (const c of run.cases) send(caseFrame(run.jobId, c.id, '2'));
      send({ type: 'done', jobId: run.jobId, reason: 'complete' });
    },
  });
  const { jobId } = r.exec.start({ key: r.key, contentHash: r.hash, language: 'python', source: 'x', mode: 'examples' });
  r.exec.cancel(jobId);
  const a = await wait(r.exec, jobId);
  await new Promise((x) => setTimeout(x, 50));
  const b = r.exec.get(jobId).result;
  assert.equal(a.verdict, b.verdict);
  assert.ok(['CANCELLED', 'EXAMPLES_PASSED'].includes(a.verdict));
});

test('malformed / out-of-order / duplicate frames => INFRA_ERROR, never ACCEPTED', async () => {
  for (const mk of [
    (run, send) => {
      send(caseFrame(run.jobId, 'check-single', '0'));
    }, // out of order
    (run, send) => {
      send(caseFrame(run.jobId, run.cases[0].id, '2'));
      send(caseFrame(run.jobId, run.cases[0].id, '2'));
    }, // duplicate
    (run, send, child) => {
      child.stdout.write('not json\n');
    },
    (run, send) => {
      send(caseFrame('other-job', run.cases[0].id, '2'));
    },
    (run, send) => {
      send({ type: 'done', jobId: run.jobId, reason: 'complete' });
    }, // missing cases
  ]) {
    const r = await rig({ onRun: mk });
    const res = await wait(r.exec, r.exec.start({ key: r.key, contentHash: r.hash, language: 'python', source: 'x', mode: 'submit' }).jobId);
    assert.notEqual(res.verdict, 'ACCEPTED');
    assert.ok(['INFRA_ERROR'].includes(res.verdict), res.verdict);
    assert.equal(r.store.statusOf(r.key, r.hash), 'unsolved');
  }
});

test('MEMORY_LIMIT only with positive OOM evidence; exit 137 alone is not enough', async () => {
  const die = (run, send, child) => child.kill();
  let r = await rig({ onRun: die }, dockerOk([], { oom: 'false' }));
  assert.equal((await wait(r.exec, r.exec.start({ key: r.key, contentHash: r.hash, language: 'python', source: 'x', mode: 'submit' }).jobId)).verdict, 'INFRA_ERROR');
  r = await rig({ onRun: die }, dockerOk([], { oom: 'true' }));
  assert.equal((await wait(r.exec, r.exec.start({ key: r.key, contentHash: r.hash, language: 'python', source: 'x', mode: 'submit' }).jobId)).verdict, 'MEMORY_LIMIT');
});

test('cleanup unconfirmed => state cleanup-unconfirmed and Run disabled', async () => {
  const r = await rig(
    {
      onRun: (run, send) => {
        for (const c of run.cases) send(caseFrame(run.jobId, c.id, '2'));
        send({ type: 'done', jobId: run.jobId, reason: 'complete' });
      },
    },
    dockerOk([], { leftover: 'abc123\n' }),
  );
  const res = await wait(r.exec, r.exec.start({ key: r.key, contentHash: r.hash, language: 'python', source: 'x', mode: 'examples' }).jobId);
  assert.equal(res.cleanup.confirmed, false);
  assert.equal(r.backend.getStatus().state, 'cleanup-unconfirmed');
  assert.throws(
    () => r.exec.start({ key: r.key, contentHash: r.hash, language: 'python', source: 'x', mode: 'examples' }),
    (e) => e.code === 'BACKEND_UNAVAILABLE',
  );
});

test('startup: never-ready engine => unavailable with Retry guidance; ready => languages listed', async () => {
  const b = new Backend({ installId: 'b'.repeat(36), docker: dockerOk(), spawn: fakeSpawn({ noReady: true }), readyMs: 100 });
  const s = await b.start();
  assert.equal(s.state, 'unavailable');
  assert.match(s.reason, /did not become ready/);
});

// ---- HOST-run engine/runner.py protocol tests: runs runner.py directly on the host (NOT in a container) ----
function hostRun(lang, source, cases, limits = {}) {
  const wd = tmp();
  const p = cp.spawnSync('python3', [path.join(__dirname, '../../engine/runner.py')], {
    input: `${JSON.stringify({ v: 1, type: 'run', jobId: 'j1', language: lang, source, cases, limits: { caseMs: 1000, compileMs: 10000, jobMs: 10000, outputBytes: 4096, ...limits } })}\n`,
    env: { ...process.env, MECODE_WORKDIR: wd },
    encoding: 'utf8',
    timeout: 60000,
  });
  return {
    frames: p.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
    status: p.status,
    stderr: p.stderr,
  };
}
test('HOST-run runner.py: python success, wrong stdout captured, timeout, output limit, runtime error', () => {
  let r = hostRun('python', 'print(int(input())*2)', [{ id: 'a', stdin: '21\n' }]);
  assert.equal(r.frames[0].type, 'ready');
  assert.ok(r.frames[0].languages.some((l) => l.id === 'python'));
  const c = r.frames.find((f) => f.type === 'case');
  assert.equal(c.stdout.trim(), '42');
  assert.equal(c.exitCode, 0);
  assert.equal(r.frames.at(-1).type, 'done');
  r = hostRun('python', 'while True: pass', [{ id: 't', stdin: '' }], { caseMs: 300 });
  const t = r.frames.find((f) => f.type === 'case');
  assert.equal(t.timedOut, true);
  assert.ok(t.elapsedMs < 3000);
  r = hostRun('python', 'print("x"*100000)', [{ id: 'o', stdin: '' }], { outputBytes: 1024 });
  assert.equal(r.frames.find((f) => f.type === 'case').outputLimit, true);
  r = hostRun('python', 'raise SystemExit(3)', [{ id: 'e', stdin: '' }]);
  assert.equal(r.frames.find((f) => f.type === 'case').exitCode, 3);
  r = hostRun(
    'python',
    'print(1)',
    [
      { id: 'a', stdin: '' },
      { id: 'b', stdin: '' },
    ],
    {},
  );
  assert.deepEqual(
    r.frames.filter((f) => f.type === 'case').map((f) => f.id),
    ['a', 'b'],
  );
});
test('HOST-run runner.py: javascript executes if node present; C++ only if g++ present (else skipped with reason)', (t) => {
  const r = hostRun('javascript', 'console.log(require("fs").readFileSync(0,"utf8").trim()+"!")', [{ id: 'a', stdin: 'hi' }]);
  assert.ok(r.frames[0].languages.some((l) => l.id === 'javascript'));
  assert.equal(r.frames.find((f) => f.type === 'case').stdout.trim(), 'hi!');
  if (!r.frames[0].languages.some((l) => l.id === 'cpp')) {
    t.diagnostic('g++ not on host: cpp NOT RUN');
    return;
  }
  const c = hostRun('cpp', '#include <iostream>\nint main(){int x;std::cin>>x;std::cout<<x*2;}', [{ id: 'a', stdin: '4' }]);
  assert.equal(c.frames.find((f) => f.type === 'case').stdout.trim(), '8');
  const bad = hostRun('cpp', 'int main(){ nope }', [{ id: 'a', stdin: '' }]);
  assert.equal(bad.frames.find((f) => f.type === 'compile').ok, false);
});
test('runner rejects invalid run frame', () => {
  const p = cp.spawnSync('python3', [path.join(__dirname, '../../engine/runner.py')], {
    input: '{"v":1,"type":"nope"}\n',
    env: { ...process.env, MECODE_WORKDIR: tmp() },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.ok(p.stdout.includes('"type":"error"'));
});

// Reference solutions (HOST-executed Python) must pass every stored case of the bundled pack
test('bundled pack reference solutions pass all stored cases (host python)', () => {
  const refs = {
    'beacon-pairs':
      'import sys\nd=sys.stdin.read().split();n,t=int(d[0]),int(d[1]);a=list(map(int,d[2:2+n]))\nfrom collections import Counter\nc=Counter();r=0\nfor x in a:\n r+=c[t-x];c[x]+=1\nprint(r)',
    'bracket-ledger':
      'm={")":"(","]":"[","}":"{"};st=[];ok=True\nfor ch in input().strip():\n if ch in m:\n  if not st or st.pop()!=m[ch]: ok=False;break\n else: st.append(ch)\nprint("YES" if ok and not st else "NO")',
    'steady-streak': 'd=input and __import__("sys").stdin.read().split();n=int(d[0]);a=d[1:1+n];b=1;c=1\nfor i in range(1,n):\n c=c+1 if a[i]==a[i-1] else 1;b=max(b,c)\nprint(b)',
  };
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '../../packs/core.json'), 'utf8'));
  for (const p of pack.problems) {
    const r = hostRun(
      'python',
      refs[p.id],
      p.tests.map((t) => ({ id: t.id, stdin: t.stdin })),
    );
    const cs = r.frames.filter((f) => f.type === 'case');
    assert.equal(cs.length, p.tests.length, p.id);
    for (const t of p.tests) assert.equal(cs.find((c) => c.id === t.id).stdout.trim(), t.expected.trim(), `${p.id}/${t.id}`);
  }
});
