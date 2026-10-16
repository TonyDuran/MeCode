'use strict';
// R1: confined managed-storage primitives. Managed directories must be real directories (never symlinks), leaves must be
// regular files, reads use O_NOFOLLOW, writes use exclusive O_EXCL|O_NOFOLLOW temp files + rename. Error messages never include file contents.
// Scope: the immediate managed directory is checked on every operation; ancestors ABOVE the data root are the user's choice (documented).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
const C = fs.constants;
const unsafe = (what, p) => new AppError('IO_ERROR', `unsafe managed path (${what}): ${path.basename(p)}`);

/** Managed directory must exist as a REAL directory. create=true makes it (single level, 0700). */
async function ensureDir(dir, fsx = fs.promises, create = true) {
  let st;
  try {
    st = await fsx.lstat(dir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new AppError('IO_ERROR', `cannot inspect ${path.basename(dir)}: ${e.code || 'error'}`);
    if (!create) {
      const err = new AppError('IO_ERROR', `missing managed directory ${path.basename(dir)}`);
      /** @type {any} */ (err).enoent = true;
      throw err;
    }
    try {
      await fsx.mkdir(dir, { mode: 0o700 });
    } catch (e2) {
      if (e2.code !== 'EEXIST') throw new AppError('IO_ERROR', `cannot create ${path.basename(dir)}: ${e2.code || 'error'}`);
    }
    st = await fsx.lstat(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw unsafe('not a real directory', dir);
}
/** Data root: ancestors may be created; the root itself must then be a real directory. */
async function ensureRoot(dir, fsx = fs.promises) {
  await fsx.mkdir(path.dirname(dir), { recursive: true });
  await ensureDir(dir, fsx, true);
}
/** lstat a leaf: null when absent; throws unless a regular file. */
async function leafStat(file, fsx = fs.promises) {
  try {
    const st = await fsx.lstat(file);
    if (!st.isFile()) throw unsafe('not a regular file', file);
    return st;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e instanceof AppError) throw e;
    throw new AppError('IO_ERROR', `cannot inspect ${path.basename(file)}: ${e.code || 'error'}`);
  }
}
/** Read a managed regular file. Missing file => error with code ENOENT (callers decide); anything unsafe => IO_ERROR. */
async function safeRead(file, fsx = fs.promises, maxBytes = 16 * 1024 * 1024) {
  try {
    await ensureDir(path.dirname(file), fsx, false);
  } catch (e) {
    if (e.enoent) {
      const m = /** @type {any} */ (new Error('ENOENT'));
      m.code = 'ENOENT';
      throw m;
    }
    throw e;
  }
  let fh;
  try {
    // F1: reject non-regular leaves (FIFO/device/socket/symlink) BEFORE any open that could block; O_NONBLOCK is defense in depth
    // so a FIFO swapped in after the lstat still cannot hang us (the fstat below rejects it).
    if (!(await leafStat(file, fsx))) {
      const m = /** @type {any} */ (new Error('ENOENT'));
      m.code = 'ENOENT';
      throw m;
    }
    fh = await fsx.open(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile()) throw unsafe('not a regular file', file);
    if (st.size > maxBytes) throw new AppError('IO_ERROR', `${path.basename(file)} is larger than the allowed ${maxBytes} bytes`);
    return await fh.readFile('utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw e;
    if (e instanceof AppError) throw e;
    if (e.code === 'ELOOP') throw unsafe('symlink', file);
    throw new AppError('IO_ERROR', `cannot read ${path.basename(file)}: ${e.code || 'error'}`);
  } finally {
    try {
      if (fh) await fh.close();
    } catch {
      /* ignore */
    }
  }
}
/** Exclusive temp + fsync + rename. Never follows a symlinked parent or leaf; resulting file is mode 0600. */
async function atomicWrite(file, text, fsx = fs.promises) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fh;
  try {
    await ensureDir(path.dirname(file), fsx, true);
    await leafStat(file, fsx);
    fh = await fsx.open(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    await fh.writeFile(text, 'utf8');
    await fh.sync();
    await fh.close();
    fh = undefined;
    await fsx.rename(tmp, file);
  } catch (e) {
    try {
      if (fh) await fh.close();
    } catch {
      /* ignore */
    }
    try {
      await fsx.rm(tmp, { force: true });
    } catch {
      /* ignore */
    }
    if (e instanceof AppError) throw e;
    throw new AppError('IO_ERROR', `write failed: ${e.code || ''} ${String(e.message).slice(0, 120)}`);
  }
}

module.exports = { AppError, ensureDir, ensureRoot, leafStat, safeRead, atomicWrite };
