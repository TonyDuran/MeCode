'use strict';
// Pure data validation. No fetch, dynamic scripts, editor reads or native bridge.
const FixtureEvidence = (() => {
  const encoder = new TextEncoder(), CAP = 256 * 1024;
  const fixtures = ['correct', 'wrong', 'exception', 'sleep_loop'];
  const verdicts = ['ACCEPTED', 'WRONG_ANSWER', 'RUNTIME_ERROR', 'TIME_LIMIT'];
  function ensure(ok, message) { if (!ok) throw new Error(message); }
  function keys(value, expected) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === expected.slice().sort().join(',');
  }
  async function sha(text) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))),
      b => b.toString(16).padStart(2, '0')).join('');
  }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function structure(d, now) {
    ensure(keys(d, ['schema_version', 'problem_id', 'case_id', 'nums', 'oracle', 'generated_utc',
      'judge_revision', 'source_sha256', 'invocation', 'records', 'termination']), 'malformed envelope');
    ensure(d.schema_version === 1 && d.problem_id === 'sum-array-v1' && d.case_id === 'positive' &&
      same(d.nums, [1,2,3,4]) && d.oracle === 10, 'problem or case identity mismatch');
    ensure(d.judge_revision === EVIDENCE_CONTRACT.judge_revision &&
      keys(d.source_sha256, ['runner.py','fixtures.py']) &&
      Object.entries(EVIDENCE_CONTRACT.source_sha256).every(([k,v]) => d.source_sha256[k] === v), 'source identity mismatch');
    ensure(typeof d.generated_utc === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(d.generated_utc), 'invalid generation time');
    const generated = Date.parse(d.generated_utc);
    ensure(Number.isFinite(generated) && new Date(generated).toISOString().replace('.000Z','Z') === d.generated_utc &&
      generated <= now + 5 * 60 * 1000 && now - generated <= 7 * 24 * 60 * 60 * 1000, 'stale or future evidence');
    ensure(d.invocation === 'Runner.run(fixture, [1, 2, 3, 4], budget=0.5)', 'invocation mismatch');
    ensure(Array.isArray(d.records) && d.records.length === 4 && Array.isArray(d.termination) && d.termination.length === 4, 'missing fixture records');
    d.records.forEach((r, i) => {
      ensure(keys(r, ['fixture','nums','verdict','pid','returncode','cleanup_confirmed','cleanup_elapsed_s',
        'failure_reason','run_budget_s','cleanup_budget_s','stdout','stderr','captured_bytes','observed_bytes',
        'input_bytes','elapsed_s','stop_reason']), 'malformed record');
      ensure(r.fixture === fixtures[i] && r.verdict === verdicts[i] && same(r.nums, d.nums), 'fixture identity mismatch');
      ensure(Number.isSafeInteger(r.pid) && r.pid > 0 && Number.isSafeInteger(r.returncode) &&
        r.cleanup_confirmed === true && r.failure_reason === null && r.run_budget_s === 0.5 && r.cleanup_budget_s === 2 &&
        r.input_bytes === 12 && Number.isFinite(r.elapsed_s) && r.elapsed_s >= 0 && r.elapsed_s <= 3 &&
        Number.isFinite(r.cleanup_elapsed_s) && r.cleanup_elapsed_s >= 0 && r.cleanup_elapsed_s <= 2, 'invalid execution receipt');
      for (const name of ['stdout','stderr']) {
        ensure(typeof r[name] === 'string' && encoder.encode(r[name]).length <= 4096, 'invalid stream');
      }
      for (const name of ['captured_bytes','observed_bytes']) {
        ensure(keys(r[name], ['stdout','stderr']) && Object.values(r[name]).every(n => Number.isSafeInteger(n) && n >= 0 && n <= 4096), 'invalid stream counts');
      }
      ensure(r.captured_bytes.stdout === encoder.encode(r.stdout).length &&
        r.observed_bytes.stdout === r.captured_bytes.stdout && r.observed_bytes.stderr === r.captured_bytes.stderr, 'inconsistent stream counts');
      // stderr traceback path is normalized by the generator; raw byte counts retained.
      ensure(i === 3 ? r.stop_reason === 'timeout' && r.returncode !== 0 && r.elapsed_s >= 0.5 :
        r.stop_reason === null && (i === 2 ? r.returncode !== 0 : r.returncode === 0), 'exit/status mismatch');
      ensure(i !== 0 || r.stdout === '10\n', 'oracle mismatch');
      ensure(i !== 1 || r.stdout === '11\n', 'wrong-fixture output mismatch');
      ensure(keys(d.termination[i], ['fixture','reaped','pid_absent']) && d.termination[i].fixture === r.fixture &&
        d.termination[i].reaped === true && d.termination[i].pid_absent === true, 'termination unconfirmed');
    });
    return d;
  }
  async function validate(text) {
    ensure(typeof text === 'string' && text.length > 0, 'missing evidence');
    ensure(text.length <= CAP && encoder.encode(text).length <= CAP, 'oversized evidence');
    let d;
    try { d = JSON.parse(text); } catch (_) { throw new Error('malformed JSON'); }
    structure(d, Date.now());
    ensure(await sha(text) === EVIDENCE_CONTRACT.sha256, 'artifact digest mismatch');
    return d;
  }
  return Object.freeze({validate});
})();
