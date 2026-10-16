'use strict';
// Shared harness for the real-browser GUI test and canaries.
// Idea attribution: the server-restart / launch-file / real-browser flow follows the observations Themis recorded in
// MeCode-v2-management/T10-evidence (read as evidence only; this is a fresh repo-maintained implementation, not Prax independent QA).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const repoRoot = path.join(__dirname, '..', '..');

/** Start the REAL web server (child process) against a data dir; returns { launchUrl (SECRET, never log it), stop() }. */
async function startServer({ appRoot = repoRoot, dataDir, log }) {
  const launchFile = path.join(dataDir, '..', `launch-${process.pid}-${Date.now()}.txt`);
  fs.rmSync(launchFile, { force: true });
  const env = { ...process.env, MECODE_USER_DATA: dataDir, MECODE_LAUNCH_FILE: launchFile };
  delete env.MECODE_PORT;
  const child = cp.spawn(process.execPath, [path.join(appRoot, 'src', 'web', 'server.cjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => {
    err = (err + d).slice(-2000);
  });
  let exited = null;
  child.on('exit', (code, sig) => {
    exited = { code, sig };
  });
  const t0 = Date.now();
  let launchUrl = null;
  while (Date.now() - t0 < 30000) {
    if (exited) throw new Error(`server exited early (${JSON.stringify(exited)}): ${err.slice(-500)}`);
    try {
      launchUrl = fs.readFileSync(launchFile, 'utf8').trim();
      if (launchUrl) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!launchUrl) throw new Error('server did not publish a launch file within 30 s');
  if (log) log(`server pid ${child.pid} listening (launch link withheld from logs)`);
  return {
    launchUrl,
    pid: child.pid,
    async stop() {
      if (exited) return exited;
      child.kill('SIGTERM');
      const t = Date.now();
      while (!exited && Date.now() - t < 20000) await new Promise((r) => setTimeout(r, 100));
      if (!exited) {
        child.kill('SIGKILL');
        throw new Error('server did not exit on SIGTERM within 20 s');
      }
      return exited;
    },
  };
}

/** Docker containers carrying this install's ownership label (empty string = none left). */
function ownedContainers(dataDir) {
  let installId;
  try {
    installId = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).installId;
  } catch {
    return 'unknown (no state.json)';
  }
  if (!installId) return 'unknown (no installId)';
  return cp.execFileSync('docker', ['ps', '-aq', '--filter', 'label=mecode.app=mecode-v2', '--filter', `label=mecode.install=${installId}`], { encoding: 'utf8', timeout: 15000 }).trim();
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
}

module.exports = { repoRoot, startServer, ownedContainers, tmpDir };
