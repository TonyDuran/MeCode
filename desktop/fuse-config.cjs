const { FuseVersion, FuseV1Options: F } = require('@electron/fuses');

// F4: deliberately retain inherited GrantFileProtocolExtraPrivileges behavior
// in this correction. Disabling it needs independent real Electron file-origin
// persistence/navigation tests; see BRIDGE.md. No new fuse privilege is enabled.

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
