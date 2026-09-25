# Vendored QuakeJS web client

`html/` is copied from https://github.com/begleysm/quakejs (itself a fork of
https://github.com/inolen/quakejs, MIT licensed) at commit
`9fdbba0da3a565efbb0e94ed67911785cf2af905` (2024-08-16), without `html/get_assets.sh`.

It is kept here so the image can be built even if the upstream repository disappears.

## Local patches

These were previously applied with `sed` during `docker build`. They make the client
load everything from the host serving the page, so it works behind an HTTPS reverse proxy:

- `html/index.html`: `fs_cdn` and `+connect` use `window.location.hostname`
  instead of the hard-coded `quakejs:80` / `quakejs:27960`.
- `html/ioquake3.js`:
  - `manifest.json` and assets are fetched from `'//' + window.location.host + '/assets/...'`
    (protocol-relative, so https pages load over https).
  - The game websocket connects to `window.location.protocol.replace('http', 'ws') + window.location.host`
    (ws on http, wss on https), which nginx proxies to the game server on port 27960.

- `html/index.html` also loads `lobby.js` / `lobby.css` (added in this repository, not upstream): before
  the game starts, a lobby asks for the player name and model, keeps them in a cookie and passes them as
  `+set name ... +set model ...`. Commands from the URL query string are appended after them.
  Because the engine reloads the config it keeps in the browser (`q3config.cfg` in IndexedDB) while
  connecting, `lobby.js` also sets these cvars in the running engine (`ioq3._Cvar_Set`) until they
  have stuck, and saves later in-game name/model changes back to the cookie.
- `html/disconnected.html` (added in this repository) is shown by nginx when the client reports an error
  after leaving the game (it POSTs to `/`), instead of nginx's "405 Not Allowed" page.

## node_modules

`package.json` / `package-lock.json` / `node_modules/` contain the only runtime dependency of the
dedicated server (`build/ioq3ded.js`): `ws@0.4.32`, the version the upstream `~0.4.29` range resolves to.
It was installed with `npm install --ignore-scripts`, so the optional native addons are not built
and the pure JavaScript fallbacks are used.
