'use strict';
// Local-web boundary tests over a REAL bound loopback socket (fake docker/engine behind it = MOCK backend).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { startWeb } = require('../../src/web/server.cjs');

const root = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'w4-'));
function fakeSpawn() {
  return () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => setImmediate(() => { child.stdout.end(); child.emit('close', 137); });
    setImmediate(() => child.stdout.write(`${JSON.stringify({ v: 1, type: 'ready', languages: [{ id: 'python', version: 'fake' }], controls: { memoryMax: String(512 * 1048576), pidsMax: '64', cpuMax: '100000 100000', uid: 65534 } })}\n`));
    return child;
  };
}
const docker = async (args) => (args[0] === 'ps' ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: 'x\n', stderr: '' });
async function boot() {
  const d = tmp();
  return startWeb({ userData: d, appRoot: root, backendOpts: { docker, spawn: fakeSpawn(), readyMs: 500, cleanupMs: 300 } });
}
function req(w, { method = 'POST', url = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: host === undefined ? `127.0.0.1:${w.port}` : host, ...headers };
    const r = http.request({ host: '127.0.0.1', port: w.port, method, path: url, headers: h, setHost: false }, (res) => {
      const bufs = []; res.on('data', (c) => bufs.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bufs).toString('utf8') }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const good = (w, extra = {}) => ({ origin: w.origin, 'x-mecode-session': w.token, 'content-type': 'application/json', ...extra });
const api = (w, name, obj = {}, hdr = {}) => { const b = JSON.stringify(obj); return req(w, { url: `/api/${name}`, headers: good(w, { 'content-length': Buffer.byteLength(b), ...hdr }), body: b }); };

test('web: binds loopback only; serves allowlisted assets with CSP/no-store; no filesystem root', async () => {
  const w = await boot();
  try {
    assert.equal(w.server.address().address, '127.0.0.1');
    const r = await req(w, { method: 'GET', url: '/' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-security-policy'], /default-src 'none'/); assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    for (const u of ['/app.js', '/bridge.js', '/style.css']) assert.equal((await req(w, { method: 'GET', url: u })).status, 200, u);
    for (const u of ['/src/main.cjs', '/../package.json', '/%2e%2e/package.json', '/packs/core.json', '/app.js?x=1', '//etc/passwd', '/api/catalog.list']) assert.equal((await req(w, { method: 'GET', url: u })).status, 404, u);
    assert.equal(r.body.includes(w.token), false);
  } finally { await w.close(); }
});

test('web: bad Host / Origin / token / method / media type / size cannot reach handlers', async () => {
  const w = await boot();
  try {
    const b = '{}';
    const base = { url: '/api/catalog.list', body: b };
    assert.equal((await req(w, { ...base, host: 'evil.example:80', headers: good(w, { 'content-length': 2 }) })).status, 403, 'foreign host');
    assert.equal((await req(w, { ...base, host: '127.0.0.1', headers: good(w, { 'content-length': 2 }) })).status, 403, 'host without port');
    assert.equal((await req(w, { ...base, headers: good(w, { 'x-forwarded-host': `127.0.0.1:${w.port}`, 'content-length': 2 }), host: 'attacker.test' })).status, 403, 'forwarded host ignored');
    for (const o of [undefined, 'null', 'http://evil.example', `http://localhost:${w.port}`, `http://127.0.0.1:${w.port + 1}`]) {
      const h = good(w, { 'content-length': 2 }); if (o === undefined) delete h.origin; else h.origin = o;
      assert.equal((await req(w, { ...base, headers: h })).status, 403, `origin ${o}`);
    }
    const noTok = good(w, { 'content-length': 2 }); delete noTok['x-mecode-session'];
    assert.equal((await req(w, { ...base, headers: noTok })).status, 401);
    assert.equal((await req(w, { ...base, headers: good(w, { 'x-mecode-session': 'a'.repeat(64), 'content-length': 2 }) })).status, 401);
    assert.equal((await req(w, { ...base, headers: good(w, { 'sec-fetch-site': 'cross-site', 'content-length': 2 }) })).status, 403);
    assert.equal((await req(w, { ...base, headers: good(w, { 'content-type': 'application/x-www-form-urlencoded', 'content-length': 2 }) })).status, 415, 'form post');
    assert.equal((await req(w, { ...base, headers: good(w, { 'content-type': 'text/plain', 'content-length': 2 }) })).status, 415);
    assert.equal((await req(w, { method: 'OPTIONS', url: '/api/catalog.list', headers: { origin: 'http://evil.example' } })).status, 405, 'no CORS preflight grant');
    assert.equal((await req(w, { method: 'PUT', url: '/api/catalog.list', body: '{}', headers: good(w) })).status, 405);
    assert.equal((await req(w, { url: '/api/fs.readFile', body: b, headers: good(w, { 'content-length': 2 }) })).status, 404, 'unknown method');
    assert.equal((await req(w, { url: '/api/../catalog.list', body: b, headers: good(w, { 'content-length': 2 }) })).status, 404);
    assert.equal((await req(w, { url: '/api/catalog.list?x=1', body: b, headers: good(w, { 'content-length': 2 }) })).status, 404, 'query');
    assert.equal((await req(w, { ...base, headers: good(w, { 'content-length': 12 * 1024 * 1024 }) })).status, 413, 'oversize declared');
    assert.equal((await req(w, { ...base, headers: good(w) })).status, 413, 'missing content-length');
    const bad = await api(w, 'catalog.get', { key: 'x', extra: 1 }); assert.equal(JSON.parse(bad.body).error.code, 'INVALID_INPUT');
    const ok = await api(w, 'catalog.list'); assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body).ok, true);
    assert.equal(ok.body.includes(w.token), false);
    assert.equal(ok.headers['access-control-allow-origin'], undefined);
  } finally { await w.close(); }
});

test('web: valid session imports an external pack, saves a draft, rejects invalid import and keeps the catalog; data dir lock; shutdown', async () => {
  const w = await boot();
  const dir = w.dataDir;
  try {
    await assert.rejects(() => startWeb({ userData: dir, appRoot: root, backendOpts: { docker, spawn: fakeSpawn() } }), (e) => e.code === 'LOCKED');
    const core = JSON.parse(fs.readFileSync(path.join(root, 'packs', 'core.json'), 'utf8'));
    const ext = { ...core, id: 'external-demo', title: 'External', problems: [{ ...core.problems[0], id: 'ext-one', title: 'Ext One' }] };
    const imp = JSON.parse((await api(w, 'packs.import', { jsonText: JSON.stringify(ext) })).body);
    assert.equal(imp.ok, true, JSON.stringify(imp));
    const list = JSON.parse((await api(w, 'catalog.list')).body).value;
    assert.ok(list.problems.some((p) => p.key === 'external-demo/ext-one'));
    const bad = JSON.parse((await api(w, 'packs.import', { jsonText: '{"nope":1}' })).body);
    assert.equal(bad.ok, false); assert.equal(bad.error.code, 'PACK_INVALID');
    assert.ok(JSON.parse((await api(w, 'catalog.list')).body).value.problems.some((p) => p.key === 'external-demo/ext-one'), 'valid catalog retained');
    const sv = JSON.parse((await api(w, 'draft.save', { key: 'external-demo/ext-one', language: 'python', source: 'print(1)', baseRevision: 0 })).body);
    assert.equal(sv.value.revision, 1);
    const ld = JSON.parse((await api(w, 'draft.load', { key: 'external-demo/ext-one', language: 'python' })).body);
    assert.equal(ld.value.source, 'print(1)');
    const stale = JSON.parse((await api(w, 'draft.save', { key: 'external-demo/ext-one', language: 'python', source: 'x', baseRevision: 0 })).body);
    assert.equal(stale.error.code, 'CONFLICT');
    const shut = JSON.parse((await api(w, 'server.shutdown')).body); assert.equal(shut.ok, true);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fs.existsSync(path.join(dir, 'server.lock')), false, 'lock released');
    await assert.rejects(() => req(w, { method: 'GET', url: '/' }), 'socket closed after shutdown');
  } finally { await w.close(); }
});

test('web: renderer assets contain no external URLs and no inline script', () => {
  for (const f of ['index.html', 'app.js', 'bridge.js', 'style.css']) {
    const t = fs.readFileSync(path.join(root, 'src', 'renderer', f), 'utf8');
    assert.equal(/https?:\/\/(?!127\.0\.0\.1)/.test(t.replace(/\/\/ .*$/gm, '')), false, `${f} references an external URL`);
  }
  assert.equal(/<script(?![^>]*\bsrc=)/.test(fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8')), false, 'inline script');
});
