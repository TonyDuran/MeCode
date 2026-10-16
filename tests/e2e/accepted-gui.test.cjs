'use strict';
/* global document, window -- referenced only inside page.evaluate/waitForFunction callbacks, which run in the browser */
// T27 real-browser flow against the REAL web server + REAL Docker engine:
//   accepted submit -> overwrite the draft with a WRONG solution and save -> restart server -> the wrong draft is what reopens (accepted source NOT silently restored)
//   -> explicit "Load accepted solution" replaces only the editor, saved draft stays wrong until the user saves -> accepted record bound to the exact submitted source hash.
// Env: MECODE_E2E_APP_ROOT (app tree under test), MECODE_E2E_SHOTS, MECODE_E2E_CHROME (executablePath override).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const cp = require('node:child_process');
const { chromium } = require('playwright-core');
const { repoRoot, startServer, ownedContainers, tmpDir } = require('./harness.cjs');
const fs = require('node:fs');

const appRoot = process.env.MECODE_E2E_APP_ROOT || repoRoot;
const shots = process.env.MECODE_E2E_SHOTS || null;
const step = (name) => console.log(`GUI-STEP ${name}`);
const WRONG = 'x = int(input())\nprint(x * 3)\n';
const RIGHT = 'x = int(input())\nprint(x * 2)\n';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const KEY = 'ext-demo/double-it';

test('GUI T27: accepted -> wrong draft saved -> restart -> wrong draft restored -> explicit Load accepted -> exact accepted source, nothing silently overwritten', { timeout: 240000 }, async () => {
  const work = tmpDir('mecode-acc-');
  const dataDir = path.join(work, 'data');
  const packFile = path.join(work, 'external-pack.json');
  cp.execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'make-demo-pack.cjs'), packFile], { stdio: 'ignore' });
  let server = null;
  let browser = null;
  let page = null;
  try {
    server = await startServer({ appRoot, dataDir, log: () => {} });
    const opts = { channel: 'chrome', headless: true, chromiumSandbox: true };
    if (process.env.MECODE_E2E_CHROME) {
      delete opts.channel;
      opts.executablePath = process.env.MECODE_E2E_CHROME;
    }
    browser = await chromium.launch(opts);
    const ctx = await browser.newContext({ acceptDownloads: false });
    page = await ctx.newPage();
    const external = [];
    ctx.on('request', (r) => {
      if (!/^(http:\/\/127\.0\.0\.1:\d+\/|about:|data:|blob:)/.test(r.url())) external.push(r.url());
    });
    const open = async (url) => {
      await page.goto(url);
      await page.waitForFunction(() => /backend: ready/.test(document.getElementById('backend').textContent), null, { timeout: 90000 });
    };
    const verdictReady = () =>
      page.waitForFunction(() => /^submit: [A-Z_]+/.test(document.getElementById('verdict').textContent) && !/Running|Saving/.test(document.getElementById('verdict').textContent), null, {
        timeout: 90000,
      });

    step('import-and-open');
    await open(server.launchUrl);
    await page.setInputFiles('#importFile', packFile);
    await page.waitForFunction(() => /imported pack ext-demo/.test(document.getElementById('importStatus').textContent), null, { timeout: 15000 });
    await page.click('#list li:has-text("Double It")');
    await page.waitForFunction(() => document.getElementById('title').textContent === 'Double It');
    await page.waitForFunction(() => !document.getElementById('editor').disabled);
    assert.equal(await page.isDisabled('#loadAccepted'), false, 'GUI-ASSERT:load-accepted-enabled-when-clean');
    await page.click('#loadAccepted');
    await page.waitForFunction(() => /No accepted solution/.test(document.getElementById('acceptedInfo').textContent), null, { timeout: 15000 });

    step('accepted-submit');
    await page.fill('#editor', RIGHT);
    assert.equal(await page.isDisabled('#loadAccepted'), true, 'GUI-ASSERT:load-disabled-while-dirty');
    assert.match(await page.textContent('#acceptedHint'), /Save your draft before loading accepted source/);
    await page.click('#submit');
    // T28 finding 1: edit WHILE the real job runs; the late ACCEPTED must still be historical, also after save + navigate away/back
    await page.waitForFunction(() => document.getElementById('verdict').textContent === 'Running…', null, { timeout: 30000 });
    const EDITED = `${RIGHT}# edited while the job was running\n`;
    await page.fill('#editor', EDITED);
    await verdictReady();
    const acc = await page.textContent('#verdict');
    assert.ok(acc.includes('ACCEPTED'), `GUI-ASSERT:accepted in "${acc}"`);
    assert.match(acc, /editor text changed since this result/, 'GUI-ASSERT:late-ACCEPTED-is-historical-after-edit-during-job');
    assert.match(await page.textContent('#results'), /solution: saved/);
    console.log(`ACCEPTED-GUI-SOURCE-HASH ${sha(RIGHT)}`);
    await page.click('#save');
    await page.waitForFunction(() => /^saved/.test(document.getElementById('saveState').textContent), null, { timeout: 15000 });
    await page.click('#list li:not(:has-text("Double It"))');
    await page.waitForFunction(() => document.getElementById('title').textContent !== 'Double It');
    await page.waitForFunction(() => !document.getElementById('editor').disabled);
    await page.click('#list li:has-text("Double It")');
    await page.waitForFunction(() => document.getElementById('title').textContent === 'Double It');
    await page.waitForFunction(() => !document.getElementById('editor').disabled);
    assert.equal(await page.inputValue('#editor'), EDITED);
    const back = await page.textContent('#verdict');
    assert.ok(back.includes('ACCEPTED'), `GUI-ASSERT:result still shown after navigate back: "${back}"`);
    assert.match(back, /editor text changed since this result/, 'GUI-ASSERT:ACCEPTED-historical-after-navigate-away-back');

    step('wrong-draft-saved');
    await page.fill('#editor', WRONG);
    assert.match(await page.textContent('#verdict'), /editor text changed since this result/, 'GUI-ASSERT:accepted-label-qualified-on-edit');
    await page.click('#save');
    await page.waitForFunction(() => /^saved/.test(document.getElementById('saveState').textContent), null, { timeout: 15000 });

    step('restart');
    await page.close();
    await server.stop();
    assert.equal(ownedContainers(dataDir), '', 'GUI-ASSERT:no-owned-container-after-stop');
    server = await startServer({ appRoot, dataDir, log: () => {} });
    page = await ctx.newPage();
    await open(server.launchUrl);
    await page.click('#list li:has-text("Double It")');
    await page.waitForFunction(() => /draft restored/.test(document.getElementById('saveState').textContent), null, { timeout: 15000 });
    assert.equal(await page.inputValue('#editor'), WRONG, 'GUI-ASSERT:wrong-draft-reopens-not-silently-replaced');
    assert.match(await page.textContent('#list li.sel'), /^\[solved\]/i);

    step('explicit-load-accepted');
    await page.click('#loadAccepted');
    await page.waitForFunction(() => /Loaded accepted submission/.test(document.getElementById('acceptedInfo').textContent), null, { timeout: 15000 });
    assert.equal(await page.inputValue('#editor'), RIGHT, 'GUI-ASSERT:exact-accepted-source-loaded');
    assert.match(await page.textContent('#acceptedInfo'), new RegExp(sha(RIGHT).slice(0, 12)), 'GUI-ASSERT:source-hash-shown');
    assert.match(await page.textContent('#saveState'), /not saved yet/);
    const onDisk = await page.evaluate((key) => window.mecode.draft.load({ key, language: 'python' }).then((r) => r.value.source), KEY);
    assert.equal(onDisk, WRONG, 'GUI-ASSERT:saved-draft-still-wrong-until-user-saves');
    const stored = await page.evaluate((key) => window.mecode.solution.load({ key, language: 'python' }).then((r) => r.value), KEY);
    assert.equal(stored.solution.sourceHash, sha(RIGHT));
    assert.equal(stored.solution.source, RIGHT);
    assert.equal(stored.stale, false);
    assert.deepEqual(external, [], 'GUI-ASSERT:no-external-network-requests');
    console.log('GUI-ACCEPTED-FLOW-COMPLETE');
  } catch (e) {
    if (page && shots) {
      fs.mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, 'accepted-gui-failure.png') }).catch(() => {});
      const txt = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => '');
      fs.writeFileSync(path.join(shots, 'accepted-gui-failure.txt'), txt);
    }
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) {
      await server.stop().catch(() => {});
      assert.equal(ownedContainers(dataDir), '', 'GUI-ASSERT:no-owned-container-at-teardown');
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
});
