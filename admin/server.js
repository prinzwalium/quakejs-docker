'use strict';
// QuakeJS admin interface. Listens on localhost only; nginx exposes it at /admin/.
// No dependencies outside Node.js itself.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { FIELDS, GAMETYPES, MAP_RE, validate, ValidationError, Store } = require('./lib/config');
const { Rcon, RconError } = require('./lib/rcon');
const pk3 = require('./lib/pk3');
const { tgaToPng } = require('./lib/tga');
const { Roster, RosterError, cleanName } = require('./lib/players');
const { Stats } = require('./lib/stats');

const HOST = '127.0.0.1';
const PORT = Number(process.env.ADMIN_PORT) || 8081;
const DATA_DIR = process.env.QJS_DATA_DIR || '/data';
const BASE_DIR = process.env.QJS_BASE_DIR || '/quakejs/base';
const GAME_DIR = path.join(BASE_DIR, 'baseq3');
const SUPERVISOR_CONF = process.env.QJS_SUPERVISOR_CONF || '/etc/supervisor/conf.d/supervisord.conf';
const GAME_URL = process.env.QJS_GAME_URL || 'ws://127.0.0.1:27960';
const PUBLIC_DIR = path.join(__dirname, 'public');

const SESSION_ABSOLUTE_MS = 12 * 3600 * 1000;
const SESSION_IDLE_MS = 2 * 3600 * 1000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_BODY = 64 * 1024;

const log = (...a) => console.log('[admin]', ...a);

// ---------------------------------------------------------------- password

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
let disabledReason = null;
if (!ADMIN_PASSWORD) disabledReason = 'The admin interface is disabled. Set the ADMIN_PASSWORD environment variable to enable it.';
else if (ADMIN_PASSWORD.length < 12) disabledReason = 'The admin interface is disabled: ADMIN_PASSWORD must be at least 12 characters long.';

const pwSalt = crypto.randomBytes(16);
const scrypt = (pw) => new Promise((res, rej) => crypto.scrypt(pw, pwSalt, 32, (e, k) => (e ? rej(e) : res(k))));
const pwHash = disabledReason ? null : crypto.scryptSync(ADMIN_PASSWORD, pwSalt, 32);
// Do not hand the password down to child processes (supervisorctl).
delete process.env.ADMIN_PASSWORD;

// ---------------------------------------------------------------- state

const store = new Store({ dataDir: DATA_DIR, gameDirs: [GAME_DIR, path.join(BASE_DIR, 'cpma')] });
let settings = store.load();
const rcon = new Rcon({ url: GAME_URL, password: store.rconPassword() });
const roster = new Roster(DATA_DIR);

// "Roster names only": kick humans whose name is not on the roster. The log line may be
// older than the current game state, so the name is checked against the live client list first.
const recentKicks = new Map();
async function enforceRoster({ num, name, bot }) {
  if (bot || settings.nameMode !== 1 || roster.resolve(name)) return;
  const key = `${num}:${name.toLowerCase()}`;
  if (recentKicks.has(key) && recentKicks.get(key) > Date.now() - 10000) return;
  recentKicks.set(key, Date.now());
  if (recentKicks.size > 1000) recentKicks.clear();
  try {
    const { clients } = await rcon.clients();
    const c = clients.find(x => x.num === num);
    if (!c || c.bot || cleanName(c.name).toLowerCase() !== name.toLowerCase()) return;
    log(`kicking "${name}" (client ${num}): not on the player roster`);
    await rcon.command(`clientkick ${num}`);
  } catch (e) {
    log(`could not enforce roster for "${name}": ${e.message}`);
  }
}

// Checks everyone who is connected right now (after enabling the mode or editing the roster).
async function enforceRosterAll() {
  if (settings.nameMode !== 1) return;
  try {
    const { clients } = await rcon.clients();
    for (const c of clients) if (!c.bot) await enforceRoster({ num: c.num, name: cleanName(c.name), bot: false });
  } catch (e) {
    log(`could not check connected players: ${e.message}`);
  }
}

const stats = new Stats({
  dataDir: DATA_DIR,
  logFile: path.join(GAME_DIR, 'games.log'),
  onUserinfo: (u) => { enforceRoster(u); },
});
setInterval(() => {
  try {
    stats.ingest(true);
  } catch (e) {
    console.error('[stats]', e.message);
  }
}, 2000).unref();

let mapCache = { key: null, maps: [], bots: [], models: [], icons: {} };
function available() {
  let key = '';
  try {
    for (const f of fs.readdirSync(GAME_DIR).filter(n => /\.pk3$/i.test(n)).sort()) {
      const st = fs.statSync(path.join(GAME_DIR, f));
      key += `${f}:${st.size}:${st.mtimeMs};`;
    }
  } catch (e) { /* directory missing before the first start */ }
  if (key !== mapCache.key) mapCache = Object.assign({ key }, pk3.scan(GAME_DIR));
  return mapCache;
}

// ---------------------------------------------------------------- sessions & rate limiting

const sessions = new Map();
const loginFails = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expires < now || s.lastSeen + SESSION_IDLE_MS < now) sessions.delete(t);
  for (const [ip, f] of loginFails) if (f.first + LOGIN_WINDOW_MS < now && f.lockedUntil < now) loginFails.delete(ip);
}, 60 * 1000).unref();

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function getSession(req) {
  const token = parseCookies(req).qjs_admin;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const s = sessions.get(token);
  const now = Date.now();
  if (!s || s.expires < now || s.lastSeen + SESSION_IDLE_MS < now) {
    sessions.delete(token);
    return null;
  }
  s.lastSeen = now;
  return s;
}

function isHttps(req) {
  return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token, maxAgeSec) {
  return `qjs_admin=${token}; Path=/admin/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

function clientIp(req) {
  // Only nginx in the same container can reach this server, so X-Real-IP is trustworthy.
  return req.headers['x-real-ip'] || req.socket.remoteAddress;
}

// ---------------------------------------------------------------- http helpers

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const data = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'],
    'Content-Length': Buffer.byteLength(data),
  }, headers));
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Expected JSON'));
    let size = 0;
    const chunks = [];
    const onData = (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // Stop buffering, drain the rest and let the caller answer with 413.
        req.off('data', onData);
        req.resume();
        reject(new HttpError(413, 'Request too large'));
      } else chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (size > MAX_BODY) return;
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const STATIC = {
  '/admin/': ['index.html', 'text/html; charset=utf-8'],
  '/admin/admin.js': ['admin.js', 'application/javascript; charset=utf-8'],
  '/admin/admin.css': ['admin.css', 'text/css; charset=utf-8'],
  '/stats/': ['stats.html', 'text/html; charset=utf-8'],
  '/stats/stats.js': ['stats.js', 'application/javascript; charset=utf-8'],
  '/stats/stats.css': ['admin.css', 'text/css; charset=utf-8'],
};

// ---------------------------------------------------------------- public endpoints (no login)

// Simple per-IP token bucket for the public endpoints.
const buckets = new Map();
function rateLimit(req, cost = 1) {
  const ip = clientIp(req);
  const now = Date.now();
  const RATE = 2; // tokens per second
  const BURST = 120;
  let b = buckets.get(ip);
  if (!b) {
    if (buckets.size > 10000) buckets.clear();
    b = { tokens: BURST, at: now };
    buckets.set(ip, b);
  }
  b.tokens = Math.min(BURST, b.tokens + ((now - b.at) / 1000) * RATE);
  b.at = now;
  if (b.tokens < cost) throw new HttpError(429, 'Too many requests');
  b.tokens -= cost;
}

const iconCache = new Map();
function iconPng(key) {
  if (iconCache.has(key)) return iconCache.get(key);
  const icon = available().icons[key];
  if (!icon) return null;
  const png = tgaToPng(pk3.readIcon(icon));
  iconCache.set(key, png);
  return png;
}

function statsReport(bots) {
  const rows = stats.report({ roster, bots });
  // Nothing identifying beyond the in-game name is exposed.
  return rows.map(r => ({
    name: r.name, bot: r.bot, roster: r.roster, aliases: r.aliases, model: r.model,
    kills: r.kills, deaths: r.deaths, kd: r.kd, suicides: r.suicides, teamKills: r.teamKills,
    killsVsHumans: r.killsVsHumans, killsVsBots: r.killsVsBots,
    matches: r.matches, wins: r.wins, bestScore: r.bestScore,
    favoriteWeapon: r.favoriteWeapon, weapons: r.weapons,
    firstSeen: r.firstSeen, lastSeen: r.lastSeen,
  }));
}

async function handlePublic(req, res, route, query) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

  if (route === '/admin/api/public/lobby') {
    rateLimit(req);
    const { models } = available();
    const list = models.length ? models : ['sarge'];
    return send(res, 200, {
      models: list.map(m => ({ id: m, icon: `/admin/api/public/icon/${m.includes('/') ? m : `${m}/default`}.png` })),
      roster: roster.players.map(p => ({ name: p.name, model: p.model })),
      rosterOnly: settings.nameMode === 1,
      statsPublic: !!settings.statsPublic,
    });
  }

  const im = /^\/admin\/api\/public\/icon\/([a-z0-9_-]{1,32})\/([a-z0-9_-]{1,32})\.png$/.exec(route);
  if (im) {
    rateLimit(req, 0.25);
    const png = iconPng(`${im[1]}/${im[2]}`);
    if (!png) throw new HttpError(404, 'Not found');
    return send(res, 200, png, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
  }

  if (route === '/admin/api/public/stats') {
    rateLimit(req);
    if (!settings.statsPublic && !(!disabledReason && getSession(req))) throw new HttpError(404, 'Statistics are private');
    return send(res, 200, {
      players: statsReport(query.get('bots') === '1'),
      resetAt: stats.state.resetAt,
    });
  }

  throw new HttpError(404, 'Not found');
}

// ---------------------------------------------------------------- game server control

function restartGameServer() {
  return new Promise((resolve, reject) => {
    execFile('supervisorctl', ['-c', SUPERVISOR_CONF, 'restart', 'quakejs'], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new HttpError(500, `Restart failed: ${(stderr || stdout || err.message).trim()}`));
      resolve(stdout.trim());
    });
  });
}

// Latched settings only apply when the next map loads: compare with what the running server uses.
async function pendingMapChange() {
  const pending = [];
  for (const [k, f] of Object.entries(FIELDS)) {
    if (!f.latched) continue;
    const out = await rcon.command(f.cvar);
    const m = /is:"([^"^]*)/.exec(out);
    const want = String(f.type === 'bool' ? (settings[k] ? 1 : 0) : settings[k]);
    if (m && m[1] !== want) pending.push(k);
  }
  return pending;
}

function cleanSay(msg) {
  return String(msg).replace(/["\\;\r\n]/g, '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 150);
}

async function runAction(body) {
  const { maps, bots } = available();
  switch (body.action) {
    case 'map': {
      const m = String(body.map || '').toLowerCase();
      if (!MAP_RE.test(m) || (maps.length && !maps.includes(m))) throw new HttpError(400, 'Unknown map');
      return rcon.command(`map ${m}`);
    }
    case 'restartMatch':
      return rcon.command('map_restart 0');
    case 'nextMap':
      return rcon.command('vstr nextmap');
    case 'addBot': {
      const name = bots.find(b => b.toLowerCase() === String(body.name || '').toLowerCase());
      const skill = Number(body.skill);
      if (!name) throw new HttpError(400, 'Unknown bot');
      if (!Number.isInteger(skill) || skill < 1 || skill > 5) throw new HttpError(400, 'Bot skill must be 1 to 5');
      return rcon.command(`addbot ${name} ${skill}`);
    }
    case 'kick': {
      const num = Number(body.num);
      if (!Number.isInteger(num) || num < 0 || num > 63) throw new HttpError(400, 'Invalid client number');
      return rcon.command(`clientkick ${num}`);
    }
    case 'kickBots':
      return rcon.command('kick allbots');
    case 'say': {
      const msg = cleanSay(body.message || '');
      if (!msg) throw new HttpError(400, 'Message is empty');
      return rcon.command(`say "${msg}"`);
    }
    default:
      throw new HttpError(400, 'Unknown action');
  }
}

// ---------------------------------------------------------------- routes

async function handleApi(req, res, route, query) {
  if (route.startsWith('/admin/api/public/')) return handlePublic(req, res, route, query);

  if (route === '/admin/api/session' && req.method === 'GET') {
    return send(res, 200, { enabled: !disabledReason, reason: disabledReason, authenticated: !!getSession(req) });
  }

  // Every state-changing request must carry this header. Browsers cannot send custom
  // headers cross-site without a CORS preflight, which this server never allows.
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'qjs-admin') throw new HttpError(403, 'Missing request header');

  if (route === '/admin/api/login' && req.method === 'POST') {
    if (disabledReason) throw new HttpError(503, disabledReason);
    const ip = clientIp(req);
    const now = Date.now();
    const f = loginFails.get(ip);
    if (f && f.lockedUntil > now) {
      throw new HttpError(429, `Too many failed logins. Try again in ${Math.ceil((f.lockedUntil - now) / 60000)} minute(s).`);
    }
    const body = await readJson(req);
    const given = typeof body.password === 'string' ? body.password.slice(0, 1024) : '';
    const ok = crypto.timingSafeEqual(await scrypt(given), pwHash);
    if (!ok) {
      const cur = f && f.first + LOGIN_WINDOW_MS > now ? f : { fails: 0, first: now, lockedUntil: 0 };
      cur.fails++;
      if (cur.fails >= LOGIN_MAX_FAILS) cur.lockedUntil = now + LOGIN_WINDOW_MS;
      if (loginFails.size > 10000) loginFails.clear();
      loginFails.set(ip, cur);
      log(`failed login from ${ip} (${cur.fails})`);
      await new Promise(r => setTimeout(r, 750));
      throw new HttpError(401, 'Wrong password');
    }
    loginFails.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { expires: now + SESSION_ABSOLUTE_MS, lastSeen: now });
    log(`login from ${ip}`);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_ABSOLUTE_MS / 1000) });
  }

  if (route === '/admin/api/logout' && req.method === 'POST') {
    const token = parseCookies(req).qjs_admin;
    if (token) sessions.delete(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (disabledReason) throw new HttpError(503, disabledReason);
  if (!getSession(req)) throw new HttpError(401, 'Not logged in');
  const ip = clientIp(req);

  if (route === '/admin/api/state' && req.method === 'GET') {
    const { maps, bots } = available();
    let pending = null;
    try { pending = await pendingMapChange(); } catch (e) { /* server offline */ }
    const fields = {};
    for (const [k, f] of Object.entries(FIELDS)) {
      fields[k] = { type: f.type, min: f.min, max: f.max, latched: !!f.latched };
    }
    return send(res, 200, { settings, fields, gametypes: GAMETYPES, maps, bots, pendingMapChange: pending });
  }

  if (route === '/admin/api/status' && req.method === 'GET') {
    try {
      const [st, cl] = [await rcon.status(), await rcon.clients()];
      return send(res, 200, {
        online: true,
        map: cl.map || st.info.mapname,
        hostname: st.info.sv_hostname,
        gametype: Number(st.info.g_gametype),
        maxclients: Number(st.info.sv_maxclients),
        clients: cl.clients,
      });
    } catch (e) {
      if (e instanceof RconError) return send(res, 200, { online: false, error: e.message });
      throw e;
    }
  }

  if (route === '/admin/api/settings' && req.method === 'PUT') {
    const body = await readJson(req);
    const next = validate(body, settings, available().maps);
    store.save(next);
    settings = next;
    log(`settings saved by ${ip}`);
    enforceRosterAll();
    let applied = true;
    let applyError = null;
    try {
      await rcon.command('exec settings.cfg');
    } catch (e) {
      applied = false;
      applyError = e.message;
    }
    let pending = null;
    try { pending = await pendingMapChange(); } catch (e) { /* server offline */ }
    return send(res, 200, { ok: true, settings, applied, applyError, pendingMapChange: pending });
  }

  if (route === '/admin/api/restart' && req.method === 'POST') {
    log(`game server restart requested by ${ip}`);
    // Rewrite the config first so the restarted server uses the current settings.
    store.writeGameConfig(settings);
    const out = await restartGameServer();
    return send(res, 200, { ok: true, output: out });
  }

  if (route === '/admin/api/action' && req.method === 'POST') {
    const body = await readJson(req);
    const out = await runAction(body);
    log(`action ${body.action} by ${ip}`);
    return send(res, 200, { ok: true, output: out });
  }

  if (route === '/admin/api/players' && req.method === 'GET') {
    return send(res, 200, { players: roster.players, recent: stats.recentNames(roster), models: available().models });
  }

  if (route === '/admin/api/players' && req.method === 'PUT') {
    const body = await readJson(req);
    const players = roster.save(body.players, available().models);
    log(`player roster saved by ${ip} (${players.length} players)`);
    enforceRosterAll();
    return send(res, 200, { ok: true, players, recent: stats.recentNames(roster) });
  }

  if (route === '/admin/api/stats/reset' && req.method === 'POST') {
    stats.reset(path.join(DATA_DIR, 'stats-archive'));
    log(`statistics reset by ${ip}`);
    return send(res, 200, { ok: true });
  }

  if (route === '/admin/api/console' && req.method === 'POST') {
    const body = await readJson(req);
    const cmd = typeof body.command === 'string' ? body.command.replace(/[\r\n]/g, ' ').trim().slice(0, 256) : '';
    if (!cmd) throw new HttpError(400, 'Command is empty');
    if (/rconpassword|\bquit\b|\bkillserver\b/i.test(cmd)) {
      throw new HttpError(400, 'This command is blocked in the console. Use the settings or the restart button instead.');
    }
    log(`console command by ${ip}: ${cmd}`);
    const out = await rcon.command(cmd);
    return send(res, 200, { ok: true, output: out });
  }

  throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  try {
    const [rawPath, rawQuery] = req.url.split('?');
    const route = decodeURI(rawPath);
    const query = new URLSearchParams(rawQuery || '');
    if (route === '/admin') return send(res, 301, '', { Location: '/admin/', 'Content-Type': 'text/plain' });
    if (route === '/stats') return send(res, 301, '', { Location: '/stats/', 'Content-Type': 'text/plain' });
    if (STATIC[route]) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      const [file, type] = STATIC[route];
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), { 'Content-Type': type });
    }
    if (route.startsWith('/admin/api/')) return await handleApi(req, res, route, query);
    throw new HttpError(404, 'Not found');
  } catch (e) {
    let status = 500;
    let message = 'Internal error';
    if (e instanceof HttpError) [status, message] = [e.status, e.message];
    else if (e instanceof ValidationError || e instanceof RosterError) [status, message] = [400, e.message];
    else if (e instanceof RconError) [status, message] = [502, e.message];
    else if (e instanceof URIError) [status, message] = [400, 'Bad request'];
    else console.error('[admin]', e);
    if (!res.headersSent) send(res, status, { error: message });
    else res.destroy();
  }
});

server.headersTimeout = 10000;
server.requestTimeout = 90000;
server.listen(PORT, HOST, () => log(`listening on ${HOST}:${PORT}${disabledReason ? ' (disabled: ADMIN_PASSWORD not set or too short)' : ''}`));

function shutdown() {
  try { stats.save(); } catch (e) { console.error('[stats]', e.message); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
