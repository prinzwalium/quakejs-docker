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
				showChangeLink();
				return;
			}
			fetchLobby(function (data) { showLobby(saved, data, start); });
		}
	};
})();
