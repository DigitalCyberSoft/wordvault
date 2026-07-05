#!/usr/bin/env python3
"""
audit-glosses.py - stage-1 content gate (G1-G8). Run: python3 tools/audit-glosses.py

Audits every authored set under sets/{A,B,C}/ against WordNet and wordfreq:
sense pinning, verbatim glosses, synset collisions, sibling-lemma glosses,
gloss opacity (a defining word rarer than the headword), Zipf floors, polysemy
sign-offs, POS and register. Pure-local: needs nltk (wordnet corpus) and
wordfreq, no network.

HARD failures exit non-zero and no stamp is written. On success the file
reference/stamps/gloss-audit.json records a sha256 per set file; the Node gate
(tools/validate-sets.js, gate M13) refuses to pass any set whose current hash
is missing or stale, so this audit can never be skipped or run against old
content. REVIEW items are printed and do not block.
"""
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from nltk.corpus import wordnet as wn
from wordfreq import zipf_frequency

ROOT = Path(__file__).resolve().parent.parent
SETS = ROOT / "sets"
STAMP = ROOT / "reference" / "stamps" / "gloss-audit.json"

POS_MAP = {"verb": ("v",), "noun": ("n",), "adjective": ("a", "s"), "adverb": ("r",)}
REGISTERS = {"neutral", "formal", "informal"}
STOP = set(
    """a an the and or but of to in on at for with as by from is are was were be
    been being it its this that these those one one's some any all no not so
    such when while where who whom whose which what or; usually especially""".split()
)

hard: list[str] = []
review: list[str] = []


def content_words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z']+", text.lower()) if w not in STOP and len(w) > 2]


def audit_word(set_id: str, set_pos: str, w: dict, member_words: list[str]) -> None:
    lemma = w["w"]
    where = f"{set_id}/{lemma}"

    if w.get("gloss_source") == "authored":
        if not w.get("gloss"):
            hard.append(f"[G1] {where}: authored gloss is empty")
        return

    # G1 synset exists
    try:
        syn = wn.synset(w["synset"])
    except Exception:
        hard.append(f"[G1] {where}: synset {w.get('synset')!r} does not resolve")
        return

    # G2 gloss is the synset definition, verbatim
    if w.get("gloss") != syn.definition():
        hard.append(f"[G2] {where}: gloss is not verbatim WordNet ({w.get('gloss')!r} vs {syn.definition()!r})")

    # G8 POS match
    allowed = POS_MAP.get(set_pos, ())
    if syn.pos() not in allowed:
        hard.append(f"[G8] {where}: synset POS {syn.pos()!r} does not match set pos {set_pos!r}")
    if w.get("register") not in REGISTERS:
        hard.append(f"[G8] {where}: register {w.get('register')!r} not in {sorted(REGISTERS)}")

    # G4 gloss contains a sibling lemma (lemmatised, word-boundary)
    for gw in content_words(w["gloss"]):
        base = wn.morphy(gw) or gw
        for sibling in member_words:
            if sibling != lemma and base == sibling:
                hard.append(f"[G4] {where}: gloss contains sibling lemma {sibling!r} - swap the word, do not reword")

    # G5 gloss opacity. A defining word is a problem only when it is BOTH rarer
    # than the headword AND rare in absolute terms: "walk" (zipf 5.1) inside the
    # gloss of "march" (5.26) is fine, "convulsively" (1.9) inside "sob" (3.7)
    # is the bug this gate exists for. OPACITY_FLOOR is the absolute cut for the
    # 8-12 audience; a knob, recorded here.
    OPACITY_FLOOR = 3.2
    head_z = zipf_frequency(lemma, "en")
    waived = set((w.get("gloss_zipf_waiver") or {}).get("words", []))
    for gw in set(content_words(w["gloss"])):
        if gw == lemma or gw in (w.get("forms") or {}).values():
            continue
        z = zipf_frequency(gw, "en")
        # -ly adverbs are morphologically transparent: "noisily" is readable by
        # anyone who knows "noisy". Score the stem when it beats the surface.
        if gw.endswith("ly"):
            for stem in (gw[:-2], gw[:-3] + "y"):
                z = max(z, zipf_frequency(stem, "en"))
        if z < min(head_z, OPACITY_FLOOR):
            if gw in waived:
                review.append(f"[G5] {where}: gloss word {gw!r} (zipf {z:.2f} < {head_z:.2f}) - waived: "
                              f"{(w.get('gloss_zipf_waiver') or {}).get('reason', '')}")
            else:
                hard.append(f"[G5] {where}: gloss word {gw!r} zipf {z:.2f} < headword {head_z:.2f} "
                            f"- swap the word or record a gloss_zipf_waiver")

    # G6 member frequency floor
    if head_z < 2.0:
        hard.append(f"[G6] {where}: zipf {head_z:.2f} below the 2.0 floor")
    elif head_z < 2.5:
        review.append(f"[G6] {where}: zipf {head_z:.2f} in the 2.0-2.5 grey zone")
    stored = w.get("zipf")
    if stored is not None and abs(stored - head_z) > 0.05:
        hard.append(f"[G6] {where}: stored zipf {stored} disagrees with wordfreq {head_z:.2f}")

    # G7 polysemy needs a recorded human sense sign-off
    senses = len(wn.synsets(lemma, allowed[0])) if allowed else 0
    if w.get("senses_at_pos") is not None and w["senses_at_pos"] != senses:
        hard.append(f"[G7] {where}: senses_at_pos says {w['senses_at_pos']}, WordNet has {senses}")
    if senses > 4 and not w.get("dominant_sense_ok"):
        hard.append(f"[G7] {where}: {senses} senses at POS and no dominant_sense_ok sign-off")


def audit_set(path: Path) -> None:
    set_data = json.loads(path.read_text())
    set_id = set_data.get("id", str(path))
    members = [w["w"] for w in set_data["words"]]

    # G3 synset collisions across members
    pinned = {}
    for w in set_data["words"]:
        if w.get("synset"):
            if w["synset"] in pinned:
                hard.append(f"[G3] {set_id}: {w['w']!r} and {pinned[w['synset']]!r} share synset {w['synset']}")
            pinned[w["synset"]] = w["w"]
    for w in set_data["words"]:
        if not w.get("synset"):
            continue
        try:
            names = set(wn.synset(w["synset"]).lemma_names())
        except Exception:
            continue  # G1 already reported it
        for sibling in members:
            if sibling != w["w"] and sibling in names:
                hard.append(f"[G3] {set_id}: {sibling!r} is a lemma of {w['w']}'s synset {w['synset']} - ungradeable pair")

    for w in set_data["words"]:
        audit_word(set_id, set_data.get("pos", ""), w, members)


def main() -> int:
    files = sorted(SETS.glob("*/*.json"))
    if not files:
        print("audit-glosses: no set files under sets/", file=sys.stderr)
        return 1
    for f in files:
        audit_set(f)

    for r in review:
        print(f"REVIEW {r}")
    for h in hard:
        print(f"HARD   {h}", file=sys.stderr)
    print(f"audit-glosses: {len(files)} set file(s), {len(hard)} hard, {len(review)} review")

    if hard:
        return 1
    STAMP.parent.mkdir(parents=True, exist_ok=True)
    STAMP.write_text(json.dumps({
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "files": {str(f.relative_to(ROOT)): hashlib.sha256(f.read_bytes()).hexdigest() for f in files},
    }, indent=2) + "\n")
    print(f"stamp written: {STAMP.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
