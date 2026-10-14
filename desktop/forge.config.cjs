const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const fuseConfig = require('./fuse-config.cjs');

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'MeCode',
    ignore: [
      /^\/test(?:\/|$)/,
      /^\/stage\.cjs$/,
      /^\/workspace\/.*(?:\.py|\.md)$/,
    ],
  },
  makers: [{ name: '@electron-forge/maker-zip', platforms: ['linux', 'darwin'] }],
  plugins: [new FusesPlugin(fuseConfig)],
};
