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
| 1 | Word rarity | zipf_min ≥ 4.2 → below 2.5 (tier-2 words) |
| 2 | Set tightness | distinct categories (hiss / moo) → adjacent rungs of one scale (gleaming / twinkling) |
| 3 | Cue mix *served* | explicit-heavy → inferential-heavy (authoring is uniform 2/2/2; the runtime shifts what it draws - a future knob, v1 serves uniformly) |
| 4 | Bank mix | A+B only → bank C (their/there, borrow/lend) from band 3 |
| 5 | Sentence length | short frames dominate low bands (review-lane flag above 15 words in bands 1-2) |
| 6 | Review pressure | lockboxes interleave after every 4th set at all levels |

Fixed non-levers: 3 runs per safe, 5 tiles, no timers. (Crack length is a
lever since the band-scaling change: see Bands below.)

## Bands

Five bands of four levels each (`MAX_LEVEL = 20`). The crack requirement grows
with the band - 2 pins at band 1, 3 at band 2, 4 at band 3, 5 from band 4
(`crackNeedFor`; review lockboxes stay at 3) - so higher vaults are structurally
harder as well as lexically harder. Leveling is still gated on clean-crack
streaks, never on a single success.

| Band | Levels | Feel | Banks | Example sets |
|---|---|---|---|---|
| 1 | 1-4 | Highest-frequency similarity families | A | (served by band-2 fallback in the pilot) |
| 2 | 5-8 | Similar words split by one everyday feature | A, B | kinds of happy, ways of being big, cry, eat, ways of walking |
| 3 | 9-12 | Rarer members, one-shade gaps, usage traps begin | A, B, C | ways of being brave, kinds of tired, kinds of shine, their/there, borrow/lend |
| 4 | 13-16 | Tier-2 vocabulary, inferential cues carry more | A, B, C | (post-pilot authoring) |
| 5 | 17-20 | Adjacent-rung sets, cue buried or fully inferential | A, B, C | (post-pilot authoring) |

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

Difficulty is a float; level = round(difficulty), clamped to 1-20. The only way
up is a **clean crack** (no misses), and climbing needs a consecutive run of
them that lengthens with level: 1 below 10, 2 from 10-15, 3 from 16. Up-step
+0.7; set exhaustion (three misses) steps -0.8; scrappy cracks hold. Review
lockboxes never move the level. A parent cap clamps the top. The Level Up
screen fires only on a first-ever reach of a level.

## Exhaustion and review

Three misses exhaust a safe: the missed words' cards are shown, the level
drops, and the set joins the review queue flagged `exhausted` (served first).
Cracked sets queue too. After every 4th completed set, one lockbox is offered:
one run, 3-in-a-row, sentences drawn only from the set's reserve pool (never
seen in normal play), coins only.

## Knobs deliberately left tunable

Runs per set (3), the crack-length band curve (2/3/4/5, `crackNeedFor`),
review cadence (4) and lockbox length (3),
the help threshold (long-press glosses below level 12), the needed-streak
curve, bank mix targets (65/20/15), the served cue-mix curve (lever 3), and
the M11 length thresholds. All are constants in game-core.js or gates in
tools/, one line each.
