'use strict';
// Minimal deterministic archive writers/readers (no dependencies): ustar tar(.gz) and zip with Unix modes.
// Determinism: sorted entries, fixed mtime (caller passes the commit time), uid/gid 0, no user names, gzip header OS byte normalised.
const zlib = require('node:zlib');

const pad = (n, width) => n.toString(8).padStart(width - 1, '0') + '\0';
function tarHeader(name, size, mode, mtime, isDir) {
  const h = Buffer.alloc(512);
  let prefix = '';
  let base = name + (isDir ? '/' : '');
  if (Buffer.byteLength(base) > 100) {
    const i = base.lastIndexOf('/', base.length - 2);
    prefix = base.slice(0, i);
    base = base.slice(i + 1);
    if (!prefix || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(base) > 100) throw new Error(`path too long for ustar: ${name}`);
  }
  h.write(base, 0, 100, 'utf8');
  h.write(pad(mode, 8), 100);
  h.write(pad(0, 8), 108);
  h.write(pad(0, 8), 116);
  h.write(pad(size, 12), 124);
  h.write(pad(mtime, 12), 136);
  h.write('        ', 148);
  h.write(isDir ? '5' : '0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

/** entries: [{ name, data?:Buffer, mode, dir?:true }] already sorted. Returns the .tar.gz Buffer. */
function makeTarGz(entries, mtime) {
  const parts = [];
  for (const e of entries) {
    const data = e.dir ? Buffer.alloc(0) : e.data;
    parts.push(tarHeader(e.name, data.length, e.mode, mtime, !!e.dir), data);
    if (data.length % 512) parts.push(Buffer.alloc(512 - (data.length % 512)));
  }
  parts.push(Buffer.alloc(1024));
  const gz = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
  gz[4] = gz[5] = gz[6] = gz[7] = 0; // mtime
  gz[9] = 3; // OS = Unix regardless of the building platform
  return gz;
}

function dosTime(sec) {
  const d = new Date(sec * 1000);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((Math.max(d.getUTCFullYear(), 1980) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

/** Zip with Unix permission bits in the external attributes (version-made-by = 3 / Unix). */
function makeZip(entries, mtime) {
  const { time, date } = dosTime(mtime);
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name + (e.dir ? '/' : ''), 'utf8');
    const raw = e.dir ? Buffer.alloc(0) : e.data;
    const comp = e.dir ? Buffer.alloc(0) : zlib.deflateRawSync(raw, { level: 9 });
    const crc = e.dir ? 0 : zlib.crc32(raw);
    const method = e.dir ? 0 : 8;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(0x0800, 6);
    l.writeUInt16LE(method, 8);
    l.writeUInt16LE(time, 10);
    l.writeUInt16LE(date, 12);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(comp.length, 18);
    l.writeUInt32LE(raw.length, 22);
    l.writeUInt16LE(name.length, 26);
    l.writeUInt16LE(0, 28);
    locals.push(l, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((((e.dir ? 0o040000 : 0o100000) | e.mode) << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cdir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdir, end]);
}

/** Readers return [{ name, mode, dir, data }]; they validate checksums/CRCs so a corrupt archive throws. */
function readTarGz(buf) {
  const tar = zlib.gunzipSync(buf);
  const out = [];
  let pos = 0;
  while (pos + 512 <= tar.length) {
    const h = tar.subarray(pos, pos + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.toString('utf8', a, b).replace(/\0.*$/s, '');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== parseInt(str(148, 156).trim(), 8)) throw new Error('tar header checksum mismatch');
    const size = parseInt(str(124, 136).trim(), 8);
    const prefix = str(345, 500);
    let name = (prefix ? `${prefix}/` : '') + str(0, 100);
    const dir = h[156] === 0x35;
    if (dir) name = name.replace(/\/$/, '');
    out.push({ name, mode: parseInt(str(100, 108).trim(), 8) & 0o7777, dir, data: dir ? Buffer.alloc(0) : Buffer.from(tar.subarray(pos + 512, pos + 512 + size)) });
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

function readZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('zip: no end-of-central-directory');
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central header');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38);
    const lho = buf.readUInt32LE(p + 42);
    let name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const dir = name.endsWith('/');
    if (dir) name = name.slice(0, -1);
    const lnl = buf.readUInt16LE(lho + 26);
    const lxl = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnl + lxl;
    const comp = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(comp) : Buffer.from(comp);
    if (!dir && zlib.crc32(data) !== crc) throw new Error(`zip: CRC mismatch for ${name}`);
    out.push({ name, mode: (ext >>> 16) & 0o7777, dir, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

module.exports = { makeTarGz, makeZip, readTarGz, readZip };
