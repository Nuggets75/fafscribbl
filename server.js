'use strict';
// fafscribbl - draw and guess Supreme Commander units.
// Zero runtime dependencies: node built-ins only.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ws = require('./lib/ws');
const { Store } = require('./lib/store');
const { Gallery, MAX_DRAWINGS } = require('./lib/gallery');
const { Solo, ROUNDS } = require('./lib/solo');
const { RoomManager, sanitizeSettings, CANVAS_W, CANVAS_H } = require('./lib/game');

const PORT = Number(process.env.PORT || 8092);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEED = path.join(__dirname, 'data', 'words.seed.json');
const ICON_MAP = path.join(__dirname, 'data', 'icons.map.json');
const ICON_BUNDLE = path.join(__dirname, 'data', 'icons.bundle.json');
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const UNIT_DB_URL = process.env.UNIT_DB_URL || 'https://faforever.github.io/etfreeman-db/#/';
const SITE_NAME = process.env.SITE_NAME || 'fafscribbl';

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.warn('[fafscribbl] ADMIN_PASSWORD is not set. Generated one for this run: ' + ADMIN_PASSWORD);
  console.warn('[fafscribbl] Set ADMIN_PASSWORD in the container to keep it across restarts.');
}

const store = new Store(DATA_DIR, SEED, ICON_MAP, ICON_BUNDLE);
store.load();
const gallery = new Gallery(DATA_DIR);
gallery.load();
const solo = new Solo(DATA_DIR, gallery);
solo.load();
const mgr = new RoomManager(store, gallery);
console.log('[fafscribbl] data dir ' + DATA_DIR + ', ' + store.db.words.length + ' words (' +
  store.enabledWords().length + ' enabled), ' + store.builtinIconNames().length + ' unit icons, ' +
  gallery.count() + ' saved drawings');

// ---------------------------------------------------------------- admin auth
const adminTokens = new Map(); // token -> expiry
const loginHits = new Map();   // ip -> {n, until}
const soloStarts = new Map();  // ip -> {n, until}
const ADMIN_TTL = 12 * 60 * 60 * 1000;

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function samePassword(given) {
  const a = sha(given || '');
  const b = sha(ADMIN_PASSWORD);
  return crypto.timingSafeEqual(a, b);
}
function issueAdminToken() {
  const t = crypto.randomBytes(24).toString('hex');
  adminTokens.set(t, Date.now() + ADMIN_TTL);
  return t;
}
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  if (!t) return false;
  const exp = adminTokens.get(String(t));
  if (!exp) return false;
  if (exp < Date.now()) { adminTokens.delete(String(t)); return false; }
  return true;
}
function ipOf(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of adminTokens) if (exp < now) adminTokens.delete(t);
  for (const [ip, v] of loginHits) if (v.until < now) loginHits.delete(ip);
  for (const [ip, v] of soloStarts) if (v.until < now) soloStarts.delete(ip);
}, 60000).unref();

// ---------------------------------------------------------------- http utils
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
function readBody(req, limit, cb) {
  let size = 0;
  const chunks = [];
  let done = false;
  req.on('data', (c) => {
    if (done) return;
    size += c.length;
    if (size > limit) { done = true; cb(new Error('too large')); try { req.destroy(); } catch (e) {} return; }
    chunks.push(c);
  });
  req.on('end', () => { if (!done) { done = true; cb(null, Buffer.concat(chunks).toString('utf8')); } });
  req.on('error', (e) => { if (!done) { done = true; cb(e); } });
}
function readJSON(req, res, fn) {
  readBody(req, 8 * 1024 * 1024, (err, body) => {
    if (err) return sendJSON(res, 413, { error: 'body too large' });
    let obj = null;
    try { obj = body ? JSON.parse(body) : {}; }
    catch (e) { return sendJSON(res, 400, { error: 'bad json' }); }
    fn(obj);
  });
}
function serveFile(res, file, cacheable) {
  fs.readFile(file, (err, buf) => {
    if (err) return sendText(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': cacheable ? 'public, max-age=60' : 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- word admin
function findWord(id) { return store.db.words.find((w) => w.id === String(id)); }

function parseImport(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed[0] === '[') {
    let arr;
    try { arr = JSON.parse(trimmed); } catch (e) { throw new Error('That is not valid JSON'); }
    if (!Array.isArray(arr)) throw new Error('JSON must be an array');
    return arr.map((w) => ({
      word: String(w.word || '').trim(),
      hint: String(w.hint || '').trim(),
      aliases: Array.isArray(w.aliases) ? w.aliases.map(String) : [],
      tags: Array.isArray(w.tags) ? w.tags.map(String) : [],
      enabled: w.enabled !== false
    })).filter((w) => w.word);
  }
  // plain lines:  Word | hint | alias, alias | tag, tag   (commas only, so a tag may contain spaces)
  return trimmed.split(/\r?\n/).map((line) => {
    const parts = line.split('|').map((s) => s.trim());
    if (!parts[0]) return null;
    return {
      word: parts[0],
      hint: parts[1] || '',
      aliases: parts[2] ? parts[2].split(',').map((s) => s.trim()).filter(Boolean) : [],
      tags: parts[3] ? parts[3].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [],
      enabled: true
    };
  }).filter(Boolean);
}

// ---------------------------------------------------------------- routes
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (e) { return sendText(res, 400, 'Bad request'); }
  const p = url.pathname;
  const method = req.method || 'GET';

  // ---- public API
  if (p === '/api/config' && method === 'GET') {
    return sendJSON(res, 200, {
      site: SITE_NAME,
      canvas: { w: CANVAS_W, h: CANVAS_H },
      unitDb: UNIT_DB_URL,
      defaults: store.defaults(),
      filterGroups: store.filterGroups(),
      tagCounts: store.tagCounts(),
      words: store.enabledWords().length,
      drawings: gallery.count(),
      soloRounds: ROUNDS
    });
  }
  if (p === '/api/rooms' && method === 'GET') {
    return sendJSON(res, 200, { rooms: mgr.publicRooms() });
  }
  // ---- single player challenge
  if (p.indexOf('/api/solo/') === 0) {
    if (p === '/api/solo/highscores' && method === 'GET') {
      return sendJSON(res, 200, { best: solo.top(20), drawings: gallery.count(), rounds: ROUNDS });
    }
    if (p === '/api/solo/start' && method === 'POST') {
      const ip = ipOf(req);
      const hit = soloStarts.get(ip);
      if (hit && hit.n >= 20 && hit.until > Date.now()) return sendJSON(res, 429, { error: 'Too many runs, wait a few minutes' });
      const cur = (hit && hit.until > Date.now()) ? hit : { n: 0, until: Date.now() + 10 * 60 * 1000 };
      cur.n++;
      soloStarts.set(ip, cur);
      return readJSON(req, res, (b) => {
        const s = solo.start(b.name);
        if (!s) return sendJSON(res, 409, { error: 'There are not enough saved drawings yet. Play a few rounds first.' });
        return sendJSON(res, 200, Object.assign({ sid: s.id }, solo.round(s)));
      });
    }
    if (method !== 'POST') return sendJSON(res, 404, { error: 'Unknown endpoint' });
    return readJSON(req, res, (b) => {
      const s = solo.get(b.sid);
      if (!s) return sendJSON(res, 404, { error: 'That run has expired, start a new one' });
      if (p === '/api/solo/guess') return sendJSON(res, 200, solo.guess(s, b.guess));
      if (p === '/api/solo/timeup') return sendJSON(res, 200, solo.timeUp(s));
      // The next drawing's clock only starts when the browser asks for it, so the
      // few seconds of "that was a Cybran Mantis" between rounds are not on the player.
      if (p === '/api/solo/next') return sendJSON(res, 200, solo.round(s));
      if (p === '/api/solo/hint') return sendJSON(res, 200, solo.hint(s));
      // The same unit look-up the lobby has. It searches notes and tags only and never the
      // word list wholesale, so it cannot be used to pull the run's answers out of the server.
      if (p === '/api/solo/lookup') {
        const t = Date.now();
        s.lkStamps = (s.lkStamps || []).filter((x) => t - x < 4000);
        if (s.lkStamps.length >= 15) return sendJSON(res, 200, { q: '', results: [], busy: true });
        s.lkStamps.push(t);
        return sendJSON(res, 200, store.lookup(b.q));
      }
      if (p === '/api/solo/finish') return sendJSON(res, 200, solo.finish(s, b.name));
      return sendJSON(res, 404, { error: 'Unknown endpoint' });
    });
  }

  if (p === '/api/health' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, rooms: mgr.rooms.size, words: store.db.words.length, uptime: Math.round(process.uptime()) });
  }

  // ---- admin API
  if (p === '/api/admin/login' && method === 'POST') {
    const ip = ipOf(req);
    const hit = loginHits.get(ip);
    if (hit && hit.n >= 8 && hit.until > Date.now()) return sendJSON(res, 429, { error: 'Too many attempts, wait a few minutes' });
    return readJSON(req, res, (body) => {
      if (samePassword(body.password)) {
        loginHits.delete(ip);
        return sendJSON(res, 200, { token: issueAdminToken() });
      }
      const cur = loginHits.get(ip) || { n: 0, until: 0 };
      cur.n++; cur.until = Date.now() + 15 * 60 * 1000;
      loginHits.set(ip, cur);
      return sendJSON(res, 401, { error: 'Wrong password' });
    });
  }

  if (p.indexOf('/api/admin/') === 0) {
    if (!isAdmin(req)) return sendJSON(res, 401, { error: 'Not logged in' });

    if (p === '/api/admin/state' && method === 'GET') {
      return sendJSON(res, 200, {
        words: store.db.words,
        defaults: store.defaults(),
        rooms: mgr.adminView(),
        filterGroups: store.filterGroups(),
        tagCounts: store.tagCounts()
      });
    }
    if (p === '/api/admin/drawings' && method === 'GET') {
      const limit = Math.min(120, Math.max(1, Number(url.searchParams.get('limit')) || 40));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      return sendJSON(res, 200, { total: gallery.count(), cap: MAX_DRAWINGS, drawings: gallery.recent(limit, offset) });
    }
    if (p === '/api/admin/drawings/one' && method === 'GET') {
      const d = gallery.get(url.searchParams.get('id'));
      if (!d) return sendJSON(res, 404, { error: 'No such drawing' });
      return sendJSON(res, 200, { drawing: d });
    }
    if (p === '/api/admin/drawings' && method === 'DELETE') {
      return readJSON(req, res, (b) => {
        const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
        let n = 0;
        for (const id of ids) if (gallery.remove(id)) n++;
        return sendJSON(res, 200, { removed: n, total: gallery.count() });
      });
    }
    if (p === '/api/admin/drawings/clear' && method === 'POST') {
      return sendJSON(res, 200, { removed: gallery.clear() });
    }
    if (p === '/api/admin/highscores/clear' && method === 'POST') {
      const n = solo.scores.length;
      solo.scores = [];
      solo.saveScores();
      return sendJSON(res, 200, { removed: n });
    }
    if (p === '/api/admin/icons' && method === 'GET') {
      let custom = [];
      try {
        custom = fs.readdirSync(store.iconDir)
          .filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
          .sort()
          .map((f) => 'custom/' + f);
      } catch (e) { custom = []; }
      return sendJSON(res, 200, {
        builtin: store.builtinIconNames().sort().map((f) => 'units/' + f),
        custom: custom
      });
    }
    if (p === '/api/admin/icons/upload' && method === 'POST') {
      return readJSON(req, res, (b) => {
        const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(b.dataUrl || ''));
        if (!m) return sendJSON(res, 400, { error: 'That is not a PNG, JPG, GIF or WEBP image' });
        let buf;
        try { buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64'); }
        catch (e) { return sendJSON(res, 400, { error: 'Could not decode the image' }); }
        if (!buf.length) return sendJSON(res, 400, { error: 'Empty image' });
        if (buf.length > MAX_ICON_BYTES) return sendJSON(res, 413, { error: 'Images must be under 2 MB' });
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const base = String(b.name || 'icon').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'icon';
        const file = base + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
        try { fs.writeFileSync(store.customIconPath(file), buf); }
        catch (e) { return sendJSON(res, 500, { error: 'Could not save the image' }); }
        return sendJSON(res, 200, { icon: 'custom/' + file });
      });
    }
    if (p === '/api/admin/icons/refill' && method === 'POST') {
      let cleared = 0;
      for (const w of store.db.words) {
        if (w.icon === '') { delete w.icon; cleared++; }
      }
      const filled = store.fillIcons();
      store.save();
      return sendJSON(res, 200, { checked: cleared, filled: filled });
    }
    if (p === '/api/admin/words' && method === 'POST') {
      return readJSON(req, res, (b) => {
        const word = String(b.word || '').trim();
        if (!word) return sendJSON(res, 400, { error: 'Word cannot be empty' });
        const w = {
          id: store.nextId(),
          word: word.slice(0, 60),
          hint: String(b.hint || '').trim().slice(0, 120),
          aliases: Array.isArray(b.aliases) ? b.aliases.map((s) => String(s).trim()).filter(Boolean).slice(0, 12) : [],
          tags: Array.isArray(b.tags) ? b.tags.map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 12) : [],
          enabled: b.enabled !== false
        };
        if (typeof b.icon === 'string') w.icon = Store.validIcon(b.icon) ? b.icon : '';
        else { const hit = store.iconMap[Store.iconKey(w.word)]; w.icon = hit || ''; }
        store.db.words.push(w);
        store.save();
        return sendJSON(res, 200, { word: w });
      });
    }
    if (p === '/api/admin/words' && method === 'PUT') {
      return readJSON(req, res, (b) => {
        const w = findWord(b.id);
        if (!w) return sendJSON(res, 404, { error: 'No such word' });
        if ('word' in b) {
          const nw = String(b.word || '').trim();
          if (!nw) return sendJSON(res, 400, { error: 'Word cannot be empty' });
          w.word = nw.slice(0, 60);
        }
        if ('hint' in b) w.hint = String(b.hint || '').trim().slice(0, 120);
        if ('aliases' in b) w.aliases = (Array.isArray(b.aliases) ? b.aliases : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
        if ('tags' in b) w.tags = (Array.isArray(b.tags) ? b.tags : []).map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 12);
        if ('enabled' in b) w.enabled = !!b.enabled;
        if ('icon' in b) {
          const v = String(b.icon || '');
          if (v && !Store.validIcon(v)) return sendJSON(res, 400, { error: 'That is not a valid icon' });
          if (v.indexOf('units/') === 0 && !store.hasBuiltinIcon(v.slice(6))) {
            return sendJSON(res, 400, { error: 'No such icon in the unit database' });
          }
          w.icon = v;
        }
        store.save();
        return sendJSON(res, 200, { word: w });
      });
    }
    if (p === '/api/admin/words' && method === 'DELETE') {
      return readJSON(req, res, (b) => {
        const ids = Array.isArray(b.ids) ? b.ids.map(String) : (b.id ? [String(b.id)] : []);
        const before = store.db.words.length;
        store.db.words = store.db.words.filter((w) => ids.indexOf(w.id) === -1);
        store.save();
        return sendJSON(res, 200, { removed: before - store.db.words.length });
      });
    }
    if (p === '/api/admin/words/bulk' && method === 'POST') {
      return readJSON(req, res, (b) => {
        const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
        const set = new Set(ids);
        let n = 0;
        if (b.action === 'enable' || b.action === 'disable') {
          for (const w of store.db.words) if (set.has(w.id)) { w.enabled = b.action === 'enable'; n++; }
        } else if (b.action === 'tag' || b.action === 'untag') {
          const tag = String(b.tag || '').trim().toLowerCase();
          if (!tag) return sendJSON(res, 400, { error: 'No tag given' });
          for (const w of store.db.words) {
            if (!set.has(w.id)) continue;
            const has = w.tags.indexOf(tag) !== -1;
            if (b.action === 'tag' && !has) { w.tags.push(tag); n++; }
            if (b.action === 'untag' && has) { w.tags = w.tags.filter((t) => t !== tag); n++; }
          }
        } else {
          return sendJSON(res, 400, { error: 'Unknown action' });
        }
        store.save();
        return sendJSON(res, 200, { changed: n });
      });
    }
    if (p === '/api/admin/words/import' && method === 'POST') {
      return readJSON(req, res, (b) => {
        let items;
        try { items = parseImport(b.text); }
        catch (e) { return sendJSON(res, 400, { error: e.message }); }
        if (!items.length) return sendJSON(res, 400, { error: 'Nothing to import' });
        // Import only ever adds. There is deliberately no mode that wipes the list:
        // everyone with the admin password would be one click away from destroying it.
        const have = new Set(store.db.words.map((w) => w.word.toLowerCase()));
        let added = 0, skipped = 0;
        for (const it of items) {
          if (have.has(it.word.toLowerCase())) { skipped++; continue; }
          have.add(it.word.toLowerCase());
          store.db.words.push(Object.assign({ id: store.nextId() }, it));
          added++;
        }
        store.save();
        return sendJSON(res, 200, { added: added, skipped: skipped });
      });
    }
    if (p === '/api/admin/export' && method === 'GET') {
      const body = JSON.stringify(store.db.words, null, 1);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="fafscribbl-words.json"',
        'Content-Length': Buffer.byteLength(body)
      });
      return res.end(body);
    }
    if (p === '/api/admin/filters' && method === 'POST') {
      return readJSON(req, res, (b) => {
        if (!Array.isArray(b.groups)) return sendJSON(res, 400, { error: 'Expected a list of groups' });
        const groups = store.normalizeGroups(b.groups);
        if (!groups.length) return sendJSON(res, 400, { error: 'At least one group is needed' });
        store.db.filterGroups = groups;
        store.save();
        return sendJSON(res, 200, { filterGroups: groups });
      });
    }
    if (p === '/api/admin/defaults' && method === 'POST') {
      return readJSON(req, res, (b) => {
        store.db.defaults = sanitizeSettings(b, store.db.defaults, store.filterGroups());
        store.save();
        return sendJSON(res, 200, { defaults: store.defaults() });
      });
    }
    if (p === '/api/admin/rooms/close' && method === 'POST') {
      return readJSON(req, res, (b) => sendJSON(res, 200, { closed: mgr.close(b.code) }));
    }
    return sendJSON(res, 404, { error: 'Unknown admin endpoint' });
  }

  // ---- the shipped unit icons come out of one bundled file
  if (p.indexOf('/icons/units/') === 0 && (method === 'GET' || method === 'HEAD')) {
    const name = decodeURIComponent(p.slice('/icons/units/'.length));
    const buf = /^[A-Za-z0-9._-]{1,80}$/.test(name) ? store.builtinIcon(name) : null;
    if (!buf) return sendText(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff'
    });
    return method === 'HEAD' ? res.end() : res.end(buf);
  }

  // ---- uploaded icons live in the data volume, not in the repo
  if (p.indexOf('/icons/custom/') === 0 && (method === 'GET' || method === 'HEAD')) {
    const name = decodeURIComponent(p.slice('/icons/custom/'.length));
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) return sendText(res, 400, 'Bad name');
    return serveFile(res, store.customIconPath(name), true);
  }

  // ---- static
  if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
  if (p === '/' || /^\/r\/[A-Za-z0-9]{1,12}\/?$/.test(p)) return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), false);
  if (p === '/solo' || p === '/solo/') return serveFile(res, path.join(PUBLIC_DIR, 'solo.html'), false);
  if (p === '/admin' || p === '/admin/') return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'), false);

  const rel = path.normalize(decodeURIComponent(p)).replace(/^(\.\.[\/\\])+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (file.indexOf(PUBLIC_DIR) !== 0) return sendText(res, 403, 'Forbidden');
  return serveFile(res, file, true);
});

// ---------------------------------------------------------------- websocket
ws.attach(server, {
  path: '/ws',
  onConnection: (conn) => {
    let room = null;
    let player = null;

    const hello = setTimeout(() => { if (!player) conn.close(4000, 'no hello'); }, 12000);

    conn.on('close', () => {
      clearTimeout(hello);
      if (room && player) room.detach(player, conn);
    });

    conn.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;

      if (m.t === 'hello') {
        if (player) return;
        clearTimeout(hello);
        // rejoin with an existing session token
        if (m.token) {
          const found = mgr.resolve(String(m.token));
          if (found && (!m.code || found.room.code === String(m.code).toUpperCase())) {
            room = found.room;
            player = found.player;
            room.attach(player, conn);
            conn.sendJSON({ t: 'joined', token: player.token, code: room.code, you: player.id, rejoined: true });
            room.system(player.name + ' reconnected', 'join');
            room.pushState();
            room.pushPlayers();
            return;
          }
        }
        if (m.create) {
          room = mgr.create(m.settings || {});
        } else {
          room = mgr.get(m.code);
          if (!room) return conn.sendJSON({ t: 'error', code: 'noroom', message: 'That lobby does not exist any more.' });
          const max = room.settings.maxPlayers;
          if (max && room.alive().length >= max) return conn.sendJSON({ t: 'error', code: 'full', message: 'That lobby is full.' });
        }
        player = room.addPlayer(m.name, conn);
        mgr.register(room, player);
        conn.sendJSON({ t: 'joined', token: player.token, code: room.code, you: player.id, created: !!m.create });
        room.system(player.name + ' joined', 'join');
        room.pushState();
        room.pushPlayers();
        return;
      }

      if (!room || !player) return;
      player.lastSeen = Date.now();
      room.touched = Date.now();

      switch (m.t) {
        case 'chat': room.handleChat(player, m.text); break;
        case 'draw': room.handleDraw(player, m.ops); break;
        case 'begin': room.handleBegin(player); break;
        case 'undo': room.handleUndo(player); break;
        case 'clearCanvas': room.handleClear(player); break;
        case 'pick': room.pick(player.id, m.index, false); break;
        case 'start': room.start(player.id); break;
        case 'settings': room.updateSettings(player.id, m.settings); break;
        case 'kick': room.kick(player.id, String(m.id || '')); break;
        case 'skip': room.skip(player.id); break;
        case 'pause': room.pause(player.id, m.on); break;
        case 'lobby': room.backToLobby(player.id); break;
        case 'lookup': room.handleLookup(player, m.q); break;
        case 'sync': conn.sendJSON(room.stateFor(player)); break;
        case 'ping': conn.sendJSON({ t: 'pong', now: Date.now() }); break;
        default: break;
      }
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log('[fafscribbl] listening on http://' + HOST + ':' + PORT);
});

process.on('uncaughtException', (e) => console.error('[fafscribbl] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[fafscribbl] unhandled rejection', e));
