// Self-authored by Talos. App-bound pins: update only with a reviewed leaf change.
// This verifier is NOT installation authentication or a race-free Python loader.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST = Object.freeze({
  'bridge_cli.py': Object.freeze({size: 4077, sha256: '3117175214a8294a6f2067b637749416696a16f8c39c99a589dc379e2bbfc287'}),
  'controller.py': Object.freeze({size: 22514, sha256: 'e39ab568824fd7844f2317eb3e8e30d03c453aa4c50478c08d80a1e59506d0bf'}),
  'edited_runner.py': Object.freeze({size: 5123, sha256: 'd7100803e65de65bc60514d3a1aaa882efe037e689db1313c639ac6efa14729d'}),
});
const NAMES = Object.freeze(Object.keys(MANIFEST).sort());
function refuse() { throw new Error('judge assets unverified'); }
function same(a, b) {
  return ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every(key => a[key] === b[key]);
}
function membership(directory) {
  // Read at most the expected entries plus one, not an unbounded directory list.
  const handle = fs.opendirSync(directory, {bufferSize: NAMES.length + 1});
  const names = [];
  try {
    let entry;
    while ((entry = handle.readSync()) !== null) {
      if (names.length === NAMES.length || !entry.isFile()) refuse();
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  if (names.sort().join('\0') !== NAMES.join('\0')) refuse();
}
function read(directory, exact) {
  if (!path.isAbsolute(directory) || typeof fs.constants.O_NOFOLLOW !== 'number') refuse();
  const before = fs.lstatSync(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) refuse();
  if (exact) membership(directory);
  const assets = NAMES.map(name => {
    const file = path.join(directory, name), pin = MANIFEST[name];
    const prior = fs.lstatSync(file);
    if (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1 || prior.size !== pin.size) refuse();
    // NONBLOCK prevents a raced-in FIFO from hanging open; NOFOLLOW rejects a
    // replaced final symlink. Ancestors and later Python opens remain a trust/race boundary.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || !same(prior, opened)) refuse();
      const bytes = Buffer.alloc(pin.size + 1);
      let used = 0;
      while (used < bytes.length) {
        const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
        if (count === 0) break;
        used += count;
      }
      if (used !== pin.size || !same(opened, fs.fstatSync(fd)) || !same(opened, fs.lstatSync(file))) refuse();
      const verified = bytes.subarray(0, used);
      if (crypto.createHash('sha256').update(verified).digest('hex') !== pin.sha256) refuse();
      return [name, verified];
    } finally { fs.closeSync(fd); }
  });
  if (exact) membership(directory);
  if (!same(before, fs.lstatSync(directory))) refuse();
  return assets;
}

// Runtime/packaged verification is always exact; no caller-provided manifest.
function readJudgeAssets(directory) { return read(directory, true); }
// Repository source contains tests/docs too. Only staging uses this narrow copy
// path; all selected bytes are pinned, then the staged directory is checked exact.
function readJudgeSources(directory) { return read(directory, false); }
module.exports = {MANIFEST, readJudgeAssets, readJudgeSources};
