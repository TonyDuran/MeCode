'use strict';
// Strict problem-pack v1 validation. Pure; no I/O. Input is untrusted.
const crypto = require('node:crypto');

const LIMITS = Object.freeze({
  packBytes: 5 * 1024 * 1024,
  stdin: 64 * 1024,
  expected: 64 * 1024,
  source: 128 * 1024,
  problems: 500,
  tests: 64,
});
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LANGS = ['python', 'javascript', 'cpp', 'c'];
const DIFFS = ['easy', 'medium', 'hard'];
const COMPARISON = ['tokens', 'exact'];
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const PACK_KEYS = ['schemaVersion', 'id', 'title', 'provenance', 'problems'];
const PROV_KEYS = ['kind', 'authors', 'license', 'sources'];
const PROBLEM_KEYS = ['id', 'title', 'difficulty', 'patterns', 'statement', 'inputFormat', 'outputFormat', 'constraints', 'comparison', 'starters', 'tests'];
const TEST_KEYS = ['id', 'kind', 'stdin', 'expected', 'explanation'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bytes = (s) => Buffer.byteLength(s, 'utf8');

function scanKeys(v, path, errs, depth = 0) {
  if (depth > 12) {
    errs.push({ path, message: 'nesting too deep' });
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => scanKeys(x, `${path}[${i}]`, errs, depth + 1));
    return;
  }
  if (isObj(v)) {
    for (const k of Object.getOwnPropertyNames(v)) {
      if (BAD_KEYS.has(k)) errs.push({ path: `${path}.${k}`, message: `forbidden key "${k}"` });
      else scanKeys(v[k], `${path}.${k}`, errs, depth + 1);
    }
  }
}

function strictKeys(o, allowed, path, errs) {
  for (const k of Object.getOwnPropertyNames(o)) if (!allowed.includes(k)) errs.push({ path: `${path}.${k}`, message: 'unknown field' });
}
function str(o, k, path, errs, { max = 20000, min = 1, optional = false } = {}) {
  const v = o[k];
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string') {
    errs.push({ path: `${path}.${k}`, message: 'must be a string' });
    return undefined;
  }
  if (v.length < min || bytes(v) > max) {
    errs.push({ path: `${path}.${k}`, message: `length out of range (${min}..${max} bytes)` });
    return undefined;
  }
  return v;
}
function strList(o, k, path, errs, { max = 50, itemMax = 2000, optional = false } = {}) {
  const v = o[k];
  if (v === undefined && optional) return [];
  if (!Array.isArray(v) || v.length > max) {
    errs.push({ path: `${path}.${k}`, message: `must be an array of at most ${max} strings` });
    return [];
  }
  v.forEach((x, i) => {
    if (typeof x !== 'string' || x.length === 0 || bytes(x) > itemMax) errs.push({ path: `${path}.${k}[${i}]`, message: 'must be a non-empty bounded string' });
  });
  return v.filter((x) => typeof x === 'string');
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}
const contentHash = (problem) => crypto.createHash('sha256').update(canonical(problem)).digest('hex');

/** @returns {{ok:true,pack:object}|{ok:false,errors:{path:string,message:string}[]}} */
function validatePack(raw, label = 'pack') {
  const errs = [];
  if (!isObj(raw)) return { ok: false, errors: [{ path: label, message: 'pack must be a JSON object' }] };
  scanKeys(raw, label, errs);
  if (errs.length) return { ok: false, errors: errs };
  strictKeys(raw, PACK_KEYS, label, errs);
  if (raw.schemaVersion !== 1) errs.push({ path: `${label}.schemaVersion`, message: 'must be 1' });
  const id = str(raw, 'id', label, errs, { max: 64 });
  if (id !== undefined && !ID_RE.test(id)) errs.push({ path: `${label}.id`, message: 'invalid id' });
  const title = str(raw, 'title', label, errs, { max: 200 });
  let provenance;
  if (!isObj(raw.provenance)) errs.push({ path: `${label}.provenance`, message: 'required object' });
  else {
    const p = raw.provenance;
    strictKeys(p, PROV_KEYS, `${label}.provenance`, errs);
    const kind = str(p, 'kind', `${label}.provenance`, errs, { max: 32 });
    if (kind !== undefined && !['original', 'reused'].includes(kind)) errs.push({ path: `${label}.provenance.kind`, message: 'original|reused' });
    const authors = strList(p, 'authors', `${label}.provenance`, errs, { max: 20, itemMax: 200 });
    const license = str(p, 'license', `${label}.provenance`, errs, { max: 100 });
    const sources = strList(p, 'sources', `${label}.provenance`, errs, { max: 50, itemMax: 500, optional: true });
    provenance = { kind, authors, license, sources };
  }
  const problems = [];
  if (!Array.isArray(raw.problems) || raw.problems.length < 1 || raw.problems.length > LIMITS.problems) {
    errs.push({ path: `${label}.problems`, message: `must be an array of 1..${LIMITS.problems} problems` });
  } else {
    const seen = new Set();
    raw.problems.forEach((rp, i) => {
      const pp = `${label}.problems[${i}]`;
      if (!isObj(rp)) {
        errs.push({ path: pp, message: 'must be an object' });
        return;
      }
      strictKeys(rp, PROBLEM_KEYS, pp, errs);
      const pid = str(rp, 'id', pp, errs, { max: 64 });
      if (pid !== undefined) {
        if (!ID_RE.test(pid)) errs.push({ path: `${pp}.id`, message: 'invalid id' });
        else if (seen.has(pid)) errs.push({ path: `${pp}.id`, message: `duplicate problem id "${pid}"` });
        seen.add(pid);
      }
      const ptitle = str(rp, 'title', pp, errs, { max: 200 });
      if (!DIFFS.includes(rp.difficulty)) errs.push({ path: `${pp}.difficulty`, message: DIFFS.join('|') });
      const patterns = strList(rp, 'patterns', pp, errs, { max: 8, itemMax: 64 });
      const statement = str(rp, 'statement', pp, errs, { max: 20000 });
      const inputFormat = str(rp, 'inputFormat', pp, errs, { max: 4000 });
      const outputFormat = str(rp, 'outputFormat', pp, errs, { max: 4000 });
      const constraints = strList(rp, 'constraints', pp, errs, { max: 30, itemMax: 500 });
      if (!COMPARISON.includes(rp.comparison)) errs.push({ path: `${pp}.comparison`, message: COMPARISON.join('|') });
      const starters = {};
      if (!isObj(rp.starters)) errs.push({ path: `${pp}.starters`, message: 'required object' });
      else {
        for (const k of Object.getOwnPropertyNames(rp.starters)) {
          if (!LANGS.includes(k)) errs.push({ path: `${pp}.starters.${k}`, message: 'unknown language' });
          else if (typeof rp.starters[k] !== 'string' || bytes(rp.starters[k]) > LIMITS.source) errs.push({ path: `${pp}.starters.${k}`, message: 'must be a bounded string' });
          else starters[k] = rp.starters[k];
        }
        if (Object.keys(starters).length === 0) errs.push({ path: `${pp}.starters`, message: 'at least one starter required' });
      }
      const tests = [];
      if (!Array.isArray(rp.tests) || rp.tests.length < 1 || rp.tests.length > LIMITS.tests) errs.push({ path: `${pp}.tests`, message: `1..${LIMITS.tests} tests required` });
      else {
        const tseen = new Set();
        rp.tests.forEach((rt, j) => {
          const tp = `${pp}.tests[${j}]`;
          if (!isObj(rt)) {
            errs.push({ path: tp, message: 'must be an object' });
            return;
          }
          strictKeys(rt, TEST_KEYS, tp, errs);
          const tid = str(rt, 'id', tp, errs, { max: 64 });
          if (tid !== undefined) {
            if (!ID_RE.test(tid)) errs.push({ path: `${tp}.id`, message: 'invalid id' });
            else if (tseen.has(tid)) errs.push({ path: `${tp}.id`, message: `duplicate test id "${tid}"` });
            tseen.add(tid);
          }
          if (!['example', 'check'].includes(rt.kind)) errs.push({ path: `${tp}.kind`, message: 'example|check' });
          const stdin = str(rt, 'stdin', tp, errs, { max: LIMITS.stdin, min: 0 });
          const expected = str(rt, 'expected', tp, errs, { max: LIMITS.expected, min: 0 });
          const explanation = str(rt, 'explanation', tp, errs, { max: 2000, optional: true });
          if (tid !== undefined && stdin !== undefined && expected !== undefined) {
            const t = { id: tid, kind: rt.kind, stdin, expected };
            if (explanation !== undefined) t.explanation = explanation;
            tests.push(t);
          }
        });
        if (!tests.some((t) => t.kind === 'example')) errs.push({ path: `${pp}.tests`, message: 'at least one example required' });
        if (!tests.some((t) => t.kind === 'check')) errs.push({ path: `${pp}.tests`, message: 'at least one check required' });
      }
      problems.push({ id: pid, title: ptitle, difficulty: rp.difficulty, patterns, statement, inputFormat, outputFormat, constraints, comparison: rp.comparison, starters, tests });
    });
  }
  if (errs.length) return { ok: false, errors: errs };
  const pack = { schemaVersion: 1, id, title, provenance, problems };
  pack.problems = problems.map((p) => ({ ...p, contentHash: contentHash(p) }));
  return { ok: true, pack };
}

module.exports = { LIMITS, LANGS, ID_RE, validatePack, contentHash, canonical };
