'use strict';
// Runs once at container start, before supervisord: makes sure the data directory exists
// and writes the game server config from the saved settings (or the defaults).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Store } = require('./lib/config');
const { Stats } = require('./lib/stats');

const USER = 'quakejs';
const DATA_DIR = process.env.QJS_DATA_DIR || '/data';
const BASE_DIR = process.env.QJS_BASE_DIR || '/quakejs/base';
const GAME_DIRS = [path.join(BASE_DIR, 'baseq3'), path.join(BASE_DIR, 'cpma')];

function chownTree(dir, uid, gid) {
  fs.chownSync(dir, uid, gid);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) chownTree(p, uid, gid);
    else if (e.isFile()) fs.chownSync(p, uid, gid);
  }
}

// When started as root, hand the directories to the game user and drop privileges,
// so every file written below belongs to the user that runs the game and the admin.
if (process.getuid && process.getuid() === 0) {
  const { execFileSync } = require('child_process');
  const uid = Number(execFileSync('id', ['-u', USER]).toString().trim());
  const gid = Number(execFileSync('id', ['-g', USER]).toString().trim());
  for (const d of [DATA_DIR, ...GAME_DIRS]) {
    fs.mkdirSync(d, { recursive: true });
    chownTree(d, uid, gid);
  }
  process.setgid(gid);
  process.setuid(uid);
}

const store = new Store({ dataDir: DATA_DIR, gameDirs: GAME_DIRS });
const settings = store.load();
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(store.settingsFile)) store.save(settings);
else store.writeGameConfig(settings);
console.log(`[init] wrote game config (${settings.rotation.length} maps in rotation)`);

// Count the rest of the previous game log into the statistics, then archive it, so the
// log never grows without bound. The game server is not running yet at this point.
const KEEP_LOGS = 20;
const logFile = path.join(GAME_DIRS[0], 'games.log');
try {
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 0) {
    const stats = new Stats({ dataDir: DATA_DIR, logFile });
    stats.ingest(false);
    stats.state.log = { ino: null, offset: 0 };
    stats.dirty = true;
    stats.save();
    const logDir = path.join(DATA_DIR, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const archive = path.join(logDir, `games-${new Date().toISOString().replace(/[:.]/g, '-')}.log.gz`);
    fs.writeFileSync(archive, zlib.gzipSync(fs.readFileSync(logFile)), { mode: 0o600 });
    fs.unlinkSync(logFile);
    const old = fs.readdirSync(logDir).filter(f => /^games-.*\.log\.gz$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_LOGS))) fs.unlinkSync(path.join(logDir, f));
    console.log(`[init] archived game log to ${archive}`);
  }
} catch (e) {
  // Statistics must never keep the server from starting.
  console.error(`[init] could not process the game log: ${e.message}`);
}
