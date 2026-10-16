'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validatePack } = require('../../src/shared/validate.cjs');
const { compare, judge } = require('../../src/main/judge.cjs');
const { Catalog } = require('../../src/main/catalog.cjs');
const { Store, AppError } = require('../../src/main/store.cjs');
const { buildRunArgs, validateLimits, Backend, DEFAULT_LIMITS } = require('../../src/main/backend.cjs');

const core = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../../packs/core.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mc-'));

test('bundled core pack validates, has >=2 examples and hashes per problem', () => {
  const r = validatePack(core());
  assert.equal(r.ok, true);
  assert.equal(r.pack.problems.length, 3);
  for (const p of r.pack.problems) {
    assert.match(p.contentHash, /^[0-9a-f]{64}$/);
    assert.ok(p.tests.filter((t) => t.kind === 'example').length >= 1);
  }
});

test('malformed packs are rejected with locations', () => {
  const bad = (mut) => {
    const c = core();
    mut(c);
    return validatePack(c);
  };
  assert.equal(validatePack([]).ok, false);
  assert.equal(
    bad((c) => {
      c.schemaVersion = 2;
    }).ok,
    false,
  );
  assert.equal(
    bad((c) => {
      c.extra = 1;
    }).ok,
    false,
  );
  assert.equal(
    bad((c) => {
      c.id = '../evil';
    }).ok,
    false,
  );
  assert.equal(
    bad((c) => {
      c.problems[0].id = 'a/b';
    }).ok,
    false,
  );
  assert.equal(
    bad((c) => {
      c.problems[1].id = c.problems[0].id;
    }).ok,
    false,
    'duplicate problem id',
  );
  assert.equal(
    bad((c) => {
      c.problems[0].tests[1].id = c.problems[0].tests[0].id;
    }).ok,
    false,
    'duplicate test id',
  );
  assert.equal(
    bad((c) => {
      c.problems[0].tests = c.problems[0].tests.filter((t) => t.kind === 'example');
    }).ok,
    false,
    'needs a check',
  );
  assert.equal(
    bad((c) => {
      c.problems[0].tests[0].stdin = 'x'.repeat(64 * 1024 + 1);
    }).ok,
    false,
    'oversized stdin',
  );
  assert.equal(
    bad((c) => {
      c.problems[0].difficulty = 'nightmare';
    }).ok,
    false,
  );
  assert.equal(
    bad((c) => {
      c.problems[0].starters.rust = 'x';
    }).ok,
    false,
  );
  const r = bad((c) => {
    c.problems[0].tests[0].stdin = 7;
  });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].path, /tests\[0\]\.stdin/);
});

test('prototype keys are rejected (JSON.parse own __proto__)', () => {
  const raw = JSON.parse('{"schemaVersion":1,"id":"x","title":"t","provenance":{"kind":"original","authors":["a"],"license":"CC0-1.0","sources":[]},"problems":[],"__proto__":{"polluted":1}}');
  const r = validatePack(raw);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /__proto__/.test(e.path)));
  assert.equal({}.polluted, undefined);
  const c = core();
  c.problems[0].starters = JSON.parse('{"python":"x","constructor":"y"}');
  assert.equal(validatePack(c).ok, false);
});

test('contentHash changes when an expected answer changes, is stable otherwise', () => {
  const a = validatePack(core()).pack.problems[0].contentHash;
  assert.equal(validatePack(core()).pack.problems[0].contentHash, a);
  const c = core();
  c.problems[0].tests[0].expected = '3\n';
  assert.notEqual(validatePack(c).pack.problems[0].contentHash, a);
});

test('comparator: tokens and exact', () => {
  assert.equal(compare('tokens', ' 1  2\r\n3 \n', '1 2 3'), true);
  assert.equal(compare('tokens', '1 2', '1 2 3'), false);
  assert.equal(compare('tokens', '1.0', '1'), false, 'no numeric coercion');
  assert.equal(compare('tokens', '', '  \n'), true, 'empty == empty');
  assert.equal(compare('exact', 'a\r\nb\n', 'a\nb\n'), true);
  assert.equal(compare('exact', 'a b', 'a  b'), false);
  assert.equal(compare('exact', 'a\n', 'a'), false);
});

const okCase = (id, stdout, extra = {}) => ({ id, stdout, stderr: '', exitCode: 0, signal: null, elapsedMs: 1, timedOut: false, outputLimit: false, ...extra });
test('judge: wrong answer, custom never accepted, missing cases are NOT_RUN, limits', () => {
  const tests = [
    { id: 'a', expected: '1' },
    { id: 'b', expected: '2' },
  ];
  assert.equal(judge({ mode: 'submit', comparison: 'tokens', tests, engine: { cases: [okCase('a', '1'), okCase('b', '2')] } }).verdict, 'ACCEPTED');
  assert.equal(judge({ mode: 'submit', comparison: 'tokens', tests, engine: { cases: [okCase('a', '1'), okCase('b', '3')] } }).verdict, 'WRONG_ANSWER');
  assert.equal(judge({ mode: 'examples', comparison: 'tokens', tests, engine: { cases: [okCase('a', '1'), okCase('b', '2')] } }).verdict, 'EXAMPLES_PASSED');
  assert.equal(judge({ mode: 'custom', comparison: 'tokens', tests: [{ id: 'custom' }], engine: { cases: [okCase('custom', 'whatever')] } }).verdict, 'EXECUTED');
  const miss = judge({ mode: 'submit', comparison: 'tokens', tests, engine: { cases: [okCase('a', '1')], reason: 'complete' } });
  assert.equal(miss.cases[1].status, 'NOT_RUN');
  assert.notEqual(miss.verdict, 'ACCEPTED');
  assert.equal(judge({ mode: 'submit', comparison: 'tokens', tests, engine: { cases: [okCase('a', '1'), okCase('b', '', { timedOut: true, exitCode: null })] } }).verdict, 'TIME_LIMIT');
  assert.equal(judge({ mode: 'submit', comparison: 'tokens', tests, engine: { cases: [okCase('a', '1', { outputLimit: true, exitCode: null }), okCase('b', '2')] } }).verdict, 'OUTPUT_LIMIT');
  assert.equal(judge({ mode: 'submit', comparison: 'tokens', tests, engine: { cases: [okCase('a', '1', { exitCode: 1 })] } }).verdict, 'RUNTIME_ERROR');
  assert.equal(judge({ mode: 'submit', comparison: 'tokens', tests, engine: { compile: { ok: false, output: 'e' }, cases: [] } }).verdict, 'COMPILE_ERROR');
});

test('catalog: import/replace/rollback/reload keeps last-good; stale hash changes', async () => {
  const d = tmp();
  const cat = new Catalog(path.join(d, 'packs'), path.join(d, 'last-good.json'), { seedDir: path.join(__dirname, '../../packs') });
  const r0 = await cat.init();
  assert.equal(r0.ok, true);
  assert.equal(cat.problemCount(), 3);
  const h0 = cat.list().problems[0].contentHash;
  // external pack, then duplicate w/o replace
  const ext = core();
  ext.id = 'external';
  ext.title = 'Ext';
  ext.problems = [ext.problems[0]];
  assert.equal((await cat.import(JSON.stringify(ext))).ok, true);
  assert.equal(cat.problemCount(), 4);
  const dup = await cat.import(JSON.stringify(ext));
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, 'CONFLICT');
  // invalid import writes nothing
  const before = fs.readdirSync(path.join(d, 'packs')).sort();
  const bad = await cat.import('{"schemaVersion":1}');
  assert.equal(bad.ok, false);
  assert.deepEqual(fs.readdirSync(path.join(d, 'packs')).sort(), before);
  // external edit of expected answer + reload -> new hash, no rebuild
  const f = path.join(d, 'packs', 'core.json');
  const c = core();
  c.problems[0].tests[0].expected = '99\n';
  fs.writeFileSync(f, JSON.stringify(c));
  assert.equal((await cat.reload()).ok, true);
  assert.notEqual(cat.list().problems[0].contentHash, h0);
  // broken edit: reload fails, last-good retained and still served
  const rev = cat.revision;
  const good = cat.list();
  fs.writeFileSync(f, '{ not json');
  const rb = await cat.reload();
  assert.equal(rb.ok, false);
  assert.equal(rb.error.code, 'PACK_INVALID');
  assert.equal(cat.revision, rev);
  assert.deepEqual(cat.list(), good);
  assert.ok(cat.lastError);
  // fresh process with broken file falls back to snapshot
  const cat2 = new Catalog(path.join(d, 'packs'), path.join(d, 'last-good.json'));
  await cat2.init();
  assert.equal(cat2.problemCount() > 0, true);
  assert.ok(cat2.lastError);
  // public view hides check expected answers
  const pub = cat.getPublic('external/beacon-pairs');
  assert.equal(pub.tests, undefined);
  assert.equal(pub.checkCount, 3);
  assert.ok(!JSON.stringify(pub).includes('check-all-equal'));
});

test('catalog: path-like / duplicate pack ids across files are rejected', () => {
  const a = JSON.stringify(core());
  const v = Catalog.validateSet([
    { name: 'a.json', text: a },
    { name: 'b.json', text: a },
  ]);
  assert.equal(v.ok, false);
  const c = core();
  c.id = '../x';
  assert.equal(Catalog.validateSet([{ name: 'c.json', text: JSON.stringify(c) }]).ok, false);
});

test('store: durable drafts, stale revision conflict, serialized saves, save failure leaves revision', async () => {
  const d = tmp();
  const s = new Store(d);
  await s.init();
  assert.deepEqual(await s.loadDraft('p/x', 'python'), { source: null, revision: 0, updatedAt: null });
  const [r1, r2] = await Promise.all([s.saveDraft('p/x', 'python', 'a', 0), s.saveDraft('p/x', 'python', 'b', 1)]);
  assert.equal(r1.revision, 1);
  assert.equal(r2.revision, 2);
  await assert.rejects(s.saveDraft('p/x', 'python', 'c', 1), (e) => e.code === 'CONFLICT');
  const s2 = new Store(d);
  await s2.init(); // "reopen"
  assert.equal((await s2.loadDraft('p/x', 'python')).source, 'b');
  assert.equal((await s2.loadDraft('p/x', 'cpp')).source, null, 'per-language');
  // path traversal keys never escape drafts dir
  await s.saveDraft('../../etc/passwd', 'c', 'z', 0);
  assert.ok(fs.readdirSync(path.join(d, 'drafts')).every((f) => /^[0-9a-f]{40}\.json$/.test(f)));
  // injected rename failure
  const bad = {
    ...fs.promises,
    rename: async () => {
      throw new Error('disk full');
    },
  };
  const s3 = new Store(tmp(), { fsx: { ...fs.promises } });
  await s3.init();
  s3.fsx = bad;
  await assert.rejects(s3.saveDraft('p/x', 'python', 'q', 0), (e) => e.code === 'IO_ERROR');
  s3.fsx = fs.promises;
  assert.equal((await s3.loadDraft('p/x', 'python')).revision, 0);
});

test('store: progress only for submit+ACCEPTED on current hash; stale after pack change; corrupt state recovers from backup', async () => {
  const d = tmp();
  const s = new Store(d);
  await s.init();
  await s.recordAttempt({ key: 'p/x', contentHash: 'h1', mode: 'custom', language: 'python', verdict: 'EXECUTED', sourceHash: 's' });
  assert.equal(s.statusOf('p/x', 'h1'), 'unsolved');
  await s.recordAttempt({ key: 'p/x', contentHash: 'h1', mode: 'submit', language: 'python', verdict: 'WRONG_ANSWER', sourceHash: 's' });
  assert.equal(s.statusOf('p/x', 'h1'), 'attempted');
  await s.recordAttempt({ key: 'p/x', contentHash: 'h1', mode: 'submit', language: 'python', verdict: 'ACCEPTED', sourceHash: 's' });
  assert.equal(s.statusOf('p/x', 'h1'), 'solved');
  assert.equal(s.statusOf('p/x', 'h2'), 'stale');
  fs.writeFileSync(path.join(d, 'state.json'), '{corrupt');
  const s2 = new Store(d);
  await s2.init();
  assert.ok(s2.warning);
  assert.equal(s2.statusOf('p/x', 'h1'), 'attempted', 'backup is one write behind; loss is announced via warning');
  fs.writeFileSync(path.join(d, 'state.json'), '{corrupt');
  fs.rmSync(path.join(d, 'state.json.bak'));
  await assert.rejects(new Store(d).init(), (e) => e instanceof AppError && e.code === 'IO_ERROR');
});

test('adapter/backend args: no host mounts, no sockets, no network, no extra caps; limits validated', () => {
  const a = buildRunArgs({ name: 'mecode-x', installId: 'iid', image: 'mecode-engine:v2', limits: DEFAULT_LIMITS });
  const j = a.join(' ');
  for (const must of [
    '--network none',
    '--read-only',
    '--cap-drop ALL',
    'no-new-privileges',
    '--memory 512m',
    '--memory-swap 512m',
    '--pids-limit 64',
    '--cpus 1',
    '--pull never',
    '--user 65534:65534',
  ])
    assert.ok(j.includes(must), must);
  for (const mustNot of ['-v ', '--volume', '--mount', 'docker.sock', '--privileged', '--network host', '--pid host', 'no-sandbox']) assert.ok(!j.includes(mustNot), mustNot);
  assert.ok(a.includes('/tmp:rw,noexec,nosuid,size=16m,mode=1777'));
  assert.throws(
    () => validateLimits({ memoryMiB: 99999 }),
    (e) => e.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => validateLimits({ image: 'evil' }),
    (e) => e.code === 'INVALID_INPUT',
  );
  assert.equal(validateLimits({ caseMs: 500 }).caseMs, 500);
});

test('backend startup states with INJECTED docker stub (stub, not real docker)', async () => {
  const mk = (docker) => new Backend({ installId: 'a'.repeat(36), docker, readyMs: 200 });
  let b = mk(async () => ({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }));
  let s = await b.start();
  assert.equal(s.state, 'unavailable');
  assert.match(s.reason, /Docker CLI\/daemon not reachable/);
  assert.match(s.reason, /Retry/);
  b = mk(async (args) => (args[0] === 'version' ? { code: 0, stdout: '29', stderr: '' } : { code: 1, stdout: '', stderr: 'No such image' }));
  s = await b.start();
  assert.equal(s.state, 'unavailable');
  assert.match(s.reason, /docker build/);
  assert.match(s.reason, /never pulls/);
});
