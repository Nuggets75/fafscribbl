'use strict';
// JSON file storage. One file, held in memory, written atomically.
const fs = require('fs');
const path = require('path');

// The chip rows a host sees in the lobby. Fully editable in the admin tab.
// Tags are opt in and additive: a word is in play if it carries any selected tag.
const DEFAULT_FILTER_GROUPS = [
  { id: 'faction', label: 'Factions', tags: ['uef', 'cybran', 'aeon', 'seraphim', 'nomads'] },
  { id: 'kind', label: 'Unit types', tags: ['land', 'air', 'naval', 'structure', 'experimental'] }
];

const DEFAULT_SETTINGS = {
  rounds: 3,
  drawTime: 80,        // seconds, 0 = no timer
  maxPlayers: 0,       // 0 = unlimited
  hints: true,
  hintCount: 2,
  wordChoices: 3,      // 1 = word is assigned, no picking
  choiceTime: 20,
  isPublic: false,
  customWords: '',
  customWordsOnly: false,
  lookup: true,        // the unit look-up box in the corner
  previews: true,      // the drawer may see a picture of the unit
  tagFilters: {}       // { groupId: [tag, ...] }, empty or missing = no filter
};

const ICON_RE = /^(units|custom)\/[A-Za-z0-9._-]{1,80}\.(png|jpg|jpeg|gif|webp)$/;
const LK_CTRL = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

class Store {
  constructor(dataDir, seedFile, iconMapFile, iconBundleFile) {
    this.dir = dataDir;
    this.iconDir = path.join(dataDir, 'icons');
    this.file = path.join(dataDir, 'fafscribbl.json');
    this.seedFile = seedFile;
    this.iconMapFile = iconMapFile;
    this.iconBundleFile = iconBundleFile;
    this.iconMap = {};
    this.iconBundle = {};   // name -> base64, one repo file so it uploads in one drag
    this.iconCache = new Map();
    this.db = null;
    this._writing = false;
    this._again = false;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.iconDir, { recursive: true });
    try { this.iconMap = JSON.parse(fs.readFileSync(this.iconMapFile, 'utf8')); }
    catch (e) { this.iconMap = {}; console.warn('[store] no icon map: ' + e.message); }
    try { this.iconBundle = JSON.parse(fs.readFileSync(this.iconBundleFile, 'utf8')); }
    catch (e) { this.iconBundle = {}; console.warn('[store] no icon bundle: ' + e.message); }
    let db = null;
    if (fs.existsSync(this.file)) {
      try {
        db = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (e) {
        const bak = this.file + '.corrupt.' + Date.now();
        console.error('[store] could not parse db, moving it to ' + bak, e.message);
        try { fs.renameSync(this.file, bak); } catch (e2) { /* ignore */ }
        db = null;
      }
    }
    if (!db || typeof db !== 'object') db = {};
    if (!Array.isArray(db.words) || db.words.length === 0) db.words = this.seedWords();
    if (!db.defaults || typeof db.defaults !== 'object') db.defaults = {};
    db.defaults = Object.assign({}, DEFAULT_SETTINGS, db.defaults);
    if (typeof db.seq !== 'number') db.seq = db.words.length + 1;
    db.filterGroups = this.normalizeGroups(db.filterGroups);
    db.defaults = this.migrateSettings(db.defaults);
    db.words = db.words.map((w, i) => this.normalizeWord(w, i));
    this.db = db;
    this.fillIcons();
    this.save();
    return db;
  }

  // Old saves carried settings.factions / settings.kinds. Fold them into tagFilters once.
  migrateSettings(s) {
    const out = Object.assign({}, s);
    if (!out.tagFilters || typeof out.tagFilters !== 'object' || Array.isArray(out.tagFilters)) out.tagFilters = {};
    if (Array.isArray(s.factions) && s.factions.length && !out.tagFilters.faction) out.tagFilters.faction = s.factions.slice();
    if (Array.isArray(s.kinds) && s.kinds.length && !out.tagFilters.kind) out.tagFilters.kind = s.kinds.slice();
    delete out.factions;
    delete out.kinds;
    return out;
  }

  normalizeGroups(groups) {
    if (!Array.isArray(groups) || !groups.length) {
      return DEFAULT_FILTER_GROUPS.map((g) => Object.assign({}, g, { tags: g.tags.slice() }));
    }
    const seen = new Set();
    const out = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      const label = String(g.label || '').trim().slice(0, 40);
      if (!label) continue;
      let id = String(g.id || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
      if (!id) id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || ('g' + (out.length + 1));
      while (seen.has(id)) id = id + '2';
      seen.add(id);
      const tags = (Array.isArray(g.tags) ? g.tags : [])
        .map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 40);
      const uniq = [];
      for (const t of tags) if (uniq.indexOf(t) === -1) uniq.push(t);
      out.push({ id: id, label: label, tags: uniq });
      if (out.length >= 8) break;
    }
    return out.length ? out : DEFAULT_FILTER_GROUPS.map((g) => Object.assign({}, g, { tags: g.tags.slice() }));
  }

  filterGroups() { return this.db.filterGroups; }

  // How many enabled words carry each tag, for the admin editor and the lobby chips.
  tagCounts() {
    const out = {};
    for (const w of this.enabledWords()) {
      for (const t of w.tags) out[t] = (out[t] || 0) + 1;
    }
    return out;
  }

  seedWords() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.seedFile, 'utf8'));
      return raw.map((w, i) => this.normalizeWord(w, i));
    } catch (e) {
      console.error('[store] seed word list missing or unreadable', e.message);
      return [];
    }
  }

  normalizeWord(w, i) {
    const out = {
      id: String(w.id || ('w' + (i + 1))),
      word: String(w.word || '').trim(),
      hint: String(w.hint || '').trim(),
      aliases: Array.isArray(w.aliases) ? w.aliases.map(String).filter(Boolean) : [],
      tags: Array.isArray(w.tags) ? w.tags.map(String).filter(Boolean) : [],
      enabled: w.enabled !== false
    };
    // `icon` missing means "never looked at", which is what lets the shipped map fill it in.
    // An empty string means somebody deliberately cleared it, and is left alone.
    if (typeof w.icon === 'string') out.icon = Store.validIcon(w.icon) ? w.icon : '';
    return out;
  }

  static validIcon(v) { return typeof v === 'string' && ICON_RE.test(v); }

  static iconKey(word) {
    return String(word == null ? '' : word)
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  // Give every word that has never had an icon the one from the shipped unit database.
  // Runs on every boot, so a word added later picks its icon up on the next restart.
  fillIcons() {
    let n = 0;
    for (const w of this.db.words) {
      if (typeof w.icon === 'string') continue;
      const hit = this.iconMap[Store.iconKey(w.word)];
      w.icon = hit || '';
      if (hit) n++;
    }
    if (n) console.log('[store] matched ' + n + ' words to a unit icon');
    return n;
  }

  nextId() {
    this.db.seq = (this.db.seq || 0) + 1;
    return 'w' + this.db.seq;
  }

  save() {
    if (this._writing) { this._again = true; return; }
    this._writing = true;
    const tmp = this.file + '.tmp';
    const body = JSON.stringify(this.db, null, 1);
    fs.writeFile(tmp, body, (err) => {
      if (err) {
        this._writing = false;
        console.error('[store] write failed', err.message);
        return;
      }
      fs.rename(tmp, this.file, (err2) => {
        this._writing = false;
        if (err2) console.error('[store] rename failed', err2.message);
        if (this._again) { this._again = false; this.save(); }
      });
    });
  }

  enabledWords() { return this.db.words.filter((w) => w.enabled && w.word); }

  // The unit look-up. Searches the admin notes and the tags, never the word list wholesale,
  // so a client cannot pull the answers out of it. Map entries are excluded on purpose: this
  // is for learning unit names. Shared by the lobby (over the socket) and the single player
  // challenge (over HTTP), so both behave identically.
  lookup(raw, limit) {
    const q = String(raw == null ? '' : raw).replace(LK_CTRL, '').trim().slice(0, 60);
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return { q: q, results: [] };
    const cap = limit || 14;
    const out = [];
    for (const w of this.enabledWords()) {
      if (w.tags.some((t) => t.indexOf('map') !== -1)) continue;
      const hay = (w.hint + ' ' + w.tags.join(' ')).toLowerCase();
      if (!terms.every((t) => hay.indexOf(t) !== -1)) continue;
      out.push({ word: w.word, hint: w.hint, icon: w.icon || '' });
      if (out.length >= cap) break;
    }
    return { q: q, results: out };
  }
  customIconPath(file) { return path.join(this.iconDir, file); }
  builtinIconNames() { return Object.keys(this.iconBundle); }
  hasBuiltinIcon(name) { return Object.prototype.hasOwnProperty.call(this.iconBundle, name); }
  builtinIcon(name) {
    if (!this.hasBuiltinIcon(name)) return null;
    let buf = this.iconCache.get(name);
    if (!buf) {
      buf = Buffer.from(this.iconBundle[name], 'base64');
      if (this.iconCache.size > 600) this.iconCache.clear();
      this.iconCache.set(name, buf);
    }
    return buf;
  }
  defaults() { return Object.assign({}, this.db.defaults); }
}

module.exports = { Store, DEFAULT_SETTINGS, DEFAULT_FILTER_GROUPS, ICON_RE };
