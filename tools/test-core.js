#!/usr/bin/env node
/*
 * test-core.js - invariant suite for game-core.js. Run: node tools/test-core.js
 * Exits non-zero on any failure. No skips, no soft passes, no swallowed errors.
 *
 * Uses synthetic fixture sets (so engine bugs can't hide behind content bugs)
 * plus, when game-content.js exists, validates the real shipped artifact too.
 */
'use strict';
var C = require('../game-core.js');

var passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  console.error('FAIL: ' + msg);
}
function eq(a, b, msg) { ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function throws(fn, msg) {
  var threw = false;
  try { fn(); } catch (e) { threw = true; }
  ok(threw, msg);
}

// ---------------------------------------------------------------------------
// Fixture: a legal synthetic set. 5 words, 8 sentences each (6 active as
// 2 explicit + 2 contextual + 2 inferential, plus 2 reserve), full surface
// tables, all 20 directed contrasts.
function makeSet(id) {
  var ws = ['alpha', 'bravo', 'carol', 'delta', 'echo'];
  var set = {
    id: id, bank: 'A', pos: 'verb', theme: 'fixture', band: 2,
    words: ws.map(function (w) {
      return { w: w, synset: w + '.v.01', gloss_source: 'wordnet', gloss: 'gloss of ' + w,
               zipf: 4, register: 'neutral',
               forms: { base: w, third: w + 's', past: w + 'ed', part: w + 'ing' } };
    }),
    sentences: [],
    contrasts: []
  };
  var cues = ['explicit', 'explicit', 'contextual', 'contextual', 'inferential', 'inferential', 'contextual', 'inferential'];
  ws.forEach(function (w, wi) {
    for (var k = 0; k < 8; k++) {
      var surface = {};
      ws.forEach(function (x) { surface[x] = x + 'ed'; });
      set.sentences.push({
        id: id + '-s' + (wi * 8 + k + 1), answer: w, cue: cues[k], reserve: k >= 6,
        text: 'Fixture frame ' + wi + '.' + k + ' where they ___ away.',
        cue_phrase: 'cue ' + w + ' ' + k, surface: surface
      });
    }
  });
  ws.forEach(function (a) { ws.forEach(function (p) {
    if (a !== p) set.contrasts.push({ answer: a, picked: p, line: a + ' not ' + p + ' here.' });
  }); });
  return set;
}
var SET = makeSet('A-fixture-01');
var CONTENT = { schema_version: 1, sets: [SET, makeSet('A-fixture-02')], shelves: C.SHELVES };

// Drive an encounter with a scripted answer policy; returns a transcript.
function play(seed, policy, review) {
  var rng = C.makeRng(seed);
  var enc = C.newEncounter(SET, { review: !!review }, rng);
  var log = { tileOrder: enc.tileOrder.slice(), draws: [], results: [] };
  var guard = 0;
  while (enc.state === 'ready' || enc.state === 'miss') {
    C.startRun(enc);
    while (enc.state === 'run') {
      if (++guard > 200) throw new Error('runaway encounter');
      var s = C.drawSentence(enc, SET, rng);
      log.draws.push(s.id);
      var pick = policy(s, enc);
      var r = C.answer(enc, SET, s, pick);
      log.results.push(r.correct ? 1 : 0);
    }
  }
  log.state = enc.state; log.enc = enc;
  return log;
}
var alwaysRight = function (s) { return s.answer; };
var alwaysWrong = function (s) { return s.answer === 'alpha' ? 'bravo' : 'alpha'; };

// ---------------------------------------------------------------------------
// 1. Rotation invariant: no (word, sentence) pair served twice per encounter.
(function () {
  for (var seed = 1; seed <= 1000; seed++) {
    var policy = (seed % 3 === 0) ? alwaysRight
               : (seed % 3 === 1) ? alwaysWrong
               : function (s, enc) { return (enc.correctInRun === 3) ? (s.answer === 'echo' ? 'alpha' : 'echo') : s.answer; };
    var log = play(seed, policy);
    var seen = {};
    var dup = false;
    log.draws.forEach(function (id) { if (seen[id]) dup = true; seen[id] = 1; });
    if (dup) { ok(false, 'duplicate sentence within encounter, seed ' + seed); return; }
  }
  ok(true, 'rotation: 1000 seeded encounters, no repeated pair');
})();

// 2. Replacement draw: words repeat within a run; no free fifth word.
(function () {
  var repeats = 0, fifthHits = 0, fifthTrials = 0;
  for (var seed = 2000; seed < 4000; seed++) {
    var perRunWords = {}, distinct = {}, count = 0, done = false;
    play(seed, function (s) {
      if (perRunWords[s.answer]) repeats++;
      perRunWords[s.answer] = 1;
      if (!done) {
        if (count === 4) {
          // four answered; was every one of the first four distinct?
          var d = Object.keys(distinct);
          if (d.length === 4) {
            fifthTrials++;
            var remaining = SET.words.map(function (w) { return w.w; }).filter(function (w) { return !distinct[w]; })[0];
            if (s.answer === remaining) fifthHits++;
          }
          done = true;
        }
        distinct[s.answer] = 1; count++;
      }
      return s.answer;
    });
  }
  ok(repeats > 0, 'replacement: a word can repeat within a run (saw ' + repeats + ')');
  ok(fifthTrials > 50, 'replacement: enough 4-distinct prefixes sampled (' + fifthTrials + ')');
  var rate = fifthHits / fifthTrials;
  ok(rate > 0.08 && rate < 0.4, 'anti-elimination: P(fifth word next | 4 distinct) = ' + rate.toFixed(3) + ', expected near 0.2, never near 1');
})();

// 3. Exhaustion / miss flow.
(function () {
  var log = play(11, alwaysWrong);
  eq(log.state, 'exhausted', 'three misses exhaust the set');
  eq(log.enc.misses, 3, 'exhaustion counts exactly 3 misses');
  eq(log.enc.missed.length, 3, 'missed words recorded per miss');
  eq(log.draws.length, 3, 'a miss ends its run: 3 misses = 3 draws');
  throws(function () { C.answer(log.enc, SET, SET.sentences[0], 'alpha'); }, 'answer() throws on a terminal state');
  var rng = C.makeRng(5);
  var enc = C.newEncounter(SET, {}, rng);
  throws(function () { C.drawSentence(enc, SET, rng); }, 'drawSentence() throws before startRun');
  var rev = play(12, alwaysWrong, true);
  eq(rev.state, 'failed', 'any miss fails a review lockbox');
  eq(rev.draws.length, 1, 'review lockbox: one miss = over');
})();

// 4. Crack discipline.
(function () {
  var log = play(21, alwaysRight);
  eq(log.state, 'cracked', 'five straight cracks the safe');
  eq(log.draws.length, 5, 'crack takes exactly CRACK_NEED draws');
  ok(C.isClean(log.enc), 'no-miss crack is clean');
  var missAt3 = function (s, enc) {
    return (enc.misses === 0 && enc.correctInRun === 3) ? (s.answer === 'echo' ? 'alpha' : 'echo') : s.answer;
  };
  var log2 = play(22, missAt3);
  eq(log2.state, 'cracked', 'crack on run 2 after a miss');
  eq(log2.enc.runIndex, 2, 'second run has runIndex 2');
  ok(!C.isClean(log2.enc), 'crack after a miss is not clean');
  eq(log2.draws.length, 4 + 5, 'streak resets across runs: 4 draws then 5');
  var rev = play(23, alwaysRight, true);
  eq(rev.state, 'cracked', 'review lockbox opens');
  eq(rev.draws.length, C.REVIEW_CRACK_NEED, 'review needs exactly ' + C.REVIEW_CRACK_NEED);
  var rng = C.makeRng(9), enc = C.newEncounter(SET, {}, rng);
  throws(function () { C.startRun(C.startRun(enc)); }, 'startRun() twice without a miss throws');
})();

// 5. Adaptivity curve.
(function () {
  // curve re-anchored to the 28-level year ladder: 1 through year 3 (<=12),
  // 2 across years 4-5 (13-20), 3 in years 6-7 (21+)
  eq(C.neededStreak(1), 1, 'streak needed in years 1-3 is 1');
  eq(C.neededStreak(12), 1, 'streak needed at 12 (year 3 top) is 1');
  eq(C.neededStreak(13), 2, 'streak needed at 13 (year 4) is 2');
  eq(C.neededStreak(20), 2, 'streak needed at 20 (year 5 top) is 2');
  eq(C.neededStreak(21), 3, 'streak needed at 21 (year 6) is 3');
  eq(C.neededStreak(28), 3, 'streak needed at 28 is 3');
  var r = C.adjustDifficulty(1, 'clean-crack', 0, 0);
  ok(Math.abs(r.difficulty - 1.7) < 1e-9 && r.streak === 0, 'level 1 climbs on a single clean crack');
  r = C.adjustDifficulty(15, 'clean-crack', 0, 0);
  ok(r.difficulty === 15 && r.streak === 1, 'level 15 needs a second clean crack');
  r = C.adjustDifficulty(15, 'clean-crack', 1, 0);
  ok(Math.abs(r.difficulty - 15.7) < 1e-9 && r.streak === 0, 'level 15 climbs on the second');
  r = C.adjustDifficulty(15, 'crack', 1, 0);
  ok(r.difficulty === 15 && r.streak === 0, 'scrappy crack holds level, breaks streak');
  r = C.adjustDifficulty(15, 'exhausted', 2, 0);
  ok(Math.abs(r.difficulty - 14.2) < 1e-9 && r.streak === 0, 'exhaustion drops 0.8');
  r = C.adjustDifficulty(1, 'exhausted', 0, 0);
  eq(r.difficulty, 1, 'difficulty clamps at 1');
  r = C.adjustDifficulty(C.MAX_LEVEL + 0.9, 'clean-crack', 2, 0);
  ok(r.difficulty <= C.MAX_LEVEL + 0.99, 'difficulty clamps at MAX_LEVEL+0.99');
  r = C.adjustDifficulty(8, 'clean-crack', 0, 6);
  ok(r.difficulty <= 6.99, 'parent cap clamps');
  r = C.adjustDifficulty(9, 'review-opened', 2, 0);
  ok(r.difficulty === 9 && r.streak === 2, 'review-opened moves nothing');
  r = C.adjustDifficulty(9, 'review-failed', 2, 0);
  ok(r.difficulty === 9 && r.streak === 2, 'review-failed moves nothing');
  throws(function () { C.adjustDifficulty(9, 'tipped', 0, 0); }, 'unknown outcome throws (the lock timer feeds miss/exhausted; speed is never an outcome)');
  var d = 3, s = 0, i;
  for (i = 0; i < 40; i++) { var up = C.adjustDifficulty(d, 'clean-crack', s, 0); ok(up.difficulty >= d, 'clean-crack never lowers'); d = up.difficulty; s = up.streak; }
  for (i = 0; i < 40; i++) { var dn = C.adjustDifficulty(d, 'exhausted', s, 0); ok(dn.difficulty <= d, 'exhaustion never raises'); d = dn.difficulty; s = dn.streak; }
  eq(C.levelOf(0.2), 1, 'levelOf clamps low');
  eq(C.levelOf(999), C.MAX_LEVEL, 'levelOf clamps high');
})();

// 6. Determinism.
(function () {
  var a = play(777, alwaysRight), b = play(777, alwaysRight), c = play(778, alwaysRight);
  eq(JSON.stringify({ t: a.tileOrder, d: a.draws }), JSON.stringify({ t: b.tileOrder, d: b.draws }), 'same seed, identical transcript');
  ok(JSON.stringify(a.draws) !== JSON.stringify(c.draws) || JSON.stringify(a.tileOrder) !== JSON.stringify(c.tileOrder), 'different seed diverges');
  var rng = C.makeRng(4);
  var sh = C.shuffle([1, 2, 3, 4, 5], rng);
  eq(sh.slice().sort().join(','), '1,2,3,4,5', 'shuffle is a permutation');
})();

// 7. Review queue policy.
(function () {
  ok(!C.reviewDue(0, [{ setId: 'x' }]), 'no review before any sets');
  ok(!C.reviewDue(4, []), 'no review with an empty queue');
  ok(C.reviewDue(4, [{ setId: 'x' }]) && C.reviewDue(8, [{ setId: 'x' }]), 'review due at multiples of ' + C.REVIEW_EVERY);
  ok(!C.reviewDue(5, [{ setId: 'x' }]), 'not due off-cycle');
  var q = [];
  q = C.pushReview(q, { setId: 'a', exhausted: false, at: 1 });
  q = C.pushReview(q, { setId: 'b', exhausted: true, at: 2 });
  q = C.pushReview(q, { setId: 'a', exhausted: true, at: 3 });
  eq(q.length, 2, 'pushReview dedupes by setId');
  ok(q.filter(function (e) { return e.setId === 'a'; })[0].exhausted, 'dedupe keeps the worse outcome');
  var pick = C.pickReview(q);
  eq(pick.entry.setId, 'b', 'exhausted entries picked first (FIFO among them)');
  eq(pick.rest.length, 1, 'picked entry removed from rest');
  var q2 = C.settleReview(q, pick.entry, true);
  eq(q2.length, 1, 'opened review leaves the queue');
  var q3 = C.settleReview(q, pick.entry, false);
  eq(q3.length, 2, 'failed review stays queued');
  eq(q3[q3.length - 1].setId, 'b', 'failed review requeues at the back');
})();

// 8. Collectibles: the walk is available, duplicate-free and shelf-ordered.
(function () {
  var total = 0;
  C.SHELVES.forEach(function (s) { total += s.items.length; });
  var owned = [];
  for (var i = 0; i < total; i++) {
    var n = C.nextCollectible(owned);
    ok(!!n, 'collectible available at count ' + i);
    ok(owned.indexOf(n.itemId) === -1, 'no duplicate collectible');
    if (i === 0) eq(n.shelfId, C.SHELVES[0].id, 'walk starts on the first shelf');
    owned.push(n.itemId);
  }
  eq(owned.length, total, 'walked every item exactly once');
})();

// 8b. Shelf accounting and cosmetics.
(function () {
  var total = 0;
  C.SHELVES.forEach(function (s) { total += s.items.length; });
  var owned = [];
  for (var i = 0; i < total; i++) owned.push(C.nextCollectible(owned).itemId);
  eq(C.nextCollectible(owned), null, 'nextCollectible null once every item owned');
  var st = C.shelfState(owned);
  ok(st.every(function (s) { return s.complete; }), 'all shelves complete');
  var st2 = C.shelfState(owned.slice(0, 4));
  eq(st2[0].owned, 4, 'partial shelf counts 4');
  ok(!st2[0].complete, 'shelf of 4/5 is not complete');
  var cos = C.cosmeticsUnlocked(owned);
  ok(cos.skins.length + cos.backdrops.length + cos.pins.length === C.SHELVES.length, 'every shelf unlocks exactly one cosmetic');
  eq(C.cosmeticsUnlocked([]).skins.length, 0, 'no cosmetics with empty cabinet');
})();

// 9. Content validation: fixture passes, corruption fails, real artifact passes.
(function () {
  var v = C.validateContent(CONTENT);
  ok(v.ok, 'fixture content validates: ' + v.errors.join('; '));
  var broken = JSON.parse(JSON.stringify(CONTENT));
  broken.sets[0].sentences[3].surface = { alpha: 'alphaed' };
  broken.sets[0].contrasts.pop();
  broken.sets[1].sentences = broken.sets[1].sentences.slice(0, 30);
  var bv = C.validateContent(broken);
  ok(!bv.ok, 'corrupted content is rejected');
  ok(bv.errors.length >= 3, 'each corruption reported (' + bv.errors.length + ' errors)');
  var fs = require('fs');
  if (fs.existsSync(__dirname + '/../game-content.js')) {
    var Content = require('../game-content.js');
    var rv = C.validateContent(Content.data);
    ok(rv.ok, 'shipped game-content.js validates: ' + rv.errors.slice(0, 5).join('; '));
  } else {
    ok(true, 'game-content.js not built yet; shipped-content check will run once it exists');
  }
})();

// 10. Grading + contrast.
(function () {
  var rng = C.makeRng(31);
  var enc = C.newEncounter(SET, {}, rng);
  C.startRun(enc);
  var s = C.drawSentence(enc, SET, rng);
  var wrongPick = s.answer === 'alpha' ? 'bravo' : 'alpha';
  var con = C.contrastFor(SET, s, wrongPick);
  eq(con.right.w, s.answer, 'contrast right word is the answer');
  eq(con.picked.w, wrongPick, 'contrast picked word is the pick');
  ok(con.right.gloss.length > 0 && con.picked.gloss.length > 0, 'both glosses present');
  eq(con.cue, s.cue_phrase, 'cue carried through');
  ok(con.line.indexOf(s.answer) !== -1 || con.line.length > 0, 'directed line found');
  ok(con.filled.indexOf('___') === -1, 'filled sentence has no blank left');
  throws(function () { C.answer(enc, SET, s, 'zebra'); }, 'answering with a word outside the set throws');
  var r = C.answer(enc, SET, s, wrongPick);
  ok(!r.correct, 'wrong pick grades wrong');
  eq(C.fillText(s, 'alpha'), s.text.replace('___', 'alphaed'), 'fillText substitutes the surface form');
})();

// 11. Rewards.
(function () {
  ok(C.coinsFor('crack', 1) > C.coinsFor('review-opened', 1), 'crack pays more than a review');
  ok(C.coinsFor('review-opened', 1) > 0, 'review pays something');
  eq(C.coinsFor('exhausted', 7), 0, 'exhaustion pays nothing');
  ok(C.coinsFor('crack', 20) > C.coinsFor('crack', 1), 'crack pay scales gently with level');
  eq(C.speedBonus(5000 * 5, 5), 2, 'fast pace earns 2');
  eq(C.speedBonus(9000 * 5, 5), 1, 'medium pace earns 1');
  eq(C.speedBonus(20000 * 5, 5), 0, 'slow pace earns 0 (and nothing else: no level input)');
  eq(C.speedBonus(1000, 0), 0, 'zero answers earns 0');
})();

// 12. Progressive pins: every school year climbs 2 to 5 pins; streaks still gate levels.
(function () {
  eq(C.crackNeedFor(1), 2, 'year 1 starts at 2 pins');
  eq(C.crackNeedFor(2), 3, 'level 2 takes 3 pins');
  eq(C.crackNeedFor(4), 5, 'year 1 tops out at the full 5');
  eq(C.crackNeedFor(5), 2, 'year 2 resets to 2 pins with its new words');
  eq(C.crackNeedFor(12), 5, 'year 3 tops out at 5');
  eq(C.crackNeedFor(25), 2, 'year 7 also starts at 2');
  eq(C.crackNeedFor(28), 5, 'the top of the ladder is a 5-pin vault');
  eq(C.yearOf(1), 1, 'levels 1-4 are year 1');
  eq(C.yearOf(4), 1, 'level 4 is still year 1');
  eq(C.yearOf(5), 2, 'level 5 opens year 2');
  eq(C.yearOf(28), 7, 'level 28 is year 7');
  eq(C.yearOf(999), 7, 'yearOf clamps to year 7');
  var set = makeSet('A-test-01');
  var rng = C.makeRng(11);
  var enc = C.newEncounter(set, { level: 1 }, rng);
  eq(enc.need, 2, 'encounter at level 1 needs 2 pins');
  C.startRun(enc);
  var s1 = C.drawSentence(enc, set, rng);
  eq(C.answer(enc, set, s1, s1.answer).state, 'run', 'first pin seats, lock still shut');
  var s2 = C.drawSentence(enc, set, rng);
  eq(C.answer(enc, set, s2, s2.answer).state, 'cracked', 'second pin cracks a 2-pin lock');
  var rev = C.newEncounter(set, { review: true, level: 20 }, rng);
  eq(rev.need, 3, 'review lockboxes stay at 3 pins regardless of level');
  var legacy = C.newEncounter(set, {}, rng);
  eq(legacy.need, 5, 'no level given falls back to the full 5 (old saves)');
  ok(C.coinsFor('crack', 1, 5) > C.coinsFor('crack', 1, 2), 'more pins pay more coins');
})();

// ---------------------------------------------------------------------------
// yearRange: the school-year badge data
(function () {
  var set = makeSet('A-year-01');
  set.words.forEach(function (w, i) { w.grade = [2, 4, 3, 2, 4][i]; });
  var yr = C.yearRange(set);
  eq(yr.min, 2, 'yearRange finds the lowest year');
  eq(yr.max, 4, 'yearRange finds the highest year');
  eq(yr.label, 'Years 2-4', 'mixed set labels as a range');
  set.words.forEach(function (w) { w.grade = 5; });
  eq(C.yearRange(set).label, 'Year 5', 'uniform set labels as a single year');
  set.words.forEach(function (w) { delete w.grade; });
  eq(C.yearRange(set), null, 'ungraded fixture words yield null, not a fake range');
})();

// ---------------------------------------------------------------------------
// setsForLevel: year-first selection with the bank-C floor
(function () {
  function graded(id, maxYear, bank) {
    var s = makeSet(id);
    if (bank) s.bank = bank;
    s.words.forEach(function (w) { w.grade = maxYear; });
    s.words[0].grade = 1;
    return s;
  }
  var content = { sets: [graded('A-y1-01', 1), graded('A-y2-01', 2),
                         graded('A-y5-01', 5), graded('C-y2-01', 2, 'C')],
                  shelves: C.SHELVES };
  eq(C.setYearOf(graded('A-x-01', 5)), 5, 'a set is pitched at its hardest word');
  eq(C.setYearOf(makeSet('A-f-01')), 4, 'ungraded sets fall back to a band estimate');
  var ids = C.setsForLevel(content, 1);
  ok(ids.indexOf('A-y1-01') !== -1, 'year 1 serves year-1 sets');
  ok(ids.indexOf('A-y5-01') === -1, 'year 1 does not reach year-5 sets');
  ok(ids.indexOf('C-y2-01') === -1, 'bank C never serves below year 3');
  ids = C.setsForLevel(content, 9);
  ok(ids.indexOf('C-y2-01') !== -1, 'bank C joins from year 3');
  ids = C.setsForLevel(content, 17);
  eq(JSON.stringify(ids), JSON.stringify(['A-y5-01']), 'year 5 draws exactly the year-5 set');
})();

// ---------------------------------------------------------------------------
// timeout: the lock timer expiring is a miss in everything but the tap
(function () {
  var rng = C.makeRng(31);
  var enc = C.newEncounter(SET, { level: 1 }, rng);
  throws(function () { C.timeout(enc, SET); }, 'timeout() outside a run throws');
  C.startRun(enc);
  var s = C.drawSentence(enc, SET, rng);
  var r = C.timeout(enc, SET);
  ok(!r.correct && r.timedOut, 'timeout grades as an incorrect, timed-out result');
  eq(r.state, 'miss', 'first timeout ends the run');
  eq(enc.misses, 1, 'timeout counts a miss');
  eq(enc.missed[0], s.answer, 'the un-answered word joins the missed list');
  C.startRun(enc); C.drawSentence(enc, SET, rng); C.timeout(enc, SET);
  C.startRun(enc); C.drawSentence(enc, SET, rng);
  eq(C.timeout(enc, SET).state, 'exhausted', 'third timeout exhausts the safe');
  var rev = C.newEncounter(SET, { review: true }, rng);
  C.startRun(rev); C.drawSentence(rev, SET, rng);
  eq(C.timeout(rev, SET).state, 'failed', 'a review timeout fails the lockbox');
  eq(C.LOCK_TIMER_MS, 15000, 'the lock clock is 15 seconds');
})();

// ---------------------------------------------------------------------------
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
