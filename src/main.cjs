'use strict';
const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { Store, AppError } = require('./main/store.cjs');
const { Catalog } = require('./main/catalog.cjs');
const { Backend, validateLimits } = require('./main/backend.cjs');
const { Executor } = require('./main/exec.cjs');
const { LANGS } = require('./shared/validate.cjs');
const fs = require('node:fs');

if (process.env.MECODE_USER_DATA) app.setPath('userData', process.env.MECODE_USER_DATA);
else app.setPath('userData', path.join(app.getPath('appData'), 'MeCode-V2'));

const wrap = (fn) => async (_e, arg) => {
  try { return { ok: true, value: await fn(arg === undefined ? {} : arg) }; }
  catch (e) {
    if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(e && e.message || e) } };
  }
};
const need = (o, k, t) => { if (typeof o[k] !== t) throw new AppError('INVALID_INPUT', `${k} must be ${t}`); return o[k]; };
const needLang = (o) => { const l = need(o, 'language', 'string'); if (!LANGS.includes(l)) throw new AppError('INVALID_INPUT', 'bad language'); return l; };

async function boot() {
  const ud = app.getPath('userData');
  const store = new Store(ud); await store.init();
  const settingsFile = path.join(ud, 'settings.json');
  let limits = {};
  try { limits = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).limits || {}; } catch { /* defaults */ }
  const catalog = new Catalog(path.join(ud, 'packs'), path.join(ud, 'last-good.json'), { seedDir: path.join(__dirname, '..', 'packs') });
  await catalog.init();
  const backend = new Backend({ installId: store.installId, image: process.env.MECODE_ENGINE_IMAGE || 'mecode-engine:v2' });
  try { backend.setLimits(limits); } catch { /* ignore bad persisted */ }
  const exec = new Executor({ catalog, store, backend });
  backend.start().catch(() => {});

  const H = {
    'catalog.list': () => {
      const l = catalog.list();
      return { ...l, error: catalog.lastError, warning: store.warning, packsDir: catalog.packsDir, problems: l.problems.map((p) => ({ ...p, status: store.statusOf(p.key, p.contentHash) })) };
    },
    'catalog.get': (a) => { const p = catalog.getPublic(need(a, 'key', 'string')); if (!p) throw new AppError('NOT_FOUND', 'unknown problem'); return { ...p, status: store.statusOf(p.key, p.contentHash) }; },
    'packs.import': async (a) => { const r = await catalog.import(need(a, 'jsonText', 'string'), a.replace === true); if (!r.ok) throw new AppError(r.error.code, r.error.message, r.error.details); return r; },
    'packs.reload': async () => { const r = await catalog.reload(); if (!r.ok) throw new AppError(r.error.code, r.error.message, r.error.details); return r; },
    'packs.openFolder': async () => { const e = await shell.openPath(catalog.packsDir); if (e) throw new AppError('IO_ERROR', e); return {}; },
    'draft.load': (a) => store.loadDraft(need(a, 'key', 'string'), needLang(a)),
    'draft.save': (a) => store.saveDraft(need(a, 'key', 'string'), needLang(a), need(a, 'source', 'string'), need(a, 'baseRevision', 'number')),
    'backend.status': () => backend.getStatus(),
    'backend.retry': () => backend.retry(),
    'settings.get': () => ({ limits: backend.limits }),
    'settings.update': async (a) => { backend.setLimits(a.limits); await require('./main/store.cjs').atomicWrite(settingsFile, JSON.stringify({ limits: backend.limits })); return { limits: backend.limits }; },
    'execution.start': (a) => exec.start({ key: need(a, 'key', 'string'), contentHash: need(a, 'contentHash', 'string'), language: needLang(a), source: need(a, 'source', 'string'), mode: need(a, 'mode', 'string'), customInput: a.customInput }),
    'execution.get': (a) => exec.get(need(a, 'jobId', 'string')),
    'execution.cancel': (a) => exec.cancel(need(a, 'jobId', 'string')),
  };
  for (const [ch, fn] of Object.entries(H)) ipcMain.handle(ch, wrap(fn));
  return { backend };
}

function createWindow() {
  const w = new BrowserWindow({ width: 1280, height: 860, title: 'MeCode V2', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(async () => {
    let ctx;
    try { ctx = await boot(); } catch (e) { console.error('boot failed', e); app.exit(1); return; }
    createWindow();
    app.on('before-quit', () => { if (ctx.backend.cur) ctx.backend._kill(ctx.backend.cur); });
  });
  app.on('window-all-closed', () => app.quit());
}
