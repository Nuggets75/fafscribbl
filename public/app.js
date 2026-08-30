/* fafscribbl client */
(function () {
  'use strict';

  var LW = 900, LH = 560;
  var PALETTE = ['#000000', '#7f7f7f', '#c3c3c3', '#ffffff', '#880015', '#ed1c24',
    '#ff7f27', '#fff200', '#22b14c', '#00a2e8', '#3f48cc', '#a349a4',
    '#b97a57', '#ffaec9', '#ffc90e', '#efe4b0', '#b5e61d', '#99d9ea',
    '#7092be', '#c8bfe7', '#654321', '#2b1b0e'];
  var SIZES = [4, 8, 16, 30];

  var $ = function (id) { return document.getElementById(id); };
  var cfg = { unitDb: 'https://faforever.github.io/etfreeman-db/#/', filterGroups: [], tagCounts: {}, defaults: null };
  var sock = null, wantOpen = false, retry = 0, retryTimer = null;
  var me = null, S = null, offset = 0, leaving = false;
  var gameEndHidden = false, lastState = null, lastCorrect = 0;
  var pendingJoin = null;

  /* ---------------------------------------------------------------- utils */
  function now() { return Date.now() + offset; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(text) {
    var d = document.createElement('div');
    d.className = 'toast';
    d.textContent = text;
    $('toasts').appendChild(d);
    setTimeout(function () { d.remove(); }, 3200);
  }
  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { /* private mode */ }
    return null;
  }
  function codeFromUrl() {
    var m = location.pathname.match(/^\/r\/([A-Za-z0-9]{1,12})/);
    return m ? m[1].toUpperCase() : '';
  }
  function isDrawer() { return !!(S && me && S.drawerId === me); }
  function isHost() { return !!(S && me && S.hostId === me); }
  function meP() {
    if (!S || !S.players) return null;
    for (var i = 0; i < S.players.length; i++) if (S.players[i].id === me) return S.players[i];
    return null;
  }

  /* ---------------------------------------------------------------- canvas */
  var off = document.createElement('canvas');
  off.width = LW; off.height = LH;
  var octx = off.getContext('2d', { willReadFrequently: true });
  var board = $('board'), bctx = board.getContext('2d');

  function clearOff() { octx.fillStyle = '#ffffff'; octx.fillRect(0, 0, LW, LH); }
  clearOff();

  // Keep the board as large as the panel allows while holding the 900x560 ratio exactly.
  var boardPct = 80;
  function isPhone() { return window.innerWidth <= 860; }
  function sizeCanvas() {
    var area = $('canvasArea');
    if (!area || !area.clientWidth) return;
    // On a phone the board is simply as wide as the column. There is no spare height to give
    // it a share of, and the board-size slider is a desktop comfort setting.
    if (isPhone()) {
      var wp = Math.floor(area.clientWidth);
      var wrapM = $('canvasWrap');
      wrapM.style.width = wp + 'px';
      wrapM.style.height = Math.floor(wp * LH / LW) + 'px';
      return;
    }
    if (!area.clientHeight) return;
    var scale = Math.min(area.clientWidth / LW, area.clientHeight / LH) * (boardPct / 100);
    if (!isFinite(scale) || scale <= 0) return;
    var wrap = $('canvasWrap');
    wrap.style.width = Math.floor(LW * scale) + 'px';
    wrap.style.height = Math.floor(LH * scale) + 'px';
  }

  function blit() {
    sizeCanvas();
    var wrap = $('canvasWrap');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(wrap.clientWidth * dpr));
    var h = Math.max(1, Math.round(wrap.clientHeight * dpr));
    if (board.width !== w || board.height !== h) { board.width = w; board.height = h; }
    bctx.imageSmoothingEnabled = true;
    bctx.clearRect(0, 0, board.width, board.height);
    bctx.drawImage(off, 0, 0, board.width, board.height);
  }
  window.addEventListener('resize', function () { blit(); if (S) renderHeader(); });
  if (typeof ResizeObserver === 'function') {
    var ro = new ResizeObserver(function () { sizeCanvas(); blit(); });
    setTimeout(function () { var a = $('canvasArea'); if (a) ro.observe(a); }, 0);
  }

  function hexToRgb(h) {
    h = String(h || '#000000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) n = 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function floodFill(x, y, color) {
    x = Math.max(0, Math.min(LW - 1, Math.round(x)));
    y = Math.max(0, Math.min(LH - 1, Math.round(y)));
    var img = octx.getImageData(0, 0, LW, LH);
    var d = img.data;
    var start = (y * LW + x) * 4;
    var tr = d[start], tg = d[start + 1], tb = d[start + 2];
    var rgb = hexToRgb(color);
    if (Math.abs(tr - rgb[0]) < 6 && Math.abs(tg - rgb[1]) < 6 && Math.abs(tb - rgb[2]) < 6) return;
    var seen = new Uint8Array(LW * LH);
    var stack = [y * LW + x];
    while (stack.length) {
      var p = stack.pop();
      if (seen[p]) continue;
      seen[p] = 1;
      var i = p * 4;
      if (Math.abs(d[i] - tr) > 40 || Math.abs(d[i + 1] - tg) > 40 || Math.abs(d[i + 2] - tb) > 40) continue;
      d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
      var px = p % LW, py = (p - px) / LW;
      if (px > 0) stack.push(p - 1);
      if (px < LW - 1) stack.push(p + 1);
      if (py > 0) stack.push(p - LW);
      if (py < LH - 1) stack.push(p + LW);
    }
    octx.putImageData(img, 0, 0);
  }

  function applyOp(op) {
    if (!op || !op.length) return;
    if (op[0] === 's') {
      octx.strokeStyle = op[5];
      octx.lineWidth = op[6];
      octx.lineCap = 'round';
      octx.lineJoin = 'round';
      octx.beginPath();
      octx.moveTo(op[1], op[2]);
      octx.lineTo(op[3], op[4]);
      octx.stroke();
    } else if (op[0] === 'f') {
      floodFill(op[1], op[2], op[3]);
    }
  }
  function rebuild(ops) {
    clearOff();
    for (var i = 0; i < ops.length; i++) applyOp(ops[i]);
    blit();
  }

  /* -------------------------------------------------------------- drawing */
  var tool = 'pen', color = '#000000', size = 8, drawing = false, last = null;
  var queue = [], flushTimer = null;

  function flush() {
    if (!queue.length) return;
    send({ t: 'draw', ops: queue });
    queue = [];
  }
  function pushOp(op) {
    applyOp(op); blit();
    queue.push(op);
    if (queue.length > 60) flush();
    if (!flushTimer) flushTimer = setInterval(function () { flush(); }, 50);
  }
  function pos(e) {
    var r = board.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width * LW,
      y: (e.clientY - r.top) / r.height * LH
    };
  }
  function canPaint() { return S && S.state === 'drawing' && isDrawer(); }

  board.addEventListener('pointerdown', function (e) {
    if (!canPaint()) return;
    e.preventDefault();
    var p = pos(e);
    if (tool === 'fill') {
      send({ t: 'begin' });
      pushOp(['f', Math.round(p.x), Math.round(p.y), color]);
      flush();
      return;
    }
    drawing = true;
    last = p;
    try { board.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    send({ t: 'begin' });
    var c = tool === 'eraser' ? '#ffffff' : color;
    pushOp(['s', Math.round(p.x), Math.round(p.y), Math.round(p.x) + 0.01, Math.round(p.y), c, size]);
  });
  board.addEventListener('pointermove', function (e) {
    if (!drawing || !canPaint()) return;
    e.preventDefault();
    var p = pos(e);
    var c = tool === 'eraser' ? '#ffffff' : color;
    if (Math.abs(p.x - last.x) < 0.7 && Math.abs(p.y - last.y) < 0.7) return;
    pushOp(['s', Math.round(last.x), Math.round(last.y), Math.round(p.x), Math.round(p.y), c, size]);
    last = p;
  });
  function stopDraw() { if (drawing) { drawing = false; flush(); } }
  board.addEventListener('pointerup', stopDraw);
  board.addEventListener('pointercancel', stopDraw);
  board.addEventListener('pointerleave', stopDraw);
  window.addEventListener('blur', stopDraw);

  function buildTools() {
    var sw = $('swatches');
    sw.innerHTML = '';
    PALETTE.forEach(function (c) {
      var d = document.createElement('div');
      d.className = 'sw' + (c === color ? ' on' : '');
      d.style.background = c;
      d.title = c;
      d.onclick = function () {
        color = c; tool = tool === 'fill' ? 'fill' : 'pen';
        buildTools(); syncToolButtons();
      };
      sw.appendChild(d);
    });
    var sz = $('sizes');
    sz.innerHTML = '';
    SIZES.forEach(function (s) {
      var d = document.createElement('div');
      d.className = 'sz' + (s === size ? ' on' : '');
      var i = document.createElement('i');
      var px = Math.max(4, Math.round(s * 0.7));
      i.style.width = px + 'px'; i.style.height = px + 'px';
      i.style.background = tool === 'eraser' ? '#fff' : color;
      d.appendChild(i);
      d.onclick = function () { size = s; buildTools(); };
      sz.appendChild(d);
    });
  }
  function syncToolButtons() {
    $('toolPen').classList.toggle('on', tool === 'pen');
    $('toolFill').classList.toggle('on', tool === 'fill');
    $('toolEraser').classList.toggle('on', tool === 'eraser');
  }
  $('toolPen').onclick = function () { tool = 'pen'; syncToolButtons(); buildTools(); };
  $('toolFill').onclick = function () { tool = 'fill'; syncToolButtons(); buildTools(); };
  $('toolEraser').onclick = function () { tool = 'eraser'; syncToolButtons(); buildTools(); };
  $('toolUndo').onclick = function () { if (canPaint()) { flush(); send({ t: 'undo' }); } };
  $('toolClear').onclick = function () { if (canPaint()) { flush(); send({ t: 'clearCanvas' }); } };
  document.addEventListener('keydown', function (e) {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); $('toolUndo').onclick(); }
  });

  /* ------------------------------------------------------------- socket */
  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }
  function send(obj) {
    if (sock && sock.readyState === 1) sock.send(JSON.stringify(obj));
  }
  function connect(payload) {
    pendingJoin = payload || pendingJoin;
    if (!pendingJoin) return;
    wantOpen = true;
    leaving = false;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    try { sock = new WebSocket(wsUrl()); } catch (e) { scheduleRetry(); return; }

    sock.onopen = function () {
      retry = 0;
      var p = Object.assign({ t: 'hello' }, pendingJoin);
      var tk = ls('fs_token_' + (pendingJoin.code || ''));
      if (tk && !pendingJoin.create) p.token = tk;
      sock.send(JSON.stringify(p));
    };
    sock.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handle(m);
    };
    sock.onclose = function () {
      sock = null;
      if (leaving || !wantOpen) return;
      if (S) toast('Connection lost, reconnecting...');
      scheduleRetry();
    };
    sock.onerror = function () { /* onclose follows */ };
  }
  function scheduleRetry() {
    if (leaving || !wantOpen) return;
    retry++;
    if (!S && retry >= 3) {
      var msg = 'Could not open a connection to the server. If the site sits behind ' +
        'Nginx Proxy Manager, switch on <b>Websockets Support</b> for this host.';
      $('homeErr').innerHTML = msg;
      $('joinErr').innerHTML = msg;
    }
    var wait = Math.min(8000, 500 * Math.pow(1.6, retry));
    retryTimer = setTimeout(function () {
      if (pendingJoin && pendingJoin.create) { pendingJoin.create = false; }
      connect(null);
    }, wait);
  }
  function disconnect() {
    leaving = true; wantOpen = false;
    if (retryTimer) clearTimeout(retryTimer);
    if (sock) { try { sock.close(); } catch (e) {} sock = null; }
  }

  /* ------------------------------------------------------------- handlers */
  function handle(m) {
    switch (m.t) {
      case 'joined':
        me = m.you;
        ls('fs_token_' + m.code, m.token);
        pendingJoin = { code: m.code, name: pendingJoin ? pendingJoin.name : '' };
        if (location.pathname !== '/r/' + m.code) history.replaceState({}, '', '/r/' + m.code);
        $('home').classList.add('hide');
        $('game').classList.remove('hide');
        setTimeout(blit, 30);
        break;
      case 'error':
        if (!S) {
          var onCard = !$('joinCard').classList.contains('hide');
          $(onCard ? 'joinErr' : 'homeErr').textContent = m.message || 'Could not join';
          disconnect();
        } else toast(m.message || 'Error');
        break;
      case 'kicked':
        disconnect();
        alert('You were removed from the lobby.');
        location.href = '/';
        break;
      case 'closed':
        disconnect();
        alert('This lobby was closed by an admin.');
        location.href = '/';
        break;
      case 'state':
        offset = m.now - Date.now();
        if (!S || m.state !== 'drawing' || m.wordIcon !== S.wordIcon) refShown = false;
        S = m;
        sizeCanvas();
        rebuild(m.canvas || []);
        renderChatAll(m.chat || []);
        renderAll();
        break;
      case 'players':
        if (!S) return;
        S.players = m.players; S.hostId = m.hostId; S.drawerId = m.drawerId;
        renderPlayers(); renderLobby(); renderHeader();
        break;
      case 'settings':
        if (!S) return;
        S.settings = m.settings;
        if (typeof m.poolSize === 'number') S.poolSize = m.poolSize;
        renderLobby(); renderHeader(); renderLookup();
        break;
      case 'chat':
        // your own correct guess already played the bigger sound, do not double it up
        if (m.kind === 'good' && / guessed the word$/.test(m.text || '') && Date.now() - lastCorrect > 600) SFX.guessed();
        addChat(m);
        break;
      case 'draw': (m.ops || []).forEach(applyOp); blit(); break;
      case 'canvas': rebuild(m.ops || []); break;
      case 'mask': if (S) { S.mask = m.mask; renderHeader(); } break;
      case 'reveal':
        // Now that this player knows the word, they get the reference picture too.
        if (S) { S.word = m.word; S.mask = m.word; S.wordIcon = m.icon || null; renderHeader(); renderRef(); }
        lastCorrect = Date.now();
        SFX.correct();
        break;
      case 'choices': window.__choiceIcons = m.icons || []; SFX.turnStart(); showChoices(m.words, m.hints); break;
      case 'turnend': showTurnEnd(m); break;
      case 'gameend': showGameEnd(m); break;
      case 'lookup': showLookup(m); break;
      case 'pong': offset = m.now - Date.now(); break;
      default: break;
    }
  }

  /* ------------------------------------------------------------- render */
  function renderAll() {
    renderHeader(); renderPlayers(); renderLobby(); renderOverlays(); renderToolbar(); renderLookup();
  }

  function renderHeader() {
    if (!S) return;
    $('codeText').textContent = S.code;
    if (S.state === 'lobby') $('roundBox').textContent = 'Lobby';
    else if (S.state === 'gameend') $('roundBox').textContent = 'Finished';
    // "Round 1/3" does not fit beside six buttons on a phone, so it becomes "1/3" there.
    else $('roundBox').textContent = (isPhone() ? '' : 'Round ') + S.round + '/' + S.rounds;

    var sub = 'waiting', mask = '';
    if (S.state === 'choosing') {
      sub = isDrawer() ? 'pick a word' : 'the drawer is choosing';
    } else if (S.state === 'drawing') {
      if (isDrawer()) { sub = 'you are drawing'; mask = S.word || ''; }
      else if (S.word) { sub = 'you got it'; mask = S.word; }
      else { sub = 'guess the word - ' + countLetters(S.mask) + ' letters'; mask = S.mask || ''; }
    } else if (S.state === 'turnend') {
      sub = 'the word was'; mask = S.word || '';
    } else if (S.state === 'lobby') {
      sub = isHost() ? 'set up the lobby, then start' : 'waiting for the host to start';
    }
    $('wordSub').textContent = sub;
    $('wordMask').textContent = mask.replace(/ /g, '   ');
    $('skipBtn').classList.toggle('hide', !(S.state === 'drawing' && (isDrawer() || isHost())));

    // Pause belongs to the host and only means anything once a game is running.
    var canPause = isHost() && S.state !== 'lobby';
    var pb = $('pauseBtn');
    pb.classList.toggle('hide', !canPause);
    pb.textContent = S.paused ? 'Resume' : 'Pause';
    pb.classList.toggle('on', !!S.paused);
    renderPaused();
  }

  function renderPaused() {
    var on = !!(S && S.paused);
    $('ovPaused').classList.toggle('hide', !on);
    $('resumeBtn').classList.toggle('hide', !(on && isHost()));
    $('pausedBy').textContent = isHost()
      ? 'You paused the game.'
      : 'The host paused the game.';
    document.body.classList.toggle('ispaused', on);
  }
  function countLetters(mask) {
    return String(mask || '').replace(/[^A-Za-z0-9_]/g, '').length;
  }

  function renderPlayers() {
    if (!S) return;
    var box = $('players');
    var list = (S.players || []).slice().sort(function (a, b) { return b.score - a.score; });
    box.innerHTML = '';
    list.forEach(function (p, i) {
      var d = document.createElement('div');
      d.className = 'pl' + (p.id === me ? ' me' : '') + (p.guessed ? ' guessed' : '') + (p.connected ? '' : ' off');
      var badges = '';
      if (p.isHost) badges += ' <span class="badge" title="host">&#9812;</span>';
      if (p.isDrawer) badges += ' <span class="badge" title="drawing">&#9998;</span>';
      if (p.guessed) badges += ' <span class="badge" title="guessed">&#10003;</span>';
      d.innerHTML =
        '<div class="av" style="background:' + esc(p.color) + '">' + esc((p.name[0] || '?').toUpperCase()) + '</div>' +
        '<div class="nm">' + (i + 1) + '. ' + esc(p.name) + badges + '</div>' +
        '<div class="sc">' + p.score + '</div>';
      if (isHost() && p.id !== me) {
        var k = document.createElement('button');
        k.className = 'kick';
        k.textContent = 'kick';
        k.onclick = function () { if (confirm('Kick ' + p.name + '?')) send({ t: 'kick', id: p.id }); };
        d.appendChild(k);
      }
      box.appendChild(d);
    });
  }

  function renderToolbar() {
    var show = S && S.state === 'drawing' && isDrawer();
    $('tools').classList.toggle('hide', !show);
    renderRef();
    board.style.cursor = show ? 'crosshair' : 'default';
    if (show) buildTools();
    sizeCanvas(); blit();
    var ci = $('chatinput');
    if (!S) return;
    if (S.state === 'drawing' && isDrawer()) ci.placeholder = 'You are drawing, do not give it away';
    else if (S.state === 'drawing' && S.word) ci.placeholder = 'Chat with the others who guessed';
    else if (S.state === 'drawing') ci.placeholder = 'Type your guess';
    else ci.placeholder = 'Say something';
  }

  /* --------- lobby overlay --------- */
  var chipsSignature = '';
  function groupDefs() { return (S && S.filterGroups) ? S.filterGroups : (cfg.filterGroups || []); }
  function tagCounts() { return (S && S.tagCounts) ? S.tagCounts : (cfg.tagCounts || {}); }

  // Chip rows come from the admin-defined groups. A tag with no enabled words behind it
  // is not offered at all, so deleting every word of a kind removes its chip by itself.
  function buildFilterGroups() {
    var groups = groupDefs();
    var counts = tagCounts();
    var sig = JSON.stringify(groups) + '|' + JSON.stringify(counts);
    if (sig === chipsSignature) return;
    chipsSignature = sig;
    var host = $('filterGroups');
    host.innerHTML = '';
    groups.forEach(function (g) {
      var live = (g.tags || []).filter(function (t) { return (counts[t] || 0) > 0; });
      if (!live.length) return;
      var box = document.createElement('div');
      box.className = 'fgroup';
      var lab = document.createElement('label');
      lab.innerHTML = esc(g.label) + ' ';
      var mk = function (text, on) {
        var b = document.createElement('button');
        b.className = 'small ghost';
        b.type = 'button';
        b.style.padding = '1px 7px';
        b.style.fontSize = '11px';
        b.style.marginLeft = '4px';
        b.textContent = text;
        b.onclick = function () {
          if (!isHost()) return;
          Array.prototype.forEach.call(box.querySelectorAll('.chip'), function (c) { c.classList.toggle('on', on); });
          pushSettings();
        };
        return b;
      };
      lab.appendChild(mk('all', true));
      lab.appendChild(mk('none', false));
      box.appendChild(lab);
      var chips = document.createElement('div');
      chips.className = 'chips';
      live.forEach(function (t) {
        var c = document.createElement('div');
        c.className = 'chip';
        c.dataset.tag = t;
        c.dataset.group = g.id;
        c.innerHTML = esc(t) + '<span class="n">' + counts[t] + '</span>';
        c.title = counts[t] + ' words tagged ' + t;
        c.onclick = function () { if (!isHost()) return; c.classList.toggle('on'); pushSettings(); };
        chips.appendChild(c);
      });
      box.appendChild(chips);
      host.appendChild(box);
    });
  }

  function buildChips() {
    if ($('setRounds').options.length) return;
    var r = $('setRounds');
    for (var i = 1; i <= 10; i++) r.add(new Option(i + (i === 1 ? ' round' : ' rounds'), i));
    var t = $('setTime');
    t.add(new Option('Off (no timer)', 0));
    [30, 40, 50, 60, 80, 100, 120, 150, 180, 240, 300].forEach(function (s) { t.add(new Option(s + ' seconds', s)); });
    var mp = $('setMax');
    mp.add(new Option('Unlimited', 0));
    [4, 6, 8, 10, 12, 16, 20, 30, 50].forEach(function (n) { mp.add(new Option(n + ' players', n)); });
  }

  function renderLobby() {
    if (!S) return;
    buildChips();
    buildFilterGroups();
    var s = S.settings;
    $('lobbyCode').textContent = S.code;
    $('inviteLink').value = location.origin + '/r/' + S.code;
    $('setRounds').value = String(s.rounds);
    $('setTime').value = String(s.drawTime);
    $('setMax').value = String(s.maxPlayers);
    $('setChoices').value = String(s.wordChoices);
    $('setHints').value = String(s.hints ? s.hintCount : 0);
    $('setPublic').value = s.isPublic ? '1' : '0';
    $('setLookup').value = s.lookup === false ? '0' : '1';
    $('setPreviews').value = s.previews === false ? '0' : '1';
    if (document.activeElement !== $('setCustom')) $('setCustom').value = s.customWords || '';
    $('setCustomOnly').checked = !!s.customWordsOnly;
    var tf = s.tagFilters || {};
    Array.prototype.forEach.call(document.querySelectorAll('#filterGroups .chip'), function (c) {
      c.classList.toggle('on', (tf[c.dataset.group] || []).indexOf(c.dataset.tag) !== -1);
    });
    renderPoolInfo();

    var host = isHost();
    ['setRounds', 'setTime', 'setMax', 'setChoices', 'setHints', 'setPublic', 'setLookup', 'setPreviews', 'setCustom', 'setCustomOnly'].forEach(function (id) {
      $(id).disabled = !host;
    });
    $('hostNote').textContent = host
      ? 'You are the host. Settings apply to the next game.'
      : 'Only the host can change the settings.';
    var enough = (S.players || []).filter(function (p) { return p.connected; }).length >= 2;
    var empty = S.poolSize === 0;
    var anyOn = !!document.querySelector('#filterGroups .chip.on');
    $('startBtn').disabled = !host || !enough || empty;
    $('startBtn').textContent = !enough ? 'Waiting for at least 2 players'
      : (!anyOn ? 'Select at least one category'
        : (empty ? 'No words in this selection'
          : (host ? 'Start the game' : 'Waiting for the host')));

    var lp = $('lobbyPlayers');
    lp.innerHTML = '';
    (S.players || []).forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'lp';
      d.innerHTML = '<div class="av" style="background:' + esc(p.color) + '">' +
        esc((p.name[0] || '?').toUpperCase()) + '</div>' + esc(p.name) + (p.isHost ? ' &#9812;' : '');
      lp.appendChild(d);
    });
  }

  function renderPoolInfo() {
    if (!S || typeof S.poolSize !== 'number') { $('poolInfo').textContent = ''; return; }
    var n = S.poolSize;
    var anyOn = !!document.querySelector('#filterGroups .chip.on');
    $('poolInfo').classList.toggle('empty', n === 0);
    if (!anyOn) {
      $('poolInfo').innerHTML = 'Nothing is selected. <b>Pick at least one category</b> above to choose what can come up.';
    } else if (n === 0) {
      $('poolInfo').innerHTML = '<b>0</b> words in this selection, pick something else';
    } else {
      $('poolInfo').innerHTML = '<b>' + n + '</b> word' + (n === 1 ? '' : 's') + ' in this selection';
    }
    var host = isHost();
    $('selectAllTags').disabled = !host;
    $('clearAllTags').disabled = !host;
  }

  function collectSettings() {
    var tagFilters = {};
    Array.prototype.forEach.call(document.querySelectorAll('#filterGroups .chip.on'), function (c) {
      (tagFilters[c.dataset.group] = tagFilters[c.dataset.group] || []).push(c.dataset.tag);
    });
    var hints = Number($('setHints').value);
    return {
      rounds: Number($('setRounds').value),
      drawTime: Number($('setTime').value),
      maxPlayers: Number($('setMax').value),
      wordChoices: Number($('setChoices').value),
      hints: hints > 0,
      hintCount: hints > 0 ? hints : 1,
      isPublic: $('setPublic').value === '1',
      lookup: $('setLookup').value === '1',
      previews: $('setPreviews').value === '1',
      customWords: $('setCustom').value,
      customWordsOnly: $('setCustomOnly').checked,
      tagFilters: tagFilters
    };
  }
  function pushSettings() { if (isHost()) send({ t: 'settings', settings: collectSettings() }); }
  ['setRounds', 'setTime', 'setMax', 'setChoices', 'setHints', 'setPublic', 'setLookup', 'setPreviews', 'setCustomOnly'].forEach(function (id) {
    $(id).addEventListener('change', pushSettings);
  });
  $('setCustom').addEventListener('blur', pushSettings);
  $('selectAllTags').onclick = function () {
    if (!isHost()) return;
    Array.prototype.forEach.call(document.querySelectorAll('#filterGroups .chip'), function (c) { c.classList.add('on'); });
    pushSettings();
  };
  $('clearAllTags').onclick = function () {
    if (!isHost()) return;
    Array.prototype.forEach.call(document.querySelectorAll('#filterGroups .chip'), function (c) { c.classList.remove('on'); });
    pushSettings();
  };
  $('startBtn').onclick = function () { send({ t: 'start' }); };
  $('againBtn').onclick = function () { if (isHost()) send({ t: 'lobby' }); else toast('Only the host can do that'); };
  $('copyInvite').onclick = function () { copy($('inviteLink').value); };
  $('codePill').onclick = function () { if (S) copy(location.origin + '/r/' + S.code); };
  function copy(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast('Invite link copied'); },
      function () { prompt('Copy this link', text); });
    else prompt('Copy this link', text);
  }
  $('skipBtn').onclick = function () { send({ t: 'skip' }); };
  $('pauseBtn').onclick = function () {
    if (!isHost()) { toast('Only the host can pause'); return; }
    send({ t: 'pause', on: !(S && S.paused) });
  };
  $('resumeBtn').onclick = function () { if (isHost()) send({ t: 'pause', on: false }); };

  /* --------- sound --------- */
  var AC = null, sndGain = null;
  var SFX_KEYS = ['guessSelf', 'guessOther', 'turnStart', 'turnEnd', 'gameEnd', 'clockMark', 'clockCount'];
  var sfxOn = {};
  (function loadSfx() {
    var raw = null;
    try { raw = JSON.parse(ls('fs_sfx') || 'null'); } catch (e) { raw = null; }
    SFX_KEYS.forEach(function (k) { sfxOn[k] = !raw || raw[k] !== false; });
  })();
  function saveSfx() { ls('fs_sfx', JSON.stringify(sfxOn)); }
  var sndOn = ls('fs_snd') !== '0';
  var sndVol = ls('fs_vol') === null ? 60 : Math.max(0, Math.min(100, Number(ls('fs_vol'))));
  function audio() {
    if (AC) { if (AC.state === 'suspended') AC.resume(); return AC; }
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try { AC = new Ctx(); } catch (e) { return null; }
    sndGain = AC.createGain();
    sndGain.gain.value = sndVol / 100;
    sndGain.connect(AC.destination);
    return AC;
  }
  // One short shaped tone. Everything below is built out of these, so there are no audio
  // files to ship and nothing to load before the first round.
  function tone(freq, at, dur, type, level) {
    var ctx = audio();
    if (!ctx || !sndOn) return;
    var t0 = ctx.currentTime + at;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(level || 0.5, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(sndGain);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }
  // Each effect checks its own switch, so any one of them can be silenced on its own.
  var SFX = {
    correct: function () { if (!sfxOn.guessSelf) return; tone(784, 0, 0.11, 'sine', 0.5); tone(1175, 0.09, 0.16, 'sine', 0.45); },
    guessed: function () { if (!sfxOn.guessOther) return; tone(660, 0, 0.07, 'sine', 0.3); },
    turnEnd: function () { if (!sfxOn.turnEnd) return; tone(659, 0, 0.13, 'triangle', 0.4); tone(523, 0.12, 0.13, 'triangle', 0.4); tone(392, 0.24, 0.26, 'triangle', 0.4); },
    gameEnd: function () { if (!sfxOn.gameEnd) return; [523, 659, 784, 1047].forEach(function (f, i) { tone(f, i * 0.11, 0.22, 'triangle', 0.42); }); },
    mark: function () { if (!sfxOn.clockMark) return; tone(700, 0, 0.14, 'sine', 0.4); },
    count: function (n) { if (!sfxOn.clockCount) return; tone(n <= 1 ? 1100 : 880, 0, 0.1, 'square', 0.32); },
    turnStart: function () { if (!sfxOn.turnStart) return; tone(523, 0, 0.09, 'sine', 0.35); tone(784, 0.08, 0.14, 'sine', 0.35); }
  };
  function applyVol() {
    if (sndGain) sndGain.gain.value = sndVol / 100;
    $('sndVol').value = String(sndVol);
    $('sndVolVal').textContent = sndVol + '%';
    $('sndOn').checked = sndOn;
    $('sndBtn').classList.toggle('off', !sndOn || sndVol === 0);
    Array.prototype.forEach.call(document.querySelectorAll('.sfx'), function (cb) {
      cb.checked = !!sfxOn[cb.dataset.sfx];
      cb.disabled = !sndOn;
    });
    ls('fs_vol', String(sndVol));
    ls('fs_snd', sndOn ? '1' : '0');
  }
  Array.prototype.forEach.call(document.querySelectorAll('.sfx'), function (cb) {
    cb.addEventListener('change', function () {
      sfxOn[cb.dataset.sfx] = cb.checked;
      saveSfx();
      applyVol();
      if (!cb.checked) return;
      var demo = { guessSelf: SFX.correct, guessOther: SFX.guessed, turnStart: SFX.turnStart,
        turnEnd: SFX.turnEnd, gameEnd: SFX.gameEnd, clockMark: SFX.mark,
        clockCount: function () { SFX.count(3); } }[cb.dataset.sfx];
      if (demo) { audio(); demo(); }
    });
  });
  $('sndBtn').onclick = function (e) {
    e.stopPropagation();
    audio();
    $('uiPanel').classList.add('hide');
    $('sndPanel').classList.toggle('hide');
  };
  $('sndClose').onclick = function () { $('sndPanel').classList.add('hide'); };
  $('sndPanel').addEventListener('click', function (e) { e.stopPropagation(); });
  $('sndVol').addEventListener('input', function () { sndVol = Number($('sndVol').value); applyVol(); });
  $('sndVol').addEventListener('change', function () { SFX.guessed(); });
  $('sndOn').addEventListener('change', function () { sndOn = $('sndOn').checked; applyVol(); if (sndOn) SFX.correct(); });
  $('sndTest').onclick = function () { audio(); SFX.correct(); };
  applyVol();
  document.addEventListener('pointerdown', function () { audio(); }, { once: true });

  /* --------- the drawer's reference picture --------- */
  var refWidth = Number(ls('fs_ref_w')) || 180;
  var refPlaced = false;
  // Deliberately not remembered. Every turn starts with the picture hidden, so seeing it
  // is always something the drawer asked for.
  var refShown = false;
  function refAvailable() { return !!(S && S.wordIcon); }
  function applyRefWidth(px) {
    refWidth = Math.max(90, Math.min(420, Math.round(px)));
    $('refPanel').style.width = refWidth + 'px';
    ls('fs_ref_w', String(refWidth));
  }
  function showRef(on) {
    refShown = !!on;
    renderRef();
  }
  function renderRef() {
    var panel = $('refPanel');
    // The button only exists when this particular unit actually has a picture.
    // The server only sends wordIcon to people who are allowed to know the word, so
    // this covers the drawer and anyone who has already guessed it.
    var can = refAvailable() && S.state === 'drawing';
    $('toolRef').classList.toggle('hide', !can);
    if (!can) { panel.classList.add('hide'); return; }
    var want = refShown;
    $('toolRef').classList.toggle('on', want);
    $('toolRef').textContent = want ? 'Hide the picture' : 'What does this look like';
    panel.classList.toggle('hide', !want);
    if (want) {
      var src = '/icons/' + S.wordIcon;
      if ($('refImg').getAttribute('src') !== src) $('refImg').src = src;
      applyRefWidth(refWidth);
      placeRef();
      clampRef();
    }
  }
  // Park it in the empty gutter beside the board when there is one, rather than on top
  // of the drawing. Once the player drags it, their position is kept.
  function placeRef() {
    if (refPlaced) return;
    var stage = $('stage'), wrap = $('canvasWrap'), panel = $('refPanel');
    if (!stage || !wrap || !wrap.offsetWidth) return;
    var gutter = (stage.clientWidth - wrap.offsetWidth) / 2;
    panel.style.left = (gutter >= panel.offsetWidth + 16 ? Math.max(6, (gutter - panel.offsetWidth) / 2) : 10) + 'px';
    panel.style.top = '12px';
    refPlaced = true;
  }
  function clampRef() {
    var stage = $('stage'), panel = $('refPanel');
    if (!stage || panel.classList.contains('hide')) return;
    var maxL = Math.max(0, stage.clientWidth - panel.offsetWidth - 4);
    var maxT = Math.max(0, stage.clientHeight - panel.offsetHeight - 4);
    panel.style.left = Math.max(0, Math.min(maxL, parseInt(panel.style.left || '10', 10))) + 'px';
    panel.style.top = Math.max(0, Math.min(maxT, parseInt(panel.style.top || '12', 10))) + 'px';
  }
  $('toolRef').onclick = function () { showRef(!refShown); };
  $('refClose').onclick = function () { showRef(false); };
  $('refBigger').onclick = function () { applyRefWidth(refWidth * 1.25); clampRef(); };
  $('refSmaller').onclick = function () { applyRefWidth(refWidth / 1.25); clampRef(); };
  (function dragRef() {
    var bar = document.querySelector('#refPanel .refbar');
    var panel = $('refPanel');
    var start = null;
    bar.addEventListener('pointerdown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      refPlaced = true;
      start = { x: e.clientX, y: e.clientY, l: parseInt(panel.style.left || '10', 10), t: parseInt(panel.style.top || '12', 10) };
      try { bar.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    bar.addEventListener('pointermove', function (e) {
      if (!start) return;
      panel.style.left = (start.l + e.clientX - start.x) + 'px';
      panel.style.top = (start.t + e.clientY - start.y) + 'px';
    });
    var stop = function () { if (start) { start = null; clampRef(); } };
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
  })();

  /* --------- display settings --------- */
  function applyBoard(pct) {
    var v = Math.max(40, Math.min(100, Math.round(pct / 5) * 5));
    boardPct = v;
    $('uiBoard').value = String(v);
    $('uiBoardVal').textContent = v + '%';
    ls('fs_board', String(v));
    sizeCanvas(); blit();
  }
  function applyScale(pct) {
    var v = Math.max(70, Math.min(160, Math.round(pct / 5) * 5));
    document.documentElement.style.setProperty('--ui', String(v / 100));
    $('uiScale').value = String(v);
    $('uiScaleVal').textContent = v + '%';
    ls('fs_ui', String(v));
    setTimeout(function () { sizeCanvas(); blit(); }, 0);
  }
  applyScale(Number(ls('fs_ui')) || 100);
  applyBoard(Number(ls('fs_board')) || 80);
  $('uiBoard').addEventListener('input', function () { applyBoard(Number($('uiBoard').value)); });
  $('uiScale').addEventListener('input', function () { applyScale(Number($('uiScale').value)); });
  $('uiReset').onclick = function () { applyScale(100); applyBoard(80); };
  $('uiBtn').onclick = function (e) {
    e.stopPropagation();
    $('sndPanel').classList.add('hide');
    $('uiPanel').classList.toggle('hide');
  };
  $('uiClose').onclick = function () { $('uiPanel').classList.add('hide'); };
  $('uiPanel').addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', function () {
    $('uiPanel').classList.add('hide');
    $('sndPanel').classList.add('hide');
  });
  $('closeGameEnd').onclick = function () { gameEndHidden = true; renderOverlays(); };
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('uiPanel').classList.contains('hide')) { $('uiPanel').classList.add('hide'); return; }
    if (!$('sndPanel').classList.contains('hide')) { $('sndPanel').classList.add('hide'); return; }
    if (!S) return;
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (S.state === 'gameend' && !gameEndHidden) { gameEndHidden = true; renderOverlays(); }
  });
  $('leaveBtn').onclick = function () {
    if (!confirm('Leave the lobby?')) return;
    document.body.classList.remove('ispaused');
    document.body.classList.remove('lkopen');
    disconnect();
    location.href = '/';
  };

  /* --------- overlays --------- */
  function renderOverlays() {
    if (!S) return;
    lastState = S.state;
    // The board only exists once a game is running. In the lobby the stage IS the lobby.
    var inLobby = S.state === 'lobby';
    $('lobbyPanel').classList.toggle('hide', !inLobby);
    $('canvasArea').classList.toggle('hide', inLobby);
    if (!inLobby) setTimeout(function () { sizeCanvas(); blit(); }, 0);
    if (S.state !== 'choosing') hideChoices();
    if (S.state !== 'turnend') $('ovTurnEnd').classList.add('hide');
    if (S.state !== 'gameend') $('ovGameEnd').classList.add('hide');
    else $('ovGameEnd').classList.toggle('hide', gameEndHidden);
    if (S.state === 'choosing') {
      if (isDrawer() && S.choosing) { window.__choiceIcons = S.choosingIcons || []; showChoices(S.choosing, S.choosingHints); }
      else showWaitingChoice();
    }
  }
  function drawerName() {
    var d = (S.players || []).filter(function (p) { return p.id === S.drawerId; })[0];
    return d ? d.name : 'Someone';
  }
  function hideChoices() {
    $('ovChoose').classList.add('hide');
    $('chooseList').innerHTML = '';
  }
  function showChoices(list, hints) {
    $('chooseTitle').textContent = 'Choose a word to draw';
    $('chooseSub').textContent = 'Only you see these. Nobody else sees what the words are.';
    var box = $('chooseList');
    box.innerHTML = '';
    (list || []).forEach(function (w, i) {
      var b = document.createElement('button');
      var name = document.createElement('span');
      name.textContent = w;
      b.appendChild(name);
      var icon = (window.__choiceIcons || [])[i];
      if (icon) {
        var im = document.createElement('img');
        im.className = 'choiceicon';
        im.src = '/icons/' + icon;
        im.alt = '';
        b.insertBefore(im, name);
      }
      var note = (hints || [])[i];
      if (note) {
        var n = document.createElement('span');
        n.className = 'note';
        n.textContent = note;
        b.appendChild(n);
      }
      b.onclick = function () { send({ t: 'pick', index: i }); hideChoices(); };
      box.appendChild(b);
    });
    $('ovChoose').classList.remove('hide');
  }
  function showWaitingChoice() {
    $('chooseTitle').textContent = drawerName() + ' is choosing a word';
    $('chooseSub').textContent = 'Get ready to guess.';
    $('chooseList').innerHTML = '';
    $('ovChoose').classList.remove('hide');
  }
  function showTurnEnd(m) {
    SFX.turnEnd();
    if (S) { S.state = 'turnend'; S.word = m.word; S.endsAt = m.endsAt; }
    hideChoices();
    var ri = $('revealIcon');
    if (m.icon) { ri.src = '/icons/' + m.icon; ri.classList.remove('hide'); }
    else ri.classList.add('hide');
    $('revealWord').textContent = m.word;
    var box = $('turnResults');
    box.innerHTML = '';
    (m.results || []).slice().sort(function (a, b) { return b.delta - a.delta; }).forEach(function (r) {
      var d = document.createElement('div');
      d.className = 'rrow';
      d.innerHTML = '<span>' + esc(r.name) + (r.id === m.drawerId ? ' (drawing)' : '') + '</span>' +
        '<span class="d ' + (r.delta > 0 ? 'pos' : 'zero') + '">' + (r.delta > 0 ? '+' + r.delta : '0') + '</span>';
      box.appendChild(d);
    });
    $('ovTurnEnd').classList.remove('hide');
    renderHeader();
  }
  function showGameEnd(m) {
    SFX.gameEnd();
    gameEndHidden = false;
    if (S) { S.state = 'gameend'; S.endsAt = m.endsAt; }
    hideChoices();
    $('ovTurnEnd').classList.add('hide');
    var st = m.standings || [];
    var pod = $('podium');
    pod.innerHTML = '';
    [1, 0, 2].forEach(function (idx) {
      var p = st[idx];
      if (!p) return;
      var d = document.createElement('div');
      d.className = 'pod';
      d.innerHTML = '<div class="nm">' + esc(p.name) + '</div><div class="sc">' + p.score + '</div>' +
        '<div class="p' + (idx + 1) + '" style="background:' + esc(p.color) + ';border-radius:6px;margin-top:6px"></div>' +
        '<div class="hint">#' + (idx + 1) + '</div>';
      pod.appendChild(d);
    });
    var box = $('finalResults');
    box.innerHTML = '';
    st.forEach(function (p, i) {
      var d = document.createElement('div');
      d.className = 'rrow';
      d.innerHTML = '<span>' + (i + 1) + '. ' + esc(p.name) + '</span><span class="d pos">' + p.score + '</span>';
      box.appendChild(d);
    });
    $('againBtn').disabled = !isHost();
    $('ovGameEnd').classList.remove('hide');
    renderHeader();
  }

  /* --------- unit look-up --------- */
  var lkTimer = null;
  function lookupEnabled() { return !!(S && S.settings && S.settings.lookup); }
  function renderLookup() {
    var on = lookupEnabled();
    $('lookup').classList.toggle('hide', !on);
    // On a phone the look-up is a sheet behind the magnifier, so the button goes with it.
    $('lkBtn').classList.toggle('hide', !on);
    if (!on) document.body.classList.remove('lkopen');
  }
  function openLookup(on) {
    document.body.classList.toggle('lkopen', !!on);
    if (on) { try { $('lkInput').focus(); } catch (e) { /* ignore */ } }
  }
  $('lkBtn').onclick = function () { openLookup(!document.body.classList.contains('lkopen')); };
  $('lkClose').onclick = function () { openLookup(false); };
  function runLookup() {
    var q = $('lkInput').value.trim();
    if (!q) {
      $('lkResults').innerHTML = '<p class="lkhint">Describe a unit and this finds its name. Order does not matter.</p>';
      return;
    }
    send({ t: 'lookup', q: q });
  }
  $('lkInput').addEventListener('input', function () {
    clearTimeout(lkTimer);
    lkTimer = setTimeout(runLookup, 180);
  });
  $('lkInput').addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'Enter') { clearTimeout(lkTimer); runLookup(); }
  });
  function showLookup(m) {
    var box = $('lkResults');
    if (m.off) { box.innerHTML = '<p class="lkhint">The look-up is switched off in this lobby.</p>'; return; }
    if (m.paused) { box.innerHTML = '<p class="lkhint">The game is paused.</p>'; return; }
    if ($('lkInput').value.trim() !== m.q) return;
    if (!m.results.length) {
      box.innerHTML = '<p class="lkhint">Nothing matches all of those words.</p>';
      return;
    }
    box.innerHTML = '';
    m.results.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'lkrow';
      if (r.icon) {
        var im = document.createElement('img');
        im.src = '/icons/' + r.icon;
        im.alt = '';
        im.loading = 'lazy';
        row.appendChild(im);
      }
      var t = document.createElement('div');
      t.className = 't';
      t.innerHTML = '<div class="n">' + esc(r.word) + '</div><div class="h" title="' + esc(r.hint) + '">' + esc(r.hint) + '</div>';
      row.appendChild(t);
      box.appendChild(row);
    });
  }

  /* --------- chat --------- */
  function chatRow(m) {
    var d = document.createElement('div');
    var cls = 'msg ';
    if (m.kind === 'msg') cls += 'plain' + (m.guessed ? ' guessed' : '') + (m.drawer ? ' drawer' : '');
    else cls += m.kind;
    d.className = cls;
    if (m.kind === 'msg') {
      d.innerHTML = '<span class="who" style="color:' + esc(m.color || '#fff') + '">' + esc(m.from) + ':</span> ' + esc(m.text);
    } else {
      d.textContent = m.text;
    }
    return d;
  }
  function addChat(m) {
    var log = $('chatlog');
    var atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
    log.appendChild(chatRow(m));
    while (log.childNodes.length > 250) log.removeChild(log.firstChild);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  function renderChatAll(list) {
    var log = $('chatlog');
    log.innerHTML = '';
    (list || []).forEach(function (m) { log.appendChild(chatRow(m)); });
    log.scrollTop = log.scrollHeight;
  }
  $('chatform').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('chatinput').value.trim();
    if (!v) return;
    send({ t: 'chat', text: v });
    $('chatinput').value = '';
  });

  /* --------- timer --------- */
  var lastLeft = null;
  var BEEP_AT = [30, 20, 5, 4, 3, 2, 1];
  setInterval(function () {
    var el = $('timer');
    var band = $('timerBand');
    if (!S || S.state === 'lobby') {
      band.classList.add('hide');
      el.classList.remove('low');
      lastLeft = null;
      return;
    }
    band.classList.remove('hide');
    if (!S.endsAt) {
      el.innerHTML = S.paused ? 'paused' : '&#8734;';
      el.classList.remove('low');
      el.classList.toggle('held', !!S.paused);
      lastLeft = null;
      return;
    }
    if (S.paused) {
      el.textContent = Math.max(0, Math.ceil(S.pausedLeft / 1000));
      el.classList.add('held');
      el.classList.remove('low');
      lastLeft = null;
      return;
    }
    el.classList.remove('held');
    var left = Math.max(0, Math.ceil((S.endsAt - now()) / 1000));
    el.textContent = left;
    el.classList.toggle('low', S.state === 'drawing' && left <= 10);
    if (S.state === 'drawing' && lastLeft !== null && left < lastLeft && BEEP_AT.indexOf(left) !== -1) {
      if (left > 10) SFX.mark(); else SFX.count(left);
    }
    lastLeft = left;
  }, 200);
  setInterval(function () { if (sock && sock.readyState === 1) send({ t: 'ping' }); }, 20000);

  /* ------------------------------------------------------------- home */
  function loadConfig() {
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
      cfg = c;
      cfg.filterGroups = c.filterGroups || [];
      cfg.tagCounts = c.tagCounts || {};
      $('dbLink').href = c.unitDb;
      $('dbLink2').href = c.unitDb;
      $('wordCount').textContent = c.words;
      var info = $('soloInfo'), sbtn = $('soloBtn');
      if (info) {
        var n = c.drawings || 0;
        info.textContent = n < 3
          ? 'No saved drawings yet. Play a lobby round and they start collecting here.'
          : n + ' drawings saved so far.';
        if (sbtn) sbtn.classList.toggle('off', n < 3);
      }
    }).catch(function () { /* offline */ });
  }
  function loadRooms() {
    if (!$('home') || $('home').classList.contains('hide')) return;
    fetch('/api/rooms').then(function (r) { return r.json(); }).then(function (d) {
      var box = $('publicRooms');
      if (!d.rooms || !d.rooms.length) {
        box.innerHTML = '<p class="hint">Nothing open right now. Create one.</p>';
        return;
      }
      box.innerHTML = '';
      d.rooms.forEach(function (r) {
        var el = document.createElement('div');
        el.className = 'roomline';
        el.innerHTML = '<span><b class="mono">' + esc(r.code) + '</b> <span class="hint">' +
          r.players + (r.max ? '/' + r.max : '') + ' players, ' + esc(r.state === 'lobby' ? 'in the lobby' : 'playing') +
          '</span></span>';
        var b = document.createElement('button');
        b.className = 'small primary';
        b.textContent = 'Join';
        b.onclick = function () { $('codeInput').value = r.code; doJoin(); };
        el.appendChild(b);
        box.appendChild(el);
      });
    }).catch(function () { /* offline */ });
  }

  function nameValue() {
    var n = $('nameInput').value.trim();
    if (!n) { $('homeErr').textContent = 'Pick a name first.'; $('nameInput').focus(); return null; }
    ls('fs_name', n);
    return n;
  }
  function doJoin() {
    var n = nameValue();
    if (!n) return;
    var code = $('codeInput').value.trim().toUpperCase();
    if (!code) { $('homeErr').textContent = 'Enter a lobby code, or create a lobby.'; return; }
    $('homeErr').textContent = '';
    connect({ name: n, code: code });
  }

  // Someone opening an invite link should only ever be asked for a name. The full menu,
  // and in particular the Create button, is out of the way until they ask for it.
  function showJoinCard(code) {
    $('joinCode').textContent = code;
    $('joinCard').classList.remove('hide');
    $('homeCard').classList.add('hide');
    var saved = ls('fs_name');
    if (saved) $('joinName').value = saved;
    setTimeout(function () { $('joinName').focus(); $('joinName').select(); }, 30);
  }
  function joinFromCard() {
    var n = $('joinName').value.trim();
    if (!n) { $('joinErr').textContent = 'Type a name first.'; $('joinName').focus(); return; }
    ls('fs_name', n);
    $('joinErr').textContent = '';
    connect({ name: n, code: $('joinCode').textContent.trim() });
  }
  $('joinNowBtn').onclick = joinFromCard;
  $('joinName').addEventListener('keydown', function (e) { if (e.key === 'Enter') joinFromCard(); });
  $('toMenu').onclick = function (e) {
    e.preventDefault();
    $('joinCard').classList.add('hide');
    $('homeCard').classList.remove('hide');
    history.replaceState({}, '', '/');
    $('nameInput').focus();
  };
  function doCreate() {
    var n = nameValue();
    if (!n) return;
    $('homeErr').textContent = '';
    connect({ name: n, create: true, settings: cfg.defaults || {} });
  }
  $('joinBtn').onclick = doJoin;
  $('createBtn').onclick = doCreate;
  $('codeInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
  $('nameInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { if ($('codeInput').value.trim()) doJoin(); else doCreate(); }
  });

  var saved = ls('fs_name');
  if (saved) $('nameInput').value = saved;
  var urlCode = codeFromUrl();
  loadConfig();
  loadRooms();
  setInterval(loadRooms, 8000);
  if (urlCode) {
    $('codeInput').value = urlCode;
    if (saved) connect({ name: saved, code: urlCode });
    else showJoinCard(urlCode);
  } else {
    $('nameInput').focus();
  }
})();
