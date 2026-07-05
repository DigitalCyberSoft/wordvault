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
  var LS = {
    get coins() { var v = parseInt(lsGet('wordvault.coins'), 10); return isFinite(v) && v >= 0 ? v : 0; },
    set coins(v) { lsSet('wordvault.coins', v); },
    get difficulty() { var v = parseFloat(lsGet('wordvault.difficulty')); return (isFinite(v) && v >= 1) ? v : 1; },
    set difficulty(v) { lsSet('wordvault.difficulty', v); },
    // Highest level ever reached. The Level Up screen fires only on a new
    // record, never on re-climbing a level after a drop. Defaults to the
    // current level so a returning player isn't congratulated for standing
    // where they already are.
    get bestLevel() { var v = parseInt(lsGet('wordvault.bestlevel'), 10); return (isFinite(v) && v >= 1) ? v : C.levelOf(this.difficulty); },
    set bestLevel(v) { lsSet('wordvault.bestlevel', v); },
    // Live clean-crack streak (spans sets, so it persists) and its record.
    get streak() { return +(lsGet('wordvault.streak') || 0); },
    set streak(v) { lsSet('wordvault.streak', v); },
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
    get history() { return jsonGet('wordvault.history', {}); },
    set history(v) { lsSet('wordvault.history', JSON.stringify(v)); },
    get setsCount() { return +(lsGet('wordvault.setscount') || 0); },
    set setsCount(v) { lsSet('wordvault.setscount', v); },
    // setsCount value at the last review lockbox, so one due-point offers at
    // most one review (otherwise a non-empty queue would loop reviews forever).
    get reviewedAt() { var v = parseInt(lsGet('wordvault.reviewedat'), 10); return isFinite(v) ? v : -1; },
    set reviewedAt(v) { lsSet('wordvault.reviewedat', v); },
    get encounter() { return jsonGet('wordvault.encounter', null); },
    set encounter(v) { if (v) lsSet('wordvault.encounter', JSON.stringify(v)); else lsDel('wordvault.encounter'); },
    get capLevel() { var v = parseInt(lsGet('wordvault.cap'), 10); return (isFinite(v) && v >= 1) ? v : 0; },
    set capLevel(v) { lsSet('wordvault.cap', v); }
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

  function currentLevel() { return C.levelOf(LS.difficulty); }
  function refreshHud() {
    el('coins').textContent = LS.coins;
    el('level-pill').textContent = 'Level ' + currentLevel();
    el('beststreak').textContent = LS.bestStreak;
    el('mute-toggle').textContent = LS.muted ? '🔇 Sound off' : '🔊 Sound on';
  }
  function rankFor(level) {
    return level >= 17 ? 'Master of the Vault'
      : level >= 13 ? 'Safecracker'
      : level >= 9 ? 'Combination Wiz'
      : level >= 5 ? 'Tumbler Turner'
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
  function pickNext() {
    var queue = LS.review;
    if (C.reviewDue(LS.setsCount, queue) && LS.reviewedAt !== LS.setsCount) {
      var pick = C.pickReview(queue);
      var set = CONTENT.byId(pick.entry.setId);
      if (set) { beginEncounter(set, { review: true, entry: pick.entry }); return; }
    }
    var history = LS.history;
    var setId = C.pickSet(CONTENT.data, {
      level: currentLevel(), history: history, lastSetId: S && S.set ? S.set.id : null
    }, C.makeRng(Date.now() >>> 0));
    beginEncounter(CONTENT.byId(setId), {});
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
      auto: S ? S.auto : null
    };
    persistEncounter();
    showReady();
  }

  // ---- Get Ready ----
  function showReady() {
    var enc = S.enc, set = S.set;
    el('ready-title').textContent = S.review
      ? '🔐 Review lockbox: ' + set.theme
      : 'The job: ' + set.theme;
    var runsLeft = enc.runsAllowed - enc.misses;
    el('ready-runs').textContent = S.review
      ? '1 run · 3 pins to open · one miss and it stays shut'
      : (enc.misses ? 'Run ' + (enc.runIndex + 1) + ' of ' + enc.runsAllowed + ' · fresh sentences this run'
                    : enc.runsAllowed + ' runs · ' + enc.need + ' in a row cracks it');
    var box = el('ready-glosses');
    box.innerHTML = '';
    // Gloss cards in the authored order: the semantic gradient, not the
    // shuffled play order, so the child builds the scale before playing.
    C.gradientOrder(set).forEach(function (w) {
      var word = null;
      for (var i = 0; i < set.words.length; i++) if (set.words[i].w === w) word = set.words[i];
      var card = document.createElement('div');
      card.className = 'gloss-card';
      var b = document.createElement('b'); b.textContent = word.w;
      var span = document.createElement('span'); span.textContent = word.gloss;
      card.appendChild(b); card.appendChild(span);
      box.appendChild(card);
    });
    renderPins();
    renderDoor(false);
    el('slip-text').textContent = '';
    renderTilesBlank();
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
    renderTiles(s);
    renderPins();
    S.busy = false;
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
  }
  function springPins() {
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
  }
  // juice: the dial accumulates a quarter-turn per seated pin (whole turns on
  // the crack), and the mech panel takes a 2px thunk on every seat. The turn
  // counter lives outside S so the dial never rewinds across encounters.
  var dialTurns = 0;
  function dialTurn(quarters) {
    dialTurns += quarters;
    el('dial').style.setProperty('--turns', dialTurns);
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
    var sentence = currentSentence();
    Snd.whoosh();
    flyGhost(tileEl, el('blank'), function (ghost) {
      var res = C.answer(S.enc, S.set, sentence, word);
      S.answered += 1;
      if (res.correct) {
        if (ghost) { ghost.parentNode.removeChild(ghost); tileEl.classList.remove('gone'); }
        var blank = el('blank');
        blank.textContent = sentence.surface[word];
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
      } else {
        Snd.drop();
        el('stage').classList.add('dimmed');
        dropGhostBack(ghost, tileEl, function () {
          Snd.relock();
          springPins();
          afterMs(480, function () {
            el('stage').classList.remove('dimmed');
            if (res.state === 'miss') showMissCard(sentence, word, true);
            else if (res.state === 'exhausted') {
              // third lamp is lit: ring the klaxon, then the card
              el('vault').classList.add('alarm');
              Snd.alarm();
              afterMs(750, function () { showMissCard(sentence, word, false); });
            }
            else onReviewFailed(sentence, word);
          });
        });
      }
    });
  }

  // ---- miss card (contrastive feedback) ----
  function fillMissCard(sentence, picked) {
    var con = C.contrastFor(S.set, sentence, picked);
    el('miss-cue').innerHTML = '';
    var read = document.createElement('span');
    read.appendChild(document.createTextNode('The slip wanted: “'));
    var strong = document.createElement('b');
    strong.textContent = con.filled;
    read.appendChild(strong);
    read.appendChild(document.createTextNode('” — the cue was “' + con.cue + '”.'));
    el('miss-cue').appendChild(read);
    el('miss-right-word').textContent = con.right.surface;
    el('miss-right-gloss').textContent = con.right.gloss;
    el('miss-picked-word').textContent = con.picked.surface;
    el('miss-picked-gloss').textContent = con.picked.gloss;
    el('miss-line').textContent = con.line;
  }
  function showMissCard(sentence, picked, runsRemain) {
    fillMissCard(sentence, picked);
    var left = S.enc.runsAllowed - S.enc.misses;
    el('miss-runs-left').textContent = runsRemain
      ? (left === 1 ? 'Last run. Read the cue twice.' : left + ' runs left.')
      : 'That was the last run for this safe.';
    el('miss-next').textContent = runsRemain ? 'Try the next run ▶' : 'See the words ▶';
    S.missWasFinal = !runsRemain;
    persistEncounter();
    // history counts every miss so the review queue can prioritise
    Snd.page();
    show('miss-overlay');
    if (S.auto) autoContinue('miss-next');
  }
  function missNext() {
    hide('miss-overlay');
    if (S.missWasFinal) { onExhausted(); return; }
    showReady(); // the relock is a beat: re-show the gloss cards, then run again
  }

  // ---- outcomes ----
  function recordHistory(outcome) {
    var h = LS.history;
    var entry = h[S.set.id] || { plays: 0, cracks: 0, exhausts: 0 };
    entry.plays += 1;
    if (outcome === 'crack') entry.cracks += 1;
    if (outcome === 'exhausted') entry.exhausts += 1;
    entry.at = Date.now();
    h[S.set.id] = entry;
    LS.history = h;
  }

  function onCracked() {
    var clean = C.isClean(S.enc);
    // the record counts consecutive clean cracks, so it is taken from the
    // incremented value BEFORE adjustDifficulty resets the streak on a climb
    if (clean) LS.bestStreak = Math.max(LS.bestStreak, LS.streak + 1);
    var adj = C.adjustDifficulty(LS.difficulty, clean ? 'clean-crack' : 'crack', LS.streak, LS.capLevel);
    LS.difficulty = adj.difficulty;
    LS.streak = adj.streak;
    var coins = C.coinsFor('crack', currentLevel(), S.enc.need) +
      C.speedBonus(Date.now() - S.startedAt, S.answered);
    LS.coins = LS.coins + coins;
    var owned = LS.collectibles;
    var reward = C.nextCollectible(owned);
    if (reward) { owned.push(reward.itemId); LS.collectibles = owned; }
    recordHistory('crack');
    LS.setsCount = LS.setsCount + 1;
    LS.review = C.pushReview(LS.review, { setId: S.set.id, exhausted: false, at: Date.now() });
    var newLevel = currentLevel();
    if (newLevel > LS.bestLevel) { S.queuedLevelUp = newLevel; LS.bestLevel = newLevel; }
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
      el('crack-coins').textContent = '+' + coins + ' coins' + (clean ? ' · clean crack!' : '');
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
      el('levelup-num').textContent = 'Level ' + S.queuedLevelUp;
      el('levelup-rank').textContent = rankFor(S.queuedLevelUp);
      S.queuedLevelUp = 0;
      Snd.fanfare();
      show('levelup-overlay');
      if (S.auto) autoContinue('levelup-btn');
      return; // levelup button continues to pickNext
    }
    pickNext();
  }

  function onExhausted() {
    var adj = C.adjustDifficulty(LS.difficulty, 'exhausted', LS.streak, LS.capLevel);
    LS.difficulty = adj.difficulty;
    LS.streak = 0;
    recordHistory('exhausted');
    LS.setsCount = LS.setsCount + 1;
    LS.review = C.pushReview(LS.review, { setId: S.set.id, exhausted: true, at: Date.now() });
    LS.encounter = null;
    refreshHud();
    var box = el('exhaust-words');
    box.innerHTML = '';
    C.missedWords(S.enc, S.set).forEach(function (w) {
      var card = document.createElement('div');
      card.className = 'gloss-card';
      var b = document.createElement('b'); b.textContent = w.w;
      var span = document.createElement('span'); span.textContent = w.gloss;
      card.appendChild(b); card.appendChild(span);
      box.appendChild(card);
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
    if (S.auto) autoContinue('miss-next');
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
    if (currentLevel() < C.HELP_THRESHOLD && !S.review) {
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
    document.body.className = cls.join(' ');
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
  var CAPS = [0, 4, 8, 12, 16, 20];
  function refreshSettings() {
    el('set-sound-val').textContent = LS.muted ? 'Off' : 'On';
    el('set-sound-val').classList.toggle('off', LS.muted);
    el('set-cap-val').textContent = LS.capLevel ? 'Level ' + LS.capLevel : 'Off';
    el('set-cap-val').classList.toggle('off', !LS.capLevel);
  }
  function wipeProgress() {
    ['coins', 'difficulty', 'bestlevel', 'streak', 'collectibles', 'cosmetic',
      'review', 'history', 'setscount', 'reviewedat', 'encounter'].forEach(function (k) {
      lsDel('wordvault.' + k);
    });
    // the best-streak record survives a new game, like an arcade high score
    S = null;
    applyCosmetics();
    refreshHud();
  }

  // ---- demo / QA hash hooks ----
  function autoContinue(btnId) { setTimeout(function () { el(btnId).click(); }, 250); }
  function autoAnswer(sentence) {
    setTimeout(function () {
      if (!S || S.busy || S.enc.state !== 'run') return;
      var mode = S.auto;
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
  function startGame(resume) {
    hide('title-overlay');
    if (resume) {
      var saved = LS.encounter;
      var set = saved && CONTENT.byId(saved.setId);
      if (set) {
        beginEncounter(set, { review: saved.review, entry: saved.reviewEntry, resume: saved.enc });
        return;
      }
    }
    pickNext();
  }

  function init() {
    preloadClips();
    applyCosmetics();
    refreshHud();
    refreshSettings();

    var saved = LS.encounter;
    if (saved && CONTENT.byId(saved.setId)) {
      el('continue-btn').style.display = '';
      el('continue-sub').textContent = CONTENT.byId(saved.setId).theme +
        (saved.enc.misses ? ' · run ' + (saved.enc.runIndex + 1) : '');
    }

    el('continue-btn').addEventListener('click', function () { Snd.tap(); startGame(true); });
    el('newgame-btn').addEventListener('click', function () {
      Snd.tap();
      if (LS.encounter || LS.setsCount > 0) {
        if (!window.confirm('Start over? This wipes coins, level and the cabinet for a new player.')) return;
        wipeProgress();
      }
      startGame(false);
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
      refreshSettings();
    });
    el('set-newgame').addEventListener('click', function () {
      if (!window.confirm('Start over? This wipes coins, level and the cabinet for a new player.')) return;
      wipeProgress();
      hide('settings-overlay');
      show('title-overlay');
      el('continue-btn').style.display = 'none';
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
    // pin 3 then cracks; #cabinet opens the cabinet; #selftest banners the
    // content check
    var hash = (location.hash || '').replace('#', '');
    if (hash === 'selftest') runSelftest();
    if (hash === 'cabinet') { renderCabinet(); show('cabinet-overlay'); }
    if (hash === 'play' || hash === 'demo' || hash === 'wrongdemo' || hash === 'missdemo') {
      S = { auto: hash === 'demo' ? 'right' : hash === 'wrongdemo' ? 'wrong' : hash === 'missdemo' ? 'miss' : null };
      startGame(!!LS.encounter);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
