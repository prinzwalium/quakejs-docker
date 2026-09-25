'use strict';
// Player statistics from the game server's log (games.log).
//
// The log is followed by byte offset; the offset and all totals are kept in
// /data/stats.json so nothing is counted twice and stats survive restarts.
// Totals are stored per player name (without color codes, case-insensitive) and
// grouped by roster entry only when they are read, so later roster changes apply
// to the whole history.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./config');
const { cleanName, nameKey } = require('./players');

const WORLD = 1022;
const MAX_NAMES = 5000;
const MAX_READ = 4 * 1024 * 1024;
const MAX_LINE = 4096;

const WEAPONS = {
  MOD_GAUNTLET: 'Gauntlet',
  MOD_MACHINEGUN: 'Machine gun',
  MOD_SHOTGUN: 'Shotgun',
  MOD_GRENADE: 'Grenade launcher',
  MOD_GRENADE_SPLASH: 'Grenade launcher',
  MOD_ROCKET: 'Rocket launcher',
  MOD_ROCKET_SPLASH: 'Rocket launcher',
  MOD_PLASMA: 'Plasma gun',
  MOD_PLASMA_SPLASH: 'Plasma gun',
  MOD_RAILGUN: 'Railgun',
  MOD_LIGHTNING: 'Lightning gun',
  MOD_BFG: 'BFG',
  MOD_BFG_SPLASH: 'BFG',
  MOD_TELEFRAG: 'Telefrag',
};

function parseInfo(str) {
  const out = {};
  const parts = str.split('\\');
  // userinfo lines start without a leading backslash ("n\Name\t\0..."), serverinfo with one.
  let i = parts[0] === '' ? 1 : 0;
  for (; i + 1 < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
}

function emptyTotals() {
  return {
    kills: 0, deaths: 0, suicides: 0, teamKills: 0, killsVsBots: 0, killsVsHumans: 0,
    matches: 0, wins: 0, bestScore: 0, weapons: {},
  };
}

function emptyState() {
  return { version: 1, log: { ino: null, offset: 0 }, names: {}, resetAt: Date.now() };
}

class Stats {
  constructor({ dataDir, logFile, onUserinfo }) {
    this.file = path.join(dataDir, 'stats.json');
    this.logFile = logFile;
    this.onUserinfo = onUserinfo || null;
    this.state = this.load();
    this.clients = new Map();
    this.match = null;
    this.partial = '';
    this.dirty = false;
    this.saveTimer = null;
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (s && s.version === 1 && s.names && s.log) return s;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[stats] ignoring unreadable ${this.file}: ${e.message}`);
    }
    return emptyState();
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Save the position of the last complete line, so a half-written line is read again.
    const log = { ino: this.state.log.ino, offset: Math.max(0, this.state.log.offset - Buffer.byteLength(this.partial, 'latin1')) };
    writeFileAtomic(this.file, JSON.stringify(Object.assign({}, this.state, { log })) + '\n', 0o600);
    this.dirty = false;
  }

  scheduleSave() {
    this.dirty = true;
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), 10000);
  }

  // Archives the current totals and starts from zero (the log position is kept).
  reset(archiveDir) {
    this.save();
    if (fs.existsSync(this.file)) {
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.copyFileSync(this.file, path.join(archiveDir, `stats-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    }
    const log = this.state.log;
    this.state = emptyState();
    this.state.log = log;
    this.dirty = true;
    this.save();
  }

  // Reads new lines from the log. live=false while catching up at container start.
  ingest(live = true) {
    let st;
    try {
      st = fs.statSync(this.logFile);
    } catch (e) {
      return 0;
    }
    const log = this.state.log;
    if (log.ino !== st.ino || st.size < log.offset) {
      // New or truncated log file: start from the beginning.
      log.ino = st.ino;
      log.offset = 0;
      this.partial = '';
      this.clients.clear();
      this.match = null;
    }
    let lines = 0;
    const fd = fs.openSync(this.logFile, 'r');
    try {
      while (log.offset < st.size) {
        const len = Math.min(MAX_READ, st.size - log.offset);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, log.offset);
        if (n <= 0) break;
        log.offset += n;
        const text = this.partial + buf.subarray(0, n).toString('latin1');
        const parts = text.split('\n');
        this.partial = parts.pop();
        if (this.partial.length > MAX_LINE) this.partial = '';
        for (const line of parts) {
          try {
            this.line(line.replace(/\r$/, ''), live);
          } catch (e) {
            console.error(`[stats] skipped log line: ${e.message}`);
          }
          lines++;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    if (lines) this.scheduleSave();
    return lines;
  }

  player(name, bot) {
    const clean = cleanName(name);
    if (!clean) return null;
    const key = clean.toLowerCase();
    let p = this.state.names[key];
    if (!p) {
      const keys = Object.keys(this.state.names);
      if (keys.length >= MAX_NAMES) {
        // Drop the name that was seen least recently.
        let oldest = keys[0];
        for (const k of keys) if (this.state.names[k].lastSeen < this.state.names[oldest].lastSeen) oldest = k;
        delete this.state.names[oldest];
      }
      p = this.state.names[key] = Object.assign({ name: clean, bot: !!bot, model: '', firstSeen: Date.now(), lastSeen: Date.now() }, emptyTotals());
    }
    if (bot !== undefined) p.bot = !!bot;
    p.name = clean;
    p.lastSeen = Date.now();
    return p;
  }

  line(raw, live) {
    const m = /^\s*\d+:\d+\s+([A-Za-z]+):\s?(.*)$/.exec(raw);
    if (!m) {
      this.matchLine(raw.trim());
      return;
    }
    const [, event, rest] = m;
    // The score lines follow "Exit:" directly; the first other line completes the match.
    // (With only bots on the server the intermission may never end, so don't wait for ShutdownGame.)
    if (this.match && this.match.exited && !['Exit', 'score', 'red'].includes(event)) this.finishMatch();
    switch (event) {
      case 'InitGame': {
        const info = parseInfo(rest);
        this.clients.clear();
        this.match = { gametype: Number(info.g_gametype) || 0, map: info.mapname || '', exited: false, scores: [], red: null, blue: null };
        break;
      }
      case 'ClientUserinfoChanged': {
        const um = /^(\d+)\s+(.*)$/.exec(rest);
        if (!um) break;
        const num = Number(um[1]);
        const info = parseInfo(um[2]);
        const name = cleanName(info.n || '');
        if (!name) break;
        const bot = 'skill' in info;
        this.clients.set(num, { name, bot, team: Number(info.t) || 0 });
        const p = this.player(name, bot);
        if (p && info.model) p.model = String(info.model).toLowerCase().slice(0, 65);
        if (live && this.onUserinfo) this.onUserinfo({ num, name, bot });
        break;
      }
      case 'ClientDisconnect':
        this.clients.delete(Number(rest));
        break;
      case 'Kill': {
        const km = /^(\d+)\s+(\d+)\s+\d+:.*\bby\s+(MOD_[A-Z_]+)/.exec(rest);
        if (!km) break;
        const killer = Number(km[1]);
        const victim = this.clients.get(Number(km[2]));
        if (!victim) break;
        const vp = this.player(victim.name);
        vp.deaths++;
        if (killer === WORLD || killer === Number(km[2])) {
          vp.suicides++;
          break;
        }
        const k = this.clients.get(killer);
        if (!k) break;
        const kp = this.player(k.name);
        const teamGame = this.match && this.match.gametype >= 3;
        if (teamGame && k.team && k.team === victim.team) {
          kp.teamKills++;
          break;
        }
        kp.kills++;
        if (victim.bot) kp.killsVsBots++; else kp.killsVsHumans++;
        const weapon = WEAPONS[km[3]] || 'Other';
        kp.weapons[weapon] = (kp.weapons[weapon] || 0) + 1;
        break;
      }
      case 'Exit':
        if (this.match) this.match.exited = true;
        break;
      case 'ShutdownGame':
        this.finishMatch();
        this.match = null;
        this.clients.clear();
        break;
      default:
        this.matchLine(`${event}:${rest}`);
    }
  }

  // Score lines after "Exit:" (they are not always prefixed with a timestamp).
  matchLine(text) {
    if (!this.match || !this.match.exited || this.match.finished) return;
    const tm = /^red:\s*(-?\d+)\s+blue:\s*(-?\d+)/.exec(text);
    if (tm) {
      this.match.red = Number(tm[1]);
      this.match.blue = Number(tm[2]);
      return;
    }
    const sm = /score:\s*(-?\d+)\s+ping:\s*\d+\s+client:\s*(\d+)\s+(.*)$/.exec(text);
    if (sm) {
      const c = this.clients.get(Number(sm[2]));
      const name = c ? c.name : cleanName(sm[3]);
      if (name) this.match.scores.push({ name, score: Number(sm[1]), team: c ? c.team : 0 });
    }
  }

  finishMatch() {
    const m = this.match;
    if (!m || !m.exited || m.finished || !m.scores.length) return;
    m.finished = true;
    let winners = [];
    if (m.gametype >= 3 && m.red !== null && m.red !== m.blue) {
      const team = m.red > m.blue ? 1 : 2;
      winners = m.scores.filter(s => s.team === team).map(s => s.name);
    } else if (m.gametype < 3) {
      const top = Math.max(...m.scores.map(s => s.score));
      const best = m.scores.filter(s => s.score === top);
      if (best.length === 1) winners = [best[0].name];
    }
    for (const s of m.scores) {
      const p = this.player(s.name);
      if (!p) continue;
      p.matches++;
      if (winners.includes(s.name)) p.wins++;
      if (s.score > p.bestScore) p.bestScore = s.score;
    }
  }

  // Leaderboard rows, grouped by roster entry. roster.resolve(name) -> entry or null.
  report({ roster, bots }) {
    const groups = new Map();
    for (const p of Object.values(this.state.names)) {
      if (p.bot && !bots) continue;
      const entry = !p.bot && roster ? roster.resolve(p.name) : null;
      const key = entry ? `r:${entry.id}` : `n:${nameKey(p.name)}`;
      let g = groups.get(key);
      if (!g) {
        g = Object.assign({ name: entry ? entry.name : p.name, roster: !!entry, bot: p.bot, aliases: [], model: '', firstSeen: p.firstSeen, lastSeen: 0 }, emptyTotals());
        groups.set(key, g);
      }
      if (entry && p.name.toLowerCase() !== entry.name.toLowerCase()) g.aliases.push(p.name);
      for (const f of ['kills', 'deaths', 'suicides', 'teamKills', 'killsVsBots', 'killsVsHumans', 'matches', 'wins']) g[f] += p[f];
      g.bestScore = Math.max(g.bestScore, p.bestScore);
      for (const [w, n] of Object.entries(p.weapons)) g.weapons[w] = (g.weapons[w] || 0) + n;
      if (p.lastSeen > g.lastSeen) { g.lastSeen = p.lastSeen; g.model = p.model; }
      g.firstSeen = Math.min(g.firstSeen, p.firstSeen);
    }
    return [...groups.values()].map((g) => {
      const fav = Object.entries(g.weapons).sort((a, b) => b[1] - a[1])[0];
      return Object.assign(g, {
        kd: g.deaths ? Math.round((g.kills / g.deaths) * 100) / 100 : g.kills,
        favoriteWeapon: fav ? fav[0] : null,
      });
    }).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }

  // Human names seen recently that are not in the roster (for "add from recent names").
  recentNames(roster, limit = 50) {
    return Object.values(this.state.names)
      .filter(p => !p.bot && !(roster && roster.resolve(p.name)))
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, limit)
      .map(p => ({ name: p.name, model: p.model, lastSeen: p.lastSeen }));
  }
}

module.exports = { Stats, WEAPONS, parseInfo };
