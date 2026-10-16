'use strict';
// T27 provisioning script tests against a FAKE docker executable (mock): argv safety, checksum/size/platform/alias refusals, "no load before verification".
// The REAL Docker export/import/cold-start proof is scripts/verify-offline.cjs (see docs/OFFLINE.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const script = path.join(__dirname, '..', '..', 'scripts', 'provision-engine.cjs');
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mc27p-'));
const ID = `sha256:${'1'.repeat(64)}`;
const ID2 = `sha256:${'2'.repeat(64)}`;

const FAKE = `#!${process.execPath}
const fs = require('fs');
const st = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(a) + '\\n');
const save = () => fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(st));
if (a[0] === 'version') { process.stdout.write(st.platform + '\\n'); process.exit(0); }
if (a[0] === 'image' && a[1] === 'inspect') { const i = st.images[a[2]]; if (!i) process.exit(1); process.stdout.write(i + '\\n'); process.exit(0); }
if (a[0] === 'tag') { st.images[a[2]] = st.images[a[1]]; save(); process.exit(0); }
if (a[0] === 'save') { fs.writeFileSync(a[2], st.saveBytes); process.exit(st.saveFail ? 1 : 0); }
if (a[0] === 'load') { st.images[st.loadAs] = st.loadId + '|linux|amd64|'; save(); process.exit(0); }
if (a[0] === 'image' && a[1] === 'rm') { delete st.images[a[2]]; save(); process.exit(0); }
process.exit(9);
`;

function rig(state = {}) {
  const d = tmp();
  const bin = path.join(d, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), FAKE, { mode: 0o755 });
  const stateFile = path.join(d, 'state.json');
  const log = path.join(d, 'log');
  fs.writeFileSync(log, '');
  const init = { platform: 'linux/amd64', images: { 'src:1': `${ID}|linux|amd64|` }, saveBytes: 'FAKE-TAR-BYTES', saveFail: false, loadAs: 'mecode-engine:t-x', loadId: ID, ...state };
  fs.writeFileSync(stateFile, JSON.stringify(init));
  const run = (...argv) =>
    cp.spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_STATE: stateFile, FAKE_LOG: log } });
  const calls = () =>
    fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const st = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return { d, run, calls, st };
}
function bundle(r, over = {}) {
  const dir = path.join(r.d, 'bundle');
  fs.mkdirSync(dir);
  const bytes = Buffer.from('some-archive-bytes');
  fs.writeFileSync(path.join(dir, 'engine.tar'), bytes);
  const m = {
    schemaVersion: 1,
    kind: 'mecode-engine-export',
    archive: { name: 'engine.tar', bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
    image: { id: ID, alias: 'mecode-engine:t-x', sourceReference: 'src:1', os: 'linux', architecture: 'amd64', variant: '' },
    ...over,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return path.join(dir, 'manifest.json');
}
const loads = (r) => r.calls().filter((c) => c[0] === 'load');

test('export: tags ONLY the new alias, saves it, writes manifest (id/platform/hash/size/recipe) + SHA256SUMS', () => {
  const r = rig();
  const out = path.join(r.d, 'out');
  const x = r.run('export', '--image', 'src:1', '--alias', 'mecode-engine:t-x', '--out', out);
  assert.equal(x.status, 0, x.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(m.image.id, ID);
  assert.equal(m.image.alias, 'mecode-engine:t-x');
  assert.equal(`${m.image.os}/${m.image.architecture}`, 'linux/amd64');
  assert.equal(m.archive.bytes, 'FAKE-TAR-BYTES'.length);
  assert.equal(m.archive.sha256, crypto.createHash('sha256').update('FAKE-TAR-BYTES').digest('hex'));
  assert.match(m.recipe.sha256, /^[0-9a-f]{64}$/);
  assert.match(fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8'), new RegExp(`${m.archive.sha256}  engine.tar`));
  const verbs = r.calls().map((c) => c.slice(0, 2).join(' '));
  assert.ok(verbs.includes('tag src:1'));
  assert.equal(r.calls().filter((c) => ['rm', 'rmi', 'prune', 'pull', 'push', 'system'].includes(c[0]) || c[1] === 'rm').length, 0, 'success path deletes/pulls/pushes nothing');
});

test('export refuses: shared tag as alias, existing alias, existing/dirty --out, unknown or duplicate options, missing local image (no pull)', () => {
  const r = rig({ images: { 'src:1': `${ID}|linux|amd64|`, 'mecode-engine:taken': `${ID2}|linux|amd64|` } });
  const out = path.join(r.d, 'out');
  const base = ['export', '--image', 'src:1', '--out', out];
  assert.notEqual(r.run(...base, '--alias', 'mecode-engine:v2').status, 0);
  assert.notEqual(r.run(...base, '--alias', 'mecode-engine:taken').status, 0);
  assert.notEqual(r.run('export', '--image', 'nope:1', '--alias', 'mecode-engine:t-y', '--out', out).status, 0);
  assert.notEqual(r.run(...base, '--alias', 'bad alias').status, 0);
  assert.notEqual(r.run(...base, '--alias', 'mecode-engine:t-y', '--extra', 'x').status, 0);
  assert.notEqual(r.run('export', '--image', '-evil', '--alias', 'mecode-engine:t-y', '--out', out).status, 0);
  fs.mkdirSync(out);
  assert.notEqual(r.run(...base, '--alias', 'mecode-engine:t-y').status, 0, 'existing out');
  fs.rmdirSync(out);
  fs.symlinkSync(os.tmpdir(), out);
  assert.notEqual(r.run(...base, '--alias', 'mecode-engine:t-y').status, 0, 'symlink out');
  assert.equal(r.calls().filter((c) => c[0] === 'pull' || c[0] === 'push').length, 0);
});

test('export failure (docker save fails): nonzero, no manifest, partial output and the new alias are removed, source image untouched', () => {
  const r = rig({ saveFail: true });
  const out = path.join(r.d, 'out');
  const x = r.run('export', '--image', 'src:1', '--alias', 'mecode-engine:t-x', '--out', out);
  assert.notEqual(x.status, 0);
  assert.equal(fs.existsSync(out), false);
  assert.equal(r.st().images['mecode-engine:t-x'], undefined, 'owned alias removed');
  assert.ok(r.st().images['src:1'], 'source tag intact');
});

test('import: verified bundle loads once and the alias is verified; already-present identical alias is a no-op', () => {
  const r = rig();
  const x = r.run('import', '--manifest', bundle(r));
  assert.equal(x.status, 0, x.stderr);
  assert.equal(loads(r).length, 1);
  assert.deepEqual(loads(r)[0].slice(0, 2), ['load', '--input']);
  const again = r.run('import', '--manifest', path.join(r.d, 'bundle', 'manifest.json'));
  assert.equal(again.status, 0);
  assert.equal(loads(r).length, 1, 'second import does not load again');
});

test('import REFUSES before docker load: bad checksum, wrong size, platform mismatch, alias collision, shared tag, traversal name, symlinked archive, bad schema', () => {
  const cases = {
    badSha: (r) => bundle(r, { archive: { name: 'engine.tar', bytes: 18, sha256: 'f'.repeat(64) } }),
    badSize: (r) => bundle(r, { archive: { name: 'engine.tar', bytes: 999, sha256: crypto.createHash('sha256').update('some-archive-bytes').digest('hex') } }),
    platform: (r) => bundle(r, { image: { id: ID, alias: 'mecode-engine:t-x', sourceReference: 's', os: 'linux', architecture: 'arm64', variant: '' } }),
    sharedTag: (r) => bundle(r, { image: { id: ID, alias: 'mecode-engine:v2', sourceReference: 's', os: 'linux', architecture: 'amd64', variant: '' } }),
    traversal: (r) => bundle(r, { archive: { name: '../engine.tar', bytes: 18, sha256: 'a'.repeat(64) } }),
    schema: (r) => bundle(r, { schemaVersion: 2 }),
  };
  for (const [name, mk] of Object.entries(cases)) {
    const r = rig();
    const x = r.run('import', '--manifest', mk(r));
    assert.notEqual(x.status, 0, name);
    assert.equal(loads(r).length, 0, `${name}: docker load must not run`);
  }
  const col = rig({ images: { 'mecode-engine:t-x': `${ID2}|linux|amd64|` } });
  assert.notEqual(col.run('import', '--manifest', bundle(col)).status, 0, 'alias points elsewhere');
  assert.equal(loads(col).length, 0);
  const sym = rig();
  const mf = bundle(sym);
  const real = path.join(sym.d, 'real.tar');
  fs.renameSync(path.join(path.dirname(mf), 'engine.tar'), real);
  fs.symlinkSync(real, path.join(path.dirname(mf), 'engine.tar'));
  assert.notEqual(sym.run('import', '--manifest', mf).status, 0, 'symlink archive');
  assert.equal(loads(sym).length, 0);
  const sm = rig();
  const mlink = bundle(sm);
  fs.renameSync(mlink, path.join(sm.d, 'm.json'));
  fs.symlinkSync(path.join(sm.d, 'm.json'), mlink);
  assert.notEqual(sm.run('import', '--manifest', mlink).status, 0, 'symlink manifest');
  assert.equal(sm.calls().filter((c) => c[0] === 'pull').length, 0);
});

test('import: loaded alias that does not match the manifest id fails nonzero; archive that also tags another name is refused before load', () => {
  const r = rig({ loadId: ID2 });
  const x = r.run('import', '--manifest', bundle(r));
  assert.notEqual(x.status, 0);
  assert.equal(loads(r).length, 1);
  // tar with docker manifest.json naming the shared tag
  const r2 = rig();
  const mf = bundle(r2);
  const body = Buffer.from(JSON.stringify([{ RepoTags: ['mecode-engine:t-x', 'mecode-engine:v2'] }]));
  const hdr = Buffer.alloc(512);
  hdr.write('manifest.json', 0);
  hdr.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  const tar = Buffer.concat([hdr, body, pad, Buffer.alloc(1024)]);
  const dir = path.dirname(mf);
  fs.writeFileSync(path.join(dir, 'engine.tar'), tar);
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.archive.bytes = tar.length;
  m.archive.sha256 = crypto.createHash('sha256').update(tar).digest('hex');
  fs.writeFileSync(mf, JSON.stringify(m));
  const y = r2.run('import', '--manifest', mf);
  assert.notEqual(y.status, 0);
  assert.match(y.stderr, /mecode-engine:v2/);
  assert.equal(loads(r2).length, 0);
});
