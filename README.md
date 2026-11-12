# 🔐 Word Vault

A vocabulary game disguised as safe-cracking, in the same family as
[Pizza Palace](https://github.com/DigitalCyberSoft/pizzashop). Five confusable
words are engraved on brass tiles; a paper slip shows a sentence with a hole in
it; the child taps the one word that truly fits. Every correct word seats a
tumbler pin - seat them all and the vault swings open. The ladder is seven
Australian school years (Years 1-7, leaning towards gifted readers), and within
every year the locks grow from 2 pins to the full 5: **four clean cracks in a
row pass the year**.
One wrong word - or letting the 15-second lock timer run out - springs every
pin back out: that run is over, and a safe grants three runs before it keeps
its secret and the game moves on (the year's run of pins starts again).

The difficulty lives in the language: word rarity rises, the cue drifts from
explicit ("cried very loudly") to inferential, and the words in a set close in
on each other (walk-family first, scalding-vs-boiling later).

## How it plays

- **A set** is five confusable words (near-synonyms or same-category) plus a
  pool of cue-locked sentences. Sentences never repeat within an encounter, so
  run 2 can't be passed on memory of run 1's pairings.
- **A miss teaches.** The card shows the word that fits and the word you
  picked side by side - both with their dictionary meanings - plus the cue and
  one line on the difference. Failure is where the vocabulary lands. Ladder
  sets (the time words: yesterday→tomorrow, never→always, morning→night) add
  a **when-line** under the cards - five ticks in order, the fitting word lit
  gold, the picked word crossed out - so the child sees *where on the scale*
  the two words sit, not just that they differ.
- **Review lockboxes.** Cracked and failed safes come back later as smaller
  lockboxes with fresh sentences: three in a row to open, one run only.
  Retention practice, never a level change.
- **Years are passed in a row.** Each clean crack (no misses) is one step and
  one more pin; four clean cracks in a row pass the school year. A miss breaks
  the run (back to the year's 2-pin start), and only a second exhausted safe in
  a row steps down a year. The HUD shows `Year 2 ●●○○`, and every crack card
  says how many clean cracks are left. Speed never moves the level:
  `adjustDifficulty` takes no time input. **Year passed!** fires only on a
  first-ever arrival in a year.
- **The lock timer.** 15 seconds per sentence (`Core.LOCK_TIMER_MS`), 20 in
  Years 1-2 (`Core.lockTimerFor`, `EARLY_TIMER_MS`); expiry
  is a miss with its own teaching card. Settings offers a grown-up off-switch
  for slower readers, and a **Starting year** knob (Year 1-7) places a new
  player at their school year.
- **The Curio Cabinet.** Every crack pays a few coins and one collectible;
  five related treasures complete a shelf.

## Learning modes

The title menu offers three games on the same vault. Each keeps its own
school year (mode-prefixed `wordvault.<mode>.*` keys), clean-crack ladder and
saved safe; coins, the cabinet and settings are shared, and 🏠 switches games.

- **🔓 Word Vault** - the sentence game above (keys keep their original names).
- **✏️ Spelling Vault** - dictation, like a classroom spelling test. The
  Get Ready card is the week's list (words and meanings); then each word is
  SPOKEN from a clip recorded at build time (`assets/voice/<slug>.mp3`, an
  Australian-teacher voice, see `tools/generate-voice.py`) while its judged
  sentence sits on the slip for meaning, and the child types it on an
  on-screen keyboard (physical keys work too); 🔊 Again replays it. The miss
  card shows the right spelling and the attempt letter by letter, with the
  differences in gold and a tip for common slips (doubled letters, silent e,
  letter order, apostrophes) from `Core.spellDiff`. No lock timer: spelling is
  about care. With sound switched off, or if a clip fails to load, the word
  falls back to Look then Cover (`Core.lookMsFor`). The clips ship as files,
  so the game still makes no network connection at play time.
- **📖 Dictionary Vault** - matching words to their definitions, both ways,
  among one confusable set's five SIMILAR definitions: "___ means 'cry weakly
  or softly'" (tiles are the five words) and "'whimper' means ___" (tiles are
  the five definitions, shown as rows). The Get Ready card is the dictionary
  page in ABC order; a miss names both words with their definitions and the
  set's contrast line. The lock timer gets 10 s extra for reading definitions.

- **🌱 Word Forms Vault** - different versions of the same word: terrify /
  terrified / terrifying / terror. Each question reuses one of the word's
  judged sentences ("Aisha was ___, too afraid to speak.") with three to five
  versions on the tiles (never two tenses that both fit: swept and sweeps
  are not offered together, since the game teaches word class, not tense); the Get Ready card shows each word's family, and a
  miss shows the right and picked versions with a one-line note each
  ("adjective: feeling very great fear" / "adjective: causing very great
  fear"). Families are drafted by `tools/draft-families.py` (gpt-5.5; every
  form must be a real word by wordfreq, share the headword's root and keep its
  meaning) into `forms/families.json`; `tools/judge-forms.py` builds the
  questions (`forms/items.json`) and judges each with the same three-model
  ensemble (`reference/forms-verdicts.json`). Grammar decides here, but
  meaning still can ("Aisha was terrifying" is grammatical and wrong), so a
  question ships only when every judge accepts the intended version and at
  most one also accepts another; `tools/bake-content.js` drops hard, stale and
  unjudged questions.

The spelling and dictionary modes build VIRTUAL sets from the gated corpus (`Core.spellingSetFrom`,
`Core.buildDictionarySet`, ids `S:<set>` and `D:<set>`), so they need no new
content gates: definitions are unique within a set (G3/G4), and a word whose
definition contains its own family ("sip: drink in sips") is never the answer
(`Core.glossGivesAway`). `tools/test-content.js` checks five distinct tiles on
every dictionary question, and that every spelling word has a clip that a
speech-to-text model heard back as that word (`reference/voice-check.json`).
Bank C usage sets stay out of the Dictionary Vault (their cards are usage notes).

## No build step, no server, no network

Plain HTML, CSS and classic `<script>` JavaScript. Open `game.html` straight
from `file://` or serve it from GitHub Pages. The game makes **no network
connection at all** while playing: the font is self-hosted, the corpus ships
baked into `game-content.js`, and progress lives in `localStorage`
(`wordvault.*` keys) on this device only.

## Project structure

| Path | What it is |
|---|---|
| `game.html` | The game shell: HUD, stage (slip / vault / tiles), overlays |
| `game-core.js` | Pure logic, zero DOM: runs, draws, grading, adaptivity, review queue, collectibles (`Core`) |
| `game-ui.js` | Rendering, input (tap answers, long-press peeks), audio, persistence |
| `game-fx.js` | The holo vault: a WebGL shader lock (energy pins, ring dial, plasma core, iris door). Auto-detects; the SVG vault below it is the full fallback, and Settings → Holo vault turns it off (`FX`) |
| `forms/` | Word Forms Vault source: drafted families and the built questions |
| `assets/voice/` | One recorded clip per Spelling Vault word (generated, `tools/generate-voice.py`) |
| `game-content.js` | **Baked** corpus - generated by `tools/bake-content.js`, never hand-edited (`Content`) |
| `styles.css` | Tokens, vault, pins, tiles, motion (pin seat ≤250ms, relock ≤400ms, door ~800ms) |
| `sets/{A,B,C}/*.json` | The authored sets: source of truth for all content |
| `reference/` | Generated: uniqueness verdicts, audit stamps, review queue, content report |
| `tools/` | The content pipeline and test suites (below) |

## The content pipeline

Generation is cheap; validation is the job. A set only bakes after every gate
passes, and the bake tool physically refuses otherwise:

1. `tools/audit-glosses.py` - gates G1-G8: pinned WordNet senses, verbatim
   glosses, no synset collisions, no sibling words inside a gloss, no defining
   word rarer than both the headword and the audience floor. Writes a
   freshness stamp the later gates verify.
2. `tools/judge-uniqueness.py` - gate G9, the critical one: every sentence is
   judged by a cross-vendor ensemble (gpt-5.5, gpt-4.1, claude-opus-4-8) that
   labels all five candidates and checks the intended answer against its
   pinned sense. A sentence two words fit never ships. Verdicts are keyed to a
   hash of the sentence, so editing one re-judges exactly that sentence.
3. `tools/grade-words.py` - attaches an Australian school year level (1-7)
   to every word in its pinned sense, by gpt-5.5 + claude-opus-4-8 consensus;
   splits of 2+ years are adjudicated by hand in
   `reference/grade-overrides.json`.
4. `tools/validate-sets.js` - gates M1-M18: schema, one blank, full surface
   tables, cue mix (2 explicit / 2 contextual / 2 inferential + 2 reserve per
   word), all 20 directed contrast lines, distinct tile surfaces, no gloss
   quoting, provenance, a grade on every word, stamp/verdict freshness.
5. `tools/bake-content.js` - runs gate 4, then compiles `sets/` into
   `game-content.js` and writes `reference/CONTENT-REPORT.md`.
6. `tools/test-content.js` - re-asserts over the baked artifact, including a
   scripted full playthrough of every set.

Set authoring needs `python3` with `nltk` (WordNet corpus) and `wordfreq`,
plus API keys in `.env` (gitignored): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.
The shipped game needs none of this.

## Tests

```sh
node tools/test-core.js      # engine invariants (rotation, adaptivity, queues)
node tools/validate-sets.js  # content gates over sets/
node tools/test-content.js   # assertions over the baked game-content.js
```

All three exit non-zero on any failure. In-browser: open `game.html#selftest`
for a pass/fail banner over the shipped content.

## Dev hooks

| Hash | Effect |
|---|---|
| `#play` | Skip the title menu |
| `#demo` | Auto-answer correctly on a timer (watch a crack) |
| `#wrongdemo` | Auto-answer wrongly (watch the three-run exhaustion flow) |
| `#missdemo` | Miss once on the final pin, then crack on run 2 |
| `#timerdemo` | Never answer: watch the lock timer expire and the timeout card |
| `#dialdemo` | Auto-crack wearing the Timekeepers clock-face dial |
| `#missdemo=B-time-deixis-01` | Any demo hook takes `=<set-id>` to pin its first safe |
| `#settings` | Open Settings |
| `#cabinet` | Open the Curio Cabinet |
| `#selftest` | Run the content check in-page |
| `#demo=spell`, `#missdemo=dict` | A demo hook given a mode name plays that game instead of pinning a set |

## Privacy

No accounts, no sign-in, no ads, no chat, no purchases, no analytics, no
network at play time. Progress is saved only in this browser on this device
and is never sent anywhere. One toggle wipes it for a new player.
