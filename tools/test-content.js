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

// Learning modes over the real corpus: every dictionary question, for every
// set and year, has exactly one right tile; spelling has items for (almost)
// every word; both modes run an encounter to a crack.
(function () {
  var Cc = require('../game-core.js');
  var dictQs = 0, guide = 0;
  data.sets.forEach(function (set) {
    if (set.bank === 'C') return;
    for (var y = 1; y <= 7; y++) {
      var d = Cc.resolveSet(data, 'D' + y + ':' + set.id);
      ok(d && d.sentences.length >= 3, set.id + ' Y' + y + ': dictionary set builds');
      var sorted = Cc.alphaSort(d.words.map(function (w) { return w.w; }));
      d.sentences.forEach(function (q) {
        dictQs++;
        var vals = d.words.map(function (w) { return q.surface[w.w]; });
        ok(new Set(vals).size === 5, q.id + ': five distinct tiles');
        var i = sorted.indexOf(q.answer);
        if (q.kind === 'meaning') {
          var w = d.words.filter(function (x) { return x.w === q.answer; })[0];
          ok(!Cc.glossGivesAway(w), q.id + ': meaning does not give the word away');
          ok(d.words.every(function (x) { return x.w === q.answer || x.gloss !== w.gloss; }), q.id + ': meaning is unique in the set');
        }
        if (q.kind === 'first') ok(i === 0, q.id + ': first');
        if (q.kind === 'last') ok(i === 4, q.id + ': last');
        if (q.kind === 'after') ok(i > 0 && sorted[i - 1] === q.info.ref, q.id + ': after');
        if (q.kind === 'before') ok(i < 4 && sorted[i + 1] === q.info.ref, q.id + ': before');
        if (q.kind === 'guide') {
          guide++;
          var inside = sorted.filter(function (x) { return Cc.alphaKey(x) > Cc.alphaKey(q.info.from) && Cc.alphaKey(x) < Cc.alphaKey(q.info.to); });
          ok(inside.length === 1 && inside[0] === q.answer, q.id + ': exactly one word between the guide words');
          ok(sorted.indexOf(q.info.from) === -1 && sorted.indexOf(q.info.to) === -1, q.id + ': guide words are not tiles');
        }
      });
    }
    var sp = Cc.resolveSet(data, 'S:' + set.id);
    var spellable = sp.words.filter(function (w) { return sp.sentences.some(function (s) { return s.answer === w.w; }); }).length;
    ok(spellable >= 4, set.id + ': spelling covers at least 4 of 5 words (' + spellable + ')');
    [sp, Cc.resolveSet(data, 'D4:' + set.id)].forEach(function (vs) {
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
  ok(dictQs > 5000 && guide > 500, 'dictionary mode has broad coverage (' + dictQs + ' questions, ' + guide + ' guide-word pages)');
})();

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
