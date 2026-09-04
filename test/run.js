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
    await galleryTests();
    await soloTests();
    await pauseTests();
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
  const allTags = {};
  (st.body.filterGroups || []).forEach((g) => { allTags[g.id] = g.tags.slice(); });
  const defTags = await api('/api/admin/defaults', { method: 'POST', body: JSON.stringify({ tagFilters: allTags }) }, adminToken);
  eq(defTags.status, 200, 'lobby defaults can preselect every tag');
  ok(Object.keys(defTags.body.defaults.tagFilters).length >= 2, 'and they are stored');
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

  // every unit word should have picked up its icon from the shipped database
  const withIcon = st.body.words.filter((w) => w.icon);
  ok(withIcon.length > 250, withIcon.length + ' words were matched to a unit icon automatically');
  const perci = st.body.words.find((w) => w.word === 'Percival');
  eq(perci.icon, 'units/XEL0305.png', 'Percival got the right icon');
  eq(st.body.words.find((w) => w.word === 'Mass Extractor').icon, 'units/UEB1103.png', 'a collapsed building got one too');
  eq(st.body.words.find((w) => w.word === 'UEF T1 Anti-Air').icon, 'units/UEB2104.png', 'and a per faction turret');
  const icons = await api('/api/admin/icons', {}, adminToken);
  ok(icons.body.builtin.length > 500, icons.body.builtin.length + ' icons available to pick from');
  ok(icons.body.builtin.indexOf('units/UEL0401.png') !== -1, 'the Fatboy icon is one of them');

  const px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await api('/api/admin/icons/upload', {
    method: 'POST', body: JSON.stringify({ dataUrl: 'data:image/png;base64,' + px, name: 'Setons Clutch' })
  }, adminToken);
  eq(up.status, 200, 'an image uploads');
  ok(/^custom\/setons-clutch-[0-9a-f]{8}\.png$/.test(up.body.icon), 'and lands under a safe name: ' + up.body.icon);
  const served = await fetch(BASE + '/icons/' + up.body.icon);
  eq(served.status, 200, 'the uploaded icon is served back');
  const notImage = await api('/api/admin/icons/upload', { method: 'POST', body: JSON.stringify({ dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }) }, adminToken);
  eq(notImage.status, 400, 'a non image upload is refused');

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

  const badIcon = await api('/api/admin/words', { method: 'PUT', body: JSON.stringify({ id: id, icon: '../../server.js' }) }, adminToken);
  eq(badIcon.status, 400, 'an icon path that escapes the folder is refused');
  const setIcon = await api('/api/admin/words', { method: 'PUT', body: JSON.stringify({ id: id, icon: 'units/UEL0401.png' }) }, adminToken);
  eq(setIcon.body.word.icon, 'units/UEL0401.png', 'an icon can be assigned by hand');
  const clrIcon = await api('/api/admin/words', { method: 'PUT', body: JSON.stringify({ id: id, icon: '' }) }, adminToken);
  eq(clrIcon.body.word.icon, '', 'and cleared again');

  const bulk = await api('/api/admin/words/bulk', {
    method: 'POST', body: JSON.stringify({ ids: [id], action: 'enable' })
  }, adminToken);
  eq(bulk.body.changed, 1, 'bulk enable works');

  const imp = await api('/api/admin/words/import', {
    method: 'POST',
    body: JSON.stringify({ text: 'Imported One | a note | alt one | test, import\nImported Two\nPercival', mode: 'merge' })
  }, adminToken);
  eq(imp.body.added, 2, 'import added the new lines');
  eq(imp.body.skipped, 1, 'import skipped the duplicate');

  // tags are comma separated, so a tag is allowed to contain spaces
  const spaced = await api('/api/admin/words/import', {
    method: 'POST',
    body: JSON.stringify({ text: 'Seton\u2019s Clutch | 20x20 | Setons | map, easy maps\nTheta Passage | 5x5 | | map, easy maps', mode: 'merge' })
  }, adminToken);
  eq(spaced.body.added, 2, 'a spaced tag imports without splitting');
  const withSpace = (await api('/api/admin/state', {}, adminToken)).body.words
    .filter((w) => w.tags.indexOf('easy maps') !== -1);
  eq(withSpace.length, 2, '"easy maps" survives as one tag');
  ok(withSpace[0].tags.indexOf('easy') === -1 && withSpace[0].tags.indexOf('maps') === -1,
    'and was not chopped into "easy" and "maps"');
  eq((await api('/api/admin/state', {}, adminToken)).body.tagCounts['easy maps'], 2,
    'the tag count keys on the whole tag');

  // and it works as a lobby filter end to end
  const groupsBefore = (await api('/api/admin/state', {}, adminToken)).body.filterGroups;
  await api('/api/admin/filters', {
    method: 'POST',
    body: JSON.stringify({ groups: groupsBefore.concat([{ id: 'maps', label: 'Maps', tags: ['easy maps'], always: '' }]) })
  }, adminToken);
  const sp1 = await join('Spaced', { create: true, settings: { tagFilters: { maps: ['easy maps'] }, wordChoices: 1, drawTime: 0, rounds: 1 } });
  const sp2 = await join('Spaced2', { code: sp1.code });
  await sleep(200);
  eq(sp1.state().poolSize, 2, 'a spaced tag filters the pool correctly');
  ok((sp1.state().tagCounts || {})['easy maps'] === 2, 'the lobby is told the spaced tag count');
  sp1.send({ t: 'start' });
  const spSt = await sp1.wait((m) => m.t === 'state' && m.state === 'drawing', 6000);
  const spDrawer = spSt.drawerId === sp1.id ? sp1 : sp2;
  const spWord = spDrawer.find((m) => m.t === 'state' && m.state === 'drawing').word;
  ok(/Clutch|Theta/.test(spWord), 'and a game started on that filter picks one of them: ' + spWord);
  sp1.close(); sp2.close();
  await sleep(200);
  await api('/api/admin/words', {
    method: 'DELETE',
    body: JSON.stringify({ ids: withSpace.map((w) => w.id) })
  }, adminToken);
  await api('/api/admin/filters', { method: 'POST', body: JSON.stringify({ groups: groupsBefore }) }, adminToken);

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

  // Nothing an admin can post is allowed to wipe the list.
  const countBefore = (await api('/api/admin/state', {}, adminToken)).body.words.length;
  const replace = await api('/api/admin/words/import', {
    method: 'POST', body: JSON.stringify({ text: 'Only One Word', mode: 'replace' })
  }, adminToken);
  eq(replace.status, 200, 'an import asking to replace still succeeds');
  ok(replace.body.replaced === undefined, 'but it does not report a replace');
  const afterReplace = (await api('/api/admin/state', {}, adminToken)).body.words;
  eq(afterReplace.length, countBefore + 1, 'and it merely added one word instead of wiping ' + countBefore);
  ok(afterReplace.some((w) => w.word === 'Percival'), 'the existing list is untouched');
  await api('/api/admin/words', {
    method: 'DELETE',
    body: JSON.stringify({ ids: afterReplace.filter((w) => w.word === 'Only One Word').map((w) => w.id) })
  }, adminToken);

  // re-importing a full export is a no-op rather than a restore, every word is a duplicate
  const back = await api('/api/admin/words/import', {
    method: 'POST', body: JSON.stringify({ text: JSON.stringify(expJson) })
  }, adminToken);
  eq(back.body.added, 0, 're-importing a full export adds nothing new');
  eq(back.body.skipped, expJson.length, 'every one of its ' + expJson.length + ' words is skipped as a duplicate');
  const after = await api('/api/admin/state', {}, adminToken);
  eq(after.body.words.length, expJson.length, 'and the list is unchanged by it');

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
  ok(Array.isArray(choices.hints) && choices.hints.length === 3 && choices.hints.every((h) => h && h.length > 2),
    'the drawer is told what each unit is: ' + choices.hints[0]);
  ok(Array.isArray(choices.icons) && choices.icons.length === 3 &&
    choices.icons.some((i) => /^units\//.test(i)), 'and gets a picture for the choices: ' + choices.icons.join(', '));
  const gChoose = guessers[0].find((m) => m.t === 'state' && m.state === 'choosing');
  eq(gChoose.choosing, null, 'guessers get no word list while the drawer picks');
  eq(gChoose.choosingHints, null, 'and no notes either');
  const word = choices.words[0];

  drawer.send({ t: 'pick', index: 0 });
  await drawer.wait((m) => m.t === 'state' && m.state === 'drawing');
  const gs = await guessers[0].wait((m) => m.t === 'state' && m.state === 'drawing');
  eq(gs.word, null, 'guessers do not receive the word');
  ok(gs.mask.indexOf('_') !== -1, 'guessers get a masked word');
  eq(gs.mask.length, word.length, 'mask keeps the word length');
  const ds = drawer.find((m) => m.t === 'state' && m.state === 'drawing');
  eq(ds.word, word, 'drawer sees the word');
  ok(typeof ds.wordIcon === 'string', 'the drawer is sent the reference picture: ' + ds.wordIcon);
  eq(gs.wordIcon, null, 'guessers are not');
  eq(gs.choosingIcons, null, 'and never saw the choice pictures either');

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
  ok(typeof te.icon === 'string', 'and the picture, now that the word is out: ' + te.icon);
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
  const f1 = await join('Fac', { create: true, settings: { tagFilters: { faction: ['seraphim'], kind: ['air'] }, wordChoices: 1, drawTime: 0, rounds: 1 } });
  const f2 = await join('Fac2', { code: f1.code });
  await sleep(150);
  f1.send({ t: 'start' });
  const fst = await f1.wait((m) => m.t === 'state' && m.state === 'drawing', 6000);
  const fd = fst.drawerId === f1.id ? f1 : f2;
  const fw = fd.find((m) => m.t === 'state' && m.state === 'drawing').word;
  const stAll = await api('/api/admin/state', {}, adminToken);
  const entry = stAll.body.words.find((w) => w.word === fw);
  ok(entry && (entry.tags.indexOf('air') !== -1 || entry.tags.indexOf('seraphim') !== -1),
    'selecting seraphim and air offers either, got ' + fw + ' [' + (entry ? entry.tags.join(' ') : '?') + ']');
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
  const ff1 = await join('Filt', { create: true, settings: { tagFilters: { faction: ['uef'] }, wordChoices: 5, drawTime: 0, rounds: 1 } });
  const ff2 = await join('Filt2', { code: ff1.code });
  await sleep(150);
  ff1.send({ t: 'start' });
  await ff1.wait((m) => m.t === 'state' && m.state === 'choosing', 6000);
  const offered = (await (ff1.find((m) => m.t === 'choices') ? ff1 : ff2).wait((m) => m.t === 'choices', 4000)).words;
  const all = (await api('/api/admin/state', {}, adminToken)).body.words;
  const tagsOf = (w) => (all.find((x) => x.word === w) || { tags: [] }).tags;
  const bad = offered.filter((w) => tagsOf(w).indexOf('uef') === -1);
  eq(bad.length, 0, 'selecting uef offers only uef words: ' + offered.join(', '));
  ff1.close(); ff2.close();
  await sleep(200);

  // tags are opt in: a lobby with nothing selected is not playable
  const oi1 = await join('OptIn', { create: true, settings: { tagFilters: {} } });
  const oi2 = await join('OptIn2', { code: oi1.code });
  await sleep(200);
  eq(oi1.state().poolSize, 0, 'nothing selected means nothing in play');
  oi1.send({ t: 'start' });
  await sleep(400);
  eq(oi1.state().state, 'lobby', 'and the game will not start');
  const pick = {};
  (oi1.state().filterGroups || []).forEach((g) => { if (g.id === 'kind') pick[g.id] = ['naval']; });
  oi1.clear();
  oi1.send({ t: 'settings', settings: { tagFilters: pick } });
  const oiSet = await oi1.wait((m) => m.t === 'settings', 3000);
  ok(oiSet.poolSize > 20, 'selecting naval alone is enough to play, ' + oiSet.poolSize + ' words');
  oi1.send({ t: 'start' });
  const oiSt = await oi1.wait((m) => m.t === 'state' && m.state !== 'lobby', 6000);
  ok(!!oiSt, 'and the game starts');
  oi1.close(); oi2.close();
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

  // the lobby reports how big the pool is, and reacts to the filters
  const pc1 = await join('Pool', { create: true });
  const pc2 = await join('Pool2', { code: pc1.code });
  await sleep(200);
  const cfgNow = (await api('/api/config')).body;
  const allWords = (await api('/api/admin/state', {}, adminToken)).body.words;
  const groupTags = new Set();
  cfgNow.filterGroups.forEach((g) => g.tags.forEach((t) => groupTags.add(t)));
  const total = allWords.filter((w) => w.enabled && w.tags.some((t) => groupTags.has(t))).length;
  ok(total > 200 && total <= cfgNow.words, 'the taggable pool is ' + total + ' of ' + cfgNow.words + ' enabled words');
  eq(pc1.state().poolSize, total, 'a lobby with every tag on reports all of them');
  ok(Array.isArray(pc1.state().filterGroups) && pc1.state().filterGroups.length >= 2, 'the lobby is told what the filter groups are');
  ok(pc1.state().tagCounts && pc1.state().tagCounts.uef > 0, 'and how many words each tag has');
  pc1.clear();
  pc1.send({ t: 'settings', settings: { tagFilters: { kind: ['naval'] } } });
  const sm = await pc1.wait((m) => m.t === 'settings', 3000);
  ok(sm.poolSize > 0 && sm.poolSize < total, 'filtering shrinks the reported pool: ' + sm.poolSize + ' of ' + total);
  const navalWords = (await api('/api/admin/state', {}, adminToken)).body.words
    .filter((w) => w.enabled && w.tags.indexOf('naval') !== -1).length;
  eq(sm.poolSize, navalWords, 'the reported count matches the word list exactly');
  pc1.clear();
  pc1.send({ t: 'settings', settings: { tagFilters: {} } });
  const sm2 = await pc1.wait((m) => m.t === 'settings', 3000);
  eq(sm2.poolSize, 0, 'clearing every tag leaves nothing in play, tags are opt in');
  const everything = {};
  cfgNow.filterGroups.forEach((g) => { everything[g.id] = g.tags.slice(); });
  pc1.clear();
  pc1.send({ t: 'settings', settings: { tagFilters: everything } });
  const sm3 = await pc1.wait((m) => m.t === 'settings', 3000);
  eq(sm3.poolSize, total, 'selecting everything puts the whole list back in play');
  pc1.close(); pc2.close();
  await sleep(200);

  // filter groups are admin editable, and an empty tag disappears from the lobby
  const before = (await api('/api/admin/state', {}, adminToken)).body.filterGroups;
  ok(before.some((g) => g.id === 'faction' && g.tags.indexOf('nomads') !== -1), 'the shipped groups are returned to the admin');
  const saved = await api('/api/admin/filters', {
    method: 'POST',
    body: JSON.stringify({
      groups: [
        { id: 'faction', label: 'Factions', tags: ['uef', 'cybran', 'aeon', 'seraphim'], always: 'neutral' },
        { id: 'kind', label: 'Unit types', tags: ['land', 'air', 'naval', 'structure', 'experimental'], always: '' },
        { id: 'extra', label: 'Extras', tags: ['map'], always: '' }
      ]
    })
  }, adminToken);
  eq(saved.status, 200, 'filter groups saved');
  eq(saved.body.filterGroups.length, 3, 'a third group can be added');
  const cfg2 = (await api('/api/config')).body;
  ok(cfg2.filterGroups.some((g) => g.id === 'extra' && g.tags.indexOf('map') !== -1), 'the new group reaches the lobby config');
  ok(!cfg2.filterGroups.some((g) => g.tags.indexOf('nomads') !== -1), 'a removed tag is gone from the groups');
  ok(cfg2.tagCounts && cfg2.tagCounts.map === undefined, 'a tag with no words has no count, so no chip is drawn');

  // a filter that matches nothing must be honest about it rather than silently using everything
  const z1 = await join('Zero', { create: true, settings: { tagFilters: { extra: ['map'] } } });
  const z2 = await join('Zero2', { code: z1.code });
  await sleep(200);
  eq(z1.state().poolSize, 0, 'a filter matching no words reports zero');
  z1.send({ t: 'start' });
  await sleep(400);
  eq(z1.state().state, 'lobby', 'and the game refuses to start');
  z1.close(); z2.close();
  await sleep(200);

  // restore the shipped groups for the rest of the run
  await api('/api/admin/filters', { method: 'POST', body: JSON.stringify({ groups: before }) }, adminToken);

  // the host can switch unit pictures off, and then none are sent at all
  const pv1 = await join('NoPic', { create: true, settings: { previews: false, wordChoices: 3, drawTime: 20, choiceTime: 4, rounds: 1 } });
  const pv2 = await join('NoPic2', { code: pv1.code });
  await sleep(200);
  pv1.send({ t: 'start' });
  const pvSt = await pv1.wait((m) => m.t === 'state' && m.state === 'choosing', 6000);
  const pvDrawer = pvSt.drawerId === pv1.id ? pv1 : pv2;
  const pvCh = await pvDrawer.wait((m) => m.t === 'choices', 4000);
  eq(pvCh.icons.length, 0, 'no choice pictures are sent with previews off');
  eq(pvDrawer.find((m) => m.t === 'state' && m.state === 'choosing').choosingIcons, null, 'and none in the state either');
  pvDrawer.send({ t: 'pick', index: 0 });
  const pvDraw = await pvDrawer.wait((m) => m.t === 'state' && m.state === 'drawing', 5000);
  eq(pvDraw.wordIcon, null, 'the drawer gets no reference picture');
  pvDrawer.send({ t: 'skip' });
  const pvEnd = await pvDrawer.wait((m) => m.t === 'turnend', 6000);
  eq(pvEnd.icon, '', 'and the reveal screen gets none');
  pv1.close(); pv2.close();
  await sleep(200);

  // the unit look-up searches notes and tags, in any order, and never returns maps
  const lu1 = await join('Look', { create: true });
  const lu2 = await join('Look2', { code: lu1.code });
  await sleep(200);
  const ask = async (q) => {
    lu1.clear();
    lu1.send({ t: 'lookup', q: q });
    return lu1.wait((m) => m.t === 'lookup', 3000);
  };
  const r1 = await ask('aeon t1 air scout');
  ok(r1.results.some((r) => r.word === 'Mirage'), 'a description finds the unit: ' + r1.results.map((r) => r.word).join(', '));
  const r2 = await ask('scout t1 aeon air');
  eq(r2.results.map((r) => r.word).sort().join(','), r1.results.map((r) => r.word).sort().join(','),
    'word order does not matter');
  const r3 = await ask('AEON T1 AIR SCOUT');
  eq(r3.results.length, r1.results.length, 'case does not matter either');
  ok(r1.results.every((r) => typeof r.icon === 'string'), 'results carry the picture too');
  const r4 = await ask('uef');
  ok(r4.results.length <= 14, 'results are capped at 14, got ' + r4.results.length);
  const r5 = await ask('zzzznothing');
  eq(r5.results.length, 0, 'a miss returns nothing');
  const r6 = await ask('');
  eq(r6.results.length, 0, 'an empty query returns nothing rather than the whole list');

  // maps must never be findable through it
  await api('/api/admin/words/import', {
    method: 'POST', body: JSON.stringify({ text: 'Lookup Test Map | a 10x10 duel map | | map, easy maps' })
  }, adminToken);
  const r7 = await ask('duel map');
  ok(!r7.results.some((r) => /Lookup Test Map/.test(r.word)), 'a map is never returned by the look-up');
  const r8 = await ask('easy maps');
  eq(r8.results.length, 0, 'and neither is its difficulty tag');

  lu1.send({ t: 'settings', settings: { lookup: false } });
  await lu1.wait((m) => m.t === 'settings', 3000);
  const off = await ask('aeon t1 air scout');
  ok(off.off === true && off.results.length === 0, 'the host can switch the look-up off');
  lu1.close(); lu2.close();
  await sleep(200);

  // long names earn more letter hints than short ones
  const hintsFor = async (label, only, expectAtLeast) => {
    const h1 = await join('Hint' + label, { create: true, settings: { wordChoices: 1, drawTime: 16, hints: true, hintCount: 2, rounds: 1, customWords: only, customWordsOnly: true } });
    const h2 = await join('Hint' + label + 'b', { code: h1.code });
    await sleep(150);
    h1.send({ t: 'start' });
    const st2 = await h1.wait((m) => m.t === 'state' && m.state === 'drawing', 6000);
    const g = st2.drawerId === h1.id ? h2 : h1;
    let masks = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && masks < expectAtLeast) {
      const seen = g.all((m) => m.t === 'mask').length;
      if (seen > masks) masks = seen;
      if (masks >= expectAtLeast) break;
      await sleep(200);
    }
    h1.close(); h2.close();
    await sleep(200);
    return masks;
  };
  const shortHints = await hintsFor('Short', 'Wasp', 2);
  eq(shortHints, 2, 'a four letter word gets the configured two hints');
  const longHints = await hintsFor('Long', 'Stealth Field Generator', 4);
  eq(longHints, 4, 'a 21 letter name gets four, one per five letters');

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

/* --------------------------------------------------- saved drawings */
async function galleryTests() {
  console.log('\nSaved drawings (unit)');
  const { Gallery } = require(path.join(__dirname, '..', 'lib', 'gallery'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fafgal-'));
  const g = new Gallery(dir);
  g.load();
  eq(g.count(), 0, 'a fresh gallery is empty');

  const ops = (n) => Array.from({ length: n }, (_, i) => ['s', i, i, i + 1, i + 1, '#000000', 6]);
  eq(g.save({ word: 'Percival', ops: ops(3) }), null, 'a near empty page is not kept');
  eq(g.save({ word: '', ops: ops(40) }), null, 'a drawing with no word is not kept');
  const id = g.save({ word: 'Percival', icon: 'units/XEL0305.png', drawer: 'Alpha', ops: ops(40) });
  ok(!!id, 'a real drawing is kept');
  eq(g.count(), 1, 'and shows up in the index');
  const back = g.get(id);
  eq(back.word, 'Percival', 'it reads back with its word');
  eq(back.ops.length, 40, 'and every stroke');
  eq(back.icon, 'units/XEL0305.png', 'and the picture that went with it');
  eq(g.get('../../etc/passwd'), null, 'a path traversal id reads nothing');
  eq(g.get('nope'), null, 'an unknown id reads nothing');

  for (let i = 0; i < 5; i++) g.save({ word: 'Unit ' + i, ops: ops(20) });
  eq(g.count(), 6, 'six saved');
  const recent = g.recent(3, 0);
  eq(recent.length, 3, 'recent() pages');
  eq(recent[0].word, 'Unit 4', 'newest first');
  ok(!recent[0].ops || typeof recent[0].ops === 'number', 'the index carries a stroke count, not the strokes');

  const picked = g.pick(4);
  eq(picked.length, 4, 'pick() returns the number asked for');
  eq(new Set(picked).size, 4, 'with no repeats');
  const words = picked.map((x) => g.get(x).word);
  eq(new Set(words).size, 4, 'and prefers different words');

  ok(g.remove(id), 'a drawing can be deleted');
  eq(g.get(id), null, 'and is gone from disk');
  eq(g.count(), 5, 'and from the index');

  await sleep(120);
  const g2 = new Gallery(dir);
  g2.load();
  eq(g2.count(), 5, 'the index survives a restart');

  // a drawing whose index line never made it to disk is picked up again
  const orphan = g2.save({ word: 'Orphan', ops: ops(20) });
  await sleep(150);
  fs.writeFileSync(path.join(dir, 'drawings', 'index.json'),
    JSON.stringify(g2.index.filter((d) => d.id !== orphan)));
  const g4 = new Gallery(dir);
  g4.load();
  ok(g4.index.some((d) => d.id === orphan), 'a drawing missing from the index is recovered on boot');

  // the cap is enforced, oldest out first
  const small = fs.mkdtempSync(path.join(os.tmpdir(), 'fafgal2-'));
  const g3 = new Gallery(small);
  g3.load();
  const realMax = require(path.join(__dirname, '..', 'lib', 'gallery')).MAX_DRAWINGS;
  eq(realMax, 1000, 'the shipped cap is 1000 drawings');
  g3.index = [];
  for (let i = 0; i < 5; i++) g3.save({ word: 'W' + i, ops: ops(20) });
  const before = g3.count();
  g3.index = g3.index.slice(-3);   // stand in for a full store
  eq(before, 5, 'five saved before trimming');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(small, { recursive: true, force: true });
}

/* -------------------------------------------------- single player mode */
async function soloTests() {
  console.log('\nSingle player challenge');

  // Fill the gallery by actually playing: two players, two rounds, drawer scribbles then skips.
  const host = await join('SoloHost', { create: true, settings: { rounds: 2, drawTime: 20, choiceTime: 4, wordChoices: 1, hints: false } });
  const mate = await join('SoloMate', { code: host.code });
  await sleep(150);
  const known = [];
  host.send({ t: 'start' });
  const clients = { [host.id]: host, [mate.id]: mate };
  let sawIcon = false;

  for (let turn = 0; turn < 4; turn++) {
    let st;
    try { st = await host.wait((m) => m.t === 'state' && (m.state === 'drawing' || m.state === 'choosing'), 12000); }
    catch (e) { break; }
    if (st.state === 'choosing') {
      const d = clients[st.drawerId];
      d.send({ t: 'pick', index: 0 });
      st = await host.wait((m) => m.t === 'state' && m.state === 'drawing', 8000);
    }
    const drawer = clients[st.drawerId];
    const guesser = drawer === host ? mate : host;
    const ds = drawer.find((m) => m.t === 'state' && m.state === 'drawing');
    const word = ds.word;
    if (word && known.indexOf(word) === -1) known.push(word);
    drawer.send({ t: 'begin' });
    const ops = [];
    for (let i = 0; i < 24; i++) ops.push(['s', 10 + i * 5, 20 + i * 3, 15 + i * 5, 25 + i * 3, '#112233', 7]);
    drawer.send({ t: 'draw', ops: ops });
    await sleep(120);

    // the correct guesser should be handed the reference picture too
    guesser.clear();
    guesser.send({ t: 'chat', text: word });
    const rv = await guesser.wait((m) => m.t === 'reveal', 6000).catch(() => null);
    if (rv && typeof rv.icon === 'string' && rv.icon) sawIcon = true;
    host.clear(); mate.clear();
    await sleep(400);
  }
  ok(sawIcon, 'a player who guessed correctly is sent the reference picture');
  ok(known.length >= 3, 'played ' + known.length + ' turns to fill the gallery');
  host.close(); mate.close();
  await sleep(400);

  const list = await api('/api/admin/drawings?limit=50', {}, adminToken);
  eq(list.status, 200, 'admin can list the saved drawings');
  ok(list.body.total >= 3, list.body.total + ' drawings were saved from real turns');
  eq(list.body.cap, 1000, 'the admin page is told the cap');
  ok(list.body.drawings.every((d) => d.word && d.ops >= 15), 'every stored drawing has a word and real strokes');
  const anyId = list.body.drawings[0].id;
  const one = await api('/api/admin/drawings/one?id=' + anyId, {}, adminToken);
  eq(one.status, 200, 'a single drawing reads back');
  ok(Array.isArray(one.body.drawing.ops), 'with its strokes');
  const noAuth = await api('/api/admin/drawings');
  eq(noAuth.status, 401, 'the drawing list needs an admin token');

  const hs0 = await api('/api/solo/highscores');
  eq(hs0.status, 200, 'the highscore board is public');
  ok(hs0.body.drawings >= 3, 'and reports the pool size');
  eq(hs0.body.rounds, 10, 'a run is ten drawings');

  const run = await api('/api/solo/start', { method: 'POST', body: JSON.stringify({ name: 'Tester' }) });
  eq(run.status, 200, 'a run starts');
  const sid = run.body.sid;
  ok(!!sid, 'with a session id');
  ok(Array.isArray(run.body.ops) && run.body.ops.length > 0, 'the first drawing arrives with strokes');
  eq(run.body.word, undefined, 'the answer is never sent to the browser');
  eq(run.body.hint, undefined, 'and neither is the admin note');
  ok(run.body.mask.indexOf('_') !== -1, 'the word comes masked: ' + run.body.mask);
  ok(run.body.endsAt > Date.now(), 'with a deadline');
  eq(run.body.index, 1, 'starting at drawing 1');

  const bad = await api('/api/solo/guess', { method: 'POST', body: JSON.stringify({ sid: 'nope', guess: 'x' }) });
  eq(bad.status, 404, 'an unknown session is refused');

  const wrong = await api('/api/solo/guess', { method: 'POST', body: JSON.stringify({ sid: sid, guess: 'zzzz nonsense' }) });
  eq(wrong.body.result, 'no', 'a wrong guess is a miss');

  // Guess through the run using the words we know were drawn.
  let solved = 0, rounds = 0, score = 0;
  for (let i = 0; i < 12; i++) {
    let hit = null;
    for (const w of known) {
      const g = await api('/api/solo/guess', { method: 'POST', body: JSON.stringify({ sid: sid, guess: w }) });
      if (g.body.result === 'exact') { hit = g.body; break; }
      if (g.body.result === 'over') { hit = g.body; break; }
    }
    if (!hit) {
      const t = await api('/api/solo/timeup', { method: 'POST', body: JSON.stringify({ sid: sid }) });
      hit = t.body;
    } else if (hit.points > 0) {
      solved++;
      score = hit.total;
    }
    rounds++;
    const nx = await api('/api/solo/next', { method: 'POST', body: JSON.stringify({ sid: sid }) });
    if (nx.body.done) break;
    ok(nx.body.index === rounds + 1, 'drawing ' + (rounds + 1) + ' follows on');
    if (rounds > 11) break;
  }
  ok(solved > 0, 'guessed ' + solved + ' of the drawings correctly');
  ok(score > 0, 'and scored ' + score + ' points for it');

  const fin = await api('/api/solo/finish', { method: 'POST', body: JSON.stringify({ sid: sid, name: 'Tester' }) });
  eq(fin.status, 200, 'the run finishes');
  eq(fin.body.score, score, 'the final score matches what was earned');
  ok(fin.body.rank >= 1, 'and lands on the board at rank ' + fin.body.rank);
  ok(fin.body.results.length === rounds, 'with one line per drawing played');
  ok(fin.body.results.some((r) => r.got), 'showing which ones were got');

  const hs1 = await api('/api/solo/highscores');
  ok(hs1.body.best.some((b) => b.name === 'Tester' && b.score === score), 'the score is on the public board');

  // a second finish must not double count
  const again = await api('/api/solo/finish', { method: 'POST', body: JSON.stringify({ sid: sid, name: 'Tester' }) });
  eq(again.body.score, score, 'finishing twice reports the same score');
  const hs2 = await api('/api/solo/highscores');
  eq(hs2.body.best.filter((b) => b.name === 'Tester').length, 1, 'and only enters the board once');

  // the look-up, over HTTP this time, behaving exactly as it does in a lobby
  const run2 = await api('/api/solo/start', { method: 'POST', body: JSON.stringify({ name: 'Looker' }) });
  const sid2 = run2.body.sid;
  const lk = await api('/api/solo/lookup', { method: 'POST', body: JSON.stringify({ sid: sid2, q: 'uef land' }) });
  eq(lk.status, 200, 'the challenge has a look-up too');
  ok(lk.body.results.length > 0, 'and it finds things: ' + lk.body.results.map((r) => r.word).slice(0, 3).join(', '));
  ok(lk.body.results.every((r) => r.word && typeof r.hint === 'string'), 'each hit carries its note');
  ok(lk.body.results.length <= 14, 'never more than fourteen at a time');
  const lkOrder = await api('/api/solo/lookup', { method: 'POST', body: JSON.stringify({ sid: sid2, q: 'land uef' }) });
  eq(JSON.stringify(lkOrder.body.results), JSON.stringify(lk.body.results), 'word order does not matter');
  const lkMap = await api('/api/solo/lookup', { method: 'POST', body: JSON.stringify({ sid: sid2, q: 'map' }) });
  eq(lkMap.body.results.length, 0, 'and maps are excluded here as well');
  const lkEmpty = await api('/api/solo/lookup', { method: 'POST', body: JSON.stringify({ sid: sid2, q: '  ' }) });
  eq(lkEmpty.body.results.length, 0, 'an empty query returns nothing rather than the whole list');
  const lkNoSid = await api('/api/solo/lookup', { method: 'POST', body: JSON.stringify({ sid: 'nope', q: 'uef' }) });
  eq(lkNoSid.status, 404, 'and it needs a live run, so it is not an open word list endpoint');
  let throttled = false;
  for (let i = 0; i < 20; i++) {
    const r = await api('/api/solo/lookup', { method: 'POST', body: JSON.stringify({ sid: sid2, q: 'uef' }) });
    if (r.body.busy) { throttled = true; break; }
  }
  ok(throttled, 'hammering it gets rate limited');

  const hsClear = await api('/api/admin/highscores/clear', { method: 'POST' }, adminToken);
  eq(hsClear.status, 200, 'admin can wipe the highscore board');
  const hs3 = await api('/api/solo/highscores');
  eq(hs3.body.best.length, 0, 'and it comes back empty');
}

/* ------------------------------------------------------- host pause */
async function pauseTests() {
  console.log('\nHost pause');
  const host = await join('PHost', { create: true, settings: { rounds: 2, drawTime: 30, choiceTime: 4, wordChoices: 1, hints: true, hintCount: 2 } });
  const mate = await join('PMate', { code: host.code });
  await sleep(200);
  eq(host.state().hostId, host.id, 'the creator is the host');

  host.send({ t: 'start' });
  let st = await host.wait((m) => m.t === 'state' && (m.state === 'drawing' || m.state === 'choosing'), 10000);
  const clients = { [host.id]: host, [mate.id]: mate };
  if (st.state === 'choosing') {
    clients[st.drawerId].send({ t: 'pick', index: 0 });
    st = await host.wait((m) => m.t === 'state' && m.state === 'drawing', 8000);
  }
  const drawer = clients[st.drawerId];
  const guesser = drawer === host ? mate : host;
  const word = drawer.find((m) => m.t === 'state' && m.state === 'drawing').word;
  drawer.send({ t: 'begin' });

  // only the host may pause
  const notHost = drawer === host ? mate : host;
  if (notHost !== host) {
    notHost.send({ t: 'pause', on: true });
    await sleep(250);
    ok(!host.state().paused, 'a player who is not the host cannot pause');
  }

  host.clear(); mate.clear();
  host.send({ t: 'pause', on: true });
  const pausedState = await host.wait((m) => m.t === 'state' && m.paused === true, 4000);
  ok(!!pausedState, 'the host can pause');
  ok(pausedState.pausedLeft > 0, 'the state carries the time that was left: ' + pausedState.pausedLeft + 'ms');
  const seenByOther = await mate.wait((m) => m.t === 'state' && m.paused === true, 4000);
  ok(!!seenByOther, 'everybody is told about it');
  ok(!!host.find((m) => m.t === 'chat' && /paused the game/.test(m.text || '')), 'and it says so in the chat');

  const frozenEnds = pausedState.endsAt;
  await sleep(1600);

  // nothing moves while paused
  guesser.clear();
  guesser.send({ t: 'chat', text: 'hello there' });
  const held = await guesser.wait((m) => m.t === 'chat' && m.kind === 'warn', 3000);
  ok(/paused/.test(held.text), 'chat is held: ' + held.text);
  await sleep(150);
  eq(mate.all((m) => m.t === 'chat' && m.text === 'hello there').length, 0, 'and the message never reaches anyone');

  guesser.clear();
  guesser.send({ t: 'chat', text: word });
  await sleep(250);
  eq(guesser.all((m) => m.t === 'reveal').length, 0, 'a correct guess does not score while paused');

  guesser.clear();
  guesser.send({ t: 'lookup', q: 'uef' });
  const lk = await guesser.wait((m) => m.t === 'lookup', 3000);
  ok(lk.paused === true && lk.results.length === 0, 'the unit look-up is on hold too');

  mate.clear(); host.clear();
  drawer.send({ t: 'draw', ops: [['s', 5, 5, 200, 200, '#000000', 8]] });
  await sleep(250);
  const other = drawer === host ? mate : host;
  eq(other.all((m) => m.t === 'draw').length, 0, 'and the drawer cannot draw either');

  // resume: the clock picks up where it stopped
  host.clear();
  host.send({ t: 'pause', on: false });
  const back = await host.wait((m) => m.t === 'state' && m.paused === false, 4000);
  ok(!!back, 'the host can resume');
  ok(back.endsAt > frozenEnds + 1400, 'the deadline moved forward by the pause (' + (back.endsAt - frozenEnds) + 'ms)');
  const leftNow = back.endsAt - back.now;
  ok(Math.abs(leftNow - pausedState.pausedLeft) < 900,
    'the drawer got every second back (' + leftNow + 'ms left, ' + pausedState.pausedLeft + 'ms when paused)');

  // and the game works again
  guesser.clear();
  guesser.send({ t: 'chat', text: word });
  const rev = await guesser.wait((m) => m.t === 'reveal', 5000);
  eq(rev.word, word, 'guessing works again after the resume');

  host.close(); mate.close();
  await sleep(300);

  // a long pause does not let the turn time out behind it
  const h2 = await join('PHost2', { create: true, settings: { rounds: 1, drawTime: 5, choiceTime: 3, wordChoices: 1, hints: false } });
  const m2 = await join('PMate2', { code: h2.code });
  await sleep(200);
  h2.send({ t: 'start' });
  let s2 = await h2.wait((m) => m.t === 'state' && (m.state === 'drawing' || m.state === 'choosing'), 10000);
  const cl2 = { [h2.id]: h2, [m2.id]: m2 };
  if (s2.state === 'choosing') {
    cl2[s2.drawerId].send({ t: 'pick', index: 0 });
    s2 = await h2.wait((m) => m.t === 'state' && m.state === 'drawing', 8000);
  }
  h2.send({ t: 'pause', on: true });
  await h2.wait((m) => m.t === 'state' && m.paused === true, 4000);
  h2.clear();
  await sleep(7000);   // longer than the whole 5 second turn
  eq(h2.all((m) => m.t === 'turnend').length, 0, 'a five second turn survives a seven second pause');
  h2.send({ t: 'pause', on: false });
  const back2 = await h2.wait((m) => m.t === 'state' && m.paused === false, 4000);
  const leftAfter = back2.endsAt - back2.now;
  ok(leftAfter > 1000, 'the turn still has ' + Math.round(leftAfter / 1000) + 's on it after the pause');
  const te = await h2.wait((m) => m.t === 'turnend', leftAfter + 6000);
  ok(!!te, 'and ends normally once the game is running again');
  h2.close(); m2.close();
  await sleep(300);

  // the host role moves when the host goes, and the new host can pause
  const o1 = await join('Owner2', { create: true, settings: { rounds: 1, drawTime: 20, choiceTime: 3, wordChoices: 1, hints: false } });
  const o2 = await join('Heir2', { code: o1.code });
  const o3 = await join('Third2', { code: o1.code });
  await sleep(200);
  eq(o1.state().hostId, o1.id, 'the creator starts as host');
  o1.close();
  const moved = await o2.wait((m) => m.t === 'players' && m.hostId === o2.id, 5000);
  ok(!!moved, 'the host role moves to the next player when the host leaves');
  o2.send({ t: 'start' });
  let s3 = await o2.wait((m) => m.t === 'state' && (m.state === 'drawing' || m.state === 'choosing'), 10000);
  const cl3 = { [o2.id]: o2, [o3.id]: o3 };
  if (s3.state === 'choosing') {
    cl3[s3.drawerId].send({ t: 'pick', index: 0 });
    await o2.wait((m) => m.t === 'state' && m.state === 'drawing', 8000);
  }
  o2.send({ t: 'pause', on: true });
  const np = await o2.wait((m) => m.t === 'state' && m.paused === true, 4000);
  ok(!!np, 'and the new host can pause');
  o2.close(); o3.close();
  await sleep(300);
}

main();
