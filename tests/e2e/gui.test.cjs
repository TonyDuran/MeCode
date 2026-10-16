'use strict';
/* global document, window -- referenced only inside page.evaluate/waitForFunction callbacks, which run in the browser */
// Real-browser GUI E2E against the REAL web server + REAL Docker engine (no mocked service).
// Flow: fresh data dir -> import external pack via the real file input -> pick problem -> edit -> WRONG_ANSWER -> edit -> ACCEPTED
//       -> Save -> stop server, restart (new session secret) -> draft + ACCEPTED status restored -> edit pack on disk -> Reload
//       -> content hash changes, status becomes stale, same source now WRONG_ANSWER.
// Browser: playwright-core driving an installed Chrome (channel "chrome"). Chromium sandbox stays ENABLED (no --no-sandbox).
// Env: MECODE_E2E_APP_ROOT (app tree under test, default repo), MECODE_E2E_EXPECT_WA (canary: assert this instead of WRONG_ANSWER),
//      MECODE_E2E_SHOTS (dir for failure screenshots), MECODE_E2E_CHROME (executablePath override).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { chromium } = require('playwright-core');
const { repoRoot, startServer, ownedContainers, tmpDir } = require('./harness.cjs');

const appRoot = process.env.MECODE_E2E_APP_ROOT || repoRoot;
const expectWA = process.env.MECODE_E2E_EXPECT_WA || 'WRONG_ANSWER';
const shots = process.env.MECODE_E2E_SHOTS || null;
const step = (name) => console.log(`GUI-STEP ${name}`);

const WRONG = 'x = int(input())\nprint(x * 3)\n';
const RIGHT = 'x = int(input())\nprint(x * 2)\n';

test('GUI: import -> edit -> WRONG_ANSWER -> ACCEPTED -> save -> restart -> restored -> edit pack -> Reload -> stale + changed verdict', { timeout: 240000 }, async () => {
  const work = tmpDir('mecode-gui-');
  const dataDir = path.join(work, 'data');
  const packFile = path.join(work, 'external-pack.json');
  cp.execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'make-demo-pack.cjs'), packFile], { stdio: 'ignore' });
  let server = null;
  let browser = null;
  let page = null;
  try {
    server = await startServer({ appRoot, dataDir, log: console.log });
    const opts = { channel: 'chrome', headless: true, chromiumSandbox: true };
    if (process.env.MECODE_E2E_CHROME) {
      delete opts.channel;
      opts.executablePath = process.env.MECODE_E2E_CHROME;
    }
    browser = await chromium.launch(opts);
    console.log(`browser: ${browser.version()} (sandbox enabled)`);
    const ctx = await browser.newContext({ acceptDownloads: false });
    page = await ctx.newPage();
    // Offline-ness: the page must make no request outside the loopback origin.
    const external = [];
    page.on('request', (r) => {
      if (!/^(http:\/\/127\.0\.0\.1:\d+\/|about:|data:|blob:)/.test(r.url())) external.push(r.url());
    });

    const open = async (url) => {
      await page.goto(url);
      await page.waitForFunction(() => /backend: ready/.test(document.getElementById('backend').textContent), null, { timeout: 90000 });
    };

    step('open-launch-link-backend-ready');
    await open(server.launchUrl);
    const backendText = await page.textContent('#backend');
    assert.ok(/python/.test(backendText), `GUI-ASSERT:backend-ready-languages (${backendText})`);
    console.log(`backend line: ${backendText}`);
    assert.ok(!page.url().includes('#s='), 'GUI-ASSERT:session-secret-scrubbed-from-url');

    step('import-external-pack-via-file-input');
    await page.setInputFiles('#importFile', packFile);
    await page.waitForFunction(() => /imported pack ext-demo/.test(document.getElementById('importStatus').textContent), null, { timeout: 15000 });
    await page.click('#list li:has-text("Double It")');
    await page.waitForFunction(() => document.getElementById('title').textContent === 'Double It');
    await page.selectOption('#lang', 'python');
    await page.waitForFunction(() => !document.getElementById('editor').disabled);

    step('wrong-answer-step');
    await page.fill('#editor', WRONG);
    await page.click('#submit');
    await page.waitForFunction(() => /^submit: [A-Z_]+/.test(document.getElementById('verdict').textContent), null, { timeout: 90000 });
    const wa = await page.textContent('#verdict');
    console.log(`observed verdict (wrong source): ${wa}`);
    assert.ok(wa.includes(expectWA), `GUI-ASSERT:wrong-answer-verdict expected "${expectWA}" in "${wa}"`);

    step('accepted-step');
    await page.fill('#editor', RIGHT);
    await page.click('#submit');
    await page.waitForFunction(() => /^submit: [A-Z_]+/.test(document.getElementById('verdict').textContent) && !/WRONG_ANSWER/.test(document.getElementById('verdict').textContent), null, {
      timeout: 90000,
    });
    const acc = await page.textContent('#verdict');
    console.log(`observed verdict (right source): ${acc}`);
    assert.ok(acc.includes('ACCEPTED'), `GUI-ASSERT:accepted-verdict in "${acc}"`);

    step('explicit-save');
    await page.click('#save');
    await page.waitForFunction(() => /^saved/.test(document.getElementById('saveState').textContent), null, { timeout: 15000 });
    await page.waitForFunction(() => /^\[solved\]/i.test(document.querySelector('#list li.sel').textContent), null, { timeout: 15000 });

    step('restart-server-and-reopen');
    await page.close();
    await server.stop();
    assert.equal(ownedContainers(dataDir), '', 'GUI-ASSERT:no-owned-container-after-server-stop');
    server = await startServer({ appRoot, dataDir, log: console.log });
    page = await ctx.newPage();
    await open(server.launchUrl);
    await page.click('#list li:has-text("Double It")');
    await page.waitForFunction(() => document.getElementById('title').textContent === 'Double It');
    await page.waitForFunction(() => /draft restored/.test(document.getElementById('saveState').textContent), null, { timeout: 15000 });
    assert.equal(await page.inputValue('#editor'), RIGHT, 'GUI-ASSERT:draft-source-restored-after-restart');
    assert.match(await page.textContent('#list li.sel'), /^\[solved\]/i, 'GUI-ASSERT:accepted-status-restored-after-restart');
    const hashBefore = await page.evaluate(() => window.mecode.catalog.get({ key: 'ext-demo/double-it' }).then((r) => r.value.contentHash));

    step('edit-pack-on-disk-and-reload');
    const packsDir = path.join(dataDir, 'packs');
    const managed = fs.readdirSync(packsDir).find((f) => fs.readFileSync(path.join(packsDir, f), 'utf8').includes('"ext-demo"'));
    assert.ok(managed, 'GUI-ASSERT:managed-pack-file-present');
    const doc = JSON.parse(fs.readFileSync(path.join(packsDir, managed), 'utf8'));
    doc.problems[0].tests.find((t) => t.id === 'check-neg').expected = '-7\n'; // now WRONG for the correct source
    fs.writeFileSync(path.join(packsDir, managed), JSON.stringify(doc, null, 2));
    await page.click('#reload');
    await page.waitForFunction(() => /^reloaded/.test(document.getElementById('importStatus').textContent), null, { timeout: 15000 });
    await page.waitForFunction(() => /^\[stale\]/i.test(document.querySelector('#list li.sel').textContent), null, { timeout: 15000 });
    const hashAfter = await page.evaluate(() => window.mecode.catalog.get({ key: 'ext-demo/double-it' }).then((r) => r.value.contentHash));
    assert.notEqual(hashAfter, hashBefore, 'GUI-ASSERT:content-hash-changed-after-reload');
    await page.click('#submit');
    await page.waitForFunction(() => /^submit: [A-Z_]+/.test(document.getElementById('verdict').textContent), null, { timeout: 90000 });
    const changed = await page.textContent('#verdict');
    console.log(`observed verdict (edited tests): ${changed}`);
    assert.ok(changed.includes('WRONG_ANSWER'), `GUI-ASSERT:changed-test-verdict in "${changed}"`);

    assert.deepEqual(external, [], 'GUI-ASSERT:no-external-network-requests');
    console.log('GUI-FLOW-COMPLETE');
  } catch (e) {
    if (page && shots) {
      fs.mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, 'gui-failure.png') }).catch(() => {});
      const txt = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => '');
      fs.writeFileSync(path.join(shots, 'gui-failure.txt'), txt);
    }
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) {
      await server.stop().catch((e) => console.log(`server stop: ${e.message}`));
      assert.equal(ownedContainers(dataDir), '', 'GUI-ASSERT:no-owned-container-at-teardown');
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
});
