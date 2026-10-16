'use strict';
// Archive-entry path confinement shared by the verifier. Entry names are untrusted input: they must be portable relative POSIX paths
// (no backslashes, drives, UNC/absolute paths or dot segments) AND resolve strictly beneath the extraction root on the host's
// path flavour. `p` is injectable (path.win32 / path.posix) so Windows semantics are testable on any host.
const path = require('node:path');

/** @returns {string|null} a reason the name is unsafe, or null when it is an acceptable relative POSIX path */
function entryProblem(/** @type {unknown} */ name) {
  if (typeof name !== 'string' || name === '') return 'empty or non-string name';
  if (name.includes('\0')) return 'NUL byte';
  if (name.includes('\\')) return 'backslash (Windows separator or traversal)';
  if (name.startsWith('/')) return 'absolute or UNC path';
  if (/^[A-Za-z]:/.test(name)) return 'drive-letter path';
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((s) => s === '')) return 'empty path segment';
  if (parts.some((s) => s === '.' || s === '..')) return 'dot or traversal segment';
  return null;
}

/** Throws unless `name` is acceptable AND resolves strictly beneath `root` under path flavour `p`; returns the destination. */
function destinationUnder(/** @type {string} */ root, /** @type {string} */ name, /** @type {typeof path.posix} */ p = path) {
  const why = entryProblem(name);
  if (why) throw new Error(`unsafe path in archive: ${JSON.stringify(name)} (${why})`);
  const dst = p.resolve(root, name);
  const rel = p.relative(p.resolve(root), dst);
  if (rel === '' || rel === '..' || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel)) throw new Error(`unsafe path in archive: ${JSON.stringify(name)} (resolves outside the extraction root)`);
  return dst;
}

module.exports = { entryProblem, destinationUnder };
