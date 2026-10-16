'use strict';
// Builds the cross-platform LOCAL WEB distribution (not Electron): for linux / windows / macos, a deterministic .tar.gz and .zip each,
// containing the real app source + launcher + packs + engine recipe/runtime code + docs + unit/integration tests, with a MANIFEST.json
// (exact source revision/tree, per-file sha256 and mode) and a SHA256SUMS file next to the archives.
// Output: dist/platform/*. Local artifacts only: NOTHING is uploaded or published by this script.
// Usage: node scripts/package-platforms.cjs
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { makeTarGz, makeZip } = require('./lib/archive.cjs');

const root = path.join(__dirname, '..');
const git = (...a) => cp.execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rev = git('rev-parse', 'HEAD');
const tree = git('rev-parse', 'HEAD^{tree}');
const commitTime = Number(git('show', '-s', '--format=%ct', 'HEAD'));
const dirty = git('status', '--porcelain', '--', '.', ':!dist', ':!logs', ':!node_modules', ':!test-results').length > 0;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Explicit allowlist (tracked files only, so local junk can never leak into an archive).
const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
const include = (f) =>
  f !== 'tests/unit/t13-archive-verify.test.cjs' &&
  f !== 'tests/unit/t18-catalog-gate.test.cjs' &&
  f !== 'tests/unit/t27-provision.test.cjs' && // dev-only: fake-docker (POSIX) mock test of the shipped provisioning script
  f !== 'tests/unit/t29-launcher-stop.test.cjs' && // dev-only: needs scripts/lib (not shipped)
  f !== 'tests/unit/t29-wrong-baseline.test.cjs' && // dev-only: needs catalog-dev (not shipped)
  f !== 'tests/unit/t31-archive-policy.test.cjs' && // dev-only: needs scripts/lib and .github (not shipped)
  f !== 'tests/integration/catalog-cleanup.test.cjs' && // dev-only: needs the full source checkout (scripts/catalog-docker-accept.cjs), never shipped
  (['README.md', 'package.json', 'scripts/make-demo-pack.cjs', 'scripts/provision-engine.cjs'].includes(f) || /^(src|engine|packs|docs)\//.test(f) || /^tests\/(unit|integration)\//.test(f)); // build-tool tests need scripts/lib, which is not shipped
const common = tracked.filter(include).sort();

const IS_WIN = { linux: false, macos: false, windows: true };
const lines = (s, crlf) => {
  const t = s.replaceAll('@NODE@', pkg.engines.node);
  return Buffer.from(crlf ? t.replace(/\n/g, '\r\n') : t, 'utf8');
};

const NODE_CHECK = `node -e "process.exit(process.versions.node==='@NODE@'?0:1)"`;
const launchers = {
  linux: {
    'start.sh': [
      '#!/bin/sh',
      'set -eu',
      'cd "$(dirname "$0")"',
      'command -v node >/dev/null 2>&1 || { echo "Node.js @NODE@ is required (https://nodejs.org)."; exit 1; }',
      `${NODE_CHECK} || echo "WARNING: MeCode is validated only with Node.js @NODE@; found $(node --version), which is unverified. Continuing."`,
      'command -v docker >/dev/null 2>&1 || echo "WARNING: docker not found. The UI will start but Run stays disabled until Docker is installed and running."',
      'IMG="${MECODE_ENGINE_IMAGE:-mecode-engine:v2}"',
      'docker image inspect "$IMG" >/dev/null 2>&1 || echo "NOTE: engine image $IMG not found locally. Import a verified local export: node scripts/provision-engine.cjs import --manifest <path-to>/manifest.json (or build it ONLINE once with ./build-engine.sh). See docs/OFFLINE.md."',
      'exec node src/web/server.cjs',
      '',
    ].join('\n'),
    'build-engine.sh': [
      '#!/bin/sh',
      'set -eu',
      'cd "$(dirname "$0")"',
      'command -v docker >/dev/null 2>&1 || { echo "Docker is required (see INSTALL.md)."; exit 1; }',
      'docker build -t mecode-engine:v2 engine/',
      'echo "engine image mecode-engine:v2 built"',
      '',
    ].join('\n'),
  },
  macos: {
    'start.command': [
      '#!/bin/sh',
      'set -eu',
      'cd "$(dirname "$0")"',
      'command -v node >/dev/null 2>&1 || { echo "Node.js @NODE@ is required (https://nodejs.org)."; exit 1; }',
      `${NODE_CHECK} || echo "WARNING: MeCode is validated only with Node.js @NODE@; found $(node --version), which is unverified. Continuing."`,
      'command -v docker >/dev/null 2>&1 || echo "WARNING: docker not found. Install Docker Desktop and start it; Run stays disabled until the engine is ready."',
      'IMG="${MECODE_ENGINE_IMAGE:-mecode-engine:v2}"',
      'docker image inspect "$IMG" >/dev/null 2>&1 || echo "NOTE: engine image $IMG not found locally. Import a verified local export: node scripts/provision-engine.cjs import --manifest <path-to>/manifest.json (or build it ONLINE once with ./build-engine.command). See docs/OFFLINE.md."',
      'exec node src/web/server.cjs',
      '',
    ].join('\n'),
    'build-engine.command': [
      '#!/bin/sh',
      'set -eu',
      'cd "$(dirname "$0")"',
      'command -v docker >/dev/null 2>&1 || { echo "Docker Desktop is required (see INSTALL.md)."; exit 1; }',
      'docker build -t mecode-engine:v2 engine/',
      'echo "engine image mecode-engine:v2 built"',
      '',
    ].join('\n'),
  },
  windows: {
    'start.cmd': [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'where node >nul 2>nul || (echo Node.js @NODE@ is required: https://nodejs.org & exit /b 1)',
      `${NODE_CHECK} || echo WARNING: MeCode is validated only with Node.js @NODE@; this Node.js version is unverified. Continuing.`,
      'where docker >nul 2>nul || echo WARNING: docker not found. The UI will start but Run stays disabled until Docker Desktop is installed and running.',
      'set "IMG=mecode-engine:v2"',
      'if defined MECODE_ENGINE_IMAGE set "IMG=%MECODE_ENGINE_IMAGE%"',
      'docker image inspect "%IMG%" >nul 2>nul || echo NOTE: engine image %IMG% not found locally. Import a verified local export: node scripts\\provision-engine.cjs import --manifest path\\to\\manifest.json - or build it ONLINE once with build-engine.cmd. See docs\\OFFLINE.md.',
      'node src\\web\\server.cjs',
      '',
    ].join('\n'),
    'build-engine.cmd': [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'where docker >nul 2>nul || (echo Docker Desktop is required, see INSTALL.md & exit /b 1)',
      'docker build -t mecode-engine:v2 engine/ || exit /b 1',
      'echo engine image mecode-engine:v2 built',
      '',
    ].join('\n'),
  },
};

const startName = { linux: 'start.sh', macos: 'start.command', windows: 'start.cmd' };
const buildName = { linux: 'build-engine.sh', macos: 'build-engine.command', windows: 'build-engine.cmd' };
const prereq = {
  linux:
    'Install Node.js @NODE@ (the only validated version; other versions, including older ones, are unverified) and Docker Engine (rootless or rootful; the user running MeCode must be able to run `docker`).',
  macos:
    'Install Node.js @NODE@ (the only validated version; other versions, including older ones, are unverified) and Docker Desktop (manual install, then start it). Apple Silicon: the engine image is built locally from engine/Dockerfile for your architecture; that path is UNTESTED here.',
  windows:
    'Install Node.js @NODE@ (the only validated version; other versions, including older ones, are unverified) and Docker Desktop with the Linux-container (WSL2) backend (manual install, then start it).',
};
const installMd = (os) => `# MeCode V2 local web distribution (${os})

This is the **local web** build (a Node server on 127.0.0.1 + your browser). It is not an Electron app.

## Prerequisites (install manually; MeCode never installs software)

${prereq[os]}

## First run

1. Verify the archive: compare its SHA-256 with \`SHA256SUMS\` (published next to the archive) and \`MANIFEST.json\` in this folder.
2. Build the engine image once (needs a network you are allowed to use; the app itself never downloads anything):
   \`${buildName[os]}\`
3. Start: \`${startName[os]}\` - then open the **launch link** it prints (it contains a per-launch secret in the \`#\` fragment; do not share it).
${os === 'macos' ? '   If Gatekeeper blocks the script, open it via right-click > Open (the files are unsigned/not notarized); do not disable system protection globally.\n' : ''}${os === 'windows' ? '   Windows SmartScreen may warn for unsigned scripts; choose to run it only if you trust this archive.\n' : ''}
## Offline use

After the engine image exists, nothing needs the network. Moving it to another machine of the SAME OS/architecture (a Linux amd64 export is not an Apple Silicon or arm64 image):

- there: \`node scripts/provision-engine.cjs export --image mecode-engine:v2 --alias mecode-engine:<your-name> --out <new-empty-dir>\` writes engine.tar, manifest.json (image ID, platform, size, SHA-256) and SHA256SUMS;
- here: \`node scripts/provision-engine.cjs import --manifest <dir>/manifest.json\` verifies size and SHA-256 BEFORE \`docker load\`, then start with \`MECODE_ENGINE_IMAGE=mecode-engine:<your-name>\` and press Retry.

The checksum detects damage only; it does not authenticate who made the archive. Import trusted bundles only. Building natively (\`build-engine\` launcher) needs the network (apt-get) unless every layer is already cached. See \`docs/OFFLINE.md\`.

## Verification status (honest)

Only Linux x64 + Docker has been exercised end-to-end (unit tests, real containers, real browser). The Windows and macOS archives are checked for structure and launcher start-up only; their Docker/engine path is untested.
Archives are unsigned. See \`README.md\` for details and \`docs/DEVELOPMENT.md\` for the problem-pack format.
`;

function build(os) {
  const top = `mecode-v2-${rev.slice(0, 12)}-${os}`;
  const files = new Map();
  for (const f of common) files.set(f, { data: fs.readFileSync(path.join(root, f)), mode: 0o644 });
  files.set('INSTALL.md', { data: lines(installMd(os), IS_WIN[os]), mode: 0o644 });
  for (const [name, text] of Object.entries(launchers[os])) files.set(name, { data: lines(text, IS_WIN[os]), mode: IS_WIN[os] ? 0o644 : 0o755 });
  const manifest = {
    name: 'mecode-v2-web',
    kind: 'local web distribution (Node stdlib server on 127.0.0.1 + browser; NOT Electron)',
    targetOs: os,
    version: pkg.version,
    sourceRevision: rev,
    sourceTree: tree,
    sourceDirty: dirty,
    commitTimeUnix: commitTime,
    requires: {
      node: pkg.engines.node + ' (the only validated version; other versions, including older ones, are unverified)',
      docker: 'Docker Engine/Desktop with Linux containers; engine image built locally from engine/Dockerfile',
    },
    engineImage: {
      tag: 'mecode-engine:v2',
      recipe: 'engine/Dockerfile',
      note: 'built locally by the user, or imported from a local export with scripts/provision-engine.cjs (docs/OFFLINE.md); not shipped inside this archive',
    },
    launcher: { start: startName[os], buildEngine: buildName[os] },
    signed: false,
    files: Object.fromEntries([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, f]) => [n, { sha256: sha256(f.data), mode: f.mode.toString(8) }])),
  };
  files.set('MANIFEST.json', { data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o644 });
  const names = [...files.keys()].sort();
  const dirs = new Set();
  for (const n of names) {
    const parts = n.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  /** @type {any[]} */
  const entries = [{ name: top, dir: true, mode: 0o755 }];
  for (const d of [...dirs].sort()) entries.push({ name: `${top}/${d}`, dir: true, mode: 0o755 });
  const all = [...entries];
  for (const n of names) all.push({ name: `${top}/${n}`, data: files.get(n).data, mode: files.get(n).mode });
  all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { top, all, fileCount: names.length };
}

const outDir = path.join(root, 'dist', 'platform');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const sums = [];
const report = [];
for (const os of ['linux', 'macos', 'windows']) {
  const { top, all, fileCount } = build(os);
  for (const [ext, make] of /** @type {[string, (e: any[], t: number) => Buffer][]} */ ([
    ['tar.gz', makeTarGz],
    ['zip', makeZip],
  ])) {
    const file = `${top}.${ext}`;
    const buf = make(all, commitTime);
    fs.writeFileSync(path.join(outDir, file), buf);
    sums.push(`${sha256(buf)}  ${file}`);
    report.push({ file, bytes: buf.length, sha256: sha256(buf), files: fileCount });
  }
}
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
console.log(JSON.stringify({ sourceRevision: rev, sourceTree: tree, sourceDirty: dirty, archives: report }, null, 2));
