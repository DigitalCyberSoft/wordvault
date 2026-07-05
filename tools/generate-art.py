#!/usr/bin/env python3
"""
Generate the game's raster art with OpenAI's gpt-image-1 (dev-time only; the
shipped game never talks to a network). Mirrors pizzashop's generate-art.py.

  assets/backdrop/wall.png            warm plaster wall behind the vault
  assets/backdrop/expedition.png      cosmetic backdrop (Expedition Shelf)
  assets/backdrop/night.png           cosmetic backdrop (Shelf of Wonders)
  assets/logo/logo.png                title-screen wordmark art
  assets/logo/logo-mark.svg           (hand-made, not generated - HUD icon)
  assets/collectibles/<id>.png        one per Curio Cabinet item (ids from
                                      game-core.js SHELVES - keep in sync)

Run:  python3 tools/generate-art.py             # generate anything missing
      python3 tools/generate-art.py --only logo,compass --force

OPENAI_API_KEY from the environment or ./.env. Every image costs credits; the
script prints the count first. The game is fully playable without any of these
(emoji stand in for collectibles, CSS for backdrops), so run it when ready.
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

STYLE = ("flat chunky children's game art, warm high-contrast palette, thick "
         "clean outlines, no text, no watermark, single centred subject")

# id -> (relative path, prompt, size)
ART = {}
ART["wall"] = ("assets/backdrop/wall.png",
               "warm terracotta plaster interior wall, soft ceiling light pooling in the centre, "
               "subtle skirting board, completely bare empty wall with nothing mounted on it, "
               "no vault, no door, no furniture, no letters, no signs, no writing, " + STYLE, "1536x1024")
ART["expedition"] = ("assets/backdrop/expedition.png",
                     "sun-bleached explorer's study wall with faded map outlines and warm sand tones, "
                     + STYLE, "1536x1024")
ART["night"] = ("assets/backdrop/night.png",
                "deep blue stone room at night, moonlight beaming from one high arched window, "
                "stars visible through the glass, cosy not scary, otherwise completely bare walls, "
                "no vault, no door, no desk, no furniture, no letters, no signs, no writing, "
                + STYLE, "1536x1024")
ART["logo"] = ("assets/logo/logo.png",
               "game logo art: a round steel vault door with brass dial slightly open with warm golden "
               "light spilling out, " + STYLE, "1024x1024")

COLLECTIBLES = {
    "compass": "an antique brass pocket compass",
    "map": "a folded treasure map with a dotted trail",
    "spyglass": "a brass sailor's spyglass",
    "lantern": "a little brass storm lantern with a warm flame",
    "boot": "a sturdy leather explorer's boot",
    "fossil": "an ammonite fossil in stone",
    "scarab": "a turquoise and gold egyptian scarab",
    "crown": "a small old golden crown with one red gem",
    "amphora": "a greek clay amphora with simple figures",
    "moonrock": "a grey glittering moon rock on a tiny stand",
    "gear": "a bronze clockwork gear",
    "spring": "a coiled copper spring",
    "lens": "a jeweller's magnifying lens with brass rim",
    "key": "an ornate iron skeleton key",
    "bell": "a brass counter bell",
    "dragon": "a tiny friendly green dragon figurine",
    "gargoyle": "a small smiling stone gargoyle",
    "feather": "a single golden feather",
    "gem": "a brilliant cut blue gem",
    "orb": "a swirling purple fortune-teller's orb on a stand",
}
for cid, desc in COLLECTIBLES.items():
    ART[cid] = ("assets/collectibles/%s.png" % cid,
                desc + ", museum curio on transparent background, " + STYLE, "1024x1024")


def load_key():
    key = os.environ.get("OPENAI_API_KEY")
    if key:
        return key.strip()
    env_path = os.path.join(ROOT, ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.strip().startswith("OPENAI_API_KEY="):
                    return line.strip().split("=", 1)[1].strip().strip('"')
    return None


def request(prompt, size, key):
    body = json.dumps({"model": "gpt-image-1", "prompt": prompt, "size": size,
                       "quality": "medium", "background": "transparent" if size == "1024x1024" else "auto"}).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations", data=body,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        out = json.load(resp)
    return base64.b64decode(out["data"][0]["b64_json"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    key = load_key()
    if not key:
        sys.exit("No OPENAI_API_KEY (environment or ./.env).")
    only = set(filter(None, args.only.split(",")))

    todo = []
    for cid, (rel, prompt, size) in ART.items():
        if only and cid not in only:
            continue
        path = os.path.join(ROOT, rel)
        if os.path.exists(path) and not args.force:
            continue
        todo.append((cid, path, prompt, size))
    if not todo:
        print("Nothing to generate (all present).")
        return
    print("Generating %d image(s) with gpt-image-1 (this costs credits)." % len(todo))

    failed = 0
    for cid, path, prompt, size in todo:
        last_err = None
        for attempt in range(3):
            try:
                png = request(prompt, size, key)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as f:
                    f.write(png)
                print("  wrote %s (%d KB)" % (os.path.relpath(path, ROOT), len(png) // 1024))
                last_err = None
                break
            except urllib.error.HTTPError as e:
                last_err = "HTTP %s %s" % (e.code, e.read().decode(errors="replace")[:200])
                if e.code in (400, 401, 403):
                    sys.exit("API error for %s: %s" % (cid, last_err))
                time.sleep(3)
            except Exception as e:  # noqa: BLE001 - network hiccup, retry
                last_err = str(e)
                time.sleep(3)
        if last_err:
            failed += 1
            print("  FAILED %s: %s" % (cid, last_err), file=sys.stderr)
    if failed:
        sys.exit("%d image(s) failed" % failed)


if __name__ == "__main__":
    main()
