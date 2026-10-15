'use strict';
// Managed pack directory -> validated catalog. Invalid import/reload keeps last-good.
const fs = require('node:fs');
const path = require('node:path');
const { validatePack, LIMITS } = require('../shared/validate.cjs');
const { AppError, atomicWrite } = require('./store.cjs');

class Catalog {
  /** @param {string} packsDir managed dir; @param {string} snapshotFile last-good snapshot */
  constructor(packsDir, snapshotFile, { seedDir } = {}) {
    this.packsDir = packsDir; this.snapshotFile = snapshotFile; this.seedDir = seedDir;
    this.packs = []; this.revision = 0; this.lastError = null; this.queue = Promise.resolve();
  }
  _serial(fn) { const r = this.queue.then(fn, fn); this.queue = r.catch(() => {}); return r; }

  async _seed() {
    if (!this.seedDir) return;
    const marker = path.join(path.dirname(this.packsDir), '.packs-seeded');
    if (fs.existsSync(marker)) return;
    await fs.promises.mkdir(this.packsDir, { recursive: true });
    for (const f of await fs.promises.readdir(this.seedDir)) {
      if (!f.endsWith('.json')) continue;
      const dst = path.join(this.packsDir, f);
      if (!fs.existsSync(dst)) await fs.promises.copyFile(path.join(this.seedDir, f), dst);
    }
    await fs.promises.writeFile(marker, 'seeded\n');
  }

  /** Parse+validate a set of {name,text}. Returns {ok,packs}|{ok:false,errors}. */
  static validateSet(files) {
    const errors = []; const packs = []; const packIds = new Set(); const keys = new Set(); let count = 0;
    for (const { name, text } of files) {
      if (Buffer.byteLength(text, 'utf8') > LIMITS.packBytes) { errors.push({ file: name, path: name, message: 'pack exceeds 5 MiB' }); continue; }
      let raw;
      try { raw = JSON.parse(text); } catch (e) { errors.push({ file: name, path: name, message: `invalid JSON: ${e.message}` }); continue; }
      const r = validatePack(raw, name);
      if (!r.ok) { for (const e of r.errors) errors.push({ file: name, ...e }); continue; }
      if (packIds.has(r.pack.id)) { errors.push({ file: name, path: `${name}.id`, message: `duplicate pack id "${r.pack.id}"` }); continue; }
      packIds.add(r.pack.id);
      for (const p of r.pack.problems) { const k = `${r.pack.id}/${p.id}`; if (keys.has(k)) errors.push({ file: name, path: k, message: 'duplicate key' }); keys.add(k); }
      count += r.pack.problems.length;
      packs.push(r.pack);
    }
    if (count > LIMITS.problems) errors.push({ file: '*', path: 'catalog', message: `more than ${LIMITS.problems} problems` });
    return errors.length ? { ok: false, errors } : { ok: true, packs };
  }

  async _readDir() {
    const names = (await fs.promises.readdir(this.packsDir)).filter((n) => n.endsWith('.json')).sort();
    const files = [];
    for (const name of names) {
      const st = await fs.promises.stat(path.join(this.packsDir, name));
      if (st.size > LIMITS.packBytes) { files.push({ name, text: ' '.repeat(0), tooBig: true }); continue; }
      files.push({ name, text: await fs.promises.readFile(path.join(this.packsDir, name), 'utf8') });
    }
    return files;
  }

  _adopt(packs) { this.packs = packs; this.revision += 1; this.lastError = null; }

  async _snapshot() {
    await atomicWrite(this.snapshotFile, JSON.stringify({ schemaVersion: 1, packs: this.packs.map((p) => ({ ...p, problems: p.problems.map(({ contentHash, ...rest }) => rest) })) }));
  }

  /** Startup: load packs; on failure fall back to revalidated last-good snapshot with visible error. */
  init() {
    return this._serial(async () => {
      await this._seed();
      const r = await this.reloadInner();
      if (r.ok) return r;
      try {
        const snap = JSON.parse(await fs.promises.readFile(this.snapshotFile, 'utf8'));
        const v = Catalog.validateSet(snap.packs.map((p, i) => ({ name: `snapshot[${i}]`, text: JSON.stringify(p) })));
        if (v.ok) { this._adopt(v.packs); this.lastError = { code: 'PACK_INVALID', message: 'managed packs invalid; using last-good snapshot', details: r.error.details }; }
      } catch { /* no usable snapshot */ }
      return r;
    });
  }

  async reloadInner() {
    let files;
    try { files = await this._readDir(); } catch (e) { return this._fail(new AppError('IO_ERROR', `cannot read packs dir: ${e.message}`)); }
    const v = Catalog.validateSet(files.map((f) => (f.tooBig ? { name: f.name, text: 'x'.repeat(LIMITS.packBytes + 1) } : f)));
    if (!v.ok) return this._fail(new AppError('PACK_INVALID', `${v.errors.length} validation error(s); previous catalog retained`, v.errors.slice(0, 50)));
    this._adopt(v.packs);
    try { await this._snapshot(); } catch (e) { this.lastError = { code: e.code, message: `snapshot failed: ${e.message}` }; }
    return { ok: true, revision: this.revision, problemCount: this.problemCount() };
  }
  _fail(err) { this.lastError = { code: err.code, message: err.message, details: err.details }; return { ok: false, error: this.lastError }; }

  reload() { return this._serial(() => this.reloadInner()); }

  import(jsonText, replace = false) {
    return this._serial(async () => {
      if (typeof jsonText !== 'string' || Buffer.byteLength(jsonText, 'utf8') > LIMITS.packBytes) return { ok: false, error: { code: 'INVALID_INPUT', message: 'pack must be a string up to 5 MiB' } };
      let raw;
      try { raw = JSON.parse(jsonText); } catch (e) { return { ok: false, error: { code: 'PACK_INVALID', message: `invalid JSON: ${e.message}` } }; }
      const one = Catalog.validateSet([{ name: 'import', text: jsonText }]);
      if (!one.ok) return { ok: false, error: { code: 'PACK_INVALID', message: 'import rejected', details: one.errors.slice(0, 50) } };
      const id = one.packs[0].id;
      void raw;
      const dst = path.join(this.packsDir, `${id}.json`);
      const exists = fs.existsSync(dst);
      if (exists && !replace) return { ok: false, error: { code: 'CONFLICT', message: `pack "${id}" already exists; confirm replace` } };
      // whole-candidate validation: existing files (minus replaced) + new
      const others = (await this._readDir()).filter((f) => f.name !== `${id}.json`);
      const whole = Catalog.validateSet([...others, { name: `${id}.json`, text: jsonText }]);
      if (!whole.ok) return { ok: false, error: { code: 'PACK_INVALID', message: 'import would make catalog invalid; nothing written', details: whole.errors.slice(0, 50) } };
      const prev = exists ? await fs.promises.readFile(dst, 'utf8') : null;
      try {
        await atomicWrite(dst, jsonText);
        this._adopt(whole.packs);
        try { await this._snapshot(); } catch { /* reported at next reload */ }
      } catch (e) {
        if (prev !== null) await atomicWrite(dst, prev).catch(() => {}); else await fs.promises.rm(dst, { force: true }).catch(() => {});
        return { ok: false, error: { code: 'IO_ERROR', message: `import failed, rolled back: ${e.message}` } };
      }
      return { ok: true, packId: id, revision: this.revision, problemCount: one.packs[0].problems.length };
    });
  }

  problemCount() { return this.packs.reduce((n, p) => n + p.problems.length, 0); }
  list() {
    const problems = [];
    for (const pk of this.packs) for (const p of pk.problems) problems.push({ key: `${pk.id}/${p.id}`, contentHash: p.contentHash, title: p.title, difficulty: p.difficulty, patterns: p.patterns, packTitle: pk.title });
    return { revision: this.revision, problems };
  }
  /** full internal problem (with all expected answers) — main only */
  getInternal(key) {
    const [pid, id] = String(key).split('/');
    const pk = this.packs.find((p) => p.id === pid);
    const pr = pk && pk.problems.find((p) => p.id === id);
    return pr ? { pack: pk, problem: pr } : null;
  }
  /** renderer view: examples with expected; checks as count only */
  getPublic(key) {
    const f = this.getInternal(key);
    if (!f) return null;
    const { tests, ...rest } = f.problem;
    return { key, ...rest, provenance: f.pack.provenance, examples: tests.filter((t) => t.kind === 'example'), checkCount: tests.filter((t) => t.kind === 'check').length };
  }
}

module.exports = { Catalog };
