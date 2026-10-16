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
if (a[0] === 'load') { st.images[st.loadAs] = st.loadId + '|linux|amd64|' + (st.loadVariant || ''); save(); process.exit(0); }
if (a[0] === 'image' && a[1] === 'rm') { delete st.images[a[2]]; save(); process.exit(0); }
process.exit(9);
`;

/** minimal ACTUAL ustar archive (valid header checksums) */
function tarOf(entries, { end = true, mutate } = {}) {
  const blocks = [];
  for (const e of entries) {
    const body = Buffer.from(e.body === undefined ? '' : e.body);
    const h = Buffer.alloc(512);
    h.write(e.name, 0);
    h.write('0000644\0', 100);
    h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write(e.type || '0', 156);
    h.write('ustar\0' + '00', 257);
    h.write('        ', 148);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length));
  }
  if (end) blocks.push(Buffer.alloc(1024));
  const t = Buffer.concat(blocks);
  return mutate ? mutate(t) : t;
}
const man = (tags) => JSON.stringify([{ Config: 'blobs/c', RepoTags: tags, Layers: [] }]);
const CFG = JSON.stringify({ architecture: 'amd64', os: 'linux', config: {}, rootfs: { type: 'layers', diff_ids: [] } }); // image config as docker save writes it (no variant for amd64)
const goodTar = (alias = 'mecode-engine:t-x') =>
  tarOf([
    { name: 'blobs/', type: '5' },
    { name: 'manifest.json', body: man([alias]) },
    { name: 'blobs/c', body: CFG },
  ]);

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
  const bytes = over.tar || goodTar();
  delete over.tar;
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

test('import: loaded alias that does not match the manifest id fails nonzero', () => {
  const r = rig({ loadId: ID2 });
  const x = r.run('import', '--manifest', bundle(r));
  assert.notEqual(x.status, 0);
  assert.equal(loads(r).length, 1);
});

test('T28 import FAILS CLOSED before docker load on absent/duplicate/unsupported/ambiguous/malformed tag metadata (ZERO load calls)', () => {
  const good = (extra = []) => tarOf([{ name: 'manifest.json', body: man(['mecode-engine:t-x']) }, { name: 'blobs/c', body: CFG }, ...extra]);
  const cases = {
    'arbitrary non-tar bytes': Buffer.from('some-archive-bytes'),
    'empty archive (end marker only)': tarOf([]),
    'no manifest.json': tarOf([{ name: 'other.json', body: '[]' }]),
    'duplicate manifest.json': tarOf([
      { name: 'manifest.json', body: man(['mecode-engine:t-x']) },
      { name: './manifest.json', body: man(['mecode-engine:t-x']) },
    ]),
    'unexpected original tag': tarOf([{ name: 'manifest.json', body: man(['mecode-engine:t-x', 'mecode-engine:v2']) }]),
    'only an unexpected tag': tarOf([{ name: 'manifest.json', body: man(['mecode-engine:v2']) }]),
    'empty RepoTags': tarOf([{ name: 'manifest.json', body: man([]) }]),
    'RepoTags null (untagged)': tarOf([{ name: 'manifest.json', body: JSON.stringify([{ Config: 'c', RepoTags: null, Layers: [] }]) }]),
    'second entry without tags': tarOf([{ name: 'manifest.json', body: JSON.stringify([{ RepoTags: ['mecode-engine:t-x'] }, { Layers: [] }]) }]),
    'empty manifest list': tarOf([{ name: 'manifest.json', body: '[]' }]),
    'manifest not JSON': tarOf([{ name: 'manifest.json', body: '{nope' }]),
    'manifest not an array': tarOf([{ name: 'manifest.json', body: '{}' }]),
    'non-string tag': tarOf([{ name: 'manifest.json', body: JSON.stringify([{ RepoTags: [7] }]) }]),
    'bad header checksum': tarOf([{ name: 'manifest.json', body: man(['mecode-engine:t-x']) }], { mutate: (t) => (t[0] ^= 1) && t }),
    'missing end-of-archive marker': tarOf([{ name: 'manifest.json', body: man(['mecode-engine:t-x']) }], { end: false }),
    'truncated member': tarOf([{ name: 'manifest.json', body: man(['mecode-engine:t-x']) }], { mutate: (t) => t.subarray(0, 600) }),
    'unsupported entry type (symlink)': good([{ name: 'evil', type: '2' }]),
    'index.json names another tag': good([{ name: 'index.json', body: JSON.stringify({ manifests: [{ annotations: { 'io.containerd.image.name': 'docker.io/library/mecode-engine:v2' } }] }) }]),
    'index.json malformed': good([{ name: 'index.json', body: '[]' }]),
    'duplicate index.json': good([
      { name: 'index.json', body: '{"manifests":[]}' },
      { name: 'index.json', body: '{"manifests":[]}' },
    ]),
    'legacy repositories names another tag': good([{ name: 'repositories', body: JSON.stringify({ 'mecode-engine': { v2: 'abc' } }) }]),
  };
  for (const [name, tar] of Object.entries(cases)) {
    const r = rig();
    const x = r.run('import', '--manifest', bundle(r, { tar }));
    assert.notEqual(x.status, 0, `${name}: must be refused`);
    assert.equal(loads(r).length, 0, `${name}: docker load must not run`);
  }
  // supported variants still import: alias-only index.json (as the real exporter writes) and repositories
  const r = rig();
  const ok = good([
    { name: 'index.json', body: JSON.stringify({ manifests: [{ annotations: { 'io.containerd.image.name': 'docker.io/library/mecode-engine:t-x', 'org.opencontainers.image.ref.name': 't-x' } }] }) },
    { name: 'repositories', body: JSON.stringify({ 'mecode-engine': { 't-x': 'abc' } }) },
  ]);
  const x = r.run('import', '--manifest', bundle(r, { tar: ok }));
  assert.equal(x.status, 0, x.stderr);
  assert.equal(loads(r).length, 1);
});

test('T28 recorded platform VARIANT is validated on already-present AND post-load paths (id/os/arch alone is not enough)', () => {
  const v = { id: ID, alias: 'mecode-engine:t-x', sourceReference: 's', os: 'linux', architecture: 'amd64', variant: 'v8' };
  // already present: same ID, different variant => refuse, no load
  const a = rig({ images: { 'mecode-engine:t-x': `${ID}|linux|amd64|` } });
  const x = a.run('import', '--manifest', bundle(a, { image: v }));
  assert.notEqual(x.status, 0);
  assert.match(x.stderr, /platform/);
  assert.equal(loads(a).length, 0);
  // already present with the matching variant stays a no-op success
  const a2 = rig({ images: { 'mecode-engine:t-x': `${ID}|linux|amd64|v8` } });
  assert.equal(a2.run('import', '--manifest', bundle(a2, { image: v })).status, 0);
  assert.equal(loads(a2).length, 0);
  // post-load (archive config agrees with the manifest, so the pre-load check passes): loaded image has a different variant than recorded => nonzero
  const tar8 = tarOf([
    { name: 'manifest.json', body: man(['mecode-engine:t-x']) },
    { name: 'blobs/c', body: JSON.stringify({ architecture: 'amd64', os: 'linux', variant: 'v8' }) },
  ]);
  const b = rig({ loadVariant: '' });
  const y = b.run('import', '--manifest', bundle(b, { image: v, tar: tar8 }));
  assert.notEqual(y.status, 0);
  assert.equal(loads(b).length, 1);
  // post-load: recorded empty variant but loaded image has one => nonzero
  const c = rig({ loadVariant: 'v8' });
  assert.notEqual(c.run('import', '--manifest', bundle(c)).status, 0);
  // matching variant after load succeeds
  const d = rig({ loadVariant: 'v8' });
  assert.equal(d.run('import', '--manifest', bundle(d, { image: v, tar: tar8 })).status, 0);
});

test('T38 platform (incl. VARIANT) of the archive IMAGE CONFIG is checked against the manifest BEFORE docker load, even when the alias is absent', () => {
  const img = (variant) => ({ id: ID, alias: 'mecode-engine:t-x', sourceReference: 's', os: 'linux', architecture: 'amd64', variant });
  const cfg = (o) => JSON.stringify({ architecture: 'amd64', os: 'linux', ...o });
  const withCfg = (body, entry = {}) =>
    tarOf([{ name: 'manifest.json', body: JSON.stringify([{ Config: 'blobs/c', RepoTags: ['mecode-engine:t-x'], Layers: [], ...entry }]) }, ...(body === null ? [] : [{ name: 'blobs/c', body }])]);
  const refused = {
    'absent alias, manifest v8 but archive config has no variant (T37-B1)': { tar: goodTar(), image: img('v8') },
    'archive config variant v8 but manifest records none': { tar: withCfg(cfg({ variant: 'v8' })) },
    'variant differs (v7 vs v8)': { tar: withCfg(cfg({ variant: 'v7' })), image: img('v8') },
    'config os differs': { tar: withCfg(cfg({ os: 'windows' })) },
    'config architecture differs': { tar: withCfg(cfg({ architecture: 'arm64' })) },
    'manifest entry has no Config': { tar: withCfg(cfg({}), { Config: undefined }) },
    'Config is not a string': { tar: withCfg(cfg({}), { Config: 5 }) },
    'Config file absent from archive': { tar: withCfg(null) },
    'Config names a directory (not a regular file)': {
      tar: tarOf([
        { name: 'manifest.json', body: man(['mecode-engine:t-x']) },
        { name: 'blobs/c', type: '5' },
      ]),
    },
    'duplicate Config file': {
      tar: tarOf([
        { name: 'manifest.json', body: man(['mecode-engine:t-x']) },
        { name: 'blobs/c', body: CFG },
        { name: './blobs/c', body: CFG },
      ]),
    },
    'config not JSON': { tar: withCfg('{nope') },
    'config not an object': { tar: withCfg('[]') },
    'config os missing': { tar: withCfg(JSON.stringify({ architecture: 'amd64' })) },
    'config architecture missing': { tar: withCfg(JSON.stringify({ os: 'linux' })) },
    'config os wrong type': { tar: withCfg(cfg({ os: 7 })) },
    'config variant wrong type': { tar: withCfg(cfg({ variant: 8 })) },
    'config variant null': { tar: withCfg(cfg({ variant: null })) },
    'config variant malformed (case is not normalized)': { tar: withCfg(cfg({ variant: 'V8' })), image: img('v8') },
    'config os malformed (case is not normalized)': { tar: withCfg(cfg({ os: 'Linux' })) },
    'config larger than the bound': { tar: withCfg(cfg({ pad: 'x'.repeat(1 << 20) })) },
    'one of two entries disagrees': {
      tar: tarOf([
        {
          name: 'manifest.json',
          body: JSON.stringify([
            { Config: 'blobs/c', RepoTags: ['mecode-engine:t-x'] },
            { Config: 'blobs/d', RepoTags: ['mecode-engine:t-x'] },
          ]),
        },
        { name: 'blobs/c', body: CFG },
        { name: 'blobs/d', body: cfg({ variant: 'v8' }) },
      ]),
    },
  };
  for (const [name, over] of Object.entries(refused)) {
    const r = rig();
    const x = r.run('import', '--manifest', bundle(r, over));
    assert.notEqual(x.status, 0, `${name}: must be refused`);
    assert.equal(loads(r).length, 0, `${name}: docker load must not run`);
    assert.equal(r.st().images['mecode-engine:t-x'], undefined, `${name}: no alias may be introduced`);
  }
  // existing alias with the manifest ID but another recorded variant is still refused before load
  const e = rig({ images: { 'mecode-engine:t-x': `${ID}|linux|amd64|` } });
  assert.notEqual(e.run('import', '--manifest', bundle(e, { image: img('v8') })).status, 0);
  assert.equal(loads(e).length, 0);
  // matching metadata still imports (absent alias): variant absent or "", and v8 on both sides
  const accepted = [
    [goodTar(), img('')],
    [withCfg(cfg({ variant: '' })), img('')],
    [withCfg(cfg({ variant: 'v8' })), img('v8')],
  ];
  for (const [tar, image] of accepted) {
    const r = rig({ loadVariant: image.variant });
    const x = r.run('import', '--manifest', bundle(r, { tar, image }));
    assert.equal(x.status, 0, x.stderr);
    assert.equal(loads(r).length, 1);
  }
});
