'use strict';
// T27 accepted-solution storage: written BEFORE the implementation (RED), then GREEN. Unit tests with a stub backend (mock) — real Docker/browser proof is separate.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../src/main/store.cjs');
const { Executor } = require('../../src/main/exec.cjs');
const { createServices, invoke } = require('../../src/main/services.cjs');

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mc27-'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const acc = (over = {}) => {
  const source = over.source ?? 'print(1)\n';
  return { key: 'p/x', contentHash: H1, mode: 'submit', language: 'python', verdict: 'ACCEPTED', source, sourceHash: sha(source), ...over };
};
const newStore = async (d = tmp(), opts) => {
  const s = new Store(d, opts);
  await s.init();
  return s;
};
const recKey = (key, lang) => crypto.createHash('sha256').update(`${key}\u0000${lang}`).digest('hex').slice(0, 40);
const mkRec = (key, language, source, contentHash = H1) => ({ schemaVersion: 1, key, language, contentHash, sourceHash: sha(source), source, acceptedAt: '2026-01-01T00:00:00.000Z' });
const seed = (d, recs, extra = {}) => {
  const state = {
    schemaVersion: 1,
    installId: '11111111-1111-4111-8111-111111111111',
    progress: {},
    attempts: [],
    acceptedSolutions: Object.fromEntries(recs.map((r) => [recKey(r.key, r.language), r])),
    ...extra,
  };
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(state));
  return state;
};

test('accepted submit stores exact source + progress reference in ONE state commit; survives restart; defensive copy', async () => {
  const d = tmp();
  const s = await newStore(d);
  await s.recordAttempt(acc());
  const r = s.loadAccepted('p/x', 'python');
  assert.deepEqual(Object.keys(r).sort(), ['acceptedAt', 'contentHash', 'key', 'language', 'schemaVersion', 'source', 'sourceHash']);
  assert.equal(r.source, 'print(1)\n');
  assert.equal(r.sourceHash, sha('print(1)\n'));
  r.source = 'tampered';
  assert.equal(s.loadAccepted('p/x', 'python').source, 'print(1)\n', 'returns a copy');
  assert.equal(s.statusOf('p/x', H1), 'solved');
  const s2 = await newStore(d);
  assert.equal(s2.loadAccepted('p/x', 'python').source, 'print(1)\n');
  assert.equal(s2.statusOf('p/x', H1), 'solved');
  assert.equal(s2.loadAccepted('p/x', 'cpp'), null);
});

test('accepted submit without matching source/sourceHash is refused and writes nothing', async () => {
  const d = tmp();
  const s = await newStore(d);
  const before = fs.readFileSync(path.join(d, 'state.json'), 'utf8');
  await assert.rejects(s.recordAttempt(acc({ source: undefined })), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(s.recordAttempt(acc({ sourceHash: sha('other') })), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(s.recordAttempt(acc({ language: 'ruby' })), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(s.recordAttempt(acc({ source: 'x'.repeat(128 * 1024 + 1) })), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(s.recordAttempt(acc({ source: 'é'.repeat(64 * 1024 + 1) })), (e) => e.code === 'INVALID_INPUT', 'multibyte counted in bytes');
  assert.equal(fs.readFileSync(path.join(d, 'state.json'), 'utf8'), before);
  assert.equal(s.statusOf('p/x', H1), 'unsolved');
  await s.recordAttempt(acc({ source: 'é'.repeat(64 * 1024) })); // exactly 128 KiB is allowed
  assert.equal(s.loadAccepted('p/x', 'python').source.length, 64 * 1024);
});

test('non-accepted verdicts / examples / custom never create or replace an accepted record', async () => {
  const s = await newStore();
  await s.recordAttempt(acc());
  const keep = JSON.stringify(s.loadAccepted('p/x', 'python'));
  for (const o of [{ verdict: 'WRONG_ANSWER' }, { verdict: 'RUNTIME_ERROR' }, { mode: 'examples', verdict: 'ACCEPTED' }, { mode: 'custom', verdict: 'ACCEPTED' }]) {
    await s.recordAttempt(acc({ source: 'wrong()', ...o }));
    assert.equal(JSON.stringify(s.loadAccepted('p/x', 'python')), keep, JSON.stringify(o));
  }
  assert.equal(s.loadAccepted('p/y', 'python'), null);
  const s2 = await newStore();
  await s2.recordAttempt(acc({ mode: 'examples' }));
  assert.equal(s2.loadAccepted('p/x', 'python'), null);
  assert.equal(s2.statusOf('p/x', H1), 'unsolved');
});

test('per problem/language identity; latest record replaces; hash change keeps old record retrievable but stale', async () => {
  const s = await newStore();
  await s.recordAttempt(acc({ source: 'py1' }));
  await s.recordAttempt(acc({ language: 'cpp', source: 'cpp1' }));
  assert.equal(s.loadAccepted('p/x', 'python').source, 'py1');
  assert.equal(s.loadAccepted('p/x', 'cpp').source, 'cpp1');
  await s.recordAttempt(acc({ source: 'py2' }));
  assert.equal(s.loadAccepted('p/x', 'python').source, 'py2');
  assert.equal(Object.keys(s.state.acceptedSolutions).length, 2, 'one latest record per problem/language');
  assert.equal(s.statusOf('p/x', H2), 'stale', 'pack changed => not solved');
  await s.recordAttempt(acc({ source: 'py3', contentHash: H2 }));
  assert.equal(s.loadAccepted('p/x', 'python').contentHash, H2);
  assert.equal(s.statusOf('p/x', H2), 'solved');
  assert.equal(s.statusOf('p/x', H1), 'stale');
});

test('legacy acceptance (no source/map) is stale/unverified, drafts and history preserved, nothing fabricated from a draft', async () => {
  const d = tmp();
  const legacy = {
    schemaVersion: 1,
    installId: '11111111-1111-4111-8111-111111111111',
    progress: { 'p/x': { lastVerdict: 'ACCEPTED', acceptedContentHash: H1, acceptedSourceHash: H2 } },
    attempts: [],
  };
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(legacy));
  const s = await newStore(d);
  await s.saveDraft('p/x', 'python', 'draft text', 0);
  assert.equal(s.statusOf('p/x', H1), 'stale');
  assert.equal(s.loadAccepted('p/x', 'python'), null);
  assert.equal((await s.loadDraft('p/x', 'python')).source, 'draft text');
  assert.equal(s.state.progress['p/x'].acceptedSourceHash, H2);
});

test('corrupt / hostile accepted records are rejected at init (no silent adoption)', async () => {
  const good = mkRec('p/x', 'python', 'ok');
  const cases = {
    badHash: { ...good, contentHash: 'zz' },
    badSourceHash: { ...good, sourceHash: sha('else') },
    badLang: { ...good, language: 'ruby' },
    extra: { ...good, admin: true },
    wrongKey: { ...good, key: 'p/other' },
    badVersion: { ...good, schemaVersion: 2 },
    nonString: { ...good, source: 5 },
    badTime: { ...good, acceptedAt: 7 },
  };
  for (const [name, rec] of Object.entries(cases)) {
    const d = tmp();
    seed(d, [good]);
    const st = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
    st.acceptedSolutions[recKey('p/x', 'python')] = rec;
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(st));
    await assert.rejects(newStore(d), (e) => e.code === 'IO_ERROR', name);
  }
  const d = tmp();
  seed(d, []);
  const txt = fs.readFileSync(path.join(d, 'state.json'), 'utf8').replace('"acceptedSolutions":{}', `"acceptedSolutions":{"__proto__":${JSON.stringify(good)}}`);
  fs.writeFileSync(path.join(d, 'state.json'), txt);
  await assert.rejects(newStore(d), (e) => e.code === 'IO_ERROR', 'prototype key / key binding');
  const d2 = tmp();
  seed(d2, [good]);
  const st = JSON.parse(fs.readFileSync(path.join(d2, 'state.json'), 'utf8'));
  st.acceptedSolutions = [good];
  fs.writeFileSync(path.join(d2, 'state.json'), JSON.stringify(st));
  await assert.rejects(newStore(d2), (e) => e.code === 'IO_ERROR', 'array instead of map');
});

test('bounds: 512 entries and 8 MiB aggregate enforced at init and on write; replacement is net-size checked; nothing evicted', async () => {
  const d = tmp();
  const recs = Array.from({ length: 512 }, (_, i) => mkRec(`p/${i}`, 'python', `s${i}`));
  seed(d, recs);
  const s = await newStore(d);
  const before = fs.readFileSync(path.join(d, 'state.json'), 'utf8');
  await assert.rejects(s.recordAttempt(acc({ key: 'p/new', source: 'n' })), (e) => e.code === 'INVALID_INPUT' || e.code === 'LIMIT');
  assert.equal(fs.readFileSync(path.join(d, 'state.json'), 'utf8'), before, 'nothing written at capacity');
  assert.equal(s.statusOf('p/new', H1), 'unsolved');
  assert.ok(s.loadAccepted('p/0', 'python'), 'unrelated record not evicted');
  await s.recordAttempt(acc({ key: 'p/0', source: 'replaced' })); // replacement does not grow the count
  assert.equal(s.loadAccepted('p/0', 'python').source, 'replaced');
  // 513 entries on disk => invalid
  const d2 = tmp();
  seed(d2, [...recs, mkRec('p/513', 'python', 'x')]);
  await assert.rejects(newStore(d2), (e) => e.code === 'IO_ERROR');
  // aggregate
  const big = 'x'.repeat(128 * 1024);
  const d3 = tmp();
  seed(
    d3,
    Array.from({ length: 64 }, (_, i) => mkRec(`b/${i}`, 'python', big)),
  );
  const s3 = await newStore(d3); // exactly 8 MiB is allowed
  await assert.rejects(s3.recordAttempt(acc({ key: 'b/extra', source: 'y' })), (e) => e.code === 'INVALID_INPUT' || e.code === 'LIMIT');
  await s3.recordAttempt(acc({ key: 'b/0', source: 'tiny' })); // shrinking replacement is fine
  await s3.recordAttempt(acc({ key: 'b/extra', source: 'y' })); // and frees room
  const d4 = tmp();
  seed(
    d4,
    Array.from({ length: 65 }, (_, i) => mkRec(`b/${i}`, 'python', big)),
  );
  await assert.rejects(newStore(d4), (e) => e.code === 'IO_ERROR', '8 MiB + 128 KiB on disk is invalid');
});

test('serialized state cap (16 MiB) is enforced even when raw source bytes are under 8 MiB (JSON escaping)', async () => {
  const d = tmp();
  const nasty = '\u0001'.repeat(128 * 1024); // 6 bytes per char once JSON-escaped
  seed(
    d,
    Array.from({ length: 24 }, (_, i) => mkRec(`e/${i}`, 'python', nasty)),
  ); // ~18 MiB serialized, only 3 MiB raw
  const raw = fs.statSync(path.join(d, 'state.json')).size;
  assert.ok(raw > 16 * 1024 * 1024);
  await assert.rejects(newStore(d), (e) => e.code === 'IO_ERROR');
  const d2 = tmp();
  seed(
    d2,
    Array.from({ length: 21 }, (_, i) => mkRec(`e/${i}`, 'python', nasty)),
  ); // ~15 MiB serialized
  const s = await newStore(d2);
  const before = fs.readFileSync(path.join(d2, 'state.json'), 'utf8');
  await assert.rejects(s.recordAttempt(acc({ key: 'e/more', source: nasty })), (e) => e.code === 'INVALID_INPUT' || e.code === 'LIMIT');
  assert.equal(fs.readFileSync(path.join(d2, 'state.json'), 'utf8'), before);
});

test('symlinked / non-regular state is a visible error (accepted source never read through a link)', async () => {
  const d = tmp();
  const target = path.join(tmp(), 'elsewhere.json');
  seed(path.dirname(target), []);
  fs.renameSync(path.join(path.dirname(target), 'state.json'), target);
  fs.symlinkSync(target, path.join(d, 'state.json'));
  await assert.rejects(newStore(d), (e) => e.code === 'IO_ERROR' || e.code === 'UNSAFE_PATH');
});

function failingFs(match) {
  const fsx = { ...fs.promises };
  fsx.rename = async (a, b) => {
    if (match(path.basename(b))) {
      const e = new Error('injected');
      e.code = 'EIO';
      throw e;
    }
    return fs.promises.rename(a, b);
  };
  return fsx;
}
for (const [label, match] of [
  ['primary rename', (n) => n === 'state.json'],
  ['backup rename', (n) => n === 'state.json.bak'],
]) {
  test(`persist failure (${label}): neither source nor progress saved; restart shows the prior consistent pair`, async () => {
    const d = tmp();
    const s0 = await newStore(d);
    await s0.recordAttempt(acc({ source: 'old' }));
    let fail = false;
    const s = new Store(d, { fsx: failingFs((n) => fail && match(n)) });
    await s.init();
    fail = true;
    await assert.rejects(s.recordAttempt(acc({ language: 'cpp', source: 'new' })), (e) => e.code === 'IO_ERROR');
    assert.equal(s.loadAccepted('p/x', 'cpp'), null);
    assert.equal(s.state.progress['p/x'].acceptedLanguage, 'python');
    const s2 = await newStore(d);
    assert.equal(s2.loadAccepted('p/x', 'cpp'), null);
    assert.equal(s2.loadAccepted('p/x', 'python').source, 'old');
    assert.equal(s2.state.progress['p/x'].acceptedLanguage, 'python');
    fail = false;
    await s.recordAttempt(acc({ language: 'cpp', source: 'new' }));
    assert.equal((await newStore(d)).loadAccepted('p/x', 'cpp').source, 'new');
  });
}

// ---- Executor: submitted snapshot semantics (stub backend: mock engine)
function stubRig({ onRun } = {}) {
  const calls = [];
  const backend = {
    limits: {},
    getStatus: () => ({
      state: 'ready',
      languages: [
        { id: 'python', version: 'x' },
        { id: 'cpp', version: 'x' },
      ],
      effectiveLimits: {},
    }),
    cancel: () => true,
    run: async (req) => {
      calls.push(req);
      if (onRun) await onRun(req);
      return {
        ok: true,
        engine: {
          reason: 'complete',
          cases: req.cases.map((c) => ({ id: c.id, status: 'OK', stdout: stubRig.out[c.id] ?? '', stderr: '', exitCode: 0, signal: null, elapsedMs: 1, timedOut: false, outputLimit: false })),
        },
        cleanup: { confirmed: true },
      };
    },
  };
  stubRig.calls = calls;
  return backend;
}
stubRig.out = {};
async function execRig(store, backend, hashRef) {
  const tests = [
    { id: 'e1', kind: 'example', stdin: '1', expected: '2' },
    { id: 'c1', kind: 'check', stdin: '2', expected: '4' },
  ];
  const catalog = { getInternal: (k) => (k === 'p/x' ? { problem: { contentHash: hashRef.v, tests, comparison: 'tokens' } } : null) };
  return new Executor({ catalog, store, backend });
}
const waitJob = async (ex, id) => {
  for (let i = 0; i < 200; i++) {
    const g = ex.get(id);
    if (g.state === 'done') return g.result;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no finish');
};

test('executor: record holds the EXACT submitted source even if the editor/draft changes during the run; result never leaks source', async () => {
  stubRig.out = { e1: '2', c1: '4' };
  const d = tmp();
  const store = await newStore(d);
  const hashRef = { v: H1 };
  let draftEdited = false;
  const backend = stubRig({
    onRun: async () => {
      if (!draftEdited) await store.saveDraft('p/x', 'python', 'WRONG DRAFT typed while running', 0); // later editor state
      draftEdited = true;
    },
  });
  const ex = await execRig(store, backend, hashRef);
  const submitted = 'x = int(input())\nprint(x*2)\n';
  const res = await waitJob(ex, ex.start({ key: 'p/x', contentHash: H1, language: 'python', source: submitted, mode: 'submit' }).jobId);
  assert.equal(draftEdited, true);
  assert.equal(res.verdict, 'ACCEPTED');
  assert.equal(res.persistence, 'saved');
  assert.equal(res.solutionPersistence, 'saved');
  assert.equal(JSON.stringify(res).includes('x*2'), false, 'source not in public result');
  assert.equal(store.loadAccepted('p/x', 'python').source, submitted);
  assert.equal(store.loadAccepted('p/x', 'python').sourceHash, res.sourceHash);
  assert.equal((await store.loadDraft('p/x', 'python')).source, 'WRONG DRAFT typed while running', 'draft untouched');
  // wrong submit afterwards does not replace; example/custom never do
  stubRig.out = { e1: '9', c1: '9' };
  const wa = await waitJob(ex, ex.start({ key: 'p/x', contentHash: H1, language: 'python', source: 'bad', mode: 'submit' }).jobId);
  assert.equal(wa.verdict, 'WRONG_ANSWER');
  assert.equal(wa.solutionPersistence, 'n/a');
  assert.equal(store.loadAccepted('p/x', 'python').source, submitted);
  assert.equal(store.statusOf('p/x', H1), 'solved', 'earlier acceptance of the same content hash stays truthful');
});

test('executor: mid-job pack change certifies only the snapshot hash => status stale for the new hash', async () => {
  stubRig.out = { e1: '2', c1: '4' };
  const store = await newStore();
  const hashRef = { v: H1 };
  const ex = await execRig(store, stubRig({ onRun: async () => (hashRef.v = H2) }), hashRef);
  const res = await waitJob(ex, ex.start({ key: 'p/x', contentHash: H1, language: 'python', source: 'old-code', mode: 'submit' }).jobId);
  assert.equal(res.verdict, 'ACCEPTED');
  assert.equal(store.loadAccepted('p/x', 'python').contentHash, H1);
  assert.equal(store.statusOf('p/x', H2), 'stale');
});

test('executor: persistence failure => verdict ACCEPTED but BOTH persistence flags failed; no record, not solved, restart consistent', async () => {
  stubRig.out = { e1: '2', c1: '4' };
  const d = tmp();
  let fail = false;
  const store = new Store(d, { fsx: failingFs((n) => fail && n === 'state.json') });
  await store.init();
  fail = true;
  const ex = await execRig(store, stubRig(), { v: H1 });
  const res = await waitJob(ex, ex.start({ key: 'p/x', contentHash: H1, language: 'python', source: 'code', mode: 'submit' }).jobId);
  assert.equal(res.verdict, 'ACCEPTED');
  assert.equal(res.persistence, 'failed');
  assert.equal(res.solutionPersistence, 'failed');
  assert.equal(store.loadAccepted('p/x', 'python'), null);
  assert.equal(store.statusOf('p/x', H1), 'unsolved');
  fail = false;
  const s2 = await newStore(d);
  assert.equal(s2.loadAccepted('p/x', 'python'), null);
  assert.equal(s2.statusOf('p/x', H1), 'unsolved');
  assert.equal(ex.active, null, 'executor released after failed commit');
});

// ---- service + transports
test('solution.load: strict args, unknown key rejected, stale flag from CURRENT catalog hash, no write method exposed', async () => {
  const userData = tmp();
  const svc = await createServices({ userData, appRoot: path.join(__dirname, '..', '..'), autostart: false });
  try {
    const key = svc.catalog.list().problems[0].key;
    const hash = svc.catalog.getPublic(key).contentHash;
    const call = (a) => invoke(svc.handlers, 'solution.load', a);
    assert.equal((await call({ key, language: 'python' })).value.solution, null);
    await svc.store.recordAttempt(acc({ key, contentHash: hash, source: 'print(42)\n' }));
    const ok = await call({ key, language: 'python' });
    assert.equal(ok.ok, true);
    assert.equal(ok.value.solution.source, 'print(42)\n');
    assert.equal(ok.value.stale, false);
    await svc.store.recordAttempt(acc({ key, contentHash: H2, language: 'c', source: 'int main(){}' }));
    assert.equal((await call({ key, language: 'c' })).value.stale, true, 'old content hash => stale');
    for (const bad of [
      { key, language: 'ruby' },
      { key: 'no/such', language: 'python' },
      { key },
      { key, language: 'python', extra: 1 },
      { key: 'k'.repeat(201), language: 'python' },
      null,
      [],
      'x',
    ]) {
      const r = await call(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
    assert.equal(
      Object.keys(svc.handlers)
        .filter((n) => /solution/.test(n))
        .join(),
      'solution.load',
    );
  } finally {
    await svc.shutdown();
  }
});

test('solution.load is in every transport allowlist (web API, browser bridge, Electron preload) and nothing else was added', () => {
  const root = path.join(__dirname, '..', '..', 'src');
  const web = fs.readFileSync(path.join(root, 'web', 'server.cjs'), 'utf8');
  const bridge = fs.readFileSync(path.join(root, 'renderer', 'bridge.js'), 'utf8');
  const pre = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
  for (const [n, t] of Object.entries({ web, bridge, pre })) assert.match(t, /'solution\.load'/, n);
  const names = (t) => [...t.matchAll(/'((?:catalog|packs|draft|backend|settings|execution|server|solution)\.[a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.equal(names(web).filter((x) => x.startsWith('solution')).length, 1);
});
