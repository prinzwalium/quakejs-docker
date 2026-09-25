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
    container.replaceChildren(bar, wrap, empty);

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
    const refresh = () => { if (!document.hidden) table.reload().catch(() => {}); };
    refresh();
    setInterval(refresh, 30000);
  }
})();
