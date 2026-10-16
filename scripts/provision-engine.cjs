#!/usr/bin/env node
'use strict';
// Local-only engine export/import. Node stdlib only. Never pulls, pushes, uploads, prunes or deletes an image ID.
//   node scripts/provision-engine.cjs export --image <local-ref> --alias mecode-engine:<name> --out <new-directory>
//   node scripts/provision-engine.cjs import --manifest <path/to/manifest.json>
// Integrity only: a SHA-256 in a manifest next to the archive proves the file was not damaged, NOT who made it. Import trusted bundles only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const ALIAS_RE = /^mecode-engine:[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/;
const ID_RE = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ARCHIVE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.tar$/;
const PROTECTED_TAG = 'mecode-engine:v2'; // the shared original: never an export alias and never created/replaced by import
const MAX_MANIFEST = 64 * 1024;
const SAVE_TIMEOUT_MS = 15 * 60 * 1000;

class CliError extends Error {}
const fail = (m) => {
  throw new CliError(m);
};

/** bounded docker call: argv only (no shell), timeout, output cap */
function docker(args, timeout = 60000) {
  const r = cp.spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.error ? -1 : r.status, stdout: r.stdout || '', stderr: ((r.stderr || '') + (r.error ? String(r.error.message) : '')).trim().slice(0, 400) };
}
const inspect = (ref) => {
  const r = docker(['image', 'inspect', ref, '--format', '{{.Id}}|{{.Os}}|{{.Architecture}}|{{.Variant}}'], 20000);
  if (r.code !== 0) return null;
  const [id, os, architecture, variant] = r.stdout.trim().split('|');
  return { id, os, architecture, variant: variant || '' };
};

function parseOpts(argv, allowed) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k || !k.startsWith('--') || !allowed.includes(k.slice(2))) fail(`unexpected option ${String(k).slice(0, 40)}`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) fail(`${k} needs a value`);
    if (Object.hasOwn(o, k.slice(2))) fail(`${k} given twice`);
    o[k.slice(2)] = argv[i + 1];
  }
  for (const a of allowed) if (!o[a]) fail(`--${a} is required`);
  return o;
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    let bytes = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, n));
      bytes += n;
    }
    return { sha256: h.digest('hex'), bytes };
  } finally {
    fs.closeSync(fd);
  }
}
function regularFile(file, what) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    fail(`${what} not found`);
  }
  if (!st.isFile()) fail(`${what} must be a regular file (symlinks and special files are refused)`);
  return st;
}

/** hash of the engine recipe files (provenance pointer ONLY; it does not prove the image was built from them) */
function recipeHash(appRoot) {
  const dir = path.join(appRoot, 'engine');
  const h = crypto.createHash('sha256');
  const names = ['Dockerfile', 'adapters.py', 'runner.py'];
  for (const n of names) {
    const f = path.join(dir, n);
    if (!fs.existsSync(f)) return null;
    h.update(`${n}\0`).update(fs.readFileSync(f)).update('\0');
  }
  return { files: names.map((n) => `engine/${n}`), sha256: h.digest('hex') };
}
function exporterRevision(appRoot) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(appRoot, 'MANIFEST.json'), 'utf8'));
    return { revision: m.sourceRevision || null, tree: m.sourceTree || null, from: 'package MANIFEST.json' };
  } catch {
    /* not a package */
  }
  try {
    const g = (...a) => cp.execFileSync('git', a, { cwd: appRoot, encoding: 'utf8', timeout: 10000 }).trim();
    return { revision: g('rev-parse', 'HEAD'), tree: g('rev-parse', 'HEAD^{tree}'), from: 'git checkout' };
  } catch {
    return { revision: null, tree: null, from: 'unknown' };
  }
}

function cmdExport(argv) {
  const o = parseOpts(argv, ['image', 'alias', 'out']);
  if (!REF_RE.test(o.image)) fail('--image is not a valid local image reference');
  if (!ALIAS_RE.test(o.alias)) fail('--alias must look like mecode-engine:<name>');
  if (o.alias === PROTECTED_TAG || o.alias === o.image) fail(`--alias must be a NEW task-owned tag, not ${o.alias}`);
  const out = path.resolve(o.out);
  if (
    fs.existsSync(out) ||
    (() => {
      try {
        fs.lstatSync(out);
        return true;
      } catch {
        return false;
      }
    })()
  )
    fail('--out already exists; give a NEW directory');
  if (!fs.statSync(path.dirname(out), { throwIfNoEntry: false })?.isDirectory()) fail('parent of --out does not exist');
  const src = inspect(o.image);
  if (!src || !ID_RE.test(src.id)) fail(`image ${o.image} is not present locally (nothing is pulled)`);
  if (inspect(o.alias)) fail(`alias ${o.alias} already exists; refusing to reuse or replace a tag`);
  fs.mkdirSync(out, { mode: 0o700 });
  let tagged = false;
  try {
    const t = docker(['tag', o.image, o.alias], 20000);
    if (t.code !== 0) fail(`docker tag failed: ${t.stderr}`);
    tagged = true;
    const a = inspect(o.alias);
    if (!a || a.id !== src.id) fail('alias does not resolve to the source image ID');
    const tarFile = path.join(out, 'engine.tar');
    const s = docker(['save', '--output', tarFile, o.alias], SAVE_TIMEOUT_MS);
    if (s.code !== 0) fail(`docker save failed: ${s.stderr}`);
    regularFile(tarFile, 'engine.tar');
    const { sha256, bytes } = sha256File(tarFile);
    if (bytes === 0) fail('engine.tar is empty');
    const appRoot = path.join(__dirname, '..');
    const manifest = {
      schemaVersion: 1,
      kind: 'mecode-engine-export',
      note: 'Local artifact. The checksum detects damage; it does not authenticate the publisher. Import trusted bundles only.',
      archive: { name: 'engine.tar', bytes, sha256 },
      image: { id: src.id, alias: o.alias, sourceReference: o.image, os: src.os, architecture: src.architecture, variant: src.variant },
      recipe: recipeHash(appRoot),
      recipeNote: 'hash of the engine recipe files at export time; it does NOT prove the image was built from them',
      exporter: exporterRevision(appRoot),
      createdAt: new Date().toISOString(),
    };
    const mText = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path.join(out, 'manifest.json'), mText, { mode: 0o600, flag: 'wx' });
    const mHash = crypto.createHash('sha256').update(mText).digest('hex');
    fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${sha256}  engine.tar\n${mHash}  manifest.json\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ exported: true, dir: out, alias: o.alias, imageId: src.id, platform: `${src.os}/${src.architecture}${src.variant ? `/${src.variant}` : ''}`, bytes, sha256 }));
  } catch (e) {
    // remove only what THIS run created: partial outputs in the new directory and the new alias tag (never an image ID, never the source tag)
    for (const f of ['engine.tar', 'manifest.json', 'SHA256SUMS']) fs.rmSync(path.join(out, f), { force: true });
    try {
      fs.rmdirSync(out);
    } catch {
      /* not empty or gone */
    }
    if (tagged) docker(['image', 'rm', o.alias], 30000);
    throw e;
  }
}

function validManifest(m) {
  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(m) || m.schemaVersion !== 1 || m.kind !== 'mecode-engine-export') return 'not a MeCode engine manifest (schemaVersion 1)';
  if (!isObj(m.archive) || !ARCHIVE_RE.test(String(m.archive.name)) || !Number.isSafeInteger(m.archive.bytes) || m.archive.bytes <= 0 || !HEX64.test(String(m.archive.sha256)))
    return 'manifest archive fields are invalid';
  const i = m.image;
  if (!isObj(i) || !ID_RE.test(String(i.id)) || !ALIAS_RE.test(String(i.alias)) || i.alias === PROTECTED_TAG)
    return 'manifest image fields are invalid (alias must be a task alias, never the shared tag)';
  if (
    typeof i.os !== 'string' ||
    typeof i.architecture !== 'string' ||
    typeof i.variant !== 'string' ||
    !/^[a-z0-9]+$/.test(i.os) ||
    !/^[a-z0-9_]+$/.test(i.architecture) ||
    !/^[a-z0-9]*$/.test(i.variant)
  )
    return 'manifest platform fields are invalid';
  return null;
}

/** RepoTags inside the saved archive (docker `manifest.json`): refuses an archive that would (re)tag anything but the alias. Bounded tar header walk. */
function archiveRepoTags(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const size = fs.fstatSync(fd).size;
    const hdr = Buffer.alloc(512);
    let off = 0;
    for (let n = 0; n < 200000 && off + 512 <= size; n++) {
      fs.readSync(fd, hdr, 0, 512, off);
      if (hdr.every((b) => b === 0)) break;
      const name = hdr.toString('utf8', 0, 100).replace(/\0.*$/, '');
      const sz = parseInt(hdr.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
      if (!Number.isFinite(sz) || sz < 0) fail('engine archive has a malformed tar header');
      if (name === 'manifest.json') {
        if (sz > 1 << 20) fail('archive manifest.json is too large');
        const b = Buffer.alloc(sz);
        fs.readSync(fd, b, 0, sz, off + 512);
        const arr = JSON.parse(b.toString('utf8'));
        if (!Array.isArray(arr)) fail('archive manifest.json is malformed');
        return arr.flatMap((e) => (e && Array.isArray(e.RepoTags) ? e.RepoTags : []));
      }
      off += 512 + Math.ceil(sz / 512) * 512;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function cmdImport(argv) {
  const o = parseOpts(argv, ['manifest']);
  const mf = path.resolve(o.manifest);
  const st = regularFile(mf, 'manifest');
  if (st.size > MAX_MANIFEST) fail('manifest is unreasonably large');
  let m;
  try {
    m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  } catch {
    fail('manifest is not valid JSON');
  }
  const bad = validManifest(m);
  if (bad) fail(bad);
  const archive = path.join(path.dirname(mf), m.archive.name); // name is a validated basename: no separators
  const ast = regularFile(archive, 'engine archive');
  if (ast.size !== m.archive.bytes) fail(`archive size ${ast.size} does not match manifest ${m.archive.bytes}; nothing loaded`);
  const got = sha256File(archive);
  if (got.sha256 !== m.archive.sha256) fail('archive SHA-256 does not match the manifest (damaged or altered); nothing loaded');
  const srv = docker(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], 20000);
  if (srv.code !== 0) fail(`Docker is not reachable (${srv.stderr}); start Docker and retry`);
  const want = `${m.image.os}/${m.image.architecture}`;
  if (srv.stdout.trim() !== want) fail(`platform mismatch: this Docker is ${srv.stdout.trim()} but the archive is ${want}; nothing loaded. Build natively instead (docs/OFFLINE.md)`);
  const existing = inspect(m.image.alias);
  if (existing) {
    if (existing.id === m.image.id) {
      console.log(JSON.stringify({ imported: false, alreadyPresent: true, alias: m.image.alias, imageId: existing.id }));
      return;
    }
    fail(`alias ${m.image.alias} already exists and points to a DIFFERENT image (${existing.id}); refusing to replace it`);
  }
  const tags = archiveRepoTags(archive);
  if (tags && tags.some((t) => t !== m.image.alias)) fail(`archive would also tag ${tags.filter((t) => t !== m.image.alias).join(', ')}; refusing (shared tags are never replaced)`);
  const l = docker(['load', '--input', archive], SAVE_TIMEOUT_MS);
  if (l.code !== 0) fail(`docker load failed: ${l.stderr}`);
  const a = inspect(m.image.alias);
  if (!a || a.id !== m.image.id || a.os !== m.image.os || a.architecture !== m.image.architecture) fail('after load the alias does not match the manifest image ID/platform');
  console.log(JSON.stringify({ imported: true, alias: m.image.alias, imageId: a.id, platform: want, next: `MECODE_ENGINE_IMAGE=${m.image.alias} (then press Retry in the app or restart it)` }));
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'export') return cmdExport(rest);
  if (cmd === 'import') return cmdImport(rest);
  return fail('usage: provision-engine.cjs export --image <ref> --alias mecode-engine:<name> --out <new-dir> | import --manifest <manifest.json>');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`provision-engine: ${e instanceof CliError ? e.message : String((e && e.message) || e).slice(0, 300)}`);
    process.exit(e instanceof CliError ? 2 : 1);
  }
}
module.exports = { main, validManifest, archiveRepoTags, ALIAS_RE };
