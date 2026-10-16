'use strict';
// T29: the archive-verify harness must AWAIT the launcher process group it spawned (bounded), keep its exit status, and check the install-owned
// containers by exact label — a delayed or failing shutdown must produce a failure, never an early success. Fake launchers/docker (mock): no real Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { trackExit, stopLauncher, readInstallId, awaitInstallContainersAbsent, groupAlive } = require('../../scripts/lib/launcher-stop.cjs');

const launch = (script) => {
  const child = cp.spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
  return { child, tr: trackExit(child) };
};
const settleStart = () => new Promise((r) => setTimeout(r, 150)); // let sh install its trap

test('prompt exit on SIGTERM: success, group gone', async () => {
  const { child, tr } = launch('sleep 30');
  await settleStart();
  const r = await stopLauncher(child, tr, { termMs: 5000, killMs: 2000 });
  assert.deepEqual(r.problems, []);
  assert.equal(r.exited, true);
  assert.equal(r.groupGone, true);
  assert.equal(groupAlive(child.pid), false);
});

test('DELAYED exit beyond the old 1500ms sleep: harness waits for the real exit instead of reporting early success', async () => {
  const { child, tr } = launch(`trap 'sleep 2; exit 0' TERM; while :; do sleep 0.1; done`);
  await settleStart();
  const t0 = Date.now();
  const r = await stopLauncher(child, tr, { termMs: 8000, killMs: 2000 });
  assert.ok(Date.now() - t0 >= 1900, `returned after ${Date.now() - t0}ms, before the launcher actually exited`);
  assert.equal(r.exitCode, 0);
  assert.equal(r.groupGone, true);
  assert.deepEqual(r.problems, []);
});

test('NONZERO exit after SIGTERM is a reported problem (exit status preserved)', async () => {
  const { child, tr } = launch(`trap 'exit 3' TERM; while :; do sleep 0.1; done`);
  await settleStart();
  const r = await stopLauncher(child, tr, { termMs: 5000, killMs: 2000 });
  assert.equal(r.exitCode, 3);
  assert.ok(
    r.problems.some((p) => /code=3/.test(p)),
    JSON.stringify(r.problems),
  );
});

test('a launcher that ignores SIGTERM past the bound is escalated, reported as a problem, and the group is really gone', async () => {
  const { child, tr } = launch(`trap '' TERM; while :; do sleep 0.1; done`);
  await settleStart();
  const r = await stopLauncher(child, tr, { termMs: 600, killMs: 3000 });
  assert.equal(r.escalated, true);
  assert.ok(r.problems.some((p) => /did not exit within 600ms/.test(p)));
  assert.equal(r.groupGone, true);
});

test('shell exits at once but a group member outlives it (the real launcher shape): waits for the WHOLE group', async () => {
  const { child, tr } = launch(`(trap 'sleep 1.5; exit 0' TERM; while :; do sleep 0.1; done) & trap 'exit 0' TERM; wait`);
  await settleStart();
  const t0 = Date.now();
  const r = await stopLauncher(child, tr, { termMs: 8000, killMs: 2000 });
  assert.ok(Date.now() - t0 >= 1400, `group member still running when stop returned (${Date.now() - t0}ms)`);
  assert.equal(r.groupGone, true);
});

test('owned-container check: exact labels, bounded wait for removal, present-at-deadline and unanswerable docker are NOT success', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  const row = `abc\tmecode-11111111-x\trunning\tUp 1 second\t2026-01-01 00:00:00 +0000 UTC\tmecode-engine:v2\tmecode.app=mecode-v2,mecode.install=${id}`;
  let n = 0;
  const gone = await awaitInstallContainersAbsent(id, {
    waitMs: 3000,
    pollMs: 20,
    run: (a) => (calls.push(a), { status: 0, stdout: ++n < 3 ? `${row}\n` : '' }),
  });
  assert.equal(gone.absent, true);
  assert.ok(calls[0].join(' ').includes(`label=mecode.install=${id}`) && calls[0].join(' ').includes('label=mecode.app=mecode-v2'));
  const stuck = await awaitInstallContainersAbsent(id, { waitMs: 150, pollMs: 20, run: () => ({ status: 0, stdout: `${row}\n` }) });
  assert.equal(stuck.absent, false);
  assert.equal(stuck.rows[0].names, 'mecode-11111111-x');
  assert.match(stuck.rows[0].labels, new RegExp(id));
  const dead = await awaitInstallContainersAbsent(id, { waitMs: 100, pollMs: 20, run: () => ({ status: 1, stdout: '', stderr: 'daemon down' }) });
  assert.equal(dead.absent, false);
  assert.equal(dead.checked, false);
  assert.equal((await awaitInstallContainersAbsent('', { run: () => ({ status: 0, stdout: '' }) })).absent, false, 'unknown install id is never "absent"');
});

test('readInstallId: only a well-formed id from the private state.json', () => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't29-'));
  assert.equal(readInstallId(d), '');
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ installId: '11111111-1111-4111-8111-111111111111' }));
  assert.equal(readInstallId(d), '11111111-1111-4111-8111-111111111111');
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ installId: 'not an id; echo hi' }));
  assert.equal(readInstallId(d), '');
});
