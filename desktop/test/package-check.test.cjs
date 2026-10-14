// Self-authored Talos build-contract tests. Real tiny ASAR fixtures, not a
// runnable Electron bundle. No install, download, Electron or Python execution.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {stageJudge} = require('../stage.cjs');
const desktop = path.resolve(__dirname, '..');
function hook() {
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(desktop, 'forge.config.cjs'), 'utf8'), {
    module, __dirname: desktop,
    require(name) {
      if (name === '@electron-forge/plugin-fuses') return {FusesPlugin: class {}};
      if (name === './fuse-config.cjs') return {};
      if (name === 'node:path') return path;
      return require(path.join(desktop, name));
    },
  });
  assert.equal(module.exports.packagerConfig.afterComplete?.length, 1,
    'packaging must verify final resources and app-bound manifest');
  return module.exports.packagerConfig.afterComplete[0];
}
async function fixture(t, platform, mutation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-package-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const buildPath = path.join(root, 'build');
  const resources = platform === 'darwin' ? path.join(buildPath, 'MeCode.app', 'Contents', 'Resources')
    : path.join(buildPath, 'resources');
  fs.mkdirSync(resources, {recursive: true});
  const source = path.join(root, 'app'); fs.mkdirSync(source);
  fs.copyFileSync(path.join(desktop, 'judge-assets.cjs'), path.join(source, 'judge-assets.cjs'));
  stageJudge(path.join(resources, 'judge'));
  if (mutation) mutation({source, resources});
  const asar = await import('@electron/asar');
  await asar.createPackage(source, path.join(resources, 'app.asar'));
  return {buildPath, platform, arch: platform === 'darwin' ? 'arm64' : 'x64', electronVersion: '44.7.2'};
}
for (const platform of ['linux', 'darwin']) test(`final ${platform} resource-layout hook verifies actual ASAR pins and sidecars`, async t => {
  const verify = hook();
  await verify(await fixture(t, platform));
});
for (const [name, mutation] of Object.entries({
  changed_manifest: ({source}) => fs.appendFileSync(path.join(source, 'judge-assets.cjs'), '// drift'),
  missing_manifest: ({source}) => fs.unlinkSync(path.join(source, 'judge-assets.cjs')),
  extra_sidecar: ({resources}) => fs.writeFileSync(path.join(resources, 'judge', 'uuid.py'), '# not executed'),
  missing_sidecar: ({resources}) => fs.unlinkSync(path.join(resources, 'judge', 'controller.py')),
  changed_sidecar: ({resources}) => fs.appendFileSync(path.join(resources, 'judge', 'controller.py'), '# drift'),
})) test(`package hook rejects ${name}`, async t => {
  const verify = hook();
  await assert.rejects(verify(await fixture(t, 'linux', mutation)));
});
