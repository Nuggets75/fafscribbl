'use strict';
/* fafscribbl end to end tests. Needs a node with a global WebSocket client (node 22+). */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9100 + Math.floor(Math.random() * 700);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fafscribbl-'));
const PW = 'test-pw-123';
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name); }
}
function eq(a, b, name) { ok(a === b, name + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (typeof WebSocket !== 'function') {
  console.error('This test needs node 22+ (global WebSocket client).');
  process.exit(2);
}

class C {
  constructor(tag) {
    this.tag = tag;
    this.msgs = [];
    this.closed = false;
    this.ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws error ' + tag)));
    });
    this.ws.addEventListener('message', (e) => { this.msgs.push(JSON.parse(e.data)); });
    this.ws.addEventListener('close', () => { this.closed = true; });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.close(); } catch (e) {} }
  find(pred) { for (let i = this.msgs.length - 1; i >= 0; i--) if (pred(this.msgs[i])) return this.msgs[i]; return null; }
  all(pred) { return this.msgs.filter(pred); }
  clear() { this.msgs = []; }
  async wait(pred, ms) {
    ms = ms || 6000;
    const t0 = Date.now();
    for (;;) {
      const m = this.find(pred);
      if (m) return m;
      if (Date.now() - t0 > ms) throw new Error('[' + this.tag + '] timeout waiting for message');
      await sleep(25);
    }
  }
  state() { return this.find((m) => m.t === 'state'); }
}

async function api(pathname, opts, token) {
  opts = opts || {};
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (token) opts.headers['x-admin-token'] = token;
  const r = await fetch(BASE + pathname, opts);
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: DATA, ADMIN_PASSWORD: PW, FAFSCRIBBL_EMPTY_MS: '2000' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });

  const stop = () => { try { srv.kill('SIGKILL'); } catch (e) {} };
  process.on('exit', stop);

  // wait for boot
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch (e) { /* retry */ }
    await sleep(100);
  }

  try {
    await httpTests();
    await adminTests();
    await gameTests();
    await edgeTests();
    await extraTests();
  } catch (e) {
    fail++;
    failures.push('threw: ' + e.message);
    console.log('  FAIL exception: ' + e.stack);
  }

  stop();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) {
    console.log('\nfailures:\n - ' + failures.join('\n - '));
    console.log('\nserver log:\n' + log.slice(-3000));
    process.exit(1);
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ http */
async function httpTests() {
  console.log('\nHTTP');
  const h = await api('/api/health');
  eq(h.status, 200, 'health responds');
  const c = await api('/api/config');
  eq(c.status, 200, 'config responds');
  ok(c.body.words > 200, 'seed word list loaded (' + c.body.words + ' enabled)');
  ok(c.body.unitDb.indexOf('etfreeman') !== -1, 'unit db link is served');
  const idx = await fetch(BASE + '/');
  eq(idx.status, 200, 'index served');
  const room = await fetch(BASE + '/r/ABCDE');
  eq(room.status, 200, 'room deep link serves the app');
  const adm = await fetch(BASE + '/admin');
  eq(adm.status, 200, 'admin page served');
  const trav = await fetch(BASE + '/../server.js');
  ok(trav.status === 404 || trav.status === 403, 'directory traversal blocked');
  const missing = await fetch(BASE + '/nope.js');
  eq(missing.status, 404, 'unknown file 404s');
}

/* ----------------------------------------------------------------- admin */
let adminToken = null;
async function adminTests() {
  console.log('\nAdmin API');
  const bad = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }) });
  eq(bad.status, 401, 'wrong password rejected');
  const noauth = await api('/api/admin/state');
  eq(noauth.status, 401, 'admin state needs a token');
  const good = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: PW }) });
  eq(good.status, 200, 'correct password accepted');
  adminToken = good.body.token;
  ok(!!adminToken, 'token issued');

  const st = await api('/api/admin/state', {}, adminToken);
  eq(st.status, 200, 'admin state readable');
  const total = st.body.words.length;
  ok(total > 250, 'word list has ' + total + ' entries');
  ok(st.body.words.some((w) => w.word === 'Percival' && /uef/i.test(w.hint + w.tags.join(' '))), 'Percival present with a note');
  ok(st.body.words.some((w) => w.word === 'UEF Land Factory'), 'factories collapsed per faction');
  ok(!st.body.words.some((w) => /T2 Mass Extractor|Mass Extractor 2/i.test(w.word)), 'no tech duplicated mass extractors');
  eq(st.body.words.filter((w) => /^Mass Extractor$/i.test(w.word)).length, 1, 'exactly one mass extractor');
  eq(st.body.words.filter((w) => /^Radar$/i.test(w.word)).length, 1, 'exactly one radar');
  eq(st.body.words.filter((w) => /^Quantum Gateway$/i.test(w.word)).length, 1, 'exactly one quantum gateway');
  eq(st.body.words.filter((w) => /^Point Defense$/i.test(w.word)).length, 1, 'exactly one T1 point defense');
  eq(st.body.words.filter((w) => /T2 Point Defense$/i.test(w.word)).length, 4, 'T2 point defense is per faction');
  eq(st.body.words.filter((w) => /Anti-Air$/i.test(w.word)).length, 12, 'anti air is per faction and tier');
  ok(st.body.words.filter((w) => w.tags.indexOf('nomads') !== -1).every((w) => !w.enabled), 'nomads shipped disabled');

  const add = await api('/api/admin/words', {
    method: 'POST',
    body: JSON.stringify({ word: 'Test Unit', hint: 'T9 test bot', aliases: ['Testy'], tags: ['test'] })
  }, adminToken);
  eq(add.status, 200, 'word added');
  const id = add.body.word.id;

  const edit = await api('/api/admin/words', {
    method: 'PUT', body: JSON.stringify({ id: id, hint: 'edited note', enabled: false })
  }, adminToken);
  eq(edit.body.word.hint, 'edited note', 'word edited');
  eq(edit.body.word.enabled, false, 'word disabled');

  const blank = await api('/api/admin/words', { method: 'PUT', body: JSON.stringify({ id: id, word: '  ' }) }, adminToken);
  eq(blank.status, 400, 'empty word rejected');

  const bulk = await api('/api/admin/words/bulk', {
    method: 'POST', body: JSON.stringify({ ids: [id], action: 'enable' })
  }, adminToken);
  eq(bulk.body.changed, 1, 'bulk enable works');

  const imp = await api('/api/admin/words/import', {
    method: 'POST',
    body: JSON.stringify({ text: 'Imported One | a note | alt one | test import\nImported Two\nPercival', mode: 'merge' })
  }, adminToken);
  eq(imp.body.added, 2, 'import added the new lines');
  eq(imp.body.skipped, 1, 'import skipped the duplicate');

  const del = await api('/api/admin/words', { method: 'DELETE', body: JSON.stringify({ ids: [id] }) }, adminToken);
  eq(del.body.removed, 1, 'word deleted');

  const exp = await fetch(BASE + '/api/admin/export', { headers: { 'x-admin-token': adminToken } });
  eq(exp.status, 200, 'export downloads');
  const expJson = await exp.json();
  ok(Array.isArray(expJson) && expJson.length >= total, 'export contains every word');


  // persistence: the store writes to disk
  await sleep(200);
  const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'fafscribbl.json'), 'utf8'));
  ok(raw.words.some((w) => w.word === 'Imported One'), 'changes persisted to disk');

  const re = await api('/api/admin/words/reseed', { method: 'POST' }, adminToken);
  eq(re.status, 404, 'the reset-to-shipped-list endpoint is gone');
  const replace = await api('/api/admin/words/import', {
    method: 'POST', body: JSON.stringify({ text: JSON.stringify(expJson), mode: 'replace' })
  }, adminToken);
  eq(replace.body.replaced, true, 'a full JSON export can be imported back as a replace');
  const after = await api('/api/admin/state', {}, adminToken);
  eq(after.body.words.length, expJson.length, 'restoring from an export gives the list back');

  const defs = await api('/api/admin/defaults', {
    method: 'POST', body: JSON.stringify({ rounds: 4, drawTime: 45, wordChoices: 2 })
  }, adminToken);
  eq(defs.body.defaults.rounds, 4, 'defaults saved');
  await api('/api/admin/defaults', { method: 'POST', body: JSON.stringify({ rounds: 3, drawTime: 80, wordChoices: 3 }) }, adminToken);
}

/* ------------------------------------------------------------------ game */
async function join(tag, opts) {
  const c = new C(tag);
  await c.ready;
  c.send(Object.assign({ t: 'hello', name: tag }, opts));
  const j = await c.wait((m) => m.t === 'joined' || m.t === 'error');
  if (j.t === 'error') throw new Error('join failed: ' + j.message);
  c.id = j.you;
  c.code = j.code;
  c.token = j.token;
  await c.wait((m) => m.t === 'state');
  return c;
}

async function gameTests() {
  console.log('\nGame flow');
  const host = await join('Host', { create: true, settings: { rounds: 1, drawTime: 20, choiceTime: 4, wordChoices: 3, hints: true, hintCount: 2 } });
  ok(!!host.code, 'lobby created with code ' + host.code);
  const a = await join('Alpha', { code: host.code });
  const b = await join('Bravo', { code: host.code });
  await sleep(120);
  eq(host.state().players.length, 3, 'three players in the lobby');
  eq(host.state().hostId, host.id, 'creator is the host');

  // non-host cannot change settings
  a.send({ t: 'settings', settings: { rounds: 9 } });
  await sleep(120);
  eq(host.find((m) => m.t === 'settings'), null, 'non host settings change ignored');
  host.send({ t: 'settings', settings: { rounds: 1, drawTime: 20 } });
  await sleep(120);
  ok(!!host.find((m) => m.t === 'settings'), 'host settings change accepted');

  // non-host cannot start
  a.send({ t: 'start' });
  await sleep(150);
  eq(host.state().state, 'lobby', 'non host cannot start the game');

  [host, a, b].forEach((c) => c.clear());
  host.send({ t: 'start' });

  const drawerState = await host.wait((m) => m.t === 'state' && m.state === 'choosing');
  const drawerId = drawerState.drawerId;
  const clients = { [host.id]: host, [a.id]: a, [b.id]: b };
  const drawer = clients[drawerId];
  const guessers = [host, a, b].filter((c) => c.id !== drawerId);
  ok(!!drawer, 'a drawer was chosen');

  const choices = await drawer.wait((m) => m.t === 'choices');
  eq(choices.words.length, 3, 'drawer got three word choices');
  eq(guessers[0].find((m) => m.t === 'choices'), null, 'guessers do not get the choices');
  const word = choices.words[0];

  drawer.send({ t: 'pick', index: 0 });
  await drawer.wait((m) => m.t === 'state' && m.state === 'drawing');
  const gs = await guessers[0].wait((m) => m.t === 'state' && m.state === 'drawing');
  eq(gs.word, null, 'guessers do not receive the word');
  ok(gs.mask.indexOf('_') !== -1, 'guessers get a masked word');
  eq(gs.mask.length, word.length, 'mask keeps the word length');
  const ds = drawer.find((m) => m.t === 'state' && m.state === 'drawing');
  eq(ds.word, word, 'drawer sees the word');

  // drawing is relayed to the others, and only from the drawer
  guessers[0].clear();
  drawer.send({ t: 'begin' });
  drawer.send({ t: 'draw', ops: [['s', 10, 10, 100, 100, '#000000', 8], ['s', 100, 100, 200, 50, '#000000', 8]] });
  const relay = await guessers[0].wait((m) => m.t === 'draw');
  eq(relay.ops.length, 2, 'draw ops relayed to guessers');
  guessers[1].clear();
  guessers[0].send({ t: 'draw', ops: [['s', 0, 0, 5, 5, '#ff0000', 8]] });
  await sleep(200);
  eq(guessers[1].find((m) => m.t === 'draw'), null, 'non drawer cannot draw');

  // undo and clear
  guessers[0].clear();
  drawer.send({ t: 'undo' });
  const undo = await guessers[0].wait((m) => m.t === 'canvas');
  eq(undo.ops.length, 0, 'undo removed the stroke');
  drawer.send({ t: 'begin' });
  drawer.send({ t: 'draw', ops: [['s', 1, 1, 2, 2, '#000000', 4]] });
  await sleep(120);
  guessers[0].clear();
  drawer.send({ t: 'clearCanvas' });
  const cl = await guessers[0].wait((m) => m.t === 'canvas');
  eq(cl.ops.length, 0, 'clear empties the canvas');

  // drawer cannot leak the word
  drawer.clear();
  drawer.send({ t: 'chat', text: 'it is ' + word });
  const warn = await drawer.wait((m) => m.t === 'chat' && m.kind === 'warn');
  ok(!!warn, 'drawer message containing the word is blocked');
  await sleep(150);
  eq(guessers[0].all((m) => m.t === 'chat' && m.text && m.text.indexOf(word) !== -1).length, 0, 'blocked message never reached the guessers');

  // a wrong guess is visible to everyone
  guessers[1].clear();
  guessers[0].send({ t: 'chat', text: 'zzzz nonsense' });
  const seen = await guessers[1].wait((m) => m.t === 'chat' && m.text === 'zzzz nonsense');
  ok(!!seen, 'wrong guesses are shown in the chat');

  // a nearly right guess is close, and only the sender is told
  const close = mutate(word);
  guessers[0].clear(); guessers[1].clear();
  guessers[0].send({ t: 'chat', text: close });
  const cm = await guessers[0].wait((m) => m.t === 'chat' && m.kind === 'close');
  ok(!!cm, 'one letter off gets a "close" reply: ' + cm.text);
  await sleep(150);
  eq(guessers[1].all((m) => m.t === 'chat' && m.kind === 'close').length, 0, 'the close hint is private');
  ok(guessers[1].all((m) => m.t === 'chat' && m.text === close).length === 1, 'the near miss itself is still shown to everyone');

  // a correct guess is hidden and scores
  guessers[1].clear(); guessers[0].clear();
  guessers[0].send({ t: 'chat', text: word.toUpperCase().replace(/ /g, '  ') });
  const rev = await guessers[0].wait((m) => m.t === 'reveal');
  eq(rev.word, word, 'correct guesser is shown the word');
  await sleep(200);
  eq(guessers[1].all((m) => m.t === 'chat' && m.text === word).length, 0, 'the correct guess itself is never shown');
  ok(!!guessers[1].find((m) => m.t === 'chat' && /guessed the word/.test(m.text || '')), 'others are told that someone guessed');
  const pv = await guessers[1].wait((m) => m.t === 'players');
  const scored = pv.players.find((p) => p.id === guessers[0].id);
  ok(scored.score > 0, 'guesser scored ' + scored.score);
  ok(scored.guessed, 'guesser flagged as guessed');

  // players who guessed talk only to each other and the drawer
  guessers[1].clear();
  guessers[0].send({ t: 'chat', text: 'secret talk' });
  await sleep(250);
  eq(guessers[1].all((m) => m.t === 'chat' && m.text === 'secret talk').length, 0, 'a guessed player is hidden from those still guessing');
  ok(!!drawer.find((m) => m.t === 'chat' && m.text === 'secret talk'), 'the drawer still sees it');

  // last guesser ends the turn
  guessers[1].send({ t: 'chat', text: word });
  const te = await drawer.wait((m) => m.t === 'turnend', 8000);
  eq(te.word, word, 'turn end reveals the word');
  ok(te.hint === undefined, 'the admin note is never sent to players');
  const drawerRow = te.results.find((r) => r.id === drawerId);
  ok(drawerRow.delta > 0, 'drawer scored ' + drawerRow.delta + ' when everyone guessed');

  // the game continues through every player then ends
  const ge = await host.wait((m) => m.t === 'gameend', 90000);
  eq(ge.standings.length, 3, 'final standings list everyone');
  ok(ge.standings[0].score >= ge.standings[1].score, 'standings sorted by score');

  host.send({ t: 'lobby' });
  const back = await host.wait((m) => m.t === 'state' && m.state === 'lobby', 4000);
  ok(!!back, 'host can send everyone back to the lobby');

  [host, a, b].forEach((c) => c.close());
  await sleep(200);
}

function mutate(word) {
  const letters = word.split('');
  for (let i = 0; i < letters.length; i++) {
    if (/[a-z]/i.test(letters[i])) {
      letters[i] = letters[i].toLowerCase() === 'q' ? 'w' : 'q';
      return letters.join('');
    }
  }
  return word + 'q';
}

/* ------------------------------------------------------------------ edge */
async function edgeTests() {
  console.log('\nEdge cases');

  // unknown lobby
  const c = new C('Ghost');
  await c.ready;
  c.send({ t: 'hello', name: 'Ghost', code: 'ZZZZZ' });
  const err = await c.wait((m) => m.t === 'error');
  eq(err.code, 'noroom', 'joining a dead lobby is refused');
  c.close();

  // max players
  const h = await join('Cap', { create: true, settings: { maxPlayers: 2, rounds: 1, drawTime: 20, choiceTime: 4 } });
  const p2 = await join('Second', { code: h.code });
  const p3 = new C('Third');
  await p3.ready;
  p3.send({ t: 'hello', name: 'Third', code: h.code });
  const full = await p3.wait((m) => m.t === 'error');
  eq(full.code, 'full', 'max players is enforced');
  p3.close();

  // duplicate names get numbered
  const dup = await join('Cap', { code: h.code + '' }).catch(() => null);
  if (dup) {
    await sleep(100);
    const names = h.state().players.map((p) => p.name);
    ok(names.filter((n) => n.indexOf('Cap') === 0).length >= 1, 'duplicate names handled');
    dup.close();
  }

  // kick
  h.send({ t: 'kick', id: p2.id });
  await p2.wait((m) => m.t === 'kicked', 3000);
  ok(true, 'host can kick a player');
  await sleep(200);

  // guest cannot kick the host
  const p4 = await join('Fourth', { code: h.code });
  p4.send({ t: 'kick', id: h.id });
  await sleep(200);
  ok(!h.find((m) => m.t === 'kicked'), 'a normal player cannot kick the host');

  // reconnect with the session token
  const tok = p4.token, code = p4.code, pid = p4.id;
  p4.close();
  await sleep(300);
  const p5 = new C('Fourth-again');
  await p5.ready;
  p5.send({ t: 'hello', name: 'Fourth', code: code, token: tok });
  const rj = await p5.wait((m) => m.t === 'joined');
  ok(rj.rejoined === true, 'reconnect with a token restores the session');
  eq(rj.you, pid, 'the same player id comes back');
  p5.close();
  h.close();
  await sleep(200);

  // word choices = 1 skips the picking step, and no timer works
  const s1 = await join('Solo', { create: true, settings: { wordChoices: 1, drawTime: 0, rounds: 1, hints: false } });
  const s2 = await join('Duo', { code: s1.code });
  await sleep(150);
  s1.send({ t: 'start' });
  const st = await s1.wait((m) => m.t === 'state' && m.state === 'drawing', 6000);
  eq(st.endsAt, 0, 'no timer when draw time is off');
  ok(!!st.mask || !!st.word, 'a word was assigned without a choice screen');
  const drawerIsS1 = st.drawerId === s1.id;
  const g = drawerIsS1 ? s2 : s1;
  const d = drawerIsS1 ? s1 : s2;
  const dw = d.find((m) => m.t === 'state' && m.state === 'drawing').word;
  ok(!!dw, 'drawer knows the assigned word');
  eq(g.find((m) => m.t === 'state' && m.state === 'drawing').word, null, 'guesser does not');
  ok(g.find((m) => m.t === 'state' && m.state === 'drawing').mask.indexOf('_') !== -1, 'hints off still masks the word');
  g.send({ t: 'chat', text: dw });
  await g.wait((m) => m.t === 'reveal', 4000);
  ok(true, 'guessing works with the timer off');

  // drawer leaving skips the turn
  const te = d.wait((m) => m.t === 'turnend', 6000).catch(() => null);
  d.close();
  const res = await te;
  ok(!!res, 'the turn ends when the drawer disconnects');
  g.close();
  await sleep(200);

  // one player alone cannot start
  const lone = await join('Lonely', { create: true });
  lone.send({ t: 'start' });
  await sleep(250);
  eq(lone.state().state, 'lobby', 'a single player cannot start a game');
  lone.close();

  // custom words only
  const q1 = await join('Cust', { create: true, settings: { customWords: 'Zebra\nQuokka', customWordsOnly: true, wordChoices: 1, drawTime: 0, rounds: 1 } });
  const q2 = await join('Cust2', { code: q1.code });
  await sleep(150);
  q1.send({ t: 'start' });
  const cst = await q1.wait((m) => m.t === 'state' && m.state === 'drawing', 6000);
  const cd = cst.drawerId === q1.id ? q1 : q2;
  const cw = cd.find((m) => m.t === 'state' && m.state === 'drawing').word;
  ok(cw === 'Zebra' || cw === 'Quokka', 'custom words only pool used, got ' + cw);
  q1.close(); q2.close();

  // faction filter
  const f1 = await join('Fac', { create: true, settings: { factions: ['seraphim'], kinds: ['air'], wordChoices: 1, drawTime: 0, rounds: 1 } });
  const f2 = await join('Fac2', { code: f1.code });
  await sleep(150);
  f1.send({ t: 'start' });
  const fst = await f1.wait((m) => m.t === 'state' && m.state === 'drawing', 6000);
  const fd = fst.drawerId === f1.id ? f1 : f2;
  const fw = fd.find((m) => m.t === 'state' && m.state === 'drawing').word;
  const stAll = await api('/api/admin/state', {}, adminToken);
  const entry = stAll.body.words.find((w) => w.word === fw);
  ok(entry && entry.tags.indexOf('air') !== -1 &&
    (entry.tags.indexOf('seraphim') !== -1 || entry.tags.indexOf('neutral') !== -1),
    'faction and type filter respected, got ' + fw + ' [' + (entry ? entry.tags.join(' ') : '?') + ']');
  f1.close(); f2.close();
  await sleep(200);
}


/* ------------------------------------------------------------ extra edge */
async function extraTests() {
  console.log('\nHints, names and hot reconnect');

  // letter hints appear over time
  const h1 = await join('Hinty', { create: true, settings: { wordChoices: 1, drawTime: 16, hints: true, hintCount: 2, rounds: 1 } });
  const h2 = await join('Hinty2', { code: h1.code });
  await sleep(150);
  h1.send({ t: 'start' });
  const hs = await h1.wait((m) => m.t === 'state' && m.state === 'drawing', 6000);
  const hg = hs.drawerId === h1.id ? h2 : h1;
  const first = hg.find((m) => m.t === 'state' && m.state === 'drawing').mask;
  const hidden = (s) => (s.match(/_/g) || []).length;
  const m1 = await hg.wait((m) => m.t === 'mask', 12000);
  ok(hidden(m1.mask) < hidden(first), 'a letter is revealed as the timer runs down');
  const m2 = await hg.wait((m) => m.t === 'mask' && hidden(m.mask) < hidden(m1.mask), 12000);
  ok(!!m2, 'a second letter is revealed');
  ok(hidden(m2.mask) > 0, 'the word is never fully revealed by hints');
  h1.close(); h2.close();
  await sleep(200);

  // duplicate names are made unique
  const n1 = await join('Same', { create: true });
  const n2 = await join('Same', { code: n1.code });
  await sleep(200);
  const names = n1.state().players.map((p) => p.name);
  eq(new Set(names).size, names.length, 'duplicate names are made unique: ' + names.join(', '));

  // opening a second socket for the same session does not drop the player
  const tok = n2.token;
  const again = new C('Same-2nd-tab');
  await again.ready;
  again.send({ t: 'hello', name: 'Same', code: n1.code, token: tok });
  await again.wait((m) => m.t === 'joined');
  await sleep(400);
  const st2 = n1.state();
  const still = st2.players.find((p) => p.id === n2.id);
  ok(still && still.connected, 'replacing a socket keeps the player connected');
  eq(st2.players.length, 2, 'no ghost player was created');
  again.close(); n1.close(); n2.close();
  await sleep(200);

  // a faction filter keeps the faction-less words and nothing from other factions
  const ff1 = await join('Filt', { create: true, settings: { factions: ['uef'], wordChoices: 5, drawTime: 0, rounds: 1 } });
  const ff2 = await join('Filt2', { code: ff1.code });
  await sleep(150);
  ff1.send({ t: 'start' });
  await ff1.wait((m) => m.t === 'state' && m.state === 'choosing', 6000);
  const offered = (await (ff1.find((m) => m.t === 'choices') ? ff1 : ff2).wait((m) => m.t === 'choices', 4000)).words;
  const all = (await api('/api/admin/state', {}, adminToken)).body.words;
  const tagsOf = (w) => (all.find((x) => x.word === w) || { tags: [] }).tags;
  const bad = offered.filter((w) => {
    const t = tagsOf(w);
    return t.indexOf('uef') === -1 && t.indexOf('neutral') === -1;
  });
  eq(bad.length, 0, 'a uef filter offers only uef and faction-less words: ' + offered.join(', '));
  ff1.close(); ff2.close();
  await sleep(200);

  // an abandoned lobby closes itself
  const e1 = await join('Leaver', { create: true });
  const e2 = await join('Leaver2', { code: e1.code });
  const deadCode = e1.code;
  await sleep(150);
  ok((await api('/api/admin/state', {}, adminToken)).body.rooms.some((r) => r.code === deadCode), 'the lobby is listed while it has players');
  e1.close(); e2.close();
  await sleep(3500);
  const list = (await api('/api/admin/state', {}, adminToken)).body.rooms;
  ok(!list.some((r) => r.code === deadCode), 'an empty lobby drops itself');
  const ghost = new C('Ghost2');
  await ghost.ready;
  ghost.send({ t: 'hello', name: 'Ghost2', code: deadCode });
  const gone = await ghost.wait((m) => m.t === 'error');
  eq(gone.code, 'noroom', 'and its code stops working');
  ghost.close();

  // the same cleanup survives a lobby that emptied out mid game
  const mid1 = await join('Mid', { create: true, settings: { wordChoices: 1, drawTime: 0, rounds: 1 } });
  const mid2 = await join('Mid2', { code: mid1.code });
  const midCode = mid1.code;
  await sleep(150);
  mid1.send({ t: 'start' });
  await mid1.wait((x) => x.t === 'state' && x.state === 'drawing', 6000);
  mid1.close(); mid2.close();
  await sleep(3500);
  ok(!(await api('/api/admin/state', {}, adminToken)).body.rooms.some((r) => r.code === midCode),
    'a lobby abandoned mid game drops itself too');

  // host leaving hands the crown over
  const o1 = await join('Owner', { create: true });
  const o2 = await join('Heir', { code: o1.code });
  await sleep(150);
  o1.close();
  const hand = await o2.wait((m) => m.t === 'players' && m.hostId === o2.id, 4000);
  ok(!!hand, 'the host role moves on when the host leaves');
  o2.close();
  await sleep(200);
}

main();
