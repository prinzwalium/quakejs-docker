'use strict';
// Settings presets: named sets of game settings (mode, limits, bots, map rotation) that can
// be applied in one step. Server name, password and access settings are not part of a preset.
// Stored in /data/presets.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { defaults, validate, ValidationError, writeFileAtomic } = require('./config');

const MAX_PRESETS = 50;
const MAX_NAME = 40;
const PRESET_KEYS = [
  'gametype', 'maxclients', 'fraglimit', 'timelimit', 'capturelimit', 'friendlyfire', 'teamAutoJoin',
  'quadfactor', 'weaponrespawn', 'forcerespawn', 'inactivity', 'botEnable', 'botMinplayers', 'botSkill',
  'rotation', 'extra',
];

class PresetError extends Error {}

function pick(settings) {
  const out = {};
  for (const k of PRESET_KEYS) if (k in settings) out[k] = settings[k];
  return out;
}

function starters() {
  const d = pick(defaults());
  return [
    { name: 'Free for all', settings: d },
    {
      name: 'Capture the flag',
      settings: Object.assign({}, d, { gametype: 4, capturelimit: 8, timelimit: 15, fraglimit: 0, rotation: ['q3wctf1', 'q3wctf2', 'q3wctf3'] }),
    },
    {
      name: 'Tournament 1v1',
      settings: Object.assign({}, d, { gametype: 1, fraglimit: 10, timelimit: 10, rotation: ['q3tourney2', 'pro-q3tourney2', 'pro-q3tourney4', 'ztn3tourney1'] }),
    },
  ];
}

function cleanPresetName(v) {
  return String(v || '').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

class Presets {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'presets.json');
    this.list = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.list = this.validateList(raw.presets || []);
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[admin] ignoring unreadable ${this.file}: ${e.message}`);
      if (e.code === 'ENOENT') {
        this.list = this.validateList(starters());
        try { this.save(); } catch (err) { console.error(`[admin] could not write ${this.file}: ${err.message}`); }
      }
    }
  }

  // One untrusted preset. Maps are not checked here: a preset may name maps this server
  // does not have; they are left out when it is applied.
  validateEntry(p) {
    if (!p || typeof p !== 'object') throw new PresetError('Invalid preset');
    const name = cleanPresetName(p.name);
    if (!name) throw new PresetError('A preset needs a name');
    let settings;
    try {
      settings = pick(validate(pick(p.settings || {}), defaults(), []));
    } catch (e) {
      if (e instanceof ValidationError) throw new PresetError(`Preset "${name}": ${e.message}`);
      throw e;
    }
    const id = typeof p.id === 'string' && /^[a-f0-9]{12}$/.test(p.id) ? p.id : crypto.randomBytes(6).toString('hex');
    return { id, name, settings };
  }

  validateList(list) {
    if (!Array.isArray(list)) throw new PresetError('Invalid preset list');
    if (list.length > MAX_PRESETS) throw new PresetError(`At most ${MAX_PRESETS} presets`);
    const out = [];
    const seen = new Set();
    for (const p of list) {
      const v = this.validateEntry(p);
      if (seen.has(v.name.toLowerCase()) || out.some(o => o.id === v.id)) continue;
      seen.add(v.name.toLowerCase());
      out.push(v);
    }
    return out;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, presets: this.list }, null, 2) + '\n', 0o600);
  }

  // Saves the given settings under name; an existing preset with the same name is replaced.
  saveCurrent(name, settings) {
    const entry = this.validateEntry({ name, settings });
    const i = this.list.findIndex(p => p.name.toLowerCase() === entry.name.toLowerCase());
    if (i >= 0) {
      entry.id = this.list[i].id;
      this.list[i] = entry;
    } else {
      if (this.list.length >= MAX_PRESETS) throw new PresetError(`At most ${MAX_PRESETS} presets`);
      this.list.push(entry);
    }
    this.save();
    return entry;
  }

  remove(id) {
    const i = this.list.findIndex(p => p.id === id);
    if (i < 0) throw new PresetError('Preset not found');
    const [gone] = this.list.splice(i, 1);
    this.save();
    return gone;
  }

  get(id) {
    const p = this.list.find(x => x.id === id);
    if (!p) throw new PresetError('Preset not found');
    return p;
  }

  // Settings to apply on this server: maps it does not have are dropped from the rotation.
  resolve(id, current, knownMaps) {
    const p = this.get(id);
    const s = Object.assign({}, p.settings);
    if (knownMaps.length) {
      s.rotation = s.rotation.filter(m => knownMaps.includes(m));
      if (!s.rotation.length) throw new PresetError(`None of the maps of "${p.name}" are available on this server`);
    }
    try {
      return { preset: p, settings: validate(s, current, knownMaps), dropped: p.settings.rotation.filter(m => !s.rotation.includes(m)) };
    } catch (e) {
      if (e instanceof ValidationError) throw new PresetError(e.message);
      throw e;
    }
  }

  replaceAll(list) {
    this.list = list;
    this.save();
  }
}

module.exports = { Presets, PresetError, PRESET_KEYS, starters };
