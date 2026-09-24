'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  let state = null;
  let statusTimer = null;

  async function api(method, url, body) {
    const opts = { method, headers: { 'X-Requested-With': 'qjs-admin' }, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch('/admin/api/' + url, opts);
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (res.status === 401 && url !== 'login') {
      showLogin();
      throw new Error('Session expired, please log in again');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.className = isError ? 'error' : '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 8000 : 4000);
  }

  function option(value, text) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  }

  function fillSelect(sel, items, selected) {
    sel.replaceChildren(...items.map(([v, t]) => option(v, t)));
    if (selected !== undefined) sel.value = String(selected);
  }

  // ------------------------------------------------------------ views

  function showOnly(id) {
    for (const s of ['disabled', 'login', 'app']) $(s).hidden = s !== id;
    $('logout').hidden = id !== 'app';
    if (id !== 'app') clearInterval(statusTimer);
  }

  function showLogin() {
    showOnly('login');
    $('login-password').value = '';
    $('login-password').focus();
  }

  async function showApp() {
    showOnly('app');
    await loadState();
    await refreshStatus();
    clearInterval(statusTimer);
    statusTimer = setInterval(() => { if (!document.hidden) refreshStatus(); }, 5000);
  }

  // ------------------------------------------------------------ status

  async function refreshStatus() {
    let s;
    try {
      s = await api('GET', 'status');
    } catch (e) {
      return;
    }
    const badge = $('status-badge');
    badge.textContent = s.online ? 'online' : 'offline';
    badge.className = 'badge ' + (s.online ? 'ok' : 'bad');
    const tbody = $('players');
    if (!s.online) {
      $('st-map').textContent = '–';
      $('st-gametype').textContent = '–';
      $('st-players').textContent = s.error || '–';
      tbody.replaceChildren();
      return;
    }
    $('st-map').textContent = s.map || '–';
    $('st-gametype').textContent = (state && state.gametypes[s.gametype]) || String(s.gametype);
    const humans = s.clients.filter(c => !c.bot).length;
    $('st-players').textContent = `${humans} player(s), ${s.clients.length - humans} bot(s), ${s.maxclients} slots`;
    if (!s.clients.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'muted';
      td.textContent = 'No players';
      tr.append(td);
      tbody.replaceChildren(tr);
      return;
    }
    tbody.replaceChildren(...s.clients.map(c => {
      const tr = document.createElement('tr');
      const name = c.name + (c.bot ? ' (bot)' : '');
      for (const v of [c.num, name, c.score, c.bot ? '–' : c.ping]) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.append(td);
      }
      const td = document.createElement('td');
      const b = document.createElement('button');
      b.className = 'secondary small';
      b.textContent = 'Kick';
      b.addEventListener('click', async () => {
        if (!confirm(`Kick ${c.name}?`)) return;
        await doAction({ action: 'kick', num: c.num }, `${c.name} kicked`);
      });
      td.append(b);
      tr.append(td);
      return tr;
    }));
  }

  function showPending(pending) {
    const names = { maxclients: 'max players', gametype: 'game type', botEnable: 'bots allowed' };
    const list = (pending || []).map(k => names[k] || k);
    $('restart-banner').hidden = !list.length;
    $('restart-fields').textContent = list.join(', ');
  }

  // ------------------------------------------------------------ settings

  let rotation = [];

  function renderRotation() {
    const ol = $('rotation');
    ol.replaceChildren(...rotation.map((m, i) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = m;
      const btns = document.createElement('span');
      btns.className = 'row';
      const mk = (label, title, fn, disabled) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'secondary small';
        b.textContent = label;
        b.title = title;
        b.disabled = disabled;
        b.addEventListener('click', fn);
        return b;
      };
      btns.append(
        mk('↑', 'Move up', () => { [rotation[i - 1], rotation[i]] = [rotation[i], rotation[i - 1]]; renderRotation(); }, i === 0),
        mk('↓', 'Move down', () => { [rotation[i + 1], rotation[i]] = [rotation[i], rotation[i + 1]]; renderRotation(); }, i === rotation.length - 1),
        mk('✕', 'Remove', () => { rotation.splice(i, 1); renderRotation(); }, rotation.length === 1),
      );
      li.append(span, btns);
      return li;
    }));
  }

  async function loadState() {
    state = await api('GET', 'state');
    const s = state.settings;
    const form = $('settings-form');
    fillSelect($('gametype'), Object.entries(state.gametypes));
    for (const [k, f] of Object.entries(state.fields)) {
      const el = form.elements[k];
      if (!el) continue;
      if (f.type === 'bool') el.checked = !!s[k];
      else el.value = s[k];
    }
    form.elements.extra.value = s.extra || '';
    rotation = s.rotation.slice();
    renderRotation();
    const maps = state.maps.length ? state.maps : s.rotation;
    fillSelect($('rotation-add'), maps.map(m => [m, m]));
    fillSelect($('act-map'), maps.map(m => [m, m]));
    fillSelect($('act-bot'), state.bots.map(b => [b, b]));
    showPending(state.pendingMapChange);
  }

  async function saveSettings(ev) {
    ev.preventDefault();
    const form = $('settings-form');
    const body = { rotation, extra: form.elements.extra.value };
    for (const [k, f] of Object.entries(state.fields)) {
      const el = form.elements[k];
      if (!el) continue;
      body[k] = f.type === 'bool' ? el.checked : (f.type === 'int' ? Number(el.value) : el.value);
    }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api('PUT', 'settings', body);
      state.settings = r.settings;
      showPending(r.pendingMapChange);
      if (r.applied) toast('Settings saved and applied');
      else toast(`Settings saved. They will apply when the game server is running again (${r.applyError}).`, true);
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------ actions

  async function doAction(body, okMsg) {
    try {
      await api('POST', 'action', body);
      toast(okMsg);
      setTimeout(refreshStatus, 1500);
    } catch (e) {
      toast(e.message, true);
    }
  }

  const ACTIONS = {
    map: () => ({ body: { action: 'map', map: $('act-map').value }, msg: `Changing map to ${$('act-map').value}`, confirm: 'Change the map now? The current match ends.' }),
    restartMatch: () => ({ body: { action: 'restartMatch' }, msg: 'Match restarted', confirm: 'Restart the current match?' }),
    nextMap: () => ({ body: { action: 'nextMap' }, msg: 'Loading next map', confirm: 'Skip to the next map in the rotation?' }),
    addBot: () => ({ body: { action: 'addBot', name: $('act-bot').value, skill: Number($('act-bot-skill').value) }, msg: `${$('act-bot').value} added` }),
    kickBots: () => ({ body: { action: 'kickBots' }, msg: 'Bots removed' }),
    say: () => ({ body: { action: 'say', message: $('act-say').value }, msg: 'Message sent' }),
  };

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    const a = ACTIONS[btn.dataset.action]();
    if (a.confirm && !confirm(a.confirm)) return;
    btn.disabled = true;
    await doAction(a.body, a.msg);
    btn.disabled = false;
    if (btn.dataset.action === 'say') $('act-say').value = '';
  });

  // ------------------------------------------------------------ wiring

  $('login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('login-error');
    err.hidden = true;
    try {
      await api('POST', 'login', { password: $('login-password').value });
      await showApp();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });

  $('logout').addEventListener('click', async () => {
    try { await api('POST', 'logout'); } catch (e) { /* ignore */ }
    showLogin();
  });

  $('settings-form').addEventListener('submit', saveSettings);

  $('rotation-add-btn').addEventListener('click', () => {
    const m = $('rotation-add').value;
    if (m && rotation.length < 64) {
      rotation.push(m);
      renderRotation();
    }
  });

  $('restart').addEventListener('click', async () => {
    if (!confirm('Restart the game server? All players are disconnected for a few seconds.')) return;
    const btn = $('restart');
    btn.disabled = true;
    try {
      await api('POST', 'restart');
      toast('Game server restarted');
      setTimeout(async () => { await loadState(); await refreshStatus(); }, 5000);
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('console-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $('console-input');
    const out = $('console-output');
    const cmd = input.value.trim();
    if (!cmd) return;
    try {
      const r = await api('POST', 'console', { command: cmd });
      out.textContent = `> ${cmd}\n${r.output.replace(/\^[0-9]/g, '')}`;
      input.value = '';
    } catch (e) {
      out.textContent = `> ${cmd}\n${e.message}`;
    }
  });

  (async () => {
    try {
      const s = await api('GET', 'session');
      if (!s.enabled) {
        $('disabled-reason').textContent = s.reason;
        showOnly('disabled');
      } else if (s.authenticated) await showApp();
      else showLogin();
    } catch (e) {
      toast(e.message, true);
    }
  })();
})();
