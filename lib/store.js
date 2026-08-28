'use strict';
// JSON file storage. One file, held in memory, written atomically.
const fs = require('fs');
const path = require('path');

// The chip rows a host sees in the lobby. Fully editable in the admin tab.
// `always` names a tag whose words bypass that group entirely: faction-less words
// (mexes, pgens, radar) belong to every faction, so a faction filter never drops them.
const DEFAULT_FILTER_GROUPS = [
  { id: 'faction', label: 'Factions', tags: ['uef', 'cybran', 'aeon', 'seraphim', 'nomads'], always: 'neutral' },
  { id: 'kind', label: 'Unit types', tags: ['land', 'air', 'naval', 'structure', 'experimental'], always: '' }
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
  tagFilters: {}       // { groupId: [tag, ...] }, empty or missing = no filter
};

class Store {
  constructor(dataDir, seedFile) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'fafscribbl.json');
    this.seedFile = seedFile;
    this.db = null;
    this._writing = false;
    this._again = false;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
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
      out.push({ id: id, label: label, tags: uniq, always: String(g.always || '').trim().toLowerCase().slice(0, 24) });
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
    return {
      id: String(w.id || ('w' + (i + 1))),
      word: String(w.word || '').trim(),
      hint: String(w.hint || '').trim(),
      aliases: Array.isArray(w.aliases) ? w.aliases.map(String).filter(Boolean) : [],
      tags: Array.isArray(w.tags) ? w.tags.map(String).filter(Boolean) : [],
      enabled: w.enabled !== false
    };
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
  defaults() { return Object.assign({}, this.db.defaults); }
}

module.exports = { Store, DEFAULT_SETTINGS, DEFAULT_FILTER_GROUPS };
