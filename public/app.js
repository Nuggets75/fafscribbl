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
  var cfg = { unitDb: 'https://faforever.github.io/etfreeman-db/#/', factionTags: [], kindTags: [], defaults: null };
  var sock = null, wantOpen = false, retry = 0, retryTimer = null;
  var me = null, S = null, offset = 0, leaving = false;
  var lobbyHidden = false, gameEndHidden = false, lastState = null;
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

  function blit() {
    var wrap = $('canvasWrap');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(wrap.clientWidth * dpr));
    var h = Math.max(1, Math.round(wrap.clientHeight * dpr));
    if (board.width !== w || board.height !== h) { board.width = w; board.height = h; }
    bctx.imageSmoothingEnabled = true;
    bctx.clearRect(0, 0, board.width, board.height);
    bctx.drawImage(off, 0, 0, board.width, board.height);
  }
  window.addEventListener('resize', blit);

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
      $('homeErr').innerHTML = 'Could not open a connection to the server. If the site sits behind ' +
        'Nginx Proxy Manager, switch on <b>Websockets Support</b> for this host.';
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
          $('homeErr').textContent = m.message || 'Could not join';
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
        S = m;
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
        renderLobby(); renderHeader();
        break;
      case 'chat': addChat(m); break;
      case 'draw': (m.ops || []).forEach(applyOp); blit(); break;
      case 'canvas': rebuild(m.ops || []); break;
      case 'mask': if (S) { S.mask = m.mask; renderHeader(); } break;
      case 'reveal': if (S) { S.word = m.word; S.mask = m.word; renderHeader(); } break;
      case 'choices': showChoices(m.words, m.endsAt); break;
      case 'turnend': showTurnEnd(m); break;
      case 'gameend': showGameEnd(m); break;
      case 'pong': offset = m.now - Date.now(); break;
      default: break;
    }
  }

  /* ------------------------------------------------------------- render */
  function renderAll() {
    renderHeader(); renderPlayers(); renderLobby(); renderOverlays(); renderToolbar();
  }

  function renderHeader() {
    if (!S) return;
    $('codeText').textContent = S.code;
    if (S.state === 'lobby') $('roundBox').textContent = 'Lobby';
    else if (S.state === 'gameend') $('roundBox').textContent = 'Finished';
    else $('roundBox').textContent = 'Round ' + S.round + '/' + S.rounds;

    var sub = 'waiting', mask = '';
    if (S.state === 'choosing') {
      sub = isDrawer() ? 'pick a unit' : 'the drawer is choosing';
    } else if (S.state === 'drawing') {
      if (isDrawer()) { sub = 'you are drawing'; mask = S.word || ''; }
      else if (S.word) { sub = 'you got it'; mask = S.word; }
      else { sub = 'guess the unit - ' + countLetters(S.mask) + ' letters'; mask = S.mask || ''; }
    } else if (S.state === 'turnend') {
      sub = 'the word was'; mask = S.word || '';
    } else if (S.state === 'lobby') {
      sub = 'waiting for the host';
    }
    $('wordSub').textContent = sub;
    $('wordMask').textContent = mask.replace(/ /g, '   ');
    $('skipBtn').classList.toggle('hide', !(S.state === 'drawing' && (isDrawer() || isHost())));
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
    board.style.cursor = show ? 'crosshair' : 'default';
    if (show) buildTools();
    var ci = $('chatinput');
    if (!S) return;
    if (S.state === 'drawing' && isDrawer()) ci.placeholder = 'You are drawing, do not give it away';
    else if (S.state === 'drawing' && S.word) ci.placeholder = 'Chat with the others who guessed';
    else if (S.state === 'drawing') ci.placeholder = 'Type your guess';
    else ci.placeholder = 'Say something';
  }

  /* --------- lobby overlay --------- */
  var chipsBuilt = false;
  function buildChips() {
    if (chipsBuilt) return;
    chipsBuilt = true;
    var f = $('factionChips'), k = $('kindChips');
    f.innerHTML = ''; k.innerHTML = '';
    cfg.factionTags.forEach(function (t) {
      var c = document.createElement('div');
      c.className = 'chip'; c.dataset.tag = t; c.dataset.kind = 'faction';
      c.textContent = t;
      c.onclick = function () { if (!isHost()) return; c.classList.toggle('on'); pushSettings(); };
      f.appendChild(c);
    });
    cfg.kindTags.forEach(function (t) {
      var c = document.createElement('div');
      c.className = 'chip'; c.dataset.tag = t; c.dataset.kind = 'kind';
      c.textContent = t;
      c.onclick = function () { if (!isHost()) return; c.classList.toggle('on'); pushSettings(); };
      k.appendChild(c);
    });
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
    var s = S.settings;
    $('lobbyCode').textContent = S.code;
    $('inviteLink').value = location.origin + '/r/' + S.code;
    $('setRounds').value = String(s.rounds);
    $('setTime').value = String(s.drawTime);
    $('setMax').value = String(s.maxPlayers);
    $('setChoices').value = String(s.wordChoices);
    $('setHints').value = String(s.hints ? s.hintCount : 0);
    $('setPublic').value = s.isPublic ? '1' : '0';
    if (document.activeElement !== $('setCustom')) $('setCustom').value = s.customWords || '';
    $('setCustomOnly').checked = !!s.customWordsOnly;
    Array.prototype.forEach.call(document.querySelectorAll('#factionChips .chip'), function (c) {
      c.classList.toggle('on', (s.factions || []).indexOf(c.dataset.tag) !== -1);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#kindChips .chip'), function (c) {
      c.classList.toggle('on', (s.kinds || []).indexOf(c.dataset.tag) !== -1);
    });

    var host = isHost();
    ['setRounds', 'setTime', 'setMax', 'setChoices', 'setHints', 'setPublic', 'setCustom', 'setCustomOnly'].forEach(function (id) {
      $(id).disabled = !host;
    });
    $('hostNote').textContent = host
      ? 'You are the host. Settings apply to the next game.'
      : 'Only the host can change the settings.';
    var enough = (S.players || []).filter(function (p) { return p.connected; }).length >= 2;
    $('startBtn').disabled = !host || !enough;
    $('startBtn').textContent = !enough ? 'Waiting for at least 2 players' : (host ? 'Start the game' : 'Waiting for the host');

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

  function collectSettings() {
    var facs = [], kinds = [];
    Array.prototype.forEach.call(document.querySelectorAll('#factionChips .chip.on'), function (c) { facs.push(c.dataset.tag); });
    Array.prototype.forEach.call(document.querySelectorAll('#kindChips .chip.on'), function (c) { kinds.push(c.dataset.tag); });
    var hints = Number($('setHints').value);
    return {
      rounds: Number($('setRounds').value),
      drawTime: Number($('setTime').value),
      maxPlayers: Number($('setMax').value),
      wordChoices: Number($('setChoices').value),
      hints: hints > 0,
      hintCount: hints > 0 ? hints : 1,
      isPublic: $('setPublic').value === '1',
      customWords: $('setCustom').value,
      customWordsOnly: $('setCustomOnly').checked,
      factions: facs,
      kinds: kinds
    };
  }
  function pushSettings() { if (isHost()) send({ t: 'settings', settings: collectSettings() }); }
  ['setRounds', 'setTime', 'setMax', 'setChoices', 'setHints', 'setPublic', 'setCustomOnly'].forEach(function (id) {
    $(id).addEventListener('change', pushSettings);
  });
  $('setCustom').addEventListener('blur', pushSettings);
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
  $('settingsBtn').onclick = function () { lobbyHidden = false; renderOverlays(); renderLobby(); };
  $('closeLobby').onclick = function () { lobbyHidden = true; renderOverlays(); };
  $('closeGameEnd').onclick = function () { gameEndHidden = true; renderOverlays(); };
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !S) return;
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (S.state === 'lobby' && !lobbyHidden) { lobbyHidden = true; renderOverlays(); }
    else if (S.state === 'gameend' && !gameEndHidden) { gameEndHidden = true; renderOverlays(); }
  });
  $('leaveBtn').onclick = function () {
    if (!confirm('Leave the lobby?')) return;
    disconnect();
    location.href = '/';
  };

  /* --------- overlays --------- */
  function renderOverlays() {
    if (!S) return;
    if (S.state !== lastState) {
      if (S.state === 'lobby') lobbyHidden = false;
      lastState = S.state;
    }
    $('settingsBtn').classList.toggle('hide', S.state !== 'lobby');
    $('ovLobby').classList.toggle('hide', S.state !== 'lobby' || lobbyHidden);
    if (S.state !== 'choosing') $('ovChoose').classList.add('hide');
    if (S.state !== 'turnend') $('ovTurnEnd').classList.add('hide');
    if (S.state !== 'gameend') $('ovGameEnd').classList.add('hide');
    else $('ovGameEnd').classList.toggle('hide', gameEndHidden);
    if (S.state === 'choosing') {
      if (isDrawer() && S.choosing) showChoices(S.choosing, S.endsAt);
      else showWaitingChoice();
    }
  }
  function drawerName() {
    var d = (S.players || []).filter(function (p) { return p.id === S.drawerId; })[0];
    return d ? d.name : 'Someone';
  }
  function showChoices(list, endsAt) {
    $('chooseTitle').textContent = 'Choose a unit to draw';
    $('chooseSub').textContent = 'Everyone else is waiting.';
    var box = $('chooseList');
    box.innerHTML = '';
    (list || []).forEach(function (w, i) {
      var b = document.createElement('button');
      b.textContent = w;
      b.onclick = function () { send({ t: 'pick', index: i }); $('ovChoose').classList.add('hide'); };
      box.appendChild(b);
    });
    $('ovChoose').classList.remove('hide');
  }
  function showWaitingChoice() {
    $('chooseTitle').textContent = drawerName() + ' is choosing a unit';
    $('chooseSub').textContent = 'Get ready to guess.';
    $('chooseList').innerHTML = '';
    $('ovChoose').classList.remove('hide');
  }
  function showTurnEnd(m) {
    if (S) { S.state = 'turnend'; S.word = m.word; S.endsAt = m.endsAt; }
    $('ovChoose').classList.add('hide');
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
    gameEndHidden = false;
    if (S) { S.state = 'gameend'; S.endsAt = m.endsAt; }
    $('ovChoose').classList.add('hide');
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
  setInterval(function () {
    var el = $('timer');
    if (!S) { el.textContent = '-'; return; }
    if (S.state === 'lobby') { el.textContent = '-'; el.classList.remove('low'); return; }
    if (!S.endsAt) { el.innerHTML = '&#8734;'; el.classList.remove('low'); return; }
    var left = Math.max(0, Math.ceil((S.endsAt - now()) / 1000));
    el.textContent = left;
    el.classList.toggle('low', S.state === 'drawing' && left <= 10);
  }, 250);
  setInterval(function () { if (sock && sock.readyState === 1) send({ t: 'ping' }); }, 20000);

  /* ------------------------------------------------------------- home */
  function loadConfig() {
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
      cfg = c;
      $('dbLink').href = c.unitDb;
      $('dbLink2').href = c.unitDb;
      $('wordCount').textContent = c.words;
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
  if (urlCode) $('codeInput').value = urlCode;
  loadConfig();
  loadRooms();
  setInterval(loadRooms, 8000);
  if (urlCode && saved) doJoin();
  else $('nameInput').focus();
})();
