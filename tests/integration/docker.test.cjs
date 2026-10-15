'use strict';
// REAL container integration (rootless Docker). Runs only with MECODE_REAL_DOCKER=1 and the app-owned image `mecode-engine:v2`
// (build: docker build -t mecode-engine:v2 engine/). Without the env var every test is reported SKIPPED (NOT RUN), never a pass.
// Every test has a hard deadline, always stops its backend (finally), and asserts no task-owned container remains.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Backend } = require('../../src/main/backend.cjs');
const { Executor } = require('../../src/main/exec.cjs');
const { Catalog } = require('../../src/main/catalog.cjs');
const { Store } = require('../../src/main/store.cjs');

const on = process.env.MECODE_REAL_DOCKER === '1';
const opts = { skip: on ? false : 'NOT RUN: set MECODE_REAL_DOCKER=1 with the provisioned mecode-engine:v2 image', timeout: 150000 };
const KEY = 'mecode-core/beacon-pairs';

async function setup(limits) {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mcd-'));
  const store = new Store(d); await store.init();
  const catalog = new Catalog(path.join(d, 'packs'), path.join(d, 'lg.json'), { seedDir: path.join(__dirname, '../../packs') }); await catalog.init();
  const backend = new Backend({ installId: store.installId, limits: limits || undefined });
  const st = await backend.start();
  assert.equal(st.state, 'ready', st.reason);
  return { store, catalog, backend, exec: new Executor({ catalog, store, backend }) };
}
async function run(ctx, language, source, mode, customInput = '3 5\n1 4 1\n') {
  for (let i = 0; i < 150 && ctx.backend.getStatus().state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 200));
  assert.equal(ctx.backend.getStatus().state, 'ready', `engine not ready: ${ctx.backend.getStatus().reason}`);
  const hash = ctx.catalog.getInternal(KEY).problem.contentHash;
  const { jobId } = ctx.exec.start({ key: KEY, contentHash: hash, language, source, mode, customInput });
  const t0 = Date.now();
  for (;;) {
    const g = ctx.exec.get(jobId); if (g.state === 'done') return g.result;
    if (Date.now() - t0 > 60000) assert.fail(`job ${language}/${mode} did not finish within 60 s (hung engine)`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const owned = (ctx) => cp.execFileSync('docker', ['ps', '-aq', '--filter', 'label=mecode.app=mecode-v2', '--filter', `label=mecode.install=${ctx.store.installId}`], { encoding: 'utf8', timeout: 10000 }).trim();
async function finish(ctx) { const r = await ctx.backend.stop(); assert.equal(r.confirmed, true); assert.equal(owned(ctx), '', 'task-owned containers remain'); }

const SRC = {
  python: 'import sys\nfrom collections import Counter\nd=sys.stdin.read().split();n,t=int(d[0]),int(d[1]);a=list(map(int,d[2:2+n]))\nc=Counter();r=0\nfor x in a:\n r+=c[t-x];c[x]+=1\nprint(r)\n',
  javascript: "const d=require('fs').readFileSync(0,'utf8').split(/\\s+/).filter(Boolean).map(Number);const n=d[0],t=d[1];const m=new Map();let r=0;for(let i=0;i<n;i++){const x=d[2+i];r+=m.get(t-x)||0;m.set(x,(m.get(x)||0)+1);}console.log(r);\n",
  cpp: '#include <bits/stdc++.h>\nint main(){long long n,t;std::cin>>n>>t;std::unordered_map<long long,long long> m;long long r=0;for(long long i=0;i<n;i++){long long x;std::cin>>x;auto it=m.find(t-x);if(it!=m.end())r+=it->second;m[x]++;}std::cout<<r<<"\\n";}\n',
  c: '#include <stdio.h>\nstatic long long a[100005];\nint main(){long long n,t;scanf("%lld %lld",&n,&t);for(long long i=0;i<n;i++)scanf("%lld",&a[i]);long long r=0;for(long long i=0;i<n;i++)for(long long j=i+1;j<n;j++)if(a[i]+a[j]==t)r++;printf("%lld\\n",r);return 0;}\n',
};

test('real container: controls match requested limits (cgroup v2 memory/pids/cpu, uid 65534) and languages report versions', opts, async () => {
  const ctx = await setup();
  try {
    const st = ctx.backend.getStatus();
    assert.equal(st.state, 'ready');
    assert.equal(st.controls.memoryMax, String(512 * 1048576)); assert.equal(st.controls.pidsMax, '64'); assert.equal(st.controls.cpuMax, '100000 100000'); assert.equal(st.controls.uid, 65534);
    for (const l of ['python', 'javascript', 'cpp', 'c']) assert.ok(st.languages.some((x) => x.id === l), `language ${l}`);
    console.log('REAL controls', JSON.stringify(st.controls), 'languages', JSON.stringify(st.languages), 'image', st.imageId);
  } finally { await finish(ctx); }
});

test('real container: SUCCESSFUL submissions in python, javascript, cpp (C++17) and c (C17) are ACCEPTED', opts, async () => {
  const ctx = await setup();
  try {
    for (const l of ['python', 'javascript', 'cpp', 'c']) {
      const r = await run(ctx, l, SRC[l], 'submit');
      console.log(`REAL ${l}: verdict=${r.verdict} cleanup=${r.cleanup && r.cleanup.confirmed} cases=${r.cases.map((c) => `${c.status}:${c.elapsedMs}ms`).join(',')}`);
      assert.equal(r.verdict, 'ACCEPTED', `${l}: ${JSON.stringify(r).slice(0, 400)}`);
      assert.equal(r.cleanup.confirmed, true);
    }
    assert.equal(ctx.store.statusOf(KEY, ctx.catalog.getInternal(KEY).problem.contentHash), 'solved');
  } finally { await finish(ctx); }
});

test('real container: wrong answer, compile error, runtime error, timeout, output limit, fork (pids) cap, custom run', opts, async () => {
  const ctx = await setup();
  try {
    assert.equal((await run(ctx, 'python', 'print(0)', 'submit')).verdict, 'WRONG_ANSWER');
    const ce = await run(ctx, 'cpp', 'int main(){ nope }', 'examples'); assert.equal(ce.verdict, 'COMPILE_ERROR'); assert.match(ce.compile.output, /error/);
    assert.equal((await run(ctx, 'python', 'raise SystemExit(3)', 'examples')).verdict, 'RUNTIME_ERROR');
    const t0 = Date.now(); const to = await run(ctx, 'python', 'while True: pass', 'examples'); assert.equal(to.verdict, 'TIME_LIMIT'); console.log('REAL timeout wall ms', Date.now() - t0);
    assert.equal((await run(ctx, 'python', 'print("x"*2000000)', 'examples')).verdict, 'OUTPUT_LIMIT');
    const fork = await run(ctx, 'python', 'import os,time\nn=0\nfor _ in range(300):\n    try:\n        if os.fork()==0:\n            time.sleep(3); os._exit(0)\n        n+=1\n    except OSError:\n        print("fork-denied-after",n); break\n', 'custom');
    console.log('REAL fork test', fork.verdict, JSON.stringify(fork.cases[0].stdout.trim()), fork.cases[0].stderr.slice(0, 120));
    assert.match(fork.cases[0].stdout, /fork-denied-after \d+/, 'pids.max must deny fork before 300 children');
    const cu = await run(ctx, 'javascript', 'console.log(require("fs").readFileSync(0,"utf8").trim()+"!")', 'custom', 'hi'); assert.equal(cu.verdict, 'EXECUTED'); assert.equal(cu.cases[0].stdout.trim(), 'hi!');
  } finally { await finish(ctx); }
});

test('real container: memory limit (512 MiB cgroup) is enforced; verdict reported truthfully', opts, async () => {
  const ctx = await setup();
  try {
    const r = await run(ctx, 'python', 'b = bytearray(1500*1024*1024)\nprint(len(b))\n', 'examples');
    console.log('REAL memory test', r.verdict, JSON.stringify(r.cases.map((c) => ({ s: c.status, exit: c.exitCode, sig: c.signal }))), 'oomKilled', r.cleanup && r.cleanup.oomKilled);
    assert.ok(['MEMORY_LIMIT', 'RUNTIME_ERROR'].includes(r.verdict), r.verdict);
    assert.ok(r.cases.every((c) => c.status !== 'PASS'));
  } finally { await finish(ctx); }
});

test('real container: cancel kills the owned container; bounded cleanup confirmed; no reprepare after stop', opts, async () => {
  const ctx = await setup();
  try {
    for (let i = 0; i < 50 && ctx.backend.getStatus().state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 100));
    const hash = ctx.catalog.getInternal(KEY).problem.contentHash;
    const { jobId } = ctx.exec.start({ key: KEY, contentHash: hash, language: 'python', source: 'while True: pass', mode: 'custom', customInput: '' });
    await new Promise((r) => setTimeout(r, 1000));
    const t0 = Date.now(); ctx.exec.cancel(jobId);
    for (;;) { const g = ctx.exec.get(jobId); if (g.state === 'done') { assert.equal(g.result.verdict, 'CANCELLED'); assert.equal(g.result.cleanup.confirmed, true); console.log('REAL cancel->settled ms', Date.now() - t0, 'cleanup ms', g.result.cleanup.ms); break; } if (Date.now() - t0 > 20000) assert.fail('cancel did not settle'); await new Promise((r) => setTimeout(r, 50)); }
  } finally { await finish(ctx); }
});

test('real container: settings change applies to the NEXT actual container (memory 256 MiB, pids 40)', opts, async () => {
  const ctx = await setup();
  try {
    await ctx.backend.updateLimits({ memoryMiB: 256, pids: 40 }, async () => {});
    for (let i = 0; i < 100 && ctx.backend.getStatus().state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 100));
    const c = ctx.backend.getStatus().controls;
    assert.equal(c.memoryMax, String(256 * 1048576)); assert.equal(c.pidsMax, '40');
  } finally { await finish(ctx); }
});
