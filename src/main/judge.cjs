'use strict';
// Host-side comparator and verdict selection. Expected answers never leave the host.

const ASCII_WS_EDGE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g; // ASCII only: NBSP and other Unicode spaces stay significant
function tokens(s) {
  const t = String(s).replace(ASCII_WS_EDGE, '');
  return t === '' ? [] : t.split(/[ \t\n\r\f\v]+/);
}

function compare(mode, actual, expected) {
  if (mode === 'exact') return String(actual).replace(/\r\n/g, '\n') === String(expected).replace(/\r\n/g, '\n');
  if (mode !== 'tokens') throw new Error(`unknown comparator ${mode}`);
  const a = tokens(actual),
    e = tokens(expected);
  return a.length === e.length && a.every((x, i) => x === e[i]);
}

/**
 * @param {{mode:'examples'|'custom'|'submit', comparison:string, tests:{id:string,expected?:string}[], engine:{compile?:object,cases:object[],reason?:string}}} a
 * Cases not reported by the engine are NOT_RUN, never PASS.
 */
function judge({ mode, comparison, tests, engine }) {
  const byId = new Map(engine.cases.map((c) => [c.id, c]));
  const cases = tests.map((t) => {
    const c = byId.get(t.id);
    if (!c) return { id: t.id, status: 'NOT_RUN', stdout: '', stderr: '', exitCode: null, signal: null, elapsedMs: 0 };
    const base = { id: t.id, stdout: c.stdout, stderr: c.stderr, exitCode: c.exitCode, signal: c.signal, elapsedMs: c.elapsedMs };
    if (c.outputLimit) return { ...base, status: 'OUTPUT_LIMIT' };
    if (c.timedOut) return { ...base, status: 'TIME_LIMIT' };
    if (c.exitCode !== 0 || c.signal) return { ...base, status: 'RUNTIME_ERROR' };
    if (mode === 'custom') return { ...base, status: 'EXECUTED' };
    return { ...base, status: compare(comparison, c.stdout, t.expected) ? 'PASS' : 'WRONG_ANSWER' };
  });
  let verdict;
  if (engine.compile && engine.compile.ok === false) verdict = 'COMPILE_ERROR';
  else if (cases.some((c) => c.status === 'OUTPUT_LIMIT') || engine.reason === 'output-limit') verdict = 'OUTPUT_LIMIT';
  else if (cases.some((c) => c.status === 'TIME_LIMIT') || engine.reason === 'job-timeout') verdict = 'TIME_LIMIT';
  else if (cases.some((c) => c.status === 'RUNTIME_ERROR')) verdict = 'RUNTIME_ERROR';
  else if (cases.some((c) => c.status === 'WRONG_ANSWER')) verdict = 'WRONG_ANSWER';
  else if (cases.some((c) => c.status === 'NOT_RUN') || (engine.reason !== undefined && engine.reason !== 'complete')) verdict = 'INFRA_ERROR';
  else if (mode === 'custom') verdict = 'EXECUTED';
  else if (mode === 'submit') verdict = 'ACCEPTED';
  else verdict = 'EXAMPLES_PASSED'; // examples only: never ACCEPTED
  return { verdict, cases, compile: engine.compile };
}

module.exports = { compare, judge, tokens };
