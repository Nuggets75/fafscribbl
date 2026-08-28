'use strict';
// Word normalisation, matching and "close guess" detection.

// Fold to a comparable form: lowercase, strip accents, drop everything that is
// not a letter or digit. So "Sou-atha" === "sou atha" === "SOUATHA".
function normalize(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Levenshtein distance with an early-out ceiling.
function distance(a, b, max) {
  if (a === b) return 0;
  if (max == null) max = Infinity;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (!la) return lb;
  if (!lb) return la;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let best = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      let v = prev[j - 1] + cost;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      if (del < v) v = del;
      if (ins < v) v = ins;
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    const t = prev; prev = cur; cur = t;
  }
  return prev[lb];
}

// How many wrong letters still counts as "close".
function closeThreshold(len) {
  if (len <= 4) return 1;
  if (len <= 10) return 1;
  return 2;
}

// Every accepted spelling of a word entry.
function acceptedForms(entry) {
  const out = [normalize(entry.word)];
  const al = entry.aliases || [];
  for (const a of al) {
    const n = normalize(a);
    if (n && out.indexOf(n) === -1) out.push(n);
  }
  return out.filter(Boolean);
}

// 'exact' | 'close' | 'no'
function checkGuess(guess, entry) {
  const g = normalize(guess);
  if (!g) return 'no';
  const forms = acceptedForms(entry);
  for (const f of forms) if (f === g) return 'exact';
  let closest = Infinity;
  for (const f of forms) {
    const thr = closeThreshold(f.length);
    const d = distance(g, f, thr);
    if (d <= thr && d < closest) closest = d;
  }
  return closest !== Infinity ? 'close' : 'no';
}

// Does a drawer's chat message leak the answer?
function leaks(text, entry) {
  const t = normalize(text);
  if (!t) return false;
  for (const f of acceptedForms(entry)) {
    if (f.length >= 3 && t.indexOf(f) !== -1) return true;
    if (distance(t, f, 1) <= 1) return true;
  }
  return false;
}

// Mask a word for guessers: letters/digits hidden, everything else shown.
function maskOf(word, revealedIdx) {
  const set = revealedIdx || [];
  const out = [];
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (/[a-z0-9]/i.test(ch)) out.push(set.indexOf(i) !== -1 ? ch : '_');
    else out.push(ch);
  }
  return out.join('');
}

function hideableIndexes(word) {
  const out = [];
  for (let i = 0; i < word.length; i++) if (/[a-z0-9]/i.test(word[i])) out.push(i);
  return out;
}

module.exports = { normalize, distance, checkGuess, leaks, maskOf, hideableIndexes, acceptedForms, closeThreshold };
