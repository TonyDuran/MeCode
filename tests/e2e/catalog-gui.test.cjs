'use strict';
/* global document -- referenced only inside page.waitForFunction/evaluate callbacks, which run in the browser */
// Real-browser GUI E2E of the 48-problem catalog against the REAL server + REAL Docker engine (no mocks).
// Fresh app data -> the bundled catalog is seeded (no import) -> browse/search/filter by the NEW patterns -> open new problems ->
//   honest starter fails -> correct Python / C++ / JavaScript solutions are ACCEPTED -> Save -> restart -> state restored, counts truthful.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { repoRoot, startServer, ownedContainers, tmpDir } = require('./harness.cjs');

const appRoot = process.env.MECODE_E2E_APP_ROOT || repoRoot;
const shots = process.env.MECODE_E2E_SHOTS || null;
const step = (/** @type {string} */ name) => console.log(`GUI-STEP ${name}`);
const sol = (/** @type {string} */ f) => fs.readFileSync(path.join(repoRoot, 'catalog-dev', 'solutions', f), 'utf8');
const ROPE_PY =
  'import heapq\nn = int(input())\nh = list(map(int, input().split()))\nheapq.heapify(h)\ncost = 0\nwhile len(h) > 1:\n    a = heapq.heappop(h)\n    b = heapq.heappop(h)\n    cost += a + b\n    heapq.heappush(h, a + b)\nprint(cost)\n';

test('GUI catalog: browse 48 problems / 18 patterns, filter, solve new problems in Python + C++ + JavaScript, restart', { timeout: 300000 }, async () => {
  const work = tmpDir('mecode-catgui-');
  const dataDir = path.join(work, 'data');
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
    const ctx = await browser.newContext({ acceptDownloads: false });
    page = await ctx.newPage();
    const external = [];
    ctx.on('request', (r) => {
      if (!/^(http:\/\/127\.0\.0\.1:\d+\/|about:|data:|blob:)/.test(r.url())) external.push(r.url());
    });
    const open = async (/** @type {string} */ url) => {
      await page.goto(url);
      await page.waitForFunction(() => /backend: ready/.test(document.getElementById('backend').textContent), null, { timeout: 90000 });
    };
    const summary = () => page.textContent('#catalogSummary');
    const count = () => page.locator('#list li').count();
    const submit = async (/** @type {string} */ title, /** @type {string} */ lang, /** @type {string | null} */ source) => {
      await page.click(`#list li:has-text("${title}")`);
      await page.waitForFunction((t) => document.getElementById('title').textContent === t, title);
      await page.selectOption('#lang', lang);
      await page.waitForFunction(() => !document.getElementById('editor').disabled);
      if (source !== null) await page.fill('#editor', source);
      const before = await page.textContent('#verdict');
      await page.click('#submit');
      await page.waitForFunction((b) => /^submit: [A-Z_]+/.test(document.getElementById('verdict').textContent) && document.getElementById('verdict').textContent !== b, before, { timeout: 120000 });
      return page.textContent('#verdict');
    };

    step('open-fresh-install-seeded-catalog');
    await open(server.launchUrl);
    assert.equal(await count(), 48, 'GUI-ASSERT:48-problems-listed-on-fresh-install');
    assert.match(await summary(), /Showing 48 of 48 problems · 18 patterns · 0 solved/, 'GUI-ASSERT:truthful-catalog-summary');
    const patterns = await page.$$eval('#patternFilter option', (os) => os.map((o) => o.value).filter(Boolean));
    assert.equal(patterns.length, 18, 'GUI-ASSERT:18-pattern-options');
    for (const p of ['tries', 'advanced-graphs', 'bit-manipulation', 'math-geometry', 'intervals', 'dp-2d', 'heap']) assert.ok(patterns.includes(p), `GUI-ASSERT:pattern-${p}`);

    step('filter-by-new-patterns');
    await page.selectOption('#patternFilter', 'tries');
    assert.equal(await count(), 2, 'GUI-ASSERT:tries-has-2');
    assert.match(await summary(), /Showing 2 of 48/);
    await page.selectOption('#diffFilter', 'hard');
    assert.equal(await count(), 1, 'GUI-ASSERT:tries+hard=1');
    assert.match(await page.textContent('#list li'), /Wildcard Lexicon/);
    await page.selectOption('#diffFilter', '');
    await page.selectOption('#patternFilter', 'heap');
    assert.equal(await count(), 3);
    await page.selectOption('#patternFilter', '');
    await page.fill('#search', 'shelf');
    assert.equal(await count(), 1, 'GUI-ASSERT:search-by-title');
    await page.fill('#search', 'bit-manip');
    assert.equal(await count(), 2, 'GUI-ASSERT:search-by-pattern');
    await page.fill('#search', '');
    assert.equal(await count(), 48);

    step('new-problem-heap-honest-starter-then-accepted-python');
    await page.selectOption('#patternFilter', 'heap');
    const starter = await submit('Rope Splicer', 'python', null);
    assert.ok(starter.includes('WRONG_ANSWER'), `GUI-ASSERT:starter-is-not-a-solution (${starter})`);
    const acc = await submit('Rope Splicer', 'python', ROPE_PY);
    assert.ok(acc.includes('ACCEPTED'), `GUI-ASSERT:python-accepted (${acc})`);
    await page.click('#save');
    await page.waitForFunction(() => /^saved/.test(document.getElementById('saveState').textContent), null, { timeout: 15000 });

    step('new-problem-tries-accepted-cpp');
    await page.selectOption('#patternFilter', 'tries');
    const cpp = await submit('Prefix Directory', 'cpp', sol('prefix-directory.cpp'));
    assert.ok(cpp.includes('ACCEPTED'), `GUI-ASSERT:cpp-accepted (${cpp})`);
    await page.click('#save');
    await page.waitForFunction(() => /^saved/.test(document.getElementById('saveState').textContent), null, { timeout: 15000 });

    step('new-problem-bit-manipulation-accepted-javascript');
    await page.selectOption('#patternFilter', 'bit-manipulation');
    const js = await submit('Lone Signal', 'javascript', sol('lone-signal.cjs'));
    assert.ok(js.includes('ACCEPTED'), `GUI-ASSERT:javascript-accepted (${js})`);
    await page.click('#save');
    await page.waitForFunction(() => /^saved/.test(document.getElementById('saveState').textContent), null, { timeout: 15000 });
    await page.selectOption('#patternFilter', '');
    assert.match(await summary(), /Showing 48 of 48 problems · 18 patterns · 3 solved/, 'GUI-ASSERT:three-solved-truthful');

    step('restart-and-reopen');
    await page.close();
    await server.stop();
    assert.equal(ownedContainers(dataDir), '', 'GUI-ASSERT:no-owned-container-after-server-stop');
    server = await startServer({ appRoot, dataDir, log: console.log });
    page = await ctx.newPage();
    await open(server.launchUrl);
    assert.equal(await count(), 48, 'GUI-ASSERT:no-reseed-or-loss-after-restart');
    assert.match(await summary(), /3 solved/, 'GUI-ASSERT:progress-survives-restart');
    await page.selectOption('#statusFilter', 'solved');
    assert.equal(await count(), 3, 'GUI-ASSERT:status-filter-solved');
    await page.click('#list li:has-text("Prefix Directory")');
    await page.waitForFunction(() => document.getElementById('title').textContent === 'Prefix Directory');
    await page.selectOption('#lang', 'cpp');
    await page.waitForFunction((s) => /** @type {HTMLTextAreaElement} */ (document.getElementById('editor')).value === s, sol('prefix-directory.cpp'), { timeout: 15000 });
    assert.equal(await page.inputValue('#editor'), sol('prefix-directory.cpp'), 'GUI-ASSERT:draft-restored');
    assert.deepEqual(external, [], 'GUI-ASSERT:no-external-network-requests');
    console.log('GUI-CATALOG-FLOW-COMPLETE');
  } catch (e) {
    if (page && shots) {
      fs.mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, 'gui-catalog-failure.png') }).catch(() => {});
      const txt = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => '');
      fs.writeFileSync(path.join(shots, 'gui-catalog-failure.txt'), txt);
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
