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
  // Tunables. MAX_LEVEL is 28: seven Australian school years (1-7) of four
  // levels ("steps") each. A step is one clean crack: within every year the
  // lock grows 2 -> 3 -> 4 -> 5 pins, and a clean crack of the 5-pin vault
  // passes the year. So a year is passed with STEPS_PER_YEAR clean cracks IN A
  // ROW; any miss sends the child back to the year's 2-pin start (see
  // adjustDifficulty and LEVELS.md). HELP_THRESHOLD is the level where in-play
  // long-press gloss help switches off (year 5) and the Get Ready screen
  // becomes the only vocabulary support.
  var MAX_LEVEL = 28;
  var STEPS_PER_YEAR = 4;
  var HELP_THRESHOLD = 17;
  var RUNS_PER_SET = 3;      // misses allowed per encounter; a miss ends its run
  var CRACK_NEED = 5;        // pin ceiling (each year's 4th step); crackNeedFor cycles below
  var REVIEW_CRACK_NEED = 3; // consecutive corrects to open a review lockbox
  var REVIEW_EVERY = 4;      // a lockbox is offered after every Nth completed set
  var SLIPS_TO_DROP = 2;     // exhausted safes IN A ROW that step a child down a year
  var MIN_POOL = 4;          // sets a year must offer before selection borrows a neighbour year
  var LOCK_TIMER_MS = 15000; // seconds on the clock per sentence; expiry = a miss
  var EARLY_TIMER_MS = 20000; // Years 1-2: young readers decode the slip AND five tiles

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
        { id: 'orb', name: 'Fortune orb', emoji: '🔮' } ] },
    { id: 'timekeepers', name: 'Timekeepers Shelf', cosmetic: { kind: 'dial', id: 'clock' },
      items: [
        { id: 'hourglass', name: 'Hourglass', emoji: '⏳' },
        { id: 'sundial', name: 'Stone sundial', emoji: '🌞' },
        { id: 'pocketwatch', name: 'Pocket watch', emoji: '⌚' },
        { id: 'cuckoo', name: 'Cuckoo clock', emoji: '🕰️' },
        { id: 'calendar', name: 'Flip calendar', emoji: '📅' } ] }
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
  // The level ladder is year-first: levels 1-4 are Year 1, 5-8 Year 2, ... 25-28
  // Year 7. Within a year the step (0-3) sets the pin count (crackNeedFor).
  function yearOf(level) { return Math.max(1, Math.min(7, Math.ceil(levelOf(level) / STEPS_PER_YEAR))); }
  function stepOf(level) { return (levelOf(level) - 1) % STEPS_PER_YEAR; }
  function yearStart(year) { return (Math.max(1, Math.min(7, year)) - 1) * STEPS_PER_YEAR + 1; }
  // clean cracks in a row still needed to pass the level's year (4 at a year's start, 1 on its 5-pin vault)
  function cleanToPass(level) { return STEPS_PER_YEAR - stepOf(level); }

  // A set is pitched at the school year where at most ONE of its words is a
  // stretch, and that stretch is at most one year ahead: max(second-hardest
  // grade, hardest grade - 1). Sets are five words with one feature apart, so
  // four known words plus one new one is the learning sweet spot, and the
  // one-year stretch is the gifted lean (a pure "hardest word" pitch parked
  // shiny/sparkly sets in Year 6 because of one word). Bank C (their/there and
  // kin) never pitches below year 3: those traps assume reading stamina the
  // youngest players don't have yet. Ungraded sets (dev fixtures) fall back to
  // a band estimate.
  function setYearOf(set) {
    var g = [];
    for (var i = 0; i < set.words.length; i++) if (typeof set.words[i].grade === 'number') g.push(set.words[i].grade);
    var y;
    if (g.length === set.words.length && g.length >= 2) {
      g.sort(function (a, b) { return a - b; });
      y = Math.max(g[g.length - 2], g[g.length - 1] - 1);
    } else {
      y = Math.min(7, set.band + 2);
    }
    if (set.bank === 'C') y = Math.max(y, 3);
    return Math.max(1, Math.min(7, y));
  }

  // Sets pitched at the level's year; if the year offers fewer than MIN_POOL
  // sets, widen the net one year at a time (both directions) so a thin year
  // never loops the same two or three safes.
  // `filter(content, id)` narrows the pool for a mode (dictionary skips usage
  // sets, word forms needs judged questions); widening counts only what passes.
  function setsForLevel(content, level, filter) {
    var want = yearOf(level), ids = [], eligible = 0;
    for (var e = 0; e < content.sets.length; e++) if (!filter || filter(content, content.sets[e].id)) eligible++;
    for (var spread = 0; spread <= 6; spread++) {
      ids = [];
      for (var i = 0; i < content.sets.length; i++) {
        var s = content.sets[i];
        if (filter && !filter(content, s.id)) continue;
        if (Math.abs(setYearOf(s) - want) <= spread) ids.push(s.id);
      }
      if (ids.length >= Math.min(MIN_POOL, eligible)) return ids;
    }
    return ids;
  }

  // Prefer sets the player has never met; then the least-played; never repeat the
  // set just played while any alternative exists.
  function pickSet(content, opts, rng) {
    var ids = setsForLevel(content, opts.level, opts.filter);
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
      // ladder sets: the when-line renders scale labels unchecked, so the
      // contract insists they are complete when present
      if (set.scale != null && !(set.scale.left && set.scale.right)) {
        bad(id, 'scale present but missing left/right labels');
      }
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
        // five tiles must show five DIFFERENT strings, or a correct-looking
        // tap can grade as a miss
        if (s.surface) {
          var vals = ws.map(function (w) { return (s.surface[w] || '').toLowerCase(); });
          vals.forEach(function (v, i) {
            if (vals.indexOf(v) !== i) bad(id, s.id + ': duplicate surface form "' + v + '"');
          });
        }
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
  // Locks grow more pins WITHIN each school year: every year starts at 2 pins
  // and works up to the full 5 before the next year's words arrive (step 0-3
  // of the year -> 2,3,4,5 pins). Each step is one clean crack, so the pin
  // count doubles as the child's in-a-row progress through the year, and the
  // year's exit exam is a full 5-pin vault (adjustDifficulty below).
  function crackNeedFor(level) {
    return Math.min(2 + stepOf(level), CRACK_NEED);
  }

  function newEncounter(set, opts, rng) {
    var review = !!(opts && opts.review);
    return {
      setId: set.id,
      review: review,
      state: 'ready',
      runIndex: 0,
      misses: 0,
      correctInRun: 0,
      need: review ? REVIEW_CRACK_NEED
        : (opts && opts.level != null ? crackNeedFor(opts.level) : CRACK_NEED),
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
    return grade(enc, sentence, picked === sentence.answer);
  }
  // The one state transition every mode shares: a correct item seats a pin
  // (enough in a row cracks the lock); a wrong one ends the run.
  function grade(enc, sentence, correct) {
    if (correct) {
      enc.correctInRun += 1;
      if (enc.correctInRun >= enc.need) enc.state = 'cracked';
    } else {
      enc.misses += 1;
      // word-forms questions answer with a tile slot; the lesson is the headword
      enc.missed.push(sentence.word || sentence.answer);
      // a miss ends the run; the third miss (or any miss on a review) ends the set
      enc.state = enc.review ? 'failed' : (enc.misses >= enc.runsAllowed ? 'exhausted' : 'miss');
    }
    enc.sentenceId = null;
    return { correct: correct, state: enc.state };
  }

  // The lock timer running out (LOCK_TIMER_MS; the UI owns the clock) is a
  // miss in everything but the tap: the run ends, a lamp lights, difficulty
  // math is identical. Speed still buys nothing upward - adjustDifficulty
  // takes no time input; the timer is a per-sentence failure condition only.
  function timeout(enc, set) {
    if (enc.state !== 'run') throw new Error('timeout() in state ' + enc.state);
    var s = enc.sentenceId ? sentenceById(set, enc.sentenceId) : null;
    enc.misses += 1;
    if (s) enc.missed.push(s.word || s.answer);
    enc.state = enc.review ? 'failed' : (enc.misses >= enc.runsAllowed ? 'exhausted' : 'miss');
    enc.sentenceId = null;
    return { correct: false, timedOut: true, state: enc.state };
  }

  // The clock a sentence gets at a level: Years 1-2 read more slowly, so they
  // get EARLY_TIMER_MS; Year 3 up gets LOCK_TIMER_MS. Still a failure
  // condition only - it never feeds adjustDifficulty.
  function lockTimerFor(level) { return yearOf(level) <= 2 ? EARLY_TIMER_MS : LOCK_TIMER_MS; }

  function isClean(enc) { return enc.state === 'cracked' && enc.misses === 0; }

  // Everything the miss card needs: both glosses, the cue, the directed line.
  function contrastFor(set, sentence, picked) {
    if (sentence.kind === 'form') {
      var r = sentence.surface[sentence.answer], p = sentence.surface[picked];
      return {
        right: { w: r, gloss: sentence.notes[sentence.answer] || '', surface: r },
        picked: { w: p, gloss: sentence.notes[picked] || '', surface: p },
        cue: '', filled: fillText(sentence, sentence.answer),
        line: 'Same word, different job: read the words around the gap to see which version the sentence needs.'
      };
    }
    var right = findWord(set, sentence.answer), wrong = findWord(set, picked);
    var line = '';
    for (var i = 0; i < (set.contrasts || []).length; i++) {
      var c = set.contrasts[i];
      if (c.answer === sentence.answer && c.picked === picked) { line = c.line; break; }
    }
    return {
      // a definition tile's text IS the gloss; the card names the word instead
      right: { w: right.w, gloss: right.gloss, surface: sentence.kind === 'define' ? right.w : sentence.surface[right.w] },
      picked: { w: wrong.w, gloss: wrong.gloss, surface: sentence.kind === 'define' ? wrong.w : sentence.surface[wrong.w] },
      cue: sentence.cue_phrase || '',
      filled: fillText(sentence, right.w),
      line: line
    };
  }

  // Unique missed words for the exhaustion screen, in the set's teaching order.
  function missedWords(enc, set) {
    if (set.mode === 'forms') {
      return enc.missed.filter(function (h, i) { return enc.missed.indexOf(h) === i && set.families[h]; })
        .map(function (h) { return familyCard(set, h); });
    }
    return set.words.filter(function (w) { return enc.missed.indexOf(w.w) !== -1; });
  }

  // A word family as a study card: the headword and its versions.
  function familyCard(set, head) {
    var src = null;
    (set.sourceWords || []).forEach(function (w) { if (w.w === head) src = w; });
    return { w: head, grade: src ? src.grade : undefined,
             gloss: (set.families[head] || []).map(function (f) { return f.form; }).join(' · ') };
  }
  // The authored word order IS the semantic gradient; the Get Ready screen shows
  // it, play uses enc.tileOrder.
  function gradientOrder(set) { return wordsOf(set); }

  // School-year span of a set's words (Australian Year 1-7; gate M18 puts an
  // integer grade on every shipped word). Sets mix years, so the honest label
  // is a range; null only if no word carries a numeric grade.
  function yearRange(set) {
    var lo = 8, hi = 0;
    for (var i = 0; i < set.words.length; i++) {
      var g = set.words[i].grade;
      if (typeof g === 'number') { if (g < lo) lo = g; if (g > hi) hi = g; }
    }
    if (!hi) return null;
    return { min: lo, max: hi, label: lo === hi ? 'Year ' + lo : 'Years ' + lo + '-' + hi };
  }

  // ---------------------------------------------------------------------------
  // Progression. The level is an INTEGER 1-28 (year = ceil(level / 4), step =
  // (level - 1) % 4) and moves only on performance, never on speed:
  //   - clean crack (cracked with zero misses): one step up. On the year's
  //     5-pin vault that passes the year (event 'promoted'); so a year is
  //     passed with four clean cracks in a row;
  //   - scrappy crack (cracked, but a miss along the way): the in-a-row run is
  //     broken, back to the year's first step (event 'reset');
  //   - exhausted safe (three misses): back to the year's first step, and the
  //     SLIPS_TO_DROP-th exhausted safe in a row steps down to the start of
  //     the year below (event 'demoted') - one bad safe never costs a year;
  //   - review lockboxes never move anything.
  // `slips` counts exhausted safes in a row (any crack clears it). capLevel
  // (a grown-up knob, a year's top level) clamps the top.
  // Returns { difficulty: level, slips, event }; event is one of
  // step | promoted | top | reset | hold | demoted.
  function adjustDifficulty(level, outcome, slips, capLevel) {
    var lv = levelOf(level), sl = slips || 0, ev = 'hold';
    var top = capLevel ? Math.min(MAX_LEVEL, levelOf(capLevel)) : MAX_LEVEL;
    var start = yearStart(yearOf(lv));
    if (outcome === 'clean-crack') {
      sl = 0;
      if (lv >= top) { ev = 'top'; }
      else { ev = stepOf(lv) === STEPS_PER_YEAR - 1 ? 'promoted' : 'step'; lv += 1; }
    } else if (outcome === 'crack') {
      sl = 0;
      if (lv > start) { lv = start; ev = 'reset'; }
    } else if (outcome === 'exhausted') {
      sl += 1;
      if (sl >= SLIPS_TO_DROP && yearOf(lv) > 1) {
        lv = yearStart(yearOf(lv) - 1); sl = 0; ev = 'demoted';
      } else if (lv > start) {
        lv = start; ev = 'reset';
      }
    } else if (outcome === 'review-opened' || outcome === 'review-failed') {
      // reviews are retention practice, not placement evidence
    } else {
      throw new Error('adjustDifficulty(): unknown outcome ' + outcome);
    }
    return { difficulty: Math.min(lv, top), slips: sl, event: ev };
  }
  // Integer level from a stored value. Older saves held a float (the old
  // +0.7 / -0.8 curve); rounding migrates them onto the ladder.
  function levelOf(difficulty) {
    var v = Math.round(+difficulty);
    return isFinite(v) ? Math.max(1, Math.min(MAX_LEVEL, v)) : 1;
  }

  // ---------------------------------------------------------------------------
  // Learning modes. Spelling and Dictionary ride the same vault, pins, runs
  // and year ladder as the word game: each builds a VIRTUAL set (the shape
  // newEncounter/drawSentence/answer already speak) from a real, gated set,
  // so no new content needs judging.
  //   - Spelling ('S:<set-id>'): dictation. The child HEARS the word (a clip
  //     recorded at build time, assets/voice/<voiceSlug>.mp3), reads its
  //     judged sentence for meaning, and types it.
  //   - Dictionary ('D:<set-id>'): match words to their definitions, both
  //     ways, among the set's five similar definitions. Exactly one right
  //     tile BY CONSTRUCTION (glosses are unique within a set by G3/G4).
  function alphaKey(w) { return String(w).toLowerCase().replace(/[^a-z]/g, ''); }
  function alphaSort(words) {
    return words.slice().sort(function (a, b) { var x = alphaKey(a), y = alphaKey(b); return x < y ? -1 : x > y ? 1 : 0; });
  }
  // A meaning that contains its own word family ("sip: drink in sips") gives
  // the answer away; such words are asked about in other ways instead.
  function glossGivesAway(word) {
    var w = alphaKey(word.w), cands = [w, w.replace(/(ful|ing|ed|er|ly|y|e|s)$/, '')];
    if (w.length >= 6) cands.push(w.slice(0, w.length - 2));
    var toks = word.gloss.toLowerCase().split(/[^a-z]+/);
    return toks.some(function (t) {
      return cands.some(function (c) { return c.length >= 3 && t.indexOf(c) === 0; });
    });
  }
  // The Dictionary Vault matches words to their definitions, both ways, inside
  // one confusable set - so the five definitions on offer are SIMILAR ones
  // (whimper / sob / bawl / howl / blubber), and the child must read closely:
  //   meaning: "___ means 'cry weakly or softly'."  tiles = the five words
  //   define:  "'whimper' means ___."               tiles = the five definitions
  // A word whose definition contains its own family ("sip: drink in sips")
  // is skipped as an answer (still a distractor): it would be a free point.
  function buildDictionarySet(content, src) {
    var ws = wordsOf(src), sentences = [], n = 0;
    function add(kind, w, text, surface) {
      n += 1;
      sentences.push({ id: 'D:' + src.id + '-q' + (n < 10 ? '0' : '') + n, answer: w.w, cue: 'explicit',
        reserve: false, kind: kind, text: text, cue_phrase: w.gloss, surface: surface });
    }
    var wordTiles = {}, defTiles = {};
    src.words.forEach(function (w) { wordTiles[w.w] = w.w; defTiles[w.w] = w.gloss; });
    src.words.forEach(function (w) {
      if (glossGivesAway(w)) return;
      add('meaning', w, '___ means “' + w.gloss + '”.', wordTiles);
      add('define', w, '“' + w.w + '” means ___.', defTiles);
    });
    return { id: 'D:' + src.id, srcId: src.id, mode: 'dict', bank: src.bank, band: src.band,
             theme: src.theme, pos: src.pos, words: src.words, contrasts: src.contrasts || [], sentences: sentences };
  }
  // The Word Forms Vault: different versions of the same word (terrify /
  // terrified / terrifying / terror). Questions are baked by
  // tools/judge-forms.py + bake-content.js (content.forms[<set-id>]); each
  // reuses a sentence already judged for meaning and puts 3-5 versions of its
  // answer word on the tiles. Tiles are five SLOTS (f0-f4) whose text changes
  // per question; a question with fewer versions leaves the last slots empty (hidden).
  var FORM_SLOTS = ['f0', 'f1', 'f2', 'f3', 'f4'];
  function formsFor(content, setId) {
    var f = content.forms && content.forms[setId];
    return f && f.items && f.items.length ? f : null;
  }
  function buildFormsSet(content, src) {
    var f = formsFor(content, src.id);
    if (!f) return null;
    var sentences = f.items.map(function (it) {
      var tiles = it.tiles.slice();
      // a stable shuffle per question, so the answer is not always on the left
      var seed = 0;
      for (var i = 0; i < it.id.length; i++) seed = (seed * 31 + it.id.charCodeAt(i)) >>> 0;
      tiles = shuffle(tiles, makeRng(seed));
      var surface = {}, notes = {}, answer = null;
      tiles.forEach(function (t, k) {
        surface[FORM_SLOTS[k]] = t;
        notes[FORM_SLOTS[k]] = it.notes[t] || '';
        if (t === it.answer) answer = FORM_SLOTS[k];
      });
      return { id: it.id, answer: answer, cue: 'explicit', reserve: false, kind: 'form', word: it.word,
               text: it.text, cue_phrase: '', surface: surface, notes: notes };
    });
    return { id: 'F:' + src.id, srcId: src.id, mode: 'forms', bank: src.bank, band: src.band, theme: src.theme,
             pos: src.pos, families: f.families, sourceWords: src.words, contrasts: [], sentences: sentences,
             words: FORM_SLOTS.map(function (k) { return { w: k, gloss: '' }; }) };
  }

  // Spelling serves the set's own judged sentences; the rare answer that is
  // two words on the tile ("looked at") is skipped.
  function spellingSetFrom(src) {
    return { id: 'S:' + src.id, srcId: src.id, mode: 'spell', bank: src.bank, band: src.band,
             theme: src.theme, pos: src.pos, words: src.words, contrasts: src.contrasts || [],
             sentences: src.sentences.filter(function (s) { return !/\s/.test(s.surface[s.answer]); })
               .map(function (s) { var c = {}; for (var k in s) c[k] = s[k]; c.reserve = false; return c; }) };
  }
  // Resolve any set id - real or virtual - against the baked content.
  function resolveSet(content, id) {
    var m = /^D[1-7]?:(.+)$/.exec(id || ''), src; // D<year>: ids saved by the first release still resolve
    function byId(x) { for (var i = 0; i < content.sets.length; i++) if (content.sets[i].id === x) return content.sets[i]; return null; }
    if (m) { src = byId(m[1]); return src && src.bank !== 'C' ? buildDictionarySet(content, src) : null; }
    if (/^S:/.test(id || '')) { src = byId(id.slice(2)); return src ? spellingSetFrom(src) : null; }
    if (/^F:/.test(id || '')) { src = byId(id.slice(2)); return src ? buildFormsSet(content, src) : null; }
    return byId(id);
  }
  // The clip a spelling word plays: assets/voice/<slug>.mp3, the same slug
  // tools/generate-voice.py writes ("they're" -> they_re).
  function voiceSlug(word) { return normSpelling(word).replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, ''); }
  // Typed answers (spelling): case and surrounding space never count, but
  // every letter, apostrophe and hyphen does.
  function normSpelling(t) { return String(t || '').trim().toLowerCase().replace(/[‘’`]/g, "'"); }
  function answerTyped(enc, set, sentence, typed) {
    if (enc.state !== 'run') throw new Error('answerTyped() in state ' + enc.state);
    if (!sentence || sentence.id !== enc.sentenceId) throw new Error('answerTyped() for a sentence not in play');
    var r = grade(enc, sentence, normSpelling(typed) === normSpelling(sentence.surface[sentence.answer]));
    r.typed = normSpelling(typed);
    return r;
  }
  // Look-phase time by year: the youngest get the longest look.
  function lookMsFor(level) { return [5000, 4500, 4000, 3500, 3000, 3000, 2500][yearOf(level) - 1]; }
  // Letter-by-letter check of an attempt against the right spelling (LCS
  // alignment): each target letter is ok or missed, each extra attempt letter
  // is flagged, plus one plain-language tip for the commonest slips.
  function spellDiff(target, attempt) {
    var a = normSpelling(target), b = normSpelling(attempt), i, j;
    var L = [];
    for (i = 0; i <= a.length; i++) { L.push([]); for (j = 0; j <= b.length; j++) L[i].push(0); }
    for (i = a.length - 1; i >= 0; i--) for (j = b.length - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    var right = [], wrote = [];
    i = 0; j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { right.push({ ch: a[i], ok: true }); wrote.push({ ch: b[j], ok: true }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { right.push({ ch: a[i], ok: false }); i++; }
      else { wrote.push({ ch: b[j], ok: false }); j++; }
    }
    for (; i < a.length; i++) right.push({ ch: a[i], ok: false });
    for (; j < b.length; j++) wrote.push({ ch: b[j], ok: false });
    var tip = 'Look at the gold letters: that is where the spelling is different.';
    var dbl = /(.)\1/.exec(a);
    if (!b) tip = 'Nothing was written. Look at the word, then spell it from memory.';
    else if (dbl && a.replace(dbl[0], dbl[1]) === b) tip = 'This word doubles the “' + dbl[1] + '”.';
    else if (dbl === null && /(.)\1/.test(b) && b.replace(/(.)\1/, '$1') === a) tip = 'Only one “' + /(.)\1/.exec(b)[1] + '” in this word.';
    else if (a.length === b.length && a.split('').sort().join('') === b.split('').sort().join('')) tip = 'All the right letters, but some are in the wrong order.';
    else if (/e$/.test(a) && a.slice(0, -1) === b) tip = 'Don’t forget the silent “e” on the end.';
    else if (a.indexOf("'") !== -1 && a.replace(/'/g, '') === b.replace(/'/g, '')) tip = 'This word needs an apostrophe ( ’ ).';
    return { right: right, wrote: wrote, tip: tip };
  }
  // ---------------------------------------------------------------------------
  // Rewards. Coins are a quiet tally; the collectible is the real prize. Speed
  // pays a small coin bonus and NOTHING else (deliberately not a progression
  // input; see adjustDifficulty).
  function coinsFor(outcome, level, need) {
    // crack pay scales with the pins seated, so a 2-pin band-1 vault does not
    // out-earn-per-minute the 5-pin vaults it feeds into
    if (outcome === 'crack') return 2 * (need || CRACK_NEED) + Math.floor((levelOf(level) - 1) / 4);
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
    var out = { skins: [], backdrops: [], pins: [], dials: [] };
    shelfState(owned).forEach(function (s) {
      if (!s.complete) return;
      if (s.cosmetic.kind === 'skin') out.skins.push(s.cosmetic.id);
      else if (s.cosmetic.kind === 'backdrop') out.backdrops.push(s.cosmetic.id);
      else if (s.cosmetic.kind === 'pins') out.pins.push(s.cosmetic.id);
      else if (s.cosmetic.kind === 'dial') out.dials.push(s.cosmetic.id);
    });
    return out;
  }

  return {
    MAX_LEVEL: MAX_LEVEL, HELP_THRESHOLD: HELP_THRESHOLD, RUNS_PER_SET: RUNS_PER_SET,
    CRACK_NEED: CRACK_NEED, REVIEW_CRACK_NEED: REVIEW_CRACK_NEED, REVIEW_EVERY: REVIEW_EVERY,
    LOCK_TIMER_MS: LOCK_TIMER_MS, EARLY_TIMER_MS: EARLY_TIMER_MS, lockTimerFor: lockTimerFor,
    STEPS_PER_YEAR: STEPS_PER_YEAR, SLIPS_TO_DROP: SLIPS_TO_DROP,
    MIN_POOL: MIN_POOL, crackNeedFor: crackNeedFor, SHELVES: SHELVES,
    makeRng: makeRng, shuffle: shuffle, bandOf: bandOf, yearOf: yearOf, setYearOf: setYearOf,
    stepOf: stepOf, yearStart: yearStart, cleanToPass: cleanToPass,
    setsForLevel: setsForLevel, pickSet: pickSet, validateContent: validateContent,
    newEncounter: newEncounter, startRun: startRun, drawSentence: drawSentence,
    sentenceById: sentenceById, fillText: fillText, answer: answer, timeout: timeout, isClean: isClean,
    contrastFor: contrastFor, missedWords: missedWords, gradientOrder: gradientOrder,
    alphaKey: alphaKey, alphaSort: alphaSort, glossGivesAway: glossGivesAway, voiceSlug: voiceSlug,
    buildDictionarySet: buildDictionarySet, spellingSetFrom: spellingSetFrom, resolveSet: resolveSet,
    buildFormsSet: buildFormsSet, formsFor: formsFor, familyCard: familyCard, FORM_SLOTS: FORM_SLOTS,
    answerTyped: answerTyped, normSpelling: normSpelling, lookMsFor: lookMsFor, spellDiff: spellDiff,
    yearRange: yearRange,
    adjustDifficulty: adjustDifficulty, levelOf: levelOf,
    coinsFor: coinsFor, speedBonus: speedBonus,
    reviewDue: reviewDue, pushReview: pushReview, pickReview: pickReview, settleReview: settleReview,
    nextCollectible: nextCollectible, shelfState: shelfState, cosmeticsUnlocked: cosmeticsUnlocked
  };
});
