#!/usr/bin/env python3
"""
init-set.py - scaffolds one authored set file with pinned senses. Sentences
come later (tools/consult-sentences.py); this tool exists so that sense
selection is always an explicit human act - a naive first-synset lookup is
wrong (bawl.v.01 "shout loudly and without restraint" vs bawl.v.03 "cry
loudly") and there is deliberately no non-interactive default.

Usage (banks A/B, WordNet-backed):
  python3 tools/init-set.py --bank A --name size-01 --theme "how big" --pos adjective \
    --word tiny=tiny.s.01 --word big=big.s.01:dcs ...
  (the :initials suffix records dominant_sense_ok for words with >4 senses)

  Inspect senses first with:  python3 tools/init-set.py --senses big,huge --pos adjective

Usage (bank C, authored glosses):
  python3 tools/init-set.py --bank C --name their-there-01 --theme "their, there or they're" \
    --pos usage --word "their=belonging to them: their coats" ...

Irregular forms:  --forms "run=base:run,third:runs,past:ran,part:running"
Discriminators:   --disc "tiny=smaller than small"
"""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from nltk.corpus import wordnet as wn
from wordfreq import zipf_frequency

ROOT = Path(__file__).resolve().parent.parent
POS_MAP = {"verb": "v", "noun": "n", "adjective": "a", "adverb": "r"}


def regular_forms(w: str, pos: str) -> dict:
    if pos != "verb":
        return {"base": w}
    if re.search(r"[^aeiou]y$", w):
        stem = w[:-1]
        return {"base": w, "third": stem + "ies", "past": stem + "ied", "part": w + "ing"}
    if re.search(r"(s|x|z|ch|sh)$", w):
        return {"base": w, "third": w + "es", "past": w + "ed", "part": w + "ing"}
    if w.endswith("e"):
        return {"base": w, "third": w + "s", "past": w + "d", "part": w[:-1] + "ing"}
    return {"base": w, "third": w + "s", "past": w + "ed", "part": w + "ing"}


def show_senses(words: list[str], pos: str) -> None:
    wn_pos = POS_MAP.get(pos)
    for w in words:
        z = zipf_frequency(w, "en")
        synsets = wn.synsets(w, wn_pos) if wn_pos else wn.synsets(w)
        # adjectives live in 'a' and satellite 's' synsets; show both
        if pos == "adjective":
            synsets = [s for s in wn.synsets(w) if s.pos() in ("a", "s")]
        print(f"== {w} (zipf {z:.2f}, {len(synsets)} senses)")
        for s in synsets:
            print(f"   {s.name():<22} {s.definition()}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--senses", help="comma list: just print senses and exit")
    ap.add_argument("--bank", choices=["A", "B", "C"])
    ap.add_argument("--name")
    ap.add_argument("--theme")
    ap.add_argument("--pos", required=True)
    ap.add_argument("--word", action="append", default=[])
    ap.add_argument("--forms", action="append", default=[])
    ap.add_argument("--disc", action="append", default=[])
    args = ap.parse_args()

    if args.senses:
        show_senses(args.senses.split(","), args.pos)
        return 0
    if not (args.bank and args.name and args.theme and len(args.word) == 5):
        ap.error("need --bank, --name, --theme and exactly five --word entries")

    forms_over = {k: dict(p.split(":") for p in v.split(",")) for k, v in
                  (f.split("=", 1) for f in args.forms)}
    discs = dict(d.split("=", 1) for d in args.disc)

    words = []
    for spec in args.word:
        lemma, rest = spec.split("=", 1)
        entry = {"w": lemma}
        if args.bank == "C":
            entry.update({"synset": None, "gloss_source": "authored", "gloss": rest})
            senses = 0
        else:
            synset_id, _, signoff = rest.partition(":")
            syn = wn.synset(synset_id)
            wn_pos = POS_MAP[args.pos]
            senses = len([s for s in wn.synsets(lemma) if s.pos() in (("a", "s") if args.pos == "adjective" else (wn_pos,))])
            entry.update({"synset": synset_id, "gloss_source": "wordnet", "gloss": syn.definition()})
            if senses > 4:
                if not signoff:
                    raise SystemExit(f"{lemma} has {senses} senses at pos - append :initials to sign off the dominant sense")
                entry["dominant_sense_ok"] = {"by": signoff, "at": datetime.now(timezone.utc).date().isoformat()}
        entry["zipf"] = round(zipf_frequency(lemma, "en"), 2)
        entry["register"] = "neutral"
        entry["senses_at_pos"] = senses
        if "dominant_sense_ok" not in entry:
            entry["dominant_sense_ok"] = None
        entry["forms"] = forms_over.get(lemma) or regular_forms(lemma, args.pos)
        entry["discriminator"] = discs.get(lemma, "")
        words.append(entry)

    set_id = f"{args.bank}-{args.name}"
    out = ROOT / "sets" / args.bank / f"{args.name}.json"
    if out.exists():
        raise SystemExit(f"{out} already exists")
    out.write_text(json.dumps({
        "id": set_id, "bank": args.bank, "pos": args.pos, "theme": args.theme,
        "band": None, "band_override": None, "computed": None,
        "words": words, "sentences": [], "contrasts": [],
        "meta": {"generated_at": None, "model": None, "scrubbed_at": None, "scrub_note": None},
    }, indent=2, ensure_ascii=False) + "\n")
    print(f"scaffolded {out.relative_to(ROOT)} - now run consult-sentences.py, then audit + judge")
    return 0


if __name__ == "__main__":
    sys.exit(main())
