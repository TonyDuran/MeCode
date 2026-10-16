'use strict';
// REAL-container acceptance of the shipped catalog (needs the provisioned image mecode-engine:v2; run from a source checkout because it
// reads the development assets under catalog-dev/, which are never shipped to learners).
//   node scripts/catalog-docker-accept.cjs [--only=id1,id2] [--skip-wrong]
// For every selected problem it submits, through the app's own Executor + Backend (one fresh network-less container per submission):
//   1. the trusted Python reference            -> must be ACCEPTED on every stored case
//   2. the deliberately wrong Python baseline  -> must NOT be ACCEPTED (negative control; the observed verdict is recorded)
//   3. non-Python regression solutions in catalog-dev/solutions/<id>.{cpp,cjs,c} -> must be ACCEPTED
//   4. the shipped starters of three problems in all four languages -> must compile/run and be WRONG_ANSWER (honest TODO skeletons)
// Trusted development assets only; never run learner code on the host (this script runs nothing on the host except `docker`).
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Backend } = require('../src/main/backend.cjs');
const { Executor } = require('../src/main/exec.cjs');
const { Catalog } = require('../src/main/catalog.cjs');
const { Store } = require('../src/main/store.cjs');

const root = path.join(__dirname, '..');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const skipWrong = process.argv.includes('--skip-wrong');
const EXT = { '.cpp': 'cpp', '.cjs': 'javascript', '.js': 'javascript', '.c': 'c', '.py': 'python' };
const STARTER_PROBLEMS = ['rope-splicer', 'prefix-directory', 'lone-signal'];
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const owned = (/** @type {string} */ install) =>
  cp.execFileSync('docker', ['ps', '-aq', '--filter', 'label=mecode.app=mecode-v2', '--filter', `label=mecode.install=${install}`], { encoding: 'utf8', timeout: 10000 }).trim();

async function main() {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'catdock-'));
  const store = new Store(d);
  await store.init();
  const catalog = new Catalog(path.join(d, 'packs'), path.join(d, 'lg.json'), { seedDir: path.join(root, 'packs') });
  await catalog.init();
  const backend = new Backend({ installId: store.installId });
  const st = await backend.start();
  if (st.state !== 'ready') throw new Error(`engine not ready: ${/** @type {any} */ (st).reason}`);
  const exec = new Executor({ catalog, store, backend });
  const problems = catalog.list().problems.filter((p) => !only.length || only.includes(p.key.split('/')[1]));
  /** @type {any[]} */
  const results = [];
  let unexpected = 0;

  async function submit(/** @type {string} */ key, /** @type {string} */ language, /** @type {string} */ source) {
    for (let i = 0; i < 300 && backend.getStatus().state !== 'ready'; i++) await sleep(200);
    if (backend.getStatus().state !== 'ready') throw new Error(`engine not ready before ${key}/${language}: ${/** @type {any} */ (backend.getStatus()).reason}`);
    const hash = catalog.getInternal(key).problem.contentHash;
    const t0 = Date.now();
    const { jobId } = exec.start({ key, contentHash: hash, language, source, mode: 'submit', customInput: '' });
    for (;;) {
      const g = exec.get(jobId);
      if (g.state === 'done') {
        const r = g.result;
        /** @type {Record<string, number>} */
        const counts = {};
        for (const c of r.cases) counts[c.status] = (counts[c.status] || 0) + 1;
        return { verdict: r.verdict, counts, ms: Date.now() - t0, cleanup: Boolean(r.cleanup && r.cleanup.confirmed) };
      }
      if (Date.now() - t0 > 120000) throw new Error(`job ${key}/${language} did not finish in 120 s`);
      await sleep(100);
    }
  }
  function record(/** @type {any} */ row, /** @type {boolean} */ ok) {
    results.push({ ...row, expectedOutcome: ok ? 'as-expected' : 'UNEXPECTED' });
    if (!ok) unexpected += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${row.kind.padEnd(8)} ${row.id.padEnd(22)} ${row.language.padEnd(10)} ${row.verdict} ${JSON.stringify(row.counts)} ${row.ms}ms`);
  }

  for (const p of problems) {
    const id = p.key.split('/')[1];
    const ref = fs.readFileSync(path.join(root, 'catalog-dev', 'refs', `${id}.py`), 'utf8');
    const a = await submit(p.key, 'python', ref);
    record({ kind: 'reference', id, language: 'python', ...a }, a.verdict === 'ACCEPTED' && a.cleanup);
    if (!skipWrong) {
      const wrong = fs.readFileSync(path.join(root, 'catalog-dev', 'wrong', `${id}.py`), 'utf8');
      const w = await submit(p.key, 'python', wrong);
      record({ kind: 'wrong', id, language: 'python', ...w }, w.verdict !== 'ACCEPTED' && w.cleanup);
    }
  }
  const solDir = path.join(root, 'catalog-dev', 'solutions');
  for (const f of fs.existsSync(solDir) ? fs.readdirSync(solDir).sort() : []) {
    const id = f.slice(0, f.lastIndexOf('.'));
    const language = /** @type {Record<string, string>} */ (EXT)[path.extname(f)];
    const prob = problems.find((p) => p.key.endsWith(`/${id}`));
    if (!language || !prob) continue;
    const s = await submit(prob.key, language, fs.readFileSync(path.join(solDir, f), 'utf8'));
    record({ kind: 'solution', id, language, ...s }, s.verdict === 'ACCEPTED' && s.cleanup);
  }
  for (const id of STARTER_PROBLEMS) {
    const p = problems.find((x) => x.key.endsWith(`/${id}`));
    if (!p) continue;
    const full = catalog.getPublic(p.key);
    for (const language of ['python', 'javascript', 'cpp', 'c']) {
      const s = await submit(p.key, language, full.starters[language]);
      record({ kind: 'starter', id, language, ...s }, s.verdict === 'WRONG_ANSWER' && s.cleanup);
    }
  }
  const stopped = await backend.stop();
  const left = owned(store.installId);
  /** @type {any} */
  const summary = { total: results.length, unexpected, byKind: {}, containersStopConfirmed: stopped.confirmed, taskOwnedContainersLeft: left === '' ? 0 : left.split('\n').length };
  for (const r of results) {
    const k = (summary.byKind[r.kind] = summary.byKind[r.kind] || { n: 0, asExpected: 0 });
    k.n += 1;
    if (r.expectedOutcome === 'as-expected') k.asExpected += 1;
  }
  if (process.env.MECODE_CATALOG_DOCKER_LOG) fs.writeFileSync(process.env.MECODE_CATALOG_DOCKER_LOG, `${JSON.stringify({ summary, results }, null, 2)}\n`);
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
  fs.rmSync(d, { recursive: true, force: true });
  process.exit(unexpected === 0 && stopped.confirmed && left === '' ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
