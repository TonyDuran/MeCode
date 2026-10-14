const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FuseVersion, FuseV1Options: F } = require('@electron/fuses');

test('package fuses disable Node escape hatches and require asar integrity', () => {
  const settings = require('../fuse-config.cjs');
  assert.equal(settings.version, FuseVersion.V1);
  assert.equal(settings[F.RunAsNode], false);
  assert.equal(settings[F.EnableNodeOptionsEnvironmentVariable], false);
  assert.equal(settings[F.EnableNodeCliInspectArguments], false);
  assert.equal(settings[F.EnableEmbeddedAsarIntegrityValidation], true);
  assert.equal(settings[F.OnlyLoadAppFromAsar], true);
  const forge = require('../forge.config.cjs');
  assert.equal(forge.plugins.length, 1);
});
