'use strict';
// REAL container integration. Runs ONLY with MECODE_REAL_DOCKER=1 and a provisioned image `mecode-engine:v2`.
// Without the env var every test is reported SKIPPED ("NOT RUN") — never a pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Backend } = require('../../src/main/backend.cjs');
const { Executor } = require('../../src/main/exec.cjs');
const { Catalog } = require('../../src/main/catalog.cjs');
const { Store } = require('../../src/main/store.cjs');

const on = process.env.MECODE_REAL_DOCKER === '1';
const opts = { skip: on ? false : 'NOT RUN: set MECODE_REAL_DOCKER=1 with operator-approved docker + provisioned mecode-engine:v2' };

async function setup() {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mcd-'));
  const store = new Store(d); await store.init();
  const catalog = new Catalog(path.join(d, 'packs'), path.join(d, 'lg.json'), { seedDir: path.join(__dirname, '../../packs') }); await catalog.init();
  const backend = new Backend({ installId: store.installId });
  const st = await backend.start();
  assert.equal(st.state, 'ready', st.reason);
  return { store, catalog, backend, exec: new Executor({ catalog, store, backend }) };
}
async function run(ctx, language, source, mode, key = 'mecode-core/beacon-pairs') {
  for (let i = 0; i < 100 && ctx.backend.getStatus().state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 200));
  const hash = ctx.catalog.getInternal(key).problem.contentHash;
  const { jobId } = ctx.exec.start({ key, contentHash: hash, language, source, mode, customInput: '1 1\n1\n' });
  for (;;) { const g = ctx.exec.get(jobId); if (g.state === 'done') return g.result; await new Promise((r) => setTimeout(r, 100)); }
}
const PY_OK = 'import sys\nfrom collections import Counter\nd=sys.stdin.read().split();n,t=int(d[0]),int(d[1]);a=list(map(int,d[2:2+n]))\nc=Counter();r=0\nfor x in a:\n r+=c[t-x];c[x]+=1\nprint(r)\n';

test('real container: python wrong answer then accepted; timeout; cleanup confirmed', opts, async () => {
  const ctx = await setup();
  assert.equal((await run(ctx, 'python', 'print(0)', 'submit')).verdict, 'WRONG_ANSWER');
  const ok = await run(ctx, 'python', PY_OK, 'submit'); assert.equal(ok.verdict, 'ACCEPTED'); assert.equal(ok.cleanup.confirmed, true);
  assert.equal((await run(ctx, 'python', 'while True: pass', 'examples')).verdict, 'TIME_LIMIT');
});
test('real container: javascript and cpp conformance', opts, async () => {
  const ctx = await setup();
  assert.equal((await run(ctx, 'javascript', 'console.log(0)', 'submit')).verdict, 'WRONG_ANSWER');
  assert.equal((await run(ctx, 'cpp', 'int main(){ nope }', 'examples')).verdict, 'COMPILE_ERROR');
});
test('real container: engine reports cgroup controls matching requested limits', opts, async () => {
  const ctx = await setup();
  const c = ctx.backend.getStatus().controls;
  assert.equal(c.memoryMax, String(512 * 1024 * 1024)); assert.equal(c.pidsMax, '64');
});
