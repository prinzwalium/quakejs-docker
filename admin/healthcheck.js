'use strict';
// Docker HEALTHCHECK: nginx serves the game page, the admin interface answers,
// and the game server replies to a status query. Exit code 0 = healthy.

const http = require('http');
const { Rcon } = require('./lib/rcon');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 4000 }, (res) => {
      res.resume();
      if (res.statusCode === 200) resolve(); else reject(new Error(`${url} answered ${res.statusCode}`));
    });
    req.on('timeout', () => req.destroy(new Error(`${url} timed out`)));
    req.on('error', reject);
  });
}

(async () => {
  try {
    await get('http://127.0.0.1/');
    await get('http://127.0.0.1/admin/api/session');
    const rcon = new Rcon({ url: process.env.QJS_GAME_URL || 'ws://127.0.0.1:27960', password: '', timeoutMs: 4000 });
    const status = await rcon.status();
    if (!status.info || !status.info.mapname) throw new Error('game server sent no map');
    console.log(`healthy: map ${status.info.mapname}, ${status.players.length} player(s)`);
    process.exit(0);
  } catch (e) {
    console.log(`unhealthy: ${e.message}`);
    process.exit(1);
  }
})();
