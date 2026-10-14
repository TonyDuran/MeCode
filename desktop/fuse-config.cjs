const { FuseVersion, FuseV1Options: F } = require('@electron/fuses');

module.exports = {
  version: FuseVersion.V1,
  // Linux can cross-package an unsigned arm64 app but cannot invoke macOS codesign.
  // The M1 owner must re-sign locally before attempting UAT; this is not release signing.
  resetAdHocDarwinSignature: false,
  [F.RunAsNode]: false,
  [F.EnableNodeOptionsEnvironmentVariable]: false,
  [F.EnableNodeCliInspectArguments]: false,
  [F.EnableEmbeddedAsarIntegrityValidation]: true,
  [F.OnlyLoadAppFromAsar]: true,
};
