'use strict';
// Pure decision logic of the real-container catalog acceptance gate (scripts/catalog-docker-accept.cjs), kept side-effect free so the
// unit tests can feed it synthetic results (infrastructure-failure negatives, missing required regression solutions, ...).

/** Required non-Python regression solutions in catalog-dev/solutions: exactly these, no more, no fewer. */
const REQUIRED_SOLUTIONS = [
  { file: 'lone-signal.cjs', id: 'lone-signal', language: 'javascript' },
  { file: 'prefix-directory.cpp', id: 'prefix-directory', language: 'cpp' },
  { file: 'ticket-counter.c', id: 'ticket-counter', language: 'c' },
];
const STARTER_PROBLEMS = ['rope-splicer', 'prefix-directory', 'lone-signal'];
const STARTER_LANGUAGES = ['python', 'javascript', 'cpp', 'c'];
/** Negatives recorded as TIME_LIMIT in the accepted container run (slow/inadequate baselines). Each must ALSO have a real WRONG_ANSWER case. */
const TIME_LIMIT_NEGATIVES = ['flavor-limit', 'drift-median', 'rival-teams'];
/** Per-case or per-job statuses that are infrastructure/compile failures and never count as a valid negative. */
const NOT_EVIDENCE = new Set(['INFRA_ERROR', 'CANCELLED', 'COMPILE_ERROR', 'NOT_RUN', 'MEMORY_LIMIT']);
const EXPECTED_TOTAL_FULL = 48 + 48 + REQUIRED_SOLUTIONS.length + STARTER_PROBLEMS.length * STARTER_LANGUAGES.length; // 111

/**
 * A wrong baseline counts as a valid negative only when it was really judged: verdict WRONG_ANSWER, or an explicitly recorded
 * TIME_LIMIT classification, AND at least one case is a genuine WRONG_ANSWER, AND no case/verdict is an infrastructure,
 * cancel or compile failure, AND cleanup was confirmed.
 * @param {string} id
 * @param {{verdict: string, counts: Record<string, number>, cleanup: boolean}} r
 */
function isValidNegative(id, r) {
  if (!r || r.cleanup !== true) return false;
  if (NOT_EVIDENCE.has(r.verdict)) return false;
  const counts = r.counts || {};
  if (Object.keys(counts).some((s) => NOT_EVIDENCE.has(s) && counts[s] > 0)) return false;
  if (!(counts.WRONG_ANSWER > 0)) return false;
  if (r.verdict === 'WRONG_ANSWER') return true;
  return r.verdict === 'TIME_LIMIT' && TIME_LIMIT_NEGATIVES.includes(id);
}

/**
 * Plan the exact job identities of a FULL run (`kind:id:language`). Throws a named error when a required input is missing or unknown.
 * @param {{problemIds: string[], solutionFiles: string[]}} inputs
 */
function planFull({ problemIds, solutionFiles }) {
  const missing = REQUIRED_SOLUTIONS.filter((s) => !solutionFiles.includes(s.file)).map((s) => s.file);
  if (missing.length) throw new Error(`GATE: required regression solution file(s) missing: ${missing.join(', ')}`);
  const unknown = solutionFiles.filter((f) => !REQUIRED_SOLUTIONS.some((s) => s.file === f));
  if (unknown.length) throw new Error(`GATE: unknown solution file(s) not in the required list: ${unknown.join(', ')}`);
  if (problemIds.length !== 48 || new Set(problemIds).size !== 48) throw new Error(`GATE: full run needs exactly 48 distinct problems, got ${problemIds.length}`);
  for (const s of REQUIRED_SOLUTIONS) if (!problemIds.includes(s.id)) throw new Error(`GATE: regression solution ${s.file} targets an unknown problem ${s.id}`);
  for (const id of STARTER_PROBLEMS) if (!problemIds.includes(id)) throw new Error(`GATE: starter problem ${id} is not in the catalog`);
  /** @type {string[]} */
  const jobs = [];
  for (const id of problemIds) jobs.push(`reference:${id}:python`, `wrong:${id}:python`);
  for (const s of REQUIRED_SOLUTIONS) jobs.push(`solution:${s.id}:${s.language}`);
  for (const id of STARTER_PROBLEMS) for (const l of STARTER_LANGUAGES) jobs.push(`starter:${id}:${l}`);
  return jobs;
}

/**
 * Judge a finished run. `full` runs must have produced exactly the planned identities; partial runs (--only/--skip-wrong) are never full acceptance.
 * @param {{results: {kind: string, id: string, language: string, expectedOutcome: string}[], plan: string[] | null}} x
 */
function evaluate({ results, plan }) {
  const errors = [];
  const ids = results.map((r) => `${r.kind}:${r.id}:${r.language}`);
  if (new Set(ids).size !== ids.length) errors.push('duplicate job identities');
  for (const r of results) if (r.expectedOutcome !== 'as-expected') errors.push(`unexpected outcome ${r.kind}:${r.id}:${r.language}`);
  if (plan) {
    if (plan.length !== EXPECTED_TOTAL_FULL) errors.push(`plan has ${plan.length} jobs, expected ${EXPECTED_TOTAL_FULL}`);
    const have = new Set(ids);
    for (const j of plan) if (!have.has(j)) errors.push(`missing required job ${j}`);
    const want = new Set(plan);
    for (const j of ids) if (!want.has(j)) errors.push(`unplanned job ${j}`);
  }
  return { fullAcceptance: plan !== null && errors.length === 0, errors };
}

module.exports = { REQUIRED_SOLUTIONS, STARTER_PROBLEMS, STARTER_LANGUAGES, TIME_LIMIT_NEGATIVES, EXPECTED_TOTAL_FULL, isValidNegative, planFull, evaluate };
