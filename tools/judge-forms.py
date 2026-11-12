#!/usr/bin/env python3
"""
judge-forms.py - build and judge the Word Forms Vault questions.

  * forms/items.json               every question: a judged sentence from the
                                   corpus, its answer FORM, and 3-5 forms of the
                                   same word on the tiles
  * reference/forms-verdicts.json  the ensemble's verdict per question, keyed by
                                   id with a hash of text + tiles

A question reuses a sentence the uniqueness gate already passed for MEANING
("Aisha was ___, too afraid to speak." -> terrified) and asks a new question:
which version of the word fits? terrify / terrified / terrifying / terror /
terrifyingly. Grammar now decides - but meaning still can ("Aisha was
terrifying" is grammatical and wrong), so every question faces the same
cross-vendor ensemble as the word game (gpt-5.5, gpt-4.1, claude-opus-4-8):

  pass    every judge accepts exactly the intended form
  review  one judge also accepts another form (a lone dissent ships)
  hard    a judge rejects the intended form, or 2+ judges accept another
          form - never ships (tools/bake-content.js filters it out)

Run with the tools venv:  python3 tools/judge-forms.py [--only A-scared-01,...]
Only questions whose text/tiles changed are re-judged.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import anthropic
from wordfreq import zipf_frequency

ROOT = Path(__file__).resolve().parent.parent
SETS = ROOT / "sets"
FAMILIES = ROOT / "forms" / "families.json"
ITEMS = ROOT / "forms" / "items.json"
VERDICTS = ROOT / "reference" / "forms-verdicts.json"
JUDGES = [("openai", "gpt-5.5"), ("openai", "gpt-4.1"), ("anthropic", "claude-opus-4-8")]
PER_WORD = 4   # questions per word family
BATCH = 10

SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": {
    "type": "object", "properties": {
        "id": {"type": "string"},
        "labels": {"type": "array", "items": {"type": "object", "properties": {
            "form": {"type": "string"},
            "label": {"type": "string", "enum": ["fits", "awkward", "wrong"]}},
            "required": ["form", "label"], "additionalProperties": False}}},
    "required": ["id", "labels"], "additionalProperties": False}}},
    "required": ["items"], "additionalProperties": False}

SYSTEM = (
    "You are judging fill-in-the-blank items for a children's word-forms game (school years 1-7). "
    "Each item shows a sentence with one blank and several VERSIONS OF THE SAME WORD (for example "
    "terrify / terrified / terrifying / terror). In a well-made item exactly ONE version makes the "
    "sentence grammatical, natural standard written English (Australian spelling) AND gives it the "
    "meaning the sentence plainly intends. Broken items are common and finding them is your job: "
    "sometimes two versions fit, sometimes the intended one does not. Judge every candidate "
    "independently as a careful adult reader; do not defer to the intended answer. Label 'fits' "
    "when the sentence is grammatical, natural and means what it plainly intends; 'awkward' when "
    "it is grammatical but strained or changes the meaning; 'wrong' when it is ungrammatical or "
    "the meaning fails."
)


def item_hash(it: dict) -> str:
    return hashlib.sha256((it["text"] + "\n" + "|".join(sorted(it["tiles"]))).encode()).hexdigest()


def tense_rivals(ans: str, forms: list) -> set:
    """Tensed forms of the answer's verb that must not share its tiles.

    The corpus sentences pin a word's MEANING, not its tense: "Grandpa ___ the
    leaves off the steps" takes swept or sweeps equally well, and the first
    judging pass marked those hard by the hundred. The Word Forms Vault teaches
    word class (terrify / terrified / terror), so a past-tense answer never
    sits beside its -s form or another past form, and an -s answer never sits
    beside a past form. The base and -ing forms stay: a singular subject rules
    out the base form ("Mina ___ the soup": relish is wrong), and the judges
    still catch the plural-subject case ("We ___ the buns": steam fits)."""
    names = {f["form"] for f in forms}
    bases = {f["form"] for f in forms if f["pos"] == "verb"}
    s_of = {}
    for b in sorted(bases, key=len):  # longest base wins: slides <- slide, not slid + es
        for s in (b + "s", b + "es", b[:-1] + "ies"):
            if s in names and s != b:
                s_of[s] = b
    if not s_of:
        return set()
    base_forms = set(s_of.values())
    s_forms = set(s_of)
    # past: the verb's other finite forms (swept, spilt, steamed, terrified).
    # An -n participle is not a rival: drew / drawn, saw / seen, wrote /
    # written is exactly the contrast a child should practise ("I seen it").
    past = {n for n in names if n not in base_forms | s_forms and not n.endswith("ing")
            and not (n.endswith("n") and not n.endswith("ed"))
            and (n.endswith("ed") or n in bases)
            and not any(n == b + "er" or n == b + "r" for b in base_forms)}
    if ans in past:
        return s_forms | (past - {ans})
    if ans in s_forms:
        # read / cut: the base doubles as the past, so it is the rival
        return past or base_forms
    if ans in base_forms and not past:
        return s_forms  # "Dad ___ the story": read or reads
    return set()


def build_items(families: dict) -> list:
    items = []
    for path in sorted(SETS.glob("*/*.json")):
        s = json.loads(path.read_text())
        fam = families.get(s["id"], {})
        for w in s["words"]:
            forms = fam.get(w["w"])
            if not forms:
                continue
            names = [f["form"] for f in forms]
            n = 0
            for sent in s["sentences"]:
                if sent["answer"] != w["w"] or sent.get("reserve") or n >= PER_WORD:
                    continue
                ans = sent["surface"][w["w"]].lower().replace("’", "'")
                if ans not in names:
                    continue  # this sentence uses a form the family does not list
                # the answer plus the four commonest other versions: the ones a
                # child really confuses it with
                rivals = tense_rivals(ans, forms)
                others = sorted((f for f in names if f != ans and f not in rivals),
                                key=lambda f: (-zipf_frequency(f, "en"), f))[:4]
                tiles = [ans] + others
                if len(tiles) < 3:
                    continue  # three tiles is the floor (relished / relish / relishing)
                n += 1
                items.append({"id": "F:" + sent["id"], "set": s["id"], "word": w["w"], "text": sent["text"],
                              "answer": ans, "tiles": tiles,
                              "notes": {f["form"]: f["note"] for f in forms if f["form"] in tiles}})
    return items


def call_openai(model, key, user):
    body = {"model": model, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "verdicts", "schema": SCHEMA, "strict": True}}}
    if model == "gpt-4.1":
        body["temperature"] = 0
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(json.load(r)["choices"][0]["message"]["content"])


def call_anthropic(client, model, user):
    resp = client.messages.create(model=model, max_tokens=16000, system=SYSTEM, thinking={"type": "adaptive"},
                                  output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
                                  messages=[{"role": "user", "content": user}])
    return json.loads(next(b.text for b in resp.content if b.type == "text"))


def judge_batch(vendor, model, ctx, batch):
    payload = []
    for it in batch:
        tiles = it["tiles"][:]
        random.Random(model + it["id"]).shuffle(tiles)  # no position bias, stable per judge
        payload.append({"id": it["id"], "sentence": it["text"], "candidates": tiles, "intended_answer": it["answer"]})
    user = json.dumps({"instructions": "Label EVERY candidate form for every item.", "items": payload}, ensure_ascii=False)
    want = {it["id"] for it in batch}
    for attempt in range(4):
        try:
            out = call_openai(model, ctx["key"], user) if vendor == "openai" else call_anthropic(ctx["client"], model, user)
            got = {x["id"]: x for x in out["items"]}
            if want - set(got):
                raise ValueError(f"missing verdicts for {sorted(want - set(got))[:3]}")
            return got
        except (urllib.error.URLError, TimeoutError, anthropic.APIError, json.JSONDecodeError, ValueError) as e:
            body = e.read()[:200] if isinstance(e, urllib.error.HTTPError) else b""
            if b"insufficient_quota" in body:
                raise SystemExit(f"{model}: out of quota")
            if attempt == 3:
                raise
            time.sleep([5, 20, 60][attempt] * (3 if isinstance(e, urllib.error.HTTPError) and e.code == 429 else 1))


def verdict_for(item, per_judge):
    judges, hard, dissent = [], False, 0
    for model, res in per_judge:
        fits = [l["form"].lower() for l in res["labels"] if l["label"] == "fits"]
        judges.append({"model": model, "fits": fits})
        if item["answer"] not in fits:
            hard = True
        if any(f != item["answer"] for f in fits):
            dissent += 1
    v = "hard" if hard or dissent >= 2 else ("review" if dissent == 1 else "pass")
    return {"hash": item_hash(item), "verdict": v, "judges": judges}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    families = json.loads(FAMILIES.read_text())
    items = build_items(families)
    ITEMS.write_text(json.dumps(items, indent=1, ensure_ascii=False) + "\n")
    verdicts = json.loads(VERDICTS.read_text()) if VERDICTS.exists() else {}
    only = set(filter(None, args.only.split(",")))
    todo = [it for it in items if (not only or it["set"] in only)
            and verdicts.get(it["id"], {}).get("hash") != item_hash(it)]
    print(f"judge-forms: {len(items)} question(s) built, {len(todo)} to judge")
    ctx = {"key": os.environ["OPENAI_API_KEY"], "client": anthropic.Anthropic()}
    batches = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]

    def run(batch):
        res = {}
        for vendor, model in JUDGES:
            got = judge_batch(vendor, model, ctx, batch)
            for it in batch:
                res.setdefault(it["id"], []).append((model, got[it["id"]]))
        return batch, res

    done = 0
    with concurrent.futures.ThreadPoolExecutor(6) as pool:
        for fut in concurrent.futures.as_completed([pool.submit(run, b) for b in batches]):
            batch, res = fut.result()
            for it in batch:
                verdicts[it["id"]] = verdict_for(it, res[it["id"]])
            done += len(batch)
            if done % 100 < BATCH:
                VERDICTS.write_text(json.dumps(verdicts, indent=1, ensure_ascii=False) + "\n")
                print(f"  {done}/{len(todo)} judged")
    VERDICTS.write_text(json.dumps(dict(sorted(verdicts.items())), indent=1, ensure_ascii=False) + "\n")
    tally = {"pass": 0, "review": 0, "hard": 0}
    for it in items:
        v = verdicts.get(it["id"])
        if v and v["hash"] == item_hash(it):
            tally[v["verdict"]] += 1
    print(f"judge-forms: {tally['pass']} pass, {tally['review']} single-dissent, {tally['hard']} hard (hard never ships)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
