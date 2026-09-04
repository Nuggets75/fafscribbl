(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().then(function (j) { j.__status = r.status; return j; }); });
  }
  function toast(msg) {
    var w = $('toasts'); if (!w) return;
    var d = document.createElement('div');
    d.className = 'toast'; d.textContent = msg;
    w.appendChild(d);
    setTimeout(function () { d.remove(); }, 4000);
  }
  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); }
    catch (e) { return null; }
  }

  /* ------------------------------------------------------------- canvas */
  var LW = 900, LH = 560;
  var cv = $('soloCanvas');
  var ctx = cv.getContext('2d', { willReadFrequently: true });

  function clearBoard() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, LW, LH);
  }
  function hexToRgb(h) {
    var s = String(h || '#000000').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // Same flood fill the drawing board uses, so a replay looks like what was drawn.
  function floodFill(x, y, color) {
    x = Math.max(0, Math.min(LW - 1, Math.round(x)));
    y = Math.max(0, Math.min(LH - 1, Math.round(y)));
    var img = ctx.getImageData(0, 0, LW, LH);
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
    ctx.putImageData(img, 0, 0);
  }
  function applyOp(op) {
    if (!op || !op.length) return;
    if (op[0] === 's') {
      ctx.strokeStyle = op[5];
      ctx.lineWidth = op[6];
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(op[1], op[2]);
      ctx.lineTo(op[3], op[4]);
      ctx.stroke();
    } else if (op[0] === 'f') {
      floodFill(op[1], op[2], op[3]);
    }
  }

  /* -------------------------------------------------------------- sound */
  // The game page stores the volume as 0-100 under the same key; keep them in step.
  var actx = null, sndOn = ls('fs_snd') !== '0';
  var stored = ls('fs_vol');
  var vol = stored === null ? 0.6 : Math.max(0, Math.min(1, Number(stored) / 100));
  if (!isFinite(vol)) vol = 0.6;
  function audio() {
    if (actx) return actx;
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; }
    return actx;
  }
  function tone(freq, at, len, shape, gain) {
    if (!sndOn) return;
    var a = audio(); if (!a) return;
    if (a.state === 'suspended') { try { a.resume(); } catch (e) { /* ignore */ } }
    var o = a.createOscillator(), g = a.createGain();
    o.type = shape || 'sine';
    o.frequency.value = freq;
    var t0 = a.currentTime + (at || 0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, (gain || 0.4) * vol), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (len || 0.15));
    o.connect(g); g.connect(a.destination);
    o.start(t0); o.stop(t0 + (len || 0.15) + 0.03);
  }
  var SFX = {
    right: function () { tone(784, 0, 0.11, 'sine', 0.5); tone(1175, 0.09, 0.16, 'sine', 0.45); },
    wrong: function () { tone(392, 0, 0.14, 'triangle', 0.35); tone(294, 0.13, 0.2, 'triangle', 0.35); },
    tick: function (n) { tone(n <= 1 ? 1100 : 880, 0, 0.1, 'square', 0.32); },
    mark: function () { tone(700, 0, 0.14, 'sine', 0.4); },
    done: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, i * 0.11, 0.22, 'triangle', 0.42); }); }
  };
  document.addEventListener('pointerdown', function () { audio(); }, { once: true });

  /* --------------------------------------------------------------- run */
  var sid = null;
  var run = null;           // { ops, endsAt, replayMs, index, total }
  var skew = 0;             // server clock minus ours
  var raf = null, clockIv = null, hintTimers = [];
  var beeped = {};
  var busy = false;
  var marks = [];           // per drawing: 'got' | 'miss' | 'now'

  function now() { return Date.now() + skew; }

  function stopRound() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (clockIv) { clearInterval(clockIv); clockIv = null; }
    hintTimers.forEach(clearTimeout);
    hintTimers = [];
  }

  function show(which) {
    ['soloStart', 'soloPlay', 'soloDone'].forEach(function (id) {
      $(id).classList.toggle('hide', id !== which);
    });
    $('hud').classList.toggle('hide', which !== 'soloPlay');
    $('headRight').classList.toggle('hide', which === 'soloPlay');
    showLookupPanel(which === 'soloPlay');
  }

  function renderProg() {
    var n = run ? run.total : 10;
    var html = '';
    for (var i = 0; i < n; i++) html += '<i class="' + (marks[i] || '') + '"></i>';
    $('prog').innerHTML = html;
  }

  function startRound(r) {
    stopRound();
    run = r;
    skew = (r.now || Date.now()) - Date.now();
    beeped = {};
    $('hudRound').textContent = r.index + '/' + r.total;
    $('hudScore').textContent = r.score;
    $('soloMask').textContent = r.mask;
    $('verdict').textContent = '';
    $('verdict').className = 'soloverdict';
    $('guessInput').value = '';
    $('guessInput').disabled = false;
    $('flash').classList.add('hide');
    marks[r.index - 1] = 'now';
    renderProg();
    clearBoard();
    try { $('guessInput').focus(); } catch (e) { /* ignore */ }

    // Replay the strokes over replayMs so it feels like watching somebody draw.
    var ops = r.ops || [];
    var t0 = performance.now();
    var at = 0;
    var span = Math.max(1, r.replayMs || 10000);
    function step() {
      var frac = (performance.now() - t0) / span;
      var want = frac >= 1 ? ops.length : Math.floor(frac * ops.length);
      while (at < want) { applyOp(ops[at]); at++; }
      if (at < ops.length) raf = requestAnimationFrame(step); else raf = null;
    }
    raf = requestAnimationFrame(step);

    // Clock
    tickClock();
    clockIv = setInterval(tickClock, 200);

    // Letters appear at the halfway mark and again near the end. Asking the server
    // for them at exactly those moments beats polling it twenty times a round.
    var left = r.endsAt - now();
    [0.5, 0.25].forEach(function (f) {
      var wait = left - (left * f);
      if (wait > 0) hintTimers.push(setTimeout(askHint, wait + 120));
    });
  }

  function tickClock() {
    if (!run) return;
    var left = Math.max(0, Math.ceil((run.endsAt - now()) / 1000));
    var el = $('soloClock');
    el.textContent = String(left);
    el.classList.toggle('low', left <= 10);
    if (!beeped[left]) {
      beeped[left] = true;
      if (left === 30 || left === 20) SFX.mark();
      else if (left <= 5 && left >= 1) SFX.tick(left);
    }
    if (left <= 0) {
      stopRound();
      if (!busy) {
        busy = true;
        post('/api/solo/timeup', { sid: sid }).then(function (r) { afterRound(r, false); });
      }
    }
  }

  function askHint() {
    if (!sid || !run) return;
    post('/api/solo/hint', { sid: sid }).then(function (r) {
      if (r && r.mask && run) $('soloMask').textContent = r.mask;
    }).catch(function () { /* ignore */ });
  }

  // Between drawings: show the answer, then ask for the next one. The next clock
  // only starts when we ask, so this pause is free.
  function afterRound(r, got) {
    stopRound();
    marks[(run ? run.index : 1) - 1] = got ? 'got' : 'miss';
    renderProg();
    $('guessInput').disabled = true;
    $('hudScore').textContent = r.total !== undefined ? r.total : $('hudScore').textContent;
    $('flashWord').textContent = r.word || '';
    $('flashPts').textContent = got ? '+' + r.points + ' points' : 'No points';
    $('flashPts').className = 'pts' + (got ? '' : ' zero');
    var img = $('flashIcon');
    if (r.icon) { img.src = '/icons/' + r.icon; img.classList.remove('hide'); }
    else { img.classList.add('hide'); img.removeAttribute('src'); }
    $('flash').classList.remove('hide');
    if (got) SFX.right(); else SFX.wrong();
    setTimeout(function () {
      post('/api/solo/next', { sid: sid }).then(function (n) {
        busy = false;
        if (n.done) return finishRun();
        startRound(n);
      });
    }, got ? 2000 : 2800);
  }

  function finishRun() {
    stopRound();
    run = null;
    post('/api/solo/finish', { sid: sid, name: $('soloName').value }).then(function (r) {
      SFX.done();
      $('finalScore').textContent = r.score;
      $('finalRank').textContent = r.rank ? '  -  rank #' + r.rank + ' on the global board' : '';
      $('recap').innerHTML = (r.results || []).map(function (x) {
        return '<div class="' + (x.got ? 'got' : '') + '"><b>' + esc(x.word) + '</b>' +
          (x.got ? '+' + x.points : 'missed') + '</div>';
      }).join('');
      fillScores($('hsBody2'), r.best, r.rank);
      show('soloDone');
    });
  }

  /* ------------------------------------------------------ unit look-up */
  // The same aid the lobby gives you. The server searches notes and tags only, so this can
  // never hand back the answer to the drawing on screen.
  var lkTimer = null;
  // The look-up only exists while a run is on: there is nothing to look up on the start
  // screen or the scoreboard.
  function showLookupPanel(on) {
    $('lookup').classList.toggle('hide', !on);
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
    var box = $('lkResults');
    if (!q) {
      box.innerHTML = '<p class="lkhint">Describe a unit and this finds its name. Order does not matter.</p>';
      return;
    }
    if (!sid) return;
    post('/api/solo/lookup', { sid: sid, q: q }).then(function (r) {
      if (r.busy) return;
      if ($('lkInput').value.trim() !== r.q) return;
      if (!r.results || !r.results.length) {
        box.innerHTML = '<p class="lkhint">Nothing matches all of those words.</p>';
        return;
      }
      box.innerHTML = '';
      r.results.forEach(function (x) {
        var row = document.createElement('div');
        row.className = 'lkrow';
        if (x.icon) {
          var im = document.createElement('img');
          im.src = '/icons/' + x.icon;
          im.alt = '';
          row.appendChild(im);
        }
        var t = document.createElement('div');
        t.className = 't';
        var n = document.createElement('div');
        n.className = 'n';
        n.textContent = x.word;
        var h = document.createElement('div');
        h.className = 'h';
        h.textContent = x.hint || '';
        t.appendChild(n); t.appendChild(h);
        row.appendChild(t);
        box.appendChild(row);
      });
    }).catch(function () { /* ignore */ });
  }
  $('lkInput').addEventListener('input', function () {
    clearTimeout(lkTimer);
    lkTimer = setTimeout(runLookup, 180);
  });
  $('lkInput').addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(lkTimer); runLookup(); }
  });

  /* ---------------------------------------------------------- highscore */
  function fillScores(tb, best, mine) {
    best = best || [];
    tb.innerHTML = best.map(function (b, i) {
      var when = new Date(b.at);
      return '<tr class="' + (mine && mine === i + 1 ? 'you' : '') + '"><td class="r">' + (i + 1) + '</td>' +
        '<td>' + esc(b.name) + '</td>' +
        '<td class="r">' + b.got + '/' + b.rounds + '</td>' +
        '<td class="r"><b>' + b.score + '</b></td>' +
        '<td class="r hint">' + when.toLocaleDateString() + '</td></tr>';
    }).join('');
  }
  function loadScores() {
    fetch('/api/solo/highscores').then(function (r) { return r.json(); }).then(function (d) {
      $('poolCount').textContent = d.drawings;
      $('hsEmpty').classList.toggle('hide', !!(d.best && d.best.length));
      fillScores($('hsBody'), d.best, 0);
      if (d.drawings < 3) {
        $('startErr').textContent = 'There are not enough saved drawings yet. Play a few lobby rounds first and they will show up here.';
        $('startBtn').disabled = true;
      }
    }).catch(function () { /* offline */ });
  }

  /* ------------------------------------------------------------- events */
  $('soloName').value = ls('fs_name') || '';

  $('startBtn').onclick = function () {
    var name = $('soloName').value.trim();
    if (!name) { $('startErr').textContent = 'Pick a name first.'; return; }
    ls('fs_name', name);
    $('startErr').textContent = '';
    $('startBtn').disabled = true;
    audio();
    post('/api/solo/start', { name: name }).then(function (r) {
      $('startBtn').disabled = false;
      if (r.error) { $('startErr').textContent = r.error; return; }
      sid = r.sid;
      busy = false;
      marks = [];
      show('soloPlay');
      startRound(r);
    }).catch(function () {
      $('startBtn').disabled = false;
      $('startErr').textContent = 'Could not reach the server.';
    });
  };

  $('guessForm').onsubmit = function (e) {
    e.preventDefault();
    var g = $('guessInput').value.trim();
    if (!g || busy || !run) return;
    $('guessInput').value = '';
    post('/api/solo/guess', { sid: sid, guess: g }).then(function (r) {
      if (r.error) { toast(r.error); return; }
      if (r.result === 'exact') { busy = true; afterRound(r, true); return; }
      if (r.result === 'over') { busy = true; afterRound(r, false); return; }
      var v = $('verdict');
      if (r.result === 'close') { v.textContent = '"' + g + '" is close.'; v.className = 'soloverdict close'; }
      else { v.textContent = '"' + g + '" is not it.'; v.className = 'soloverdict bad'; }
    });
  };

  $('quitBtn').onclick = function () {
    if (!sid) return;
    stopRound();
    finishRun();
  };
  $('againBtn').onclick = function () {
    show('soloStart');
    loadScores();
  };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && $('soloStart').classList.contains('hide') === false) $('startBtn').click();
  });
  showLookupPanel(false);

  clearBoard();
  renderProg();
  loadScores();
})();
