#!/usr/bin/env python3
"""
Generate the game's sound effects with ElevenLabs' text-to-sound-effects API.

  * assets/sfx/<id>.mp3   (one short clip per id below)

Run:   python3 tools/generate-sfx.py                 # generate anything missing
       python3 tools/generate-sfx.py --force         # regenerate everything
       python3 tools/generate-sfx.py --only seat,door

ELEVENLABS_API_KEY is read from the environment or ./.env (gitignored). Each
clip costs API credits; the script prints the count first. Stdlib only.

The design brief (see the spec): the satisfaction is MECHANICAL, not
celebratory. `seat` is the star click; `drop`/`relock` are deliberately soft
and dull - the relock IS the punishment, so it must never sound scary.
Celebration lives only in `door`/`fanfare`. game-ui.js plays clips through
HTMLAudioElement (works from file://) and stays fully playable when clips are
missing, so the game runs before/without this script.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

ENDPOINT = "https://api.elevenlabs.io/v1/sound-generation"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "assets", "sfx")

# id -> (prompt, duration_seconds). Matches SFX_VOL in game-ui.js.
SFX = [
    ("tap", "a single soft brass key click, very short, subtle cartoon game ui tap", 0.5),
    ("whoosh", "a quick soft swish of a small metal plate flying through the air, short", 0.6),
    ("seat", "one heavy little brass pin clunking home into a lock with a crisp "
             "satisfying mechanical click and a faint metallic ring", 1.0),
    ("drop", "a soft dull thud of a small brass plate dropping onto felt, gentle, "
             "muted, not scary", 0.8),
    ("relock", "several small metal lock pins springing back out one after another "
               "with a heavy dull mechanical thunk, firm but gentle, not scary", 1.2),
    ("door", "a massive bank vault door unlatching with a deep clunk then slowly "
             "swinging open with a low resonant creak, satisfying", 2.2),
    ("coin", "a bright cartoon coin pickup ka-ching chime, crisp and short", 1.2),
    ("chime", "a warm magical glass chime arpeggio, gentle and wondrous, short", 1.6),
    ("fanfare", "a short triumphant playful brass fanfare for a level up in a kids "
                "game, cheerful and ascending", 2.0),
    ("page", "a soft paper note sliding and settling, short and quiet", 0.6),
]


def load_key():
    key = os.environ.get("ELEVENLABS_API_KEY")
    if key:
        return key.strip()
    env_path = os.path.join(ROOT, ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("ELEVENLABS_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def request(prompt, seconds, key):
    body = json.dumps({
        "text": prompt,
        "duration_seconds": seconds,
        "prompt_influence": 0.45,
    }).encode()
    req = urllib.request.Request(
        ENDPOINT, data=body,
        headers={"xi-api-key": key, "Content-Type": "application/json",
                 "Accept": "audio/mpeg"},
    )
    with urllib.request.urlopen(req, timeout=240) as resp:
        data = resp.read()
    if data[:3] != b"ID3" and data[:2] != b"\xff\xfb" and data[:2] != b"\xff\xf3":
        # not an MP3 frame/ID3 header: the API returned JSON (an error), surface it.
        raise RuntimeError("unexpected (non-mp3) response: " + data[:200].decode(errors="replace"))
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", default="", help="comma-separated ids")
    args = ap.parse_args()

    key = load_key()
    if not key:
        sys.exit("No ELEVENLABS_API_KEY (set it in the environment or ./.env).")
    only = set(filter(None, args.only.split(",")))
    os.makedirs(OUT, exist_ok=True)

    todo = []
    for cid, prompt, seconds in SFX:
        if only and cid not in only:
            continue
        path = os.path.join(OUT, cid + ".mp3")
        if os.path.exists(path) and not args.force:
            continue
        todo.append((cid, prompt, seconds, path))

    if not todo:
        print("Nothing to generate (all present).")
        return
    print("Generating %d sound(s) with ElevenLabs (this costs credits)." % len(todo))

    made = 0
    for cid, prompt, seconds, path in todo:
        last_err = None
        for attempt in range(3):
            try:
                mp3 = request(prompt, seconds, key)
                with open(path, "wb") as f:
                    f.write(mp3)
                made += 1
                print("  wrote %s (%d bytes)" % (os.path.relpath(path, ROOT), len(mp3)))
                last_err = None
                break
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:300]
                last_err = "HTTP %s %s" % (e.code, detail)
                if e.code in (400, 401, 403):
                    sys.exit("API error for %s: %s" % (cid, last_err))
                time.sleep(2)
            except Exception as e:  # noqa: BLE001 - network reset etc., retry
                last_err = str(e)
                time.sleep(2)
        if last_err:
            print("  FAILED %s: %s" % (cid, last_err), file=sys.stderr)
    print("Done. %d sound(s) written." % made)


if __name__ == "__main__":
    main()
