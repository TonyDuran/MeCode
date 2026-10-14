const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stageWorkspace } = require('../stage.cjs');

const EXPECTED = ['index.html', 'styles.css', 'app-styles.css', 'app.js',
                  'persistence.js', 'evidence.js', 'evidence-contract.js'];

test('stage fails before writing if a renderer asset disagrees with the inventory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mecode-stage-integrity-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    const real = path.resolve(__dirname, '..', '..', 'prototypes', 'trusted-workspace');
    for (const name of [...EXPECTED, 'ARTIFACT-SHA256.txt']) {
      fs.copyFileSync(path.join(real, name), path.join(source, name));
    }
    fs.appendFileSync(path.join(source, 'app.js'), '\n// drift\n');
    const out = path.join(root, 'workspace');
    assert.throws(() => stageWorkspace(out, source), /digest mismatch/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stage copies only the generated offline renderer allowlist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mecode-stage-test-'));
  try {
    const out = path.join(root, 'workspace');
    stageWorkspace(out);
    assert.deepEqual(fs.readdirSync(out).sort(), EXPECTED.slice().sort());
    for (const name of EXPECTED) {
      const source = path.resolve(__dirname, '..', '..', 'prototypes', 'trusted-workspace', name);
      assert.deepEqual(fs.readFileSync(path.join(out, name)), fs.readFileSync(source), name);
    }
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /id="fixture-evidence"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
