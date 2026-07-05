#!/usr/bin/env python3
"""
extract-candidates.py - mines WordNet for confusable-set raw material.
Run: python3 tools/extract-candidates.py [seed.pos ...]   (default: a starter list)

For each seed synset, lists its hyponym lemmas with zipf, sense count and
gloss, flagging the known hazards (zipf below the 2.0 floor or in the 2.0-2.5
grey zone, polysemy over 4, multiword lemmas). Candidate mining ONLY: it picks
nothing - a human curates coherent manner/intensity pools out of these and
pins senses via init-set.py, because WordNet cannot tell a coherent pool
(stride/saunter/stomp) from a grab-bag (run/fly/swim).

Output: reference/candidates.json + reference/CANDIDATES.md.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from nltk.corpus import wordnet as wn
from wordfreq import zipf_frequency

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SEEDS = [
    "walk.v.01", "cry.v.02", "talk.v.02", "eat.v.01", "look.v.01",
    "throw.v.01", "hold.v.01", "shine.v.02", "rain.n.01", "happy.a.01",
]


def lemma_row(lemma: str) -> dict:
    z = zipf_frequency(lemma.replace("_", " "), "en")
    senses = len(wn.synsets(lemma))
    flags = []
    if "_" in lemma:
        flags.append("multiword")
    if z < 2.0:
        flags.append("below-floor")
    elif z < 2.5:
        flags.append("grey-zone")
    if senses > 4:
        flags.append("polysemous")
    return {"lemma": lemma.replace("_", " "), "zipf": round(z, 2), "senses": senses, "flags": flags}


def main() -> int:
    seeds = sys.argv[1:] or DEFAULT_SEEDS
    out = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "seeds": {}}
    lines = ["# Candidate pools", "", "Mined by tools/extract-candidates.py. Curate by hand; pin senses via init-set.py.", ""]
    for seed in seeds:
        syn = wn.synset(seed)
        pool = []
        for hyp in syn.hyponyms() + ([syn] if not syn.hyponyms() else []):
            for lemma in hyp.lemma_names():
                row = lemma_row(lemma)
                row["synset"] = hyp.name()
                row["gloss"] = hyp.definition()
                pool.append(row)
        pool.sort(key=lambda r: -r["zipf"])
        out["seeds"][seed] = {"gloss": syn.definition(), "pool": pool}
        lines.append(f"## {seed} - {syn.definition()}")
        lines.append("")
        for r in pool:
            flag = (" [" + ",".join(r["flags"]) + "]") if r["flags"] else ""
            lines.append(f"- **{r['lemma']}** (zipf {r['zipf']}, {r['senses']} senses){flag} `{r['synset']}` {r['gloss']}")
        lines.append("")
    ref = ROOT / "reference"
    ref.mkdir(exist_ok=True)
    (ref / "candidates.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    (ref / "CANDIDATES.md").write_text("\n".join(lines) + "\n")
    print(f"extract-candidates: {len(seeds)} seed(s) -> reference/CANDIDATES.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
