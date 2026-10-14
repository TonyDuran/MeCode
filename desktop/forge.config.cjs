const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const fuseConfig = require('./fuse-config.cjs');
const path = require('node:path');
const { ignoreAppPath } = require('./package-assets.cjs');
const { verifyPackagedJudge } = require('./package-check.cjs');

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'MeCode',
    ignore: ignoreAppPath,
    // Python cannot import from app.asar. Copy only stageJudge's three files.
    extraResource: [path.join(__dirname, 'judge')],
    afterComplete: [verifyPackagedJudge],
  },
  makers: [{ name: '@electron-forge/maker-zip', platforms: ['linux', 'darwin'] }],
  plugins: [new FusesPlugin(fuseConfig)],
};
