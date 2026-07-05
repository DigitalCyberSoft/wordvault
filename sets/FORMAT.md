# Authored-set format

One JSON file per set under `sets/{A,B,C}/`; the file name is the set id minus
its bank prefix (`A-cry-01` lives at `sets/A/cry-01.json`). These files are the
source of truth: `tools/bake-content.js` compiles them into `game-content.js`
after every gate passes, and the runtime never reads `sets/` itself.

Scaffold with `tools/init-set.py` (which forces an explicit sense pick per
word), draft sentences with `tools/consult-sentences.py`, then run the gates:
`audit-glosses.py` → `judge-uniqueness.py` → `validate-sets.js` → `bake-content.js`.

## Top level

| Field | Meaning |
|---|---|
| `id` | `^[ABC]-[a-z0-9-]+$`, bank prefix must match the directory |
| `bank` | `A` gradient near-synonyms · `B` same-category, one clean feature each · `C` school-usage confusions (authored glosses, band ≥ 3) |
| `pos` | `verb` / `adjective` / `noun` / `usage` (bank C) |
| `theme` | Short child-facing label, shown on the Get Ready screen |
| `band` | 1-5; must equal `band_override ?? computed.band_suggested` (gate M15) |
| `band_override` | The human banding word; corpus frequency undercounts children's-book words, so overrides are normal |
| `computed` | Written by `score-difficulty.py`: `zipf_min`, `zipf_mean`, `tightness` (Wu-Palmer, nouns/verbs only), `band_suggested` |
| `words` | Exactly 5 (below). Array order IS the semantic gradient shown on Get Ready |
| `sentences` | 8 per word: 2 explicit + 2 contextual + 2 inferential active, 2 reserve (the review-lockbox pool) |
| `contrasts` | All 20 directed pairs `{answer, picked, line}`, ≤140 chars, mention only the pair |
| `meta` | `generated_at`/`model` (drafting provenance) + `scrubbed_at`/`scrub_note` — unscrubbed machine output never bakes (gate M12) |

## A word

```json
{ "w": "trudge", "synset": "slog.v.02", "gloss_source": "wordnet",
  "gloss": "walk heavily and firmly, as when weary, or through mud",
  "zipf": 2.40, "register": "neutral", "senses_at_pos": 1,
  "dominant_sense_ok": null,
  "forms": { "base": "trudge", "third": "trudges", "past": "trudged", "part": "trudging" },
  "discriminator": "slow, heavy and tired, but keeps going" }
```

- `gloss` is the pinned synset's definition **verbatim** (gate G2). It IS the
  player-facing card copy; a bad gloss means swapping the word, never rewording.
- `synset` and `w` are separate because synset names need not contain the
  headword (trudge → `slog.v.02`).
- `dominant_sense_ok` (`{by, at, note?}`) is required when the lemma has more
  than 4 senses at the set's POS (gate G7).
- `gloss_zipf_waiver` (`{words, reason, by, at}`) is the only escape from the
  gloss-opacity gate (G5): a defining word rarer than both the headword and the
  audience floor must be waived with a reason or the word swapped.
- Bank C words: `synset: null`, `gloss_source: "authored"`, and `gloss` is a
  hand-written usage one-liner.
- Bank A words MAY pin a synset and still carry `gloss_source: "authored"`.
  This is the sanctioned escape for scale families WordNet defines circularly
  (dim = "not bright") or with words below the opacity floor: the synset stays
  pinned (it anchors the sense for G3/G7/G8 and the judge's sense check), only
  the card text is authored. Authored glosses are dictionary-register, never
  kiddified, and every gloss gate except G2 verbatim (G4 siblings, G5 opacity,
  G6 frequency) still applies to them.

## A sentence

```json
{ "id": "A-walk-manner-01-s17", "answer": "trudge", "cue": "contextual", "reserve": false,
  "text": "Worn out after training, every player ___ slowly back to the changing rooms together.",
  "cue_phrase": "worn out; slowly; together",
  "surface": { "march": "marched", "tiptoe": "tiptoed", "trudge": "trudged",
               "stroll": "strolled", "limp": "limped" } }
```

- Exactly one `___`; 6-18 words; the cue must EXCLUDE the other four words,
  not merely suit the answer (gate G9 sends every sentence through a
  cross-vendor judge ensemble and a two-fit never ships).
- `surface` carries a grammatical form of ALL FIVE words for this frame, so
  meaning is the only discriminator - never morphology.
- No member word (or inflection) may appear in the text; no quoting the gloss.
- `waivers` (`[{check, note/word, by, at}]`) records human resolutions of
  review-lane flags, e.g. an accepted single-judge dissent.

Lessons baked into the drafting prompt after the first judged set: make
exhaustion cues collective (a whole team, not one person - one person might be
injured), injury cues one-sided (one ankle, one leg), and never hang the cue on
something every member satisfies (schedules fit strolling guards as well as
marching ones).
