const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { stageJudge } = require('../stage.cjs');
const { ignoreAppPath } = require('../package-assets.cjs');
const { verifyPackagedJudge } = require('../package-check.cjs');

const EXPECTED = ['bridge_cli.py', 'controller.py', 'edited_runner.py'];

test('judge stage replaces stale files and copies only three trusted Python assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mecode-judge-assets-'));
  try {
    const out = path.join(root, 'judge');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'test_fixture.py'), 'must not ship');
    stageJudge(out);
    assert.deepEqual(fs.readdirSync(out).sort(), EXPECTED);
    for (const name of EXPECTED) {
      assert.deepEqual(fs.readFileSync(path.join(out, name)),
        fs.readFileSync(path.resolve(__dirname, '../../prototypes/docker-engine', name)));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('app packaging is an allowlist, not an expanding test/fixture denylist', () => {
  for (const name of ['', '/', '/package.json', '/main.cjs', '/security.cjs', '/preload.cjs',
    '/judge-bridge.cjs', '/judge-assets.cjs', '/modal.cjs', '/prompt.html', '/prompt-preload.cjs',
    '/workspace', '/workspace/index.html', '/workspace/app.js', '/workspace/run-ui.js']) {
    assert.equal(ignoreAppPath(name), false, name);
  }
  for (const name of ['/test', '/test/main.test.cjs', '/judge', '/judge/controller.py',
    '/bridge_cli.py', '/fixture-evidence.json', '/workspace/fixture-evidence.json',
    '/workspace/test.py', '/workspace/unexpected.js', '/workspace/subdir', '/.env',
    '/package-lock.json', '/stage.cjs', '/package-check.cjs', '/node_modules', '/README.md']) {
    assert.equal(ignoreAppPath(name), true, name);
  }
});

test('Forge config wires the app allowlist and only the staged judge resource (plugin mock)', () => {
  const dirname = path.resolve(__dirname, '..');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(dirname, 'forge.config.cjs'), 'utf8'), {
    module, __dirname: dirname,
    require(name) {
      if (name === '@electron-forge/plugin-fuses') return { FusesPlugin: class {} };
      if (name === './fuse-config.cjs') return {};
      if (name === 'node:path') return path;
      if (name === './package-assets.cjs') return { ignoreAppPath };
      if (name === './package-check.cjs') return { verifyPackagedJudge };
      assert.fail(`unexpected config import: ${name}`);
    },
  });
  assert.equal(module.exports.packagerConfig.ignore, ignoreAppPath);
  assert.deepEqual(Array.from(module.exports.packagerConfig.extraResource), [path.join(dirname, 'judge')]);
  assert.equal(module.exports.packagerConfig.asar, true);
  assert.deepEqual(Array.from(module.exports.packagerConfig.afterComplete), [verifyPackagedJudge]);
});
