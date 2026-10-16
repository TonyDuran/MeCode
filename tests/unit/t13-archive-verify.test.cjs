'use strict';
// T13: verify-archives must finish ALL verification before extracting/spawning anything (F2) and must validate every entry path before
// writing (F3). Fixtures are task-owned temp files; no archive payload is ever executed by these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { makeTarGz } = require('../../scripts/lib/archive.cjs');
const { entryProblem, destinationUnder } = require('../../scripts/lib/safe-path.cjs');

const script = path.join(__dirname, '..', '..', 'scripts', 'verify-archives.cjs');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't13-'));

const BAD_NAMES = [
  '../escape.txt',
  'top/../../escape.txt',
  'top/..\\..\\escape.txt', // Windows traversal that POSIX-only checks miss
  '..\\escape.txt',
  '/abs/escape.txt',
  '\\abs\\escape.txt',
  'C:\\escape.txt',
  'C:/escape.txt',
  'c:escape.txt',
  '\\\\server\\share\\escape.txt',
  '//server/share/escape.txt',
  'top//double.txt',
  'top/./dot.txt',
  'top/bad\0nul.txt',
  '',
];

test('entryProblem rejects every POSIX and Windows escape form and accepts normal nested paths', () => {
  for (const n of BAD_NAMES) assert.ok(entryProblem(n), `should reject ${JSON.stringify(n)}`);
  for (const n of ['top', 'top/a/b.txt', 'mecode-v2-abc-windows/src/web/server.cjs', 'top/dir/']) assert.equal(entryProblem(n), null, n);
});

test('destinationUnder keeps every destination beneath the root under win32 and posix path logic', () => {
  for (const n of BAD_NAMES) {
    assert.throws(() => destinationUnder('C:\\work\\out', n, path.win32), /unsafe path/, `win32 ${JSON.stringify(n)}`);
    assert.throws(() => destinationUnder('/work/out', n, path.posix), /unsafe path/, `posix ${JSON.stringify(n)}`);
  }
  assert.equal(destinationUnder('C:\\work\\out', 'top/a/b.txt', path.win32), 'C:\\work\\out\\top\\a\\b.txt');
  assert.equal(destinationUnder('/work/out', 'top/a/b.txt', path.posix), '/work/out/top/a/b.txt');
});

function fixture(entries, { sumsHash, listInSums = true } = {}) {
  const base = tmpRoot();
  const dir = path.join(base, 'dist');
  fs.mkdirSync(dir);
  const name = 'mecode-v2-abc123-linux.tar.gz';
  const buf = makeTarGz(entries, 1700000000);
  fs.writeFileSync(path.join(dir, name), buf);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), listInSums ? `${sumsHash || sha(buf)}  ${name}\n` : `${'0'.repeat(64)}  other-linux.tar.gz\n`);
  const extractTo = path.join(base, 'work', 'out');
  const sentinel = path.join(base, 'work', 'escape.txt');
  fs.mkdirSync(path.dirname(sentinel));
  fs.writeFileSync(sentinel, 'original');
  return { base, dir, name, extractTo, sentinel };
}
const run = (f, file = f.name, extra = []) =>
  cp.spawnSync(process.execPath, [script, '--dir', f.dir, '--run', path.join(f.dir, file), '--extract-to', f.extractTo, ...extra], { encoding: 'utf8', timeout: 60000 });
const launcherEntries = (revision) => {
  const manifest = { sourceRevision: revision, sourceDirty: false, targetOs: 'linux', files: {}, launcher: { start: 'start.sh', buildEngine: 'build-engine.sh' } };
  return [
    { name: 'top', dir: true, mode: 0o755 },
    { name: 'top/MANIFEST.json', data: Buffer.from(JSON.stringify(manifest)), mode: 0o644 },
    { name: 'top/start.sh', data: Buffer.from('#!/bin/sh\necho launcher-would-run\n'), mode: 0o755 },
  ];
};
const assertNothingRan = (f, r, marker) => {
  assert.notEqual(r.status, 0, `must exit nonzero; stdout=${r.stdout}`);
  assert.match(r.stderr, marker);
  assert.match(r.stderr, /nothing extracted or started/);
  assert.ok(!fs.existsSync(f.extractTo), 'no extraction directory may be created');
  assert.ok(!/EXTRACTED|LAUNCHER-/.test(r.stdout), `no extract/launcher/unit step may run: ${r.stdout}`);
  assert.equal(fs.readFileSync(f.sentinel, 'utf8'), 'original');
};

test('F2: SHA256SUMS mismatch on the --run archive exits nonzero with no extraction, launcher or unit run', () => {
  const f = fixture(launcherEntries('0'.repeat(40)), { sumsHash: 'f'.repeat(64) });
  try {
    assertNothingRan(f, run(f, f.name, ['--unit']), /SHA256SUMS mismatch/);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('F2: manifest revision rejection exits nonzero with no extraction, launcher or unit run', () => {
  const f = fixture(launcherEntries('0'.repeat(40)));
  try {
    assertNothingRan(f, run(f, f.name, ['--unit']), /manifest revision/);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('F2: a --run path that is not in the verified SHA256SUMS set is rejected before any extraction', () => {
  const f = fixture(launcherEntries('0'.repeat(40)), { listInSums: false });
  try {
    assertNothingRan(f, run(f), /not one of the verified archives/);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('F3: hostile entry names are rejected before anything is written; outside sentinel stays unchanged', () => {
  for (const evil of ['top/..\\..\\escape.txt', 'top/../../escape.txt', 'C:\\escape.txt', '\\\\server\\share\\escape.txt', '/tmp/escape.txt']) {
    const f = fixture([...launcherEntries('0'.repeat(40)), { name: evil, data: Buffer.from('pwned'), mode: 0o644 }]);
    try {
      assertNothingRan(f, run(f), /unsafe entry/);
    } finally {
      fs.rmSync(f.base, { recursive: true, force: true });
    }
  }
});
