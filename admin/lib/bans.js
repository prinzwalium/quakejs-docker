'use strict';
// Bans by IP address or player name, with a reason and an optional end time.
// Stored in /data/bans.json and enforced by the admin (players are kicked on join).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./config');
const { cleanName, nameKey } = require('./players');
const { packed } = require('./netaddr');

const MAX_BANS = 1000;
const MAX_REASON = 200;
const MAX_DURATION_MS = 10 * 365 * 24 * 3600 * 1000;

class BanError extends Error {}

class Bans {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'bans.json');
    this.list = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.list = this.validateList(raw.bans || []);
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[admin] ignoring unreadable ${this.file}: ${e.message}`);
    }
  }

  // One untrusted ban entry. Either ip (IPv4) or name must be given.
  validateEntry(b, now = Date.now()) {
    if (!b || typeof b !== 'object') throw new BanError('Invalid ban');
    const ip = typeof b.ip === 'string' ? b.ip.trim() : '';
    const name = typeof b.name === 'string' ? cleanName(b.name) : '';
    if (!ip && !name) throw new BanError('A ban needs an IP address or a name');
    if (ip && packed(ip) === null) throw new BanError(`"${ip}" is not an IPv4 address`);
    const reason = typeof b.reason === 'string' ? b.reason.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_REASON) : '';
    let until = null;
    if (b.until !== null && b.until !== undefined && b.until !== '') {
      until = Number(b.until);
      if (!Number.isFinite(until) || until <= 0 || until > now + MAX_DURATION_MS) throw new BanError('Invalid ban end time');
    }
    const id = typeof b.id === 'string' && /^[a-f0-9]{12}$/.test(b.id) ? b.id : crypto.randomBytes(6).toString('hex');
    const createdAt = Number.isFinite(Number(b.createdAt)) && Number(b.createdAt) > 0 ? Number(b.createdAt) : now;
    return { id, ip: ip || null, name: name || null, reason, until, createdAt };
  }

  validateList(list) {
    if (!Array.isArray(list)) throw new BanError('Invalid ban list');
    if (list.length > MAX_BANS) throw new BanError(`At most ${MAX_BANS} bans`);
    return list.map(b => this.validateEntry(b, Date.now()));
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, bans: this.list }, null, 2) + '\n', 0o600);
  }

  prune(now = Date.now()) {
    const before = this.list.length;
    this.list = this.list.filter(b => b.until === null || b.until > now);
    if (this.list.length !== before) this.save();
  }

  active(now = Date.now()) {
    this.prune(now);
    return this.list.slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  add(entry) {
    if (this.list.length >= MAX_BANS) throw new BanError(`At most ${MAX_BANS} bans`);
    const ban = this.validateEntry(entry);
    this.list.push(ban);
    this.save();
    return ban;
  }

  remove(id) {
    const before = this.list.length;
    this.list = this.list.filter(b => b.id !== id);
    if (this.list.length === before) throw new BanError('Unknown ban');
    this.save();
  }

  replaceAll(list) {
    this.list = this.validateList(list);
    this.save();
  }

  // The active ban matching a player (by IP or name), or null.
  match({ ip, name }, now = Date.now()) {
    const key = name ? nameKey(name) : '';
    return this.list.find(b => (b.until === null || b.until > now)
      && ((b.ip && ip && b.ip === ip) || (b.name && key && nameKey(b.name) === key))) || null;
  }
}

module.exports = { Bans, BanError };
