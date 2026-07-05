/*
 * game-core.js - pure game logic for Word Vault, no DOM.
 *
 * UMD-style: exposes `Core` on the browser global, and module.exports under node
 * so tools/test-core.js can require() it. Classic script (not an ES module) so it
 * loads from file:// with no server.
 *
 * Responsibilities: the encounter state machine (runs, misses, crack), sentence
 * selection (rotation across runs + draw-with-replacement over words), grading,
 * adaptive difficulty, the review-lockbox queue policy, and collectibles. The UI
 * never grades; it only renders state and reports the player's taps back here.
 *
 * Everything is deterministic given an injected rng (a () -> [0,1) function), so
 * the whole engine is testable and an encounter snapshot is a plain JSON object.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Tunables. MAX_LEVEL is 20 (five content bands of four levels each; see
  // LEVELS.md). HELP_THRESHOLD is the level where in-play long-press gloss help
  // switches off and the Get Ready screen becomes the only vocabulary support.
  var MAX_LEVEL = 20;
  var HELP_THRESHOLD = 12;
  var RUNS_PER_SET = 3;      // misses allowed per encounter; a miss ends its run
  var CRACK_NEED = 5;        // consecutive corrects to crack the safe
  var REVIEW_CRACK_NEED = 3; // consecutive corrects to open a review lockbox
  var REVIEW_EVERY = 4;      // a lockbox is offered after every Nth completed set
  var UP_STEP = 0.7;
  var DOWN_STEP = 0.8;

  // Themed shelves for the Curio Cabinet. Five treasures complete a shelf and
  // unlock its cosmetic. Item ids double as art keys (assets/collectibles/<id>.png);
  // the emoji is the fallback until the art lands, and for reduced-asset builds.
  var SHELVES = [
    { id: 'expedition', name: 'Expedition Shelf', cosmetic: { kind: 'backdrop', id: 'expedition' },
      items: [
        { id: 'compass', name: 'Brass compass', emoji: '🧭' },
        { id: 'map', name: 'Folded map', emoji: '🗺️' },
        { id: 'spyglass', name: 'Spyglass', emoji: '🔭' },
        { id: 'lantern', name: 'Storm lantern', emoji: '🏮' },
        { id: 'boot', name: 'Explorer’s boot', emoji: '🥾' } ] },
    { id: 'museum', name: 'Museum Shelf', cosmetic: { kind: 'skin', id: 'bronze' },
      items: [
        { id: 'fossil', name: 'Fossil', emoji: '🦴' },
        { id: 'scarab', name: 'Scarab', emoji: '🪲' },
        { id: 'crown', name: 'Old crown', emoji: '👑' },
        { id: 'amphora', name: 'Amphora', emoji: '🏺' },
        { id: 'moonrock', name: 'Moon rock', emoji: '🌑' } ] },
    { id: 'workshop', name: 'Workshop Shelf', cosmetic: { kind: 'pins', id: 'copper' },
      items: [
        { id: 'gear', name: 'Bronze gear', emoji: '⚙️' },
        { id: 'spring', name: 'Coiled spring', emoji: '🌀' },
        { id: 'lens', name: 'Jeweller’s lens', emoji: '🔍' },
        { id: 'key', name: 'Skeleton key', emoji: '🗝️' },
        { id: 'bell', name: 'Counter bell', emoji: '🔔' } ] },
    { id: 'wonder', name: 'Shelf of Wonders', cosmetic: { kind: 'backdrop', id: 'night' },
      items: [
        { id: 'dragon', name: 'Tiny dragon', emoji: '🐉' },
        { id: 'gargoyle', name: 'Stone gargoyle', emoji: '🗿' },
        { id: 'feather', name: 'Golden feather', emoji: '🪶' },
        { id: 'gem', name: 'Cut gem', emoji: '💎' },
        { id: 'orb', name: 'Fortune orb', emoji: '🔮' } ] }
  ];

  // ---------------------------------------------------------------------------
  // Seeded rng + shuffle, so tests replay byte-identical encounters.
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function shuffle(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ---------------------------------------------------------------------------
  // Content access.
  function wordsOf(set) { return set.words.map(function (w) { return w.w; }); }
  function findWord(set, w) {
    for (var i = 0; i < set.words.length; i++) if (set.words[i].w === w) return set.words[i];
    return null;
  }
  function sentenceById(set, id) {
    for (var i = 0; i < set.sentences.length; i++) if (set.sentences[i].id === id) return set.sentences[i];
    return null;
  }
  function fillText(sentence, w) { return sentence.text.replace('___', sentence.surface[w]); }
  function bandOf(level) { return Math.max(1, Math.min(5, Math.ceil(level / 4))); }

  // Sets whose band matches the level's band; if the band is thin, widen the net
  // one band at a time rather than starving the draw.
  function setsForLevel(content, level) {
    var want = bandOf(level);
    for (var spread = 0; spread <= 4; spread++) {
      var ids = [];
      for (var i = 0; i < content.sets.length; i++) {
        if (Math.abs(content.sets[i].band - want) <= spread) ids.push(content.sets[i].id);
      }
      if (ids.length) return ids;
    }
    return [];
  }

  // Prefer sets the player has never met; then the least-played; never repeat the
  // set just played while any alternative exists.
  function pickSet(content, opts, rng) {
    var ids = setsForLevel(content, opts.level);
    if (!ids.length) return null;
    var history = opts.history || {};
    var pool = ids.filter(function (id) { return id !== opts.lastSetId; });
    if (!pool.length) pool = ids;
    var unseen = pool.filter(function (id) { return !history[id]; });
    if (unseen.length) return unseen[Math.floor(rng() * unseen.length)];
    var minPlays = Infinity;
    pool.forEach(function (id) { minPlays = Math.min(minPlays, history[id].plays || 0); });
    var least = pool.filter(function (id) { return (history[id].plays || 0) === minPlays; });
    return least[Math.floor(rng() * least.length)];
  }

  // ---------------------------------------------------------------------------
  // Content validation: the runtime contract every shipped set must meet. Run by
  // tools/validate-sets.js, tools/test-content.js and the in-page #selftest.
  var CUES = { explicit: 1, contextual: 1, inferential: 1 };
  function validateContent(content) {
    var errors = [];
    function bad(setId, msg) { errors.push((setId ? setId + ': ' : '') + msg); }
    if (!content || !content.sets || !content.sets.length) bad(null, 'no sets');
    var seenIds = {};
    (content && content.sets || []).forEach(function (set) {
      var id = set.id || '(missing id)';
      if (!/^[ABC]-[a-z0-9-]+$/.test(set.id || '')) bad(id, 'bad set id');
      if (seenIds[id]) bad(id, 'duplicate set id'); seenIds[id] = 1;
      if (!(set.band >= 1 && set.band <= 5)) bad(id, 'band out of range');
      if (set.bank === 'C' && set.band < 3) bad(id, 'bank C below band 3');
      if (!set.words || set.words.length !== 5) { bad(id, 'needs exactly 5 words'); return; }
      var ws = wordsOf(set), seenW = {};
      ws.forEach(function (w) { if (seenW[w]) bad(id, 'duplicate word ' + w); seenW[w] = 1; });
      set.words.forEach(function (w) {
        if (!w.gloss) bad(id, w.w + ': missing gloss');
        if (w.gloss_source === 'wordnet' && !w.synset) bad(id, w.w + ': wordnet gloss without pinned synset');
      });
      // all 20 directed contrast pairs, exactly once each
      var pairs = {};
      (set.contrasts || []).forEach(function (c) {
        var k = c.answer + '|' + c.picked;
        if (pairs[k]) bad(id, 'duplicate contrast ' + k);
        pairs[k] = c.line && c.line.length <= 140;
        if (!pairs[k]) bad(id, 'contrast ' + k + ' empty or over 140 chars');
      });
      ws.forEach(function (a) { ws.forEach(function (p) {
        if (a !== p && !(a + '|' + p in pairs)) bad(id, 'missing contrast ' + a + '|' + p);
      }); });
      // sentences
      var perWord = {}, seenS = {};
      ws.forEach(function (w) { perWord[w] = { active: 0, reserve: 0 }; });
      (set.sentences || []).forEach(function (s) {
        if (seenS[s.id]) bad(id, 'duplicate sentence id ' + s.id); seenS[s.id] = 1;
        if (!perWord[s.answer]) { bad(id, s.id + ': answer not in set'); return; }
        if ((s.text.match(/___/g) || []).length !== 1) bad(id, s.id + ': needs exactly one ___');
        if (!CUES[s.cue]) bad(id, s.id + ': bad cue type');
        ws.forEach(function (w) {
          if (!s.surface || !s.surface[w]) bad(id, s.id + ': missing surface for ' + w);
        });
        perWord[s.answer][s.reserve ? 'reserve' : 'active'] += 1;
      });
      ws.forEach(function (w) {
        if (perWord[w].active < 6) bad(id, w + ': only ' + perWord[w].active + ' active sentences (need 6)');
        if (perWord[w].reserve < 2) bad(id, w + ': only ' + perWord[w].reserve + ' reserve sentences (need 2)');
      });
    });
    (content && content.shelves || SHELVES).forEach(function (sh) {
      if (!sh.items || sh.items.length !== 5) bad(null, 'shelf ' + sh.id + ' needs 5 items');
    });
    return { ok: !errors.length, errors: errors };
  }

  // ---------------------------------------------------------------------------
  // Encounter state machine. One encounter = one attempt at one safe (or one
  // review lockbox). Plain serializable data: the UI persists it verbatim so a
  // reload resumes at the top of the current run. States:
  //   ready -> run -> (miss -> run)* -> cracked | exhausted | failed(review)
  function newEncounter(set, opts, rng) {
    var review = !!(opts && opts.review);
    return {
      setId: set.id,
      review: review,
      state: 'ready',
      runIndex: 0,
      misses: 0,
      correctInRun: 0,
      need: review ? REVIEW_CRACK_NEED : CRACK_NEED,
      runsAllowed: review ? 1 : RUNS_PER_SET,
      // tile positions are fixed for the whole encounter: shuffled once here,
      // never again, so the child spends working memory on meaning, not on
      // re-finding words that moved.
      tileOrder: shuffle(wordsOf(set), rng),
      used: {},     // wordId -> [sentenceId]: pairs served, never repeated
      runUsed: [],  // sentenceIds served in the current run (fallback bookkeeping)
      missed: [],   // answer words the player failed on, in order
      sentenceId: null
    };
  }

  function startRun(enc) {
    if (enc.state !== 'ready' && enc.state !== 'miss') throw new Error('startRun() in state ' + enc.state);
    enc.state = 'run';
    enc.runIndex += 1;
    enc.correctInRun = 0;
    enc.runUsed = [];
    enc.sentenceId = null;
    return enc;
  }

  function poolFor(enc, set) {
    return set.sentences.filter(function (s) { return !!s.reserve === !!enc.review; });
  }

  // Draw the next sentence. Two rules do the pedagogy:
  //  - draw the WORD uniformly (with replacement) over words that still have an
  //    unused sentence, so tile frequencies stay flat and answering four words
  //    never makes the fifth a free guess;
  //  - never serve the same (word, sentence) pair twice in one encounter, so
  //    run 2 and run 3 can't be passed on memory of run 1's pairings.
  function drawSentence(enc, set, rng) {
    if (enc.state !== 'run') throw new Error('drawSentence() in state ' + enc.state);
    var pool = poolFor(enc, set);
    function unusedFor(w) {
      return pool.filter(function (s) {
        return s.answer === w && (enc.used[w] || []).indexOf(s.id) === -1;
      });
    }
    var words = wordsOf(set).filter(function (w) { return unusedFor(w).length > 0; });
    var options;
    if (words.length) {
      var w = words[Math.floor(rng() * words.length)];
      options = unusedFor(w);
    } else {
      // Content minimums (6 active per word vs a worst case of 15 draws) make
      // this unreachable with shipped sets; on thin dev content, degrade to
      // "not repeated within the current run" instead of throwing.
      options = pool.filter(function (s) { return enc.runUsed.indexOf(s.id) === -1; });
      if (!options.length) options = pool;
    }
    var s = options[Math.floor(rng() * options.length)];
    (enc.used[s.answer] = enc.used[s.answer] || []).push(s.id);
    enc.runUsed.push(s.id);
    enc.sentenceId = s.id;
    return s;
  }

  function answer(enc, set, sentence, picked) {
    if (enc.state !== 'run') throw new Error('answer() in state ' + enc.state);
    if (!sentence || sentence.id !== enc.sentenceId) throw new Error('answer() for a sentence not in play');
    if (!findWord(set, picked)) throw new Error('answer() with a word not in the set: ' + picked);
    var correct = picked === sentence.answer;
    if (correct) {
      enc.correctInRun += 1;
      if (enc.correctInRun >= enc.need) enc.state = 'cracked';
    } else {
      enc.misses += 1;
      enc.missed.push(sentence.answer);
      // a miss ends the run; the third miss (or any miss on a review) ends the set
      enc.state = enc.review ? 'failed' : (enc.misses >= enc.runsAllowed ? 'exhausted' : 'miss');
    }
    enc.sentenceId = null;
    return { correct: correct, state: enc.state };
  }

  function isClean(enc) { return enc.state === 'cracked' && enc.misses === 0; }

  // Everything the miss card needs: both glosses, the cue, the directed line.
  function contrastFor(set, sentence, picked) {
    var right = findWord(set, sentence.answer), wrong = findWord(set, picked);
    var line = '';
    for (var i = 0; i < (set.contrasts || []).length; i++) {
      var c = set.contrasts[i];
      if (c.answer === sentence.answer && c.picked === picked) { line = c.line; break; }
    }
    return {
      right: { w: right.w, gloss: right.gloss, surface: sentence.surface[right.w] },
      picked: { w: wrong.w, gloss: wrong.gloss, surface: sentence.surface[wrong.w] },
      cue: sentence.cue_phrase || '',
      filled: fillText(sentence, right.w),
      line: line
    };
  }

  // Unique missed words for the exhaustion screen, in the set's teaching order.
  function missedWords(enc, set) {
    return set.words.filter(function (w) { return enc.missed.indexOf(w.w) !== -1; });
  }

  // The authored word order IS the semantic gradient; the Get Ready screen shows
  // it, play uses enc.tileOrder.
  function gradientOrder(set) { return wordsOf(set); }

  // ---------------------------------------------------------------------------
  // Adaptive difficulty. Difficulty IS the level, a persisted float. Driven only
  // by performance, never by speed: there are no timers in this game, and a slow
  // correct answer is a correct answer.
  //   - the only way UP is a CLEAN crack (crack with zero misses), and the climb
  //     needs a run of clean cracks that lengthens with the level: one below 10,
  //     two from 10-15, three from 16 up;
  //   - a scrappy crack (cracked, but missed along the way) holds the level and
  //     breaks the streak;
  //   - exhausting a set (three misses, no crack) drops the level;
  //   - review lockboxes never move the level in either direction.
  function neededStreak(level) { return level >= 16 ? 3 : (level >= 10 ? 2 : 1); }
  function adjustDifficulty(difficulty, outcome, streak, capLevel) {
    var d = difficulty, s = streak || 0;
    if (outcome === 'clean-crack') {
      s += 1;
      if (s >= neededStreak(Math.round(d))) { d += UP_STEP; s = 0; }
    } else if (outcome === 'crack') {
      s = 0;
    } else if (outcome === 'exhausted') {
      s = 0; d -= DOWN_STEP;
    } else if (outcome === 'review-opened' || outcome === 'review-failed') {
      // reviews are retention practice, not placement evidence
    } else {
      throw new Error('adjustDifficulty(): unknown outcome ' + outcome);
    }
    d = Math.max(1, Math.min(MAX_LEVEL + 0.99, d));
    if (capLevel) d = Math.min(d, capLevel + 0.99); // parent control: don't climb past the cap
    return { difficulty: d, streak: s };
  }
  function levelOf(difficulty) { return Math.max(1, Math.min(MAX_LEVEL, Math.round(difficulty))); }

  // ---------------------------------------------------------------------------
  // Rewards. Coins are a quiet tally; the collectible is the real prize. Speed
  // pays a small coin bonus and NOTHING else (deliberately not a difficulty
  // input; see adjustDifficulty).
  function coinsFor(outcome, level) {
    if (outcome === 'crack') return 5 + Math.floor((levelOf(level) - 1) / 4);
    if (outcome === 'review-opened') return 2;
    return 0;
  }
  function speedBonus(elapsedMs, answered) {
    if (!answered || elapsedMs < 0) return 0;
    var per = elapsedMs / answered;
    return per <= 6000 ? 2 : (per <= 10000 ? 1 : 0);
  }

  // ---------------------------------------------------------------------------
  // Review-lockbox queue. Entries: { setId, exhausted, at }. Treated immutably:
  // every operation returns a new array for painless persistence.
  function reviewDue(setsCompleted, queue) {
    return setsCompleted > 0 && setsCompleted % REVIEW_EVERY === 0 && queue.length > 0;
  }
  function pushReview(queue, entry) {
    var exhausted = !!entry.exhausted;
    var rest = queue.filter(function (e) {
      if (e.setId === entry.setId) { exhausted = exhausted || e.exhausted; return false; }
      return true;
    });
    return rest.concat([{ setId: entry.setId, exhausted: exhausted, at: entry.at || 0 }]);
  }
  function pickReview(queue) {
    if (!queue.length) return null;
    var idx = 0;
    for (var i = 0; i < queue.length; i++) if (queue[i].exhausted) { idx = i; break; }
    var entry = queue[idx];
    return { entry: entry, rest: queue.slice(0, idx).concat(queue.slice(idx + 1)) };
  }
  function settleReview(queue, entry, opened) {
    var rest = queue.filter(function (e) { return e.setId !== entry.setId; });
    return opened ? rest : rest.concat([entry]); // failed lockboxes requeue at the back
  }

  // ---------------------------------------------------------------------------
  // Collectibles. Deterministic walk through the shelves so a wiped-then-replayed
  // game always rebuilds the cabinet in the same charming order.
  function nextCollectible(owned) {
    for (var i = 0; i < SHELVES.length; i++) {
      var sh = SHELVES[i];
      for (var j = 0; j < sh.items.length; j++) {
        if (owned.indexOf(sh.items[j].id) === -1) {
          return { shelfId: sh.id, shelfName: sh.name, itemId: sh.items[j].id,
                   name: sh.items[j].name, emoji: sh.items[j].emoji };
        }
      }
    }
    return null;
  }
  function shelfState(owned) {
    return SHELVES.map(function (sh) {
      var have = sh.items.filter(function (it) { return owned.indexOf(it.id) !== -1; }).length;
      return { shelfId: sh.id, name: sh.name, owned: have, total: sh.items.length,
               complete: have === sh.items.length, cosmetic: sh.cosmetic, items: sh.items };
    });
  }
  function cosmeticsUnlocked(owned) {
    var out = { skins: [], backdrops: [], pins: [] };
    shelfState(owned).forEach(function (s) {
      if (!s.complete) return;
      if (s.cosmetic.kind === 'skin') out.skins.push(s.cosmetic.id);
      else if (s.cosmetic.kind === 'backdrop') out.backdrops.push(s.cosmetic.id);
      else if (s.cosmetic.kind === 'pins') out.pins.push(s.cosmetic.id);
    });
    return out;
  }

  return {
    MAX_LEVEL: MAX_LEVEL, HELP_THRESHOLD: HELP_THRESHOLD, RUNS_PER_SET: RUNS_PER_SET,
    CRACK_NEED: CRACK_NEED, REVIEW_CRACK_NEED: REVIEW_CRACK_NEED, REVIEW_EVERY: REVIEW_EVERY,
    UP_STEP: UP_STEP, DOWN_STEP: DOWN_STEP, SHELVES: SHELVES,
    makeRng: makeRng, shuffle: shuffle, bandOf: bandOf,
    setsForLevel: setsForLevel, pickSet: pickSet, validateContent: validateContent,
    newEncounter: newEncounter, startRun: startRun, drawSentence: drawSentence,
    sentenceById: sentenceById, fillText: fillText, answer: answer, isClean: isClean,
    contrastFor: contrastFor, missedWords: missedWords, gradientOrder: gradientOrder,
    neededStreak: neededStreak, adjustDifficulty: adjustDifficulty, levelOf: levelOf,
    coinsFor: coinsFor, speedBonus: speedBonus,
    reviewDue: reviewDue, pushReview: pushReview, pickReview: pickReview, settleReview: settleReview,
    nextCollectible: nextCollectible, shelfState: shelfState, cosmeticsUnlocked: cosmeticsUnlocked
  };
});
