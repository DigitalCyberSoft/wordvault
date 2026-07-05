#!/usr/bin/env python3
"""
score-difficulty.py - writes each set's `computed` block: zipf stats, semantic
tightness, and a suggested band. Run: python3 tools/score-difficulty.py

Banding algorithm (LEVELS.md): rarity rank R from zipf_min (>=4.2 -> 1,
3.6-4.2 -> 2, 3.0-3.6 -> 3, 2.5-3.0 -> 4, <2.5 -> 5); tightness rank T from
mean pairwise Wu-Palmer similarity between pinned synsets (<0.45 -> 1 ... >=0.75
-> 5); suggested = round((2R + T) / 3). Wu-Palmer only works for nouns and
verbs; adjective sets and bank C fall back to rarity alone. Corpus frequency
undercounts children's-book words (tiptoe, trudge), so `band_override` is the
human word and the shipped `band` is override ?? suggested.

Idempotent and pure-local. Deliberately leaves `band` alone when it already
matches; a mismatch is reported (and gate M15 hard-fails it) rather than
silently rewritten.
"""
import json
import sys
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path

from nltk.corpus import wordnet as wn
from wordfreq import zipf_frequency

ROOT = Path(__file__).resolve().parent.parent


def rarity_rank(zipf_min: float) -> int:
    return 1 if zipf_min >= 4.2 else 2 if zipf_min >= 3.6 else 3 if zipf_min >= 3.0 else 4 if zipf_min >= 2.5 else 5


def tightness_rank(t: float) -> int:
    return 1 if t < 0.45 else 2 if t < 0.55 else 3 if t < 0.65 else 4 if t < 0.75 else 5


def main() -> int:
    bad = 0
    for path in sorted((ROOT / "sets").glob("*/*.json")):
        set_data = json.loads(path.read_text())
        zipfs = [zipf_frequency(w["w"], "en") for w in set_data["words"]]
        synsets = []
        for w in set_data["words"]:
            if w.get("synset"):
                s = wn.synset(w["synset"])
                if s.pos() in ("n", "v"):
                    synsets.append(s)
        tightness = None
        if len(synsets) == 5:
            sims = [a.wup_similarity(b) or 0.0 for a, b in combinations(synsets, 2)]
            tightness = round(sum(sims) / len(sims), 3)
        r = rarity_rank(min(zipfs))
        suggested = round((2 * r + tightness_rank(tightness)) / 3) if tightness is not None else r
        suggested = max(1, min(5, suggested))
        computed = {
            "zipf_min": round(min(zipfs), 2),
            "zipf_mean": round(sum(zipfs) / len(zipfs), 2),
            "tightness": tightness,
            "band_suggested": suggested,
            "scored_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        if set_data.get("computed", {}).get("note"):
            computed["note"] = set_data["computed"]["note"]
        set_data["computed"] = computed
        band = set_data.get("band_override") if set_data.get("band_override") is not None else suggested
        if set_data.get("band") != band:
            print(f"{set_data['id']}: band {set_data.get('band')} != override/suggested {band} - fix the set file")
            bad += 1
        path.write_text(json.dumps(set_data, indent=2, ensure_ascii=False) + "\n")
        print(f"{set_data['id']}: zipf_min {computed['zipf_min']}, tightness {tightness}, "
              f"suggested {suggested}, band {set_data.get('band')}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
