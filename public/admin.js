/* fafscribbl admin */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var token = null, words = [], defaults = null, rooms = [], selected = {}, page = 1;

  function toast(t) {
    var d = document.createElement('div');
    d.className = 'toast'; d.textContent = t;
    $('toasts').appendChild(d);
    setTimeout(function () { d.remove(); }, 3000);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (token) opts.headers['x-admin-token'] = token;
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { logout(); throw new Error('Session expired, log in again'); }
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function store(v) {
    try { if (v === null) sessionStorage.removeItem('fs_admin'); else sessionStorage.setItem('fs_admin', v); }
    catch (e) { /* ignore */ }
  }
  function logout() {
    token = null; store(null);
    $('panel').classList.add('hide');
    $('login').classList.remove('hide');
  }

  /* ------------------------------------------------------------- login */
  function login() {
    var pw = $('pw').value;
    $('loginErr').textContent = '';
    fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { $('loginErr').textContent = res.j.error || 'Login failed'; return; }
        token = res.j.token;
        store(token);
        $('pw').value = '';
        boot();
      }).catch(function () { $('loginErr').textContent = 'Server unreachable'; });
  }
  $('loginBtn').onclick = login;
  $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });
  $('logoutBtn').onclick = logout;

  /* ------------------------------------------------------------- tabs */
  Array.prototype.forEach.call(document.querySelectorAll('.tab[data-tab]'), function (t) {
    t.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab[data-tab]'), function (x) { x.classList.remove('on'); });
      t.classList.add('on');
      ['words', 'defaults', 'rooms', 'io'].forEach(function (n) {
        $('tab-' + n).classList.toggle('hide', n !== t.dataset.tab);
      });
      if (t.dataset.tab === 'rooms') loadRooms();
    };
  });

  /* ------------------------------------------------------------- boot */
  function boot() {
    api('/api/admin/state').then(function (d) {
      words = d.words; defaults = d.defaults; rooms = d.rooms;
      $('login').classList.add('hide');
      $('panel').classList.remove('hide');
      fillTagFilter();
      renderRows();
      fillDefaults();
      renderRooms();
    }).catch(function (e) { $('loginErr').textContent = e.message; });
  }

  /* ------------------------------------------------------------- words */
  function allTags() {
    var s = {};
    words.forEach(function (w) { (w.tags || []).forEach(function (t) { s[t] = 1; }); });
    return Object.keys(s).sort();
  }
  function fillTagFilter() {
    var sel = $('filterTag'), cur = sel.value;
    sel.innerHTML = '<option value="">Any tag</option>';
    allTags().forEach(function (t) { sel.add(new Option(t, t)); });
    sel.value = cur;
  }
  function filtered() {
    var q = $('search').value.trim().toLowerCase();
    var st = $('filterState').value;
    var tag = $('filterTag').value;
    return words.filter(function (w) {
      if (st === 'on' && !w.enabled) return false;
      if (st === 'off' && w.enabled) return false;
      if (tag && (w.tags || []).indexOf(tag) === -1) return false;
      if (!q) return true;
      var hay = (w.word + ' ' + w.hint + ' ' + (w.aliases || []).join(' ') + ' ' + (w.tags || []).join(' ')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }
  function selCount() { return Object.keys(selected).filter(function (k) { return selected[k]; }).length; }

  function renderRows() {
    var list = filtered();
    var size = Number($('pageSize').value) || list.length || 1;
    var pages = Math.max(1, Math.ceil(list.length / size));
    if (page > pages) page = pages;
    var slice = size >= list.length ? list : list.slice((page - 1) * size, page * size);

    var tb = $('rows');
    tb.innerHTML = '';
    slice.forEach(function (w) {
      var tr = document.createElement('tr');
      tr.className = w.enabled ? '' : 'dis';
      tr.dataset.id = w.id;

      var td0 = document.createElement('td'); td0.className = 'c';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.style.width = 'auto'; cb.checked = !!selected[w.id];
      cb.onchange = function () { setSelected(w.id, cb.checked, tr); };
      td0.appendChild(cb); tr.appendChild(td0);

      // clicking anywhere on the row selects it, except on the fields and buttons
      tr.classList.toggle('sel', !!selected[w.id]);
      tr.onclick = function (e) {
        if (e.target.closest('input[type=text], textarea, button, select')) return;
        if (e.target === cb) return;
        var next = !selected[w.id];
        cb.checked = next;
        setSelected(w.id, next, tr);
      };

      tr.appendChild(field(w, 'word'));
      tr.appendChild(field(w, 'hint'));
      tr.appendChild(field(w, 'aliases'));
      tr.appendChild(field(w, 'tags'));

      var td5 = document.createElement('td'); td5.className = 'c';
      var en = document.createElement('button');
      en.className = 'small onbtn' + (w.enabled ? '' : ' off');
      en.innerHTML = w.enabled ? '&#10003;' : '&#10005;';
      en.title = w.enabled ? 'Enabled, click to turn off' : 'Disabled, click to turn on';
      en.onclick = function () {
        var next = !w.enabled;
        en.className = 'small onbtn' + (next ? '' : ' off');
        en.innerHTML = next ? '&#10003;' : '&#10005;';
        en.title = next ? 'Enabled, click to turn off' : 'Disabled, click to turn on';
        save(w, { enabled: next }, tr);
      };
      td5.appendChild(en); tr.appendChild(td5);

      var td6 = document.createElement('td'); td6.className = 'c';
      var del = document.createElement('button');
      del.className = 'small danger delbtn'; del.innerHTML = '&#10005;'; del.title = 'Delete';
      del.onclick = function () {
        if (!confirm('Delete "' + w.word + '"?')) return;
        api('/api/admin/words', { method: 'DELETE', body: JSON.stringify({ ids: [w.id] }) })
          .then(function () {
            words = words.filter(function (x) { return x.id !== w.id; });
            delete selected[w.id];
            renderRows();
          }).catch(function (e) { toast(e.message); });
      };
      td6.appendChild(del); tr.appendChild(td6);
      tb.appendChild(tr);
    });

    $('counts').textContent = words.length + ' words, ' +
      words.filter(function (w) { return w.enabled; }).length + ' enabled, ' +
      list.length + ' shown';
    renderPager(pages);
    updateSel();
  }

  function field(w, key) {
    var td = document.createElement('td');
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.value = key === 'aliases' || key === 'tags' ? (w[key] || []).join(', ') : (w[key] || '');
    inp.placeholder = key === 'hint' ? 'what it is' : (key === 'aliases' ? 'other spellings' : '');
    var before = inp.value;
    inp.onblur = function () {
      if (inp.value === before) return;
      var patch = {};
      if (key === 'aliases' || key === 'tags') {
        patch[key] = inp.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      } else patch[key] = inp.value;
      before = inp.value;
      save(w, patch, inp.closest('tr'));
    };
    inp.onkeydown = function (e) { if (e.key === 'Enter') inp.blur(); };
    td.appendChild(inp);
    return td;
  }

  function save(w, patch, tr) {
    api('/api/admin/words', { method: 'PUT', body: JSON.stringify(Object.assign({ id: w.id }, patch)) })
      .then(function (r) {
        Object.assign(w, r.word);
        if (tr) {
          tr.classList.toggle('dis', !w.enabled);
          tr.classList.add('saved');
          setTimeout(function () { tr.classList.remove('saved'); }, 700);
        }
        fillTagFilter();
        $('counts').textContent = words.length + ' words, ' +
          words.filter(function (x) { return x.enabled; }).length + ' enabled, ' + filtered().length + ' shown';
      }).catch(function (e) { toast(e.message); });
  }

  function renderPager(pages) {
    var p = $('pager');
    p.innerHTML = '';
    if (pages <= 1) return;
    var mk = function (label, target, on) {
      var b = document.createElement('button');
      b.className = 'small' + (on ? ' primary' : '');
      b.textContent = label;
      b.onclick = function () { page = target; renderRows(); };
      p.appendChild(b);
    };
    mk('<', Math.max(1, page - 1), false);
    for (var i = 1; i <= pages; i++) {
      if (pages > 12 && Math.abs(i - page) > 3 && i !== 1 && i !== pages) continue;
      mk(String(i), i, i === page);
    }
    mk('>', Math.min(pages, page + 1), false);
  }

  function setSelected(id, on, tr) {
    selected[id] = on;
    if (tr) tr.classList.toggle('sel', on);
    updateSel();
  }
  function updateSel() {
    $('selCount').textContent = selCount() + ' selected';
  }
  function selectedIds() { return Object.keys(selected).filter(function (k) { return selected[k]; }); }

  $('search').oninput = function () { page = 1; renderRows(); };
  $('filterState').onchange = function () { page = 1; renderRows(); };
  $('filterTag').onchange = function () { page = 1; renderRows(); };
  $('pageSize').onchange = function () { page = 1; renderRows(); };
  $('selAll').onclick = function () {
    Array.prototype.forEach.call(document.querySelectorAll('#rows tr'), function (tr) {
      selected[tr.dataset.id] = true;
      tr.classList.add('sel');
      var cb = tr.querySelector('td.c input[type=checkbox]');
      if (cb) cb.checked = true;
    });
    updateSel();
  };
  $('selNone').onclick = function () {
    selected = {};
    Array.prototype.forEach.call(document.querySelectorAll('#rows tr'), function (tr) {
      tr.classList.remove('sel');
      var cb = tr.querySelector('td.c input[type=checkbox]');
      if (cb) cb.checked = false;
    });
    updateSel();
  };

  function bulk(action, tag) {
    var ids = selectedIds();
    if (!ids.length) return toast('Nothing selected');
    api('/api/admin/words/bulk', { method: 'POST', body: JSON.stringify({ ids: ids, action: action, tag: tag }) })
      .then(function () { return api('/api/admin/state'); })
      .then(function (d) { words = d.words; fillTagFilter(); renderRows(); toast('Done'); })
      .catch(function (e) { toast(e.message); });
  }
  $('bulkOn').onclick = function () { bulk('enable'); };
  $('bulkOff').onclick = function () { bulk('disable'); };
  $('bulkAddTag').onclick = function () { bulk('tag', $('bulkTag').value.trim().toLowerCase()); };
  $('bulkRmTag').onclick = function () { bulk('untag', $('bulkTag').value.trim().toLowerCase()); };
  $('bulkDel').onclick = function () {
    var ids = selectedIds();
    if (!ids.length) return toast('Nothing selected');
    if (!confirm('Delete ' + ids.length + ' words?')) return;
    api('/api/admin/words', { method: 'DELETE', body: JSON.stringify({ ids: ids }) })
      .then(function () {
        words = words.filter(function (w) { return ids.indexOf(w.id) === -1; });
        selected = {};
        renderRows();
        toast('Deleted');
      }).catch(function (e) { toast(e.message); });
  };

  $('addBtn').onclick = function () {
    var w = $('newWord').value.trim();
    if (!w) return toast('Type a word first');
    api('/api/admin/words', {
      method: 'POST',
      body: JSON.stringify({
        word: w,
        hint: $('newHint').value.trim(),
        aliases: $('newAliases').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        tags: $('newTags').value.split(/[\s,]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean),
        enabled: true
      })
    }).then(function (r) {
      words.push(r.word);
      $('newWord').value = ''; $('newHint').value = ''; $('newAliases').value = '';
      fillTagFilter();
      renderRows();
      toast('Added ' + r.word.word);
      $('newWord').focus();
    }).catch(function (e) { toast(e.message); });
  };
  ['newWord', 'newHint', 'newAliases', 'newTags'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') $('addBtn').click(); });
  });

  /* ------------------------------------------------------------- defaults */
  function fillDefaults() {
    if (!defaults) return;
    $('dRounds').value = defaults.rounds;
    $('dTime').value = defaults.drawTime;
    $('dMax').value = defaults.maxPlayers;
    $('dChoices').value = defaults.wordChoices;
    $('dHints').value = defaults.hints ? defaults.hintCount : 0;
    $('dChoiceTime').value = defaults.choiceTime;
  }
  $('saveDefaults').onclick = function () {
    var hints = Number($('dHints').value);
    api('/api/admin/defaults', {
      method: 'POST',
      body: JSON.stringify({
        rounds: Number($('dRounds').value),
        drawTime: Number($('dTime').value),
        maxPlayers: Number($('dMax').value),
        wordChoices: Number($('dChoices').value),
        hints: hints > 0,
        hintCount: hints > 0 ? hints : 1,
        choiceTime: Number($('dChoiceTime').value)
      })
    }).then(function (r) {
      defaults = r.defaults;
      fillDefaults();
      $('defSaved').textContent = 'Saved';
      setTimeout(function () { $('defSaved').textContent = ''; }, 1800);
    }).catch(function (e) { toast(e.message); });
  };

  /* ------------------------------------------------------------- rooms */
  function loadRooms() {
    api('/api/admin/state').then(function (d) { rooms = d.rooms; renderRooms(); }).catch(function (e) { toast(e.message); });
  }
  function renderRooms() {
    var tb = $('roomRows');
    tb.innerHTML = '';
    $('roomStat').textContent = rooms.length + (rooms.length === 1 ? ' lobby' : ' lobbies');
    rooms.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td class="mono"><b>' + esc(r.code) + '</b>' + (r.isPublic ? ' <span class="hint">public</span>' : '') + '</td>' +
        '<td>' + esc(r.state) + '</td>' +
        '<td>' + (r.round ? r.round + '/' + r.rounds : '-') + '</td>' +
        '<td>' + r.online + ' online <span class="hint">' + esc(r.names.join(', ')) + '</span></td>' +
        '<td>' + esc(r.word || '-') + '</td>';
      var td = document.createElement('td');
      var b = document.createElement('button');
      b.className = 'small danger'; b.textContent = 'Close';
      b.onclick = function () {
        if (!confirm('Close lobby ' + r.code + ' and kick everyone?')) return;
        api('/api/admin/rooms/close', { method: 'POST', body: JSON.stringify({ code: r.code }) })
          .then(loadRooms).catch(function (e) { toast(e.message); });
      };
      td.appendChild(b);
      tr.appendChild(td);
      tb.appendChild(tr);
    });
  }
  $('refreshRooms').onclick = loadRooms;

  /* ------------------------------------------------------------- io */
  $('importBtn').onclick = function () {
    var text = $('importText').value;
    if (!text.trim()) return toast('Nothing to import');
    if ($('importMode').value === 'replace' && !confirm('This replaces the entire word list. Continue?')) return;
    api('/api/admin/words/import', { method: 'POST', body: JSON.stringify({ text: text, mode: $('importMode').value }) })
      .then(function (r) {
        $('importStat').textContent = r.replaced ? ('Replaced with ' + r.added + ' words') : (r.added + ' added, ' + r.skipped + ' duplicates skipped');
        return api('/api/admin/state');
      })
      .then(function (d) { words = d.words; fillTagFilter(); renderRows(); })
      .catch(function (e) { toast(e.message); });
  };
  $('exportBtn').onclick = function () {
    fetch('/api/admin/export', { headers: { 'x-admin-token': token } })
      .then(function (r) { return r.blob(); })
      .then(function (b) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = 'fafscribbl-words.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      }).catch(function () { toast('Export failed'); });
  };
  /* ------------------------------------------------------------- start */
  try {
    var saved = sessionStorage.getItem('fs_admin');
    if (saved) { token = saved; boot(); }
  } catch (e) { /* ignore */ }
  $('pw').focus();
})();
