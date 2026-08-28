/* fafscribbl admin */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var token = null, words = [], defaults = null, rooms = [], selected = {}, page = 1;
  var groups = [], counts = {}, iconList = null, iconTarget = null;

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
      ['words', 'defaults', 'filters', 'rooms', 'drawings', 'io'].forEach(function (n) {
        $('tab-' + n).classList.toggle('hide', n !== t.dataset.tab);
      });
      if (t.dataset.tab === 'rooms') loadRooms();
      if (t.dataset.tab === 'filters') refreshCounts();
      if (t.dataset.tab === 'drawings') loadDrawings(true);
    };
  });

  /* -------------------------------------------------- saved drawings */
  var drawOffset = 0, drawTotal = 0, drawSel = {};
  var DW = 900, DH = 560;

  function hexToRgb(h) {
    var t = String(h || '#000000').replace('#', '');
    if (t.length === 3) t = t[0] + t[0] + t[1] + t[1] + t[2] + t[2];
    var n = parseInt(t, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // Thumbnails skip the flood fills: they are slow and a filled area reads fine as an outline.
  function paint(cv, ops, doFills) {
    var ctx = cv.getContext('2d', { willReadFrequently: !!doFills });
    var sx = cv.width / DW, sy = cv.height / DH;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!op || !op.length) continue;
      if (op[0] === 's') {
        ctx.strokeStyle = op[5];
        ctx.lineWidth = op[6];
        ctx.beginPath();
        ctx.moveTo(op[1], op[2]);
        ctx.lineTo(op[3], op[4]);
        ctx.stroke();
      } else if (op[0] === 'f' && doFills) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        fillOn(ctx, cv, Math.round(op[1] * sx), Math.round(op[2] * sy), op[3]);
        ctx.setTransform(sx, 0, 0, sy, 0, 0);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  function fillOn(ctx, cv, x, y, color) {
    var w = cv.width, h = cv.height;
    x = Math.max(0, Math.min(w - 1, x));
    y = Math.max(0, Math.min(h - 1, y));
    var img = ctx.getImageData(0, 0, w, h), d = img.data;
    var st = (y * w + x) * 4, tr = d[st], tg = d[st + 1], tb = d[st + 2];
    var rgb = hexToRgb(color);
    if (Math.abs(tr - rgb[0]) < 6 && Math.abs(tg - rgb[1]) < 6 && Math.abs(tb - rgb[2]) < 6) return;
    var seen = new Uint8Array(w * h), stack = [y * w + x];
    while (stack.length) {
      var p = stack.pop();
      if (seen[p]) continue;
      seen[p] = 1;
      var i = p * 4;
      if (Math.abs(d[i] - tr) > 40 || Math.abs(d[i + 1] - tg) > 40 || Math.abs(d[i + 2] - tb) > 40) continue;
      d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
      var px = p % w, py = (p - px) / w;
      if (px > 0) stack.push(p - 1);
      if (px < w - 1) stack.push(p + 1);
      if (py > 0) stack.push(p - w);
      if (py < h - 1) stack.push(p + w);
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawStat() {
    var n = Object.keys(drawSel).length;
    $('drawStat').textContent = drawTotal + ' saved' + (n ? ', ' + n + ' selected' : '');
    $('drawMore').disabled = $('drawGrid').children.length >= drawTotal;
  }

  function loadDrawings(reset) {
    if (reset) { drawOffset = 0; drawSel = {}; $('drawGrid').innerHTML = ''; }
    return api('/api/admin/drawings?limit=24&offset=' + drawOffset).then(function (d) {
      drawTotal = d.total;
      if (d.cap) $('drawCap').textContent = d.cap;
      drawOffset += d.drawings.length;
      if (!d.drawings.length && !$('drawGrid').children.length) {
        $('drawGrid').innerHTML = '<p class="hint">No drawings saved yet. They appear here as soon as people finish turns.</p>';
      }
      d.drawings.forEach(addCard);
      drawStat();
    }).catch(function (e) { $('drawStat').textContent = e.message; });
  }

  function addCard(d) {
    var card = document.createElement('div');
    card.className = 'dcard';
    card.innerHTML =
      '<canvas width="380" height="236"></canvas>' +
      '<div class="dmeta"><input type="checkbox" style="width:auto;margin:0"> <b></b>' +
      '<span style="flex:1"></span><button class="small danger">Delete</button></div>';
    var cv = card.querySelector('canvas');
    card.querySelector('b').textContent = d.word;
    card.querySelector('b').title = (d.drawer ? 'drawn by ' + d.drawer + ', ' : '') + new Date(d.at).toLocaleString();
    var cb = card.querySelector('input');
    cb.onchange = function () {
      if (cb.checked) drawSel[d.id] = true; else delete drawSel[d.id];
      card.classList.toggle('sel', cb.checked);
      drawStat();
    };
    card.querySelector('button').onclick = function () {
      api('/api/admin/drawings', { method: 'DELETE', body: JSON.stringify({ ids: [d.id] }) })
        .then(function (r) { drawTotal = r.total; delete drawSel[d.id]; card.remove(); drawStat(); })
        .catch(function (e) { alert(e.message); });
    };
    cv.onclick = function () { openBig(d); };
    $('drawGrid').appendChild(card);
    api('/api/admin/drawings/one?id=' + encodeURIComponent(d.id)).then(function (r) {
      card._ops = r.drawing.ops;
      paint(cv, r.drawing.ops, false);
    }).catch(function () { /* gone */ });
  }

  function openBig(d) {
    $('drawFor').textContent = d.word + (d.drawer ? '  -  drawn by ' + d.drawer : '');
    $('drawModal').classList.remove('hide');
    api('/api/admin/drawings/one?id=' + encodeURIComponent(d.id)).then(function (r) {
      paint($('drawBig'), r.drawing.ops, true);
    }).catch(function () { /* gone */ });
  }
  $('drawModalClose').onclick = function () { $('drawModal').classList.add('hide'); };
  $('drawModal').onclick = function (e) { if (e.target === $('drawModal')) $('drawModal').classList.add('hide'); };

  $('drawRefresh').onclick = function () { loadDrawings(true); };
  $('drawMore').onclick = function () { loadDrawings(false); };
  $('drawDelSel').onclick = function () {
    var ids = Object.keys(drawSel);
    if (!ids.length) { alert('Nothing selected.'); return; }
    if (!confirm('Delete ' + ids.length + ' drawing' + (ids.length === 1 ? '' : 's') + '?')) return;
    api('/api/admin/drawings', { method: 'DELETE', body: JSON.stringify({ ids: ids }) })
      .then(function () { loadDrawings(true); }).catch(function (e) { alert(e.message); });
  };
  $('drawClear').onclick = function () {
    if (!confirm('Delete every saved drawing? The single player challenge will have nothing left to show until new ones are drawn.')) return;
    if (!confirm('Really delete all ' + drawTotal + '? This cannot be undone.')) return;
    api('/api/admin/drawings/clear', { method: 'POST' })
      .then(function (r) { alert(r.removed + ' deleted.'); loadDrawings(true); })
      .catch(function (e) { alert(e.message); });
  };
  $('hsClear').onclick = function () {
    if (!confirm('Wipe the single player highscore board?')) return;
    api('/api/admin/highscores/clear', { method: 'POST' })
      .then(function (r) { alert(r.removed + ' scores removed.'); })
      .catch(function (e) { alert(e.message); });
  };

  /* ------------------------------------------------------------- boot */
  function boot() {
    api('/api/admin/state').then(function (d) {
      words = d.words; defaults = d.defaults; rooms = d.rooms;
      groups = d.filterGroups || []; counts = d.tagCounts || {};
      $('login').classList.add('hide');
      $('panel').classList.remove('hide');
      fillTagFilter();
      renderRows();
      fillDefaults();
      renderRooms();
      renderGroups();
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

      var tdIcon = document.createElement('td');
      tdIcon.className = 'c';
      var img = document.createElement('img');
      img.className = 'wicon' + (w.icon ? '' : ' empty');
      img.src = w.icon ? ('/icons/' + w.icon) : '/favicon.svg';
      img.title = w.icon ? ('Icon: ' + w.icon + ' (click to change)') : 'No icon, click to pick one';
      img.onclick = function (e) { e.stopPropagation(); openIconPicker(w, img); };
      tdIcon.appendChild(img);
      tr.appendChild(tdIcon);

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
      .then(function (d) {
        words = d.words; counts = d.tagCounts || counts;
        fillTagFilter(); renderRows(); renderGroups(); toast('Done');
      })
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
        tags: $('newTags').value.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean),
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

  /* ------------------------------------------------------------- icons */
  function loadIcons() {
    if (iconList) return Promise.resolve(iconList);
    return api('/api/admin/icons').then(function (d) {
      iconList = (d.custom || []).concat(d.builtin || []);
      return iconList;
    });
  }
  function openIconPicker(w, img) {
    iconTarget = { word: w, img: img };
    $('iconFor').textContent = 'Icon for "' + w.word + '"';
    $('iconStat').textContent = '';
    $('iconSearch').value = '';
    $('iconModal').classList.remove('hide');
    $('iconGrid').innerHTML = '<p class="hint">Loading...</p>';
    loadIcons().then(function () { renderIconGrid(); $('iconSearch').focus(); })
      .catch(function (e) { $('iconGrid').innerHTML = '<p class="hint">' + esc(e.message) + '</p>'; });
  }
  function renderIconGrid() {
    var q = $('iconSearch').value.trim().toLowerCase();
    var cur = iconTarget && iconTarget.word.icon;
    var list = (iconList || []).filter(function (f) { return !q || f.toLowerCase().indexOf(q) !== -1; });
    var grid = $('iconGrid');
    grid.innerHTML = '';
    list.slice(0, 600).forEach(function (f) {
      var im = document.createElement('img');
      im.src = '/icons/' + f;
      im.title = f;
      im.loading = 'lazy';
      if (f === cur) im.className = 'on';
      im.onclick = function () { setIcon(f); };
      grid.appendChild(im);
    });
    if (!list.length) grid.innerHTML = '<p class="hint">Nothing matches.</p>';
    $('iconStat').textContent = list.length + ' available';
  }
  function setIcon(value) {
    if (!iconTarget) return;
    var w = iconTarget.word, img = iconTarget.img;
    api('/api/admin/words', { method: 'PUT', body: JSON.stringify({ id: w.id, icon: value }) })
      .then(function (r) {
        Object.assign(w, r.word);
        img.src = w.icon ? ('/icons/' + w.icon) : '/favicon.svg';
        img.classList.toggle('empty', !w.icon);
        img.title = w.icon ? ('Icon: ' + w.icon + ' (click to change)') : 'No icon, click to pick one';
        $('iconModal').classList.add('hide');
        toast(value ? 'Icon set' : 'Icon removed');
      }).catch(function (e) { toast(e.message); });
  }
  $('iconSearch').addEventListener('input', renderIconGrid);
  $('iconCancel').onclick = function () { $('iconModal').classList.add('hide'); };
  $('iconClear').onclick = function () { setIcon(''); };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') $('iconModal').classList.add('hide');
  });
  $('iconFile').addEventListener('change', function () {
    var f = $('iconFile').files && $('iconFile').files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { toast('Images must be under 2 MB'); return; }
    var rd = new FileReader();
    rd.onload = function () {
      $('iconStat').textContent = 'Uploading...';
      api('/api/admin/icons/upload', { method: 'POST', body: JSON.stringify({ dataUrl: rd.result, name: f.name.replace(/\.[^.]+$/, '') }) })
        .then(function (r) {
          iconList = null;
          $('iconFile').value = '';
          return loadIcons().then(function () { setIcon(r.icon); });
        }).catch(function (e) { $('iconStat').textContent = ''; toast(e.message); });
    };
    rd.readAsDataURL(f);
  });

  /* ------------------------------------------------------------- filters */
  // Counts drift as soon as a word is added, tagged or disabled, so pull them fresh
  // whenever the tab is opened rather than trusting whatever boot left behind.
  function refreshCounts() {
    return api('/api/admin/state').then(function (d) {
      counts = d.tagCounts || {};
      groups = d.filterGroups || groups;
      renderGroups();
    }).catch(function (e) { toast(e.message); renderGroups(); });
  }

  function renderGroups() {
    var host = $('groupRows');
    if (!host) return;
    host.innerHTML = '';
    groups.forEach(function (g, i) {
      var row = document.createElement('div');
      row.className = 'grow';
      row.innerHTML =
        '<div><label>Group name</label><input type="text" class="g-label" value="' + esc(g.label) + '"></div>' +
        '<div><label>Tags, comma separated</label><input type="text" class="g-tags" value="' + esc((g.tags || []).join(', ')) + '"></div>';
      var rm = document.createElement('div');
      var b = document.createElement('button');
      b.className = 'small danger delbtn';
      b.innerHTML = '&#10005;';
      b.title = 'Remove this group';
      b.onclick = function () { groups.splice(i, 1); renderGroups(); };
      rm.appendChild(b);
      row.appendChild(rm);
      host.appendChild(row);
    });
    if (!groups.length) host.innerHTML = '<p class="hint">No groups. Hosts will see no filters at all.</p>';

    var cloud = $('tagCloud');
    cloud.innerHTML = '';
    Object.keys(counts).sort().forEach(function (t) {
      var c = document.createElement('div');
      c.className = 'chip';
      c.innerHTML = esc(t) + '<span class="n">' + counts[t] + '</span>';
      c.title = 'Click to copy';
      c.onclick = function () {
        if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { toast('Copied "' + t + '"'); }, function () {});
      };
      cloud.appendChild(c);
    });
  }

  function collectGroups() {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('#groupRows .grow'), function (row, i) {
      var label = row.querySelector('.g-label').value.trim();
      if (!label) return;
      out.push({
        id: (groups[i] && groups[i].id) || label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        label: label,
        tags: row.querySelector('.g-tags').value.split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean)
      });
    });
    return out;
  }

  $('addGroup').onclick = function () {
    groups = collectGroups();
    groups.push({ id: '', label: 'New group', tags: [] });
    renderGroups();
  };
  $('saveFilters').onclick = function () {
    api('/api/admin/filters', { method: 'POST', body: JSON.stringify({ groups: collectGroups() }) })
      .then(function (r) {
        groups = r.filterGroups;
        renderGroups();
        $('filtersSaved').textContent = 'Saved';
        setTimeout(function () { $('filtersSaved').textContent = ''; }, 1800);
      }).catch(function (e) { toast(e.message); });
  };

  /* ------------------------------------------------------------- rooms */
  function loadRooms() {
    api('/api/admin/state').then(function (d) {
      rooms = d.rooms; counts = d.tagCounts || counts;
      renderRooms();
    }).catch(function (e) { toast(e.message); });
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
    api('/api/admin/words/import', { method: 'POST', body: JSON.stringify({ text: text }) })
      .then(function (r) {
        $('importStat').textContent = r.added + ' added, ' + r.skipped + ' already in the list';
        return api('/api/admin/state');
      })
      .then(function (d) {
        words = d.words; counts = d.tagCounts || counts;
        fillTagFilter(); renderRows(); renderGroups();
      })
      .catch(function (e) { toast(e.message); });
  };
  $('refillBtn').onclick = function () {
    $('refillStat').textContent = 'Matching...';
    api('/api/admin/icons/refill', { method: 'POST' })
      .then(function (r) {
        $('refillStat').textContent = r.filled + ' of ' + r.checked + ' words without a picture were matched';
        return api('/api/admin/state');
      })
      .then(function (d) { words = d.words; renderRows(); })
      .catch(function (e) { $('refillStat').textContent = ''; toast(e.message); });
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
