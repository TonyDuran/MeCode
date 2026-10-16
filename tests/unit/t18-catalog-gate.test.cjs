'use strict';
// T18 R3: decision logic of the full-catalog container acceptance gate, fed with synthetic results (no Docker needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../../scripts/catalog-gate.cjs');

const ids = Array.from({ length: 48 }, (_, i) => `p${i}`);
ids[0] = 'ticket-counter';
ids[1] = 'prefix-directory';
ids[2] = 'lone-signal';
ids[3] = 'rope-splicer';
const solFiles = gate.REQUIRED_SOLUTIONS.map((s) => s.file);
const neg = (verdict, counts, cleanup = true) => ({ verdict, counts, cleanup });

test('T18 gate: infrastructure, cancel and compile failures are never a valid negative, even with cleanup confirmed', () => {
  for (const verdict of ['INFRA_ERROR', 'CANCELLED', 'COMPILE_ERROR', 'RUNTIME_ERROR', 'ACCEPTED', 'MEMORY_LIMIT']) {
    assert.equal(gate.isValidNegative('p9', neg(verdict, { [verdict]: 1 })), false, verdict);
    assert.equal(gate.isValidNegative('p9', neg(verdict, { WRONG_ANSWER: 2, [verdict]: 1 })), false, `${verdict} even beside real WA cases`);
  }
  assert.equal(gate.isValidNegative('p9', neg('WRONG_ANSWER', { PASS: 3, WRONG_ANSWER: 1, INFRA_ERROR: 1 })), false, 'an infrastructure case poisons the evidence');
  assert.equal(gate.isValidNegative('p9', neg('WRONG_ANSWER', { PASS: 3, WRONG_ANSWER: 1 }, false)), false, 'unconfirmed cleanup');
  assert.equal(gate.isValidNegative('p9', neg('WRONG_ANSWER', { PASS: 3 })), false, 'verdict without any WRONG_ANSWER case');
  assert.equal(gate.isValidNegative('p9', neg('WRONG_ANSWER', { PASS: 3, WRONG_ANSWER: 1 })), true);
});

test('T18 gate: TIME_LIMIT is accepted only for the three recorded classifications and only with a real wrong-answer case', () => {
  assert.deepEqual([...gate.TIME_LIMIT_NEGATIVES].sort(), ['drift-median', 'flavor-limit', 'rival-teams']);
  assert.equal(gate.isValidNegative('flavor-limit', neg('TIME_LIMIT', { PASS: 8, WRONG_ANSWER: 2, TIME_LIMIT: 1 })), true);
  assert.equal(gate.isValidNegative('flavor-limit', neg('TIME_LIMIT', { PASS: 8, TIME_LIMIT: 1 })), false, 'no real WA case');
  assert.equal(gate.isValidNegative('some-other-problem', neg('TIME_LIMIT', { PASS: 8, WRONG_ANSWER: 2, TIME_LIMIT: 1 })), false, 'unrecorded TIME_LIMIT');
});

test('T18 gate: a full run needs the exact required solutions and 48 problems; the plan has the 111 named identities', () => {
  const plan = gate.planFull({ problemIds: ids, solutionFiles: solFiles });
  assert.equal(plan.length, 111);
  assert.equal(new Set(plan).size, 111);
  assert.equal(plan.filter((j) => j.startsWith('reference:')).length, 48);
  assert.equal(plan.filter((j) => j.startsWith('wrong:')).length, 48);
  assert.deepEqual(plan.filter((j) => j.startsWith('solution:')).sort(), ['solution:lone-signal:javascript', 'solution:prefix-directory:cpp', 'solution:ticket-counter:c']);
  assert.equal(plan.filter((j) => j.startsWith('starter:')).length, 12);
  // removing a required regression solution must fail loudly (no silent skip)
  assert.throws(() => gate.planFull({ problemIds: ids, solutionFiles: solFiles.filter((f) => f !== 'ticket-counter.c') }), /GATE: required regression solution file\(s\) missing: ticket-counter\.c/);
  assert.throws(() => gate.planFull({ problemIds: ids, solutionFiles: [...solFiles, 'mystery.py'] }), /unknown solution file/);
  assert.throws(() => gate.planFull({ problemIds: ids.slice(1), solutionFiles: solFiles }), /exactly 48/);
});

test('T18 gate: evaluate reports full acceptance only when every planned identity ran as expected; partial runs are never full', () => {
  const plan = gate.planFull({ problemIds: ids, solutionFiles: solFiles });
  const mk = (j) => {
    const [kind, id, language] = j.split(':');
    return { kind, id, language, expectedOutcome: 'as-expected' };
  };
  const results = plan.map(mk);
  assert.deepEqual(gate.evaluate({ results, plan }), { fullAcceptance: true, errors: [] });
  const dropped = gate.evaluate({ results: results.filter((r) => !(r.kind === 'solution' && r.id === 'ticket-counter')), plan });
  assert.equal(dropped.fullAcceptance, false);
  assert.ok(dropped.errors.some((e) => e === 'missing required job solution:ticket-counter:c'));
  const bad = gate.evaluate({ results: results.map((r, i) => (i === 7 ? { ...r, expectedOutcome: 'UNEXPECTED' } : r)), plan });
  assert.equal(bad.fullAcceptance, false);
  assert.equal(gate.evaluate({ results, plan: null }).fullAcceptance, false, 'a partial (--only/--skip-wrong) run is never full acceptance');
});
