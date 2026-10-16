'use strict';
// Local-web transport: Node stdlib only, loopback only, per-launch capability, fixed asset + method allowlists.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServices, invoke } = require('../main/services.cjs');

const MAX_BODY = 11 * 1024 * 1024; // 5 MiB pack (JSON-escaped worst case) + envelope
const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/bridge.js': ['bridge.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const API = ['catalog.list', 'catalog.get', 'packs.import', 'packs.reload', 'draft.load', 'draft.save', 'backend.status', 'backend.retry', 'settings.get', 'settings.update', 'execution.start', 'execution.get', 'execution.cancel', 'execution.active'];
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SEC = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };

const LOCK_NAME = 'server.lock';
const lockErr = (message) => { const err = new Error(message); err.code = 'LOCKED'; return err; };
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } }
/** Complete lock record, or null when unreadable/incomplete/ambiguous (callers then FAIL CLOSED; never delete). */
function readLock(f) {
  let raw, fd;
  try {
    // F1: never block on a special file: lstat first (non-regular => unreadable => fail closed), then O_NONBLOCK|O_NOFOLLOW + fstat.
    if (!fs.lstatSync(f).isFile()) return null;
    fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd); if (!st.isFile() || st.size > 4096) return null;
    raw = fs.readFileSync(fd, 'utf8');
  } catch (e) { return e.code === 'ENOENT' ? { missing: true } : null; } finally { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ } }
  let o; try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object' || !Number.isInteger(o.pid) || o.pid <= 0 || (o.nonce !== undefined && (typeof o.nonce !== 'string' || o.nonce.length > 64))) return null;
  return { pid: o.pid, nonce: o.nonce };
}
/** Publish a COMPLETE record atomically: write a private temp file, then link() it into place (fails with EEXIST if taken). */
function publish(target, rec) {
  const tmp = `${target}.${process.pid}.${rec.nonce}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec), { flag: 'wx', mode: 0o600 });
  try { fs.linkSync(tmp, target); } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}
const sameOwner = (a, b) => a && b && a.pid === b.pid && a.nonce === b.nonce;
function unlinkIfOwner(file, mine) { const cur = readLock(file); if (cur && !cur.missing && sameOwner(cur, mine)) { try { fs.unlinkSync(file); return true; } catch { /* ignore */ } } return false; }

/** Ownership-safe data-dir lock. Returns {file,pid,nonce}. Throws code LOCKED when held, incomplete or contended (fails closed). */
function acquireLock(userData) {
  fs.mkdirSync(path.dirname(userData), { recursive: true });
  try { fs.mkdirSync(userData, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const st = fs.lstatSync(userData); if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('data directory must be a real directory (symlinks are refused)');
  const file = path.join(userData, LOCK_NAME); const mine = { pid: process.pid, nonce: crypto.randomBytes(16).toString('hex') };
  try { publish(file, mine); return { file, ...mine }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const seen = readLock(file);
  if (seen && seen.missing) { try { publish(file, mine); return { file, ...mine }; } catch (e) { if (e.code === 'EEXIST') throw lockErr('data directory lock is contended; try again'); throw e; } }
  if (!seen) throw lockErr(`${LOCK_NAME} is incomplete or unreadable; not removing it automatically. If no MeCode server is running, delete ${file} yourself`);
  if (pidAlive(seen.pid)) throw lockErr(`data directory is in use by another MeCode server (pid ${seen.pid}); stop it first`);
  // stale owner: takeover is serialized by a second exclusive lock so two reclaimers can never delete each other's replacement
  const reclaim = path.join(userData, `${LOCK_NAME}.reclaim`);
  try { publish(reclaim, mine); } catch (e) { if (e.code === 'EEXIST') throw lockErr(`another process is reclaiming the lock (or crashed doing so); if none is running delete ${reclaim}`); throw e; }
  try {
    const again = readLock(file);
    if (!again || again.missing || !sameOwner(again, seen) || pidAlive(again.pid)) throw lockErr('data directory lock changed while reclaiming; try again');
    fs.unlinkSync(file);
    try { publish(file, mine); } catch (e) { if (e.code === 'EEXIST') throw lockErr('data directory lock was taken by another process'); throw e; }
    return { file, ...mine };
  } finally { unlinkIfOwner(reclaim, mine); }
}
/** Remove the lock only if it is still OUR record. */
function releaseLock(lock) { if (lock) unlinkIfOwner(lock.file, lock); }

/** Create/replace a secret file: never follows a symlink, ends up regular with mode 0600. */
function writeSecretFile(file, text) {
  let st = null; try { st = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`launch file not writable: ${e.code}`); }
  if (st && !st.isFile()) throw new Error('launch file path is not a regular file (symlinks are refused)');
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ } try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw new Error(`launch file not writable: ${e.code || 'error'}`); }
}

/** Everything after the lock is guarded: on ANY startup failure stop owned services/listener and release only OUR lock. */
async function startWeb(opts) {
  const lock = acquireLock(opts.userData);
  const own = { services: null, server: null };
  try { return await startLocked(opts, lock, own); } catch (e) {
    try { if (own.server && own.server.listening) await new Promise((resolve) => { own.server.close(() => resolve()); own.server.closeAllConnections(); }); } catch { /* ignore */ }
    try { if (own.services) await own.services.shutdown(); } catch { /* ignore */ }
    releaseLock(lock);
    throw e;
  }
}

async function startLocked({ userData, appRoot, port = 0, backendOpts = {}, autostart = true, launchFile = null, image }, lock, own) {
  const services = await createServices({ userData, appRoot, backendOpts, autostart, image }); own.services = services;
  const rdir = path.join(appRoot, 'src', 'renderer');
  const assets = new Map();
  for (const [url, [file, type]] of Object.entries(ASSETS)) assets.set(url, { body: fs.readFileSync(path.join(rdir, file)), type });
  const token = crypto.randomBytes(32).toString('hex');
  const tokenBuf = Buffer.from(token);
  let origin = null; let hostHeader = null; let closing = null;

  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code, { ...SEC, 'Content-Type': type, 'Content-Length': b.length, ...extra });
    res.end(b);
  };
  const deny = (res, code, message) => send(res, code, { ok: false, error: { code: code === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message } });

  const server = http.createServer((req, res) => {
    // Host: exact canonical host:port (blocks DNS rebinding); forwarded headers are never consulted
    if (req.headers.host !== hostHeader) return deny(res, 403, 'bad host');
    const url = req.url || '';
    if (req.method === 'GET' || req.method === 'HEAD') {
      const a = Object.hasOwn(ASSETS, url) ? assets.get(url) : null;
      if (!a) return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } });
      res.writeHead(200, { ...SEC, 'Content-Type': a.type, 'Content-Length': a.body.length });
      return res.end(req.method === 'HEAD' ? undefined : a.body);
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } }, undefined, { Allow: 'GET, HEAD, POST' });
    if (!url.startsWith('/api/') || url.includes('?') || url.includes('#')) return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } });
    const method = url.slice(5);
    const isShutdown = method === 'server.shutdown';
    if (!isShutdown && !API.includes(method)) return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'unknown method' } });
    if (req.headers.origin !== origin) return deny(res, 403, 'bad origin');
    const sfs = req.headers['sec-fetch-site']; if (sfs !== undefined && sfs !== 'same-origin') return deny(res, 403, 'cross-site request');
    const supplied = Buffer.from(String(req.headers['x-mecode-session'] || ''));
    if (supplied.length !== tokenBuf.length || !crypto.timingSafeEqual(supplied, tokenBuf)) return deny(res, 401, 'missing or wrong session capability');
    const ct = String(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
    if (ct !== 'application/json') return send(res, 415, { ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'application/json required' } });
    const declared = Number(req.headers['content-length']);
    if (!Number.isFinite(declared) || declared > MAX_BODY) return send(res, 413, { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'body too large or length missing' } }, undefined, { Connection: 'close' });
    const chunks = []; let n = 0; let dead = false;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY && !dead) { dead = true; send(res, 413, { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'body too large' } }, undefined, { Connection: 'close' }); req.destroy(); } else if (!dead) chunks.push(c); });
    req.on('error', () => { dead = true; });
    req.on('end', async () => {
      if (dead) return;
      let arg;
      try { arg = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(res, 400, { ok: false, error: { code: 'INVALID_INPUT', message: 'invalid JSON' } }); }
      if (isShutdown) { send(res, 200, { ok: true, value: { stopping: true } }); setImmediate(() => close().then((r) => process.emit('mecode:stopped', r))); return; }
      const out = await invoke(services.handlers, method, arg);
      send(res, 200, out);
    });
  });
  own.server = server;
  server.headersTimeout = 10000; server.requestTimeout = 30000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 50;
  server.on('clientError', (err, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
  const actual = server.address().port;
  origin = `http://127.0.0.1:${actual}`; hostHeader = `127.0.0.1:${actual}`;
  const launchUrl = `${origin}/#s=${token}`;
  let wroteLaunch = false;
  if (launchFile) { writeSecretFile(launchFile, `${launchUrl}\n`); wroteLaunch = true; }

  function close() {
    if (closing) return closing;
    closing = (async () => {
      const r = await services.shutdown();                 // 1) stop backend: no new workers, owned containers removed
      await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); // 2) stop listening
      releaseLock(lock);
      if (wroteLaunch) { try { if (fs.lstatSync(launchFile).isFile()) fs.unlinkSync(launchFile); } catch { /* ignore */ } }
      return r;
    })();
    return closing;
  }
  return { origin, port: actual, token, launchUrl, services, close, server, dataDir: userData };
}

module.exports = { startWeb, acquireLock, releaseLock, API, ASSETS, CSP };

if (require.main === module) {
  const appRoot = path.join(__dirname, '..', '..');
  const os = require('node:os');
  const dataDir = process.env.MECODE_USER_DATA || (process.platform === 'win32' ? path.join(process.env.APPDATA || os.homedir(), 'MeCode-V2') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'MeCode-V2') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'MeCode-V2'));
  const portEnv = process.env.MECODE_PORT ? Number(process.env.MECODE_PORT) : 0;
  startWeb({ userData: dataDir, appRoot, port: portEnv, launchFile: process.env.MECODE_LAUNCH_FILE || null }).then((w) => {
    console.log(`MeCode V2 (local web) pid ${process.pid}`);
    console.log(`data directory: ${dataDir}`);
    console.log(`managed packs : ${path.join(dataDir, 'packs')}`);
    console.log(`Open this launch link in your browser (contains the session secret; do not share):\n  ${w.launchUrl}`);
    console.log('Stop with Ctrl-C (SIGINT/SIGTERM) or the Quit button; closing the browser tab does NOT stop the server.');
    let stopping = false;
    const stop = (sig) => { if (stopping) return; stopping = true; console.log(`stopping (${sig})...`); const t = setTimeout(() => process.exit(2), 15000); t.unref(); w.close().then((r) => { console.log(`stopped; container removal confirmed: ${r.confirmed}`); process.exit(r.confirmed ? 0 : 3); }); };
    process.on('SIGINT', () => stop('SIGINT')); process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('mecode:stopped', (r) => { console.log(`stopped via Quit; container removal confirmed: ${r && r.confirmed}`); process.exit(r && r.confirmed ? 0 : 3); });
  }).catch((e) => { console.error(`cannot start: ${e.message}`); process.exit(1); });
}
