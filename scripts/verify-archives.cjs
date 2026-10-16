'use strict';
// Verifies the archives from package-platforms.cjs WITHOUT trusting the builder:
//   structure (every archive) : SHA256SUMS match, archive parses (tar/zip checksums/CRC), single top dir, MANIFEST.json file hashes+modes match
//                               the extracted bytes, real payload present (server, renderer, engine recipe+runner, pack, launcher), exec bits on
//                               POSIX launchers, source revision in the manifest equals the checked-out HEAD.
//   --run <archive>           : extract that archive to a fresh temp dir and exercise it: launcher start-up (server serves the UI shell and
//                               prints a launch link to a private file), and with --unit also the shipped unit tests.
// Usage: node scripts/verify-archives.cjs [--run <archive-path>] [--unit] [--extract-to <dir>]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { readTarGz, readZip } = require('./lib/archive.cjs');
const { entryProblem, destinationUnder } = require('./lib/safe-path.cjs');
const { trackExit, stopLauncher, readInstallId, awaitInstallContainersAbsent } = require('./lib/launcher-stop.cjs');

const root = path.join(__dirname, '..');
const argv = process.argv;
const argAt = (/** @type {string} */ k) => (argv.indexOf(k) > 0 ? argv[argv.indexOf(k) + 1] : undefined);
const dirArg = argAt('--dir');
const dir = dirArg ? path.resolve(dirArg) : path.join(root, 'dist', 'platform');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rev = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const problems = [];
const bad = (m) => {
  problems.push(m);
  console.error(`ARCHIVE-BAD ${m}`);
};

const readEntries = (/** @type {string} */ file) => (file.endsWith('.zip') ? readZip(fs.readFileSync(file)) : readTarGz(fs.readFileSync(file)));

// Validate EVERY entry before the first byte is written (only regular files and directories are ever created).
function extract(/** @type {string} */ file, /** @type {string} */ into) {
  const entries = readEntries(file);
  const plan = entries.map((e) => ({ e, dst: destinationUnder(into, e.name) }));
  for (const { e, dst } of plan) {
    if (e.dir) fs.mkdirSync(dst, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, e.data);
      if (process.platform !== 'win32') fs.chmodSync(dst, e.mode);
    }
  }
  return entries;
}

function structure(file) {
  const base = path.basename(file);
  const osName = /-(linux|macos|windows)\./.exec(base)[1];
  const entries = readEntries(file);
  for (const e of entries) {
    const why = entryProblem(e.name);
    if (why) return bad(`${base}: unsafe entry ${JSON.stringify(e.name)}: ${why}`);
  }
  const tops = new Set(entries.map((e) => e.name.split('/')[0]));
  if (tops.size !== 1) return bad(`${base}: expected one top directory, got ${[...tops].join(',')}`);
  const top = [...tops][0];
  const byName = new Map(entries.filter((e) => !e.dir).map((e) => [e.name.slice(top.length + 1), e]));
  const manifest = JSON.parse(byName.get('MANIFEST.json').data.toString('utf8'));
  if (manifest.sourceRevision !== rev) bad(`${base}: manifest revision ${manifest.sourceRevision} != HEAD ${rev}`);
  if (manifest.sourceDirty) bad(`${base}: built from a dirty working tree`);
  if (manifest.targetOs !== osName) bad(`${base}: manifest targetOs ${manifest.targetOs}`);
  for (const [n, meta] of Object.entries(manifest.files)) {
    const e = byName.get(n);
    if (!e) bad(`${base}: manifest lists missing file ${n}`);
    else {
      if (sha256(e.data) !== meta.sha256) bad(`${base}: hash mismatch ${n}`);
      if (e.mode.toString(8) !== meta.mode) bad(`${base}: mode ${e.mode.toString(8)} != ${meta.mode} for ${n}`);
    }
  }
  if (byName.size !== Object.keys(manifest.files).length + 1) bad(`${base}: archive has files not listed in the manifest`);
  for (const need of [
    'src/web/server.cjs',
    'src/main/backend.cjs',
    'src/renderer/app.js',
    'engine/Dockerfile',
    'engine/runner.py',
    'scripts/provision-engine.cjs',
    'docs/OFFLINE.md',
    'packs/core.json',
    'packs/mecode-patterns.json',
    'INSTALL.md',
    'package.json',
    manifest.launcher.start,
    manifest.launcher.buildEngine,
  ])
    if (!byName.has(need)) bad(`${base}: missing payload ${need}`);
  if (byName.size < 25) bad(`${base}: suspiciously small payload (${byName.size} files)`);
  // Runtime claims must match the single validated Node (package.json engines) everywhere a recipient reads them.
  const nodeV = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).engines.node;
  const claims = {
    'INSTALL.md': byName.get('INSTALL.md'),
    [manifest.launcher.start]: byName.get(manifest.launcher.start),
    'MANIFEST.json requires.node': { data: Buffer.from(String(manifest.requires && manifest.requires.node)) },
  };
  for (const [n, e] of Object.entries(claims)) {
    if (!e) continue;
    const t = e.data.toString('utf8');
    if (!t.includes(nodeV)) bad(`${base}: ${n} does not state the validated Node.js ${nodeV}`);
    if (/or newer|\b\d+\+|>=\s*\d/.test(t.replace(/\d+\.\d+\.\d+\+?/g, (m) => (m.endsWith('+') ? m : '')))) bad(`${base}: ${n} promises an unvalidated Node.js range`);
  }
  if (osName !== 'windows')
    for (const l of [manifest.launcher.start, manifest.launcher.buildEngine]) if (byName.get(l) && (byName.get(l).mode & 0o111) !== 0o111) bad(`${base}: launcher ${l} lost its exec bit`);
  if (osName === 'windows' && !byName.get(manifest.launcher.start).data.toString().includes('\r\n')) bad(`${base}: windows launcher is not CRLF`);
  console.log(`ARCHIVE-STRUCTURE-OK ${base} files=${byName.size} sha256=${sha256(fs.readFileSync(file))}`);
}

async function runArchive(file, wantUnit, keepIn) {
  const base = path.basename(file);
  const osName = /-(linux|macos|windows)\./.exec(base)[1];
  for (const e of readEntries(file)) destinationUnder(path.join(path.sep, 'x'), e.name); // fail before creating anything
  const tmp = keepIn || fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mecode-arch-'));
  fs.mkdirSync(tmp, { recursive: true });
  extract(file, tmp);
  const appDir = path.join(
    tmp,
    fs.readdirSync(tmp).find((n) => n.startsWith('mecode-v2-')),
  );
  console.log(`EXTRACTED ${base} -> fresh dir (app dir ${path.basename(appDir)})`);
  if (wantUnit) {
    const r = cp.spawnSync(process.execPath, ['--test', 'tests/unit/*.test.cjs'], { cwd: appDir, encoding: 'utf8', timeout: 240000 });
    const m = (k) => (new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(r.stdout) || [])[1];
    console.log(`EXTRACTED-UNIT exit=${r.status} tests=${m('tests')} pass=${m('pass')} fail=${m('fail')} skipped=${m('skipped')}`);
    if (r.status !== 0) bad(`${base}: unit tests failed in the extracted tree`);
  }
  // launcher start-up: private data dir + launch file; Docker may be absent (UI must still start and say so)
  const data = path.join(tmp, 'data');
  const launchFile = path.join(tmp, 'launch.txt');
  const launcher = { linux: ['sh', ['start.sh']], macos: ['sh', ['start.command']], windows: ['cmd.exe', ['/c', 'start.cmd']] }[osName];
  if (osName !== { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform]) {
    console.log(`LAUNCHER-SKIPPED ${base}: archive is for ${osName} but this host is ${process.platform}`);
    return;
  }
  const child = cp.spawn(launcher[0], launcher[1], {
    cwd: appDir,
    env: { ...process.env, MECODE_USER_DATA: data, MECODE_LAUNCH_FILE: launchFile },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const tracker = trackExit(child);
  let out = '';
  child.stdout.on('data', (d) => (out = (out + d).slice(-4000)));
  child.stderr.on('data', (d) => (out = (out + d).slice(-4000)));
  let url = null;
  for (let i = 0; i < 300 && !url; i++) {
    try {
      url = fs.readFileSync(launchFile, 'utf8').trim();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    if (!url) throw new Error(`launcher did not publish a launch link: ${out.replace(/#s=[0-9a-f]+/g, '#s=<redacted>').slice(-400)}`);
    const origin = new URL(url).origin;
    const res = await fetch(`${origin}/`);
    const html = await res.text();
    if (res.status !== 200 || !html.includes('MeCode V2')) throw new Error(`UI shell not served (status ${res.status})`);
    const js = await fetch(`${origin}/app.js`);
    if (js.status !== 200) throw new Error(`app.js status ${js.status}`);
    console.log(`LAUNCHER-OK ${base}: ${launcher[1][launcher[1].length - 1]} started the server, GET / -> 200 with UI shell, GET /app.js -> 200 (launch link withheld)`);
  } catch (e) {
    bad(`${base}: ${e.message}`);
  } finally {
    // Bounded await of the exact launcher process group THIS harness spawned, then an exact install-label container check (no sweeps/prunes).
    if (process.platform === 'win32') {
      cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      const installId = readInstallId(data);
      const st = await stopLauncher(child, tracker);
      console.log(
        `LAUNCHER-STOP ${base}: exited=${st.exited} code=${st.exitCode} signal=${st.signal} groupGone=${st.groupGone} escalated=${st.escalated} waited=${st.elapsedMs}ms installId=${installId || 'unknown'}`,
      );
      for (const p of st.problems) bad(`${base}: ${p}`);
      const dockerUp = cp.spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20000 }).status === 0;
      if (!dockerUp) console.log(`LAUNCHER-CONTAINERS ${base}: Docker did not answer; owned-container absence not asserted here (nothing could have been started)`);
      else {
        const c = await awaitInstallContainersAbsent(installId);
        console.log(`LAUNCHER-CONTAINERS ${base}: installId=${installId || 'unknown'} checked=${c.checked} absent=${c.absent}${c.reason ? ` reason=${JSON.stringify(c.reason)}` : ''}`);
        for (const r of c.rows)
          console.log(
            `LAUNCHER-CONTAINERS-LEFT id=${r.id.slice(0, 12)} name=${r.names} state=${r.state} status=${JSON.stringify(r.status)} created=${JSON.stringify(r.createdAt)} image=${r.image} labels=${JSON.stringify(r.labels)}`,
          );
        if (!c.absent) bad(`${base}: install-owned containers not confirmed absent after launcher stop (${c.reason})`);
      }
    }
    if (!keepIn) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const files = sums.map((l) => l.split(/\s+/)[1]);
  for (const l of sums) {
    const [h, n] = l.split(/\s+/);
    if (!n || path.basename(n) !== n || n.includes('\\')) {
      bad(`SHA256SUMS lists a non-plain file name ${JSON.stringify(n)}`);
      continue;
    }
    try {
      if (sha256(fs.readFileSync(path.join(dir, n))) !== h) bad(`${n}: SHA256SUMS mismatch`);
    } catch (e) {
      bad(`${n}: unreadable (${/** @type {Error} */ (e).message})`);
    }
  }
  if (files.length !== 6) bad(`expected 6 archives, found ${files.length}`);
  for (const n of files) {
    try {
      if (n && path.basename(n) === n) structure(path.join(dir, n));
    } catch (e) {
      bad(`${n}: structure check failed (${/** @type {Error} */ (e).message})`);
    }
  }
  const runArg = argAt('--run');
  const runFile = runArg === undefined ? null : path.resolve(runArg);
  if (runFile && !files.some((n) => path.resolve(dir, n) === runFile)) bad(`--run ${runArg} is not one of the verified archives listed in SHA256SUMS`);
  // Nothing below may extract or spawn unless EVERY check above passed.
  if (problems.length) {
    console.error(`ARCHIVES-FAIL ${problems.length} problem(s); nothing extracted or started`);
    process.exit(1);
  }
  if (runFile) {
    const x = argAt('--extract-to');
    await runArchive(runFile, argv.includes('--unit'), x ? path.resolve(x) : null);
  }
  if (problems.length) {
    console.error(`ARCHIVES-FAIL ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log('ARCHIVES-OK');
})();
