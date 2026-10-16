'use strict';
// T16 catalog contract: the bundled packs ARE the shipped catalog. These tests need only the shipped files (no catalog-dev).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validatePack, LANGS } = require('../../src/shared/validate.cjs');
const { Catalog } = require('../../src/main/catalog.cjs');

const packsDir = path.join(__dirname, '../../packs');
const bundled = () =>
  fs
    .readdirSync(packsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, pack: JSON.parse(fs.readFileSync(path.join(packsDir, f), 'utf8')) }));
// T01 distribution: 12 patterns x 3 + 6 patterns x 2 = 48 problems over 18 patterns
const WANT = {
  'arrays-hashing': 3,
  'two-pointers': 3,
  'sliding-window': 3,
  stack: 3,
  'binary-search': 3,
  trees: 3,
  heap: 3,
  backtracking: 3,
  graphs: 3,
  'dp-1d': 3,
  'dp-2d': 3,
  greedy: 3,
  'linked-lists': 2,
  tries: 2,
  'advanced-graphs': 2,
  intervals: 2,
  'math-geometry': 2,
  'bit-manipulation': 2,
};
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't16-'));

test('T16 bundled catalog: 48 original problems, exact 18-pattern distribution, CC0 provenance', () => {
  const packs = bundled();
  const probs = packs.flatMap((p) => p.pack.problems);
  assert.equal(probs.length, 48);
  assert.equal(new Set(probs.map((p) => p.id)).size, 48, 'unique problem ids');
  assert.equal(new Set(probs.map((p) => p.title)).size, 48, 'unique titles');
  assert.equal(new Set(probs.map((p) => p.statement)).size, 48, 'unique statements (no renamed duplicates)');
  const dist = {};
  for (const p of probs) for (const t of p.patterns) dist[t] = (dist[t] || 0) + 1;
  assert.deepEqual(dist, WANT);
  assert.equal(Object.keys(dist).length, 18);
  for (const { file, pack } of packs) {
    assert.equal(pack.provenance.kind, 'original', file);
    assert.equal(pack.provenance.license, 'CC0-1.0', file);
    assert.deepEqual(pack.provenance.sources, [], file);
    assert.ok(validatePack(pack, file).ok, `${file} validates`);
  }
  assert.ok(probs.some((p) => p.id === 'beacon-pairs') && probs.some((p) => p.id === 'bracket-ledger') && probs.some((p) => p.id === 'steady-streak'), 'the 3 original ids are retained');
});

test('T16 every problem: >=2 examples with explanations, >=8 checks, 4 honest TODO starters, bounded numeric constraints', () => {
  for (const p of bundled().flatMap((x) => x.pack.problems)) {
    const ex = p.tests.filter((t) => t.kind === 'example');
    const ck = p.tests.filter((t) => t.kind === 'check');
    assert.ok(ex.length >= 2, `${p.id} examples`);
    assert.ok(ck.length >= 8, `${p.id} checks`);
    assert.equal(new Set(p.tests.map((t) => t.stdin)).size, p.tests.length, `${p.id} duplicate inputs`);
    assert.ok(
      p.constraints.some((c) => /\d/.test(c)),
      `${p.id} numeric constraints`,
    );
    assert.deepEqual(Object.keys(p.starters).sort(), [...LANGS].sort(), `${p.id} starters`);
    for (const [lang, src] of Object.entries(p.starters)) assert.match(src, /TODO/, `${p.id}/${lang} must be a skeleton with a TODO, not a solution`);
    assert.ok(['easy', 'medium', 'hard'].includes(p.difficulty));
    assert.equal(p.comparison, 'tokens');
  }
  const d = {};
  for (const p of bundled().flatMap((x) => x.pack.problems)) d[p.difficulty] = (d[p.difficulty] || 0) + 1;
  assert.ok(d.easy >= 5 && d.medium >= 5 && d.hard >= 5, `difficulty spread ${JSON.stringify(d)}`);
});

test('T16 fresh install seeds all bundled packs; an upgrade adds ONLY the new pack and never touches user edits or deletions', async () => {
  // fresh
  const d1 = tmp();
  const c1 = new Catalog(path.join(d1, 'packs'), path.join(d1, 'lg.json'), { seedDir: packsDir });
  assert.equal((await c1.init()).ok, true);
  assert.equal(c1.problemCount(), 48);
  // simulate an install made by the previous app version: only core.json + the legacy marker, plus a user edit
  const d2 = tmp();
  fs.mkdirSync(path.join(d2, 'packs'));
  const edited = JSON.parse(fs.readFileSync(path.join(packsDir, 'core.json'), 'utf8'));
  edited.problems[0].title = 'My Edited Title';
  fs.writeFileSync(path.join(d2, 'packs', 'core.json'), JSON.stringify(edited));
  fs.writeFileSync(path.join(d2, '.packs-seeded'), 'seeded\n');
  const c2 = new Catalog(path.join(d2, 'packs'), path.join(d2, 'lg.json'), { seedDir: packsDir });
  assert.equal((await c2.init()).ok, true);
  assert.equal(c2.problemCount(), 48, 'new bundled pack appears');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d2, 'packs', 'core.json'), 'utf8')).problems[0].title, 'My Edited Title', 'user edit untouched');
  // the user deletes the new pack: it must not come back on the next launch
  fs.unlinkSync(path.join(d2, 'packs', 'mecode-patterns.json'));
  const c3 = new Catalog(path.join(d2, 'packs'), path.join(d2, 'lg.json'), { seedDir: packsDir });
  assert.equal((await c3.init()).ok, true);
  assert.equal(c3.problemCount(), 3, 'deleted pack is not resurrected');
  assert.equal(c3.list().problems.length, 3);
});

test('T16 catalog list exposes every pattern for browsing and keeps hashes content-addressed', async () => {
  const d = tmp();
  const c = new Catalog(path.join(d, 'packs'), path.join(d, 'lg.json'), { seedDir: packsDir });
  await c.init();
  const list = c.list().problems;
  assert.equal(new Set(list.flatMap((p) => p.patterns)).size, 18);
  assert.equal(new Set(list.map((p) => p.contentHash)).size, 48, 'distinct content hashes');
  const again = new Catalog(path.join(tmp(), 'packs'), path.join(d, 'lg2.json'), { seedDir: packsDir });
  await again.init();
  assert.deepEqual(
    again.list().problems.map((p) => p.contentHash),
    list.map((p) => p.contentHash),
    'hash is deterministic across installs',
  );
});
