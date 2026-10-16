'use strict';
// Transport-independent service layer: used by BOTH the Electron IPC wrapper and the local-web server.
// Every handler takes one plain object, validates it strictly, and returns a plain value or throws AppError.
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./store.cjs');
const { AppError, atomicWrite, safeRead } = require('./safefs.cjs');
const { Catalog } = require('./catalog.cjs');
const { Backend, validateLimits } = require('./backend.cjs');
const { Executor } = require('./exec.cjs');
const { LANGS } = require('../shared/validate.cjs');

const MAX_SOURCE = 128 * 1024;
const MAX_PACK = 5 * 1024 * 1024;

/** strict arg object: only the listed fields, each of the given type; optional fields end with '?' */
function args(a, spec) {
  if (a === undefined) a = {};
  if (a === null || typeof a !== 'object' || Array.isArray(a)) throw new AppError('INVALID_INPUT', 'arguments must be an object');
  for (const k of Object.keys(a)) if (!Object.hasOwn(spec, k) && !Object.hasOwn(spec, `${k}?`)) throw new AppError('INVALID_INPUT', `unexpected field ${k.slice(0, 40)}`);
  const out = {};
  for (const [name, t] of Object.entries(spec)) {
    const opt = name.endsWith('?'); const k = opt ? name.slice(0, -1) : name;
    if (!Object.hasOwn(a, k) || a[k] === undefined) { if (!opt) throw new AppError('INVALID_INPUT', `${k} is required`); continue; }
    const v = a[k];
    if (t === 'integer' ? !Number.isSafeInteger(v) : typeof v !== t) throw new AppError('INVALID_INPUT', `${k} must be ${t}`);
    out[k] = v;
  }
  return out;
}
const lang = (l) => { if (!LANGS.includes(l)) throw new AppError('INVALID_INPUT', 'bad language'); return l; };
const short = (s, n) => { if (s.length > n) throw new AppError('INVALID_INPUT', 'value too long'); return s; };

async function createServices({ userData, appRoot, image = process.env.MECODE_ENGINE_IMAGE || 'mecode-engine:v2', backendOpts = {}, autostart = true }) {
  const store = new Store(userData); await store.init(); // confines + creates the data root
  const settingsFile = path.join(userData, 'settings.json');
  let limits = {}; let settingsWarning = null;
  try { limits = validateLimits(JSON.parse(await safeRead(settingsFile)).limits); } catch (e) { if (e.code !== 'ENOENT') settingsWarning = `settings.json ignored (${String(e.message).slice(0, 120)}); defaults in use`; limits = validateLimits({}); }
  const catalog = new Catalog(path.join(userData, 'packs'), path.join(userData, 'last-good.json'), { seedDir: path.join(appRoot, 'packs') });
  await catalog.init();
  const backend = new Backend({ installId: store.installId, image, limits, ...backendOpts });
  const exec = new Executor({ catalog, store, backend });
  if (autostart) backend.start().catch(() => {});

  const withStatus = (p) => ({ ...p, status: store.statusOf(p.key, p.contentHash) });
  const handlers = {
    'catalog.list': (a) => { args(a, {}); const l = catalog.list(); return { ...l, error: catalog.lastError, warning: [store.warning, settingsWarning].filter(Boolean).join(' | ') || null, packsDir: catalog.packsDir, problems: l.problems.map(withStatus) }; },
    'catalog.get': (a) => { const { key } = args(a, { key: 'string' }); short(key, 200); const p = catalog.getPublic(key); if (!p) throw new AppError('NOT_FOUND', 'unknown problem'); return withStatus(p); },
    'packs.import': async (a) => {
      const { jsonText, replace } = args(a, { jsonText: 'string', 'replace?': 'boolean' });
      if (Buffer.byteLength(jsonText) > MAX_PACK) throw new AppError('INVALID_INPUT', 'pack larger than 5 MiB');
      const r = await catalog.import(jsonText, replace === true); if (!r.ok) throw new AppError(r.error.code, r.error.message, r.error.details); return r;
    },
    'packs.reload': async (a) => { args(a, {}); const r = await catalog.reload(); if (!r.ok) throw new AppError(r.error.code, r.error.message, r.error.details); return r; },
    'draft.load': (a) => { const o = args(a, { key: 'string', language: 'string' }); return store.loadDraft(short(o.key, 200), lang(o.language)); },
    'draft.save': (a) => { const o = args(a, { key: 'string', language: 'string', source: 'string', baseRevision: 'integer' }); return store.saveDraft(short(o.key, 200), lang(o.language), o.source, o.baseRevision); },
    'backend.status': (a) => { args(a, {}); return backend.getStatus(); },
    'backend.retry': async (a) => { args(a, {}); return backend.retry(); },
    'settings.get': (a) => { args(a, {}); return { limits: backend.limits, ranges: require('./backend.cjs').RANGES }; },
    'settings.update': async (a) => {
      const o = args(a, { limits: 'object' });
      const next = await backend.updateLimits(o.limits, (cand) => atomicWrite(settingsFile, JSON.stringify({ limits: cand })));
      return { limits: next };
    },
    'execution.start': (a) => {
      const o = args(a, { key: 'string', contentHash: 'string', language: 'string', source: 'string', mode: 'string', 'customInput?': 'string' });
      if (Buffer.byteLength(o.source) > MAX_SOURCE) throw new AppError('INVALID_INPUT', 'source must be up to 128 KiB');
      return exec.start({ ...o, key: short(o.key, 200), contentHash: short(o.contentHash, 100), language: lang(o.language) });
    },
    'execution.get': (a) => exec.get(short(args(a, { jobId: 'string' }).jobId, 80)),
    'execution.cancel': (a) => exec.cancel(short(args(a, { jobId: 'string' }).jobId, 80)),
    'execution.active': (a) => { args(a, {}); return { active: exec.activeJob() }; },
  };
  return {
    handlers, store, catalog, backend, exec,
    shutdown: async () => { const r = await backend.stop(); return r; },
  };
}

/** Run one handler and wrap into the {ok,value}|{ok:false,error} envelope shared by IPC and HTTP. */
async function invoke(handlers, name, arg) {
  if (!Object.hasOwn(handlers, name)) return { ok: false, error: { code: 'NOT_FOUND', message: 'unknown method' } };
  try { return { ok: true, value: await handlers[name](arg) }; } catch (e) {
    if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(e && e.message || e).slice(0, 300) } };
  }
}

module.exports = { createServices, invoke, args };
