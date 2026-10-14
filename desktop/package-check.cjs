// Self-authored by Talos. Packager 20.3.0 afterComplete hook (object argument).
// Inspect final build bytes; never load code from the produced ASAR.
const fs = require('node:fs');
const path = require('node:path');
const {readJudgeAssets} = require('./judge-assets.cjs');

async function verifyPackagedJudge({buildPath, platform}) {
  if (!path.isAbsolute(buildPath) || !['linux', 'darwin'].includes(platform)) {
    throw new Error('unsupported judge package layout');
  }
  const resources = platform === 'darwin'
    ? path.join(buildPath, 'MeCode.app', 'Contents', 'Resources')
    : path.join(buildPath, 'resources');
  const archive = path.join(resources, 'app.asar');
  const expected = fs.readFileSync(path.join(__dirname, 'judge-assets.cjs'));
  // Existing pinned Forge/packager toolchain dependency; not shipped at runtime.
  const asar = await import('@electron/asar');
  asar.uncache(archive);
  try {
    const entry = asar.statFile(archive, 'judge-assets.cjs', false);
    if (entry.link || entry.unpacked || entry.size !== expected.length
        || !asar.extractFile(archive, 'judge-assets.cjs', false).equals(expected)) {
      throw new Error('packaged judge manifest differs from reviewed app module');
    }
    readJudgeAssets(path.join(resources, 'judge'));
  } finally { asar.uncache(archive); }
}
module.exports = {verifyPackagedJudge};
