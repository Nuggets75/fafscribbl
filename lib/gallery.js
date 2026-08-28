'use strict';
// Saved drawings. One gzipped file per drawing plus a small index kept in memory,
// so writing a drawing costs one small write and nothing is ever rewritten wholesale.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAX_DRAWINGS = Number(process.env.FAFSCRIBBL_MAX_DRAWINGS || 1000);
const MIN_OPS = Number(process.env.FAFSCRIBBL_MIN_OPS || 15);

class Gallery {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'drawings');
    this.indexFile = path.join(this.dir, 'index.json');
    this.index = [];        // newest last: { id, word, at, ops, drawer }
    this._writing = false;
    this._again = false;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      this.index = Array.isArray(raw) ? raw.filter((d) => d && d.id && d.word) : [];
    } catch (e) { this.index = []; }
    // drop entries whose file went missing, so a half deleted volume cannot break solo mode
    this.index = this.index.filter((d) => fs.existsSync(this.fileOf(d.id)));
    this.adopt();
    this.prune();
    console.log('[gallery] ' + this.index.length + ' saved drawings');
    return this.index.length;
  }

  fileOf(id) { return path.join(this.dir, id + '.json.gz'); }

  // The index is written asynchronously, so a hard kill right after a save can lose the
  // last line of it while the drawing itself is safely on disk. Pick those up on boot
  // rather than quietly throwing the drawing away.
  adopt() {
    let files;
    try { files = fs.readdirSync(this.dir); } catch (e) { return 0; }
    const have = new Set(this.index.map((d) => d.id));
    const found = [];
    for (const f of files) {
      if (!/^[a-z0-9]{1,32}\.json\.gz$/.test(f)) continue;
      const id = f.slice(0, -8);
      if (have.has(id)) continue;
      const body = this.get(id);
      if (!body || !body.word || !Array.isArray(body.ops)) {
        try { fs.unlinkSync(path.join(this.dir, f)); } catch (e2) { /* ignore */ }
        continue;
      }
      found.push({ id: id, word: body.word, at: body.at || 0, ops: body.ops.length, drawer: body.drawer || '' });
    }
    if (!found.length) return 0;
    this.index = this.index.concat(found).sort((a, b) => a.at - b.at);
    this.saveIndex();
    console.log('[gallery] recovered ' + found.length + ' drawing(s) missing from the index');
    return found.length;
  }

  // Blank pages are not worth keeping and would be unguessable in the challenge.
  worthKeeping(ops) { return Array.isArray(ops) && ops.length >= MIN_OPS; }

  save(entry) {
    if (!this.worthKeeping(entry.ops)) return null;
    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const body = {
      id: id,
      word: String(entry.word || ''),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.map(String) : [],
      hint: String(entry.hint || ''),
      icon: String(entry.icon || ''),
      drawer: String(entry.drawer || ''),
      at: Date.now(),
      ops: entry.ops
    };
    if (!body.word) return null;
    try {
      fs.writeFileSync(this.fileOf(id), zlib.gzipSync(Buffer.from(JSON.stringify(body)), { level: 6 }));
    } catch (e) {
      console.error('[gallery] could not save a drawing', e.message);
      return null;
    }
    this.index.push({ id: id, word: body.word, at: body.at, ops: entry.ops.length, drawer: body.drawer });
    this.prune();
    this.saveIndex();
    return id;
  }

  prune() {
    while (this.index.length > MAX_DRAWINGS) {
      const gone = this.index.shift();
      try { fs.unlinkSync(this.fileOf(gone.id)); } catch (e) { /* already gone */ }
    }
  }

  get(id) {
    if (!/^[a-z0-9]{1,32}$/.test(String(id || ''))) return null;
    try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(this.fileOf(id))).toString('utf8')); }
    catch (e) { return null; }
  }

  remove(id) {
    const i = this.index.findIndex((d) => d.id === id);
    if (i === -1) return false;
    this.index.splice(i, 1);
    try { fs.unlinkSync(this.fileOf(id)); } catch (e) { /* already gone */ }
    this.saveIndex();
    return true;
  }

  clear() {
    const n = this.index.length;
    for (const d of this.index) { try { fs.unlinkSync(this.fileOf(d.id)); } catch (e) { /* ignore */ } }
    this.index = [];
    this.saveIndex();
    return n;
  }

  count() { return this.index.length; }

  recent(limit, offset) {
    const list = this.index.slice().reverse();
    return list.slice(offset || 0, (offset || 0) + (limit || 50));
  }

  // n distinct random drawings, preferring different words so a run is not the same unit twice
  pick(n) {
    const pool = this.index.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    const out = [];
    const seenWord = new Set();
    for (const d of pool) {
      const key = d.word.toLowerCase();
      if (seenWord.has(key)) continue;
      seenWord.add(key);
      out.push(d.id);
      if (out.length >= n) break;
    }
    for (const d of pool) {
      if (out.length >= n) break;
      if (out.indexOf(d.id) === -1) out.push(d.id);
    }
    return out;
  }

  saveIndex() {
    if (this._writing) { this._again = true; return; }
    this._writing = true;
    const tmp = this.indexFile + '.tmp';
    fs.writeFile(tmp, JSON.stringify(this.index), (err) => {
      if (err) { this._writing = false; console.error('[gallery] index write failed', err.message); return; }
      fs.rename(tmp, this.indexFile, (e2) => {
        this._writing = false;
        if (e2) console.error('[gallery] index rename failed', e2.message);
        if (this._again) { this._again = false; this.saveIndex(); }
      });
    });
  }
}

module.exports = { Gallery, MAX_DRAWINGS, MIN_OPS };
