#!/usr/bin/env python3
"""
grade-words.py - attach an Australian school year level (1-7) to every corpus
word. Run: python3 tools/grade-words.py

Each word is graded IN ITS PINNED SENSE (the gloss is shown to the graders:
'miss' as longing grades far easier than its rarest senses would suggest) by
a cross-vendor pair - gpt-5.5 and claude-opus-4-8 - against Australian year
levels: Year 1 (~age 6-7) through Year 7 (~age 12-13).

Consensus rule:
  equal          -> that year
  differ by 1    -> the HIGHER year (conservative: calling a hard word easy
                    misleads parents; the reverse is harmless)
  differ by >=2  -> unresolved; must be adjudicated by a human entry in
                    reference/grade-overrides.json ({"<set-id>:<word>": year})

Grades write into words[].grade in the set files. Words already graded are
skipped unless FORCE=1. If any word is left unresolved the script exits
non-zero after writing what it could; gate M18 in tools/validate-sets.js
independently refuses to bake ungraded words, so a partial run cannot ship.
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

import anthropic

ROOT = Path(__file__).resolve().parent.parent
SETS = ROOT / "sets"
OVERRIDES = ROOT / "reference" / "grade-overrides.json"

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                    # min/max unsupported by the Anthropic structured-output
                    # validator on integers; range is enforced in code below
                    "year": {"type": "integer"},
                },
                "required": ["key", "year"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}

SYSTEM = (
    "You are a primary-school literacy specialist familiar with the Australian "
    "Curriculum (English, Foundation to Year 7) and with the vocabulary found "
    "in Australian school readers and NAPLAN materials. For each word, judged "
    "IN THE SENSE GIVEN BY ITS DEFINITION, answer the school year (1 to 7) at "
    "which a typical Australian student would read and understand it in "
    "context: Year 1 is ages 6-7, Year 7 is ages 12-13. Use the whole range; "
    "everyday words belong in the early years. If a word is genuinely beyond "
    "Year 7, still answer 7. Answer for every item."
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


def grade_openai(key: str, user: str) -> dict:
    body = {
        "model": os.environ.get("OPENAI_MODEL", "gpt-5.5"),
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "grades", "schema": SCHEMA, "strict": True}},
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        out = json.load(r)
    return json.loads(out["choices"][0]["message"]["content"])


def grade_anthropic(client: anthropic.Anthropic, user: str) -> dict:
    resp = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=16000,
        system=SYSTEM,
        thinking={"type": "adaptive"},
        output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": user}],
    )
    text = next(b.text for b in resp.content if b.type == "text")
    return json.loads(text)


def main() -> int:
    force = os.environ.get("FORCE") == "1"
    overrides = json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {}

    files, todo = [], []
    for path in sorted(SETS.glob("*/*.json")):
        data = json.loads(path.read_text())
        files.append((path, data))
        for w in data["words"]:
            if force or not isinstance(w.get("grade"), int):
                todo.append({"key": f"{data['id']}:{w['w']}", "word": w["w"],
                             "definition": w["gloss"], "theme": data["theme"]})
    if not todo:
        print("grade-words: nothing to grade")
        return 0

    user = json.dumps({"instructions": "Grade every item.", "items": todo}, ensure_ascii=False)
    openai_key = load_env_key("OPENAI_API_KEY")
    client = anthropic.Anthropic(api_key=load_env_key("ANTHROPIC_API_KEY"))
    def in_range(items):
        return {i["key"]: i["year"] for i in items if 1 <= i["year"] <= 7}

    a = in_range(grade_openai(openai_key, user)["items"])
    b = in_range(grade_anthropic(client, user)["items"])

    grades, unresolved = {}, []
    for item in todo:
        k = item["key"]
        if k in overrides:
            grades[k] = int(overrides[k])
            continue
        ga, gb = a.get(k), b.get(k)
        if ga is None or gb is None:
            unresolved.append((k, ga, gb, "missing from a grader"))
        elif abs(ga - gb) <= 1:
            grades[k] = max(ga, gb)
        else:
            unresolved.append((k, ga, gb, "graders disagree by 2+"))

    written = 0
    for path, data in files:
        changed = False
        for w in data["words"]:
            k = f"{data['id']}:{w['w']}"
            if k in grades and w.get("grade") != grades[k]:
                w["grade"] = grades[k]
                changed = True
                written += 1
        if changed:
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    print(f"grade-words: {written} grade(s) written across {len(files)} sets")
    for k, ga, gb, why in unresolved:
        print(f"  UNRESOLVED {k}: gpt-5.5={ga} claude={gb} ({why}) - add to {OVERRIDES.name}")
    if unresolved:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
