'use strict';
// Negative-canary orchestrator (runs in the normal pipeline). Each canary runs a CHILD process and requires
//   (a) a non-zero exit, (b) the NAMED assertion in the output, and (c) evidence markers proving the real engine/browser ran up to that
//   assertion (so a missing runtime / launch error can never satisfy a canary). The green control must exit 0 with the same markers.
// Canaries: 1 engine control (green), 2 engine wrong-assertion (red @ CANARY-ASSERT:known-wrong-solution-verdict),
//           3 GUI wrong-assertion (red @ GUI-ASSERT:wrong-answer-verdict), 4 mutated-app GUI (comparator mutated to accept everything:
//           the unchanged GUI test must go red at GUI-ASSERT:wrong-answer-verdict with an observed ACCEPTED verdict).
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { repoRoot, tmpDir } = require('../e2e/harness.cjs');

const outDir = process.env.MECODE_CANARY_LOGS || path.join(repoRoot, 'logs');
fs.mkdirSync(outDir, { recursive: true });
const results = [];

function child(name, args, env, timeoutMs) {
  const r = cp.spawnSync(process.execPath, args, { cwd: repoRoot, env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  fs.writeFileSync(path.join(outDir, `canary-${name}.log`), text.replace(/#s=[0-9a-f]{16,}/g, '#s=REDACTED').slice(0, 200000));
  return { code: r.status, signal: r.signal, text };
}
function check(name, desc, ok, detail) {
  results.push({ name, desc, ok });
  console.log(`${ok ? 'CANARY-OK  ' : 'CANARY-BAD '} ${name}: ${desc}${ok ? '' : ` -- ${detail}`}`);
}
const has = (t, s) => t.includes(s);

// 1 engine control: green
let r = child('engine-green', ['tests/canary/engine-wrong.cjs', 'WRONG_ANSWER'], {}, 120000);
check(
  'engine-control-green',
  'known-wrong solution yields WRONG_ANSWER on the real container',
  r.code === 0 && has(r.text, 'ACTUAL_VERDICT=WRONG_ANSWER') && /ACTUAL_CASE_STATUSES=.*WRONG_ANSWER/.test(r.text),
  `exit ${r.code}`,
);

// 2 engine deliberate wrong assertion: red at the named assertion
r = child('engine-red', ['tests/canary/engine-wrong.cjs', 'ACCEPTED'], {}, 120000);
check(
  'engine-wrong-assertion-red',
  'asserting ACCEPTED for the known-wrong solution fails at the named assertion after real execution',
  r.code !== 0 && has(r.text, 'CANARY-ASSERT:known-wrong-solution-verdict') && has(r.text, 'ACTUAL_VERDICT=WRONG_ANSWER') && has(r.text, 'ACTUAL_CLEANUP='),
  `exit ${r.code}`,
);

// 3 GUI deliberate mismatch: red at the named assertion, after the real browser observed the real verdict
const gui = ['--test', 'tests/e2e/gui.test.cjs'];
r = child('gui-red', gui, { MECODE_E2E_EXPECT_WA: 'ACCEPTED' }, 200000);
check(
  'gui-wrong-assertion-red',
  'GUI asserting ACCEPTED for the wrong source fails at the named GUI assertion',
  r.code !== 0 && has(r.text, 'GUI-ASSERT:wrong-answer-verdict') && has(r.text, 'observed verdict (wrong source): submit: WRONG_ANSWER') && has(r.text, 'backend line: backend: ready'),
  `exit ${r.code}`,
);

// 4 mutated application: comparator accepts everything; the UNCHANGED GUI test must fail at the verdict assertion
const mut = tmpDir('mecode-mutant-');
try {
  for (const item of ['package.json', 'src', 'engine', 'packs']) fs.cpSync(path.join(repoRoot, item), path.join(mut, item), { recursive: true, filter: (s) => !s.includes('__pycache__') });
  const jf = path.join(mut, 'src', 'main', 'judge.cjs');
  const orig = fs.readFileSync(jf, 'utf8');
  const marker = 'function compare(mode, actual, expected) {';
  if (!orig.includes(marker)) throw new Error('mutation anchor missing: update the canary');
  fs.writeFileSync(jf, orig.replace(marker, `${marker}\n  return true; // MUTANT: accept everything`));
  r = child('gui-mutant', gui, { MECODE_E2E_APP_ROOT: mut }, 200000);
  check(
    'gui-mutated-app-red',
    'mutated comparator (accepts everything) is caught by the unchanged GUI verdict assertion',
    r.code !== 0 && has(r.text, 'GUI-ASSERT:wrong-answer-verdict') && has(r.text, 'observed verdict (wrong source): submit: ACCEPTED') && has(r.text, 'backend line: backend: ready'),
    `exit ${r.code}`,
  );
} finally {
  fs.rmSync(mut, { recursive: true, force: true });
}

const bad = results.filter((x) => !x.ok);
console.log(`CANARY-SUMMARY ${results.length - bad.length}/${results.length} behaved as required`);
process.exit(bad.length ? 1 : 0);
