#!/usr/bin/env python3
"""
draft-families.py - draft the word families behind the Word Forms Vault.

  * forms/families.json   { "<set-id>": { "<word>": [ {form, pos, note}, ... ] } }

A family is the different versions of one word: terrify / terrifies /
terrified / terrifying / terror. The Word Forms Vault puts five of them on the
tiles under one of the word's already-judged sentences ("Aisha was ___, too
afraid to speak.") and the child picks the form that fits. Each form carries a
one-line dictionary-register note that leads with its part of speech
("adjective: feeling very great fear"); notes teach on the miss card.

Drafting is OpenAI (gpt-5.5, per the project's drafting convention); every
form is then checked mechanically: a real word (wordfreq zipf >= MIN_ZIPF),
distinct, the headword and all its recorded inflections present. A word with
fewer than 5 good forms gets no family (time words like "yesterday" have none).
Nothing here is shipped until tools/judge-forms.py has judged every question.

Run with the tools venv (needs wordfreq):
    python3 tools/draft-families.py               # draft sets that have no families yet
    python3 tools/draft-families.py --only A-scared-01,A-cry-01 --force
"""
import argparse
import concurrent.futures
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

from wordfreq import zipf_frequency

ROOT = Path(__file__).resolve().parent.parent
SETS = ROOT / "sets"
OUT = ROOT / "forms" / "families.json"
MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.5")
MIN_ZIPF = 2.0     # a form a child will actually meet in print
MIN_FORMS = 4      # four or five tiles (verbs often have exactly four: trudge/trudges/trudged/trudging)

SCHEMA = {
    "type": "object",
    "properties": {"words": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "word": {"type": "string"},
            "forms": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "form": {"type": "string"},
                    "pos": {"type": "string", "enum": ["verb", "noun", "adjective", "adverb"]},
                    "note": {"type": "string"},
                },
                "required": ["form", "pos", "note"], "additionalProperties": False}},
        },
        "required": ["word", "forms"], "additionalProperties": False}}},
    "required": ["words"], "additionalProperties": False,
}

PROMPT = """You are building word families for an Australian children's vocabulary game (school Years 1-7).
For each headword below, list the DIFFERENT VERSIONS OF THE SAME WORD a child meets in print:
inflections and derivations that share its root, e.g. terrified -> terrify, terrifies, terrified,
terrifying, terror; trudge -> trudge, trudges, trudged, trudging; vast -> vast, vastly, vastness.

Rules:
- 4 to 7 forms per headword. Include the headword itself and EVERY inflection listed for it.
- Only real, standard, reasonably common English words (Australian spelling: colour, realise).
  No rare coinages (no "trudger"), no phrases, no hyphen-joined inventions, no capitalised words.
- Each form must be spelt differently from the others.
- Keep the headword's MEANING: forms from an unrelated sense of the spelling are not family
  (no "stroller" for stroll - in Australia that is a pram; no "fogged" for fog if it means a lens).
- Never a COMPOUND with another word (no "hailstorm", "hailstone"), and never a different word that
  happens to be inside the headword (downpour is NOT family with pour).
- If a headword has fewer than 4 such forms (e.g. "yesterday", "now"), return just the forms it has.
- note: one dictionary-register line, at most 70 characters, starting with the part of speech and a
  colon, then the meaning of THAT form, e.g. "adjective: feeling very great fear",
  "adjective: causing very great fear", "verb: to make someone feel very great fear",
  "noun: very great fear". Do not use the form itself or its family members in its note.

Headwords (with the meaning they have in the game, and any recorded inflections):
"""


def draft(set_data: dict, key: str) -> dict:
    words = [{"word": w["w"], "meaning": w["gloss"], "part_of_speech": set_data["pos"],
              "inflections": sorted(set(w.get("forms", {}).values()))} for w in set_data["words"]]
    body = {"model": MODEL, "messages": [{"role": "user", "content": PROMPT + json.dumps(words, ensure_ascii=False, indent=1)}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "families", "schema": SCHEMA, "strict": True}}}
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        out = json.load(r)
    return json.loads(out["choices"][0]["message"]["content"])


def shares_root(form: str, head: str) -> bool:
    # a family member starts like its headword (terror/terrified, horror/horrify);
    # this rejects inside-words like downpour -> pour
    n = 0
    while n < min(len(form), len(head)) and form[n] == head[n]:
        n += 1
    return n >= 3 and n >= 0.4 * len(head)


def vet(word: dict, drafted: list) -> tuple:
    """Return (kept forms, reasons dropped)."""
    must = {word["w"].lower()} | {f.lower() for f in word.get("forms", {}).values()}
    seen, kept, dropped = set(), [], []
    for f in drafted:
        form = f["form"].strip().lower().replace("’", "'")
        if not re.fullmatch(r"[a-z]+(?:[-'][a-z]+)*", form):
            dropped.append(f"{form}: not a single word"); continue
        if form in seen:
            dropped.append(f"{form}: duplicate"); continue
        if form not in must and not shares_root(form, word["w"].lower()):
            dropped.append(f"{form}: does not share the headword's root"); continue
        if form not in must and zipf_frequency(form, "en") < MIN_ZIPF:
            dropped.append(f"{form}: too rare (zipf {zipf_frequency(form, 'en'):.2f})"); continue
        if len(f["note"]) > 80 or re.search(r"\b" + re.escape(form) + r"\b", f["note"].lower()):
            dropped.append(f"{form}: note too long or names the form"); continue
        seen.add(form)
        kept.append({"form": form, "pos": f["pos"], "note": f["note"].strip()})
    for m in must:
        if m not in seen:
            dropped.append(f"{m}: required form missing")
    return kept, dropped


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    key = os.environ.get("OPENAI_API_KEY") or sys.exit("OPENAI_API_KEY not set")
    fam = json.loads(OUT.read_text()) if OUT.exists() else {}
    only = set(filter(None, args.only.split(",")))
    todo = []
    for path in sorted(SETS.glob("*/*.json")):
        s = json.loads(path.read_text())
        if s["bank"] == "C" or (only and s["id"] not in only):
            continue  # usage sets (their/there) are not families
        if s["id"] in fam and not args.force:
            continue
        todo.append(s)
    print(f"draft-families: {len(todo)} set(s) to draft with {MODEL}")
    with concurrent.futures.ThreadPoolExecutor(6) as pool:
        futs = {pool.submit(draft, s, key): s for s in todo}
        for fut in concurrent.futures.as_completed(futs):
            s = futs[fut]
            try:
                got = {d["word"]: d["forms"] for d in fut.result()["words"]}
            except Exception as e:  # noqa: BLE001
                print(f"  {s['id']}: FAILED {e}"); continue
            fam[s["id"]] = {}
            for w in s["words"]:
                kept, dropped = vet(w, got.get(w["w"], []))
                for d in dropped:
                    print(f"  {s['id']}/{w['w']}: dropped {d}")
                if len(kept) >= MIN_FORMS and all(m in {k["form"] for k in kept} for m in
                                                  {w["w"].lower()} | {f.lower() for f in w.get("forms", {}).values()}):
                    fam[s["id"]][w["w"]] = kept
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(dict(sorted(fam.items())), indent=1, ensure_ascii=False) + "\n")
    n = sum(len(v) for v in fam.values())
    print(f"draft-families: {n} word families across {len(fam)} set(s) -> {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
