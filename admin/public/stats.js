'use strict';
// Player statistics table. Used by the public page (/stats/) and the admin page.

(() => {
  const COLUMNS = [
    ['name', 'Player', 'text'],
    ['kills', 'Kills', 'num'],
    ['deaths', 'Deaths', 'num'],
    ['kd', 'K/D', 'num'],
    ['matches', 'Matches', 'num'],
    ['wins', 'Wins', 'num'],
    ['bestScore', 'Best score', 'num'],
    ['favoriteWeapon', 'Favourite weapon', 'text'],
    ['lastSeen', 'Last seen', 'date'],
  ];

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function ago(ts) {
    if (!ts) return '–';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 129600) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }

  const MODES = { 0: 'Free for all', 1: 'Tournament', 3: 'Team deathmatch', 4: 'Capture the flag' };
  const TEAMS = { 1: 'Red', 2: 'Blue', 3: 'Spectator' };

  function duration(sec) {
    if (!sec) return '–';
    const m = Math.floor(sec / 60);
    const s = String(Math.round(sec % 60)).padStart(2, '0');
    return `${m}:${s}`;
  }

  function winnerText(m) {
    if (m.gametype >= 3 && m.red !== null && m.blue !== null) {
      if (m.red === m.blue) return `Draw ${m.red}:${m.blue}`;
      return `${m.red > m.blue ? 'Red' : 'Blue'} ${Math.max(m.red, m.blue)}:${Math.min(m.red, m.blue)}`;
    }
    return m.winners.length ? m.winners.join(', ') : 'Draw';
  }

  // Recent matches table. Returns { section, reload(bots) }.
  function matchHistory() {
    const section = el('div', 'matches');
    const head = el('h3', null, 'Recent matches');
    const wrap = el('div', 'table-wrap');
    const table = el('table', 'players stats-table matches-table');
    const thead = el('thead');
    const tbody = el('tbody');
    const hr = el('tr');
    for (const [label, cls] of [['Played', null], ['Map', null], ['Mode', null], ['Winner', null], ['Players', 'num'], ['Duration', 'num']]) {
      hr.append(el('th', cls, label));
    }
    thead.append(hr);
    table.append(thead, tbody);
    wrap.append(table);
    const empty = el('p', 'muted', 'No finished matches yet.');
    section.append(head, wrap, empty);
    let matches = [];
    let open = null;

    function scoreboard(m) {
      const tr = el('tr', 'detail');
      const td = el('td');
      td.colSpan = 6;
      const t = el('table', 'players scoreboard');
      const h = el('tr');
      const teams = m.gametype >= 3;
      h.append(el('th', null, 'Player'));
      if (teams) h.append(el('th', null, 'Team'));
      h.append(el('th', 'num', 'Score'));
      t.append(h);
      for (const p of m.players) {
        const r = el('tr');
        const name = p.name + (p.bot ? ' (bot)' : '');
        // Bots can share a name: in free-for-all only the top score wins.
        const won = m.winners.includes(p.name) && (teams || p.score === m.players[0].score);
        r.append(el('td', won ? 'winner' : null, name));
        if (teams) r.append(el('td', null, TEAMS[p.team] || '–'));
        r.append(el('td', 'num', p.score));
        t.append(r);
      }
      const facts = el('p', 'muted', `${MODES[m.gametype] || `Mode ${m.gametype}`} · ${new Date(m.time).toLocaleString()}${m.reason ? ` · ended by ${m.reason.toLowerCase()}` : ''}`);
      td.append(t, facts);
      tr.append(td);
      return tr;
    }

    function render() {
      const out = [];
      for (const m of matches) {
        const tr = el('tr', 'clickable');
        tr.append(
          el('td', null, ago(m.time)),
          el('td', null, m.map || '–'),
          el('td', null, MODES[m.gametype] || `Mode ${m.gametype}`),
          el('td', null, winnerText(m)),
          el('td', 'num', m.players.length),
          el('td', 'num', duration(m.duration)),
        );
        tr.tabIndex = 0;
        const toggle = () => { open = open === m ? null : m; render(); };
        tr.addEventListener('click', toggle);
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        out.push(tr);
        if (open === m) out.push(scoreboard(m));
      }
      tbody.replaceChildren(...out);
      wrap.hidden = matches.length === 0;
      empty.hidden = matches.length > 0;
    }

    async function reload(bots) {
      const res = await fetch(`/admin/api/public/matches?bots=${bots ? 1 : 0}&limit=50`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const keep = open ? `${open.time}:${open.map}` : null;
      matches = (await res.json()).matches;
      open = matches.find(m => `${m.time}:${m.map}` === keep) || null;
      render();
    }

    render();
    return { section, reload };
  }

  // Renders into container. Returns { reload() }.
  function mount(container, { onPrivate } = {}) {
    let rows = [];
    let sortKey = 'kills';
    let sortDir = -1;
    let open = null;

    const bar = el('div', 'row stats-bar');
    const botsLabel = el('label', 'check');
    const bots = el('input');
    bots.type = 'checkbox';
    botsLabel.append(bots, ' Show bots');
    const count = el('span', 'muted');
    bar.append(botsLabel, count);

    const wrap = el('div', 'table-wrap');
    const table = el('table', 'players stats-table');
    const thead = el('thead');
    const tbody = el('tbody');
    table.append(thead, tbody);
    wrap.append(table);
    const empty = el('p', 'muted', 'No statistics yet. Play a match and they appear here.');
    empty.hidden = true;
    const history = matchHistory();
    container.replaceChildren(bar, wrap, empty, history.section);

    const headRow = el('tr');
    for (const [key, label, type] of COLUMNS) {
      const th = el('th');
      const b = el('button', 'sort', label);
      b.type = 'button';
      if (type === 'num') th.className = 'num';
      b.addEventListener('click', () => {
        if (sortKey === key) sortDir = -sortDir;
        else { sortKey = key; sortDir = type === 'text' ? 1 : -1; }
        render();
      });
      th.append(b);
      headRow.append(th);
    }
    thead.append(headRow);

    function detail(r) {
      const tr = el('tr', 'detail');
      const td = el('td');
      td.colSpan = COLUMNS.length;
      const dl = el('dl', 'facts');
      const add = (k, v) => {
        const d = el('div');
        d.append(el('dt', null, k), el('dd', null, v));
        dl.append(d);
      };
      add('Kills on players / bots', `${r.killsVsHumans} / ${r.killsVsBots}`);
      add('Suicides', r.suicides);
      add('Team kills', r.teamKills);
      add('Win rate', r.matches ? `${Math.round((r.wins / r.matches) * 100)} %` : '–');
      add('Model', r.model || '–');
      add('First seen', r.firstSeen ? new Date(r.firstSeen).toLocaleString() : '–');
      if (r.aliases && r.aliases.length) add('Also played as', r.aliases.join(', '));
      const weapons = Object.entries(r.weapons || {}).sort((a, b) => b[1] - a[1]);
      if (weapons.length) add('Kills by weapon', weapons.map(([w, n]) => `${w}: ${n}`).join(', '));
      td.append(dl);
      tr.append(td);
      return tr;
    }

    function render() {
      const sorted = rows.slice().sort((a, b) => {
        const x = a[sortKey];
        const y = b[sortKey];
        if (typeof x === 'string' || typeof y === 'string') return String(x || '').localeCompare(String(y || '')) * sortDir;
        return ((x || 0) - (y || 0)) * sortDir || b.kills - a.kills;
      });
      for (const th of thead.querySelectorAll('th')) th.removeAttribute('aria-sort');
      const idx = COLUMNS.findIndex(c => c[0] === sortKey);
      thead.querySelectorAll('th')[idx].setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending');
      const out = [];
      for (const r of sorted) {
        const tr = el('tr', 'clickable');
        for (const [key, , type] of COLUMNS) {
          let v = r[key];
          if (type === 'date') v = ago(v);
          if (key === 'name') v = r.name + (r.bot ? ' (bot)' : '');
          if (v === null || v === undefined || v === '') v = '–';
          const td = el('td', type === 'num' ? 'num' : null, v);
          tr.append(td);
        }
        tr.tabIndex = 0;
        const toggle = () => { open = open === r.name ? null : r.name; render(); };
        tr.addEventListener('click', toggle);
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        out.push(tr);
        if (open === r.name) out.push(detail(r));
      }
      tbody.replaceChildren(...out);
      empty.hidden = rows.length > 0;
      wrap.hidden = rows.length === 0;
      count.textContent = rows.length ? `${rows.length} player(s)` : '';
    }

    async function reload() {
      const res = await fetch(`/admin/api/public/stats?bots=${bots.checked ? 1 : 0}`, { credentials: 'same-origin' });
      if (res.status === 404) {
        if (onPrivate) onPrivate();
        return;
      }
      if (!res.ok) throw new Error(`Could not load statistics (${res.status})`);
      rows = (await res.json()).players;
      render();
      await history.reload(bots.checked);
    }

    bots.addEventListener('change', () => { reload().catch(() => {}); });
    return { reload };
  }

  window.QjsStats = { mount };

  // Stand-alone page
  const page = document.getElementById('stats-page');
  if (page) {
    const priv = document.getElementById('stats-private');
    const table = mount(page, { onPrivate: () => { page.hidden = true; priv.hidden = false; } });
    const now = document.getElementById('now-playing');
    const showServer = async () => {
      try {
        const res = await fetch('/admin/api/public/server', { credentials: 'same-origin' });
        const s = res.ok ? await res.json() : { online: false };
        if (!s.online) {
          now.textContent = 'The game server is not reachable right now.';
        } else {
          const n = s.humans.length;
          let who = n ? `${n} playing: ${s.humans.map(h => h.name).join(', ')}` : 'nobody playing';
          if (s.bots) who += ` + ${s.bots} bot${s.bots === 1 ? '' : 's'}`;
          now.textContent = `Now playing: ${s.map} (${MODES[s.gametype] || s.gametypeName}) – ${who}`;
        }
        now.hidden = false;
      } catch (e) { /* keep the last line */ }
    };
    const refresh = () => {
      if (document.hidden) return;
      table.reload().catch(() => {});
      if (now) showServer();
    };
    refresh();
    setInterval(refresh, 30000);
  }
})();
