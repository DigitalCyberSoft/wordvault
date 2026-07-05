#!/usr/bin/env node
/*
 * validate-sets.js - the content hard gate. Run: node tools/validate-sets.js
 *
 * Validates every authored set under sets/{A,B,C}/ against gates M1-M18 (see
 * the build plan; gates G1-G8 live in tools/audit-glosses.py, whose freshness
 * stamp is verified here as M13, and G9 uniqueness verdicts are verified as
 * M14). Two lanes, mirroring pizzashop's validate-orders.js:
 *   - HARD failures: the corpus must not bake; exit non-zero.
 *   - REVIEW items: legal to bake, listed for human eyes in reference/REVIEW.md.
 * No skips, no soft passes, no swallowed errors.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var Core = require('../game-core.js');

var ROOT = path.join(__dirname, '..');
var SETS_DIR = path.join(ROOT, 'sets');
var STAMP = path.join(ROOT, 'reference', 'stamps', 'gloss-audit.json');
var UNIQ_DIR = path.join(ROOT, 'reference', 'uniqueness');

var hard = [], review = [];
function H(setId, gate, msg) { hard.push({ set: setId, gate: gate, msg: msg }); }
function R(setId, gate, msg) { review.push({ set: setId, gate: gate, msg: msg }); }

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function words(text) { return (text.toLowerCase().match(/[a-z']+/g) || []); }
var STOP = {};
('a an the and or but of to in on at for with as by from is are was were be been being it its this that these those ' +
 'through over under into onto along toward towards past around about before after again out up down off very ' +
 "one one's some any all no not so such when while where who whom whose which what o'clock s t").split(' ')
  .forEach(function (w) { STOP[w] = 1; });
function contentWords(text) { return words(text).filter(function (w) { return !STOP[w] && w.length > 2; }); }

// every inflection we know for a member: forms table + the headword itself
function memberForms(w) {
  var out = [w.w.toLowerCase()];
  Object.keys(w.forms || {}).forEach(function (k) { out.push(String(w.forms[k]).toLowerCase()); });
  return out.filter(function (v, i, a) { return a.indexOf(v) === i; });
}

// ---------------------------------------------------------------------------
// Load the corpus.
var files = [];
['A', 'B', 'C'].forEach(function (bank) {
  var dir = path.join(SETS_DIR, bank);
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).filter(function (f) { return /\.json$/.test(f); }).sort().forEach(function (f) {
    files.push({ bank: bank, file: path.join(dir, f) });
  });
});
if (!files.length) { console.error('validate-sets: no set files found under sets/'); process.exit(1); }

var stamp = fs.existsSync(STAMP) ? JSON.parse(fs.readFileSync(STAMP, 'utf8')) : null;

var seenIds = {}, bankCounts = { A: 0, B: 0, C: 0 };
var sets = [];

files.forEach(function (entry) {
  var raw = fs.readFileSync(entry.file);
  var set;
  try { set = JSON.parse(raw); } catch (e) { H(entry.file, 'M1', 'unparseable JSON: ' + e.message); return; }
  var id = set.id || entry.file;
  sets.push(set);
  bankCounts[set.bank] = (bankCounts[set.bank] || 0) + 1;

  // M1 schema/id shape
  if (!/^[ABC]-[a-z0-9-]+$/.test(set.id || '')) H(id, 'M1', 'bad id format');
  if (seenIds[set.id]) H(id, 'M1', 'duplicate set id'); seenIds[set.id] = 1;
  if (set.bank !== entry.bank) H(id, 'M1', 'bank field ' + set.bank + ' does not match directory ' + entry.bank);
  if ((set.id || '').charAt(0) !== entry.bank) H(id, 'M1', 'id prefix does not match bank directory');
  ['pos', 'theme', 'words', 'sentences', 'contrasts', 'meta'].forEach(function (k) {
    if (!(k in set)) H(id, 'M1', 'missing field ' + k);
  });
  if (!set.words || !set.sentences || !set.contrasts) return;

  // M2 exactly five unique words
  var ws = set.words.map(function (w) { return w.w; });
  if (set.words.length !== 5 || ws.filter(function (w, i) { return ws.indexOf(w) === i; }).length !== 5) {
    H(id, 'M2', 'needs exactly 5 unique words');
    return;
  }

  // M18 every word carries an Australian school year level (tools/grade-words.py)
  set.words.forEach(function (w) {
    if (!(Number.isInteger(w.grade) && w.grade >= 1 && w.grade <= 7)) {
      H(id, 'M18', w.w + ': grade must be an integer year 1-7, got ' + JSON.stringify(w.grade));
    }
  });

  var texts = {};
  set.sentences.forEach(function (s) {
    var sid = s.id || '(no id)';
    // M3 exactly one blank
    if ((s.text.match(/___/g) || []).length !== 1) H(id, 'M3', sid + ': needs exactly one ___');

    // M4 no member word or inflection in the sentence text outside the blank
    var lower = ' ' + s.text.toLowerCase() + ' ';
    set.words.forEach(function (w) {
      memberForms(w).forEach(function (form) {
        if (new RegExp('[^a-z]' + form + "[^a-z']").test(lower)) {
          H(id, 'M4', sid + ': member form "' + form + '" appears in the text');
        }
      });
    });

    // M5/M6 surface table complete and substitutable
    ws.forEach(function (w) {
      if (!s.surface || !s.surface[w]) { H(id, 'M5', sid + ': missing surface for ' + w); return; }
      var filled = s.text.replace('___', s.surface[w]);
      if (/__/.test(filled) || /  /.test(filled)) H(id, 'M6', sid + ': substitution leaves debris for ' + w);
      var word = set.words.filter(function (x) { return x.w === w; })[0];
      var stemOk = memberForms(word).some(function (form) {
        return s.surface[w].toLowerCase().slice(0, 3) === form.slice(0, 3);
      });
      if (!stemOk) R(id, 'M6', sid + ': surface "' + s.surface[w] + '" does not resemble ' + w);
    });
    // M17 the five surfaces must be five DISTINCT strings: a duplicate puts
    // the same word on two tiles and grades a visually correct tap as a miss
    // (shipped once as B-move-01-s21 run->"swim")
    if (s.surface) {
      var vals = ws.map(function (w) { return (s.surface[w] || '').toLowerCase(); });
      if (new Set(vals).size !== vals.length) H(id, 'M17', sid + ': duplicate surface forms ' + JSON.stringify(s.surface));
    }

    // M7 the cue must not quote the gloss
    var answerWord = set.words.filter(function (x) { return x.w === s.answer; })[0];
    if (answerWord && answerWord.gloss) {
      var g = words(answerWord.gloss), t = words(s.text);
      for (var i = 0; i + 2 < g.length; i++) {
        var tri = g.slice(i, i + 3).join(' ');
        if ((' ' + t.join(' ') + ' ').indexOf(' ' + tri + ' ') !== -1) {
          H(id, 'M7', sid + ': quotes 3+ gloss words "' + tri + '"');
        }
      }
      var gc = contentWords(answerWord.gloss), tc = contentWords(s.text);
      gc.forEach(function (w) {
        if (tc.indexOf(w) !== -1) {
          var waived = (s.waivers || []).some(function (wv) { return wv.check === 'GLOSS-WORD-ECHO' && wv.word === w; });
          if (!waived) R(id, 'M7', sid + ': shares gloss word "' + w + '" (waive or reword)');
        }
      });
    }

    // M9 duplicate / near-duplicate sentences
    var norm = contentWords(s.text).join(' ');
    if (texts[norm]) H(id, 'M9', sid + ' duplicates ' + texts[norm]);
    else {
      Object.keys(texts).forEach(function (other) {
        var a = norm.split(' '), b = other.split(' ');
        var inter = a.filter(function (w) { return b.indexOf(w) !== -1; }).length;
        var jac = inter / (a.length + b.length - inter);
        if (jac > 0.85) R(id, 'M9', sid + ' near-duplicates ' + texts[other] + ' (' + jac.toFixed(2) + ')');
      });
      texts[norm] = sid;
    }

    // M11 length bounds
    var n = words(s.text.replace('___', 'x')).length;
    if (n < 6 || n > 18) H(id, 'M11', sid + ': ' + n + ' words (bounds 6-18)');
    else if (n > 15 && (set.band_override || set.band) <= 2) R(id, 'M11', sid + ': ' + n + ' words is long for band ' + set.band);
  });

  // M8 cue mix per word: >=2 of each cue type active, >=2 reserve
  ws.forEach(function (w) {
    var mine = set.sentences.filter(function (s) { return s.answer === w; });
    var act = mine.filter(function (s) { return !s.reserve; });
    ['explicit', 'contextual', 'inferential'].forEach(function (cue) {
      var k = act.filter(function (s) { return s.cue === cue; }).length;
      if (k < 2) H(id, 'M8', w + ': only ' + k + ' active ' + cue + ' cues (need 2)');
    });
    var res = mine.length - act.length;
    if (res < 2) H(id, 'M8', w + ': only ' + res + ' reserve sentences (need 2)');
    // M16 totals (redundant with M8 but kept as its own named gate)
    if (act.length < 6) H(id, 'M16', w + ': only ' + act.length + ' active sentences (need 6)');
  });

  // M10 contrasts: all 20 directed pairs, short, no third member
  var pairs = {};
  (set.contrasts || []).forEach(function (c) {
    var k = c.answer + '|' + c.picked;
    if (pairs[k]) H(id, 'M10', 'duplicate contrast ' + k);
    pairs[k] = 1;
    if (!c.line || c.line.length > 140) H(id, 'M10', k + ': line empty or over 140 chars');
    var third = ws.filter(function (w) { return w !== c.answer && w !== c.picked; });
    third.forEach(function (w) {
      if (new RegExp('\\b' + w, 'i').test(c.line || '')) R(id, 'M10', k + ': line mentions third member ' + w);
    });
  });
  ws.forEach(function (a) { ws.forEach(function (p) {
    if (a !== p && !pairs[a + '|' + p]) H(id, 'M10', 'missing contrast ' + a + '|' + p);
  }); });

  // M12 provenance
  if (!set.meta || !set.meta.generated_at || !set.meta.model) H(id, 'M12', 'missing generation provenance');
  if (!set.meta || !set.meta.scrubbed_at) H(id, 'M12', 'unscrubbed machine output must not ship');

  // M13 gloss-audit stamp freshness
  var digest = sha256(raw);
  var rel = path.relative(ROOT, entry.file);
  if (!stamp || !stamp.files || stamp.files[rel] !== digest) {
    H(id, 'M13', 'gloss audit stamp missing or stale (run tools/audit-glosses.py)');
  }

  // M14 uniqueness verdicts: every sentence has a fresh pass
  var uniqFile = path.join(UNIQ_DIR, set.id + '.json');
  if (!fs.existsSync(uniqFile)) {
    H(id, 'M14', 'no uniqueness verdicts (run tools/judge-uniqueness.py)');
  } else {
    var verdicts = JSON.parse(fs.readFileSync(uniqFile, 'utf8')).sentences || {};
    set.sentences.forEach(function (s) {
      var v = verdicts[s.id];
      var h = sha256(Buffer.from(s.text + '\n' + ws.map(function (w) { return s.surface[w]; }).join('|'), 'utf8'));
      if (!v) H(id, 'M14', s.id + ': never judged');
      else if (v.text_sha256 !== h) H(id, 'M14', s.id + ': edited since judging (stale verdict)');
      else if (v.verdict === 'hard') H(id, 'M14', s.id + ': judge rejected the answer or its sense');
      else if (v.verdict === 'review') R(id, 'M14', s.id + ': judge flagged a possible second fit — resolve in REVIEW.md');
      else if (v.verdict !== 'pass') H(id, 'M14', s.id + ': unknown verdict ' + v.verdict);
    });
  }

  // M15 band assignment
  var band = set.band_override != null ? set.band_override : (set.computed && set.computed.band_suggested);
  if (!(band >= 1 && band <= 5)) H(id, 'M15', 'no usable band');
  if (set.band !== band) H(id, 'M15', 'band field (' + set.band + ') disagrees with override/suggested (' + band + ')');
  if (set.bank === 'C' && band < 3) H(id, 'M15', 'bank C below band 3');
});

// M15 corpus-level bank mix (warning only: 65/20/15 are declared starting values)
var totalSets = sets.length;
if (totalSets >= 10) {
  var mix = { A: bankCounts.A / totalSets, B: bankCounts.B / totalSets, C: bankCounts.C / totalSets };
  [['A', 0.65], ['B', 0.20], ['C', 0.15]].forEach(function (t) {
    if (Math.abs(mix[t[0]] - t[1]) > 0.15) {
      console.log('note: bank ' + t[0] + ' at ' + Math.round(mix[t[0]] * 100) + '% vs ' + Math.round(t[1] * 100) + '% target');
    }
  });
}

// Redundant belt-and-braces: the runtime contract over the assembled corpus.
var rv = Core.validateContent({ sets: sets, shelves: Core.SHELVES });
rv.errors.forEach(function (e) { H('(runtime contract)', 'core', e); });

// ---------------------------------------------------------------------------
// Report, write the review lane, exit.
var refDir = path.join(ROOT, 'reference');
if (!fs.existsSync(refDir)) fs.mkdirSync(refDir, { recursive: true });
var reviewMd = '# Content review queue\n\nGenerated by tools/validate-sets.js. Items here are legal to ship but need human eyes.\n\n' +
  (review.length ? review.map(function (r) { return '- [' + r.gate + '] ' + r.set + ': ' + r.msg; }).join('\n') : '(empty)') + '\n';
fs.writeFileSync(path.join(refDir, 'REVIEW.md'), reviewMd);

console.log('validate-sets: ' + files.length + ' set file(s), ' + hard.length + ' hard failure(s), ' + review.length + ' review item(s)');
hard.forEach(function (h2) { console.error('  HARD [' + h2.gate + '] ' + h2.set + ': ' + h2.msg); });
if (review.length) console.log('  review lane written to reference/REVIEW.md');
process.exit(hard.length ? 1 : 0);
