#!/usr/bin/env node
/*
 * test-content.js - assertions over the BAKED artifact (game-content.js), the
 * exact file the game ships. Run after bake: node tools/test-content.js
 * Defense in depth: validate-sets.js gates the sources; this gates the output.
 */
'use strict';
var Core = require('../game-core.js');
var Content = require('../game-content.js');

var passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  console.error('FAIL: ' + msg);
}

var data = Content.data;
ok(Content.SCHEMA_VERSION === 1, 'schema version 1');
ok(!!data.built_at && !!data.source_sha256, 'bake provenance present');
ok(data.builder === 'tools/bake-content.js', 'baked by the bake tool, not by hand');

// The runtime contract, over the shipped bytes.
var v = Core.validateContent(data);
ok(v.ok, 'runtime contract holds: ' + v.errors.slice(0, 5).join('; '));

// Counts in the artifact match its own contents.
var words = 0, sentences = 0, contrasts = 0;
data.sets.forEach(function (s) {
  words += s.words.length; sentences += s.sentences.length; contrasts += s.contrasts.length;
});
ok(data.counts.sets === data.sets.length, 'set count matches');
ok(data.counts.words === words, 'word count matches');
ok(data.counts.sentences === sentences, 'sentence count matches');
ok(data.counts.contrasts === contrasts, 'contrast count matches');

// The band index is complete and correct both ways.
var indexed = 0;
Object.keys(data.bands).forEach(function (band) {
  data.bands[band].forEach(function (id) {
    indexed++;
    var set = Content.byId(id);
    ok(!!set && String(set.band) === band, id + ' band-indexed correctly');
  });
});
ok(indexed === data.sets.length, 'every set appears in the band index exactly once');

// Accessors.
ok(Content.byId(data.sets[0].id) === data.sets[0], 'byId returns the set');
ok(Content.byId('A-no-such-set') === null, 'byId returns null on a miss');

// Ladder sets ship complete scales, and the five time ladders are aboard.
var laddered = data.sets.filter(function (s) { return s.scale != null; });
laddered.forEach(function (s) {
  ok(typeof s.scale.left === 'string' && s.scale.left.length > 0 &&
     typeof s.scale.right === 'string' && s.scale.right.length > 0,
     s.id + ' scale labels complete');
  ok(s.drafting_notes === undefined, s.id + ' authoring notes stripped at bake');
});
['B-time-deixis-01', 'B-time-day-01', 'B-time-order-01',
 'A-time-frequency-01', 'A-time-nearness-01'].forEach(function (id) {
  var s = Content.byId(id);
  ok(!!s && !!s.scale, id + ' shipped with its scale');
});

// The engine can actually run a full encounter on every shipped set.
data.sets.forEach(function (set) {
  var rng = Core.makeRng(42);
  var enc = Core.newEncounter(set, {}, rng);
  Core.startRun(enc);
  var draws = 0;
  while (enc.state === 'run') {
    var s = Core.drawSentence(enc, set, rng);
    draws++;
    Core.answer(enc, set, s, s.answer);
  }
  ok(enc.state === 'cracked' && draws === Core.CRACK_NEED, set.id + ' plays through to a crack');
  var rng2 = Core.makeRng(43);
  var rev = Core.newEncounter(set, { review: true }, rng2);
  Core.startRun(rev);
  while (rev.state === 'run') {
    var rs = Core.drawSentence(rev, set, rng2);
    ok(rs.reserve === true, set.id + ' review draws only reserve sentences');
    Core.answer(rev, set, rs, rs.answer);
  }
  ok(rev.state === 'cracked', set.id + ' review lockbox opens');
});

// Learning modes over the real corpus: every dictionary question has five
// distinct tiles and exactly one right one (definitions unique within a set);
// every spelling word has a recorded clip; both modes run to a crack.
(function () {
  var Cc = require('../game-core.js');
  var fs = require('fs'), path = require('path');
  var dictQs = 0, targets = {};
  data.sets.forEach(function (set) {
    var sp = Cc.resolveSet(data, 'S:' + set.id);
    sp.sentences.forEach(function (s) { targets[Cc.normSpelling(s.surface[s.answer])] = 1; });
    var spellable = sp.words.filter(function (w) { return sp.sentences.some(function (s) { return s.answer === w.w; }); }).length;
    ok(spellable >= 4, set.id + ': spelling covers at least 4 of 5 words (' + spellable + ')');
    var runs = [sp];
    if (set.bank !== 'C') {
      var d = Cc.resolveSet(data, 'D:' + set.id);
      ok(d && d.sentences.length >= 6, set.id + ': dictionary set has at least 6 questions (' + d.sentences.length + ')');
      var glosses = d.words.map(function (w) { return w.gloss; });
      ok(new Set(glosses).size === 5, set.id + ': five different definitions');
      d.sentences.forEach(function (q) {
        dictQs++;
        ok(new Set(d.words.map(function (w) { return q.surface[w.w]; })).size === 5, q.id + ': five distinct tiles');
        ok(!Cc.glossGivesAway(d.words.filter(function (x) { return x.w === q.answer; })[0]), q.id + ': the answer is not given away');
      });
      runs.push(d);
    }
    runs.forEach(function (vs) {
      var rng = Cc.makeRng(11), enc = Cc.newEncounter(vs, { level: 16 }, rng);
      Cc.startRun(enc);
      for (var k = 0; k < enc.need; k++) {
        var s = Cc.drawSentence(enc, vs, rng);
        if (vs.mode === 'spell') Cc.answerTyped(enc, vs, s, s.surface[s.answer]);
        else Cc.answer(enc, vs, s, s.answer);
      }
      ok(enc.state === 'cracked', vs.id + ': a perfect run cracks it');
    });
  });
  ok(dictQs > 600, 'dictionary mode has broad coverage (' + dictQs + ' questions)');
  var root = path.join(__dirname, '..');
  var missing = Object.keys(targets).filter(function (w) {
    return !fs.existsSync(path.join(root, 'assets', 'voice', Cc.voiceSlug(w) + '.mp3'));
  });
  ok(!missing.length, 'every spelling word has a recorded clip (' + Object.keys(targets).length + ' words; missing: ' + missing.slice(0, 8).join(', ') + ')');
  var check = path.join(root, 'reference', 'voice-check.json');
  var vc = fs.existsSync(check) ? JSON.parse(fs.readFileSync(check, 'utf8')) : {};
  var unheard = Object.keys(targets).filter(function (w) { return !(vc[w] && vc[w].ok); });
  ok(!unheard.length, 'every clip was transcribed back to its word (' + unheard.slice(0, 8).join(', ') + ')');
})();

// Word Forms Vault over the baked questions: only judged, well-formed
// questions shipped, every year can serve forms safes, and they play.
(function () {
  var Cc = require('../game-core.js');
  var forms = data.forms || {};
  var total = 0;
  Object.keys(forms).forEach(function (sid) {
    forms[sid].items.forEach(function (it) {
      total++;
      ok(it.tiles.indexOf(it.answer) !== -1, it.id + ': the answer is on a tile');
      // 3 is the floor: a past-tense answer never sits beside its -s form
      // (judge-forms.py tense_rivals), so relished / relish / relishing
      ok(it.tiles.length >= 3 && it.tiles.length <= 5 && new Set(it.tiles).size === it.tiles.length, it.id + ': 3-5 distinct tiles');
      ok((it.text.match(/___/g) || []).length === 1, it.id + ': one blank');
      ok(it.tiles.every(function (t) { return it.notes[t]; }), it.id + ': every version has a note');
      ok(forms[sid].families[it.word], it.id + ': its family ships too');
    });
  });
  ok(total >= 300, 'word-forms questions shipped: ' + total);
  var eligible = function (c, id) { var f = Cc.formsFor(c, id); return !!f && f.items.length >= 6; };
  for (var y = 1; y <= 7; y++) {
    var ids = Cc.setsForLevel(data, Cc.yearStart(y), eligible);
    ok(ids.length >= 2, 'Year ' + y + ' can serve word-forms safes (' + ids.length + ')');
  }
  Object.keys(forms).forEach(function (sid) {
    var fs = Cc.resolveSet(data, 'F:' + sid);
    var rng = Cc.makeRng(4), enc = Cc.newEncounter(fs, { level: 12 }, rng);
    Cc.startRun(enc);
    for (var k = 0; k < enc.need; k++) { var q = Cc.drawSentence(enc, fs, rng); Cc.answer(enc, fs, q, q.answer); }
    ok(enc.state === 'cracked', fs.id + ': a perfect run cracks it');
  });
})();

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
