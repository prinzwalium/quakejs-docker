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
    await Promise.all([refreshStatus(), loadPlayers(), loadStats(), loadBans(), loadAudit()]);
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
      const cell = document.createElement('span');
      cell.className = 'row';
      cell.append(b);
      if (!c.bot) {
        tr.title = c.ip ? `Address: ${c.ip}` : '';
        const ban = document.createElement('button');
        ban.className = 'secondary small';
        ban.textContent = 'Ban';
        ban.addEventListener('click', () => banPlayer(c));
        cell.append(ban);
      }
      td.append(cell);
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

  // ------------------------------------------------------------ players (roster)

  let roster = [];
  let models = [];

  function modelSelect(value) {
    const sel = document.createElement('select');
    sel.append(option('', '(none)'), ...models.map(m => option(m, m)));
    sel.value = value || '';
    return sel;
  }

  function renderRoster() {
    const tbody = $('roster');
    if (!roster.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'muted';
      td.textContent = 'No players yet.';
      tr.append(td);
      tbody.replaceChildren(tr);
      return;
    }
    tbody.replaceChildren(...roster.map((p, i) => {
      const tr = document.createElement('tr');
      const name = document.createElement('input');
      name.type = 'text';
      name.maxLength = 32;
      name.value = p.name;
      name.setAttribute('aria-label', 'Name');
      name.addEventListener('input', () => { p.name = name.value; });
      const aliases = document.createElement('input');
      aliases.type = 'text';
      aliases.value = p.aliases.join(', ');
      aliases.setAttribute('aria-label', 'Other names');
      aliases.addEventListener('input', () => { p.aliases = aliases.value.split(',').map(a => a.trim()).filter(Boolean); });
      const model = modelSelect(p.model);
      model.setAttribute('aria-label', 'Default model');
      model.addEventListener('change', () => { p.model = model.value; });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'secondary small';
      del.textContent = 'Remove';
      del.addEventListener('click', () => { roster.splice(i, 1); renderRoster(); });
      for (const c of [name, aliases, model, del]) {
        const td = document.createElement('td');
        td.append(c);
        tr.append(td);
      }
      return tr;
    }));
  }

  function renderRecent(recent) {
    const ul = $('recent-names');
    if (!recent.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'None';
      ul.replaceChildren(li);
      return;
    }
    ul.replaceChildren(...recent.map((r) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = r.name;
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'secondary small';
      add.textContent = 'Add as player';
      add.addEventListener('click', () => {
        roster.push({ name: r.name, aliases: [], model: models.includes(r.model) ? r.model : '' });
        renderRoster();
        li.remove();
      });
      const target = document.createElement('select');
      target.setAttribute('aria-label', `Add ${r.name} as another name of`);
      target.append(option('', 'Another name of…'), ...roster.map((p, i) => option(String(i), p.name)));
      const alias = document.createElement('button');
      alias.type = 'button';
      alias.className = 'secondary small';
      alias.textContent = 'Add';
      alias.addEventListener('click', () => {
        const p = roster[Number(target.value)];
        if (target.value === '' || !p) return;
        p.aliases.push(r.name);
        renderRoster();
        li.remove();
      });
      li.append(name, add, target, alias);
      return li;
    }));
  }

  async function loadPlayers() {
    try {
      const r = await api('GET', 'players');
      roster = r.players.map(p => ({ id: p.id, name: p.name, aliases: p.aliases.slice(), model: p.model }));
      models = r.models;
      renderRoster();
      renderRecent(r.recent);
    } catch (e) {
      toast(e.message, true);
    }
    $('name-mode').value = String(state.settings.nameMode || 0);
    $('stats-public').checked = !!state.settings.statsPublic;
  }

  $('roster-add').addEventListener('click', () => {
    roster.push({ name: '', aliases: [], model: '' });
    renderRoster();
    const inputs = $('roster').querySelectorAll('input');
    if (inputs.length) inputs[inputs.length - 2].focus();
  });

  $('roster-save').addEventListener('click', async () => {
    const btn = $('roster-save');
    btn.disabled = true;
    try {
      const r = await api('PUT', 'players', { players: roster.filter(p => p.name.trim() || p.aliases.length) });
      roster = r.players.map(p => ({ id: p.id, name: p.name, aliases: p.aliases.slice(), model: p.model }));
      renderRoster();
      renderRecent(r.recent);
      toast('Players saved');
      loadStats();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  // Admin-only settings that are changed outside the settings form.
  async function saveSetting(body, okMsg, revert) {
    try {
      const r = await api('PUT', 'settings', body);
      state.settings = r.settings;
      toast(okMsg);
    } catch (e) {
      revert();
      toast(e.message, true);
    }
  }

  $('name-mode').addEventListener('change', (ev) => {
    const v = Number(ev.target.value);
    if (v === 1 && !roster.length) toast('The player list is empty: everyone would be kicked. Add players first.', true);
    saveSetting({ nameMode: v }, v === 1 ? 'Only players on the list can join now' : 'Anyone can join now',
      () => { ev.target.value = String(state.settings.nameMode || 0); });
  });

  // ------------------------------------------------------------ statistics

  let statsTable = null;
  async function loadStats() {
    if (!statsTable) statsTable = window.QjsStats.mount($('admin-stats'));
    try { await statsTable.reload(); } catch (e) { toast(e.message, true); }
  }

  $('stats-public').addEventListener('change', (ev) => {
    const v = ev.target.checked;
    saveSetting({ statsPublic: v }, v ? 'The stats page is now public' : 'The stats page is now private',
      () => { ev.target.checked = !!state.settings.statsPublic; });
  });

  $('stats-reset').addEventListener('click', async () => {
    if (!confirm('Reset all player statistics? The current statistics are archived first.')) return;
    try {
      await api('POST', 'stats/reset');
      toast('Statistics reset');
      loadStats();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // ------------------------------------------------------------ bans

  function fmtTime(ts) {
    return ts ? new Date(ts).toLocaleString() : 'permanent';
  }

  function renderBans(list) {
    const tbody = $('bans');
    if (!list.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'muted';
      td.textContent = 'No active bans.';
      tr.append(td);
      tbody.replaceChildren(tr);
      return;
    }
    tbody.replaceChildren(...list.map((b) => {
      const tr = document.createElement('tr');
      for (const v of [b.ip || '–', b.name || '–', b.reason || '–', fmtTime(b.until)]) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.append(td);
      }
      const td = document.createElement('td');
      const un = document.createElement('button');
      un.className = 'secondary small';
      un.textContent = 'Unban';
      un.addEventListener('click', async () => {
        try {
          const r = await api('DELETE', `bans?id=${encodeURIComponent(b.id)}`);
          renderBans(r.bans);
          toast('Ban removed');
          loadAudit();
        } catch (e) {
          toast(e.message, true);
        }
      });
      td.append(un);
      tr.append(td);
      return tr;
    }));
  }

  async function loadBans() {
    try { renderBans((await api('GET', 'bans')).bans); } catch (e) { toast(e.message, true); }
  }

  async function addBan(body, okMsg) {
    try {
      const r = await api('POST', 'bans', body);
      renderBans(r.bans);
      toast(okMsg);
      setTimeout(refreshStatus, 1500);
      loadAudit();
      return true;
    } catch (e) {
      toast(e.message, true);
      return false;
    }
  }

  async function banPlayer(c) {
    const reason = prompt(`Ban ${c.name}${c.ip ? ` (${c.ip})` : ''}?\nReason:`, '');
    if (reason === null) return;
    const hours = prompt('Duration in hours (leave empty for a permanent ban):', '24');
    if (hours === null) return;
    const duration = hours.trim() === '' ? null : Math.round(Number(hours) * 3600);
    if (duration !== null && !(duration > 0)) { toast('Invalid duration', true); return; }
    await addBan({ num: c.num, reason, duration }, `${c.name} banned`);
  }

  $('ban-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ip = $('ban-ip').value.trim();
    const name = $('ban-name').value.trim();
    if (!ip && !name) { toast('Enter an IP address or a name', true); return; }
    const d = $('ban-duration').value;
    const ok = await addBan({ ip: ip || undefined, name: name || undefined, reason: $('ban-reason').value, duration: d === '' ? null : Number(d) }, 'Ban added');
    if (ok) { $('ban-ip').value = ''; $('ban-name').value = ''; $('ban-reason').value = ''; }
  });

  // ------------------------------------------------------------ audit log

  async function loadAudit() {
    try {
      const { entries } = await api('GET', 'audit?limit=100');
      const tbody = $('audit');
      if (!entries.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.className = 'muted';
        td.textContent = 'Nothing logged yet.';
        tr.append(td);
        tbody.replaceChildren(tr);
        return;
      }
      tbody.replaceChildren(...entries.map((e) => {
        const tr = document.createElement('tr');
        for (const v of [new Date(e.time).toLocaleString(), e.ip, e.action, e.detail || '']) {
          const td = document.createElement('td');
          td.textContent = v;
          tr.append(td);
        }
        return tr;
      }));
    } catch (e) {
      toast(e.message, true);
    }
  }
  $('audit-refresh').addEventListener('click', loadAudit);

  // ------------------------------------------------------------ backup

  $('backup-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    if (!confirm(`Restore "${file.name}"? This replaces the settings, the player list, bans and statistics.`)) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      toast('This file is not valid JSON', true);
      return;
    }
    try {
      const r = await api('POST', 'backup', data);
      toast(r.applied ? 'Backup restored' : 'Backup restored; settings apply when the game server is running again');
      await loadState();
      await Promise.all([loadPlayers(), loadStats(), loadBans(), loadAudit(), refreshStatus()]);
    } catch (e) {
      toast(e.message, true);
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
