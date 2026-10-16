'use strict';
// T29 harness helpers for scripts/verify-archives.cjs: bounded, observable shutdown of the launcher PROCESS GROUP the harness itself spawned,
// and an exact (install-label) check that its backend containers are gone. No sweeps/prunes: only reads `docker ps`, and only signals our own group.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}
/** @param {import('node:child_process').ChildProcess} child spawned with detached:true (its own process group) */
function trackExit(child) {
  /** @type {{code: number|null, signal: string|null}|null} */
  let st = null;
  /** @type {Promise<{code: number|null, signal: string|null}>} */
  const p = new Promise((res) => {
    child.once('exit', (code, signal) => {
      st = { code, signal };
      res(st);
    });
  });
  return { done: p, state: () => st };
}
async function stopLauncher(child, tracker, { termMs = 20000, killMs = 5000, pollMs = 50, okCodes = [0] } = {}) {
  const t0 = Date.now();
  const problems = [];
  let escalated = false;
  const signalGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* already gone */
    }
  };
  const waitGone = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (tracker.state() && !groupAlive(child.pid)) return true;
      await sleep(pollMs);
    }
    return !!tracker.state() && !groupAlive(child.pid);
  };
  signalGroup('SIGTERM');
  let gone = await waitGone(termMs);
  if (!gone) {
    escalated = true;
    problems.push(`launcher group did not exit within ${termMs}ms of SIGTERM; escalating to SIGKILL`);
    signalGroup('SIGKILL');
    gone = await waitGone(killMs);
    if (!gone) problems.push(`launcher group still present ${killMs}ms after SIGKILL`);
  }
  const s = tracker.state();
  if (s && !escalated) {
    // a requested SIGTERM may surface as the signal or as a clean/handled exit; any other status is a harness failure, not "early success"
    const okTerm = (s.code !== null && okCodes.includes(s.code)) || (s.code === null && s.signal === 'SIGTERM');
    if (!okTerm) problems.push(`launcher exited with code=${s.code} signal=${s.signal} after SIGTERM`);
  }
  return { exited: !!s, exitCode: s ? s.code : null, signal: s ? s.signal : null, groupGone: gone, escalated, elapsedMs: Date.now() - t0, problems };
}

/** installId the app recorded in its private data dir ('' when unreadable) */
function readInstallId(dataDir) {
  try {
    const id = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).installId;
    return typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? id : '';
  } catch {
    return '';
  }
}
const FMT = '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.CreatedAt}}\t{{.Image}}\t{{.Labels}}';
/** bounded `docker ps -a` for labels; returns {ok, rows[]} (ok=false when docker could not answer) */
function psRows(labels, run = defaultRun) {
  const args = ['ps', '-a', '--no-trunc'];
  for (const l of labels) args.push('--filter', `label=${l}`);
  args.push('--format', FMT);
  const r = run(args);
  if (r.status !== 0) return { ok: false, rows: [], error: String(r.stderr || r.error || '').slice(0, 200) };
  const rows = String(r.stdout)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [id, names, state, status, createdAt, image, lab] = l.split('\t');
      return { id, names, state, status, createdAt, image, labels: String(lab || '').slice(0, 300) };
    });
  return { ok: true, rows };
}
function defaultRun(args) {
  return cp.spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
}
/** waits (bounded) until NO container carries this install's labels; absent installId or unanswerable docker is reported, never assumed OK */
async function awaitInstallContainersAbsent(installId, { waitMs = 20000, pollMs = 500, run = defaultRun } = {}) {
  if (!installId) return { checked: false, absent: false, reason: 'install id unreadable', rows: [] };
  const labels = ['mecode.app=mecode-v2', `mecode.install=${installId}`];
  const end = Date.now() + waitMs;
  let last = psRows(labels, run);
  while (last.ok && last.rows.length && Date.now() < end) {
    await sleep(pollMs);
    last = psRows(labels, run);
  }
  if (!last.ok) return { checked: false, absent: false, reason: `docker did not answer: ${last.error}`, rows: [] };
  return { checked: true, absent: last.rows.length === 0, reason: last.rows.length ? `still present after ${waitMs}ms` : '', rows: last.rows };
}
/** true when a Docker daemon answers right now (bounded) */
function defaultProbe() {
  return cp.spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20000 }).status === 0;
}
/**
 * CALLER POLICY for POSIX launcher teardown (T31 R2). Strict by default: only a clean exit 0 and a CONFIRMED-absent install container set pass,
 * whatever Docker does later. The ONLY relaxation is the explicit unavailable-Docker archive-smoke mode (native no-engine fixture/job), and only if
 * Docker was recorded UNAVAILABLE before launch and is still unavailable after: then exit 3 is accepted and container removal is reported NOT ASSERTED.
 * Exit 2, escalation, available-before/unavailable-after, and an unavailable-mode run on a host where Docker answers all remain failures.
 */
async function teardownLauncher(
  child,
  tracker,
  /** @type {{unavailableSmoke?: boolean, dockerBefore?: boolean|null, installId?: string, probe?: () => boolean, stopOpts?: object, absentOpts?: object}} */ {
    unavailableSmoke = false,
    dockerBefore,
    installId = '',
    probe = defaultProbe,
    stopOpts = {},
    absentOpts = {},
  } = {},
) {
  const problems = [];
  const relaxed = unavailableSmoke && dockerBefore === false;
  if (unavailableSmoke && !relaxed) problems.push('explicit unavailable-Docker smoke requires Docker to be recorded unavailable BEFORE launch; it answered or was not probed (strict policy applied)');
  const st = await stopLauncher(child, tracker, { ...stopOpts, okCodes: relaxed ? [0, 3] : [0] });
  problems.push(...st.problems);
  let containers;
  if (relaxed) {
    if (probe()) problems.push('Docker became available after an unavailable-before launch; engine-container removal can no longer be treated as NOT ASSERTED');
    containers = { mode: 'not-asserted', checked: false, absent: false, reason: 'Docker unavailable before and after; removal NOT ASSERTED', rows: [] };
  } else {
    const c = await awaitInstallContainersAbsent(installId, absentOpts);
    containers = { mode: 'asserted', ...c };
    if (!c.absent) problems.push(`install-owned containers not confirmed absent after launcher stop (${c.reason})`);
  }
  return { st, containers, problems };
}
module.exports = { trackExit, stopLauncher, teardownLauncher, defaultProbe, readInstallId, psRows, awaitInstallContainersAbsent, groupAlive };
