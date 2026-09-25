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
const MAX_BSP = 64 * 1024 * 1024;

function extract(fd, entry, max = MAX_EXTRACT) {
  if (entry.csize > max) throw new Error('entry too large');
  const hdr = readAt(fd, entry.localOff, 30);
  if (hdr.length < 30 || hdr.readUInt32LE(0) !== LOCAL_SIG) throw new Error('corrupt local header');
  const start = entry.localOff + 30 + hdr.readUInt16LE(26) + hdr.readUInt16LE(28);
  const data = readAt(fd, start, entry.csize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: max });
  throw new Error('unsupported compression method ' + entry.method);
}

// Game types (0 FFA, 1 Tournament, 3 Team DM, 4 CTF) from an arena "type" string.
const ARENA_TYPES = { ffa: 0, tourney: 1, team: 3, ctf: 4 };
function arenaTypes(text) {
  const out = {};
  for (const block of text.match(/\{[^}]*\}/g) || []) {
    const map = (/\bmap\s+"([^"]+)"/i.exec(block) || [])[1];
    const type = (/\btype\s+"([^"]*)"/i.exec(block) || [])[1];
    if (!map || type === undefined) continue;
    const types = type.toLowerCase().split(/\s+/).map(t => ARENA_TYPES[t]).filter(t => t !== undefined);
    out[map.toLowerCase()] = [...new Set(types)].sort();
  }
  return out;
}

// Game types a map supports, from its entities (BSP lump 0): deathmatch spawn points
// allow FFA/Tournament/Team DM, both CTF flags allow CTF.
function bspTypes(bsp) {
  if (bsp.length < 16 || bsp.toString('latin1', 0, 4) !== 'IBSP') return null;
  const off = bsp.readInt32LE(8);
  const len = bsp.readInt32LE(12);
  if (off < 0 || len <= 0 || off + len > bsp.length) return null;
  const ents = bsp.toString('latin1', off, off + len);
  const classes = new Set([...ents.matchAll(/"classname"\s+"([^"]+)"/g)].map(m => m[1].toLowerCase()));
  const types = [];
  if (classes.has('info_player_deathmatch')) types.push(0, 1, 3);
  if (classes.has('team_ctf_redflag') && classes.has('team_ctf_blueflag')) types.push(4);
  return types;
}

// BSP files are large; their game types are cached per pak file.
const bspCache = new Map();

// Returns { maps, bots, models, icons, mapInfo } for all *.pk3 files in dir.
// mapInfo: { map: { types: [gametype, ...] | null } } (null = unknown).
// models: selectable player models as "model" or "model/skin" (team skins red/blue excluded).
// icons: { "model/skin": { file, entry } } used by readIcon().
function scan(dir) {
  const maps = new Set();
  const bots = new Set();
  const bodies = new Set();
  const icons = {};
  const arenas = {};
  const bspEntries = {};
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => /\.pk3$/i.test(f)).sort();
  } catch (e) {
    return { maps: [], bots: [], models: [], icons: {}, mapInfo: {} };
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
      if (m) {
        maps.add(m[1]);
        bspEntries[m[1]] = { file: path.join(dir, f), entry: e };
      }
      if (lower === 'scripts/arenas.txt' || /^scripts\/[^/]+\.arena$/.test(lower)) {
        try {
          Object.assign(arenas, arenaTypes(extract(fd, e).toString('latin1')));
        } catch (err) { /* ignore unreadable arena files */ }
      }
      const body = /^models\/players\/([a-z0-9_-]+)\/lower\.(md3|mdc)$/.exec(lower);
      if (body) bodies.add(body[1]);
      const icon = /^models\/players\/([a-z0-9_-]+)\/icon_([a-z0-9_-]+)\.tga$/.exec(lower);
      if (icon && icon[2] !== 'red' && icon[2] !== 'blue') icons[`${icon[1]}/${icon[2]}`] = { file: path.join(dir, f), entry: e };
      if (lower === 'scripts/bots.txt' || /^scripts\/[^/]+\.bot$/.test(lower)) {
        try {
          const text = extract(fd, e).toString('latin1');
          for (const b of text.matchAll(/\bname\s+"?([A-Za-z0-9_-]+)"?/g)) bots.add(b[1]);
        } catch (err) { /* ignore unreadable bot definitions */ }
      }
    }
    fs.closeSync(fd);
  }
  // Only models with a body can be played; drop icons of head-only models.
  for (const key of Object.keys(icons)) if (!bodies.has(key.split('/')[0])) delete icons[key];
  const mapInfo = {};
  for (const map of maps) {
    if (arenas[map]) {
      mapInfo[map] = { types: arenas[map] };
      continue;
    }
    const src = bspEntries[map];
    const st = fs.statSync(src.file);
    const key = `${src.file}:${st.size}:${st.mtimeMs}:${map}`;
    if (!bspCache.has(key)) {
      let types = null;
      let bfd;
      try {
        bfd = fs.openSync(src.file, 'r');
        types = bspTypes(extract(bfd, src.entry, MAX_BSP));
      } catch (err) { /* unknown */ } finally {
        if (bfd !== undefined) fs.closeSync(bfd);
      }
      bspCache.set(key, types);
    }
    mapInfo[map] = { types: bspCache.get(key) };
  }
  const byName = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  const models = Object.keys(icons).map(k => (k.endsWith('/default') ? k.slice(0, -8) : k)).sort(byName);
  return { maps: [...maps].sort(byName), bots: [...bots].sort(byName), models, icons, mapInfo };
}

// Reads one icon (TGA) found by scan().
function readIcon(icon) {
  const fd = fs.openSync(icon.file, 'r');
  try {
    return extract(fd, icon.entry);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { scan, readIcon, arenaTypes, bspTypes };
