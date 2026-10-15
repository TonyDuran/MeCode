'use strict';
// Durable app state. Main-only. Serialized atomic writes (tmp + fsync + rename), one backup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class AppError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
const h = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 40);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SOURCE = 128 * 1024;

async function atomicWrite(file, text, fsx = fs.promises) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fh;
  try {
    await fsx.mkdir(path.dirname(file), { recursive: true });
    fh = await fsx.open(tmp, 'w', 0o600);
    await fh.writeFile(text, 'utf8');
    await fh.sync();
    await fh.close(); fh = undefined;
    await fsx.rename(tmp, file);
  } catch (e) {
    try { if (fh) await fh.close(); } catch { /* ignore */ }
    try { await fsx.rm(tmp, { force: true }); } catch { /* ignore */ }
    throw new AppError('IO_ERROR', `write failed: ${e.message}`);
  }
}

class Store {
  constructor(dir, { fsx = fs.promises, now = () => new Date().toISOString() } = {}) {
    this.dir = dir; this.fsx = fsx; this.now = now; this.chain = Promise.resolve(); this.state = null; this.warning = null;
  }
  _serial(fn) { const r = this.chain.then(fn, fn); this.chain = r.catch(() => {}); return r; }
  async _readJson(file) {
    try { return JSON.parse(await this.fsx.readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return undefined; throw new AppError('IO_ERROR', `corrupt or unreadable ${path.basename(file)}: ${e.message}`); }
  }
  async init() {
    const f = path.join(this.dir, 'state.json');
    const valid = (s) => s && typeof s === 'object' && !Array.isArray(s) && s.schemaVersion === 1 && typeof s.installId === 'string' && UUID.test(s.installId)
      && s.progress && typeof s.progress === 'object' && !Array.isArray(s.progress) && Array.isArray(s.attempts) && s.attempts.length <= 1000;
    let s, problem = null;
    try { s = await this._readJson(f); if (s !== undefined && !valid(s)) { problem = new AppError('IO_ERROR', 'state.json has invalid shape'); s = undefined; } } catch (e) { problem = e; s = undefined; }
    if (problem) {
      const b = await this._readJson(`${f}.bak`).catch(() => undefined);
      if (!valid(b)) throw problem; // visible, not a silent reset
      s = b; this.warning = `state.json was unusable; recovered from backup (${problem.message}); the most recent write may be lost`;
    }
    this.state = s || { schemaVersion: 1, installId: crypto.randomUUID(), progress: {}, attempts: [] };
    if (!s) await this._writeState(this.state);
    return this.state;
  }
  async _writeState(next) {
    const f = path.join(this.dir, 'state.json');
    try { await this.fsx.copyFile(f, `${f}.bak`); } catch { /* first write */ }
    await atomicWrite(f, JSON.stringify(next), this.fsx);
  }
  get installId() { return this.state.installId; }
  _draftFile(key, lang) { return path.join(this.dir, 'drafts', `${h(`${key}\u0000${lang}`)}.json`); }
  async loadDraft(key, lang) {
    const d = await this._readJson(this._draftFile(key, lang));
    if (!d) return { source: null, revision: 0, updatedAt: null };
    if (typeof d.source !== 'string' || !Number.isSafeInteger(d.revision) || d.revision < 0 || d.key !== key || d.lang !== lang) throw new AppError('IO_ERROR', 'draft file has invalid shape; not replacing it with a starter');
    return { source: d.source, revision: d.revision, updatedAt: d.updatedAt };
  }
  saveDraft(key, lang, source, baseRevision) { try { return this._saveDraft(key, lang, source, baseRevision); } catch (e) { return Promise.reject(e); } }
  _saveDraft(key, lang, source, baseRevision) {
    if (typeof key !== 'string' || key.length > 200) throw new AppError('INVALID_INPUT', 'bad key');
    if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_SOURCE) throw new AppError('INVALID_INPUT', 'source must be a string up to 128 KiB');
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new AppError('INVALID_INPUT', 'baseRevision must be a non-negative integer');
    return this._serial(async () => {
      const cur = await this.loadDraft(key, lang);
      if (cur.revision !== baseRevision) throw new AppError('CONFLICT', `stale draft revision (have ${cur.revision}, got ${baseRevision})`, { revision: cur.revision });
      const rec = { key, lang, source, revision: cur.revision + 1, updatedAt: this.now() };
      await atomicWrite(this._draftFile(key, lang), JSON.stringify(rec), this.fsx); // ack only after durable
      return { revision: rec.revision, updatedAt: rec.updatedAt };
    });
  }
  recordAttempt({ key, contentHash, mode, language, verdict, sourceHash }) {
    return this._serial(async () => {
      const at = this.now();
      const next = structuredClone(this.state); // stage; adopt only after a durable write
      next.attempts.push({ key, contentHash, mode, language, verdict, sourceHash, at });
      if (next.attempts.length > 1000) next.attempts.splice(0, next.attempts.length - 1000);
      if (mode === 'submit') {
        const p = Object.hasOwn(next.progress, key) ? next.progress[key] : {};
        p.lastVerdict = verdict; p.lastContentHash = contentHash; p.lastAt = at;
        if (verdict === 'ACCEPTED') { p.acceptedContentHash = contentHash; p.acceptedSourceHash = sourceHash; p.acceptedAt = at; }
        next.progress[key] = p;
      }
      await this._writeState(next);
      this.state = next;
    });
  }
  /** solved only if acceptance was for the CURRENT content hash */
  statusOf(key, contentHash) {
    const p = Object.hasOwn(this.state.progress, key) ? this.state.progress[key] : null;
    if (!p) return 'unsolved';
    if (p.acceptedContentHash === contentHash) return 'solved';
    if (p.acceptedContentHash) return 'stale';
    return 'attempted';
  }
}

module.exports = { Store, AppError, atomicWrite, h };
