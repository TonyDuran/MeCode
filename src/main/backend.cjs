'use strict';
// App-owned engine container lifecycle. All docker calls are argv arrays with bounded timeouts and exact names.
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { AppError } = require('./store.cjs');

const APP_LABEL = 'mecode.app=mecode-v2';
const DEFAULT_LIMITS = Object.freeze({ memoryMiB: 512, cpus: 1, pids: 64, caseMs: 2000, compileMs: 10000, jobMs: 30000, outputBytes: 64 * 1024 });
const RANGES = { memoryMiB: [128, 1024], cpus: [0.25, 2], pids: [32, 128], caseMs: [100, 10000], compileMs: [1000, 30000], jobMs: [5000, 120000], outputBytes: [1024, 256 * 1024] };

function validateLimits(input) {
  const out = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(input || {})) {
    if (!(k in RANGES)) throw new AppError('INVALID_INPUT', `unknown limit ${k}`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < RANGES[k][0] || v > RANGES[k][1]) throw new AppError('INVALID_INPUT', `${k} must be within ${RANGES[k].join('..')}`);
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

class Backend extends EventEmitter {
  constructor({ installId, image = 'mecode-engine:v2', spawn = cp.spawn, docker = dockerExec, limits = DEFAULT_LIMITS, readyMs = 20000, idleMs = 120000, cleanupMs = 5000 } = {}) {
    super();
    Object.assign(this, { installId, image, spawn, docker, limits, readyMs, idleMs, cleanupMs });
    this.status = { state: 'checking', languages: [] };
    this.cur = null; this.starting = null;
  }
  _set(state, extra = {}) { this.status = { state, languages: [], ...extra }; this.emit('status', this.status); }
  getStatus() { return { ...this.status, effectiveLimits: this.limits }; }
  setLimits(l) { this.limits = validateLimits(l); }
  retry() { if (this.status.state === 'busy' || this.status.state === 'cleanup-unconfirmed') return this.getStatus(); return this.start(); }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async _start() {
    this._set('checking');
    const v = await this.docker(['version', '--format', '{{.Server.Version}}'], 5000);
    if (v.code !== 0) { this._set('unavailable', { reason: `Docker CLI/daemon not reachable (${(v.stderr || v.error || '').trim().slice(0, 200)}). Install/start Docker (rootless is fine), then press Retry.` }); return this.getStatus(); }
    const img = await this.docker(['image', 'inspect', this.image, '--format', '{{.Id}}'], 5000);
    if (img.code !== 0) { this._set('unavailable', { reason: `Engine image "${this.image}" is not present locally. The app never pulls silently. Build it: docker build -t ${this.image} engine/ (see docs/INSTALL.md), then press Retry.` }); return this.getStatus(); }
    const imageId = img.stdout.trim();
    const stale = await this.docker(['ps', '-aq', '--filter', `label=mecode.install=${this.installId}`], 5000);
    if (stale.code === 0 && stale.stdout.trim()) {
      for (const id of stale.stdout.trim().split(/\s+/)) if (/^[0-9a-f]{6,64}$/.test(id)) await this.docker(['rm', '-f', id], this.cleanupMs);
    }
    this._set('starting', { imageId });
    const name = `mecode-${this.installId.slice(0, 8)}-${crypto.randomBytes(4).toString('hex')}`;
    const child = this.spawn('docker', buildRunArgs({ name, installId: this.installId, image: this.image, limits: this.limits }), { stdio: ['pipe', 'pipe', 'pipe'] });
    const w = { name, child, buf: '', frames: [], waiter: null, exited: false, stderr: '' };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { w.buf += d; if (w.buf.length > MAX_LINE * 2) { w.overflow = true; this._kill(w); return; } this._pump(w); });
    child.stderr.on('data', (d) => { w.stderr = (w.stderr + d).slice(-2000); });
    child.on('error', (e) => { w.exited = true; w.spawnError = e.message; this._wake(w); });
    child.on('close', (code) => { w.exited = true; w.code = code; this._wake(w); });
    this.cur = w;
    try {
      const ready = await this._next(w, this.readyMs);
      if (!ready || ready.type !== 'ready' || !Array.isArray(ready.languages)) throw new Error(`no valid ready frame (${w.stderr.trim().slice(0, 200) || 'process ended'})`);
      w.ready = ready;
    } catch (e) {
      await this._cleanup(w);
      this.cur = null;
      this._set('unavailable', { reason: `Engine did not become ready: ${e.message}. Press Retry.`, imageId });
      return this.getStatus();
    }
    this._set('ready', { languages: w.ready.languages, imageId, controls: w.ready.controls });
    w.idle = setTimeout(() => { if (this.cur === w && this.status.state === 'ready') { this._cleanup(w).then(() => { this.cur = null; this._set('unavailable', { reason: 'Idle engine expired after 120 s. Press Retry to prepare a fresh one.', imageId }); }); } }, this.idleMs);
    w.idle.unref && w.idle.unref();
    return this.getStatus();
  }

  _pump(w) {
    let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i); w.buf = w.buf.slice(i + 1);
      if (line.length > MAX_LINE) { w.overflow = true; this._kill(w); return; }
      let f; try { f = JSON.parse(line); } catch { f = { type: '__malformed' }; }
      w.frames.push(f);
    }
    this._wake(w);
  }
  _wake(w) { if (w.waiter) { const fn = w.waiter; w.waiter = null; fn(); } }
  /** next frame, or null on exit; throws on timeout */
  _next(w, ms) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (w.frames.length) { clearTimeout(t); resolve(w.frames.shift()); return true; }
        if (w.exited) { clearTimeout(t); resolve(null); return true; }
        return false;
      };
      const t = setTimeout(() => { w.waiter = null; reject(new Error(`timed out after ${ms} ms`)); }, ms);
      const arm = () => { w.waiter = () => { if (!check()) arm(); }; };
      if (!check()) arm();
    });
  }
  _kill(w) { try { w.child.kill('SIGKILL'); } catch { /* ignore */ } this.docker(['kill', w.name], 3000).catch(() => {}); }

  async _cleanup(w) {
    clearTimeout(w.idle);
    const t0 = Date.now();
    let oom = null;
    const ins = await this.docker(['inspect', '--format', '{{.State.OOMKilled}}', w.name], 3000);
    if (ins.code === 0) oom = ins.stdout.trim() === 'true';
    this._kill(w);
    const rm = await this.docker(['rm', '-f', w.name], this.cleanupMs);
    const chk = await this.docker(['ps', '-aq', '--filter', `name=^${w.name}$`], 3000);
    const confirmed = rm.code === 0 && chk.code === 0 && chk.stdout.trim() === '';
    return { confirmed, oomKilled: oom, ms: Date.now() - t0, container: w.name };
  }

  cancel() { const w = this.cur; if (w && this.runCtl) { this.runCtl.cancelled = true; this._kill(w); return true; } return false; }

  /** One job on the prepared engine. Returns {ok,engine,cleanup,oomKilled} | {ok:false,kind,message,cleanup}. Settles exactly once. */
  async run({ jobId, language, source, cases, limits }) {
    const w = this.cur;
    if (!w || this.status.state !== 'ready') return { ok: false, kind: 'BACKEND_UNAVAILABLE', message: `backend is ${this.status.state}` };
    clearTimeout(w.idle);
    const imageId = this.status.imageId;
    this._set('busy', { imageId });
    const ctl = (this.runCtl = { cancelled: false });
    let outcome;
    const engine = { cases: [] };
    const deadline = limits.jobMs + 3000;
    try {
      w.child.stdin.write(`${JSON.stringify({ v: 1, type: 'run', jobId, language, source, cases, limits: { caseMs: limits.caseMs, compileMs: limits.compileMs, jobMs: limits.jobMs, outputBytes: limits.outputBytes } })}\n`);
      const t0 = Date.now();
      let expectIdx = 0, sawCompile = false;
      for (;;) {
        const left = deadline - (Date.now() - t0);
        if (ctl.cancelled) { outcome = { ok: false, kind: 'CANCELLED', message: 'cancelled' }; break; }
        let f;
        try { f = await this._next(w, Math.max(1, left)); } catch { outcome = { ok: false, kind: 'WATCHDOG', message: `job watchdog fired after ${deadline} ms; container killed` }; break; }
        if (ctl.cancelled) { outcome = { ok: false, kind: 'CANCELLED', message: 'cancelled' }; break; }
        if (f === null) { outcome = { ok: false, kind: 'INFRA_ERROR', message: w.overflow ? 'protocol line exceeded limit' : `engine exited unexpectedly (code ${w.code})` }; break; }
        if (f.v !== 1 || f.jobId !== jobId) { outcome = { ok: false, kind: 'INFRA_ERROR', message: `unexpected frame ${String(f.type).slice(0, 20)}` }; break; }
        if (f.type === 'compile' && !sawCompile && expectIdx === 0 && typeof f.ok === 'boolean') { sawCompile = true; engine.compile = { ok: f.ok, timedOut: !!f.timedOut, output: String(f.output || '').slice(0, limits.outputBytes), elapsedMs: f.elapsedMs }; continue; }
        if (f.type === 'case' && expectIdx < cases.length && f.id === cases[expectIdx].id && typeof f.stdout === 'string' && typeof f.stderr === 'string') {
          engine.cases.push({ id: f.id, stdout: f.stdout, stderr: f.stderr, exitCode: f.exitCode ?? null, signal: f.signal ?? null, elapsedMs: Number(f.elapsedMs) || 0, timedOut: !!f.timedOut, outputLimit: !!f.outputLimit });
          expectIdx += 1; continue;
        }
        if (f.type === 'done') { engine.reason = f.reason; outcome = { ok: true, engine }; break; }
        outcome = { ok: false, kind: 'INFRA_ERROR', message: `out-of-order or malformed ${f.type} frame` }; break;
      }
    } catch (e) {
      outcome = { ok: false, kind: 'INFRA_ERROR', message: `engine write failed: ${e.message}` };
    }
    const cleanup = await this._cleanup(w);
    this.cur = null; this.runCtl = null;
    outcome.cleanup = cleanup; outcome.oomKilled = cleanup.oomKilled;
    if (!cleanup.confirmed) this._set('cleanup-unconfirmed', { reason: `could not confirm removal of ${w.name}; remove it manually: docker rm -f ${w.name}`, imageId });
    else this.start().catch(() => {}); // next fresh single-use engine
    return outcome;
  }
}

module.exports = { Backend, buildRunArgs, validateLimits, DEFAULT_LIMITS, RANGES };
