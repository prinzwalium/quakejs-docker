'use strict';
// Minimal reader for .pk3 files (plain zip archives) using only Node built-ins.
// Used to list the maps and bots that the game server actually has available.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return buf.subarray(0, n);
}

// Reads only the central directory, not the whole (possibly large) archive.
function readEntries(fd) {
  const size = fs.fstatSync(fd).size;
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = readAt(fd, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOff = tail.readUInt32LE(eocd + 16);
  if (cdOff + cdSize > size || cdSize > 64 * 1024 * 1024) throw new Error('corrupt central directory');
  const cd = readAt(fd, cdOff, cdSize);
  const entries = [];
  let off = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > cd.length || cd.readUInt32LE(off) !== CDIR_SIG) throw new Error('corrupt central directory');
    const method = cd.readUInt16LE(off + 10);
    const csize = cd.readUInt32LE(off + 20);
    const nameLen = cd.readUInt16LE(off + 28);
    const extraLen = cd.readUInt16LE(off + 30);
    const commentLen = cd.readUInt16LE(off + 32);
    const localOff = cd.readUInt32LE(off + 42);
    const name = cd.toString('latin1', off + 46, off + 46 + nameLen);
    entries.push({ name, method, csize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const MAX_EXTRACT = 1024 * 1024;

function extract(fd, entry) {
  if (entry.csize > MAX_EXTRACT) throw new Error('entry too large');
  const hdr = readAt(fd, entry.localOff, 30);
  if (hdr.length < 30 || hdr.readUInt32LE(0) !== LOCAL_SIG) throw new Error('corrupt local header');
  const start = entry.localOff + 30 + hdr.readUInt16LE(26) + hdr.readUInt16LE(28);
  const data = readAt(fd, start, entry.csize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_EXTRACT });
  throw new Error('unsupported compression method ' + entry.method);
}

// Returns { maps: [...], bots: [...] } for all *.pk3 files in dir.
function scan(dir) {
  const maps = new Set();
  const bots = new Set();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => /\.pk3$/i.test(f)).sort();
  } catch (e) {
    return { maps: [], bots: [] };
  }
  for (const f of files) {
    let fd;
    let entries;
    try {
      fd = fs.openSync(path.join(dir, f), 'r');
      entries = readEntries(fd);
    } catch (e) {
      if (fd !== undefined) fs.closeSync(fd);
      continue; // skip unreadable archives instead of failing the whole scan
    }
    for (const e of entries) {
      const lower = e.name.toLowerCase();
      const m = /^maps\/([a-z0-9_-]+)\.bsp$/.exec(lower);
      if (m) maps.add(m[1]);
      if (lower === 'scripts/bots.txt' || /^scripts\/[^/]+\.bot$/.test(lower)) {
        try {
          const text = extract(fd, e).toString('latin1');
          for (const b of text.matchAll(/\bname\s+"?([A-Za-z0-9_-]+)"?/g)) bots.add(b[1]);
        } catch (err) { /* ignore unreadable bot definitions */ }
      }
    }
    fs.closeSync(fd);
  }
  const byName = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  return { maps: [...maps].sort(byName), bots: [...bots].sort(byName) };
}

module.exports = { scan };
