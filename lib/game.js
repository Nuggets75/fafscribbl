'use strict';
// Room + turn engine for fafscribbl.
const crypto = require('crypto');
const W = require('./words');
const { DEFAULT_SETTINGS, DEFAULT_FILTER_GROUPS } = require('./store');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CANVAS_W = 900;
const CANVAS_H = 560;
const MAX_OPS = 60000;
const TURN_END_MS = 6500;
const GAME_END_MS = 25000;
const RECONNECT_MS = 60000;
const CHAT_HISTORY = 120;
const MAX_NAME = 18;
const MAX_CHAT = 120;
const ROOM_IDLE_MS = 10 * 60 * 1000;
// How long an empty lobby is held open so a lone host can reload without losing it.
const EMPTY_ROOM_MS = Number(process.env.FAFSCRIBBL_EMPTY_MS || 60000);
const CTRL = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
// Timers that belong to the turn, and so stop when the host pauses. Housekeeping timers
// (per-player cleanup, the empty-lobby check) are deliberately not in here.
const PAUSABLE = ['choice', 'turn', 'hint', 'next', 'lobby'];

const COLORS = ['#e8622a', '#3fa7d6', '#6bbf59', '#d1495b', '#9b6bcf', '#e0b23a',
  '#4ecdc4', '#f06595', '#7f8fa6', '#c56a1a', '#5c8ae6', '#43b581'];


function rid(n) {
  let s = '';
  const b = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}
function token() { return crypto.randomBytes(18).toString('hex'); }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }

function sanitizeSettings(patch, base, groups) {
  const s = Object.assign({}, base || DEFAULT_SETTINGS);
  s.tagFilters = Object.assign({}, s.tagFilters || {});
  if (!patch || typeof patch !== 'object') return s;
  if ('rounds' in patch) s.rounds = clamp(Math.round(num(patch.rounds, s.rounds)), 1, 20);
  if ('drawTime' in patch) {
    const d = Math.round(num(patch.drawTime, s.drawTime));
    s.drawTime = d <= 0 ? 0 : clamp(d, 15, 600);
  }
  if ('maxPlayers' in patch) {
    const m = Math.round(num(patch.maxPlayers, s.maxPlayers));
    s.maxPlayers = m <= 0 ? 0 : clamp(m, 2, 60);
  }
  if ('hints' in patch) s.hints = !!patch.hints;
  if ('hintCount' in patch) s.hintCount = clamp(Math.round(num(patch.hintCount, s.hintCount)), 1, 5);
  if ('wordChoices' in patch) s.wordChoices = clamp(Math.round(num(patch.wordChoices, s.wordChoices)), 1, 5);
  if ('choiceTime' in patch) s.choiceTime = clamp(Math.round(num(patch.choiceTime, s.choiceTime)), 5, 60);
  if ('isPublic' in patch) s.isPublic = !!patch.isPublic;
  if ('customWords' in patch) s.customWords = String(patch.customWords || '').slice(0, 8000);
  if ('customWordsOnly' in patch) s.customWordsOnly = !!patch.customWordsOnly;
  if ('lookup' in patch) s.lookup = !!patch.lookup;
  if ('previews' in patch) s.previews = !!patch.previews;
  if ('tagFilters' in patch) {
    const list = Array.isArray(groups) && groups.length ? groups : DEFAULT_FILTER_GROUPS;
    const raw = (patch.tagFilters && typeof patch.tagFilters === 'object') ? patch.tagFilters : {};
    const out = {};
    for (const g of list) {
      const picked = Array.isArray(raw[g.id]) ? raw[g.id] : [];
      const keep = picked.map(String).filter((t) => g.tags.indexOf(t) !== -1);
      if (keep.length) out[g.id] = keep;
    }
    s.tagFilters = out;
  }
  return s;
}

function cleanName(raw) {
  let n = String(raw == null ? '' : raw).replace(CTRL, '').trim();
  n = n.replace(/\s+/g, ' ').slice(0, MAX_NAME);
  return n;
}

class Player {
  constructor(id, name, color) {
    this.id = id;
    this.token = token();
    this.name = name;
    this.color = color;
    this.score = 0;
    this.roundScore = 0;
    this.guessed = false;
    this.guessRank = 0;
    this.guessPts = 0;
    this.conn = null;
    this.connected = false;
    this.lastSeen = Date.now();
    this.dropAt = 0;
    this.chatStamps = [];
    this.drawStamps = 0;
    this.drawWindow = 0;
  }
}

class Room {
  constructor(mgr, code, settings) {
    this.mgr = mgr;
    this.code = code;
    this.createdAt = Date.now();
    this.touched = Date.now();
    this.settings = sanitizeSettings(settings, mgr.store.defaults(), mgr.store.filterGroups());
    this.players = new Map();
    this.order = [];
    this.hostId = null;
    this.state = 'lobby';
    this.round = 0;
    this.turnIndex = 0;
    this.drawerId = null;
    this.entry = null;
    this.choices = null;
    this.revealed = [];
    this.hintsLeft = 0;
    this.endsAt = 0;
    this.turnStartedAt = 0;
    this.ops = [];
    this.undoMarks = [];
    this.chat = [];
    this.usedIds = new Set();
    this.guessRank = 0;
    this.hintTotal = 0;
    this.paused = false;
    this.pausedAt = 0;
    this.pausedLeft = 0;
    this.frozen = null;
    this.timers = {};
  }

  clearTimer(name) {
    const t = this.timers[name];
    if (t) { clearTimeout(t.h); delete this.timers[name]; }
  }
  // Clears the timers that drive a turn. Housekeeping timers (per-player cleanup and the
  // empty-lobby timer) must survive, otherwise an abandoned lobby never tidies itself up.
  clearAllTimers() {
    Object.keys(this.timers).forEach((k) => {
      if (k.indexOf('gc:') === 0 || k === 'empty') return;
      this.clearTimer(k);
    });
    // Anything held by a pause is a turn timer too, so it goes with them. Otherwise a
    // resume would re-arm a timer belonging to a turn that is already over.
    this.frozen = null;
  }
  clearEveryTimer() { Object.keys(this.timers).forEach((k) => this.clearTimer(k)); }
  // Timers keep their callback and due time so pause() can freeze one with the time it had
  // left and put it back exactly where it was.
  setTimer(name, ms, fn) {
    this.clearTimer(name);
    ms = Math.max(0, ms);
    // A turn timer created while the game is paused is held straight away rather than armed,
    // so a turn that starts during a pause (the drawer left, say) is paused as well.
    if (this.paused && PAUSABLE.indexOf(name) !== -1) {
      this.frozen = this.frozen || {};
      this.frozen[name] = { fn: fn, left: ms };
      return;
    }
    const rec = { fn: fn, dueAt: Date.now() + ms, h: null };
    rec.h = setTimeout(() => {
      delete this.timers[name];
      try { fn(); } catch (e) { console.error('[room ' + this.code + '] timer ' + name, e); }
    }, ms);
    this.timers[name] = rec;
  }
  // While paused, everything that stamps a deadline uses the moment the pause began, so the
  // single shift applied on resume is correct for all of them.
  clock() { return this.paused ? this.pausedAt : Date.now(); }
  alive() { return Array.from(this.players.values()).filter((p) => p.connected); }
  isEmpty() { return this.alive().length === 0; }
  send(p, obj) { if (p && p.conn && !p.conn.dead) p.conn.sendJSON(obj); }
  broadcast(obj, filter) {
    const str = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (!p.conn || p.conn.dead) continue;
      if (filter && !filter(p)) continue;
      p.conn.send(str);
    }
  }

  playerView(p) {
    return {
      id: p.id, name: p.name, color: p.color, score: p.score,
      roundScore: p.roundScore, guessed: p.guessed, connected: p.connected,
      isHost: p.id === this.hostId, isDrawer: p.id === this.drawerId
    };
  }
  playersView() {
    return this.order.map((id) => this.players.get(id)).filter(Boolean).map((p) => this.playerView(p));
  }

  maskFor(p) {
    if (!this.entry) return '';
    if (this.canSeeWord(p)) return this.entry.word;
    return W.maskOf(this.entry.word, this.revealed);
  }
  canSeeWord(p) {
    if (!this.entry) return false;
    if (this.state === 'turnend' || this.state === 'gameend') return true;
    return p.id === this.drawerId || p.guessed;
  }

  stateFor(p) {
    return {
      t: 'state',
      now: Date.now(),
      code: this.code,
      state: this.state,
      round: this.round,
      rounds: this.settings.rounds,
      turnIndex: this.turnIndex,
      turnsPerRound: this.order.length,
      settings: this.settings,
      poolSize: this.pool().length,
      filterGroups: this.mgr.store.filterGroups(),
      tagCounts: this.mgr.store.tagCounts(),
      hostId: this.hostId,
      drawerId: this.drawerId,
      players: this.playersView(),
      you: p.id,
      endsAt: this.endsAt,
      paused: this.paused,
      pausedLeft: this.paused ? this.pausedLeft : 0,
      word: this.entry ? (this.canSeeWord(p) ? this.entry.word : null) : null,
      mask: this.entry ? this.maskFor(p) : '',
      choosing: this.state === 'choosing' ? (p.id === this.drawerId && this.choices ? this.choices.map((c) => c.word) : null) : null,
      choosingHints: this.state === 'choosing' ? (p.id === this.drawerId && this.choices ? this.choices.map((c) => c.hint || '') : null) : null,
      choosingIcons: (this.state === 'choosing' && this.settings.previews !== false)
        ? (p.id === this.drawerId && this.choices ? this.choices.map((c) => c.icon || '') : null) : null,
      wordIcon: (this.entry && this.state === 'drawing' && this.settings.previews !== false && this.canSeeWord(p))
        ? (this.entry.icon || '') : null,
      canvas: this.ops,
      chat: this.chat.filter((m) => this.chatVisible(m, p)).slice(-CHAT_HISTORY).map((m) => m.msg)
    };
  }
  pushState() { for (const p of this.players.values()) this.send(p, this.stateFor(p)); }
  pushPlayers() {
    this.broadcast({ t: 'players', players: this.playersView(), hostId: this.hostId, drawerId: this.drawerId });
  }

  chatVisible(rec, p) {
    if (rec.to === 'all') return true;
    if (rec.to === 'guessed') return p.guessed || p.id === this.drawerId;
    return rec.to === p.id;
  }
  pushChat(msg, to) {
    const rec = { to: to || 'all', msg: msg };
    this.chat.push(rec);
    if (this.chat.length > CHAT_HISTORY * 2) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    this.broadcast(msg, (p) => this.chatVisible(rec, p));
  }
  system(text, kind, to) {
    this.pushChat({ t: 'chat', kind: kind || 'sys', text: text }, to);
  }
  systemTo(id, text) {
    const p = this.players.get(id);
    if (p) this.send(p, { t: 'chat', kind: 'warn', text: text });
  }

  customEntries() {
    const raw = String(this.settings.customWords || '');
    const parts = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const p of parts) {
      const key = W.normalize(p);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ id: 'c:' + key, word: p.slice(0, 48), hint: 'custom word', aliases: [], tags: ['custom'], icon: '', custom: true });
    }
    return out.slice(0, 500);
  }
  // Tags are opt in and additive. A word is in the pool when it carries at least one
  // selected tag, so "naval" gives every naval unit and "land, easy maps" gives land units
  // plus those maps. Nothing selected means nothing is in play.
  selectedTags() {
    const groups = this.mgr.store.filterGroups();
    const tf = this.settings.tagFilters || {};
    const out = new Set();
    for (const g of groups) {
      for (const t of (tf[g.id] || [])) if (g.tags.indexOf(t) !== -1) out.add(t);
    }
    return out;
  }
  pool() {
    const custom = this.customEntries();
    if (this.settings.customWordsOnly && custom.length >= 1) return custom;
    const sel = this.selectedTags();
    if (!sel.size) return custom;
    const list = this.mgr.store.enabledWords().filter((w) => w.tags.some((t) => sel.has(t)));
    return list.concat(custom);
  }
  drawChoices(n) {
    const pool = this.pool();
    let avail = pool.filter((w) => !this.usedIds.has(w.id));
    if (avail.length < n) { this.usedIds.clear(); avail = pool.slice(); }
    if (!avail.length) return [];
    shuffle(avail);
    return avail.slice(0, Math.min(n, avail.length));
  }

  addPlayer(name, conn) {
    const used = new Set(Array.from(this.players.values()).map((p) => p.name.toLowerCase()));
    const base = cleanName(name) || 'Commander';
    let n = base, i = 2;
    while (used.has(n.toLowerCase())) { n = (base + ' (' + i + ')').slice(0, MAX_NAME + 4); i++; }
    const taken = new Set(Array.from(this.players.values()).map((p) => p.color));
    let free = COLORS.filter((c) => !taken.has(c));
    if (!free.length) free = COLORS;
    const color = free[crypto.randomInt(free.length)];
    const p = new Player(rid(10), n, color);
    p.conn = conn;
    p.connected = true;
    this.players.set(p.id, p);
    this.order.push(p.id);
    if (!this.hostId) this.hostId = p.id;
    this.clearTimer('empty');
    this.touched = Date.now();
    return p;
  }

  // An empty lobby drops itself shortly after the last player goes.
  scheduleEmptyCheck() {
    if (this.alive().length > 0) { this.clearTimer('empty'); return; }
    this.setTimer('empty', EMPTY_ROOM_MS, () => {
      if (this.alive().length === 0) this.mgr.drop(this);
    });
  }

  attach(p, conn) {
    // Point the player at the new socket BEFORE closing the old one, so the old
    // socket's close handler sees that it is stale and does not detach the player.
    const old = p.conn;
    p.conn = conn;
    p.connected = true;
    p.dropAt = 0;
    p.lastSeen = Date.now();
    this.touched = Date.now();
    this.clearTimer('gc:' + p.id);
    this.clearTimer('empty');
    if (old && old !== conn && !old.dead) old.close(4001, 'replaced');
  }

  detach(p, conn) {
    if (conn && p.conn && p.conn !== conn) return; // a stale socket closing
    if (!p.connected) return;
    p.connected = false;
    p.conn = null;
    p.dropAt = Date.now();
    this.touched = Date.now();
    this.system(p.name + ' left', 'leave');
    const wasDrawer = this.drawerId === p.id;
    this.rehost();
    this.pushPlayers();
    if (wasDrawer && (this.state === 'drawing' || this.state === 'choosing')) {
      this.system('The drawer left, skipping the turn', 'warn');
      this.endTurn('drawer-left');
    }
    this.setTimer('gc:' + p.id, RECONNECT_MS, () => this.reap(p.id));
    this.checkViability();
    this.scheduleEmptyCheck();
  }

  reap(id) {
    const p = this.players.get(id);
    if (!p || p.connected) return;
    this.players.delete(id);
    const i = this.order.indexOf(id);
    if (i !== -1) {
      this.order.splice(i, 1);
      if (i < this.turnIndex) this.turnIndex--;
    }
    this.rehost();
    this.pushPlayers();
    this.checkViability();
    if (this.players.size === 0) this.mgr.maybeDrop(this);
    else this.scheduleEmptyCheck();
  }

  rehost() {
    const host = this.players.get(this.hostId);
    if (host && host.connected) return;
    const next = this.order.map((id) => this.players.get(id)).find((p) => p && p.connected);
    this.hostId = next ? next.id : (host ? host.id : null);
  }

  kick(byId, targetId) {
    if (byId !== this.hostId || byId === targetId) return;
    const p = this.players.get(targetId);
    if (!p) return;
    this.system(p.name + ' was kicked by the host', 'warn');
    if (p.conn && !p.conn.dead) { this.send(p, { t: 'kicked' }); p.conn.close(4003, 'kicked'); }
    const wasDrawer = this.drawerId === p.id;
    p.connected = false; p.conn = null;
    this.reap(targetId);
    if (wasDrawer && (this.state === 'drawing' || this.state === 'choosing')) this.endTurn('drawer-left');
  }

  checkViability() {
    if (this.state === 'lobby' || this.state === 'gameend') return;
    if (this.alive().length < 2) {
      this.clearAllTimers();
      this.state = 'lobby';
      this.drawerId = null;
      this.entry = null;
      this.endsAt = 0;
      this.paused = false; this.pausedAt = 0; this.pausedLeft = 0; this.frozen = null;
      this.ops = []; this.undoMarks = [];
      this.system('Not enough players, back to the lobby', 'warn');
      this.pushState();
    }
  }

  start(byId) {
    if (byId !== this.hostId) return;
    if (this.state !== 'lobby' && this.state !== 'gameend') return;
    if (this.alive().length < 2) { this.systemTo(byId, 'You need at least 2 players to start'); return; }
    if (!this.pool().length) { this.systemTo(byId, 'The word list is empty, ask an admin'); return; }
    this.clearAllTimers();
    const connected = this.order.filter((id) => { const p = this.players.get(id); return p && p.connected; });
    const rest = this.order.filter((id) => connected.indexOf(id) === -1);
    this.order = shuffle(connected).concat(rest);
    for (const p of this.players.values()) { p.score = 0; p.roundScore = 0; p.guessed = false; }
    this.usedIds.clear();
    this.round = 1;
    this.turnIndex = 0;
    this.chat = [];
    this.system('Game started, ' + this.settings.rounds + ' round' + (this.settings.rounds > 1 ? 's' : ''), 'good');
    this.startTurn();
  }

  startTurn() {
    this.clearAllTimers();
    if (this.alive().length < 2) return this.checkViability();
    let drawer = null;
    while (this.turnIndex < this.order.length) {
      const cand = this.players.get(this.order[this.turnIndex]);
      if (cand && cand.connected) { drawer = cand; break; }
      this.turnIndex++;
    }
    if (!drawer) return this.nextRoundOrEnd();

    this.drawerId = drawer.id;
    this.entry = null;
    this.revealed = [];
    this.ops = [];
    this.undoMarks = [];
    this.guessRank = 0;
    this.endsAt = 0;
    for (const p of this.players.values()) { p.guessed = false; p.roundScore = 0; p.guessRank = 0; p.guessPts = 0; }

    const n = Math.max(1, this.settings.wordChoices);
    this.choices = this.drawChoices(n);
    if (!this.choices.length) {
      this.system('No words available, ask an admin', 'warn');
      this.state = 'lobby';
      return this.pushState();
    }

    this.state = 'choosing';
    if (this.settings.wordChoices === 1 || this.choices.length === 1) {
      this.pushState();
      return this.pick(drawer.id, 0);
    }
    this.endsAt = this.clock() + this.settings.choiceTime * 1000;
    this.pushState();
    this.send(drawer, {
      t: 'choices',
      words: this.choices.map((c) => c.word),
      hints: this.choices.map((c) => c.hint || ''),
      icons: this.settings.previews === false ? [] : this.choices.map((c) => c.icon || ''),
      endsAt: this.endsAt,
      now: Date.now()
    });
    this.setTimer('choice', this.settings.choiceTime * 1000 + 250, () => {
      if (this.state === 'choosing' && this.choices) this.pick(drawer.id, crypto.randomInt(this.choices.length), true);
    });
  }

  pick(byId, index, auto) {
    if (this.state !== 'choosing' || byId !== this.drawerId) return;
    const list = this.choices || [];
    const idx = clamp(Math.round(num(index, 0)), 0, Math.max(0, list.length - 1));
    const entry = list[idx];
    if (!entry) return;
    this.clearTimer('choice');
    this.entry = entry;
    this.usedIds.add(entry.id);
    this.choices = null;
    this.state = 'drawing';
    this.revealed = [];
    // The configured count is a floor. A long name gets one hint per five letters, so
    // "Stealth Field Generator" is not left with the same two letters as "Wasp".
    const letters = W.hideableIndexes(entry.word).length;
    this.hintTotal = this.settings.hints
      ? Math.max(this.settings.hintCount, Math.floor(letters / 5))
      : 0;
    this.hintsLeft = this.hintTotal;
    this.turnStartedAt = this.clock();
    this.endsAt = this.settings.drawTime > 0 ? this.clock() + this.settings.drawTime * 1000 : 0;
    this.ops = [];
    this.undoMarks = [];

    const drawer = this.players.get(this.drawerId);
    this.system((auto ? 'Out of time, ' : '') + (drawer ? drawer.name : 'Someone') + ' is drawing now', 'turn');
    this.pushState();
    if (this.settings.drawTime > 0) {
      this.setTimer('turn', this.settings.drawTime * 1000 + 200, () => this.endTurn('timeup'));
    }
    this.scheduleHints();
  }

  scheduleHints() {
    if (!this.settings.hints || this.hintsLeft <= 0) return;
    const total = Math.max(1, this.hintTotal || this.settings.hintCount);
    const done = total - this.hintsLeft;
    let delay;
    if (this.settings.drawTime > 0) {
      const slice = (this.settings.drawTime * 1000) / (total + 1);
      delay = (this.turnStartedAt + slice * (done + 1)) - this.clock();
    } else {
      delay = 45000;
    }
    this.setTimer('hint', Math.max(1000, delay), () => this.revealHint());
  }

  revealHint() {
    if (this.state !== 'drawing' || !this.entry || this.hintsLeft <= 0) return;
    const all = W.hideableIndexes(this.entry.word);
    const hidden = all.filter((i) => this.revealed.indexOf(i) === -1);
    const floor = Math.max(1, Math.ceil(all.length * 0.4));
    if (hidden.length <= floor) { this.hintsLeft = 0; return; }
    this.revealed.push(hidden[crypto.randomInt(hidden.length)]);
    this.hintsLeft--;
    for (const p of this.players.values()) this.send(p, { t: 'mask', mask: this.maskFor(p) });
    this.scheduleHints();
  }

  timeFrac() {
    if (this.settings.drawTime > 0) {
      const total = this.settings.drawTime * 1000;
      return clamp((this.endsAt - Date.now()) / total, 0, 1);
    }
    return clamp(1 - 0.15 * this.guessRank, 0.15, 1);
  }

  guessCorrect(p) {
    p.guessed = true;
    this.guessRank++;
    p.guessRank = this.guessRank;
    const pts = 50 + Math.round(350 * this.timeFrac());
    p.guessPts = pts;
    p.roundScore = pts;
    p.score += pts;
    this.send(p, {
      t: 'reveal',
      word: this.entry.word,
      icon: this.settings.previews === false ? '' : (this.entry.icon || '')
    });
    this.system(p.name + ' guessed the word', 'good');
    this.pushPlayers();
    const others = this.order.map((id) => this.players.get(id))
      .filter((x) => x && x.connected && x.id !== this.drawerId);
    if (others.length && others.every((x) => x.guessed)) {
      this.system('Everybody guessed it', 'good');
      this.endTurn('allguessed');
    }
  }

  handleChat(p, textRaw) {
    const now = Date.now();
    p.chatStamps = p.chatStamps.filter((t) => now - t < 4000);
    if (p.chatStamps.length >= 6) return;
    p.chatStamps.push(now);
    const text = String(textRaw == null ? '' : textRaw).replace(CTRL, '').trim().slice(0, MAX_CHAT);
    if (!text) return;

    // Nothing moves while the game is paused. If guesses were still checked, a player could
    // work the word out with the clock stopped and answer the instant it resumes.
    if (this.paused) {
      this.send(p, { t: 'chat', kind: 'warn', text: 'The game is paused. Chat and guesses are on hold.' });
      return;
    }

    if (this.state !== 'drawing' || !this.entry) {
      this.pushChat({ t: 'chat', kind: 'msg', from: p.name, color: p.color, text: text }, 'all');
      return;
    }
    if (p.id === this.drawerId) {
      if (W.leaks(text, this.entry)) {
        this.send(p, { t: 'chat', kind: 'warn', text: 'That gives the word away, not sent.' });
        return;
      }
      this.pushChat({ t: 'chat', kind: 'msg', from: p.name, color: p.color, text: text, drawer: true }, 'all');
      return;
    }
    if (p.guessed) {
      this.pushChat({ t: 'chat', kind: 'msg', from: p.name, color: p.color, text: text, guessed: true }, 'guessed');
      return;
    }
    const verdict = W.checkGuess(text, this.entry);
    if (verdict === 'exact') return this.guessCorrect(p);
    this.pushChat({ t: 'chat', kind: 'msg', from: p.name, color: p.color, text: text }, 'all');
    if (verdict === 'close') this.send(p, { t: 'chat', kind: 'close', text: '"' + text + '" is close!' });
  }

  // Look up a unit by its description. The search itself lives in Store.lookup so the single
  // player challenge gets exactly the same behaviour over HTTP.
  handleLookup(p, raw) {
    if (!this.settings.lookup) return this.send(p, { t: 'lookup', q: '', results: [], off: true });
    // The look-up is a guessing aid, so it stops with everything else.
    if (this.paused) return this.send(p, { t: 'lookup', q: '', results: [], paused: true });
    const now = Date.now();
    p.lookupStamps = (p.lookupStamps || []).filter((t) => now - t < 4000);
    if (p.lookupStamps.length >= 15) return;
    p.lookupStamps.push(now);
    const hit = this.mgr.store.lookup(raw);
    this.send(p, { t: 'lookup', q: hit.q, results: hit.results });
  }

  canDraw(p) { return this.state === 'drawing' && !this.paused && p.id === this.drawerId; }

  handleDraw(p, ops) {
    if (!this.canDraw(p) || !Array.isArray(ops)) return;
    const now = Date.now();
    if (now - p.drawWindow > 1000) { p.drawWindow = now; p.drawStamps = 0; }
    p.drawStamps += ops.length;
    if (p.drawStamps > 2000) return;
    const clean = [];
    for (const op of ops) {
      if (!Array.isArray(op) || !op.length) continue;
      if (op[0] === 's' && op.length === 7) {
        clean.push(['s',
          clamp(Math.round(num(op[1], 0)), -60, CANVAS_W + 60),
          clamp(Math.round(num(op[2], 0)), -60, CANVAS_H + 60),
          clamp(Math.round(num(op[3], 0)), -60, CANVAS_W + 60),
          clamp(Math.round(num(op[4], 0)), -60, CANVAS_H + 60),
          String(op[5]).slice(0, 9),
          clamp(Math.round(num(op[6], 4)), 1, 64)
        ]);
      } else if (op[0] === 'f' && op.length === 4) {
        clean.push(['f',
          clamp(Math.round(num(op[1], 0)), 0, CANVAS_W),
          clamp(Math.round(num(op[2], 0)), 0, CANVAS_H),
          String(op[3]).slice(0, 9)
        ]);
      }
    }
    if (!clean.length) return;
    if (this.ops.length + clean.length > MAX_OPS) return;
    for (const c of clean) this.ops.push(c);
    this.broadcast({ t: 'draw', ops: clean }, (x) => x.id !== p.id);
  }

  handleBegin(p) {
    if (!this.canDraw(p)) return;
    this.undoMarks.push(this.ops.length);
    if (this.undoMarks.length > 500) this.undoMarks.shift();
  }
  handleUndo(p) {
    if (!this.canDraw(p)) return;
    if (!this.undoMarks.length) return this.handleClear(p);
    const mark = this.undoMarks.pop();
    this.ops.length = Math.min(this.ops.length, mark);
    this.broadcast({ t: 'canvas', ops: this.ops });
  }
  handleClear(p) {
    if (!this.canDraw(p)) return;
    this.ops = [];
    this.undoMarks = [];
    this.broadcast({ t: 'canvas', ops: [] });
  }

  endTurn(reason) {
    if (this.state !== 'drawing' && this.state !== 'choosing') return;
    this.clearAllTimers();
    const entry = this.entry;
    const drawer = this.players.get(this.drawerId);
    const guessers = this.order.map((id) => this.players.get(id))
      .filter((x) => x && x.id !== this.drawerId && x.connected);
    const correct = guessers.filter((x) => x.guessed);

    if (drawer) {
      let drawerPts = 0;
      if (correct.length && guessers.length) {
        const avg = correct.reduce((n, x) => n + x.guessPts, 0) / correct.length;
        drawerPts = Math.round(avg * (correct.length / guessers.length));
      }
      drawer.roundScore = drawerPts;
      drawer.score += drawerPts;
    }

    // Keep the picture. Blank boards and lobby scratch are filtered out in the gallery.
    if (entry && !entry.custom && this.mgr.gallery) {
      try {
        this.mgr.gallery.save({
          word: entry.word,
          aliases: entry.aliases || [],
          hint: entry.hint || '',
          icon: entry.icon || '',
          drawer: drawer ? drawer.name : '',
          ops: this.ops
        });
      } catch (e) { console.error('[room ' + this.code + '] could not save the drawing', e.message); }
    }

    this.state = 'turnend';
    this.endsAt = this.clock() + TURN_END_MS;
    const results = this.order.map((id) => this.players.get(id)).filter(Boolean).map((p) => ({
      id: p.id, name: p.name, color: p.color, delta: p.roundScore, score: p.score, guessed: p.guessed
    }));
    this.broadcast({
      t: 'turnend',
      reason: reason || 'end',
      word: entry ? entry.word : '',
      icon: (entry && this.settings.previews !== false) ? (entry.icon || '') : '',
      drawerId: this.drawerId,
      results: results,
      endsAt: this.endsAt,
      now: Date.now()
    });
    if (entry) this.system('The word was: ' + entry.word, 'reveal');
    this.pushPlayers();
    this.setTimer('next', TURN_END_MS, () => this.nextTurn());
  }

  nextTurn() {
    this.entry = null;
    this.drawerId = null;
    this.turnIndex++;
    if (this.turnIndex >= this.order.length) return this.nextRoundOrEnd();
    if (this.alive().length < 2) return this.checkViability();
    this.startTurn();
  }

  nextRoundOrEnd() {
    this.turnIndex = 0;
    this.round++;
    if (this.round > this.settings.rounds) return this.endGame();
    this.system('Round ' + this.round + ' of ' + this.settings.rounds, 'turn');
    if (this.alive().length < 2) return this.checkViability();
    this.startTurn();
  }

  endGame() {
    this.clearAllTimers();
    this.state = 'gameend';
    this.drawerId = null;
    this.entry = null;
    this.endsAt = this.clock() + GAME_END_MS;
    const standings = this.order.map((id) => this.players.get(id)).filter(Boolean)
      .map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score }))
      .sort((a, b) => b.score - a.score);
    this.broadcast({ t: 'gameend', standings: standings, endsAt: this.endsAt, now: Date.now() });
    this.system('Game over', 'good');
    this.setTimer('lobby', GAME_END_MS, () => this.resetToLobby());
  }

  resetToLobby() {
    this.clearAllTimers();
    this.state = 'lobby';
    this.round = 0;
    this.turnIndex = 0;
    this.drawerId = null;
    this.entry = null;
    this.choices = null;
    this.endsAt = 0;
    this.paused = false;
    this.pausedAt = 0;
    this.pausedLeft = 0;
    this.frozen = null;
    this.ops = []; this.undoMarks = [];
    for (const p of this.players.values()) { p.guessed = false; p.roundScore = 0; }
    this.pushState();
  }

  updateSettings(byId, patch) {
    if (byId !== this.hostId) return;
    if (this.state !== 'lobby' && this.state !== 'gameend') return;
    this.settings = sanitizeSettings(patch, this.settings, this.mgr.store.filterGroups());
    this.broadcast({ t: 'settings', settings: this.settings, poolSize: this.pool().length });
  }

  backToLobby(byId) {
    if (byId !== this.hostId) return;
    this.resetToLobby();
  }

  // Host-only pause. Every timer that drives the turn is frozen with the time it had left
  // and put back untouched on resume, so a pause costs the drawer nothing.
  pause(byId, on) {
    if (byId !== this.hostId) return;
    const want = !!on;
    if (want === this.paused) return;
    if (this.state === 'lobby') return;
    if (want) {
      this.frozen = {};
      for (const name of PAUSABLE) {
        const t = this.timers[name];
        if (!t) continue;
        this.frozen[name] = { fn: t.fn, left: Math.max(0, t.dueAt - Date.now()) };
        clearTimeout(t.h);
        delete this.timers[name];
      }
      this.paused = true;
      this.pausedAt = Date.now();
      this.pausedLeft = this.endsAt ? Math.max(0, this.endsAt - this.pausedAt) : 0;
      this.system('The host paused the game', 'warn');
    } else {
      const delta = Date.now() - this.pausedAt;
      this.paused = false;
      // Everything that was measured from the wall clock moves forward by the pause.
      if (this.endsAt) this.endsAt += delta;
      if (this.turnStartedAt) this.turnStartedAt += delta;
      const frozen = this.frozen || {};
      this.frozen = null;
      for (const name of Object.keys(frozen)) this.setTimer(name, frozen[name].left, frozen[name].fn);
      this.system('The host resumed the game', 'good');
    }
    this.pushState();
  }

  skip(byId) {
    const p = this.players.get(byId);
    if (!p) return;
    if (this.state === 'drawing' && (byId === this.drawerId || byId === this.hostId)) this.endTurn('skipped');
    else if (this.state === 'choosing' && byId === this.hostId) this.endTurn('skipped');
  }
}

class RoomManager {
  constructor(store, gallery) {
    this.store = store;
    this.gallery = gallery || null;
    this.rooms = new Map();
    this.byToken = new Map();
    const iv = setInterval(() => this.sweep(), 60000);
    if (iv.unref) iv.unref();
  }
  newCode() {
    let c;
    do { c = rid(5); } while (this.rooms.has(c));
    return c;
  }
  create(settings) {
    const room = new Room(this, this.newCode(), settings);
    this.rooms.set(room.code, room);
    return room;
  }
  get(code) { return this.rooms.get(String(code == null ? '' : code).toUpperCase().trim()); }
  publicRooms() {
    return Array.from(this.rooms.values())
      .filter((r) => r.settings.isPublic && r.alive().length > 0 &&
        (!r.settings.maxPlayers || r.alive().length < r.settings.maxPlayers))
      .map((r) => ({
        code: r.code, players: r.alive().length, max: r.settings.maxPlayers,
        state: r.state, rounds: r.settings.rounds, drawTime: r.settings.drawTime
      }))
      .sort((a, b) => b.players - a.players)
      .slice(0, 30);
  }
  adminView() {
    return Array.from(this.rooms.values()).map((r) => ({
      code: r.code, players: r.players.size, online: r.alive().length,
      state: r.state, round: r.state === 'lobby' ? 0 : r.round, rounds: r.settings.rounds,
      isPublic: r.settings.isPublic, createdAt: r.createdAt,
      names: Array.from(r.players.values()).map((p) => p.name),
      word: r.entry ? r.entry.word : null
    })).sort((a, b) => b.online - a.online);
  }
  close(code) {
    const r = this.get(code);
    if (!r) return false;
    r.broadcast({ t: 'closed' });
    for (const p of r.players.values()) if (p.conn) p.conn.close(4004, 'closed');
    this.drop(r);
    return true;
  }
  drop(room) {
    room.clearEveryTimer();
    this.rooms.delete(room.code);
    for (const [tk, v] of this.byToken) if (v.code === room.code) this.byToken.delete(tk);
  }
  maybeDrop(room) { if (room.players.size === 0) this.drop(room); }
  sweep() {
    const now = Date.now();
    for (const room of Array.from(this.rooms.values())) {
      if (room.alive().length === 0 && now - room.touched > ROOM_IDLE_MS) this.drop(room);
    }
  }
  register(room, player) { this.byToken.set(player.token, { code: room.code, playerId: player.id }); }
  resolve(tk) {
    const v = this.byToken.get(tk);
    if (!v) return null;
    const room = this.rooms.get(v.code);
    if (!room) { this.byToken.delete(tk); return null; }
    const p = room.players.get(v.playerId);
    if (!p) { this.byToken.delete(tk); return null; }
    return { room: room, player: p };
  }
}

module.exports = {
  RoomManager, Room, sanitizeSettings, cleanName,
  CANVAS_W, CANVAS_H, COLORS
};
