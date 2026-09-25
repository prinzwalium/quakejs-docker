// Player lobby: pick a name and a player model before the game starts.
// The choice is kept in a cookie (and localStorage as a fallback) and passed to the
// game as "+set name ... +set model ..." on every start. Open it again with /#lobby.
(function () {
	'use strict';

	var COOKIE = 'qjs_player';
	var FALLBACK_MODELS = ['sarge', 'visor', 'major', 'grunt'];

	// Printable ASCII without characters that break Quake 3 command parsing.
	function cleanName(name) {
		return String(name || '').replace(/["\\;+%]/g, '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 32);
	}

	function stripColors(name) {
		return name.replace(/\^./g, '');
	}

	function cleanModel(model) {
		model = String(model || '').toLowerCase();
		return /^[a-z0-9_-]{1,32}(\/[a-z0-9_-]{1,32})?$/.test(model) ? model : '';
	}

	function loadPlayer() {
		var raw = null;
		var m = document.cookie.match(/(?:^|;\s*)qjs_player=([^;]*)/);
		if (m) raw = m[1];
		try {
			if (!raw && window.localStorage) raw = window.localStorage.getItem(COOKIE);
			if (!raw) return null;
			var p = JSON.parse(decodeURIComponent(raw));
			var name = cleanName(p.name);
			var model = cleanModel(p.model);
			return name && model ? { name: name, model: model } : null;
		} catch (e) {
			return null;
		}
	}

	function savePlayer(p) {
		var value = encodeURIComponent(JSON.stringify(p));
		var secure = window.location.protocol === 'https:' ? '; Secure' : '';
		document.cookie = COOKIE + '=' + value + '; Path=/; Max-Age=31536000; SameSite=Lax' + secure;
		try {
			if (window.localStorage) window.localStorage.setItem(COOKIE, value);
		} catch (e) { /* storage disabled */ }
	}

	function args(p) {
		// The engine quotes arguments that contain spaces itself, so the name is passed as is.
		return ['+set', 'name', p.name, '+set', 'model', p.model, '+set', 'headmodel', p.model];
	}

	// The browser also keeps the engine's own config (q3config.cfg) with the last used name and
	// model, and the engine loads it again while connecting, which overrides the start arguments.
	// So the choice is also set directly in the running engine until it has stuck, and changes
	// made later in the in-game menu are saved back to the cookie.
	function engine() {
		var m = window.ioq3;
		return m && m._Cvar_Set && m._Cvar_VariableString && m._free && m.allocate && m.intArrayFromString && m.Pointer_stringify ? m : null;
	}

	function withStrings(m, strings, fn) {
		var ptrs = strings.map(function (s) { return m.allocate(m.intArrayFromString(s), 'i8', m.ALLOC_NORMAL); });
		try {
			return fn.apply(null, ptrs);
		} finally {
			ptrs.forEach(function (ptr) { m._free(ptr); });
		}
	}

	function getCvar(m, name) {
		return withStrings(m, [name], function (n) { return m.Pointer_stringify(m._Cvar_VariableString(n)); });
	}

	function setCvar(m, name, value) {
		withStrings(m, [name, value], function (n, v) { m._Cvar_Set(n, v); });
	}

	// name/model/headmodel set by commands in the URL, e.g. "?set name Foo" or "?name=Foo".
	function queryValues() {
		var out = {};
		var query = '';
		try { query = decodeURIComponent(window.location.search.replace(/\+/g, ' ')); } catch (e) { return out; }
		var re = /(?:^|[?&])(?:(?:seta?|setu)[\s=]+)?(name|model|headmodel)[\s=]+([^&]*)/gi;
		var m;
		while ((m = re.exec(query))) {
			var key = m[1].toLowerCase();
			var value = key === 'name' ? cleanName(m[2]) : cleanModel(m[2].trim());
			if (value) out[key] = value;
		}
		return out;
	}

	function followInGameChanges(p) {
		setInterval(function () {
			var m = engine();
			if (!m) return;
			try {
				var name = cleanName(getCvar(m, 'name'));
				var model = cleanModel(getCvar(m, 'model'));
				if (name && model && (name !== p.name || model !== p.model)) {
					p.name = name;
					p.model = model;
					savePlayer(p);
				}
			} catch (e) { /* engine not available */ }
		}, 5000);
	}

	function applyInEngine(p) {
		var want = { name: p.name, model: p.model, headmodel: p.model };
		// Commands in the URL (e.g. /?set name Foo) win over the lobby. They are applied the same
		// way, because the saved engine config would override them too.
		var fromQuery = queryValues();
		Object.keys(fromQuery).forEach(function (k) { want[k] = fromQuery[k]; });
		var begin = Date.now();
		var okSince = 0;
		var timer = setInterval(function () {
			var m = engine();
			var done = Date.now() - begin > 10 * 60 * 1000;
			if (m) {
				try {
					// Only once the engine is initialised (its cvars exist).
					if (getCvar(m, 'version')) {
						var ok = true;
						Object.keys(want).forEach(function (k) {
							if (getCvar(m, k) !== want[k]) {
								setCvar(m, k, want[k]);
								ok = false;
							}
						});
						var connected = !!getCvar(m, 'cl_currentServerAddress');
						if (!ok || !connected) okSince = 0;
						else if (!okSince) okSince = Date.now();
						// Connected, and the values stayed as chosen for 20 seconds: the saved
						// config has been loaded already and can't override them anymore.
						if (okSince && Date.now() - okSince > 20000) done = true;
					}
				} catch (e) { /* engine still starting */ }
			}
			if (done) {
				clearInterval(timer);
				// Don't make one-off URL overrides the saved lobby choice.
				if (!Object.keys(fromQuery).length) followInGameChanges(p);
			}
		}, 500);
	}

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	function fetchLobby(done) {
		var finished = false;
		var finish = function (data) {
			if (finished) return;
			finished = true;
			done(data);
		};
		setTimeout(function () { finish(null); }, 4000);
		var xhr = new XMLHttpRequest();
		xhr.open('GET', '/admin/api/public/lobby');
		xhr.onload = function () {
			try {
				finish(xhr.status === 200 ? JSON.parse(xhr.responseText) : null);
			} catch (e) {
				finish(null);
			}
		};
		xhr.onerror = function () { finish(null); };
		xhr.send();
	}

	function showChangeLink() {
		var a = el('a', 'qjs-lobby-change', 'Change player');
		a.href = '/#lobby';
		a.addEventListener('click', function (ev) {
			ev.preventDefault();
			window.location.hash = 'lobby';
			window.location.reload();
		});
		document.body.appendChild(a);
		setTimeout(function () { a.className += ' qjs-hidden'; }, 20000);
	}

	function showLobby(saved, data, start) {
		var models = (data && data.models && data.models.length) ? data.models : FALLBACK_MODELS.map(function (m) { return { id: m, icon: null }; });
		var roster = (data && data.roster) || [];
		var rosterOnly = !!(data && data.rosterOnly && roster.length);
		var hasSarge = models.some(function (m) { return m.id === 'sarge'; });
		var selected = saved ? saved.model : (hasSarge ? 'sarge' : models[0].id);
		if (!models.some(function (m) { return m.id === selected; })) selected = models[0].id;

		var overlay = el('div', 'qjs-lobby');
		var box = el('form', 'qjs-lobby-box');
		box.appendChild(el('h1', null, 'Choose your player'));

		var label = el('label', null, 'Name');
		var nameInput;
		if (rosterOnly) {
			nameInput = el('select');
			roster.forEach(function (p) {
				var o = el('option', null, p.name);
				o.value = p.name;
				nameInput.appendChild(o);
			});
			if (saved) nameInput.value = stripColors(saved.name);
			label.appendChild(nameInput);
			box.appendChild(label);
			box.appendChild(el('p', 'qjs-lobby-hint', 'Only players on the list can join this server.'));
		} else {
			nameInput = el('input');
			nameInput.type = 'text';
			nameInput.maxLength = 32;
			nameInput.autocomplete = 'nickname';
			nameInput.placeholder = 'Your name';
			nameInput.value = saved ? saved.name : '';
			if (roster.length) {
				var list = el('datalist');
				list.id = 'qjs-lobby-names';
				roster.forEach(function (p) {
					var o = el('option');
					o.value = p.name;
					list.appendChild(o);
				});
				box.appendChild(list);
				nameInput.setAttribute('list', 'qjs-lobby-names');
			}
			label.appendChild(nameInput);
			box.appendChild(label);
			box.appendChild(el('p', 'qjs-lobby-hint', 'Colors: ^1 red, ^2 green, ^3 yellow, ^4 blue, ^5 cyan, ^6 magenta, ^7 white'));
		}

		// Picking a known name selects that player's default model.
		var applyRosterModel = function () {
			var n = stripColors(cleanName(nameInput.value)).toLowerCase();
			roster.forEach(function (p) {
				if (p.name.toLowerCase() === n && p.model) selectModel(p.model);
			});
		};
		nameInput.addEventListener('change', applyRosterModel);

		box.appendChild(el('span', 'qjs-lobby-label', 'Model'));
		var grid = el('div', 'qjs-lobby-models');
		var buttons = {};
		var selectModel = function (id) {
			if (!buttons[id]) return;
			selected = id;
			Object.keys(buttons).forEach(function (k) {
				buttons[k].setAttribute('aria-pressed', k === id ? 'true' : 'false');
			});
		};
		models.forEach(function (m) {
			var b = el('button', 'qjs-lobby-model');
			b.type = 'button';
			b.title = m.id;
			if (m.icon) {
				var img = el('img');
				img.src = m.icon;
				img.alt = '';
				img.width = 64;
				img.height = 64;
				b.appendChild(img);
			}
			b.appendChild(el('span', null, m.id.replace('/', ' / ')));
			b.addEventListener('click', function () { selectModel(m.id); });
			buttons[m.id] = b;
			grid.appendChild(b);
		});
		box.appendChild(grid);
		selectModel(selected);
		if (!saved) applyRosterModel();

		var error = el('p', 'qjs-lobby-error');
		error.hidden = true;
		box.appendChild(error);
		var play = el('button', 'qjs-lobby-play', 'Play');
		play.type = 'submit';
		box.appendChild(play);
		if (data && data.statsPublic) {
			var stats = el('a', 'qjs-lobby-stats', 'Player statistics');
			stats.href = '/stats/';
			stats.target = '_blank';
			stats.rel = 'noopener';
			box.appendChild(stats);
		}

		box.addEventListener('submit', function (ev) {
			ev.preventDefault();
			var name = cleanName(nameInput.value);
			if (!stripColors(name).trim()) {
				error.textContent = 'Please enter a name.';
				error.hidden = false;
				nameInput.focus();
				return;
			}
			var p = { name: name, model: selected };
			savePlayer(p);
			overlay.parentNode.removeChild(overlay);
			if (window.location.hash === '#lobby') history.replaceState(null, '', window.location.pathname + window.location.search);
			start(args(p));
			applyInEngine(p);
			showChangeLink();
		});

		overlay.appendChild(box);
		document.body.appendChild(overlay);
		nameInput.focus();
	}

	window.qjsLobby = {
		// Calls start(extraArgs) once the player is chosen.
		start: function (start) {
			var saved = loadPlayer();
			if (saved && window.location.hash !== '#lobby') {
				start(args(saved));
				applyInEngine(saved);
				showChangeLink();
				return;
			}
			fetchLobby(function (data) { showLobby(saved, data, start); });
		}
	};
})();
