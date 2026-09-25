'use strict';
// Player roster: known players with display name, aliases and default model.
// Stored in /data/players.json. Names are matched case-insensitively without color codes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./config');

const MAX_PLAYERS = 500;
const MAX_ALIASES = 20;
const MODEL_RE = /^[a-z0-9_-]{1,32}(\/[a-z0-9_-]{1,32})?$/;

class RosterError extends Error {}

// Q3 player names: printable ASCII without characters that break commands or quoting.
// Color codes (^1 etc.) are removed for matching and stored names.
function cleanName(name) {
  return String(name)
    .replace(/\^./g, '')
    .replace(/["\\;+%]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 32);
}

function nameKey(name) {
  return cleanName(name).toLowerCase();
}

class Roster {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'players.json');
    this.players = [];
    this.index = new Map();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.players = this.validate(raw.players || [], []);
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[admin] ignoring unreadable ${this.file}: ${e.message}`);
      this.players = [];
    }
    this.reindex();
  }

  reindex() {
    this.index = new Map();
    for (const p of this.players) {
      for (const n of [p.name, ...p.aliases]) this.index.set(nameKey(n), p);
    }
  }

  // Validates an untrusted list of players. models: available models (may be empty).
  validate(list, models) {
    if (!Array.isArray(list)) throw new RosterError('Invalid player list');
    if (list.length > MAX_PLAYERS) throw new RosterError(`At most ${MAX_PLAYERS} players`);
    const seen = new Set();
    const out = [];
    for (const p of list) {
      if (!p || typeof p !== 'object') throw new RosterError('Invalid player entry');
      const name = cleanName(p.name || '');
      if (!name) throw new RosterError('Every player needs a name');
      const aliasesIn = Array.isArray(p.aliases) ? p.aliases : [];
      if (aliasesIn.length > MAX_ALIASES) throw new RosterError(`At most ${MAX_ALIASES} aliases per player`);
      const aliases = [];
      for (const a of aliasesIn) {
        const c = cleanName(a);
        if (c && nameKey(c) !== nameKey(name) && !aliases.some(x => nameKey(x) === nameKey(c))) aliases.push(c);
      }
      for (const n of [name, ...aliases]) {
        const k = nameKey(n);
        if (seen.has(k)) throw new RosterError(`The name "${n}" is used more than once`);
        seen.add(k);
      }
      let model = typeof p.model === 'string' ? p.model.toLowerCase().trim() : '';
      if (model && (!MODEL_RE.test(model) || (models.length && !models.includes(model)))) {
        throw new RosterError(`Unknown model "${model}" for ${name}`);
      }
      const id = typeof p.id === 'string' && /^[a-f0-9]{12}$/.test(p.id) ? p.id : crypto.randomBytes(6).toString('hex');
      out.push({ id, name, aliases, model });
    }
    return out;
  }

  save(list, models) {
    const players = this.validate(list, models);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, players }, null, 2) + '\n', 0o600);
    this.players = players;
    this.reindex();
    return players;
  }

  // Roster entry for an in-game name, or null.
  resolve(name) {
    return this.index.get(nameKey(name)) || null;
  }
}

module.exports = { Roster, RosterError, cleanName, nameKey, MODEL_RE };
