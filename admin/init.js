'use strict';
// Runs once at container start, before supervisord: makes sure the data directory exists
// and writes the game server config from the saved settings (or the defaults).

const fs = require('fs');
const path = require('path');
const { Store } = require('./lib/config');

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
