#!/usr/bin/env python3
"""
consult-sentences.py - LLM-drafts the sentence pool and contrast lines for any
set that doesn't have them yet. Run: python3 tools/consult-sentences.py
(SETS_ONLY=A-size-01,... limits it; a populated set is never overwritten.)

Drafting is cheap; validation is the job. This tool bakes the authoring rules
(and the lessons the judge ensemble taught on the pilot set) into the prompt,
mechanically checks the draft's SHAPE before writing it, and stamps
generated_at/model - but it never stamps scrubbed_at: a human reads the draft
(gate M12), and every sentence still faces audit-glosses, judge-uniqueness and
validate-sets before it can bake. Model chain mirrors the pizzashop consult
scripts: OPENAI_MODEL override, then gpt-5.5, gpt-5.4, gpt-4.1 (ids verified
against this key).
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = [m for m in [os.environ.get("OPENAI_MODEL"), "gpt-5.5", "gpt-5.4", "gpt-4.1"] if m]
CUES = ["explicit", "contextual", "inferential"]
STOP = set("""a an the and or but of to in on at for with as by from is are was were be been being it its
this that these those through over under into onto along toward towards past around about before after
again out up down off very one one's some any all no not so such when while where who whom whose which
what""".split())

SCHEMA = {
    "type": "object",
    "properties": {
        "sentences": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "answer": {"type": "string"},
                "cue": {"type": "string", "enum": CUES},
                "reserve": {"type": "boolean"},
                "text": {"type": "string"},
                "cue_phrase": {"type": "string"},
                "surface": {"type": "array", "items": {
                    "type": "object",
                    "properties": {"word": {"type": "string"}, "form": {"type": "string"}},
                    "required": ["word", "form"], "additionalProperties": False}},
            },
            "required": ["id", "answer", "cue", "reserve", "text", "cue_phrase", "surface"],
            "additionalProperties": False}},
        "contrasts": {"type": "array", "items": {
            "type": "object",
            "properties": {"answer": {"type": "string"}, "picked": {"type": "string"}, "line": {"type": "string"}},
            "required": ["answer", "picked", "line"], "additionalProperties": False}},
    },
    "required": ["sentences", "contrasts"],
    "additionalProperties": False,
}


def load_key() -> str:
    if os.environ.get("OPENAI_API_KEY"):
        return os.environ["OPENAI_API_KEY"]
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("OPENAI_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("OPENAI_API_KEY not set")


def content_words(text: str) -> set:
    return {w for w in re.findall(r"[a-z']+", text.lower()) if w not in STOP and len(w) > 2}


def build_prompt(set_data: dict) -> str:
    words = set_data["words"]
    lemmas = [w["w"] for w in words]
    per_word = []
    for i, w in enumerate(words):
        banned = sorted(content_words(w["gloss"]))
        per_word.append({
            "word": w["w"],
            "meaning": w["gloss"],
            "what_sets_it_apart": w.get("discriminator", ""),
            "known_forms": w.get("forms", {}),
            "words_banned_from_its_sentences": banned,
            "sentence_ids": [f"{set_data['id']}-s{i * 8 + k + 1:02d}" for k in range(8)],
        })
    rules = f"""You are authoring fill-in-the-blank items for a children's vocabulary game (ages 8-12).
Set theme: {set_data['theme']}. The five words: {', '.join(lemmas)}.

Write EXACTLY 8 sentences per word (40 total) using that word's listed sentence_ids in order, and
EXACTLY 20 contrast lines (every ordered pair).

Per word, the 8 sentences are: 2 cue="explicit" + 2 cue="contextual" + 2 cue="inferential" with
reserve=false, then 2 more of any cue type with reserve=true.

HARD RULES for every sentence:
- exactly one blank written as ___ ; 6 to 18 words long; child-appropriate; UK-neutral spelling; no brand names or real people.
- THE CUE MUST EXCLUDE THE OTHER FOUR WORDS, not merely suit the answer. Before writing, mentally
  place each of the other four words in the blank: if any reads as acceptable to a careful adult,
  the sentence is broken. Traps to avoid, learned the hard way: a cue about schedule/regularity fits
  any walking word; "worn out" alone lets an injury word in (make exhaustion collective: several
  people at once, and injury one-sided: one leg, one ankle); avoidance-of-pain mechanics let a
  careful-quiet word in; idioms ("marched on") that other members also satisfy.
- never use any of the five words or any inflection of them in the sentence text.
- never use the words listed as banned for the answer word (they come from its dictionary gloss).
- cue_phrase: quote the 2-6 word span of the sentence that carries the cue.
- surface: give a form of ALL FIVE words that fits the frame grammatically (same tense and
  agreement for every one; the child must never be able to rule a word out by grammar).
- vary the frames: mix past tense, base form after "to"/"made her"/"had me", and one or two
  present-tense generics; vary settings (home, school, outdoors, story-worlds); never reuse a cue phrase.

CONTRAST LINES (all 20 ordered pairs answer->picked): at most 140 characters, plain language for a
child, mention only those two words, and teach the difference the cue turns on, e.g.
"Trudging is slow, tired work. This walk is light and happy."
"""
    return rules + "\nWORD DATA:\n" + json.dumps(per_word, ensure_ascii=False, indent=1)


def call_openai(key: str, model: str, prompt: str) -> dict:
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "draft", "schema": SCHEMA, "strict": True}},
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        out = json.load(r)
    return json.loads(out["choices"][0]["message"]["content"])


def shape_errors(set_data: dict, draft: dict) -> list[str]:
    errs = []
    lemmas = [w["w"] for w in set_data["words"]]
    want_ids = {f"{set_data['id']}-s{i * 8 + k + 1:02d}": lemmas[i] for i in range(5) for k in range(8)}
    seen = {}
    for s in draft["sentences"]:
        sid = s["id"]
        if sid not in want_ids:
            errs.append(f"{sid}: unexpected id"); continue
        if sid in seen:
            errs.append(f"{sid}: duplicate id"); continue
        seen[sid] = True
        if s["answer"] != want_ids[sid]:
            errs.append(f"{sid}: answer {s['answer']} but this id belongs to {want_ids[sid]}")
        if s["text"].count("___") != 1:
            errs.append(f"{sid}: needs exactly one ___")
        got = {p["word"] for p in s["surface"]}
        if got != set(lemmas):
            errs.append(f"{sid}: surface covers {sorted(got)}, need all of {lemmas}")
        n = len(re.findall(r"[A-Za-z']+", s["text"].replace("___", "x")))
        if not 6 <= n <= 18:
            errs.append(f"{sid}: {n} words (bounds 6-18)")
    missing = set(want_ids) - set(seen)
    if missing:
        errs.append(f"missing sentence ids: {sorted(missing)[:5]}...")
    for w in [x["w"] for x in set_data["words"]]:
        mine = [s for s in draft["sentences"] if s.get("answer") == w and s["id"] in want_ids]
        active = [s for s in mine if not s["reserve"]]
        for cue in CUES:
            if len([s for s in active if s["cue"] == cue]) != 2:
                errs.append(f"{w}: needs exactly 2 active {cue} cues")
        if len(mine) - len(active) != 2:
            errs.append(f"{w}: needs exactly 2 reserve sentences")
    pairs = {(c["answer"], c["picked"]) for c in draft["contrasts"]}
    want_pairs = {(a, p) for a in lemmas for p in lemmas if a != p}
    if pairs != want_pairs:
        errs.append(f"contrasts cover {len(pairs)} pairs, need all {len(want_pairs)}")
    for c in draft["contrasts"]:
        if len(c["line"]) > 140:
            errs.append(f"contrast {c['answer']}->{c['picked']}: over 140 chars")
    return errs


def main() -> int:
    key = load_key()
    only = set(filter(None, os.environ.get("SETS_ONLY", "").split(",")))
    for path in sorted((ROOT / "sets").glob("*/*.json")):
        set_data = json.loads(path.read_text())
        if only and set_data["id"] not in only:
            continue
        if len(set_data.get("sentences", [])) >= 40:
            continue
        print(f"{set_data['id']}: drafting...")
        prompt = build_prompt(set_data)
        draft = None
        for model in MODELS:
            for attempt in range(2):
                try:
                    candidate = call_openai(key, model, prompt if attempt == 0 else
                                            prompt + "\n\nYOUR PREVIOUS DRAFT HAD THESE SHAPE ERRORS - fix all of them:\n" +
                                            "\n".join(errs))
                except urllib.error.HTTPError as e:
                    print(f"  {model}: HTTP {e.code}, trying next")
                    break
                errs = shape_errors(set_data, candidate)
                if not errs:
                    draft = candidate
                    used_model = model
                    break
                print(f"  {model}: {len(errs)} shape error(s), " + ("retrying with feedback" if attempt == 0 else "giving up on this model"))
                for e in errs[:6]:
                    print(f"    - {e}")
            if draft:
                break
        if not draft:
            raise SystemExit(f"{set_data['id']}: no model produced a shape-valid draft")

        order = {f"{set_data['id']}-s{n:02d}": n for n in range(1, 41)}
        draft["sentences"].sort(key=lambda s: order[s["id"]])
        set_data["sentences"] = [{
            "id": s["id"], "answer": s["answer"], "cue": s["cue"], "reserve": s["reserve"],
            "text": s["text"].strip(), "cue_phrase": s["cue_phrase"].strip(),
            "surface": {p["word"]: p["form"].strip() for p in s["surface"]},
        } for s in draft["sentences"]]
        set_data["contrasts"] = [{"answer": c["answer"], "picked": c["picked"], "line": c["line"].strip()}
                                 for c in draft["contrasts"]]
        set_data["meta"]["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        set_data["meta"]["model"] = used_model
        # scrubbed_at is deliberately NOT written: a human reads the draft and
        # stamps it (gate M12 refuses unscrubbed machine output).
        path.write_text(json.dumps(set_data, indent=2, ensure_ascii=False) + "\n")
        print(f"  {set_data['id']}: 40 sentences + 20 contrasts drafted by {used_model}; awaiting scrub")
    return 0


if __name__ == "__main__":
    sys.exit(main())
