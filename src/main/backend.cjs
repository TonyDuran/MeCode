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
  return [
    'run',
    '-i',
    '--pull',
    'never',
    '--name',
    name,
    '--label',
    APP_LABEL,
    '--label',
    `mecode.install=${installId}`,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    m,
    '--memory-swap',
    m,
    '--cpus',
    String(limits.cpus),
    '--pids-limit',
    String(limits.pids),
    '--user',
    '65534:65534',
    '--tmpfs',
    '/work:rw,exec,nosuid,size=128m,mode=1777',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m,mode=1777',
    image,
  ];
}

/** `docker create` argv: EXACTLY the buildRunArgs sandbox/security/resource flags, only the verb differs (start -ai attaches later). */
function buildCreateArgs(o) {
  return ['create', ...buildRunArgs(o).slice(1)];
}

/**
 * Bounded `docker create` run as a task-owned CLI in its OWN process group (POSIX), so a TERM sent to the parent/harness group cannot kill a
 * pending create before the daemon replies. The handle is retained (no unref), killed (whole group) on timeout and on parent exit.
 * Resolves { code, stdout, stderr, timedOut, error }. code<0 or timedOut => the daemon outcome is UNKNOWN (never "not created").
 */
const liveCreates = new Set();
let exitHookInstalled = false;
function killGroup(child) {
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
function dockerCreateDetached(args, timeoutMs, bin = 'docker', signal = undefined) {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const c of liveCreates) killGroup(c);
    });
  }
  return new Promise((resolve) => {
    let done = false;
    let stdout = '';
    let stderr = '';
    let child;
    let timer;
    const onAbort = () => {
      // stop-budget expiry: terminate the task-owned client group. The daemon outcome stays UNKNOWN (code -1, never "not created").
      if (child) killGroup(child);
      finish({ code: -1, error: 'docker create aborted (shutdown budget expired)' });
    };
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (child) liveCreates.delete(child);
      resolve({ stdout, stderr, timedOut: false, error: null, ...r });
    };
    if (signal && signal.aborted) return finish({ code: -1, error: 'docker create aborted before launch' }); // never launch after expiry
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      if (child) killGroup(child);
      finish({ code: -1, timedOut: true, error: `docker create timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    try {
      child = cp.spawn(bin, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ code: -1, error: String(e && e.message) });
    }
    liveCreates.add(child);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(0, 4096)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', (e) => finish({ code: -1, error: e.message }));
    child.on('close', (code, signal) => finish({ code: typeof code === 'number' ? code : -1, error: signal ? `signal ${signal}` : null }));
  });
}

function dockerExec(args, timeoutMs) {
  return new Promise((resolve) => {
    cp.execFile('docker', args, { timeout: timeoutMs, maxBuffer: 1 << 20, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr, error: err ? err.message : null });
    });
  });
}

const MAX_LINE = 2 * 1024 * 1024;
/** result of a Docker command that was not issued / not answered because the single stop budget was spent (never a daemon answer) */
const BUDGET_SPENT = { code: -1, stdout: '', stderr: '', error: 'stop budget exhausted' };
/** result of a startup preflight cancelled by stop intent */
const STOP_CANCELLED = { code: -2, stdout: '', stderr: '', error: 'cancelled by stop' };
const MAX_FRAMES = 4096;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const AGGREGATE_BYTES = 1024 * 1024; // declared aggregate output bound (runner.py default agg_cap)
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
  return (
    !!r &&
    r.v === 1 &&
    Array.isArray(r.languages) &&
    r.languages.length > 0 &&
    r.languages.length <= 16 &&
    r.languages.every((l) => l && typeof l.id === 'string' && /^[a-z0-9_-]{1,16}$/.test(l.id) && typeof l.version === 'string' && l.version.length <= 200)
  );
}

class Backend extends EventEmitter {
  /* Declared so the type checker knows the fields assigned via Object.assign below (assigned in the constructor, before use). */
  /** @type {string} */ installId;
  /** @type {string} */ image;
  /** @type {any} */ spawn;
  /** @type {any} */ docker;
  /** @type {any} */ dockerCreate;
  /** @type {number} */ createMs;
  /** @type {any} */ limits;
  /** @type {number} */ readyMs;
  /** @type {number} */ idleMs;
  /** @type {number} */ cleanupMs;
  /** @type {number} */ watchdogGraceMs;
  /** @type {number} */ stopMs;
  /** @param {{installId?: string, image?: string, spawn?: any, docker?: any, dockerCreate?: any, createMs?: number, limits?: any, readyMs?: number, idleMs?: number, cleanupMs?: number, watchdogGraceMs?: number, stopMs?: number}} [opts] */
  constructor({
    installId,
    image = 'mecode-engine:v2',
    spawn = cp.spawn,
    docker = dockerExec,
    dockerCreate,
    createMs = 4000,
    limits = DEFAULT_LIMITS,
    readyMs = 20000,
    idleMs = 120000,
    cleanupMs = 5000,
    watchdogGraceMs = 3000,
    stopMs = 12000, // ONE absolute stop budget; 3 s margin inside the server's unchanged 15000 ms emergency exit
  } = {}) {
    super();
    Object.assign(this, {
      installId,
      image,
      spawn,
      docker,
      dockerCreate: dockerCreate || (docker === dockerExec ? dockerCreateDetached : docker),
      createMs,
      limits,
      readyMs,
      idleMs,
      cleanupMs,
      watchdogGraceMs,
      stopMs,
    });
    /** absolute stop deadline (epoch ms) once stop() is requested; null before */
    this.stopDeadline = null;
    /** true once the stop budget expired: no further Docker command is issued by this backend */
    this.expired = false;
    /** resolved at stop intent: cancels in-flight startup preflights */
    this._stopSig = (() => {
      /** @type {any} */ let resolve;
      const promise = new Promise((r) => (resolve = r));
      return { promise, resolve };
    })();
    /** aborted at stop-budget expiry: terminates task-owned pending create CLIs and refuses to launch new ones */
    this._abort = new AbortController();
    this.status = { state: 'checking', languages: [] };
    this.cur = null;
    /** every worker whose container may exist (or may still be published) until its removal is confirmed; independent of cur */
    this.workers = new Set();
    /** bounded, sanitized lifecycle trace (phase/name/install/state only; no source, URLs or secrets) */
    this.trace = [];
    this.starting = null;
    this.stopped = false;
    this.stopping = null;
    this.runCtl = null;
    this.activeLimits = null;
    this.settingsTx = false;
  }
  _tr(phase, w) {
    this.trace.push({
      t: new Date().toISOString(),
      mono: Math.round(performance.now()),
      phase,
      name: w ? w.name : undefined,
      install: String(this.installId).slice(0, 8),
      create: w ? w.createState : undefined,
    });
    if (this.trace.length > 64) this.trace.shift();
  }
  _set(state, extra = {}) {
    this.status = { state, languages: [], ...extra };
    this.emit('status', this.status);
  }
  getStatus() {
    return { ...this.status, effectiveLimits: this.activeLimits || this.limits, requestedLimits: this.limits };
  }
  retry() {
    if (this.stopped || this.settingsTx || ['busy', 'cleanup-unconfirmed', 'stopping', 'updating-settings'].includes(this.status.state)) return Promise.resolve(this.getStatus());
    return this.start();
  }
  _armIdle(w, imageId) {
    clearTimeout(w.idle);
    w.idle = setTimeout(() => {
      if (this.cur === w && this.status.state === 'ready') this._idleExpire(w, imageId);
    }, this.idleMs);
    if (w.idle.unref) w.idle.unref();
  }

  /** validate -> reserve the transition (before ANY await) -> persist -> adopt -> retire the idle worker so the next one really has the new limits. */
  async updateLimits(candidate, persist) {
    const next = validateLimits(candidate);
    if (this.stopped) throw new AppError('BACKEND_UNAVAILABLE', 'backend is stopped');
    if (this.settingsTx || ['busy', 'starting', 'stopping', 'checking', 'updating-settings'].includes(this.status.state) || this.starting)
      throw new AppError('BUSY', 'cannot change limits while a job runs, the engine is starting or another settings change is in progress');
    this.settingsTx = true; // exclusive from here: Run/Retry/other updates are refused until this settles
    const w0 = this.cur;
    const prev = this.status;
    const imageId = prev.imageId;
    if (w0 && prev.state === 'ready') {
      clearTimeout(w0.idle);
      this._set('updating-settings', { imageId });
    }
    try {
      if (persist) await persist(next); // failure => nothing adopted
    } catch (e) {
      this.settingsTx = false;
      if (!this.stopped && this.status.state === 'updating-settings' && this.cur === w0 && w0 && !w0.exited) {
        this.status = prev;
        this.emit('status', this.status);
        this._armIdle(w0, imageId);
      }
      throw e;
    }
    try {
      if (this.stopped) throw new AppError('BACKEND_UNAVAILABLE', 'backend was stopped during the settings update; limits not adopted');
      this.limits = next;
      if (this.cur) {
        const w = this.cur;
        this.cur = null;
        this._set('stopping', { imageId });
        const c = await this._retire(w);
        if (!c.confirmed) {
          this._set('cleanup-unconfirmed', { reason: `could not confirm removal of ${w.name}`, imageId });
          return next;
        }
        await this.start(true);
      }
      return next;
    } finally {
      this.settingsTx = false;
    }
  }
  setLimits(l) {
    this.limits = validateLimits(l);
  } // pre-start configuration only

  async start(internal = false) {
    if (this.stopped) return this.getStatus();
    if (this.settingsTx && !internal) return this.getStatus();
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  /** Docker call under the single stop budget. Before stop: a plain call. After stop intent: capped by the REMAINING budget, never issued once spent. */
  _dk(args, cap) {
    if (this.stopDeadline === null) return Promise.resolve().then(() => this.docker(args, cap));
    const ms = Math.min(cap, this.stopDeadline - Date.now());
    if (this.expired || ms <= 0) return Promise.resolve(BUDGET_SPENT);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(BUDGET_SPENT), ms);
      Promise.resolve()
        .then(() => this.docker(args, ms))
        .then(
          (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          () => {
            clearTimeout(timer);
            resolve(BUDGET_SPENT);
          },
        );
    });
  }
  /** Startup preflight: like _dk, but a stop request cancels it immediately (the caller re-checks this.stopped before using the result). */
  _pre(args, cap) {
    return Promise.race([this._dk(args, cap), this._stopSig.promise.then(() => STOP_CANCELLED)]);
  }
  /** @param {boolean} [cancellable] startup sweeps are cancelled by stop intent; the shutdown sweep never is (strict final absence). */
  async _sweepStale(cancellable = false) {
    const q = (/** @type {string[]} */ a, /** @type {number} */ c) => (cancellable ? this._pre(a, c) : this._dk(a, c));
    const flt = ['--filter', `label=${APP_LABEL}`, '--filter', `label=mecode.install=${this.installId}`];
    const stale = await q(['ps', '-aq', ...flt], 5000);
    if (stale.code !== 0) return false;
    const ids = stale.stdout.trim() ? stale.stdout.trim().split(/\s+/) : [];
    if (!ids.length) return true;
    for (const id of ids) {
      if (!/^[0-9a-f]{6,64}$/.test(id)) return false;
      if (cancellable && this.stopped) return false; // stop intent: the shutdown sweep owns removal from here
      const rm = await q(['rm', '-f', id], this.cleanupMs);
      if (rm.code !== 0) return false;
    }
    const again = await q(['ps', '-aq', ...flt], 5000);
    return again.code === 0 && again.stdout.trim() === '';
  }
  async _start() {
    if (this.stopped) return this.getStatus();
    this._set('checking');
    const v = await this._pre(['version', '--format', '{{.Server.Version}}'], 5000);
    if (this.stopped) return this.getStatus(); // cancelled by stop: no further preflight, no create
    if (v.code !== 0) {
      this._set('unavailable', { reason: `Docker CLI/daemon not reachable (${(v.stderr || v.error || '').trim().slice(0, 200)}). Install/start Docker (rootless is fine), then press Retry.` });
      return this.getStatus();
    }
    const img = await this._pre(['image', 'inspect', this.image, '--format', '{{.Id}}'], 5000);
    if (this.stopped) return this.getStatus();
    if (img.code !== 0) {
      this._set('unavailable', {
        reason: `Engine image "${this.image}" is not present locally. The app never pulls silently. Offline: import a verified local export (node scripts/provision-engine.cjs import --manifest <path>/manifest.json; see docs/OFFLINE.md). Online: docker build -t ${this.image} engine/ (needs network). Then press Retry.`,
      });
      return this.getStatus();
    }
    const imageId = img.stdout.trim();
    const swept = await this._sweepStale(true);
    if (this.stopped) return this.getStatus();
    if (!swept) {
      this._set('cleanup-unconfirmed', { reason: 'could not confirm removal of stale app-owned containers; inspect with: docker ps -a --filter label=mecode.app=mecode-v2', imageId });
      return this.getStatus();
    }
    if (this.stopped) return this.getStatus();
    const limits = this.limits;
    this._set('starting', { imageId });
    const name = `mecode-${this.installId.slice(0, 8)}-${crypto.randomBytes(4).toString('hex')}`;
    const w = { name, child: null, buf: '', frames: [], sizes: [], qBytes: 0, waiter: null, exited: false, stderr: '', limits, createState: 'none', id: null, createError: '' };
    this.workers.add(w); // retained from BEFORE the create request until removal is confirmed (survives cur being cleared)
    this.cur = w;
    // Creation-completion boundary: bounded `docker create`, awaited to its reply. Cancellation never kills it; it only marks intent (this.stopped).
    w.createState = 'pending';
    this._tr('create-issued', w);
    let cr;
    let createTimer;
    try {
      // No await exists between the `if (this.stopped) return` after the preflights and this synchronous runner call: nothing is created after stop intent.
      // The runner enforces createMs itself; this outer bound only guards an injected/misbehaving runner so shutdown stays bounded (never "not created").
      // The runner is invoked SYNCHRONOUSLY (no await between the gate above and the call); the abort signal terminates a pending create CLI at stop-budget expiry.
      const bound = new Promise((res) => {
        createTimer = setTimeout(() => res({ code: -1, stdout: '', stderr: '', timedOut: true, error: 'create outcome not received in time' }), this.createMs + 250);
      });
      cr = await Promise.race([
        Promise.resolve(this.dockerCreate(buildCreateArgs({ name, installId: this.installId, image: this.image, limits }), this.createMs, undefined, this._abort.signal)),
        bound,
      ]);
    } catch (e) {
      cr = { code: -1, stdout: '', stderr: '', error: String((e && e.message) || e) };
    } finally {
      clearTimeout(createTimer);
    }
    const cid = String((cr && cr.stdout) || '').trim();
    // ONLY exit 0 with a well-formed id proves creation. Every other completion (positive CLI exit incl. transport/response loss and handled
    // signals 128+N, timeout, kill, abort, unreadable id) is UNKNOWN: a CLI exit is not a typed daemon reply, so the daemon may still publish this
    // exact name. No stderr parsing, no "failed => nothing created" inference.
    if (cr && cr.code === 0 && /^[0-9a-f]{12,64}$/.test(cid)) {
      w.createState = 'created';
      w.id = cid;
    } else w.createState = 'unknown';
    w.createError = String((cr && (cr.stderr || cr.error)) || '')
      .trim()
      .slice(0, 200);
    if (w.createState !== 'created' || this.stopped) {
      this._tr(this.stopped ? 'create-settled-stop-intent-no-start' : 'create-settled-not-created', w);
      const c = await this._retire(w); // exact-name removal + absence confirmation; for 'unknown' this can never confirm
      if (this.cur === w) this.cur = null;
      if (!c.confirmed) this._set('cleanup-unconfirmed', { reason: `could not confirm removal of ${w.name}; remove it manually: docker rm -f ${w.name}`, imageId });
      else if (!this.stopped) this._set('unavailable', { reason: `Engine container could not be created (${w.createError || 'docker create failed'}). Press Retry.`, imageId });
      return this.getStatus();
    }
    // no await between the stop-intent check above and the spawn: nothing can launch after stop
    const child = this.spawn('docker', ['start', '-a', '-i', name], { stdio: ['pipe', 'pipe', 'pipe'] });
    this._tr('start-attached', w);
    w.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      w.buf += d;
      if (w.buf.length > MAX_LINE * 2) {
        w.overflow = true;
        this._kill(w);
        return;
      }
      this._pump(w);
    });
    child.stderr.on('data', (d) => {
      w.stderr = (w.stderr + d).slice(-2000);
    });
    child.stdin.on('error', (e) => {
      w.stdinError = e.message;
      w.exited = true;
      this._kill(w);
      this._wake(w);
      this._died(w);
    });
    child.on('error', (e) => {
      w.exited = true;
      w.spawnError = e.message;
      this._wake(w);
      this._died(w);
    });
    child.on('close', (code) => {
      w.exited = true;
      w.code = code;
      this._wake(w);
      this._died(w);
    });
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
    if (this.stopped || this.cur !== w || w.exited) {
      await this._retire(w);
      if (this.cur === w) this.cur = null;
      if (!this.stopped) this._set('unavailable', { reason: 'Engine exited during startup. Press Retry.', imageId });
      return this.getStatus();
    }
    this.activeLimits = limits;
    this._set('ready', { languages: w.ready.languages, imageId, controls: w.ready.controls });
    w.idle = undefined;
    this._armIdle(w, imageId);
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
    if (this.cur === w && ['ready', 'updating-settings'].includes(this.status.state)) {
      const imageId = this.status.imageId;
      this._set('stopping', { imageId });
      this._retire(w)
        .then((c) => {
          if (this.cur === w) this.cur = null;
          if (this.stopped) return;
          if (c.confirmed) this._set('unavailable', { reason: 'Engine process exited unexpectedly while idle. Press Retry.', imageId });
          else this._set('cleanup-unconfirmed', { reason: `could not confirm removal of ${w.name}`, imageId });
        })
        .catch(() => {});
    }
  }

  _pump(w) {
    let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i);
      w.buf = w.buf.slice(i + 1);
      if (line.length > MAX_LINE) {
        w.overflow = true;
        this._kill(w);
        return;
      }
      let f;
      try {
        f = JSON.parse(line);
      } catch {
        f = { type: '__malformed' };
      }
      const n = Buffer.byteLength(line, 'utf8');
      if (w.frames.length >= MAX_FRAMES || w.qBytes + n > MAX_QUEUED_BYTES) {
        w.overflow = true;
        w.frames.length = 0;
        w.sizes.length = 0;
        w.qBytes = 0;
        w.buf = '';
        this._kill(w);
        this._wake(w);
        return;
      }
      w.qBytes += n;
      w.frames.push(f);
      w.sizes.push(n);
    }
    this._wake(w);
  }
  _wake(w) {
    if (w.waiter) {
      const fn = w.waiter;
      w.waiter = null;
      fn();
    }
  }
  _take(w) {
    w.qBytes -= w.sizes.shift();
    return w.frames.shift();
  } // queue accounting follows consumption
  /** next frame, or null on exit/overflow; throws on timeout */
  _next(w, ms) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (w.overflow) {
          clearTimeout(t);
          resolve(null);
          return true;
        }
        if (w.frames.length) {
          clearTimeout(t);
          resolve(this._take(w));
          return true;
        }
        if (w.exited) {
          clearTimeout(t);
          resolve(null);
          return true;
        }
        return false;
      };
      const t = setTimeout(() => {
        w.waiter = null;
        reject(new Error(`timed out after ${ms} ms`));
      }, ms);
      const arm = () => {
        w.waiter = () => {
          if (!check()) arm();
        };
      };
      if (!check()) arm();
    });
  }
  _kill(w) {
    if (!w.child) return; // no attached client yet: a pending create is never killed here (see _start; only the stop-budget abort ends it)
    try {
      w.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      Promise.resolve(this._dk(['kill', w.name], 3000)).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /** Remove one owned container within ONE strict total budget (no minimum after expiry, no new command once spent); never throws. Also capped by the single stop budget when stopping. */
  async _cleanup(w) {
    clearTimeout(w.idle);
    const t0 = Date.now();
    const left = () => Math.min(this.cleanupMs - (Date.now() - t0), this.stopDeadline === null ? Infinity : this.stopDeadline - Date.now());
    const EXHAUSTED = { code: -1, stdout: '', stderr: '', error: 'cleanup budget exhausted' };
    const bounded = (args, cap) => {
      const ms = Math.min(cap, left());
      if (ms <= 0 || this.expired) return Promise.resolve(EXHAUSTED);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(EXHAUSTED), ms);
        Promise.resolve()
          .then(() => this.docker(args, ms))
          .then(
            (r) => {
              clearTimeout(timer);
              resolve(r);
            },
            () => {
              clearTimeout(timer);
              resolve(EXHAUSTED);
            },
          );
      });
    };
    let oom = null,
      confirmed;
    try {
      const ins = await bounded(['inspect', '--format', '{{.State.OOMKilled}}', w.name], Math.min(3000, Math.ceil(this.cleanupMs / 3)));
      if (ins.code === 0) oom = ins.stdout.trim() === 'true';
    } catch {
      /* evidence unavailable */
    }
    try {
      try {
        if (w.child) w.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      if (left() > 0) this._kill(w);
      // 'none': no create was ever issued. 'unknown'/'pending': the daemon may STILL publish this name (a create CLI exit, positive or not, is not
      // a daemon reply), so absence can never be confirmed. Only 'created' (exit 0 + valid id) can be removed and confirmed.
      let removed = true;
      if (w.createState !== 'none') {
        const rm = await bounded(['rm', '-f', w.name], this.cleanupMs);
        removed = rm.code === 0;
      }
      const chk = await bounded(['ps', '-aq', '--filter', `name=^${w.name}$`], 3000);
      confirmed = removed && w.createState !== 'unknown' && w.createState !== 'pending' && chk.code === 0 && chk.stdout.trim() === '';
    } catch {
      confirmed = false;
    }
    return { confirmed, oomKilled: oom, ms: Date.now() - t0, container: w.name };
  }
  _retire(w) {
    if (!w.retiring)
      w.retiring = this._cleanup(w).then((c) => {
        this._tr(c.confirmed ? 'retire-confirmed' : 'retire-UNCONFIRMED', w);
        if (c.confirmed) this.workers.delete(w);
        return c;
      });
    return w.retiring;
  }

  /** Serialized shutdown under ONE absolute budget (stopMs, inside the server's 15000 ms exit): reject new work, cancel startup steps, remove owned container(s), no reprepare. Idempotent. */
  stop() {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopDeadline = Date.now() + this.stopMs;
    this._stopSig.resolve(); // cancels in-flight startup preflights; _start re-checks `stopped` before every further step and before create
    const work = (async () => {
      if (this.runCtl) this.runCtl.cancelled = true;
      if (this.starting && this.cur) this._kill(this.cur); // a worker spawned during startup is killed NOW, not after readyMs
      if (this.status.state !== 'busy') this._set('stopping', { imageId: this.status.imageId });
      if (this.starting) {
        try {
          await this.starting;
        } catch {
          /* ignore */
        }
      }
      let ok = true;
      // Every worker that may still own a container, independent of cur (startup may already have cleared it): an unresolved creation or a
      // failed retirement is combined into the receipt; an empty `ps` below cannot erase it.
      for (const w of [...this.workers]) {
        this._kill(w);
        const c = await this._retire(w);
        if (!c.confirmed) ok = false;
      }
      if (!(await this._sweepStale())) ok = false;
      return ok;
    })();
    work.catch(() => {});
    this.stopping = (async () => {
      const prev = this.status.imageId;
      let timer;
      const expiry = new Promise((res) => {
        timer = setTimeout(() => res('expired'), this.stopMs);
      });
      const r = await Promise.race([work.catch(() => false), expiry]);
      clearTimeout(timer);
      let ok = r === true;
      if (r === 'expired') {
        // Budget spent: nothing more may be issued (BUDGET_SPENT everywhere), a pending create CLI group is terminated, attached clients are killed.
        // Uncertainty stays recorded: every worker whose removal is not confirmed remains in this.workers with its exact name.
        this.expired = true;
        this._abort.abort();
        for (const w of this.workers) {
          try {
            if (w.child) w.child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
        ok = false;
      }
      this.cur = null;
      this._tr(ok ? 'stop-receipt-confirmed' : 'stop-receipt-UNCONFIRMED');
      if (!ok) console.error(`BACKEND-LIFECYCLE-TRACE ${JSON.stringify(this.trace.slice(-24))}`); // bounded, sanitized: phase/name/install/create-state only
      const owned = [...this.workers].map((w) => w.name).join(', ');
      this._set(ok ? 'unavailable' : 'cleanup-unconfirmed', { reason: ok ? 'backend stopped' : `shutdown could not confirm container removal${owned ? ` (owned: ${owned})` : ''}`, imageId: prev });
      return { confirmed: ok };
    })();
    return this.stopping;
  }

  cancel() {
    const w = this.cur;
    if (w && this.runCtl) {
      this.runCtl.cancelled = true;
      this._kill(w);
      return true;
    }
    return false;
  }

  /** One job on the prepared engine. Settles exactly once; never throws. */
  async run(args) {
    try {
      return await this._run(args);
    } catch (e) {
      const w = this.cur;
      let cleanup = { confirmed: false, oomKilled: null };
      if (w) {
        try {
          cleanup = await this._retire(w);
        } catch {
          /* ignore */
        }
        if (this.cur === w) this.cur = null;
      }
      this.runCtl = null;
      this.activeLimits = null;
      this._postRun(w, cleanup);
      return { ok: false, kind: 'INFRA_ERROR', message: `internal error: ${String((e && e.message) || e).slice(0, 200)}`, cleanup, oomKilled: cleanup.oomKilled };
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
    const ctl = (this.runCtl = { cancelled: false, expired: false });
    /** @type {any} */
    let outcome;
    const engine = { cases: [] };
    const t0 = Date.now();
    const deadline = limits.jobMs + this.watchdogGraceMs;
    const capBytes = limits.outputBytes;
    const watchdog = { kind: 'WATCHDOG', message: `job watchdog fired after ${deadline} ms; container killed` };
    // R4: ONE independent absolute deadline, armed BEFORE the write. Expiry is idempotent: it kills the worker and wakes every waiter;
    // settlement below happens exactly once, whatever the write/read state is.
    let expire;
    const expired = new Promise((res) => {
      expire = res;
    });
    const timer = setTimeout(() => {
      if (ctl.expired) return;
      ctl.expired = true;
      this._kill(w);
      this._wake(w);
      expire();
    }, deadline);
    try {
      const frame = `${JSON.stringify({ v: 1, type: 'run', jobId, language, source, cases, limits: { caseMs: limits.caseMs, compileMs: limits.compileMs, jobMs: limits.jobMs, outputBytes: limits.outputBytes } })}\n`;
      const written = new Promise((resolve, reject) => {
        w.child.stdin.once('error', reject); // async EPIPE surfaces here as well as in the write callback
        w.child.stdin.write(frame, (err) => (err ? reject(err) : resolve()));
      });
      written.catch(() => {}); // a write that loses the race to the deadline must not become an unhandled rejection
      await Promise.race([written, expired]);
      let expectIdx = 0,
        sawCompile = false,
        aggregate = 0;
      for (;;) {
        const left = deadline - (Date.now() - t0);
        if (ctl.cancelled) {
          outcome = { ok: false, kind: 'CANCELLED', message: 'cancelled' };
          break;
        }
        if (ctl.expired || left <= 0) {
          outcome = { ok: false, ...watchdog };
          break;
        }
        let f;
        try {
          f = await this._next(w, left);
        } catch {
          outcome = { ok: false, ...watchdog };
          break;
        }
        if (ctl.cancelled) {
          outcome = { ok: false, kind: 'CANCELLED', message: 'cancelled' };
          break;
        }
        if (ctl.expired) {
          outcome = { ok: false, ...watchdog };
          break;
        }
        if (f === null) {
          outcome = {
            ok: false,
            kind: 'INFRA_ERROR',
            message: w.overflow ? 'protocol queue/line exceeded limit' : w.stdinError ? `engine pipe error: ${w.stdinError}` : `engine exited unexpectedly (code ${w.code})`,
          };
          break;
        }
        if (!f || f.v !== 1 || f.jobId !== jobId) {
          outcome = { ok: false, kind: 'INFRA_ERROR', message: `unexpected frame ${String(f && f.type).slice(0, 20)}` };
          break;
        }
        if (f.type === 'compile') {
          const limitOk = f.limit === undefined || f.limit === null || f.limit === 'job' || f.limit === 'compile';
          const okc =
            typeof f.ok === 'boolean' &&
            typeof f.timedOut === 'boolean' &&
            (f.output === undefined || strBytes(f.output) >= 0) &&
            !sawCompile &&
            expectIdx === 0 &&
            limitOk &&
            !(f.ok && f.timedOut) &&
            (f.timedOut ? f.limit === 'job' || f.limit === 'compile' : f.limit === undefined || f.limit === null) &&
            (f.elapsedMs === undefined || (Number.isFinite(f.elapsedMs) && f.elapsedMs >= 0));
          if (!okc || strBytes(f.output || '') > capBytes) {
            outcome = { ok: false, kind: 'INFRA_ERROR', message: 'malformed or contradictory compile frame' };
            break;
          }
          sawCompile = true;
          engine.compile = { ok: f.ok, timedOut: f.timedOut, output: String(f.output || ''), elapsedMs: Number(f.elapsedMs) || 0, limit: f.limit || null };
          continue;
        }
        if (f.type === 'case') {
          const good =
            expectIdx < cases.length &&
            f.id === cases[expectIdx].id &&
            !(engine.compile && engine.compile.ok === false) &&
            typeof f.stdout === 'string' &&
            typeof f.stderr === 'string' &&
            (f.exitCode === null || isInt(f.exitCode)) &&
            (f.signal === null || typeof f.signal === 'string') &&
            typeof f.timedOut === 'boolean' &&
            typeof f.outputLimit === 'boolean' &&
            Number.isFinite(f.elapsedMs) &&
            f.elapsedMs >= 0;
          const n = good ? strBytes(f.stdout) + strBytes(f.stderr) : 0;
          if (!good || n > capBytes) {
            outcome = { ok: false, kind: 'INFRA_ERROR', message: good ? 'case output exceeded the requested byte limit' : 'out-of-order or malformed case frame' };
            break;
          }
          aggregate += n;
          if (aggregate > AGGREGATE_BYTES) {
            outcome = { ok: false, kind: 'INFRA_ERROR', message: 'aggregate output exceeded the declared 1 MiB bound' };
            break;
          }
          engine.cases.push({ id: f.id, stdout: f.stdout, stderr: f.stderr, exitCode: f.exitCode, signal: f.signal, elapsedMs: f.elapsedMs, timedOut: f.timedOut, outputLimit: f.outputLimit });
          expectIdx += 1;
          continue;
        }
        if (f.type === 'done') {
          if (!DONE_REASONS.has(f.reason)) {
            outcome = { ok: false, kind: 'INFRA_ERROR', message: 'unknown done reason' };
            break;
          }
          if ((f.reason === 'compile-error') !== !!(engine.compile && engine.compile.ok === false)) {
            outcome = { ok: false, kind: 'INFRA_ERROR', message: 'contradictory compile/done frames' };
            break;
          }
          if (f.reason === 'complete' && expectIdx !== cases.length) {
            outcome = { ok: false, kind: 'INFRA_ERROR', message: 'complete reported with missing cases' };
            break;
          }
          if (w.frames.length > 0 || w.buf.length > 0) {
            outcome = { ok: false, kind: 'INFRA_ERROR', message: 'frames after done (duplicate, malformed or trailing data)' };
            break;
          }
          engine.reason = f.reason;
          outcome = { ok: true, engine };
          break;
        }
        outcome = { ok: false, kind: 'INFRA_ERROR', message: `out-of-order or malformed ${String(f.type).slice(0, 20)} frame` };
        break;
      }
      if (!outcome) outcome = { ok: false, ...watchdog }; // deadline won while the frame was still being written
    } catch (e) {
      outcome = ctl.expired ? { ok: false, ...watchdog } : { ok: false, kind: 'INFRA_ERROR', message: `engine write failed: ${String(e && e.message).slice(0, 200)}` };
    } finally {
      clearTimeout(timer);
    }
    const cleanup = await this._retire(w);
    if (this.cur === w) this.cur = null;
    this.runCtl = null;
    this.activeLimits = null;
    outcome.cleanup = cleanup;
    outcome.oomKilled = cleanup.oomKilled;
    this._postRun(w, cleanup);
    return outcome;
  }
}

module.exports = { Backend, buildRunArgs, buildCreateArgs, dockerCreateDetached, validateLimits, controlsMatch, DEFAULT_LIMITS, RANGES };
