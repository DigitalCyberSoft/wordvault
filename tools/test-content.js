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

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
