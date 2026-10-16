'use strict';
// Project-local Linux x64 package from the CACHED Electron zip. No network, no npm install.
// Usage: node scripts/package.cjs [--electron-zip PATH]
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const arg = process.argv.indexOf('--electron-zip');
const cacheRoot = path.join(process.env.HOME, '.cache', 'electron');
function findZip() {
  if (arg > 0) return process.argv[arg + 1];
  for (const d of fs.readdirSync(cacheRoot)) { const p = path.join(cacheRoot, d, 'electron-v44.7.2-linux-x64.zip'); if (fs.existsSync(p)) return p; }
  throw new Error('cached electron-v44.7.2-linux-x64.zip not found');
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const zip = findZip();
const out = path.join(root, 'dist', 'mecode-v2-linux-x64');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
cp.execFileSync('unzip', ['-q', zip, '-d', out], { stdio: 'inherit' });
fs.renameSync(path.join(out, 'electron'), path.join(out, 'mecode-v2'));
const app = path.join(out, 'resources', 'app');
fs.mkdirSync(app, { recursive: true });
for (const item of ['package.json', 'src', 'packs', 'engine']) fs.cpSync(path.join(root, item), path.join(app, item), { recursive: true, filter: (s) => !s.includes('__pycache__') });
const manifest = { electronZip: path.basename(zip), electronZipSha256: sha(zip), builtAt: new Date().toISOString(), node: process.version };
fs.writeFileSync(path.join(out, 'PACKAGE-MANIFEST.json'), JSON.stringify(manifest, null, 2));
// deterministic tarball of the unpacked dir
const tar = path.join(root, 'dist', 'mecode-v2-linux-x64.tar.gz');
cp.execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', tar, '-C', path.join(root, 'dist'), 'mecode-v2-linux-x64']);
console.log(JSON.stringify({ ...manifest, tar, tarSha256: sha(tar) }, null, 2));
