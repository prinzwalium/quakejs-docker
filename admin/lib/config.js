'use strict';
// Settings schema, validation and generation of the game server's config files.
//
// The server executes server.cfg at startup (see supervisord.conf). server.cfg only
// runs settings.cfg and starts the map rotation, so settings.cfg can be re-executed
// over rcon to apply changes without changing the current map.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GAMETYPES = { 0: 'Free For All', 1: 'Tournament', 3: 'Team Deathmatch', 4: 'Capture The Flag' };

// type: 'string' | 'int' | 'bool'. latched: the server only applies a change when the next
// map loads (a map change or a server restart).
const FIELDS = {
  hostname:      { type: 'string', max: 64, def: 'quakejs', cvar: 'sv_hostname' },
  motd:          { type: 'string', max: 128, def: 'Welcome to the Local baseq3 QuakeJS Server', cvar: 'g_motd' },
  password:      { type: 'string', max: 32, def: '', cvar: 'g_password' },
  maxclients:    { type: 'int', min: 1, max: 32, def: 12, cvar: 'sv_maxclients', latched: true },
  gametype:      { type: 'int', enum: Object.keys(GAMETYPES).map(Number), def: 0, cvar: 'g_gametype', latched: true },
  fraglimit:     { type: 'int', min: 0, max: 999, def: 20, cvar: 'fraglimit' },
  timelimit:     { type: 'int', min: 0, max: 999, def: 10, cvar: 'timelimit' },
  capturelimit:  { type: 'int', min: 0, max: 999, def: 8, cvar: 'capturelimit' },
  friendlyfire:  { type: 'bool', def: false, cvar: 'g_friendlyfire' },
  quadfactor:    { type: 'int', min: 1, max: 10, def: 3, cvar: 'g_quadfactor' },
  weaponrespawn: { type: 'int', min: 1, max: 60, def: 3, cvar: 'g_weaponrespawn' },
  forcerespawn:  { type: 'int', min: 0, max: 60, def: 0, cvar: 'g_forcerespawn' },
  inactivity:    { type: 'int', min: 0, max: 86400, def: 3000, cvar: 'g_inactivity' },
  botEnable:     { type: 'bool', def: true, cvar: 'bot_enable', latched: true },
  botMinplayers: { type: 'int', min: 0, max: 32, def: 0, cvar: 'bot_minplayers' },
  botSkill:      { type: 'int', min: 1, max: 5, def: 3, cvar: 'g_spSkill' },
};

const DEFAULT_ROTATION = ['q3dm1', 'q3dm7', 'q3dm17', 'pro-q3tourney2', 'pro-q3tourney4', 'pro-q3dm6', 'pro-q3dm13', 'q3tourney2'];
const MAP_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ROTATION = 64;
const MAX_EXTRA = 4000;

function defaults() {
  const s = {};
  for (const [k, f] of Object.entries(FIELDS)) s[k] = f.def;
  s.rotation = DEFAULT_ROTATION.slice();
  s.extra = '';
  return s;
}

// Strip everything that could break out of a quoted cvar value or start a new command.
function cleanString(v, max) {
  return String(v).replace(/["\\;\r\n]/g, '').replace(/[^\x20-\x7e]/g, '').slice(0, max);
}

class ValidationError extends Error {}

// Validates untrusted input. Unknown keys are ignored, missing keys keep their current value.
// knownMaps: list of maps on the server (may be empty before the first start).
function validate(input, current, knownMaps) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Invalid settings');
  const out = Object.assign(defaults(), current);
  for (const [k, f] of Object.entries(FIELDS)) {
    if (!(k in input)) continue;
    const v = input[k];
    if (f.type === 'string') {
      if (typeof v !== 'string') throw new ValidationError(`${k} must be text`);
      out[k] = cleanString(v, f.max);
    } else if (f.type === 'bool') {
      if (typeof v !== 'boolean') throw new ValidationError(`${k} must be true or false`);
      out[k] = v;
    } else {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (!Number.isInteger(n)) throw new ValidationError(`${k} must be a whole number`);
      if (f.enum && !f.enum.includes(n)) throw new ValidationError(`${k} has an invalid value`);
      if (f.min !== undefined && (n < f.min || n > f.max)) throw new ValidationError(`${k} must be between ${f.min} and ${f.max}`);
      out[k] = n;
    }
  }
  if ('rotation' in input) {
    const r = input.rotation;
    if (!Array.isArray(r) || r.length < 1 || r.length > MAX_ROTATION) throw new ValidationError(`Map rotation needs 1 to ${MAX_ROTATION} maps`);
    for (const m of r) {
      if (typeof m !== 'string' || !MAP_RE.test(m)) throw new ValidationError('Invalid map name in rotation');
      if (knownMaps.length && !knownMaps.includes(m.toLowerCase())) throw new ValidationError(`Map "${m}" is not available on this server`);
    }
    out.rotation = r.map(m => m.toLowerCase());
  }
  if ('extra' in input) {
    if (typeof input.extra !== 'string' || input.extra.length > MAX_EXTRA) throw new ValidationError(`Extra config must be text of at most ${MAX_EXTRA} characters`);
    out.extra = input.extra.replace(/\r/g, '');
  }
  return out;
}

// Lines of the free-form extra config that would override values the admin interface relies on.
function extraLines(extra) {
  return extra.split('\n')
    .map(l => l.replace(/[^\x20-\x7e\t]/g, '').trim())
    .filter(l => l && !/rconpassword|\bvstr\s+d\d|\bset[as]?\s+d\d+\b|\bquit\b|\bexec\b/i.test(l));
}

function renderSettingsCfg(s, rconPassword) {
  const lines = ['// Generated by the QuakeJS admin interface. Changes made here are overwritten.'];
  for (const [k, f] of Object.entries(FIELDS)) {
    const v = f.type === 'bool' ? (s[k] ? 1 : 0) : s[k];
    lines.push(f.type === 'string' ? `seta ${f.cvar} "${cleanString(v, f.max)}"` : `seta ${f.cvar} ${v}`);
  }
  lines.push(`seta rconpassword "${rconPassword}"`);
  const rot = s.rotation;
  rot.forEach((m, i) => {
    lines.push(`set d${i + 1} "map ${m} ; set nextmap vstr d${(i + 1) % rot.length + 1}"`);
  });
  const extra = extraLines(s.extra || '');
  if (extra.length) lines.push('// Extra config', ...extra);
  return lines.join('\n') + '\n';
}

const SERVER_CFG = '// Generated by the QuakeJS admin interface. Settings live in settings.cfg.\nexec settings.cfg\nvstr d1\n';

// Atomic write: never leaves a half-written file behind if the process dies.
function writeFileAtomic(file, data, mode) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: mode || 0o644 });
  fs.renameSync(tmp, file);
}

class Store {
  constructor({ dataDir, gameDirs }) {
    this.dataDir = dataDir;
    this.gameDirs = gameDirs;
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.rconFile = path.join(dataDir, 'rcon_password');
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      return validate(raw, defaults(), []);
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[admin] ignoring unreadable ${this.settingsFile}: ${e.message}`);
      return defaults();
    }
  }

  // RCON_PASSWORD from the environment wins; otherwise a random one is generated once and kept.
  rconPassword() {
    const env = process.env.RCON_PASSWORD;
    if (env) {
      if (!/^[A-Za-z0-9_\-.:@#%+=]{8,64}$/.test(env)) {
        throw new Error('RCON_PASSWORD must be 8 to 64 characters from A-Z a-z 0-9 _ - . : @ # % + =');
      }
      return env;
    }
    try {
      const p = fs.readFileSync(this.rconFile, 'utf8').trim();
      if (/^[a-f0-9]{32,}$/.test(p)) return p;
    } catch (e) { /* generate below */ }
    const p = crypto.randomBytes(24).toString('hex');
    writeFileAtomic(this.rconFile, p + '\n', 0o600);
    return p;
  }

  save(settings) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    writeFileAtomic(this.settingsFile, JSON.stringify(settings, null, 2) + '\n', 0o600);
    this.writeGameConfig(settings);
  }

  writeGameConfig(settings) {
    const cfg = renderSettingsCfg(settings, this.rconPassword());
    for (const dir of this.gameDirs) {
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(path.join(dir, 'settings.cfg'), cfg, 0o600);
      writeFileAtomic(path.join(dir, 'server.cfg'), SERVER_CFG, 0o644);
    }
  }
}

module.exports = { FIELDS, GAMETYPES, MAP_RE, defaults, validate, ValidationError, renderSettingsCfg, cleanString, Store };
