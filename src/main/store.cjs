'use strict';
// Durable app state. Main-only. Serialized atomic writes (exclusive tmp + fsync + rename), one backup. All paths confined (see safefs.cjs).
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError, ensureRoot, safeRead, atomicWrite } = require('./safefs.cjs');
const { LANGS } = require('../shared/validate.cjs');

const h = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 40);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SOURCE = 128 * 1024;
const MAX_ATTEMPTS = 1000;
const MAX_PROGRESS = 10000;
const MAX_ACCEPTED = 512;
const MAX_ACCEPTED_BYTES = 8 * 1024 * 1024;
const MAX_STATE_BYTES = 16 * 1024 * 1024; // = safeRead default: a state we write must be one we can read back
const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- R7: strict, bounded persisted-record schemas (validated before adoption; never "fixed" silently)
const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const str = (v, max) => typeof v === 'string' && v.length <= max;
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));
const PROGRESS_FIELDS = { lastVerdict: 40, lastContentHash: 100, lastAt: 40, acceptedContentHash: 100, acceptedSourceHash: 100, acceptedAt: 40, acceptedLanguage: 16 };
const validProgress = (p) => isPlain(p) && Object.entries(p).every(([k, v]) => Object.hasOwn(PROGRESS_FIELDS, k) && str(v, PROGRESS_FIELDS[k]));
const ATTEMPT_FIELDS = { key: 200, contentHash: 100, mode: 16, language: 16, verdict: 40, sourceHash: 100, at: 40 };
const validAttempt = (a) =>
  isPlain(a) && onlyKeys(a, Object.keys(ATTEMPT_FIELDS)) && Object.keys(ATTEMPT_FIELDS).every((k) => str(a[k], ATTEMPT_FIELDS[k])) && ['examples', 'custom', 'submit'].includes(a.mode);
const accKey = (key, lang) => h(`${key}\u0000${lang}`);
const ACC_FIELDS = ['schemaVersion', 'key', 'language', 'contentHash', 'sourceHash', 'source', 'acceptedAt'];
/** AcceptedSolution: strict fields, LANGS, 64-hex hashes, source bytes <= 128 KiB and sourceHash recomputed from the stored bytes */
function validAccepted(r) {
  return (
    isPlain(r) &&
    Object.keys(r).length === ACC_FIELDS.length &&
    onlyKeys(r, ACC_FIELDS) &&
    r.schemaVersion === 1 &&
    str(r.key, 200) &&
    LANGS.includes(r.language) &&
    typeof r.contentHash === 'string' &&
    HEX64.test(r.contentHash) &&
    typeof r.sourceHash === 'string' &&
    HEX64.test(r.sourceHash) &&
    typeof r.source === 'string' &&
    Buffer.byteLength(r.source) <= MAX_SOURCE &&
    sha256(r.source) === r.sourceHash &&
    str(r.acceptedAt, 40)
  );
}
function validAcceptedMap(m) {
  if (!isPlain(m)) return false;
  const ks = Object.keys(m);
  if (ks.length > MAX_ACCEPTED) return false;
  let bytes = 0;
  for (const k of ks) {
    const r = m[k];
    if (!validAccepted(r) || k !== accKey(r.key, r.language)) return false;
    bytes += Buffer.byteLength(r.source);
  }
  return bytes <= MAX_ACCEPTED_BYTES;
}
function validState(s) {
  if (!isPlain(s) || s.schemaVersion !== 1 || typeof s.installId !== 'string' || !UUID.test(s.installId)) return false;
  if (!onlyKeys(s, ['schemaVersion', 'installId', 'progress', 'attempts', 'acceptedSolutions'])) return false;
  if (s.acceptedSolutions !== undefined && !validAcceptedMap(s.acceptedSolutions)) return false;
  if (!isPlain(s.progress) || !Array.isArray(s.attempts) || s.attempts.length > MAX_ATTEMPTS) return false;
  const keys = Object.keys(s.progress);
  return keys.length <= MAX_PROGRESS && keys.every((k) => k.length <= 200 && validProgress(s.progress[k])) && s.attempts.every(validAttempt);
}
function validDraft(d, key, lang) {
  return (
    isPlain(d) &&
    Object.keys(d).length === 5 &&
    onlyKeys(d, ['key', 'lang', 'source', 'revision', 'updatedAt']) &&
    typeof d.source === 'string' &&
    Buffer.byteLength(d.source) <= MAX_SOURCE &&
    Number.isSafeInteger(d.revision) &&
    d.revision >= 0 &&
    str(d.updatedAt, 40) &&
    d.key === key &&
    d.lang === lang
  );
}

class Store {
  constructor(dir, { fsx = require('node:fs').promises, now = () => new Date().toISOString() } = {}) {
    this.dir = dir;
    this.fsx = fsx;
    this.now = now;
    this.chain = Promise.resolve();
    this.state = null;
    this.warning = null;
  }
  _serial(fn) {
    const r = this.chain.then(fn, fn);
    this.chain = r.catch(() => {});
    return r;
  }
  /** undefined ONLY for a missing file; every other problem (unsafe path, unreadable, invalid JSON) is a visible IO_ERROR. JSON values such as null/false/0/"" are returned as-is. */
  async _readJson(file) {
    let text;
    try {
      text = await safeRead(file, this.fsx);
    } catch (e) {
      if (e.code === 'ENOENT') return undefined;
      throw new AppError('IO_ERROR', `unreadable ${path.basename(file)}: ${e.message}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError('IO_ERROR', `corrupt ${path.basename(file)}: invalid JSON`);
    } // parser text can echo file content: not included
  }
  async init() {
    await ensureRoot(this.dir, this.fsx);
    const f = path.join(this.dir, 'state.json');
    let s,
      problem = null;
    try {
      s = await this._readJson(f);
      if (s !== undefined && !validState(s)) {
        problem = new AppError('IO_ERROR', 'state.json has invalid shape');
        s = undefined;
      }
    } catch (e) {
      problem = e;
      s = undefined;
    }
    if (problem) {
      const b = await this._readJson(`${f}.bak`).catch(() => undefined);
      if (!validState(b)) throw problem; // visible, not a silent reset
      s = b;
      this.warning = `state.json was unusable; recovered from backup (${problem.message}); the most recent write may be lost`;
    }
    this.state = s || { schemaVersion: 1, installId: crypto.randomUUID(), progress: {}, attempts: [] };
    if (!s) await this._writeState(this.state);
    return this.state;
  }
  async _writeState(next) {
    const f = path.join(this.dir, 'state.json');
    let cur;
    try {
      cur = await safeRead(f, this.fsx);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    } // ENOENT only on the very first write
    // F2: only a VALIDATED primary may replace the backup; an unusable primary must never overwrite the last good backup
    // (otherwise a failed primary rename after recovery would lose both copies).
    let curValid = false;
    if (cur !== undefined) {
      try {
        curValid = validState(JSON.parse(cur));
      } catch {
        /* invalid JSON */
      }
    }
    if (curValid) await atomicWrite(`${f}.bak`, cur, this.fsx); // safe backup: never follows a symlink
    await atomicWrite(f, JSON.stringify(next), this.fsx);
  }
  get installId() {
    return this.state.installId;
  }
  _draftFile(key, lang) {
    return path.join(this.dir, 'drafts', `${h(`${key}\u0000${lang}`)}.json`);
  }
  async loadDraft(key, lang) {
    const d = await this._readJson(this._draftFile(key, lang));
    if (d === undefined) return { source: null, revision: 0, updatedAt: null }; // ONLY a missing file means "no draft"
    if (!validDraft(d, key, lang)) throw new AppError('IO_ERROR', 'draft file has invalid shape; not replacing it with a starter');
    return { source: d.source, revision: d.revision, updatedAt: d.updatedAt };
  }
  saveDraft(key, lang, source, baseRevision) {
    try {
      return this._saveDraft(key, lang, source, baseRevision);
    } catch (e) {
      return Promise.reject(e);
    }
  }
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
  recordAttempt({ key, contentHash, mode, language, verdict, sourceHash, source }) {
    return this._serial(async () => {
      const keepSource = mode === 'submit' && verdict === 'ACCEPTED';
      if (keepSource) {
        // exact submitted snapshot is mandatory for an acceptance: validated BEFORE anything is staged
        if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_SOURCE) throw new AppError('INVALID_INPUT', 'accepted source must be a string up to 128 KiB');
        if (!LANGS.includes(language)) throw new AppError('INVALID_INPUT', 'bad language');
        if (typeof sourceHash !== 'string' || sourceHash !== sha256(source)) throw new AppError('INVALID_INPUT', 'sourceHash does not match the submitted source');
        if (typeof contentHash !== 'string' || !HEX64.test(contentHash)) throw new AppError('INVALID_INPUT', 'contentHash must be a 64-hex problem hash');
        if (typeof key !== 'string' || key.length > 200) throw new AppError('INVALID_INPUT', 'bad key');
      }
      const at = this.now();
      const next = structuredClone(this.state); // stage; adopt only after a durable write
      next.attempts.push({ key, contentHash, mode, language, verdict, sourceHash, at });
      if (next.attempts.length > MAX_ATTEMPTS) next.attempts.splice(0, next.attempts.length - MAX_ATTEMPTS);
      if (mode === 'submit') {
        const p = Object.hasOwn(next.progress, key) ? next.progress[key] : {};
        p.lastVerdict = verdict;
        p.lastContentHash = contentHash;
        p.lastAt = at;
        if (verdict === 'ACCEPTED') {
          p.acceptedContentHash = contentHash;
          p.acceptedSourceHash = sourceHash;
          p.acceptedAt = at;
          p.acceptedLanguage = language;
        }
        next.progress[key] = p;
      }
      if (keepSource) {
        next.acceptedSolutions = { ...(next.acceptedSolutions || {}) };
        next.acceptedSolutions[accKey(key, language)] = { schemaVersion: 1, key, language, contentHash, sourceHash, source, acceptedAt: at };
        // bounds are checked on the NET result (replacing the same problem/language does not count twice); unrelated records are never evicted
        if (!validAcceptedMap(next.acceptedSolutions)) throw new AppError('INVALID_INPUT', 'accepted-solution storage is full (512 solutions / 8 MiB); nothing was saved');
      }
      if (!validState(next)) throw new AppError('INVALID_INPUT', 'attempt record is not valid; nothing written'); // never persist what init would reject
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_STATE_BYTES) throw new AppError('INVALID_INPUT', 'state would exceed 16 MiB; nothing was saved');
      await this._writeState(next);
      this.state = next;
    });
  }
  /** solved only if acceptance was for the CURRENT content hash */
  loadAccepted(key, language) {
    const m = this.state.acceptedSolutions;
    const k = accKey(key, language);
    return m && Object.hasOwn(m, k) ? structuredClone(m[k]) : null;
  }
  /** solved needs the CURRENT hash AND a validated accepted record that matches the progress entry. Legacy acceptance (no stored source) is 'stale' = unverified. */
  statusOf(key, contentHash) {
    const p = Object.hasOwn(this.state.progress, key) ? this.state.progress[key] : null;
    if (!p) return 'unsolved';
    if (p.acceptedContentHash === contentHash) {
      const r = p.acceptedLanguage ? this.loadAccepted(key, p.acceptedLanguage) : null;
      return r && r.contentHash === contentHash && r.sourceHash === p.acceptedSourceHash ? 'solved' : 'stale';
    }
    if (p.acceptedContentHash) return 'stale';
    return 'attempted';
  }
}

module.exports = { Store, AppError, atomicWrite, h, validState, validDraft };
