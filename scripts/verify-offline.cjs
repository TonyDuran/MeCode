#!/usr/bin/env node
/* global document -- referenced only inside page.waitForFunction callbacks, which run in the browser */
'use strict';
// Task-owned offline proof (development checkout; NOT shipped). Real Docker, real extracted Linux package, real engine, no mocks.
//   node scripts/verify-offline.cjs --package <linux .tar.gz> --out <new evidence dir> [--image mecode-engine:v2] [--browser]
// Sequence: record original image + unrelated containers -> export under a NEW alias -> verify export -> remove ONLY that alias tag
//   -> fresh extraction + fresh data + MECODE_ENGINE_IMAGE=<alias> via the generated start.sh -> observe missing-image state (unavailable, Run refused)
//   -> verified import -> Retry -> ready (exact image ID, four language IDs) -> four real accepted submissions + persisted retrieval
//   -> cleanup (owned server/containers/alias) -> original image ID/tag and unrelated containers unchanged.
// Nothing here downloads, pushes, prunes, deletes an image ID, or changes host/daemon/network settings. Exit 0 only if every check passed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const repo = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const pkg = opt('package');
const outDir = opt('out');
const image = opt('image', 'mecode-engine:v2');
const withBrowser = argv.includes('--browser');
if (!pkg || !outDir) {
  console.error('usage: verify-offline.cjs --package <linux.tar.gz> --out <new dir> [--image ref] [--browser]');
  process.exit(2);
}
if (fs.existsSync(outDir)) {
  console.error('--out must be a NEW directory');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const runId = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const alias = `mecode-engine:t27-${runId}`;
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mecode-offline-'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sh = (cmd, args, timeout = 60000) => {
  const r = cp.spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  return { code: r.error ? -1 : r.status, stdout: r.stdout || '', stderr: (r.stderr || '').slice(0, 400) };
};
const dk = (...a) => sh('docker', a, 60000);
const receipt = { schemaVersion: 1, runId, alias, startedAt: new Date().toISOString(), checks: [], commands: [], jobs: [] };
const check = (name, ok, detail = '') => {
  receipt.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${String(detail).slice(0, 160)}` : ''}`);
  return !!ok;
};
const imgInfo = (ref) => {
  const r = dk('image', 'inspect', ref, '--format', '{{.Id}}|{{.Os}}/{{.Architecture}}|{{with index . "Variant"}}{{.}}{{end}}');
  return r.code === 0 ? r.stdout.trim() : null;
};
const containerSnapshot = () =>
  dk('ps', '-a', '--format', '{{.ID}} {{.Names}} {{.Image}}')
    .stdout.split('\n')
    .filter((l) => l && !/mecode-engine/.test(l))
    .sort()
    .join('\n');
const cmd = (label, c, args, timeout) => {
  const r = sh(c, args, timeout);
  receipt.commands.push({ label, argv: [c, ...args].map((x) => x.replace(/#s=[0-9a-f]+/g, '#s=REDACTED')), exit: r.code });
  return r;
};

async function main() {
  const originalBefore = imgInfo(image);
  const unrelatedBefore = containerSnapshot();
  receipt.original = { reference: image, before: originalBefore };
  if (!check('original image present', originalBefore, originalBefore)) return;
  const [origId, origPlat] = originalBefore.split('|');
  receipt.platform = origPlat;

  // 1. export + verify
  const exportDir = path.join(outDir, 'export');
  const ex = cmd('export', process.execPath, [path.join(repo, 'scripts', 'provision-engine.cjs'), 'export', '--image', image, '--alias', alias, '--out', exportDir], 20 * 60 * 1000);
  if (!check('export exit 0', ex.code === 0, ex.stderr)) return;
  const man = JSON.parse(fs.readFileSync(path.join(exportDir, 'manifest.json'), 'utf8'));
  const tarFile = path.join(exportDir, 'engine.tar');
  const tarBuf = crypto.createHash('sha256');
  const fd = fs.openSync(tarFile, 'r');
  const b = Buffer.allocUnsafe(1 << 20);
  let n,
    bytes = 0;
  while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0) {
    tarBuf.update(b.subarray(0, n));
    bytes += n;
  }
  fs.closeSync(fd);
  receipt.export = {
    dir: exportDir,
    archiveBytes: bytes,
    archiveSha256: tarBuf.digest('hex'),
    imageId: man.image.id,
    platform: `${man.image.os}/${man.image.architecture}`,
    alias,
    recipeSha256: man.recipe && man.recipe.sha256,
  };
  check('export recomputed hash/size equal manifest', receipt.export.archiveSha256 === man.archive.sha256 && bytes === man.archive.bytes, `${bytes} bytes`);
  check('exported image ID equals original ID', man.image.id === origId, man.image.id);
  check('SHA256SUMS lists engine.tar', fs.readFileSync(path.join(exportDir, 'SHA256SUMS'), 'utf8').includes(`${man.archive.sha256}  engine.tar`));

  // 2. remove ONLY the owned alias tag (never by ID)
  const rm = cmd('remove owned alias tag', 'docker', ['image', 'rm', alias]);
  check('alias removed', rm.code === 0 && imgInfo(alias) === null, rm.stderr);
  check('original image still present with same ID after alias removal', (imgInfo(image) || '').split('|')[0] === origId);

  // 3. fresh extraction + fresh data + generated launcher
  const fresh = path.join(work, 'fresh');
  fs.mkdirSync(fresh);
  const tx = cmd('extract package', 'tar', ['-xzf', pkg, '-C', fresh]);
  if (!check('package extracted', tx.code === 0, tx.stderr)) return;
  const appDir = path.join(
    fresh,
    fs.readdirSync(fresh).find((x) => x.startsWith('mecode-v2-')),
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'MANIFEST.json'), 'utf8'));
  receipt.package = { file: path.resolve(pkg), sha256: sha(fs.readFileSync(pkg)), sourceRevision: manifest.sourceRevision, sourceTree: manifest.sourceTree, sourceDirty: manifest.sourceDirty };
  check('package built from a clean tree', manifest.sourceDirty === false, manifest.sourceRevision);
  const dataDir = path.join(work, 'fresh-data');
  const launchFile = path.join(work, 'launch.txt');
  const child = cp.spawn('sh', [path.join(appDir, 'start.sh')], {
    cwd: appDir,
    env: { ...process.env, MECODE_USER_DATA: dataDir, MECODE_LAUNCH_FILE: launchFile, MECODE_ENGINE_IMAGE: alias },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let launcherOut = '';
  child.stdout.on('data', (d) => (launcherOut = (launcherOut + d).slice(-4000)));
  child.stderr.on('data', (d) => (launcherOut = (launcherOut + d).slice(-4000)));
  let exited = false;
  child.on('exit', () => (exited = true));
  let browser = null;
  let bpage = null;
  let installId = null;
  try {
    let url = '';
    for (let i = 0; i < 300 && !url && !exited; i++) {
      try {
        url = fs.readFileSync(launchFile, 'utf8').trim();
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!check('server published launch link (generated start.sh)', url, exited ? 'server exited' : '')) return;
    const origin = new URL(url).origin;
    const tok = /#s=([0-9a-f]{64})/.exec(url)[1];
    const api = async (name, arg = {}) => {
      const r = await fetch(`${origin}/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MeCode-Session': tok }, body: JSON.stringify(arg) });
      return r.json();
    };
    const waitState = async (pred, ms) => {
      const t0 = Date.now();
      let s;
      while (Date.now() - t0 < ms) {
        s = (await api('backend.status')).value;
        if (s && pred(s)) return s;
        await new Promise((r) => setTimeout(r, 400));
      }
      return s;
    };
    check('launcher printed missing-image NOTE with import guidance', /not found locally/.test(launcherOut) && /provision-engine\.cjs import/.test(launcherOut), launcherOut.slice(0, 120));

    // 4. missing alias state
    const missing = await waitState((s) => s.state === 'unavailable', 60000);
    receipt.missing = { state: missing && missing.state, reason: missing && missing.reason };
    check('missing alias => backend unavailable', missing && missing.state === 'unavailable');
    check(
      'reason names the alias, says never pulls, and gives import + build guidance',
      missing && missing.reason.includes(alias) && /never pulls/.test(missing.reason) && /provision-engine\.cjs import/.test(missing.reason) && /docker build/.test(missing.reason),
      missing && missing.reason.slice(0, 120),
    );
    check('no image appeared by itself (no pull)', imgInfo(alias) === null);
    const list = await api('catalog.list');
    check('catalog usable without engine', list.ok && list.value.problems.length >= 48, `${list.value && list.value.problems.length} problems`);
    const key0 = list.value.problems[0].key;
    const start0 = await api('execution.start', { key: key0, contentHash: list.value.problems[0].contentHash, language: 'python', source: 'print(1)\n', mode: 'examples' });
    check('Run refused while image missing', !start0.ok && start0.error.code === 'BACKEND_UNAVAILABLE', start0.error && start0.error.code);
    const d0 = await api('draft.save', { key: key0, language: 'python', source: '# offline draft\n', baseRevision: 0 });
    const d1 = await api('draft.load', { key: key0, language: 'python' });
    check('draft write/reopen works without engine', d0.ok && d1.ok && d1.value.source === '# offline draft\n');
    installId = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).installId;

    // 5. browser view of the same state (optional flag): Run disabled, external requests
    let external = [];
    if (withBrowser) {
      const { chromium } = require('playwright-core');
      const o = { channel: 'chrome', headless: true, chromiumSandbox: true };
      if (process.env.MECODE_E2E_CHROME) {
        delete o.channel;
        o.executablePath = process.env.MECODE_E2E_CHROME;
      }
      browser = await chromium.launch(o);
      const ctx = await browser.newContext();
      ctx.on('request', (r) => {
        if (!/^(http:\/\/127\.0\.0\.1:\d+\/|about:|data:|blob:)/.test(r.url())) external.push(r.url().split('?')[0]);
      });
      const page = await ctx.newPage();
      await page.goto(url);
      await page.waitForFunction(() => /backend: unavailable/.test(document.getElementById('backend').textContent), null, { timeout: 30000 });
      await page.click('#list li');
      await page.waitForFunction(() => document.getElementById('work').hidden === false);
      const ui = {
        backend: await page.textContent('#backend'),
        submitDisabled: await page.isDisabled('#submit'),
        runDisabled: await page.isDisabled('#runEx'),
        retryShown: await page.isVisible('#retry'),
      };
      check('browser: unavailable text + Run/Submit disabled + Retry shown', /not present locally/.test(ui.backend) && ui.submitDisabled && ui.runDisabled && ui.retryShown, ui.backend.slice(0, 100));
      receipt.browser = { missingImageView: { runDisabled: ui.runDisabled, submitDisabled: ui.submitDisabled, retryShown: ui.retryShown } };
      bpage = page;
    }

    // 6. verified import, then Retry
    const im = cmd('import', process.execPath, [path.join(appDir, 'scripts', 'provision-engine.cjs'), 'import', '--manifest', path.join(exportDir, 'manifest.json')], 20 * 60 * 1000);
    check('import (from the extracted package script) exit 0', im.code === 0, im.stderr);
    check('alias present with the exported image ID', (imgInfo(alias) || '').startsWith(man.image.id), imgInfo(alias));
    await api('backend.retry');
    const ready = await waitState((s) => s.state === 'ready', 120000);
    receipt.ready = { state: ready && ready.state, imageId: ready && ready.imageId, languages: ready && ready.languages && ready.languages.map((l) => `${l.id} ${l.version}`) };
    check('backend ready after Retry', ready && ready.state === 'ready', ready && (ready.reason || ready.state));
    check('ready imageId equals exported image ID', ready && ready.imageId === man.image.id, ready && ready.imageId);
    const ids = ready ? ready.languages.map((l) => l.id).sort() : [];
    check('four language IDs', ids.join() === 'c,cpp,javascript,python', ids.join());
    if (withBrowser && bpage) {
      const page = bpage;
      await page.waitForFunction(() => /backend: ready/.test(document.getElementById('backend').textContent), null, { timeout: 60000 });
      check('browser: Run enabled after import (no reload)', (await page.isDisabled('#submit')) === false);
      receipt.browser.nonLoopbackRequests = external;
      check('browser: no non-loopback requests observed', external.length === 0, external.join(','));
    }

    // 7. four genuine accepted submissions on an imported external pack (no source edits)
    const packFile = path.join(work, 'pack.json');
    cp.execFileSync(process.execPath, [path.join(appDir, 'scripts', 'make-demo-pack.cjs'), packFile], { stdio: 'ignore' });
    const imp = await api('packs.import', { jsonText: fs.readFileSync(packFile, 'utf8'), replace: false });
    check('demo pack imported', imp.ok, imp.error && imp.error.message);
    const KEY = 'ext-demo/double-it';
    const prob = (await api('catalog.get', { key: KEY })).value;
    const SRC = {
      python: 'x = int(input())\nprint(x * 2)\n',
      javascript: "const x = parseInt(require('fs').readFileSync(0, 'utf8'));\nconsole.log(String(x * 2));\n",
      cpp: '#include <iostream>\nint main() { long long x; std::cin >> x; std::cout << x * 2 << "\\n"; return 0; }\n',
      c: '#include <stdio.h>\nint main(void) { long long x; if (scanf("%lld", &x) != 1) return 1; printf("%lld\\n", x * 2); return 0; }\n',
    };
    for (const [language, source] of Object.entries(SRC)) {
      await waitState((s) => s.state === 'ready', 60000);
      const st = await api('execution.start', { key: KEY, contentHash: prob.contentHash, language, source, mode: 'submit' });
      if (!check(`${language}: job started`, st.ok, st.error && st.error.message)) continue;
      let res = null;
      for (let i = 0; i < 600 && !res; i++) {
        const g = (await api('execution.get', { jobId: st.value.jobId })).value;
        if (g && g.state === 'done') res = g.result;
        else await new Promise((r) => setTimeout(r, 250));
      }
      const loaded = (await api('solution.load', { key: KEY, language })).value;
      const job = {
        language,
        jobId: st.value.jobId,
        key: KEY,
        contentHash: prob.contentHash,
        sourceHash: res && res.sourceHash,
        expectedSourceHash: sha(source),
        verdict: res && res.verdict,
        cleanupConfirmed: !!(res && res.cleanup && res.cleanup.confirmed),
        persistence: res && res.persistence,
        solutionPersistence: res && res.solutionPersistence,
        retrieved: !!(loaded && loaded.solution && loaded.solution.source === source && loaded.solution.sourceHash === sha(source) && !loaded.stale),
      };
      receipt.jobs.push(job);
      check(
        `${language}: ACCEPTED, source hash matches, cleanup confirmed, saved, retrievable`,
        job.verdict === 'ACCEPTED' && job.sourceHash === job.expectedSourceHash && job.cleanupConfirmed && job.persistence === 'saved' && job.solutionPersistence === 'saved' && job.retrieved,
        `${job.verdict} ${String(job.sourceHash).slice(0, 12)}`,
      );
    }
    const flags = require(path.join(appDir, 'src', 'main', 'backend.cjs')).buildRunArgs({
      name: 'x',
      installId: 'x',
      image: alias,
      limits: require(path.join(appDir, 'src', 'main', 'backend.cjs')).DEFAULT_LIMITS,
    });
    check('engine container argv has --network none (scoped, not whole-host isolation)', flags.join(' ').includes('--network none'));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!exited) {
      child.kill('SIGTERM');
      for (let i = 0; i < 200 && !exited; i++) await new Promise((r) => setTimeout(r, 100));
      if (!exited) child.kill('SIGKILL');
    }
    const owned = installId ? dk('ps', '-aq', '--filter', 'label=mecode.app=mecode-v2', '--filter', `label=mecode.install=${installId}`).stdout.trim() : 'unknown';
    check('owned server stopped and owned containers absent', exited && owned === '', owned);
    const rmA = dk('image', 'rm', alias);
    check('owned alias tag removed (by tag, never by ID)', imgInfo(alias) === null, rmA.stderr);
    const after = imgInfo(image);
    receipt.original.after = after;
    check('original image reference and ID unchanged', after === originalBefore, `${originalBefore} -> ${after}`);
    check('unrelated containers unchanged', containerSnapshot() === unrelatedBefore);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main()
  .catch((e) => check('script error', false, e && e.stack))
  .finally(() => {
    receipt.finishedAt = new Date().toISOString();
    receipt.passed = receipt.checks.filter((c) => c.ok).length;
    receipt.failed = receipt.checks.filter((c) => !c.ok).length;
    fs.writeFileSync(path.join(outDir, 'offline-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`OFFLINE-VERIFY passed=${receipt.passed} failed=${receipt.failed} receipt=${path.join(outDir, 'offline-receipt.json')}`);
    process.exit(receipt.failed === 0 ? 0 : 1);
  });
