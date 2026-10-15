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

function acquireLock(userData) {
  const f = path.join(userData, 'server.lock');
  fs.mkdirSync(userData, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { const fd = fs.openSync(f, 'wx', 0o600); fs.writeSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd); return f; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0; try { pid = JSON.parse(fs.readFileSync(f, 'utf8')).pid; } catch { /* corrupt lock */ }
      let alive = false; try { if (Number.isInteger(pid) && pid > 0) { process.kill(pid, 0); alive = true; } } catch (err) { alive = err.code === 'EPERM'; }
      if (alive) { const err = new Error(`data directory is in use by another MeCode server (pid ${pid}); stop it first`); err.code = 'LOCKED'; throw err; }
      fs.rmSync(f, { force: true }); // stale lock from a dead process
    }
  }
  throw new Error('could not acquire data-dir lock');
}

async function startWeb({ userData, appRoot, port = 0, backendOpts = {}, autostart = true, launchFile = null, image }) {
  const lockFile = acquireLock(userData);
  let services;
  try { services = await createServices({ userData, appRoot, backendOpts, autostart, image }); } catch (e) { fs.rmSync(lockFile, { force: true }); throw e; }
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
  server.headersTimeout = 10000; server.requestTimeout = 30000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 50;
  server.on('clientError', (err, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
  const actual = server.address().port;
  origin = `http://127.0.0.1:${actual}`; hostHeader = `127.0.0.1:${actual}`;
  const launchUrl = `${origin}/#s=${token}`;
  if (launchFile) fs.writeFileSync(launchFile, `${launchUrl}\n`, { mode: 0o600 });

  function close() {
    if (closing) return closing;
    closing = (async () => {
      const r = await services.shutdown();                 // 1) stop backend: no new workers, owned containers removed
      await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); // 2) stop listening
      fs.rmSync(lockFile, { force: true });
      if (launchFile) fs.rmSync(launchFile, { force: true });
      return r;
    })();
    return closing;
  }
  return { origin, port: actual, token, launchUrl, services, close, server, dataDir: userData };
}

module.exports = { startWeb, API, ASSETS, CSP };

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
