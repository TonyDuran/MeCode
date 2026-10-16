'use strict';
// Builds the local-web distribution: dist/mecode-v2-web-<rev>.tar.gz + MANIFEST.json (source identity + file hashes).
// Local artifact only (no upload). Run from a clean committed tree for an exact identity: node scripts/package-web.cjs
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const root = path.join(__dirname, '..');
const git = (...a) => cp.execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const rev = git('rev-parse', 'HEAD');
const tree = git('rev-parse', 'HEAD^{tree}');
const dirty = git('status', '--porcelain', '--', '.', ':!dist', ':!logs').length > 0;
const name = `mecode-v2-web-${rev.slice(0, 12)}`;
const stage = path.join(root, 'dist', name);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const include = ['README.md', 'package.json', 'src', 'engine', 'packs', 'docs', 'scripts/make-demo-pack.cjs', 'tests'];
const files = [];
const walk = (rel) => {
  const abs = path.join(root, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(abs).sort()) if (f !== '__pycache__') walk(path.join(rel, f));
    return;
  }
  files.push(rel);
};
include.forEach(walk);
const hashes = {};
for (const rel of files) {
  const dst = path.join(stage, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(root, rel), dst);
  fs.chmodSync(dst, 0o644);
  hashes[rel] = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(root, rel)))
    .digest('hex');
}
let imageId = null;
try {
  imageId = cp.execFileSync('docker', ['image', 'inspect', 'mecode-engine:v2', '--format', '{{.Id}}'], { encoding: 'utf8', timeout: 10000 }).trim();
} catch {
  /* image not present */
}
const manifest = {
  name: 'mecode-v2-web',
  kind: 'local web distribution (Node stdlib server; NOT Electron)',
  sourceRevision: rev,
  sourceTree: tree,
  workingTreeDirty: dirty,
  engineImage: {
    tag: 'mecode-engine:v2',
    idAtPackageTime: imageId,
    dockerfileBase: 'python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170',
    note: 'image is built locally from engine/Dockerfile; it is not shipped in this archive',
  },
  node: process.version,
  platformsTested: ['linux-x64 (local web + real Docker)'],
  platformsUntested: ['windows', 'macos', 'electron wrapper'],
  files: hashes,
};
fs.writeFileSync(path.join(stage, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const out = path.join(root, 'dist', `${name}.tar.gz`);
// deterministic archive: sorted names, fixed mtime/owner, gzip without name/timestamp
const tarCmd = `tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - -C dist ${name} | gzip -n -9 > ${out}`;
cp.execSync(tarCmd, { cwd: root, shell: '/bin/bash' });
const sha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
fs.writeFileSync(`${out}.sha256`, `${sha}  ${path.basename(out)}\n`);
console.log(JSON.stringify({ archive: out, sha256: sha, sourceRevision: rev, sourceTree: tree, workingTreeDirty: dirty, engineImageId: imageId, fileCount: files.length }, null, 2));
