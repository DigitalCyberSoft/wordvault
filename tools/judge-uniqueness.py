#!/usr/bin/env python3
"""
judge-uniqueness.py - gate G9, the spec-8.3 uniqueness check. The one gate that
protects the game's fairness: a sentence two candidates fit punishes a correct
answer, and a sentence whose intended answer does not fit (or fits under the
wrong sense) is worse. Run: python3 tools/judge-uniqueness.py

Every sentence in every set is judged by a cross-vendor ensemble of three
models - two OpenAI (gpt-5.5, gpt-4.1) plus Claude (claude-opus-4-8) - so a
single vendor's blind spot can't pass a broken item. Each judge sees the
sentence with the blank and ALL FIVE surface forms exactly as the tiles would
show them (shuffled per judge against position bias), labels every candidate
fits/awkward/wrong, and answers whether the intended word, as used here,
matches its pinned gloss.

Verdicts:
  pass   - every judge labels exactly the intended answer as "fits" AND
           confirms the sense match
  review - some judge thinks a second candidate fits (two-fit suspect:
           sharpen the cue or kill the sentence; queued in REVIEW.md by
           tools/validate-sets.js)
  hard   - some judge rejects the intended answer or its sense (the game
           would punish a correct answer; the corpus must not bake)

Verdicts persist in reference/uniqueness/<set-id>.json keyed by a sha256 of the
sentence text + surface table, so editing a sentence automatically invalidates
its verdict (gate M14 in tools/validate-sets.js) and re-running this script
re-judges only what changed. FORCE=1 re-judges everything.
"""
import hashlib
import json
import os
import random
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import anthropic

ROOT = Path(__file__).resolve().parent.parent
SETS = ROOT / "sets"
OUT = ROOT / "reference" / "uniqueness"

# Cross-vendor ensemble. OpenAI ids verified against this key's /v1/models.
JUDGES = [
    ("openai", "gpt-5.5"),
    ("openai", "gpt-4.1"),
    ("anthropic", "claude-opus-4-8"),
]
BATCH = 10

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "labels": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "word": {"type": "string"},
                                "label": {"type": "string", "enum": ["fits", "awkward", "wrong"]},
                            },
                            "required": ["word", "label"],
                            "additionalProperties": False,
                        },
                    },
                    "sense_match": {"type": "boolean"},
                },
                "required": ["id", "labels", "sense_match"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}

SYSTEM = (
    "You are judging fill-in-the-blank items for a children's vocabulary game "
    "(ages 8-12). Each item shows a sentence with one blank and five candidate "
    "words, inflected to fit the frame grammatically. In a well-made item, "
    "exactly ONE candidate truly fits the meaning of the sentence; the others "
    "are semantically wrong for it. Broken items are common and finding them "
    "is your job: sometimes two candidates fit, sometimes the intended answer "
    "does not fit at all, and sometimes it fits only under a different sense "
    "of the word than the definition given. Judge each candidate on meaning, "
    "independently, as a careful adult reader of standard written English "
    "would; do not defer to the intended answer. Label 'fits' when the "
    "sentence reads naturally and the meaning is right; 'awkward' when it is "
    "grammatical but semantically strained; 'wrong' when the meaning fails. "
    "Answer sense_match=true only when the intended answer, as used in this "
    "sentence, matches the given definition exactly."
)


def load_env_key(name: str) -> str:
    if os.environ.get(name):
        return os.environ[name]
    env = ROOT / ".env"  # pizzashop convention; gitignored
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip()
    raise SystemExit(f"{name} not set")


def sentence_hash(set_data: dict, s: dict) -> str:
    words = [w["w"] for w in set_data["words"]]
    payload = s["text"] + "\n" + "|".join(s["surface"][w] for w in words)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def batch_prompt(set_data: dict, sentences: list[dict], judge_model: str) -> str:
    glosses = {w["w"]: w["gloss"] for w in set_data["words"]}
    items = []
    for s in sentences:
        rng = random.Random(hashlib.sha256((judge_model + s["id"]).encode()).digest())
        candidates = [{"word": w, "as_shown": s["surface"][w]} for w in s["surface"]]
        rng.shuffle(candidates)
        items.append({
            "id": s["id"],
            "sentence": s["text"],
            "candidates": candidates,
            "intended_answer": s["answer"],
            "intended_definition": glosses[s["answer"]],
        })
    return json.dumps({
        "instructions": "For every item: label EVERY candidate (use its 'word' key), then judge sense_match for the intended answer against its definition.",
        "items": items,
    }, ensure_ascii=False)


def judge_openai(model: str, key: str, system: str, user: str) -> dict:
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "verdicts", "schema": SCHEMA, "strict": True}},
    }
    if model == "gpt-4.1":
        body["temperature"] = 0
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        out = json.load(r)
    return json.loads(out["choices"][0]["message"]["content"])


def judge_anthropic(client: anthropic.Anthropic, model: str, system: str, user: str) -> dict:
    resp = client.messages.create(
        model=model,
        max_tokens=16000,
        system=system,
        thinking={"type": "adaptive"},
        output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": user}],
    )
    text = next(b.text for b in resp.content if b.type == "text")
    return json.loads(text)


def run_judge(vendor: str, model: str, ctx: dict, system: str, user: str) -> dict:
    if vendor == "openai":
        return judge_openai(model, ctx["openai_key"], system, user)
    return judge_anthropic(ctx["anthropic"], model, system, user)


def main() -> int:
    force = os.environ.get("FORCE") == "1"
    only = set(filter(None, os.environ.get("SETS_ONLY", "").split(",")))
    ctx = {
        "openai_key": load_env_key("OPENAI_API_KEY"),
        "anthropic": anthropic.Anthropic(api_key=load_env_key("ANTHROPIC_API_KEY")),
    }
    OUT.mkdir(parents=True, exist_ok=True)

    totals = {"pass": 0, "review": 0, "hard": 0, "skipped": 0}
    for path in sorted(SETS.glob("*/*.json")):
        set_data = json.loads(path.read_text())
        set_id = set_data["id"]
        if only and set_id not in only:
            continue
        out_path = OUT / f"{set_id}.json"
        existing = json.loads(out_path.read_text())["sentences"] if out_path.exists() else {}

        pending = []
        for s in set_data["sentences"]:
            h = sentence_hash(set_data, s)
            old = existing.get(s["id"])
            if not force and old and old.get("text_sha256") == h:
                totals["skipped"] += 1
                continue
            pending.append(s)
        if not pending:
            continue
        print(f"{set_id}: judging {len(pending)} sentence(s)")

        for i in range(0, len(pending), BATCH):
            chunk = pending[i:i + BATCH]
            by_sentence: dict[str, list] = {s["id"]: [] for s in chunk}
            for vendor, model in JUDGES:
                user = batch_prompt(set_data, chunk, model)
                result = run_judge(vendor, model, ctx, SYSTEM, user)
                got = {item["id"]: item for item in result["items"]}
                missing = [s["id"] for s in chunk if s["id"] not in got]
                if missing:
                    raise SystemExit(f"{model} returned no verdict for {missing}")
                for s in chunk:
                    item = got[s["id"]]
                    # Judges sometimes answer with the surface form ("marched")
                    # instead of the lemma key ("march"); normalise both to the
                    # lemma so aggregation compares like with like. Unknown
                    # words are kept raw so they surface as a review, never
                    # silently dropped.
                    lemmas = {w["w"] for w in set_data["words"]}
                    surface_to_lemma = {s["surface"][w].lower(): w for w in s["surface"]}
                    def norm(word: str) -> str:
                        word = word.strip().lower()
                        if word in lemmas:
                            return word
                        return surface_to_lemma.get(word, word)
                    fits = sorted({norm(l["word"]) for l in item["labels"] if l["label"] == "fits"})
                    by_sentence[s["id"]].append(
                        {"model": model, "fits": fits, "sense_match": bool(item["sense_match"])})
                print(f"  {model}: batch {i // BATCH + 1} done")

            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            for s in chunk:
                judges = by_sentence[s["id"]]
                answer = s["answer"]
                if any(answer not in j["fits"] or not j["sense_match"] for j in judges):
                    verdict = "hard"
                elif any(len(j["fits"]) > 1 for j in judges):
                    verdict = "review"
                else:
                    verdict = "pass"
                totals[verdict] += 1
                existing[s["id"]] = {
                    "text_sha256": sentence_hash(set_data, s),
                    "verdict": verdict,
                    "judges": judges,
                    "judged_at": now,
                }
                if verdict != "pass":
                    detail = "; ".join(f"{j['model']}: fits={j['fits']} sense={j['sense_match']}" for j in judges)
                    print(f"  {verdict.upper()} {s['id']} ({answer}): {detail}")

            # write after every batch so an interrupted run never loses verdicts
            out_path.write_text(json.dumps(
                {"set_id": set_id, "sentences": existing}, indent=2, ensure_ascii=False) + "\n")

    print(f"judge-uniqueness: {totals['pass']} pass, {totals['review']} review, "
          f"{totals['hard']} hard, {totals['skipped']} unchanged")
    return 1 if totals["hard"] else 0


if __name__ == "__main__":
    sys.exit(main())
