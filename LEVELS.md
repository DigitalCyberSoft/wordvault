# Word Vault: level design plan

The teaching target is **precision word choice among confusables**: given five
words that live in the same semantic neighbourhood, read a sentence's cue and
pick the one that truly fits. The level is adaptive (see the runtime rules at
the bottom); this document is the curriculum the content is banded against.

## The closed-set invariant

One blank, five tiles, and all five tiles are **grammatical** in the frame
(per-sentence surface forms) - meaning is the only discriminator. Every shipped
sentence is machine-and-human verified to admit exactly one member (the
uniqueness ensemble, gate G9): a sentence a careful reader could defend two
answers for is a shipping bug, because it punishes a correct answer.

## The levers

| # | Lever | Easy → hard |
|---|---|---|
| 1 | Word rarity | zipf_min ≥ 4.2 → below 2.5 (tier-2 words); every word also carries an Australian school year `grade` 1-7 (tools/grade-words.py) as the human-readable rarity check |
| 2 | Set tightness | distinct categories (hiss / moo) → adjacent rungs of one scale (gleaming / twinkling) |
| 3 | Cue mix *served* | explicit-heavy → inferential-heavy (authoring is uniform 2/2/2; the runtime shifts what it draws - a future knob, v1 serves uniformly) |
| 4 | Bank mix | A+B only → bank C (their/there, borrow/lend) from year 3 |
| 5 | Sentence length | gated by the year a set serves (M11): Year 1 at most 12 words (review above 10), Year 2 at most 14 (review above 12), Year 3+ at most 18 |
| 6 | Review pressure | lockboxes interleave after every 4th set at all levels |

Fixed non-levers: 3 runs per safe, 5 tiles. The lock timer (below) is a
failure condition, not a difficulty input: speed never moves the level.

## The year ladder

Seven Australian school years of four steps each (`MAX_LEVEL = 28`, integer
levels). WITHIN every year the crack requirement climbs - 2 pins at the year's
first step, then 3, 4, and the full 5 as its exit exam (`crackNeedFor`; review
lockboxes stay at 3) - and **each step is one clean crack**. So a child passes
a year with **four clean cracks in a row**: the pin count is also the visible
in-a-row progress (the HUD shows `Year 2 ●●○○`). Any miss breaks the run.

Sets are pitched with a **gifted lean** (`setYearOf`): a set serves the year
where at most ONE of its words is a stretch, and that stretch is at most one
year ahead - `max(second-hardest grade, hardest grade - 1)`. Four known words
plus one new one is the learning sweet spot; the old "hardest word" pitch
parked shiny/sparkly sets in Year 6 because of a single word. Bank C pitches
no lower than year 3. Selection borrows from neighbouring years only while a
year offers fewer than `MIN_POOL` (4) sets.

| Years | Levels | Feel | Banks | Example sets |
|---|---|---|---|---|
| 1-2 | 1-8 | Everyday similarity families, manner splits, short frames | A, B | ways to move things, ways to clean, making marks, eat |
| 3-4 | 9-16 | Rarer members, one-shade gaps, usage traps begin | A, B, C | little movements, ways to cook, cry, their/there, borrow/lend |
| 5-6 | 17-24 | Tier-2 vocabulary, inferential cues carry more | A, B, C | climate, tricks, secrecy, skill |
| 7 | 25-28 | Literary-register abstractions, cue buried or fully inferential | A, B, C | statements, tempo, desire |

## The time ladders

Five sets teach time vocabulary as ordered scales, threaded through the early
years: **deixis** (yesterday · today · now · tonight · tomorrow, Y1),
**times of day** (morning → night, Y2), **frequency** (never → always, Y3),
**nearness** (immediately → someday, Y4) and **order** (earlier → finally, Y4).
Their `words` array order IS the ladder, and a `scale` field labels its ends;
miss and timeout cards draw a **when-line** from it (five ticks, fitting word
lit, picked word crossed out) so the child learns the geometry of the scale,
not just pairwise contrasts.

Two authoring laws specific to these sets, learned at the gates:

- **Tense prunes, never picks.** Deictic words interact with tense, but every
  frame keeps at least two grammatically live candidates; a scene fact (still
  wet paint, one more sleep, a whistling kettle) makes the final choice.
  Grammar alone must never grade - that is the closed-set invariant.
- **Closed relational systems need authored glosses.** WordNet defines time
  words in terms of each other (yesterday's gloss contains "today"; sometimes'
  contains "always") - gate G4 rightly rejects that on a tile card. Such words
  pin their synset for sense anchoring and carry an authored dictionary-register
  gloss instead (`gloss_source: "authored"`, sanctioned in FORMAT.md).

## The lock timer

`LOCK_TIMER_MS` (15 s) per sentence - `EARLY_TIMER_MS` (20 s) in Years 1-2,
where the child is still decoding (`lockTimerFor`) - enforced by the UI, graded by
`Core.timeout()`: expiry is a MISS in everything but the tap (run ends, lamp
lights, same difficulty math, its own teaching card). The clock pauses while
the tab is hidden and stops the moment an answer is committed. Settings
carries a grown-up off-switch; with the timer off nothing else changes.
`adjustDifficulty` still takes no time input - the timer is a per-sentence
failure condition, never a speed reward.

## Banding algorithm

`tools/score-difficulty.py` computes per set: rarity rank **R** from `zipf_min`
(≥4.2→1, 3.6→2, 3.0→3, 2.5→4, else 5) and tightness rank **T** from mean
pairwise Wu-Palmer similarity of the pinned synsets (<0.45→1 ... ≥0.75→5;
nouns/verbs only). `band_suggested = round((2R + T) / 3)`, rarity-only where
similarity is undefined (adjectives, bank C).

**`band_override` is the human word.** Corpus frequency systematically
undercounts children's-book words - tiptoe (zipf 2.64) and trudge (2.40) score
as band 4-5 by rarity while being early-primary vocabulary - so overrides
toward easier bands are normal and recorded per set. Gate M15 refuses any set
whose `band` disagrees with `band_override ?? band_suggested`.

## A WordNet lesson worth keeping

Intensity-scale **adjective** sets (dim/bright, quiet/loud, tiny/huge)
systematically fail gate G4 because WordNet defines scale words by their
siblings ("dim: not bright", "deafening: loud enough to..."). Manner **verb**
families survive because WordNet defines them via the base verb (walk, cry,
eat, throw), which is not a set member. Author accordingly: verb manners and
distinct-category sets are cheap; adjective scales need hand-authored care or
different member choices (the shine set works because its members are defined
via light, not via each other).

## Runtime adaptivity (for reference; the code is game-core.js)

The level is an integer 1-28 (`year = ceil(level / 4)`, `step = (level - 1) % 4`).
`adjustDifficulty(level, outcome, slips, cap)`:

| Outcome | Effect |
|---|---|
| clean crack (no misses) | one step up; on the year's 5-pin vault, **passes the year** |
| scrappy crack (cracked after a miss) | the in-a-row run breaks: back to the year's first step |
| exhausted safe (three misses) | back to the year's first step; the 2nd exhausted safe **in a row** (`SLIPS_TO_DROP`) drops to the start of the year below |
| review lockbox | nothing moves |

Speed never moves anything. A grown-up cap (Settings → Highest year) holds the
child at that year's 5-pin vault, and **Starting year** places a new player at
their school year's first step. The Year Passed screen fires only on a
first-ever arrival in a year; every crack and exhaust card says where the child
now stands ("2 clean cracks in a row to pass Year 3"). Saves from the old float
curve round onto the integer ladder.

## Spelling and Dictionary Vaults

Both modes climb the same 28-step ladder with the same in-a-row rule, each on
its own record, drawing sets by the same gifted pitch.

- **Spelling** is dictation: the word is heard (a recorded clip), its judged
  sentence gives the meaning, the child types it. Targets are the answer's
  surface form in that sentence, so inflection rules (doubling, dropping e,
  y to ied) come with it. A word's grade is a meaning grade, so spelling
  difficulty follows it loosely.
- **Word forms** puts versions of one word on the tiles (terrify /
  terrified / terrifying / terror), under a sentence judged for meaning. The
  sets come from the same year pitch; a set needs six judged questions to
  serve, and a thin year borrows from its neighbours.
- **Dictionary** is definition matching inside one confusable set, both ways
  (definition to word, word to definition), so every year's definitions are
  as close as that year's words: walking manners in Year 2, shades of doubt
  in Year 7.

## Exhaustion and review

Three misses exhaust a safe: the missed words' cards are shown, the child
returns to the start of the year (or the year below, on a second in a row), and the set joins the review queue flagged `exhausted` (served first).
Cracked sets queue too. After every 4th completed set, one lockbox is offered:
one run, 3-in-a-row, sentences drawn only from the set's reserve pool (never
seen in normal play), coins only.

## Knobs deliberately left tunable

Runs per set (3), the per-year crack curve (2/3/4/5, `crackNeedFor`), the
lock timer (`LOCK_TIMER_MS`, 15 s), review cadence (4) and lockbox length (3),
the help threshold (long-press glosses below level 17), steps per year (4)
and the slips that drop a year (2), the thin-year pool (`MIN_POOL`), bank mix targets (65/20/15), the served cue-mix curve (lever 3), and
the M11 length thresholds. All are constants in game-core.js or gates in
tools/, one line each.
