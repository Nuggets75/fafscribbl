'use strict';
// Single player challenge. The answers never leave the server: the browser gets the
// strokes and a letter mask, and every guess is checked here, so a score is worth something.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const W = require('./words');

const ROUNDS = 10;
const ROUND_MS = 40000;        // time per drawing
const REPLAY_MS = 10000;       // how long the strokes take to appear
const SESSION_TTL = 20 * 60 * 1000;
const MAX_SCORES = 50;
const HINT_AT = [0.5, 0.25];   // fraction of the round left when a letter is revealed
const CTRL = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

class Solo {
  constructor(dataDir, gallery) {
    this.gallery = gallery;
    this.file = path.join(dataDir, 'highscores.json');
    this.scores = [];
    this.sessions = new Map();
    const iv = setInterval(() => this.sweep(), 60000);
    if (iv.unref) iv.unref();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.scores = Array.isArray(raw) ? raw : [];
    } catch (e) { this.scores = []; }
    return this.scores.length;
  }

  saveScores() {
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.scores, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[solo] could not save highscores', e.message); }
  }

  sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.touched > SESSION_TTL) this.sessions.delete(id);
  }

  start(name) {
    const ids = this.gallery.pick(ROUNDS);
    if (ids.length < 3) return null;   // not enough material to make a run of it
    const sid = crypto.randomBytes(18).toString('hex');
    const s = {
      id: sid,
      name: String(name || '').slice(0, 18),
      ids: ids,
      at: 0,
      score: 0,
      results: [],
      startedAt: 0,
      hintsGiven: 0,
      revealed: [],
      current: null,
      touched: Date.now(),
      done: false
    };
    this.sessions.set(sid, s);
    return s;
  }

  get(sid) {
    const s = this.sessions.get(String(sid || ''));
    if (!s) return null;
    s.touched = Date.now();
    return s;
  }

  // What the browser is allowed to know about the current drawing.
  round(s) {
    if (s.done || s.at >= s.ids.length) return { done: true, score: s.score, results: s.results };
    const d = this.gallery.get(s.ids[s.at]);
    if (!d) { s.ids.splice(s.at, 1); return this.round(s); }
    s.current = d;
    s.revealed = [];
    s.hintsGiven = 0;
    s.startedAt = Date.now();
    return {
      done: false,
      index: s.at + 1,
      total: s.ids.length,
      score: s.score,
      ops: d.ops,
      mask: W.maskOf(d.word, []),
      endsAt: s.startedAt + ROUND_MS,
      replayMs: REPLAY_MS,
      now: Date.now()
    };
  }

  fraction(s) {
    const left = (s.startedAt + ROUND_MS) - Date.now();
    return clamp(left / ROUND_MS, 0, 1);
  }

  guess(s, text) {
    if (s.done || !s.current) return { result: 'no' };
    if (Date.now() > s.startedAt + ROUND_MS + 1500) return this.timeUp(s);
    const verdict = W.checkGuess(text, s.current);
    if (verdict !== 'exact') return { result: verdict };
    const points = 50 + Math.round(350 * this.fraction(s));
    s.score += points;
    const d = s.current;
    s.results.push({ word: d.word, icon: d.icon || '', points: points, got: true });
    s.at++;
    s.current = null;   // the round is over; a second guess must not score twice
    return { result: 'exact', points: points, word: d.word, icon: d.icon || '', total: s.score };
  }

  timeUp(s) {
    if (s.done || !s.current) return { result: 'over' };
    const d = s.current;
    s.results.push({ word: d.word, icon: d.icon || '', points: 0, got: false });
    s.at++;
    s.current = null;
    return { result: 'over', points: 0, word: d.word, icon: d.icon || '', total: s.score };
  }

  hint(s) {
    if (!s.current) return { mask: '' };
    const frac = this.fraction(s);
    let want = 0;
    for (const at of HINT_AT) if (frac <= at) want++;
    const all = W.hideableIndexes(s.current.word);
    const floor = Math.max(1, Math.ceil(all.length * 0.4));
    while (s.hintsGiven < want) {
      const hidden = all.filter((i) => s.revealed.indexOf(i) === -1);
      if (hidden.length <= floor) break;
      s.revealed.push(hidden[crypto.randomInt(hidden.length)]);
      s.hintsGiven++;
    }
    return { mask: W.maskOf(s.current.word, s.revealed) };
  }

  finish(s, name) {
    if (s.done) return this.rankOf(s);
    s.done = true;
    s.name = String(name || s.name || 'Anonymous').replace(CTRL, '').trim().slice(0, 18) || 'Anonymous';
    const entry = {
      name: s.name,
      score: s.score,
      rounds: s.results.length,
      got: s.results.filter((r) => r.got).length,
      at: Date.now()
    };
    if (s.score > 0) {
      this.scores.push(entry);
      this.scores.sort((a, b) => b.score - a.score || a.at - b.at);
      this.scores = this.scores.slice(0, MAX_SCORES);
      this.saveScores();
      s.entry = entry;
    }
    return this.rankOf(s, entry);
  }

  rankOf(s, entry) {
    const e = entry || s.entry;
    const rank = e ? this.scores.indexOf(e) + 1 : 0;
    return {
      score: s.score,
      results: s.results,
      rank: rank > 0 ? rank : null,
      best: this.scores.slice(0, 20)
    };
  }

  top(n) { return this.scores.slice(0, n || 20); }
}

module.exports = { Solo, ROUNDS, ROUND_MS, REPLAY_MS };
