'use strict';
// T22-R1 regression (DEV-ONLY, not shipped in archives): the authoring gate scripts/catalog-docker-accept.cjs must release every resource it
// acquired (engine container, catdock temp dir) on EVERY exit path, and a bad plan must be rejected BEFORE the backend starts.
// Runs the script in a task copy of the repo (never edits the working tree) against the provisioned rootless Docker engine image.
//   MECODE_REAL_DOCKER=1 node --test tests/integration/catalog-cleanup.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const REAL = process.env.MECODE_REAL_DOCKER === '1';
const allMecode = () => new Set(cp.execFileSync('docker', ['ps', '-aq', '--filter', 'label=mecode.app=mecode-v2'], { encoding: 'utf8', timeout: 15000 }).split('\n').filter(Boolean));
const ownedBy = (/** @type {string} */ install) =>
  cp.execFileSync('docker', ['ps', '-aq', '--filter', 'label=mecode.app=mecode-v2', '--filter', `label=mecode.install=${install}`], { encoding: 'utf8', timeout: 15000 }).trim();

/** Task copy with only what the script needs; optionally without one required solution file. */
function taskCopy(/** @type {string | null} */ dropSolution) {
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't23-copy-'));
  const copy = path.join(base, 'repo');
  fs.mkdirSync(path.join(copy, 'catalog-dev'), { recursive: true });
  for (const d of ['scripts', 'src', 'packs', 'engine']) fs.cpSync(path.join(root, d), path.join(copy, d), { recursive: true });
  fs.cpSync(path.join(root, 'catalog-dev', 'solutions'), path.join(copy, 'catalog-dev', 'solutions'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(copy, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'));
  if (dropSolution) fs.rmSync(path.join(copy, 'catalog-dev', 'solutions', dropSolution));
  return { base, copy, tmp: fs.mkdtempSync(path.join(base, 'tmp-')) };
}

function runGate(/** @type {{copy: string, tmp: string}} */ c, /** @type {Record<string,string>} */ extraEnv) {
  const r = cp.spawnSync(process.execPath, ['scripts/catalog-docker-accept.cjs'], {
    cwd: c.copy,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...extraEnv, TMPDIR: c.tmp },
  });
  const line = (r.stderr.split('\n').find((l) => l.startsWith('CLEANUP ')) || '').slice(8);
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, cleanup: line ? JSON.parse(line) : null };
}

/** Shared assertions: no new mecode container of any state, no catdock temp dir left in the task-owned TMPDIR. */
function assertNoLeftovers(/** @type {Set<string>} */ before, /** @type {{tmp: string}} */ c) {
  const after = allMecode();
  const added = [...after].filter((x) => !before.has(x));
  assert.deepEqual(added, [], `new mecode.app containers left behind: ${added.join(',')}`);
  const temps = fs.readdirSync(c.tmp).filter((n) => n.startsWith('catdock-'));
  assert.deepEqual(temps, [], `catdock temp data left behind: ${temps.join(',')}`);
}

test('missing required solution: named GATE failure, nonzero, backend never started, zero owned containers, no temp data', { skip: !REAL && 'set MECODE_REAL_DOCKER=1' }, () => {
  const before = allMecode();
  const c = taskCopy('ticket-counter.c');
  try {
    const r = runGate(c, {});
    assert.notEqual(r.status, 0);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /GATE: required regression solution file\(s\) missing: ticket-counter\.c/);
    assertNoLeftovers(before, c);
    assert.ok(r.cleanup, 'failure path must print its CLEANUP report');
    assert.equal(r.cleanup.backendStarted, false, 'plan must be validated BEFORE the backend starts');
    assert.deepEqual(r.cleanup.cleanupErrors, []);
  } finally {
    fs.rmSync(c.base, { recursive: true, force: true });
  }
});

test('late injected failure AFTER the backend started: original error preserved, container stopped+removed, temp removed (finally runs)', { skip: !REAL && 'set MECODE_REAL_DOCKER=1' }, () => {
  const before = allMecode();
  const c = taskCopy(null);
  try {
    const r = runGate(c, { MECODE_CATALOG_DOCKER_FAULT: 'after-start' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /injected fault after backend start/);
    assertNoLeftovers(before, c);
    assert.ok(r.cleanup, 'failure path must print its CLEANUP report');
    assert.equal(r.cleanup.backendStarted, true, 'the injected fault must really hit after resource acquisition');
    assert.equal(r.cleanup.ownedLeft, 0);
    assert.deepEqual(r.cleanup.cleanupErrors, []);
    assert.equal(ownedBy(r.cleanup.installId), '', 'exact install-owned containers must be zero');
  } finally {
    fs.rmSync(c.base, { recursive: true, force: true });
  }
});
