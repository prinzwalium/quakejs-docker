'use strict';
// Audit log of admin actions: JSON lines in /data/audit.log, rotated at 1 MB (3 old files kept).

const fs = require('fs');
const path = require('path');

const MAX_SIZE = 1024 * 1024;
const KEEP = 3;
const MAX_DETAIL = 300;

class Audit {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'audit.log');
  }

  rotate() {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch (e) { return; }
    if (size < MAX_SIZE) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      try { fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`); } catch (e) { /* missing */ }
    }
    fs.renameSync(this.file, `${this.file}.1`);
    try { fs.unlinkSync(`${this.file}.${KEEP + 1}`); } catch (e) { /* missing */ }
  }

  // Never throws: the audit log must not break the action it records.
  add(ip, action, detail) {
    try {
      this.rotate();
      const entry = {
        time: new Date().toISOString(),
        ip: String(ip || '').slice(0, 64),
        action: String(action).slice(0, 40),
        detail: String(detail || '').replace(/[\r\n]+/g, ' ').slice(0, MAX_DETAIL),
      };
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (e) {
      console.error(`[audit] could not write: ${e.message}`);
    }
  }

  // Newest first, from the current and the previous file.
  recent(limit = 200) {
    const out = [];
    for (const f of [this.file, `${this.file}.1`]) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
      const lines = text.split('\n').filter(Boolean).reverse();
      for (const l of lines) {
        try { out.push(JSON.parse(l)); } catch (e) { /* skip damaged line */ }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}

module.exports = { Audit };
