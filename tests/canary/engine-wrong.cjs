'use strict';
// Canary child: a KNOWN-WRONG solution run through the REAL engine container must yield WRONG_ANSWER.
// argv[2] = verdict to ASSERT. Normal pipeline uses WRONG_ANSWER (green) and, via run-canaries.cjs, ACCEPTED (must fail at the named assertion).
// Idea attribution: structure follows Themis's T10 canary.cjs (MeCode-v2-management/T10-evidence), re-implemented here; not Prax independent QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const cp = require('node:child_process');
const { createServices } = require('../../src/main/services.cjs');
const { repoRoot, tmpDir } = require('../e2e/harness.cjs');

const expected = process.argv[2];
if (!expected) throw new Error('usage: engine-wrong.cjs <verdict-to-assert>');
(async () => {
  const dir = tmpDir('mecode-canary-');
  let svc;
  try {
    svc = await createServices({ userData: dir, appRoot: repoRoot, autostart: false });
    const st = await svc.backend.start();
    assert.equal(st.state, 'ready', `engine not ready (canary must not pass on launch failure): ${st.reason}`);
    const key = 'mecode-core/beacon-pairs';
    const contentHash = svc.catalog.getInternal(key).problem.contentHash;
    const { jobId } = svc.exec.start({ key, contentHash, language: 'python', source: 'print(-123456789)\n', mode: 'submit' });
    const t0 = Date.now();
    let g;
    for (;;) {
      g = svc.exec.get(jobId);
      if (g.state === 'done') break;
      assert.ok(Date.now() - t0 < 60000, 'job did not finish in 60 s');
      await new Promise((r) => setTimeout(r, 50));
    }
    // Evidence markers prove the REAL container executed the source before the assertion below runs.
    console.log(`ACTUAL_VERDICT=${g.result.verdict}`);
    console.log(`ACTUAL_CASE_STATUSES=${g.result.cases.map((c) => `${c.id}:${c.status}:exit${c.exitCode}`).join(',')}`);
    console.log(`ACTUAL_CLEANUP=${JSON.stringify(g.result.cleanup)}`);
    assert.equal(g.result.verdict, expected, 'CANARY-ASSERT:known-wrong-solution-verdict');
  } finally {
    if (svc) {
      const r = await svc.shutdown();
      assert.equal(r.confirmed, true, 'CANARY-ASSERT:shutdown-confirmed');
      const label = ['--filter', 'label=mecode.app=mecode-v2', '--filter', `label=mecode.install=${svc.store.installId}`];
      assert.equal(cp.execFileSync('docker', ['ps', '-aq', ...label], { encoding: 'utf8', timeout: 15000 }).trim(), '', 'CANARY-ASSERT:no-owned-container-left');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
