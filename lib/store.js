'use strict';
// JSON file storage. One file, held in memory, written atomically.
const fs = require('fs');
const path = require('path');

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
  factions: [],        // empty = all
  kinds: []            // empty = all
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
    db.words = db.words.map((w, i) => this.normalizeWord(w, i));
    this.db = db;
    this.save();
    return db;
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

module.exports = { Store, DEFAULT_SETTINGS };
