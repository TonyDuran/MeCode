'use strict';
// Job manager: snapshot, single active job, one terminal result per job.
const crypto = require('node:crypto');
const { judge } = require('./judge.cjs');
const { AppError } = require('./store.cjs');
const { LANGS } = require('../shared/validate.cjs');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class Executor {
  constructor({ catalog, store, backend }) { Object.assign(this, { catalog, store, backend }); this.jobs = new Map(); this.active = null; this.maxRetained = 50; }

  start({ key, contentHash, language, source, mode, customInput }) {
    if (!['examples', 'custom', 'submit'].includes(mode)) throw new AppError('INVALID_INPUT', 'bad mode');
    if (!LANGS.includes(language)) throw new AppError('INVALID_INPUT', 'bad language');
    if (typeof source !== 'string' || Buffer.byteLength(source) > 128 * 1024) throw new AppError('INVALID_INPUT', 'source must be a string up to 128 KiB');
    if (mode === 'custom' && (typeof customInput !== 'string' || Buffer.byteLength(customInput) > 64 * 1024)) throw new AppError('INVALID_INPUT', 'custom input must be a string up to 64 KiB');
    const found = this.catalog.getInternal(key);
    if (!found) throw new AppError('NOT_FOUND', 'unknown problem');
    if (found.problem.contentHash !== contentHash) throw new AppError('CONFLICT', 'problem changed since it was displayed; reload the problem');
    if (this.active) throw new AppError('BUSY', 'a job is already running');
    const st = this.backend.getStatus();
    if (st.state !== 'ready') throw new AppError('BACKEND_UNAVAILABLE', st.reason || `backend is ${st.state}`);
    if (!st.languages.some((l) => l.id === language)) throw new AppError('BACKEND_UNAVAILABLE', `language ${language} not available in engine`);
    const tests = mode === 'custom' ? [{ id: 'custom', stdin: customInput }] : found.problem.tests.filter((t) => mode === 'submit' || t.kind === 'example').map((t) => ({ id: t.id, stdin: t.stdin, expected: t.expected }));
    const limits = { ...(st.effectiveLimits || this.backend.limits) }; // enforced worker snapshot
    const jobId = crypto.randomUUID();
    const job = { jobId, key, contentHash, language, mode, sourceHash: sha(source), state: 'running', phase: 'executing', limits, result: null, settled: false };
    this.jobs.set(jobId, job); this.active = job;
    const comparison = found.problem.comparison;
    this.backend.run({ jobId, language, source, cases: tests.map((t) => ({ id: t.id, stdin: t.stdin })), limits })
      .catch((e) => ({ ok: false, kind: 'INFRA_ERROR', message: `internal error: ${String(e && e.message || e).slice(0, 200)}`, cleanup: { confirmed: false } }))
      .then((o) => this._finish(job, o, tests, comparison))
      .catch((e) => { job.settled = true; job.result = job.result || { jobId, verdict: 'INFRA_ERROR', message: String(e && e.message || e).slice(0, 200), cases: [], persistence: 'n/a' }; job.state = 'done'; job.phase = 'finished'; if (this.active === job) this.active = null; });
    return { jobId };
  }

  _prune() {
    const done = [...this.jobs.values()].filter((j) => j.state === 'done');
    for (const j of done.slice(0, Math.max(0, done.length - this.maxRetained))) this.jobs.delete(j.jobId);
  }

  async _finish(job, o, tests, comparison) {
    if (job.settled) return; job.settled = true; // main owns terminal-state selection: exactly one
    let result;
    const base = { jobId: job.jobId, key: job.key, contentHash: job.contentHash, language: job.language, mode: job.mode, sourceHash: job.sourceHash, effectiveLimits: job.limits, cleanup: o.cleanup };
    if (o.ok) {
      const j = judge({ mode: job.mode, comparison, tests, engine: o.engine });
      result = { ...base, ...j };
      if (o.oomKilled === true) result.verdict = 'MEMORY_LIMIT'; // only on positive OOM evidence
    } else {
      const verdict = o.kind === 'CANCELLED' ? 'CANCELLED' : o.kind === 'WATCHDOG' ? 'TIME_LIMIT' : o.oomKilled === true ? 'MEMORY_LIMIT' : 'INFRA_ERROR';
      result = { ...base, verdict, message: o.message, cases: tests.map((t) => ({ id: t.id, status: 'NOT_RUN', stdout: '', stderr: '', exitCode: null, signal: null, elapsedMs: 0 })) };
    }
    job.phase = 'persisting';
    result.persistence = 'n/a';
    if (result.verdict !== 'CANCELLED' && result.verdict !== 'INFRA_ERROR') {
      try { await this.store.recordAttempt({ key: job.key, contentHash: job.contentHash, mode: job.mode, language: job.language, verdict: result.verdict, sourceHash: job.sourceHash }); result.persistence = 'saved'; }
      catch (e) { result.persistence = 'failed'; result.persistError = String(e && e.message || e).slice(0, 200); }
    }
    job.result = result; job.state = 'done'; job.phase = 'finished'; this.active = null;
    this._prune();
  }

  /** the single active job (if any), independent of which problem the UI shows */
  activeJob() { return this.active ? { jobId: this.active.jobId, key: this.active.key, language: this.active.language, mode: this.active.mode, contentHash: this.active.contentHash } : null; }

  get(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) throw new AppError('NOT_FOUND', 'unknown job');
    return { state: j.state, phase: j.phase, result: j.result || undefined };
  }
  cancel(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) throw new AppError('NOT_FOUND', 'unknown job');
    if (j.state === 'done') return { requested: false, note: 'already finished' };
    return { requested: this.backend.cancel(), note: 'cancellation requested; termination not yet confirmed' };
  }
}

module.exports = { Executor };
