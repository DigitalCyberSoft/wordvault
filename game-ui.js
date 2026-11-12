/*
 * game-ui.js - DOM, screens, input, audio and persistence for Word Vault.
 *
 * No grading lives here: game-core.js owns every rule (runs, misses, draws,
 * difficulty); this file renders state, reports the player's taps back to the
 * core, and persists progress. game-content.js carries the baked corpus.
 */
(function () {
  'use strict';
  var C = window.Core;
  var CONTENT = window.Content;
  // the holo vault renderer; a no-op stand-in keeps every call site safe if
  // game-fx.js is missing or WebGL never comes up (the SVG vault then renders)
  var noop = function () {};
  var FX = window.FX || { supported: function () { return false; }, mounted: function () { return false; },
                          mount: function () { return false; }, unmount: noop, set: noop, pulse: noop };

  function el(id) { return document.getElementById(id); }
  function show(id) { el(id).classList.add('show'); }
  function hide(id) { el(id).classList.remove('show'); }
  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // ---- persistent state ----
  // Safe storage: on a locked-down profile (managed/school tablet with site
  // data blocked) localStorage access THROWS a SecurityError; fall back to an
  // in-memory store so the game still runs for the session. Nothing is ever
  // sent anywhere; wordvault.* keys live only in this browser.
  var memStore = {};
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return (k in memStore) ? memStore[k] : null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { memStore[k] = '' + v; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { delete memStore[k]; } }
  function jsonGet(k, fallback) {
    var raw = lsGet(k);
    if (raw === null || raw === '') return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }
  // ---- learning modes ----
  // Three games share the vault: the word game (sentences), the Spelling
  // Vault and the Dictionary Vault. Each keeps its OWN school year, slips,
  // history and saved safe (mode-prefixed keys); coins, the cabinet and the
  // settings are shared. The word game keeps the original key names.
  var MODES = {
    words: { icon: '🔓', name: 'Word Vault', short: 'Words' },
    spell: { icon: '✏️', name: 'Spelling Vault', short: 'Spelling' },
    dict: { icon: '📖', name: 'Dictionary Vault', short: 'Dictionary' }
  };
  var MODE = 'words';
  function mk(k) { return MODE === 'words' ? 'wordvault.' + k : 'wordvault.' + MODE + '.' + k; }
  function inMode(m, fn) { var was = MODE; MODE = m; try { return fn(); } finally { MODE = was; } }
  var LS = {
    get coins() { var v = parseInt(lsGet('wordvault.coins'), 10); return isFinite(v) && v >= 0 ? v : 0; },
    set coins(v) { lsSet('wordvault.coins', v); },
    // The integer level 1-28 (key name kept from the float era; levelOf()
    // rounds an old float save onto the ladder). A fresh game opens at the
    // chosen starting year's first level (a grown-up knob, like the cap).
    get difficulty() {
      var v = parseFloat(lsGet(mk('difficulty')));
      return (isFinite(v) && v >= 1) ? C.levelOf(v) : C.yearStart(this.startYear);
    },
    set difficulty(v) { lsSet(mk('difficulty'), v); },
    get lastMode() { var m = lsGet('wordvault.mode'); return MODES[m] ? m : 'words'; },
    set lastMode(v) { lsSet('wordvault.mode', v); },
    get startYear() { var v = parseInt(lsGet('wordvault.startyear'), 10); return (isFinite(v) && v >= 1 && v <= 7) ? v : 1; },
    set startYear(v) { lsSet('wordvault.startyear', v); },
    // Highest level ever reached. The Level Up screen fires only on a new
    // record, never on re-climbing a level after a drop. Defaults to the
    // current level so a returning player isn't congratulated for standing
    // where they already are.
    get bestLevel() { var v = parseInt(lsGet(mk('bestlevel')), 10); return (isFinite(v) && v >= 1) ? v : C.levelOf(this.difficulty); },
    set bestLevel(v) { lsSet(mk('bestlevel'), v); },
    // Exhausted safes in a row: the second one steps down a year (Core.SLIPS_TO_DROP).
    get slips() { return +(lsGet(mk('slips')) || 0); },
    set slips(v) { lsSet(mk('slips'), v); },
    // Live clean-crack streak (spans sets, so it persists) and its record.
    get streak() { return +(lsGet(mk('streak')) || 0); },
    set streak(v) { lsSet(mk('streak'), v); },
    get bestStreak() { return +(lsGet('wordvault.beststreak') || 0); },
    set bestStreak(v) { lsSet('wordvault.beststreak', v); },
    get muted() { return lsGet('wordvault.muted') === 'on'; },
    set muted(v) { lsSet('wordvault.muted', v ? 'on' : 'off'); },
    get collectibles() { return jsonGet('wordvault.collectibles', []); },
    set collectibles(v) { lsSet('wordvault.collectibles', JSON.stringify(v)); },
    get cosmetic() { return jsonGet('wordvault.cosmetic', {}); },
    set cosmetic(v) { lsSet('wordvault.cosmetic', JSON.stringify(v)); },
    get review() { return jsonGet('wordvault.review', []); },
    set review(v) { lsSet('wordvault.review', JSON.stringify(v)); },
    get history() { return jsonGet(mk('history'), {}); },
    set history(v) { lsSet(mk('history'), JSON.stringify(v)); },
    get setsCount() { return +(lsGet(mk('setscount')) || 0); },
    set setsCount(v) { lsSet(mk('setscount'), v); },
    // setsCount value at the last review lockbox, so one due-point offers at
    // most one review (otherwise a non-empty queue would loop reviews forever).
    get reviewedAt() { var v = parseInt(lsGet('wordvault.reviewedat'), 10); return isFinite(v) ? v : -1; },
    set reviewedAt(v) { lsSet('wordvault.reviewedat', v); },
    get encounter() { return jsonGet(mk('encounter'), null); },
    set encounter(v) { if (v) lsSet(mk('encounter'), JSON.stringify(v)); else lsDel(mk('encounter')); },
    get capLevel() { var v = parseInt(lsGet('wordvault.cap'), 10); return (isFinite(v) && v >= 1) ? v : 0; },
    set capLevel(v) { lsSet('wordvault.cap', v); },
    // holo vault preference; a display setting like mute, so it survives New Game
    get fxWanted() { return lsGet('wordvault.fx') !== 'off'; },
    set fxWanted(v) { lsSet('wordvault.fx', v ? 'on' : 'off'); },
    // the lock timer; a grown-up can switch it off for slower readers
    get timerOn() { return lsGet('wordvault.timer') !== 'off'; },
    set timerOn(v) { lsSet('wordvault.timer', v ? 'on' : 'off'); }
  };

  // ---- audio ----
  // HTMLAudioElement + cloneNode so rapid taps overlap; mp3 because iOS
  // Safari can't play ogg and fetch()/decodeAudioData is CORS-blocked from
  // file://. Every clip is primed inside the first user gesture for iOS.
  var SFX_VOL = {
    tap: 0.4, whoosh: 0.5, seat: 0.9, drop: 0.5, relock: 0.7,
    door: 0.9, coin: 0.7, chime: 0.8, fanfare: 0.9, page: 0.5, alarm: 0.8
  };
  var clips = {};
  function preloadClips() {
    Object.keys(SFX_VOL).forEach(function (id) {
      var a = new Audio('assets/sfx/' + id + '.mp3');
      a.preload = 'auto';
      clips[id] = a;
    });
  }
  var audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    Object.keys(clips).forEach(function (id) {
      var a = clips[id];
      a.muted = true;
      // The sfx files are generated at the M4 art pass (tools/generate-sfx.py);
      // until they exist, and on any playback restriction, the rejected play()
      // promise is contained here so the game stays fully playable silent.
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
      a.pause(); a.currentTime = 0; a.muted = false;
    });
  }
  function playSfx(id) {
    if (LS.muted || !clips[id]) return;
    var a = clips[id].cloneNode();
    a.volume = SFX_VOL[id];
    var p = a.play();
    if (p && p.catch) p.catch(function () {}); // missing asset / autoplay policy; see unlockAudio
  }
  var Snd = {};
  Object.keys(SFX_VOL).forEach(function (id) { Snd[id] = function () { playSfx(id); }; });

  // ---- run state (in-memory; the persisted projection is LS.encounter) ----
  var S = null;

  // the grown-up cap also clamps a level reached before the cap was set
  function currentLevel() {
    var lv = C.levelOf(LS.difficulty);
    return LS.capLevel ? Math.min(lv, LS.capLevel) : lv;
  }
  // "Year 2 ●●○○": the dots are clean cracks in a row this year, so the
  // child can always see how close the next year is
  function yearProgress(lvl) {
    var done = C.stepOf(lvl), dots = '';
    for (var i = 0; i < C.STEPS_PER_YEAR; i++) dots += i < done ? '●' : '○';
    return dots;
  }
  function refreshHud() {
    el('coins').textContent = LS.coins;
    var lvl = currentLevel();
    el('mode-ico').textContent = MODES[MODE].icon;
    el('level-pill').textContent = 'Year ' + C.yearOf(lvl) + ' ' + yearProgress(lvl);
    el('level-pill').title = C.cleanToPass(lvl) + ' clean crack' + (C.cleanToPass(lvl) === 1 ? '' : 's') +
      ' in a row to pass Year ' + C.yearOf(lvl);
    el('beststreak').textContent = LS.bestStreak;
    el('mute-toggle').textContent = LS.muted ? '🔇 Sound off' : '🔊 Sound on';
  }
  function rankFor(level) {
    return level >= 25 ? 'Master of the Vault'
      : level >= 19 ? 'Safecracker'
      : level >= 13 ? 'Combination Wiz'
      : level >= 7 ? 'Tumbler Turner'
      : 'Lockpick Apprentice';
  }

  // ---- encounter persistence ----
  // The snapshot is the encounter REWOUND to the top of its current run, so a
  // reload resumes at the run boundary: used sentence pairs and misses are
  // kept (no repeats, no free extra runs), the in-flight streak is not.
  function persistEncounter() {
    if (!S || !S.enc) { LS.encounter = null; return; }
    var snap = JSON.parse(JSON.stringify(S.enc));
    if (snap.state === 'run') {
      snap.state = snap.misses > 0 ? 'miss' : 'ready';
      snap.runIndex = Math.max(0, snap.runIndex - 1);
      snap.correctInRun = 0;
      snap.runUsed = [];
      snap.sentenceId = null;
    }
    if (snap.state === 'cracked' || snap.state === 'exhausted' || snap.state === 'failed') {
      LS.encounter = null; return;
    }
    LS.encounter = { setId: S.set.id, review: S.review, reviewEntry: S.reviewEntry || null, enc: snap };
  }

  // ---- picking what comes next ----
  // a real set id -> the set this mode plays (virtual for spelling/dictionary)
  function modeSetId(srcId) {
    return MODE === 'dict' ? 'D' + C.yearOf(currentLevel()) + ':' + srcId : MODE === 'spell' ? 'S:' + srcId : srcId;
  }
  function setById(id) { return C.resolveSet(CONTENT.data, id); }
  function pickNext() {
    // dev hooks may pin the first safe to a named set (#missdemo=B-time-deixis-01)
    if (S && S.forceSetId) {
      var forced = setById(modeSetId(S.forceSetId));
      S.forceSetId = null;
      if (forced) { beginEncounter(forced, {}); return; }
    }
    // review lockboxes belong to the word game
    var queue = LS.review;
    if (MODE === 'words' && C.reviewDue(LS.setsCount, queue) && LS.reviewedAt !== LS.setsCount) {
      var pick = C.pickReview(queue);
      var set = setById(pick.entry.setId);
      if (set) { beginEncounter(set, { review: true, entry: pick.entry }); return; }
    }
    var history = LS.history;
    var setId = C.pickSet(CONTENT.data, {
      level: currentLevel(), history: history, lastSetId: S && S.set ? (S.set.srcId || S.set.id) : null,
      // usage sets (their/there, borrow/lend) carry usage notes, not dictionary meanings
      filter: MODE === 'dict' ? function (c, id) { return id.charAt(0) !== 'C'; } : null
    }, C.makeRng(Date.now() >>> 0));
    beginEncounter(setById(modeSetId(setId)), {});
  }

  function beginEncounter(set, opts) {
    var rng = C.makeRng((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    S = {
      set: set,
      review: !!opts.review,
      reviewEntry: opts.entry || null,
      enc: opts.resume || C.newEncounter(set, { review: !!opts.review, level: currentLevel() }, rng),
      rng: rng,
      startedAt: Date.now(),
      answered: 0,
      busy: false,
      queuedLevelUp: 0,
      auto: S ? S.auto : null,
      holdCards: S ? !!S.holdCards : false
    };
    persistEncounter();
    showReady();
  }

  // A gloss card: the word, its card gloss, and a Year chip so the child can
  // see which school year each word belongs to.
  function glossCard(word) {
    var card = document.createElement('div');
    card.className = 'gloss-card';
    var b = document.createElement('b'); b.textContent = word.w;
    var span = document.createElement('span'); span.textContent = word.gloss;
    card.appendChild(b); card.appendChild(span);
    if (typeof word.grade === 'number') {
      var chip = document.createElement('i');
      chip.className = 'year-chip';
      chip.textContent = 'Y' + word.grade;
      chip.title = 'Year ' + word.grade + ' word';
      card.appendChild(chip);
    }
    return card;
  }

  // ---- Get Ready ----
  function showReady() {
    var enc = S.enc, set = S.set;
    el('ready-title').textContent = S.review ? '🔐 Review lockbox: ' + set.theme
      : MODE === 'spell' ? '✏️ Spelling list: ' + set.theme
      : MODE === 'dict' ? '📖 Dictionary page: ' + set.theme
      : 'The job: ' + set.theme;
    el('ready-btn').textContent = MODE === 'spell' ? 'I’ve read the list — start spelling ▶'
      : MODE === 'dict' ? 'I’ve read the page — open the job ▶' : 'I’ve read them — open the job ▶';
    var runsLeft = enc.runsAllowed - enc.misses;
    el('ready-runs').textContent = S.review
      ? '1 run · 3 pins to open · one miss and it stays shut'
      : (enc.misses ? 'Run ' + (enc.runIndex + 1) + ' of ' + enc.runsAllowed + ' · fresh sentences this run'
                    : enc.runsAllowed + ' runs · ' + enc.need + ' in a row cracks it');
    var yr = C.yearRange(set);
    el('ready-year').hidden = !yr;
    if (yr) el('ready-year').textContent = '🎓 ' + yr.label + ' words';
    el('year-stat').hidden = !yr;
    if (yr) el('year-pill').textContent = yr.label;
    var box = el('ready-glosses');
    box.innerHTML = '';
    // Gloss cards in the authored order: the semantic gradient, not the
    // shuffled play order, so the child builds the scale before playing.
    // the Dictionary Vault shows its page in ABC order, like a real dictionary
    (MODE === 'dict' ? C.alphaSort(C.gradientOrder(set)) : C.gradientOrder(set)).forEach(function (w) {
      var word = null;
      for (var i = 0; i < set.words.length; i++) if (set.words[i].w === w) word = set.words[i];
      box.appendChild(glossCard(word));
    });
    renderPins();
    renderDoor(false);
    FX.pulse('boot');
    timerStop();
    el('slip-text').textContent = '';
    renderTilesBlank();
    showInputFor(MODE);
    show('ready-overlay');
    if (S.auto) autoContinue('ready-btn');
  }

  function startRun() {
    hide('ready-overlay');
    C.startRun(S.enc);
    persistEncounter();
    nextSentence();
  }

  // ---- the sentence loop ----
  function currentSentence() { return C.sentenceById(S.set, S.enc.sentenceId); }

  function nextSentence() {
    var s = C.drawSentence(S.enc, S.set, S.rng);
    persistEncounter();
    renderSlip(s);
    renderPins();
    S.busy = false;
    if (MODE === 'spell') { startSpell(s); return; }
    renderTiles(s);
    timerStart();
    if (S.auto) autoAnswer(s);
  }

  function renderSlip(sentence) {
    var box = el('slip');
    box.classList.remove('deal');
    void document.body.offsetWidth;
    box.classList.add('deal');
    var slip = el('slip-text');
    slip.innerHTML = '';
    var parts = sentence.text.split('___');
    slip.appendChild(document.createTextNode(parts[0]));
    var blank = document.createElement('span');
    blank.id = 'blank';
    blank.textContent = ' ';
    slip.appendChild(blank);
    slip.appendChild(document.createTextNode(parts[1] || ''));
  }

  function renderTiles(sentence) {
    var tiles = el('tiles').children;
    for (var i = 0; i < tiles.length; i++) {
      var w = S.enc.tileOrder[i];
      tiles[i].textContent = sentence.surface[w];
      tiles[i].setAttribute('data-word', w);
      tiles[i].classList.remove('gone', 'held');
      tiles[i].disabled = false;
    }
  }
  function renderTilesBlank() {
    var tiles = el('tiles').children;
    for (var i = 0; i < tiles.length; i++) {
      tiles[i].textContent = '·····';
      tiles[i].setAttribute('data-word', '');
      tiles[i].disabled = true;
    }
  }

  function renderPins() {
    var pins = el('mech').querySelectorAll('.pinstack');
    for (var i = 0; i < pins.length; i++) {
      pins[i].classList.remove('spring');
      pins[i].classList.toggle('seated', i < S.enc.correctInRun);
      // locks grow pins with the band (2..5); hide the spare channels
      pins[i].style.display = (i < S.enc.need) ? '' : 'none';
    }
    // the alarm lamps track misses this encounter; three rings the klaxon
    var lamps = el('alarm-box').querySelectorAll('.lamp');
    for (var j = 0; j < lamps.length; j++) {
      lamps[j].classList.toggle('on', j < S.enc.misses);
    }
    if (S.enc.misses === 0) el('vault').classList.remove('alarm');
    FX.set({ need: S.enc.need, seated: S.enc.correctInRun, misses: S.enc.misses });
  }
  function springPins() {
    FX.pulse('spring');
    FX.set({ seated: 0 });
    var pins = el('mech').querySelectorAll('.pinstack');
    for (var i = 0; i < pins.length; i++) {
      if (pins[i].classList.contains('seated')) pins[i].classList.add('spring');
    }
    setTimeout(function () {
      for (var i = 0; i < pins.length; i++) pins[i].classList.remove('seated', 'spring');
    }, reducedMotion() ? 0 : 560);
  }

  function renderDoor(open) {
    if (!open) el('vault').classList.remove('unbolted');
    el('vault').classList.toggle('open', !!open);
    FX.set({ door: !!open });
  }
  // juice: the dial accumulates a quarter-turn per seated pin (whole turns on
  // the crack), and the mech panel takes a 2px thunk on every seat. The turn
  // counter lives outside S so the dial never rewinds across encounters.
  var dialTurns = 0;
  function dialTurn(quarters) {
    dialTurns += quarters;
    el('dial').style.setProperty('--turns', dialTurns);
    FX.pulse('dial', quarters);
  }
  function mechThunk() {
    var m = el('mech');
    m.classList.remove('thunk');
    void document.body.offsetWidth;
    m.classList.add('thunk');
  }
  // the opening beat: bolt slides clear, the handle drops, then the door
  // swings and the interior light blooms
  function openVault(cb) {
    el('vault').classList.add('unbolted');
    FX.pulse('open');
    Snd.relock();
    dialTurn(8);
    afterMs(680, function () {
      renderDoor(true);
      Snd.door();
      cb();
    });
  }
  // crack payout: six coins arc from the vault to the HUD tally
  function spawnCoins() {
    if (reducedMotion()) return;
    var from = el('vault').getBoundingClientRect();
    var to = el('coins').getBoundingClientRect();
    var stat = el('coins').parentNode;
    for (var i = 0; i < 6; i++) (function (i) {
      setTimeout(function () {
        var c = document.createElement('div');
        c.className = 'coin-fly';
        var x0 = from.left + from.width / 2 - 11, y0 = from.top + from.height / 2 - 11;
        c.style.left = x0 + 'px';
        c.style.top = y0 + 'px';
        document.body.appendChild(c);
        c.getBoundingClientRect(); // reflow so the transition runs
        c.style.transform = 'translate(' + (to.left + to.width / 2 - 11 - x0) + 'px,' +
          (to.top + to.height / 2 - 11 - y0) + 'px) scale(.5)';
        c.style.opacity = '.2';
        setTimeout(function () {
          c.parentNode && c.parentNode.removeChild(c);
          stat.classList.remove('tick');
          void document.body.offsetWidth;
          stat.classList.add('tick');
        }, 570);
      }, i * 70);
    })(i);
  }

  // ---- the lock timer ----
  // Core.lockTimerFor(level) on the clock per sentence (20 s in Years 1-2,
  // 15 s from Year 3); running out is a miss
  // (Core.timeout). The clock runs ONLY while a sentence is up - overlays,
  // cards and the ready screen all stop it - and it pauses while the tab is
  // hidden, so switching away never fails a lock on return. Under reduced
  // motion the bar steps once a second instead of animating.
  var timer = { deadline: 0, raf: 0, left: 0, total: C.LOCK_TIMER_MS };
  function timerStop() {
    cancelAnimationFrame(timer.raf);
    clearTimeout(timer.raf);
    timer.deadline = 0;
    el('timer-wrap').hidden = true;
    FX.set({ clock: -1 });
  }
  function timerStart() {
    timerStop();
    if (!LS.timerOn || MODE === 'spell') return;
    timer.total = C.lockTimerFor(currentLevel()) + (MODE === 'dict' ? 5000 : 0);
    timer.deadline = Date.now() + timer.total;
    el('timer-wrap').hidden = false;
    timerTick();
  }
  function timerTick() {
    if (!timer.deadline) return;
    var left = timer.deadline - Date.now();
    if (left <= 0) { onTimeout(); return; }
    var f = left / timer.total;
    el('timer-fill').style.transform = 'scaleX(' + f.toFixed(4) + ')';
    el('timer-num').textContent = Math.ceil(left / 1000);
    el('timer-wrap').classList.toggle('low', left < 5000);
    FX.set({ clock: f });
    timer.raf = reducedMotion()
      ? setTimeout(timerTick, 250)
      : requestAnimationFrame(timerTick);
  }
  document.addEventListener('visibilitychange', function () {
    if (!timer.deadline) return;
    if (document.hidden) {
      timer.left = Math.max(0, timer.deadline - Date.now());
      cancelAnimationFrame(timer.raf);
      clearTimeout(timer.raf);
    } else {
      timer.deadline = Date.now() + Math.max(timer.left, 1500); // a beat to re-orient
      timerTick();
    }
  });

  function onTimeout() {
    timerStop();
    if (!S || S.busy || S.enc.state !== 'run') return;
    S.busy = true;
    var sentence = currentSentence();
    var res = C.timeout(S.enc, S.set);
    Snd.drop();
    el('stage').classList.add('dimmed');
    FX.pulse('fail', 1); // timeout flavour: discharge + rings wind back
    vaultShudder();
    springPins();
    afterMs(620, function () {
      el('stage').classList.remove('dimmed');
      if (res.state === 'miss') showTimeoutCard(sentence, true);
      else if (res.state === 'exhausted') {
        renderPins();
        el('vault').classList.add('alarm');
        FX.pulse('alarm');
        Snd.alarm();
        afterMs(750, function () { showTimeoutCard(sentence, false); });
      } else {
        onReviewTimeout(sentence);
      }
    });
  }
  // classic-vault failure animation: the whole door takes a shudder
  function vaultShudder() {
    var v = el('vault');
    v.classList.remove('shudder');
    void document.body.offsetWidth;
    v.classList.add('shudder');
    setTimeout(function () { v.classList.remove('shudder'); }, reducedMotion() ? 0 : 620);
  }

  // ---- the flying tile ----
  function afterMs(ms, fn) { setTimeout(fn, reducedMotion() ? 0 : ms); }
  function flyGhost(fromEl, toEl, cb) {
    if (reducedMotion()) { cb(null); return; }
    var from = fromEl.getBoundingClientRect();
    var to = toEl.getBoundingClientRect();
    var ghost = fromEl.cloneNode(true);
    ghost.id = 'tile-ghost';
    ghost.style.left = from.left + 'px';
    ghost.style.top = from.top + 'px';
    ghost.style.width = from.width + 'px';
    ghost.style.height = from.height + 'px';
    document.body.appendChild(ghost);
    fromEl.classList.add('gone');
    ghost.getBoundingClientRect(); // reflow so the transition actually runs
    ghost.style.transform = 'translate(' + (to.left + to.width / 2 - from.left - from.width / 2) + 'px,' +
      (to.top + to.height / 2 - from.top - from.height / 2) + 'px) scale(.72)';
    setTimeout(function () { cb(ghost); }, 310);
  }
  function dropGhostBack(ghost, fromEl, cb) {
    if (!ghost) { cb(); return; }
    ghost.classList.add('shake');
    setTimeout(function () {
      ghost.style.transform = 'translate(0,0)';
      setTimeout(function () {
        ghost.parentNode && ghost.parentNode.removeChild(ghost);
        fromEl.classList.remove('gone');
        cb();
      }, 270);
    }, 290);
  }

  // ---- answering ----
  function answerWith(word, tileEl) {
    if (!S || S.busy || S.enc.state !== 'run') return;
    S.busy = true;
    timerStop(); // the commit beats the clock; grading animation runs untimed
    var sentence = currentSentence();
    Snd.whoosh();
    flyGhost(tileEl, el('blank'), function (ghost) {
      var res = C.answer(S.enc, S.set, sentence, word);
      S.answered += 1;
      if (res.correct) {
        if (ghost) { ghost.parentNode.removeChild(ghost); tileEl.classList.remove('gone'); }
        gradedRight(res, sentence.surface[word]);
      } else {
        failBeat();
        dropGhostBack(ghost, tileEl, function () { gradedWrong(res, sentence, word); });
      }
    });
  }
  // shared by tiles and typed spellings: a seated pin, or the relock beat
  function gradedRight(res, shown) {
    var blank = el('blank');
    blank.classList.remove('typing', 'looking');
    blank.textContent = shown;
    blank.classList.add('filled', 'glow');
    Snd.seat();
    renderPins();
    dialTurn(1);
    mechThunk();
    if (res.state === 'cracked') {
      afterMs(500, function () { S.review ? onReviewOpened() : onCracked(); });
    } else {
      afterMs(520, nextSentence);
    }
  }
  function failBeat() {
    Snd.drop();
    el('stage').classList.add('dimmed');
    FX.pulse('fail', 0); // wrong-word flavour: discharge and power flicker
    vaultShudder();
  }
  function gradedWrong(res, sentence, picked) {
    Snd.relock();
    springPins();
    afterMs(480, function () {
      el('stage').classList.remove('dimmed');
      if (res.state === 'miss') showMissCard(sentence, picked, true);
      else if (res.state === 'exhausted') {
        // light the third lamp NOW (renderPins otherwise waits for the
        // next ready screen), then ring the klaxon and show the card
        renderPins();
        el('vault').classList.add('alarm');
        FX.pulse('alarm');
        Snd.alarm();
        afterMs(750, function () { showMissCard(sentence, picked, false); });
      }
      else onReviewFailed(sentence, picked);
    });
  }

  // ---- Spelling Vault: Look, Cover, Write, Check ----
  // LOOK: the word sits in the slip's blank, lit gold (spoken aloud when the
  // device has an on-device voice); COVER: after lookMsFor(level) or a tap;
  // WRITE: on-screen or physical keyboard; CHECK: graded by Core.answerTyped.
  // three rows so the whole keyboard fits under the vault on a laptop screen:
  // letters plus apostrophe and hyphen, with Back, Hear and Check on the ends
  var KEY_ROWS = [['qwertyuiop', 'back'], ["asdfghjkl'-", null], ['zxcvbnm', 'check']];
  var spellTimer = 0;
  function showInputFor(mode) {
    el('tiles').hidden = mode === 'spell';
    el('speller').hidden = mode !== 'spell';
    if (mode === 'spell') { el('spell-look').hidden = true; el('spell-write').hidden = true; }
  }
  function keyBtn(label, attrs, cls) {
    var k = document.createElement('button');
    k.className = 'key' + (cls ? ' ' + cls : '');
    k.textContent = label;
    for (var a in attrs) k.setAttribute(a, attrs[a]);
    return k;
  }
  function buildKeys() {
    KEY_ROWS.forEach(function (row, r) {
      var box = el('krow-' + (r + 1));
      box.innerHTML = '';
      if (row[1] === 'check') box.appendChild(keyBtn('🔊', { id: 'spell-hear', 'aria-label': 'hear the word', hidden: '' }, 'wide'));
      row[0].split('').forEach(function (ch) {
        box.appendChild(keyBtn(ch === "'" ? '’' : ch, { 'data-ch': ch,
          'aria-label': ch === "'" ? 'apostrophe' : ch === '-' ? 'hyphen' : ch }));
      });
      if (row[1] === 'back') box.appendChild(keyBtn('⌫', { id: 'spell-back', 'aria-label': 'delete a letter' }, 'wide'));
      if (row[1] === 'check') box.appendChild(keyBtn('✔ Check', { id: 'spell-check' }, 'wide go'));
    });
  }
  // On-device voices only: a network voice would send the word off the
  // device, and this game promises no network at play time.
  function localVoice() {
    if (!window.speechSynthesis || !speechSynthesis.getVoices) return null;
    var vs = speechSynthesis.getVoices().filter(function (v) { return v.localService && /^en/i.test(v.lang); });
    var au = vs.filter(function (v) { return /en[-_]AU/i.test(v.lang); });
    return au[0] || vs[0] || null;
  }
  function speak(word) {
    var v = localVoice();
    if (!v || LS.muted) return;
    var u = new SpeechSynthesisUtterance(word);
    u.voice = v; u.lang = v.lang; u.rate = 0.85;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
  function spellTarget() { var s = currentSentence(); return s ? s.surface[s.answer] : ''; }
  function startSpell(sentence) {
    clearTimeout(spellTimer);
    S.spell = { phase: 'look', typed: '' };
    var blank = el('blank');
    blank.className = 'looking';
    blank.textContent = sentence.surface[sentence.answer];
    var canHear = !!localVoice();
    el('spell-hear-look').hidden = !canHear;
    el('spell-hear').hidden = !canHear;
    el('spell-look').hidden = false;
    el('spell-write').hidden = true;
    speak(sentence.surface[sentence.answer]);
    spellTimer = setTimeout(coverWord, S.auto ? 300 : C.lookMsFor(currentLevel()));
  }
  function coverWord() {
    clearTimeout(spellTimer);
    if (!S || !S.spell || S.spell.phase !== 'look' || S.enc.state !== 'run') return;
    S.spell.phase = 'write';
    el('spell-look').hidden = true;
    el('spell-write').hidden = false;
    renderTyped();
    Snd.page();
    if (S.auto) autoSpell();
  }
  function renderTyped() {
    var blank = el('blank');
    blank.className = 'typing';
    blank.textContent = S.spell.typed.replace(/'/g, '’');
  }
  function typeKey(ch) {
    if (!S || S.busy || !S.spell || S.spell.phase !== 'write') return;
    if (S.spell.typed.length >= spellTarget().length + 6) return;
    S.spell.typed += ch;
    Snd.tap();
    renderTyped();
  }
  function backKey() {
    if (!S || S.busy || !S.spell || S.spell.phase !== 'write') return;
    S.spell.typed = S.spell.typed.slice(0, -1);
    renderTyped();
  }
  function checkSpelling() {
    if (!S || S.busy || !S.spell || S.spell.phase !== 'write' || S.enc.state !== 'run') return;
    if (!S.spell.typed.trim()) return; // an empty check is a slip of the finger, not an answer
    S.busy = true;
    S.spell.phase = 'checked';
    var sentence = currentSentence();
    var res = C.answerTyped(S.enc, S.set, sentence, S.spell.typed);
    S.answered += 1;
    el('spell-write').hidden = true;
    if (res.correct) gradedRight(res, sentence.surface[sentence.answer]);
    else { failBeat(); afterMs(300, function () { gradedWrong(res, sentence, res.typed); }); }
  }
  function onSpellKeydown(e) {
    if (MODE !== 'spell' || !S || !S.spell || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.overlay.show')) return;
    if (S.spell.phase === 'look' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); coverWord(); return; }
    if (S.spell.phase !== 'write') return;
    if (e.key === 'Enter') { e.preventDefault(); checkSpelling(); }
    else if (e.key === 'Backspace') { e.preventDefault(); backKey(); }
    else if (/^[a-zA-Z'’-]$/.test(e.key)) { e.preventDefault(); typeKey(e.key.toLowerCase().replace('’', "'")); }
  }

  // ---- miss card (contrastive feedback) ----
  // Scaled sets (the time ladders) draw a when-line under the word cards:
  // five ticks in gradient order, the fitting word lit gold, the picked word
  // dimmed. Sets without a scale never show it.
  function fillWhenline(answer, picked) {
    var wl = el('whenline');
    var scale = S.set && S.set.scale;
    if (!scale) { wl.hidden = true; return; }
    el('wl-left').textContent = scale.left;
    el('wl-right').textContent = scale.right;
    var rail = el('wl-rail');
    rail.innerHTML = '';
    S.set.words.forEach(function (w) {
      var tick = document.createElement('span');
      tick.className = 'wl-tick' +
        (w.w === answer ? ' is-right' : '') +
        (picked && w.w === picked ? ' is-picked' : '');
      tick.appendChild(document.createElement('i'));
      var lab = document.createElement('em');
      lab.textContent = w.w;
      tick.appendChild(lab);
      rail.appendChild(tick);
    });
    wl.hidden = false;
  }
  function letters(cells) {
    var box = document.createElement('span');
    box.className = 'ltrs';
    cells.forEach(function (c) {
      var sp = document.createElement('span');
      sp.className = 'ltr' + (c.ok ? '' : ' bad');
      sp.textContent = c.ch === "'" ? '’' : c.ch;
      box.appendChild(sp);
    });
    return box;
  }
  function fillSpellCard(sentence, typed) {
    var target = sentence.surface[sentence.answer], d = C.spellDiff(target, typed);
    el('miss-title').textContent = '✏️ Not quite — check the letters';
    el('miss-right-h').textContent = 'The right spelling';
    el('miss-picked-h').textContent = 'You wrote';
    el('miss-cue').innerHTML = '';
    var read = document.createElement('span');
    read.appendChild(document.createTextNode('The slip wanted: “'));
    var strong = document.createElement('b');
    strong.textContent = C.fillText(sentence, sentence.answer);
    read.appendChild(strong);
    read.appendChild(document.createTextNode('”.'));
    el('miss-cue').appendChild(read);
    var right = null;
    S.set.words.forEach(function (x) { if (x.w === sentence.answer) right = x; });
    el('miss-right-word').innerHTML = '';
    el('miss-right-word').appendChild(letters(d.right));
    el('miss-right-gloss').textContent = right ? right.w + ': ' + right.gloss : '';
    el('miss-picked-word').innerHTML = '';
    el('miss-picked-word').appendChild(letters(d.wrote.length ? d.wrote : [{ ch: '—', ok: false }]));
    el('miss-picked-gloss').textContent = '';
    el('miss-line').textContent = d.tip;
    el('whenline').hidden = true;
  }
  function fillMissCard(sentence, picked) {
    if (MODE === 'spell') { fillSpellCard(sentence, picked); return; }
    el('miss-title').textContent = 'The tumblers reset';
    el('miss-right-h').textContent = 'The word that fits';
    el('miss-picked-h').textContent = 'You picked';
    var con = C.contrastFor(S.set, sentence, picked);
    el('miss-cue').innerHTML = '';
    var read = document.createElement('span');
    read.appendChild(document.createTextNode(MODE === 'dict' ? 'The page wanted: “' : 'The slip wanted: “'));
    var strong = document.createElement('b');
    strong.textContent = con.filled;
    read.appendChild(strong);
    // a meaning question's cue IS the meaning, already quoted in the answer
    read.appendChild(document.createTextNode(sentence.kind === 'meaning' ? '”.' : '” — the cue was “' + con.cue + '”.'));
    el('miss-cue').appendChild(read);
    el('miss-right-word').textContent = con.right.surface;
    el('miss-right-gloss').textContent = con.right.gloss;
    el('miss-picked-word').textContent = con.picked.surface;
    el('miss-picked-gloss').textContent = con.picked.gloss;
    el('miss-line').textContent = con.line;
    fillWhenline(sentence.answer, picked);
  }
  // the first miss of a safe is when the in-a-row run breaks; say so once
  function streakNote() {
    return S.enc.misses === 1 && !S.review
      ? ' You can still crack it, but the Year ' + C.yearOf(currentLevel()) + ' run will start again.'
      : '';
  }
  function showMissCard(sentence, picked, runsRemain) {
    fillMissCard(sentence, picked);
    var left = S.enc.runsAllowed - S.enc.misses;
    el('miss-runs-left').textContent = runsRemain
      ? (left === 1 ? 'Last run. Read the cue twice.' : left + ' runs left.') + streakNote()
      : 'That was the last run for this safe.';
    el('miss-next').textContent = runsRemain ? 'Try the next run ▶' : 'See the words ▶';
    S.missWasFinal = !runsRemain;
    persistEncounter();
    // history counts every miss so the review queue can prioritise
    Snd.page();
    show('miss-overlay');
    if (S.auto && !S.holdCards) autoContinue('miss-next');
  }
  function missNext() {
    hide('miss-overlay');
    if (S.missWasFinal) { onExhausted(); return; }
    showReady(); // the relock is a beat: re-show the gloss cards, then run again
  }

  // ---- timeout card: same overlay, but there is no picked word to contrast ----
  function fillTimeoutCard(sentence) {
    el('miss-title').textContent = '⏱ Too slow — the lock re-sealed';
    el('miss-right-h').textContent = 'The word that fits';
    el('miss-picked-h').textContent = 'The clock';
    var right = null;
    S.set.words.forEach(function (x) { if (x.w === sentence.answer) right = x; });
    el('miss-cue').innerHTML = '';
    var read = document.createElement('span');
    read.appendChild(document.createTextNode('The slip wanted: “'));
    var strong = document.createElement('b');
    strong.textContent = C.fillText(sentence, sentence.answer);
    read.appendChild(strong);
    read.appendChild(document.createTextNode('” — the cue was “' + (sentence.cue_phrase || '') + '”.'));
    el('miss-cue').appendChild(read);
    el('miss-right-word').textContent = sentence.surface[sentence.answer];
    el('miss-right-gloss').textContent = right ? right.gloss : '';
    el('miss-picked-word').textContent = '⏱ ' + Math.round(timer.total / 1000) + 's';
    el('miss-picked-gloss').textContent = 'The timer ran out before a word was chosen.';
    el('miss-line').textContent = 'Read the cue first, then scan the tiles — there is plenty of time once you know what you’re hunting for.';
    fillWhenline(sentence.answer, null);
  }
  function showTimeoutCard(sentence, runsRemain) {
    fillTimeoutCard(sentence);
    var left = S.enc.runsAllowed - S.enc.misses;
    el('miss-runs-left').textContent = runsRemain
      ? (left === 1 ? 'Last run. Cue first, then tiles.' : left + ' runs left.') + streakNote()
      : 'That was the last run for this safe.';
    el('miss-next').textContent = runsRemain ? 'Try the next run ▶' : 'See the words ▶';
    S.missWasFinal = !runsRemain;
    persistEncounter();
    Snd.page();
    show('miss-overlay');
    if (S.auto && !S.holdCards) autoContinue('miss-next');
  }
  function onReviewTimeout(sentence) {
    LS.review = C.settleReview(LS.review, S.reviewEntry, false);
    LS.reviewedAt = LS.setsCount;
    LS.encounter = null;
    fillTimeoutCard(sentence);
    el('miss-runs-left').textContent = 'The lockbox stays shut this time - it will come back around.';
    el('miss-next').textContent = 'Onward ▶';
    S.missWasFinal = false;
    S.reviewDone = true;
    Snd.page();
    show('miss-overlay');
    if (S.auto && !S.holdCards) autoContinue('miss-next');
  }

  // ---- outcomes ----
  function recordHistory(outcome) {
    var h = LS.history;
    var hid = S.set.srcId || S.set.id;
    var entry = h[hid] || { plays: 0, cracks: 0, exhausts: 0 };
    entry.plays += 1;
    if (outcome === 'crack') entry.cracks += 1;
    if (outcome === 'exhausted') entry.exhausts += 1;
    entry.at = Date.now();
    h[hid] = entry;
    LS.history = h;
  }

  // One line under the crack/exhaust card saying where the child now stands
  // on the year ladder - the in-a-row rule only motivates if it is visible.
  function progressLine(ev, lvl, stuck) {
    var yr = C.yearOf(lvl), left = C.cleanToPass(lvl);
    var more = left + ' clean crack' + (left === 1 ? '' : 's') + ' in a row to pass Year ' + yr + '.';
    if (ev === 'promoted') return '🎓 Year ' + (yr - 1) + ' passed - welcome to Year ' + yr + '!';
    if (ev === 'step') return 'Clean crack! ' + yearProgress(lvl) + ' ' + (left === 1 ? 'One more clean crack passes Year ' + yr + '!' : more);
    if (ev === 'top') return lvl >= C.MAX_LEVEL ? 'Top of the ladder - Master of the Vault!' : 'Clean crack! That is as high as Settings allow for now.';
    if (ev === 'reset') return (stuck ? 'This safe stayed shut' : 'A pin slipped on the way') +
      ', so the Year ' + yr + ' run starts again: ' + more;
    if (ev === 'demoted') return 'Let’s step back to Year ' + yr + ' and build up again: ' + more;
    return more;
  }

  function onCracked() {
    var clean = C.isClean(S.enc);
    LS.streak = clean ? LS.streak + 1 : 0;
    if (clean) LS.bestStreak = Math.max(LS.bestStreak, LS.streak);
    var adj = C.adjustDifficulty(currentLevel(), clean ? 'clean-crack' : 'crack', LS.slips, LS.capLevel);
    LS.difficulty = adj.difficulty;
    LS.slips = adj.slips;
    S.progressLine = progressLine(adj.event, adj.difficulty);
    var coins = C.coinsFor('crack', currentLevel(), S.enc.need) +
      C.speedBonus(Date.now() - S.startedAt, S.answered);
    LS.coins = LS.coins + coins;
    var owned = LS.collectibles;
    var reward = C.nextCollectible(owned);
    if (reward) { owned.push(reward.itemId); LS.collectibles = owned; }
    recordHistory('crack');
    LS.setsCount = LS.setsCount + 1;
    if (MODE === 'words') LS.review = C.pushReview(LS.review, { setId: S.set.id, exhausted: false, at: Date.now() });
    // the big celebration is for passing a year for the first time
    var newLevel = currentLevel();
    if (adj.event === 'promoted' && newLevel > LS.bestLevel) S.queuedLevelUp = newLevel;
    if (newLevel > LS.bestLevel) LS.bestLevel = newLevel;
    LS.encounter = null;
    refreshHud();
    el('vault-reward').textContent = reward ? reward.emoji : '🪙';
    openVault(function () { spawnCoins(); afterMs(850, function () {
      el('crack-collectible').innerHTML = '';
      var big = document.createElement('div');
      big.style.fontSize = '4rem';
      if (reward) collectibleIcon(reward, big); else big.textContent = '🪙';
      var name = document.createElement('p');
      name.style.fontWeight = '800';
      name.textContent = reward ? reward.name : 'The cabinet is full - coins only!';
      el('crack-collectible').appendChild(big);
      el('crack-collectible').appendChild(name);
      el('crack-coins').textContent = '+' + coins + ' coins';
      el('crack-progress').textContent = S.progressLine || '';
      var shelf = reward ? C.shelfState(LS.collectibles).filter(function (s) { return s.shelfId === reward.shelfId; })[0] : null;
      el('crack-shelf').textContent = shelf
        ? (shelf.complete ? '★ ' + shelf.name + ' complete! New look unlocked in the Cabinet.'
                          : shelf.name + ': ' + shelf.owned + ' of ' + shelf.total)
        : '';
      Snd.coin();
      if (shelf && shelf.complete) Snd.chime();
      show('crack-overlay');
      if (S.auto) autoContinue('crack-next');
    }); });
  }
  function crackNext() {
    hide('crack-overlay');
    renderDoor(false);
    el('vault-reward').textContent = ' ';
    if (S.queuedLevelUp) {
      el('levelup-num').textContent = (MODE === 'words' ? '' : MODES[MODE].icon + ' ' + MODES[MODE].short + ' · ') +
        'Year ' + C.yearOf(S.queuedLevelUp);
      el('levelup-rank').textContent = rankFor(S.queuedLevelUp) +
        ' · new words, and the vaults start again at 2 pins';
      S.queuedLevelUp = 0;
      Snd.fanfare();
      show('levelup-overlay');
      if (S.auto) autoContinue('levelup-btn');
      return; // levelup button continues to pickNext
    }
    pickNext();
  }

  function onExhausted() {
    var adj = C.adjustDifficulty(currentLevel(), 'exhausted', LS.slips, LS.capLevel);
    LS.difficulty = adj.difficulty;
    LS.slips = adj.slips;
    LS.streak = 0;
    el('exhaust-progress').textContent = progressLine(adj.event, adj.difficulty, true);
    recordHistory('exhausted');
    LS.setsCount = LS.setsCount + 1;
    if (MODE === 'words') LS.review = C.pushReview(LS.review, { setId: S.set.id, exhausted: true, at: Date.now() });
    LS.encounter = null;
    refreshHud();
    var box = el('exhaust-words');
    box.innerHTML = '';
    C.missedWords(S.enc, S.set).forEach(function (w) {
      box.appendChild(glossCard(w));
    });
    show('exhaust-overlay');
    if (S.auto) autoContinue('exhaust-next');
  }

  function onReviewOpened() {
    var coins = C.coinsFor('review-opened', currentLevel());
    LS.coins = LS.coins + coins;
    LS.review = C.settleReview(LS.review, S.reviewEntry, true);
    LS.reviewedAt = LS.setsCount;
    LS.encounter = null;
    refreshHud();
    openVault(function () {
      el('crack-collectible').innerHTML = '<div style="font-size:4rem">🔓</div><p style="font-weight:800">Still yours! The words held.</p>';
      el('crack-coins').textContent = '+' + coins + ' coins';
      el('crack-progress').textContent = 'Review lockboxes never change your year.';
      el('crack-shelf').textContent = '';
      show('crack-overlay');
      if (S.auto) autoContinue('crack-next');
    });
  }
  function onReviewFailed(sentence, picked) {
    LS.review = C.settleReview(LS.review, S.reviewEntry, false);
    LS.reviewedAt = LS.setsCount;
    LS.encounter = null;
    fillMissCard(sentence, picked);
    el('miss-runs-left').textContent = 'The lockbox stays shut this time - it will come back around.';
    el('miss-next').textContent = 'Onward ▶';
    S.missWasFinal = false;
    S.reviewDone = true;
    Snd.page();
    show('miss-overlay');
    if (S.auto && !S.holdCards) autoContinue('miss-next');
  }

  // ---- input: tap answers, long-press peeks (below the help threshold) ----
  var press = null;
  var LONG_PRESS_MS = 500, SLOP_PX = 10;
  function tileFromEvent(e) {
    var t = e.target;
    while (t && t !== document.body) {
      if (t.classList && t.classList.contains('tile')) return t;
      t = t.parentNode;
    }
    return null;
  }
  function hideGloss() { el('gloss-pop').hidden = true; }
  function showGlossFor(tile) {
    var w = tile.getAttribute('data-word');
    var word = null;
    S.set.words.forEach(function (x) { if (x.w === w) word = x; });
    if (!word) return;
    var pop = el('gloss-pop');
    pop.innerHTML = '';
    var b = document.createElement('b'); b.textContent = word.w + ': ';
    pop.appendChild(b);
    pop.appendChild(document.createTextNode(word.gloss));
    pop.hidden = false;
    var r = tile.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
    pop.style.top = (r.top - pop.offsetHeight - 10) + 'px';
    Snd.page();
  }
  function onPointerDown(e) {
    var tile = tileFromEvent(e);
    if (!tile || tile.disabled || !S || S.busy || S.enc.state !== 'run') return;
    Snd.tap();
    tile.classList.add('held');
    press = { tile: tile, id: e.pointerId, x: e.clientX, y: e.clientY, consumed: false, timer: null };
    if (MODE === 'words' && currentLevel() < C.HELP_THRESHOLD && !S.review) {
      press.timer = setTimeout(function () {
        if (!press) return;
        press.consumed = true; // this gesture is a peek, not an answer
        showGlossFor(press.tile);
      }, LONG_PRESS_MS);
    }
  }
  function onPointerMove(e) {
    if (!press || e.pointerId !== press.id) return;
    if (Math.abs(e.clientX - press.x) > SLOP_PX || Math.abs(e.clientY - press.y) > SLOP_PX) {
      clearTimeout(press.timer);
      press.tile.classList.remove('held');
      press = null; // finger is sliding, not choosing
    }
  }
  function onPointerUp(e) {
    if (!press || e.pointerId !== press.id) return;
    clearTimeout(press.timer);
    var p = press; press = null;
    p.tile.classList.remove('held');
    hideGloss();
    // touch-up commit: the answer happens on release, never on touch-down,
    // so one stray brush can't wipe four earned tumblers
    if (!p.consumed) answerWith(p.tile.getAttribute('data-word'), p.tile);
  }
  function onPointerCancel() {
    if (!press) return;
    clearTimeout(press.timer);
    press.tile.classList.remove('held');
    press = null;
    hideGloss();
  }

  // ---- cosmetics ----
  // A completed shelf's cosmetic is worn by tapping its button in the cabinet;
  // the choice persists and is re-applied on boot.
  function applyCosmetics() {
    var cos = LS.cosmetic;
    var cls = [];
    if (cos.backdrop) cls.push('backdrop-' + cos.backdrop);
    if (cos.skin) cls.push('skin-' + cos.skin);
    if (cos.pins) cls.push('pins-' + cos.pins);
    if (cos.dial) cls.push('dial-' + cos.dial);
    document.body.className = cls.join(' ');
    FX.set({ cosmetic: cos }); // earned skins recolour the hologram too
  }
  function toggleCosmetic(cosmetic) {
    var cos = LS.cosmetic;
    cos[cosmetic.kind] = cos[cosmetic.kind] === cosmetic.id ? null : cosmetic.id;
    LS.cosmetic = cos;
    applyCosmetics();
    renderCabinet();
  }

  // ---- curio cabinet ----
  // Collectible art with the emoji as fallback (mirrors the title logo's
  // onerror pattern); the game stays complete without any PNGs on disk.
  function collectibleIcon(item, holder) {
    var img = document.createElement('img');
    img.alt = item.name;
    img.addEventListener('error', function () { holder.textContent = item.emoji; });
    // shelf items carry .id, the crack reward carries .itemId
    img.src = 'assets/collectibles/' + (item.id || item.itemId) + '.png';
    holder.appendChild(img);
  }
  function renderCabinet() {
    var box = el('shelves');
    box.innerHTML = '';
    C.shelfState(LS.collectibles).forEach(function (shelf) {
      var div = document.createElement('div');
      div.className = 'shelf';
      var h = document.createElement('h3');
      h.textContent = shelf.name + (shelf.complete ? ' ★' : ' · ' + shelf.owned + '/' + shelf.total);
      if (shelf.complete) {
        var wearing = LS.cosmetic[shelf.cosmetic.kind] === shelf.cosmetic.id;
        var btn = document.createElement('button');
        btn.textContent = wearing ? 'Wearing it ✓' : 'Wear it';
        btn.addEventListener('click', function () { Snd.chime(); toggleCosmetic(shelf.cosmetic); });
        h.appendChild(btn);
      }
      div.appendChild(h);
      var items = document.createElement('div');
      items.className = 'items';
      shelf.items.forEach(function (it) {
        var slot = document.createElement('div');
        var have = LS.collectibles.indexOf(it.id) !== -1;
        slot.className = 'slot' + (have ? '' : ' empty');
        if (have) collectibleIcon(it, slot); else slot.textContent = '?';
        slot.title = have ? it.name : '???';
        items.appendChild(slot);
      });
      div.appendChild(items);
      box.appendChild(div);
    });
  }

  // ---- settings ----
  var CAPS = [0, 4, 8, 12, 16, 20, 24, 28];
  function refreshSettings() {
    el('set-sound-val').textContent = LS.muted ? 'Off' : 'On';
    el('set-sound-val').classList.toggle('off', LS.muted);
    el('set-year-val').textContent = 'Year ' + LS.startYear;
    el('set-cap-val').textContent = LS.capLevel ? 'Year ' + C.yearOf(LS.capLevel) : 'Off';
    el('set-cap-val').classList.toggle('off', !LS.capLevel);
    var fxv = !FX.supported() ? 'No WebGL' : LS.fxWanted ? 'On' : 'Off';
    el('set-fx-val').textContent = fxv;
    el('set-fx-val').classList.toggle('off', fxv !== 'On');
    el('set-timer-val').textContent = LS.timerOn ? Math.round(C.lockTimerFor(currentLevel()) / 1000) + 's' : 'Off';
    el('set-timer-val').classList.toggle('off', !LS.timerOn);
  }
  // in-game confirm: the same overlay system as everything else, because a
  // native confirm() dialog yanks the child out of the vault
  var confirmYes = null;
  function askConfirm(onYes) {
    confirmYes = onYes;
    Snd.page();
    show('confirm-overlay');
  }

  function wipeProgress() {
    ['coins', 'collectibles', 'cosmetic', 'review', 'reviewedat', 'mode'].forEach(function (k) {
      lsDel('wordvault.' + k);
    });
    Object.keys(MODES).forEach(function (m) {
      inMode(m, function () {
        ['difficulty', 'bestlevel', 'streak', 'slips', 'history', 'setscount', 'encounter'].forEach(function (k) { lsDel(mk(k)); });
      });
    });
    // the best-streak record survives a new game, like an arcade high score
    S = null;
    applyCosmetics();
    refreshHud();
  }

  // ---- demo / QA hash hooks ----
  function autoContinue(btnId) { setTimeout(function () { el(btnId).click(); }, 250); }
  function autoSpell() {
    setTimeout(function () {
      if (!S || S.busy || !S.spell || S.spell.phase !== 'write') return;
      var target = spellTarget(), mode = S.auto;
      if (mode === 'stall') return;
      var wrong = mode === 'wrong' || (mode === 'miss' && S.enc.correctInRun === S.enc.need - 1);
      if (mode === 'miss' && wrong) S.auto = 'right';
      S.spell.typed = wrong ? target.slice(0, -1) : target;
      renderTyped();
      checkSpelling();
    }, 350);
  }
  function autoAnswer(sentence) {
    setTimeout(function () {
      if (!S || S.busy || S.enc.state !== 'run') return;
      var mode = S.auto;
      if (mode === 'stall') return; // #timerdemo: never answer, let the clock run out
      var want = sentence.answer;
      if (mode === 'wrong' || (mode === 'miss' && S.enc.correctInRun === S.enc.need - 1)) {
        want = S.enc.tileOrder.filter(function (w) { return w !== sentence.answer; })[0];
        if (mode === 'miss') S.auto = 'right';
      }
      var tiles = el('tiles').children;
      for (var i = 0; i < tiles.length; i++) {
        if (tiles[i].getAttribute('data-word') === want) { answerWith(want, tiles[i]); return; }
      }
    }, 350);
  }
  function runSelftest() {
    var v = C.validateContent(CONTENT.data);
    var banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;padding:10px 16px;font-weight:800;color:#fff;text-align:center;background:' + (v.ok ? '#1f8a5c' : '#b73e18');
    banner.textContent = v.ok
      ? '#selftest: content OK (' + CONTENT.data.counts.sets + ' sets, ' + CONTENT.data.counts.sentences + ' sentences)'
      : '#selftest: ' + v.errors.length + ' content error(s) - ' + v.errors[0];
    document.body.appendChild(banner);
  }

  // ---- boot ----
  function setMode(m) {
    MODE = MODES[m] ? m : 'words';
    LS.lastMode = MODE;
    showInputFor(MODE);
    refreshHud();
  }
  // a mode resumes its own saved safe; otherwise it picks a fresh one
  function startGame(resume) {
    hide('title-overlay');
    showInputFor(MODE);
    if (resume) {
      var saved = LS.encounter;
      var set = saved && setById(saved.setId);
      if (set) {
        beginEncounter(set, { review: saved.review, entry: saved.reviewEntry, resume: saved.enc });
        return;
      }
    }
    pickNext();
  }
  // the title menu shows each game's own year so a child sees all three ladders
  function refreshTitle() {
    Object.keys(MODES).forEach(function (m) {
      inMode(m, function () {
        var base = { words: 'Pick the word that fits the sentence', spell: 'Look, cover, write, check',
                     dict: 'Meanings, ABC order, guide words' }[m];
        var lvl = currentLevel();
        var started = !!LS.encounter || LS.setsCount > 0;
        el('mode-sub-' + m).textContent = started ? 'Year ' + C.yearOf(lvl) + ' ' + yearProgress(lvl) + ' · ' + base : base;
      });
    });
    var last = LS.lastMode;
    var saved = inMode(last, function () { return LS.encounter; });
    var sset = saved && setById(saved.setId);
    el('continue-btn').style.display = sset ? '' : 'none';
    if (sset) {
      el('continue-sub').textContent = MODES[last].icon + ' ' + sset.theme +
        (saved.enc.misses ? ' · run ' + (saved.enc.runIndex + 1) : '');
    }
  }
  // 🏠: park the current safe (persisted at its run boundary) and go to the menu
  function goHome() {
    // only an in-flight grading animation blocks; a card on screen never does
    if (S && S.busy && !document.querySelector('.overlay.show')) return;
    timerStop();
    clearTimeout(spellTimer);
    if (S && S.enc) persistEncounter();
    ['ready-overlay', 'settings-overlay', 'cabinet-overlay', 'howto-overlay'].forEach(hide);
    refreshTitle();
    show('title-overlay');
  }

  function init() {
    preloadClips();
    if (LS.fxWanted && FX.supported()) FX.mount(el('fx'));
    applyCosmetics(); // after mount so the hologram picks up worn cosmetics
    refreshHud();
    refreshSettings();

    buildKeys();
    setMode(LS.lastMode);
    refreshTitle();

    el('continue-btn').addEventListener('click', function () { Snd.tap(); setMode(LS.lastMode); startGame(true); });
    Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (b) {
      b.addEventListener('click', function () {
        Snd.tap();
        setMode(b.getAttribute('data-mode'));
        startGame(!!LS.encounter);
      });
    });
    el('home-btn').addEventListener('click', function () { Snd.tap(); goHome(); });
    el('ready-home').addEventListener('click', function () { Snd.tap(); goHome(); });
    el('speller').addEventListener('click', function (e) {
      var k = e.target.closest ? e.target.closest('button') : null;
      if (!k) return;
      if (k.id === 'spell-cover') coverWord();
      else if (k.id === 'spell-back') backKey();
      else if (k.id === 'spell-check') checkSpelling();
      else if (k.id === 'spell-hear' || k.id === 'spell-hear-look') speak(spellTarget());
      else if (k.getAttribute('data-ch')) typeKey(k.getAttribute('data-ch'));
    });
    document.addEventListener('keydown', onSpellKeydown);
    // voices load asynchronously on some browsers; re-check the Hear buttons
    if (window.speechSynthesis && 'onvoiceschanged' in speechSynthesis) {
      speechSynthesis.onvoiceschanged = function () {
        var can = !!localVoice();
        if (S && S.spell && S.spell.phase === 'look') el('spell-hear-look').hidden = !can;
        if (S && S.spell && S.spell.phase === 'write') el('spell-hear').hidden = !can;
      };
    }
    el('confirm-yes').addEventListener('click', function () {
      Snd.tap();
      hide('confirm-overlay');
      var fn = confirmYes; confirmYes = null;
      if (fn) fn();
    });
    el('confirm-no').addEventListener('click', function () {
      Snd.tap();
      confirmYes = null;
      hide('confirm-overlay');
    });
    el('howto-btn').addEventListener('click', function () { Snd.page(); show('howto-overlay'); });
    el('howto-close').addEventListener('click', function () { hide('howto-overlay'); });
    el('cabinet-menu-btn').addEventListener('click', function () { Snd.page(); renderCabinet(); show('cabinet-overlay'); });
    el('cabinet-btn').addEventListener('click', function () { Snd.page(); renderCabinet(); show('cabinet-overlay'); });
    el('cabinet-close').addEventListener('click', function () { hide('cabinet-overlay'); });
    el('settings-menu-btn').addEventListener('click', function () { Snd.page(); refreshSettings(); show('settings-overlay'); });
    el('settings-btn').addEventListener('click', function () { Snd.page(); refreshSettings(); show('settings-overlay'); });
    el('settings-close').addEventListener('click', function () { hide('settings-overlay'); });
    el('set-howto').addEventListener('click', function () { hide('settings-overlay'); show('howto-overlay'); });
    el('set-sound').addEventListener('click', function () { LS.muted = !LS.muted; refreshHud(); refreshSettings(); });
    el('mute-toggle').addEventListener('click', function () { LS.muted = !LS.muted; refreshHud(); });
    el('set-cap').addEventListener('click', function () {
      var idx = CAPS.indexOf(LS.capLevel);
      LS.capLevel = CAPS[(idx + 1) % CAPS.length];
      refreshHud();
      refreshSettings();
    });
    el('set-year').addEventListener('click', function () {
      // cycling the starting year MOVES the game there, both directions: it is
      // the grown-up placing the child, streak and all
      LS.startYear = (LS.startYear % 7) + 1;
      Object.keys(MODES).forEach(function (m) {
        inMode(m, function () {
          LS.difficulty = C.yearStart(LS.startYear);
          LS.bestLevel = LS.difficulty; // celebrations count from the placement
          LS.streak = 0;
          LS.slips = 0;
        });
      });
      refreshHud();
      refreshSettings();
    });
    el('set-timer').addEventListener('click', function () {
      LS.timerOn = !LS.timerOn;
      if (!LS.timerOn) timerStop();
      else if (S && S.enc && S.enc.state === 'run' && !S.busy) timerStart();
      refreshSettings();
    });
    el('set-fx').addEventListener('click', function () {
      if (!FX.supported()) { refreshSettings(); return; }
      LS.fxWanted = !LS.fxWanted;
      if (LS.fxWanted) {
        FX.mount(el('fx'));
        FX.set({ cosmetic: LS.cosmetic });
        if (S && S.enc) renderPins(); // sync a mid-encounter lock state
      } else {
        FX.unmount();
      }
      refreshSettings();
    });
    el('set-newgame').addEventListener('click', function () {
      askConfirm(function () {
        wipeProgress();
        hide('settings-overlay');
        refreshTitle();
        show('title-overlay');
        el('year-stat').hidden = true;
      });
    });

    el('ready-btn').addEventListener('click', function () { Snd.tap(); startRun(); });
    el('miss-next').addEventListener('click', function () {
      Snd.tap();
      if (S.reviewDone) { S.reviewDone = false; hide('miss-overlay'); pickNext(); return; }
      missNext();
    });
    el('exhaust-next').addEventListener('click', function () { Snd.tap(); hide('exhaust-overlay'); pickNext(); });
    el('crack-next').addEventListener('click', function () { Snd.tap(); crackNext(); });
    el('levelup-btn').addEventListener('click', function () { Snd.tap(); hide('levelup-overlay'); pickNext(); });

    var tilesBox = el('tiles');
    tilesBox.addEventListener('pointerdown', onPointerDown);
    tilesBox.addEventListener('pointermove', onPointerMove);
    tilesBox.addEventListener('pointerup', onPointerUp);
    tilesBox.addEventListener('pointercancel', onPointerCancel);
    tilesBox.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('pointerdown', unlockAudio, { once: true });

    // dev hooks (documented in README): #play skips the title; #demo answers
    // correctly on a timer; #wrongdemo always misses; #missdemo misses once on
    // pin 3 then cracks; #timerdemo stalls until the lock timer expires;
    // #dialdemo plays wearing the Timekeepers clock dial; a demo hook may pin
    // its first safe with =<set-id> (#missdemo=B-time-deixis-01);
    // #settings opens Settings; #cabinet opens the cabinet; #selftest banners
    // the content check
    var hash = (location.hash || '').replace('#', '');
    var eq = hash.indexOf('=');
    var base = eq === -1 ? hash : hash.slice(0, eq);
    var arg = eq === -1 ? null : decodeURIComponent(hash.slice(eq + 1));
    if (base === 'selftest') runSelftest();
    if (base === 'cabinet') { renderCabinet(); show('cabinet-overlay'); }
    if (base === 'settings') { refreshSettings(); show('settings-overlay'); }
    if (base === 'dialdemo') { LS.cosmetic = { dial: 'clock' }; applyCosmetics(); }
    if (base === 'play' || base === 'demo' || base === 'wrongdemo' || base === 'missdemo' ||
        base === 'timerdemo' || base === 'dialdemo') {
      // a trailing ! on the set id holds teaching cards open (screenshot rigs)
      var hold = !!arg && arg.charAt(arg.length - 1) === '!';
      // #demo=spell / #wrongdemo=dict pick the game instead of a set
      var forceId = hold ? arg.slice(0, -1) : arg;
      if (forceId && MODES[forceId]) { setMode(forceId); forceId = null; }
      S = { auto: base === 'demo' || base === 'dialdemo' ? 'right' : base === 'wrongdemo' ? 'wrong'
              : base === 'missdemo' ? 'miss' : base === 'timerdemo' ? 'stall' : null,
            forceSetId: forceId, holdCards: hold };
      startGame(!!LS.encounter);
    }
  }
  if (!Element.prototype.closest) Element.prototype.closest = function (sel) {
    var n = this; while (n && n.nodeType === 1) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; } return null;
  };

  document.addEventListener('DOMContentLoaded', init);
})();
