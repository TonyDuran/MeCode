'use strict';
// T31 R2: the CALLER policy of scripts/verify-archives.cjs (teardownLauncher is exactly what the script calls), not just the helper's okCodes.
// Fake launchers (real sh process groups) + injected docker answers = mock evidence; no real Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { trackExit, teardownLauncher } = require('../../scripts/lib/launcher-stop.cjs');

const ID = '11111111-1111-4111-8111-111111111111';
const launch = (code) => {
  const child = cp.spawn('sh', ['-c', `trap 'exit ${code}' TERM; while :; do sleep 0.1; done`], { detached: true, stdio: 'ignore' });
  return { child, tr: trackExit(child) };
};
const settle = () => new Promise((r) => setTimeout(r, 150));
const FAST = { termMs: 5000, killMs: 2000 };
const emptyPs = { waitMs: 100, pollMs: 20, run: () => ({ status: 0, stdout: '' }) };
const deadPs = { waitMs: 100, pollMs: 20, run: () => ({ status: 1, stdout: '', stderr: 'daemon down' }) };
const run = async (code, opts) => {
  const l = launch(code);
  await settle();
  return teardownLauncher(l.child, l.tr, { installId: ID, stopOpts: FAST, absentOpts: emptyPs, ...opts });
};

test('explicit unavailable smoke (Docker unanswered before AND after) + exit 3: accepted, removal reported NOT ASSERTED', async () => {
  const t = await run(3, { unavailableSmoke: true, dockerBefore: false, probe: () => false });
  assert.deepEqual(t.problems, []);
  assert.equal(t.st.exitCode, 3);
  assert.equal(t.containers.mode, 'not-asserted');
  assert.equal(t.containers.absent, false, 'absence is never claimed');
});

test('default Linux engine mode + Docker unanswered + exit 3: REJECTED (no teardown-probe exception)', async () => {
  const t = await run(3, { unavailableSmoke: false, dockerBefore: true, absentOpts: deadPs, probe: () => false });
  assert.ok(
    t.problems.some((p) => /code=3/.test(p)),
    JSON.stringify(t.problems),
  );
  assert.ok(
    t.problems.some((p) => /not confirmed absent/.test(p)),
    JSON.stringify(t.problems),
  );
  assert.equal(t.containers.mode, 'asserted');
  // even when Docker was never recorded at all, default stays strict
  const u = await run(3, { dockerBefore: undefined, absentOpts: deadPs });
  assert.ok(u.problems.some((p) => /code=3/.test(p)));
});

test('available before, unavailable after: always a failure (strict default AND explicit mode)', async () => {
  const a = await run(3, { unavailableSmoke: false, dockerBefore: true, absentOpts: deadPs });
  assert.ok(a.problems.length >= 2);
  const b = await run(3, { unavailableSmoke: true, dockerBefore: true, absentOpts: deadPs });
  assert.ok(
    b.problems.some((p) => /BEFORE launch/.test(p)),
    JSON.stringify(b.problems),
  );
  assert.ok(
    b.problems.some((p) => /code=3/.test(p)),
    'exit 3 not accepted when Docker was available before',
  );
});

test('explicit unavailable smoke where Docker becomes available after launch: failure', async () => {
  const t = await run(0, { unavailableSmoke: true, dockerBefore: false, probe: () => true });
  assert.ok(
    t.problems.some((p) => /became available/.test(p)),
    JSON.stringify(t.problems),
  );
});

test('exit 2 is rejected in BOTH modes; clean exit 0 passes strict mode only with confirmed absence', async () => {
  const a = await run(2, { unavailableSmoke: true, dockerBefore: false, probe: () => false });
  assert.ok(
    a.problems.some((p) => /code=2/.test(p)),
    JSON.stringify(a.problems),
  );
  const b = await run(2, { unavailableSmoke: false, dockerBefore: true });
  assert.ok(
    b.problems.some((p) => /code=2/.test(p)),
    JSON.stringify(b.problems),
  );
  const ok = await run(0, { unavailableSmoke: false, dockerBefore: true });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.containers.absent, true);
});

test('wiring: verify-archives passes the flag only into teardownLauncher; CI sets it for macOS only; final CI owned-container assertion unchanged', () => {
  const root = path.join(__dirname, '../..');
  const va = fs.readFileSync(path.join(root, 'scripts/verify-archives.cjs'), 'utf8');
  assert.match(va, /unavailableSmoke = argv\.includes\('--docker-unavailable-smoke'\)/);
  assert.match(va, /teardownLauncher\(child, tracker, \{ unavailableSmoke, dockerBefore, installId \}\)/);
  assert.doesNotMatch(va, /okCodes/, 'no ad-hoc okCodes in the caller');
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /os: macos-14\n\s+archive: macos\.tar\.gz\n\s+smoke_flag: '--docker-unavailable-smoke'/);
  assert.match(ci, /os: windows-2022\n\s+archive: windows\.zip\n\s+smoke_flag: ''/);
  assert.equal((ci.match(/--docker-unavailable-smoke/g) || []).length, 1, 'only the macOS matrix entry enables it; the Linux engine job never does');
  assert.match(ci, /run: test -z "\$\(docker ps -aq --filter label=mecode\.app=mecode-v2\)"/);
});
