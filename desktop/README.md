# MeCode desktop prototype

This is an **offline Electron shell** around the generated trusted-workspace preview. It preserves the draft editor, local save/reopen, and recorded fixture inspection; **Run/Submit do not judge edited code**. The experimental Docker judge lives in another prototype and is not connected here. No service or localhost port is required for this shell.

## Build and run

From `desktop/` with a current Node/npm installation:

```sh
npm ci
npm test
npm run stage
npm start
npm run make
```

`stage.cjs` copies an exact allowlist of seven generated static renderer files from `prototypes/trusted-workspace/` into ignored `desktop/workspace/`. Re-stage after changing the workspace. Do not edit the staged files. `npm run make` creates a platform-specific ZIP under `desktop/out/make/`; it includes Electron, so the recipient does not need a separate Electron or Node install. The Linux x64 and macOS arm64 packages can be generated on this Linux host, but **the macOS package is unsigned, unnotarized and not runtime-tested on an M1 Mac**. Fuse flipping invalidates the upstream arm64 framework's ad-hoc code signature: **the extracted app will refuse to launch on Apple Silicon until it is locally re-signed**; “Open Anyway” alone cannot repair that signature. For owner-controlled UAT only, after extracting the ZIP on a Mac, run `codesign --force --deep --sign - MeCode.app` and verify the signature before launching; this does not sign or notarize a distribution. The ASAR-integrity fuse protects the macOS package; on Linux it is not enforced, although ASAR-only loading remains enforced and the Node escape hatches remain disabled. This is a PoC artifact, not a public release.

## Boundary

The renderer loads only the bundled `index.html`: Node integration off, context isolation on, renderer sandbox on, no preload/IPC bridge, popups and non-document navigation denied, permissions denied. The generated HTML CSP disallows network connections. The desktop package deliberately contains only the allowlisted renderer assets, not Python test fixtures, host state, Docker socket, or judge controller. IndexedDB remains browser-owned; its existing error/corruption behavior is displayed by the workspace.

**Linux host validation gap:** Packaging and Node tests passed, but launching the GUI on this host failed before a window appeared: Electron reported an unconfigured setuid sandbox helper (`chrome-sandbox` owned by the unprivileged user, mode 755). A direct unprivileged user-namespace probe also failed `uid_map: Operation not permitted`. We did **not** retry with `--no-sandbox`, alter the host, or claim runtime verification. A sandbox-preserving GUI run and Apple Silicon owner UAT remain outstanding.
