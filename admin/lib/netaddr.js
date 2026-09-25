'use strict';
// Real client addresses behind reverse proxies.
//
// nginx in the container passes the address it saw as X-Real-IP and appends it to
// X-Forwarded-For. When that address belongs to a trusted proxy (TRUSTED_PROXIES,
// a comma/space separated list of IPv4 addresses or CIDR ranges), the client is the
// right-most X-Forwarded-For entry that is not a trusted proxy. Entries further left
// were written by the client itself and are never trusted. The game server
// (include/ioq3ded/ioq3ded.fixed.js, realClientAddress) applies the same rule.

function packed(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m || m.slice(1).some(o => Number(o) > 255)) return null;
  return ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
}

function parseCidrs(list) {
  const out = [];
  for (const entry of String(list || '').split(/[\s,]+/)) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(entry);
    if (!m) continue;
    const ip = packed(m[1]);
    if (ip === null) continue;
    const bits = m[2] === undefined ? 32 : Math.min(32, Number(m[2]));
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    out.push([(ip & mask) >>> 0, mask]);
  }
  return out;
}

function normalize(ip) {
  return String(ip || '').trim().replace(/^::ffff:/i, '');
}

function isLoopback(ip) {
  return ip === '::1' || /^127\./.test(ip);
}

function inList(ip, cidrs) {
  const v = packed(ip);
  if (v === null) return false;
  return cidrs.some(([net, mask]) => ((v & mask) >>> 0) === net);
}

// peer: the address that connected to nginx (X-Real-IP); xff: X-Forwarded-For.
function clientAddress(peer, xff, cidrs) {
  const direct = normalize(peer);
  if (!isLoopback(direct) && !inList(direct, cidrs)) return direct;
  const hops = String(xff || '').split(',').map(normalize).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (packed(hop) === null) break; // stop at anything that is not an IPv4 address
    if (!inList(hop, cidrs)) return hop;
  }
  return direct;
}

module.exports = { parseCidrs, clientAddress, packed };
