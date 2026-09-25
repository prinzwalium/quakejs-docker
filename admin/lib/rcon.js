'use strict';
// Talks to the game server the same way the browser client does: every websocket
// message is one Quake 3 UDP packet. Out-of-band packets start with 0xFFFFFFFF.
// Uses the WebSocket client built into Node.js (>= 22), no extra dependencies.

const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);

// The server drops out-of-band packets (getstatus and rcon) from one address beyond a burst
// of 10, refilled at one per second (ioq3 SVC_RateLimitAddress), without answering. Stay
// below that with a little room for the healthcheck, which also asks from 127.0.0.1.
const BURST = 8;
const REFILL_MS = 1000;

class RconError extends Error {}

class Rcon {
  constructor({ url, password, timeoutMs = 3000, settleMs = 250 }) {
    this.url = url;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.settleMs = settleMs;
    this.queue = Promise.resolve();
    this.bucket = 0;
    this.bucketAt = Date.now();
  }

  // Waits until one more packet fits into the server's rate limit, then counts it.
  async _throttle() {
    for (;;) {
      const now = Date.now();
      const drained = Math.floor((now - this.bucketAt) / REFILL_MS);
      if (drained > 0) {
        this.bucket = Math.max(0, this.bucket - drained);
        this.bucketAt += drained * REFILL_MS;
      }
      if (this.bucket === 0) this.bucketAt = now;
      if (this.bucket < BURST) {
        this.bucket++;
        return;
      }
      await new Promise(r => setTimeout(r, this.bucketAt + REFILL_MS - now + 5));
    }
  }

  // Sends one OOB packet and collects the replies. Long rcon output arrives in several
  // packets, so we wait until no packet has arrived for settleMs.
  _request(body, expectPrefix) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        return reject(new RconError('Game server not reachable'));
      }
      ws.binaryType = 'arraybuffer';
      const parts = [];
      let settle = null;
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(settle);
        try { ws.close(); } catch (e) { /* ignore */ }
        if (err) reject(err); else resolve(parts.join(''));
      };
      const timer = setTimeout(() => {
        finish(parts.length ? null : new RconError('Game server did not answer'));
      }, this.timeoutMs);
      ws.onopen = () => ws.send(Buffer.concat([OOB, Buffer.from(body + '\n', 'latin1')]));
      ws.onerror = () => finish(new RconError('Game server not reachable'));
      ws.onclose = () => finish(parts.length ? null : new RconError('Game server closed the connection'));
      ws.onmessage = (ev) => {
        const buf = Buffer.from(ev.data);
        if (buf.length < 4 || !buf.subarray(0, 4).equals(OOB)) return;
        const text = buf.subarray(4).toString('latin1');
        if (!text.startsWith(expectPrefix)) return;
        parts.push(text.slice(expectPrefix.length));
        clearTimeout(settle);
        settle = setTimeout(() => finish(null), this.settleMs);
      };
    });
  }

  // Requests are serialized and paced: the server rate-limits out-of-band packets.
  _enqueue(fn) {
    const paced = () => this._throttle().then(fn);
    const run = this.queue.then(paced, paced);
    this.queue = run.catch(() => {});
    return run;
  }

  command(cmd) {
    if (/[\r\n]/.test(cmd)) throw new RconError('Command must be a single line');
    return this._enqueue(async () => {
      const out = await this._request(`rcon ${this.password} ${cmd}`, 'print\n');
      if (/^Bad rconpassword\./.test(out)) throw new RconError('Game server rejected the rcon password (restart the server to apply it)');
      return out;
    });
  }

  // Public server info and player list, no password needed.
  async status() {
    const out = await this._enqueue(() => this._request('getstatus', 'statusResponse\n'));
    const lines = out.split('\n');
    const info = {};
    const kv = (lines.shift() || '').split('\\');
    for (let i = 1; i + 1 < kv.length; i += 2) info[kv[i]] = kv[i + 1];
    const players = [];
    for (const l of lines) {
      const m = /^(-?\d+) (\d+) "(.*)"$/.exec(l);
      if (m) players.push({ score: Number(m[1]), ping: Number(m[2]), name: m[3] });
    }
    return { info, players };
  }

  // Client numbers are only available through the rcon "status" command.
  async clients() {
    const out = await this.command('status');
    const clients = [];
    for (const l of out.split('\n')) {
      const m = /^\s*(\d+)\s+(-?\d+)\s+(\S+)\s+(.*?)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s*$/.exec(l);
      // Kicked or disconnected clients stay listed as "ZMBI" for a few seconds.
      if (m && m[3] !== 'ZMBI') {
        const ipm = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(m[6]);
        clients.push({
          num: Number(m[1]), score: Number(m[2]), ping: m[3], name: m[4].replace(/\^./g, ''),
          bot: m[6] === 'bot', ip: ipm ? ipm[1] : null,
        });
      }
    }
    const map = (/^map:\s*(\S+)/m.exec(out) || [])[1] || null;
    return { map, clients };
  }
}

module.exports = { Rcon, RconError };
