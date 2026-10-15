'use strict';
// App-owned engine container lifecycle. All docker calls are argv arrays with bounded timeouts and exact names.
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { AppError } = require('./store.cjs');

const APP_LABEL = 'mecode.app=mecode-v2';
const DEFAULT_LIMITS = Object.freeze({ memoryMiB: 512, cpus: 1, pids: 64, caseMs: 2000, compileMs: 10000, jobMs: 30000, outputBytes: 64 * 1024 });
const RANGES = { memoryMiB: [128, 1024], cpus: [0.25, 2], pids: [32, 128], caseMs: [100, 10000], compileMs: [1000, 30000], jobMs: [5000, 120000], outputBytes: [1024, 256 * 1024] };
const INT_LIMITS = new Set(['memoryMiB', 'pids', 'caseMs', 'compileMs', 'jobMs', 'outputBytes']);

function validateLimits(input) {
  const out = { ...DEFAULT_LIMITS };
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) throw new AppError('INVALID_INPUT', 'limits must be an object');
  for (const [k, v] of Object.entries(input || {})) {
    if (!Object.hasOwn(RANGES, k)) throw new AppError('INVALID_INPUT', `unknown limit ${k}`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < RANGES[k][0] || v > RANGES[k][1]) throw new AppError('INVALID_INPUT', `${k} must be within ${RANGES[k].join('..')}`);
    if (INT_LIMITS.has(k) && !Number.isInteger(v)) throw new AppError('INVALID_INPUT', `${k} must be an integer`);
    out[k] = v;
  }
  return out;
}

/** The single place docker-run flags are built. No host mounts, no sockets, no network, no extra caps. */
function buildRunArgs({ name, installId, image, limits }) {
  const m = `${limits.memoryMiB}m`;
  return ['run', '-i', '--pull', 'never', '--name', name,
    '--label', APP_LABEL, '--label', `mecode.install=${installId}`,
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', m, '--memory-swap', m, '--cpus', String(limits.cpus), '--pids-limit', String(limits.pids),
    '--user', '65534:65534',
    '--tmpfs', '/work:rw,exec,nosuid,size=128m,mode=1777', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,mode=1777',
    image];
}

function dockerExec(args, timeoutMs) {
  return new Promise((resolve) => {
    cp.execFile('docker', args, { timeout: timeoutMs, maxBuffer: 1 << 20, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr, error: err ? err.message : null });
    });
  });
}

const MAX_LINE = 2 * 1024 * 1024;
const MAX_FRAMES = 4096;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const DONE_REASONS = new Set(['complete', 'compile-error', 'job-timeout', 'output-limit']);
const isInt = (x) => Number.isInteger(x);
const strBytes = (x) => (typeof x === 'string' ? Buffer.byteLength(x, 'utf8') : -1);

/** Required cgroup/user controls for the limits that were requested (fail closed). Returns a problem string or null. */
function controlsMatch(c, l) {
  if (!c || typeof c !== 'object') return 'no controls reported';
  if (c.memoryMax !== String(l.memoryMiB * 1048576)) return `memory.max=${c.memoryMax} (expected ${l.memoryMiB * 1048576})`;
  if (c.pidsMax !== String(l.pids)) return `pids.max=${c.pidsMax} (expected ${l.pids})`;
  const m = /^(\d+) (\d+)$/.exec(String(c.cpuMax || ''));
  if (!m || Math.abs(Number(m[1]) / Number(m[2]) - l.cpus) > 0.01) return `cpu.max=${c.cpuMax} (expected ${l.cpus} CPUs)`;
  if (c.uid !== 65534) return `uid=${c.uid} (expected 65534)`;
  return null;
}
function validReady(r) {
  return !!r && Array.isArray(r.languages) && r.languages.length > 0 && r.languages.length <= 16
    && r.languages.every((l) => l && typeof l.id === 'string' && /^[a-z0-9_-]{1,16}$/.test(l.id) && typeof l.version === 'string' && l.version.length <= 200);
}

class Backend extends EventEmitter {
  constructor({ installId, image = 'mecode-engine:v2', spawn = cp.spawn, docker = dockerExec, limits = DEFAULT_LIMITS, readyMs = 20000, idleMs = 120000, cleanupMs = 5000 } = {}) {
    super();
    Object.assign(this, { installId, image, spawn, docker, limits, readyMs, idleMs, cleanupMs });
    this.status = { state: 'checking', languages: [] };
    this.cur = null; this.starting = null; this.stopped = false; this.stopping = null; this.runCtl = null; this.activeLimits = null;
  }
  _set(state, extra = {}) { this.status = { state, languages: [], ...extra }; this.emit('status', this.status); }
  getStatus() { return { ...this.status, effectiveLimits: this.activeLimits || this.limits, requestedLimits: this.limits }; }
  retry() {
    if (this.stopped || ['busy', 'cleanup-unconfirmed', 'stopping'].includes(this.status.state)) return Promise.resolve(this.getStatus());
    return this.start();
  }

  /** validate -> persist -> adopt -> retire the idle worker so the next one really has the new limits. */
  async updateLimits(candidate, persist) {
    const next = validateLimits(candidate);
    if (this.stopped) throw new AppError('BACKEND_UNAVAILABLE', 'backend is stopped');
    if (['busy', 'starting', 'stopping', 'checking'].includes(this.status.state) || this.starting) throw new AppError('BUSY', 'cannot change limits while a job runs or the engine is starting');
    if (persist) await persist(next); // failure => nothing adopted
    this.limits = next;
    if (this.cur) {
      const w = this.cur; this.cur = null;
      this._set('stopping', { imageId: this.status.imageId });
      const c = await this._retire(w);
      if (!c.confirmed) { this._set('cleanup-unconfirmed', { reason: `could not confirm removal of ${w.name}`, imageId: this.status.imageId }); return next; }
      await this.start();
    }
    return next;
  }
  setLimits(l) { this.limits = validateLimits(l); } // pre-start configuration only

  async start() {
    if (this.stopped) return this.getStatus();
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async _sweepStale() {
    const flt = ['--filter', `label=${APP_LABEL}`, '--filter', `label=mecode.install=${this.installId}`];
    const stale = await this.docker(['ps', '-aq', ...flt], 5000);
    if (stale.code !== 0) return false;
    const ids = stale.stdout.trim() ? stale.stdout.trim().split(/\s+/) : [];
    if (!ids.length) return true;
    for (const id of ids) {
      if (!/^[0-9a-f]{6,64}$/.test(id)) return false;
      const rm = await this.docker(['rm', '-f', id], this.cleanupMs);
      if (rm.code !== 0) return false;
    }
    const again = await this.docker(['ps', '-aq', ...flt], 5000);
    return again.code === 0 && again.stdout.trim() === '';
  }
  async _start() {
    if (this.stopped) return this.getStatus();
    this._set('checking');
    const v = await this.docker(['version', '--format', '{{.Server.Version}}'], 5000);
    if (v.code !== 0) { this._set('unavailable', { reason: `Docker CLI/daemon not reachable (${(v.stderr || v.error || '').trim().slice(0, 200)}). Install/start Docker (rootless is fine), then press Retry.` }); return this.getStatus(); }
    const img = await this.docker(['image', 'inspect', this.image, '--format', '{{.Id}}'], 5000);
    if (img.code !== 0) { this._set('unavailable', { reason: `Engine image "${this.image}" is not present locally. The app never pulls silently. Build it: docker build -t ${this.image} engine/ (see README), then press Retry.` }); return this.getStatus(); }
    const imageId = img.stdout.trim();
    if (!(await this._sweepStale())) { this._set('cleanup-unconfirmed', { reason: 'could not confirm removal of stale app-owned containers; inspect with: docker ps -a --filter label=mecode.app=mecode-v2', imageId }); return this.getStatus(); }
    if (this.stopped) return this.getStatus();
    const limits = this.limits;
    this._set('starting', { imageId });
    const name = `mecode-${this.installId.slice(0, 8)}-${crypto.randomBytes(4).toString('hex')}`;
    const child = this.spawn('docker', buildRunArgs({ name, installId: this.installId, image: this.image, limits }), { stdio: ['pipe', 'pipe', 'pipe'] });
    const w = { name, child, buf: '', frames: [], qBytes: 0, waiter: null, exited: false, stderr: '', limits };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { w.buf += d; if (w.buf.length > MAX_LINE * 2) { w.overflow = true; this._kill(w); return; } this._pump(w); });
    child.stderr.on('data', (d) => { w.stderr = (w.stderr + d).slice(-2000); });
    child.stdin.on('error', (e) => { w.stdinError = e.message; w.exited = true; this._kill(w); this._wake(w); this._died(w); });
    child.on('error', (e) => { w.exited = true; w.spawnError = e.message; this._wake(w); this._died(w); });
    child.on('close', (code) => { w.exited = true; w.code = code; this._wake(w); this._died(w); });
    this.cur = w;
    try {
      const ready = await this._next(w, this.readyMs);
      if (!ready || ready.type !== 'ready' || !validReady(ready)) throw new Error(`no valid ready frame (${w.stderr.trim().slice(0, 200) || 'process ended'})`);
      const bad = controlsMatch(ready.controls, limits);
      if (bad) throw new Error(`engine controls do not match requested limits: ${bad}`);
      w.ready = ready;
    } catch (e) {
      const c = await this._retire(w);
      if (this.cur === w) this.cur = null;
      if (!c.confirmed) this._set('cleanup-unconfirmed', { reason: `could not confirm removal of ${w.name}; remove it manually: docker rm -f ${w.name}`, imageId });
      else this._set('unavailable', { reason: `Engine did not become ready: ${e.message}. Press Retry.`, imageId });
      return this.getStatus();
    }
    if (this.stopped || this.cur !== w || w.exited) { await this._retire(w); if (this.cur === w) this.cur = null; if (!this.stopped) this._set('unavailable', { reason: 'Engine exited during startup. Press Retry.', imageId }); return this.getStatus(); }
    this.activeLimits = limits;
    this._set('ready', { languages: w.ready.languages, imageId, controls: w.ready.controls });
    w.idle = setTimeout(() => { if (this.cur === w && this.status.state === 'ready') this._idleExpire(w, imageId); }, this.idleMs);
    if (w.idle.unref) w.idle.unref();
    return this.getStatus();
  }
  async _idleExpire(w, imageId) {
    this._set('stopping', { imageId }); // leaves 'ready' BEFORE awaiting Docker: a Run at the boundary cannot start
    const c = await this._retire(w);
    if (this.cur === w) this.cur = null;
    if (c.confirmed) this._set('unavailable', { reason: 'Idle engine expired after 120 s. Press Retry to prepare a fresh one.', imageId });
    else this._set('cleanup-unconfirmed', { reason: `could not confirm removal of ${w.name}; remove it manually: docker rm -f ${w.name}`, imageId });
  }
  /** The prepared child died by itself: invalidate readiness immediately and clean up. */
  _died(w) {
    if (this.cur === w && this.status.state === 'ready') {
      const imageId = this.status.imageId;
      this._set('stopping', { imageId });
      this._retire(w).then((c) => {
        if (this.cur === w) this.cur = null;
        if (this.stopped) return;
        if (c.confirmed) this._set('unavailable', { reason: 'Engine process exited unexpectedly while idle. Press Retry.', imageId });
        else this._set('cleanup-unconfirmed', { reason: `could not confirm removal of ${w.name}`, imageId });
      }).catch(() => {});
    }
  }

  _pump(w) {
    let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i); w.buf = w.buf.slice(i + 1);
      if (line.length > MAX_LINE) { w.overflow = true; this._kill(w); return; }
      let f; try { f = JSON.parse(line); } catch { f = { type: '__malformed' }; }
      w.qBytes += line.length;
      if (w.frames.length >= MAX_FRAMES || w.qBytes > MAX_QUEUED_BYTES) { w.overflow = true; w.frames.length = 0; w.qBytes = 0; w.buf = ''; this._kill(w); this._wake(w); return; }
      w.frames.push(f);
    }
    this._wake(w);
  }
  _wake(w) { if (w.waiter) { const fn = w.waiter; w.waiter = null; fn(); } }
  /** next frame, or null on exit/overflow; throws on timeout */
  _next(w, ms) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (w.overflow) { clearTimeout(t); resolve(null); return true; }
        if (w.frames.length) { clearTimeout(t); resolve(w.frames.shift()); return true; }
        if (w.exited) { clearTimeout(t); resolve(null); return true; }
        return false;
      };
      const t = setTimeout(() => { w.waiter = null; reject(new Error(`timed out after ${ms} ms`)); }, ms);
      const arm = () => { w.waiter = () => { if (!check()) arm(); }; };
      if (!check()) arm();
    });
  }
  _kill(w) {
    try { w.child.kill('SIGKILL'); } catch { /* ignore */ }
    try { Promise.resolve(this.docker(['kill', w.name], 3000)).catch(() => {}); } catch { /* ignore */ }
  }

  /** Remove one owned container within ONE total budget; never throws. */
  async _cleanup(w) {
    clearTimeout(w.idle);
    const t0 = Date.now();
    const left = () => Math.max(300, this.cleanupMs - (Date.now() - t0));
    let oom = null, confirmed = false;
    try {
      const ins = await this.docker(['inspect', '--format', '{{.State.OOMKilled}}', w.name], Math.min(3000, left()));
      if (ins.code === 0) oom = ins.stdout.trim() === 'true';
    } catch { /* evidence unavailable */ }
    try {
      this._kill(w);
      const rm = await this.docker(['rm', '-f', w.name], left());
      const chk = await this.docker(['ps', '-aq', '--filter', `name=^${w.name}$`], Math.min(3000, left()));
      confirmed = rm.code === 0 && chk.code === 0 && chk.stdout.trim() === '';
    } catch { confirmed = false; }
    return { confirmed, oomKilled: oom, ms: Date.now() - t0, container: w.name };
  }
  _retire(w) { if (!w.retiring) w.retiring = this._cleanup(w); return w.retiring; }

  /** Serialized shutdown: reject new work, remove owned container(s), no reprepare. Idempotent. */
  stop() {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = (async () => {
      const prev = this.status.imageId;
      if (this.runCtl) this.runCtl.cancelled = true;
      if (this.status.state !== 'busy') this._set('stopping', { imageId: prev });
      if (this.starting) { try { await this.starting; } catch { /* ignore */ } }
      let ok = true;
      const w = this.cur;
      if (w) { this._kill(w); const c = await this._retire(w); ok = c.confirmed; }
      if (!(await this._sweepStale())) ok = false;
      this.cur = null;
      this._set(ok ? 'unavailable' : 'cleanup-unconfirmed', { reason: ok ? 'backend stopped' : 'shutdown could not confirm container removal', imageId: prev });
      return { confirmed: ok };
    })();
    return this.stopping;
  }

  cancel() { const w = this.cur; if (w && this.runCtl) { this.runCtl.cancelled = true; this._kill(w); return true; } return false; }

  /** One job on the prepared engine. Settles exactly once; never throws. */
  async run(args) {
    try { return await this._run(args); } catch (e) {
      const w = this.cur; let cleanup = { confirmed: false, oomKilled: null };
      if (w) { try { cleanup = await this._retire(w); } catch { /* ignore */ } if (this.cur === w) this.cur = null; }
      this.runCtl = null; this.activeLimits = null;
      this._postRun(w, cleanup);
      return { ok: false, kind: 'INFRA_ERROR', message: `internal error: ${String(e && e.message || e).slice(0, 200)}`, cleanup, oomKilled: cleanup.oomKilled };
    }
  }
  _postRun(w, cleanup) {
    if (this.stopped) return;
    if (!cleanup.confirmed) this._set('cleanup-unconfirmed', { reason: `could not confirm removal of ${w && w.name}; remove it manually: docker rm -f ${w && w.name}`, imageId: this.status.imageId });
    else this.start().catch(() => {});
  }
  async _run({ jobId, language, source, cases, limits }) {
    const w = this.cur;
    if (this.stopped || !w || w.exited || this.status.state !== 'ready') return { ok: false, kind: 'BACKEND_UNAVAILABLE', message: `backend is ${this.status.state}` };
    clearTimeout(w.idle);
    const imageId = this.status.imageId;
    this._set('busy', { imageId });
    const ctl = (this.runCtl = { cancelled: false });
    let outcome;
    const engine = { cases: [] };
    const t0 = Date.now();
    const deadline = limits.jobMs + 3000;
    const capBytes = limits.outputBytes;
    try {
      await new Promise((resolve, reject) => {
        const frame = `${JSON.stringify({ v: 1, type: 'run', jobId, language, source, cases, limits: { caseMs: limits.caseMs, compileMs: limits.compileMs, jobMs: limits.jobMs, outputBytes: limits.outputBytes } })}\n`;
        w.child.stdin.once('error', reject); // async EPIPE surfaces here as well as in the write callback
        w.child.stdin.write(frame, (err) => (err ? reject(err) : resolve()));
      });
      let expectIdx = 0, sawCompile = false, aggregate = 0;
      for (;;) {
        const left = deadline - (Date.now() - t0);
        if (ctl.cancelled) { outcome = { ok: false, kind: 'CANCELLED', message: 'cancelled' }; break; }
        if (left <= 0) { outcome = { ok: false, kind: 'WATCHDOG', message: `job watchdog fired after ${deadline} ms; container killed` }; break; }
        let f;
        try { f = await this._next(w, left); } catch { outcome = { ok: false, kind: 'WATCHDOG', message: `job watchdog fired after ${deadline} ms; container killed` }; break; }
        if (ctl.cancelled) { outcome = { ok: false, kind: 'CANCELLED', message: 'cancelled' }; break; }
        if (f === null) { outcome = { ok: false, kind: 'INFRA_ERROR', message: w.overflow ? 'protocol queue/line exceeded limit' : w.stdinError ? `engine pipe error: ${w.stdinError}` : `engine exited unexpectedly (code ${w.code})` }; break; }
        if (!f || f.v !== 1 || f.jobId !== jobId) { outcome = { ok: false, kind: 'INFRA_ERROR', message: `unexpected frame ${String(f && f.type).slice(0, 20)}` }; break; }
        if (f.type === 'compile') {
          const okc = typeof f.ok === 'boolean' && typeof f.timedOut === 'boolean' && (f.output === undefined || strBytes(f.output) >= 0) && !sawCompile && expectIdx === 0;
          if (!okc || strBytes(f.output || '') > capBytes) { outcome = { ok: false, kind: 'INFRA_ERROR', message: 'malformed compile frame' }; break; }
          sawCompile = true; engine.compile = { ok: f.ok, timedOut: f.timedOut, output: String(f.output || ''), elapsedMs: Number(f.elapsedMs) || 0 }; continue;
        }
        if (f.type === 'case') {
          const good = expectIdx < cases.length && f.id === cases[expectIdx].id && !(engine.compile && engine.compile.ok === false)
            && typeof f.stdout === 'string' && typeof f.stderr === 'string' && (f.exitCode === null || isInt(f.exitCode)) && (f.signal === null || typeof f.signal === 'string')
            && typeof f.timedOut === 'boolean' && typeof f.outputLimit === 'boolean' && Number.isFinite(f.elapsedMs) && f.elapsedMs >= 0;
          const n = good ? strBytes(f.stdout) + strBytes(f.stderr) : 0;
          if (!good || n > capBytes) { outcome = { ok: false, kind: 'INFRA_ERROR', message: good ? 'case output exceeded the requested byte limit' : 'out-of-order or malformed case frame' }; break; }
          aggregate += n;
          if (aggregate > 1048576 + capBytes) { outcome = { ok: false, kind: 'INFRA_ERROR', message: 'aggregate output exceeded host bound' }; break; }
          engine.cases.push({ id: f.id, stdout: f.stdout, stderr: f.stderr, exitCode: f.exitCode, signal: f.signal, elapsedMs: f.elapsedMs, timedOut: f.timedOut, outputLimit: f.outputLimit });
          expectIdx += 1; continue;
        }
        if (f.type === 'done') {
          if (!DONE_REASONS.has(f.reason)) { outcome = { ok: false, kind: 'INFRA_ERROR', message: 'unknown done reason' }; break; }
          if ((f.reason === 'compile-error') !== !!(engine.compile && engine.compile.ok === false)) { outcome = { ok: false, kind: 'INFRA_ERROR', message: 'contradictory compile/done frames' }; break; }
          if (f.reason === 'complete' && expectIdx !== cases.length) { outcome = { ok: false, kind: 'INFRA_ERROR', message: 'complete reported with missing cases' }; break; }
          engine.reason = f.reason; outcome = { ok: true, engine }; break;
        }
        outcome = { ok: false, kind: 'INFRA_ERROR', message: `out-of-order or malformed ${String(f.type).slice(0, 20)} frame` }; break;
      }
    } catch (e) {
      outcome = { ok: false, kind: 'INFRA_ERROR', message: `engine write failed: ${String(e && e.message).slice(0, 200)}` };
    }
    const cleanup = await this._retire(w);
    if (this.cur === w) this.cur = null;
    this.runCtl = null; this.activeLimits = null;
    outcome.cleanup = cleanup; outcome.oomKilled = cleanup.oomKilled;
    this._postRun(w, cleanup);
    return outcome;
  }
}

module.exports = { Backend, buildRunArgs, validateLimits, controlsMatch, DEFAULT_LIMITS, RANGES };
