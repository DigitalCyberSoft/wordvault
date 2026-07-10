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
| 5 | Sentence length | short frames dominate low years (review-lane flag above 15 words in bands 1-2; bands remain authoring metadata) |
| 6 | Review pressure | lockboxes interleave after every 4th set at all levels |

Fixed non-levers: 3 runs per safe, 5 tiles. The lock timer (below) is a
failure condition, not a difficulty input: speed never moves the level.

## The year ladder

Seven Australian school years of four levels each (`MAX_LEVEL = 28`). WITHIN
every year the crack requirement climbs - 2 pins at the year's first level,
then 3, 4, and the full 5 as its exit exam (`crackNeedFor` cycles; review
lockboxes stay at 3) - so each year's new vocabulary gets fast early wins and
ends on a structurally hard vault. Leveling is still gated on clean-crack
streaks, never on a single success.

Sets are pitched at the school year of their HARDEST word (`setYearOf`: the
max of the per-word `grade` fields; the child must know all five). Selection
widens one year at a time if a year is thin. Bank C never serves below year 3.

| Years | Levels | Feel | Banks | Example sets |
|---|---|---|---|---|
| 1-2 | 1-8 | Everyday similarity families, manner splits | A, B | ways to move things, sounds people make, cry, eat |
| 3-4 | 9-16 | Rarer members, one-shade gaps, usage traps begin | A, B, C | brave, tired, shine, their/there, borrow/lend |
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

`LOCK_TIMER_MS` (15 s) per sentence, enforced by the UI, graded by
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

Difficulty is a float; level = round(difficulty), clamped to 1-28. The only way
up is a **clean crack** (no misses), and climbing needs a consecutive run of
them that lengthens with level: 1 through year 3 (levels 1-12), 2 across years
4-5 (13-20), 3 in years 6-7 (21-28). Up-step +0.7; set exhaustion (three
misses) steps -0.8; scrappy cracks hold. Review lockboxes never move the
level. A parent cap clamps the top, and **Starting year** (Settings) places a
new player at their school year's first level. The Level Up screen fires only
on a first-ever reach of a level.

## Exhaustion and review

Three misses exhaust a safe: the missed words' cards are shown, the level
drops, and the set joins the review queue flagged `exhausted` (served first).
Cracked sets queue too. After every 4th completed set, one lockbox is offered:
one run, 3-in-a-row, sentences drawn only from the set's reserve pool (never
seen in normal play), coins only.

## Knobs deliberately left tunable

Runs per set (3), the per-year crack curve (2/3/4/5, `crackNeedFor`), the
lock timer (`LOCK_TIMER_MS`, 15 s), review cadence (4) and lockbox length (3),
the help threshold (long-press glosses below level 17), the needed-streak
curve, bank mix targets (65/20/15), the served cue-mix curve (lever 3), and
the M11 length thresholds. All are constants in game-core.js or gates in
tools/, one line each.
