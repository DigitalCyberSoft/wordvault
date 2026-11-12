#!/usr/bin/env python3
"""
generate-voice.py - record every Spelling Vault word as a small offline clip.

  * assets/voice/<slug>.mp3      one clip per spelling target (the answer's
                                 surface form in its sentence: "clapped")
  * reference/voice-check.json   what a speech-to-text model heard in each clip

The Spelling Vault is dictation: the child HEARS the word and spells it, with
the sentence on screen for meaning. The game promises no network at play time,
so voices are generated here, at build time, and ship as files; the runtime
only plays assets/voice/<slug>.mp3 (Core.voiceSlug gives the same slug).

Voice: OpenAI gpt-4o-mini-tts with an Australian-teacher instruction. Because
no human ear is in this loop, every clip is VERIFIED: gpt-4o-transcribe
transcribes it and the result must match the word (letters only). Mismatches
are listed and exit non-zero, except known homophones recorded in
HOMOPHONES_OK (the sentence on screen tells the child which spelling).

Run with the tools venv (nltk cmudict enables the homophone check):
       python3 tools/generate-voice.py              # generate missing + verify all unverified
       python3 tools/generate-voice.py --force      # regenerate everything
       python3 tools/generate-voice.py --only clapped,read
       python3 tools/generate-voice.py --verify     # re-transcribe every clip

OPENAI_API_KEY comes from the environment. Needs ffmpeg. Stdlib only.
"""
import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETS = ROOT / "sets"
OUT = ROOT / "assets" / "voice"
CHECK = ROOT / "reference" / "voice-check.json"

TTS_MODEL = "gpt-4o-mini-tts"
TTS_VOICE = "coral"
INSTRUCTIONS = (
    "You are a warm, clear Australian primary-school teacher giving a spelling test. "
    "Say the single word exactly once, at a calm, slightly slow pace, with natural "
    "Australian English pronunciation. Say nothing else and do not spell it out."
)
# Words whose middle t/d Australian speech softens into a flap ("patted" can
# sound like "padded"): a teacher giving a spelling test says them carefully.
CAREFUL = {
    "patted": "Say it carefully, the way a teacher does in a spelling test, with a crisp, clear 't' in the middle: pat-ted.",
    "waded": "Say it carefully, the way a teacher does in a spelling test, with a clear 'd' in the middle: way-ded.",
}
STT_MODEL = "gpt-4o-transcribe"
# word -> spellings a transcriber may legitimately hear instead (true homophones)
HOMOPHONES_OK = {
    "read": ["red", "reed"],
    "their": ["there", "theyre"], "there": ["their", "theyre"], "theyre": ["their", "there"],
    "then": ["than"], "than": ["then"],
    "cowered": ["coward"], "bawling": ["balling"], "lends": ["lens"],
}


def slug(word: str) -> str:
    return re.sub(r"[^a-z]+", "_", word.lower()).strip("_")


def norm(word: str) -> str:
    return word.strip().lower().replace("’", "'").replace("‘", "'").replace("`", "'")


def letters(word: str) -> str:
    return re.sub(r"[^a-z]", "", word.lower())


def targets() -> list:
    out = set()
    for path in sorted(SETS.glob("*/*.json")):
        data = json.loads(path.read_text())
        for s in data["sentences"]:
            t = s["surface"][s["answer"]]
            if not re.search(r"\s", t):
                out.add(norm(t))
    return sorted(out)


def api(url: str, body: bytes, ctype: str, key: str, timeout=90) -> bytes:
    for attempt in range(5):
        req = urllib.request.Request(url, data=body, headers={
            "Authorization": "Bearer " + key, "Content-Type": ctype})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            msg = e.read()[:300]
            if b"insufficient_quota" in msg:
                raise SystemExit("OpenAI account is out of quota: " + msg.decode("utf8", "replace"))
            if e.code in (429, 500, 502, 503) and attempt < 4:
                time.sleep([5, 15, 45, 90][attempt]); continue
            raise RuntimeError(f"HTTP {e.code}: {msg!r}")
        except (urllib.error.URLError, TimeoutError):
            if attempt < 4:
                time.sleep([5, 15, 45, 90][attempt]); continue
            raise


def generate(word: str, key: str) -> None:
    wav = api("https://api.openai.com/v1/audio/speech", json.dumps({
        "model": TTS_MODEL, "voice": TTS_VOICE, "input": word,
        "instructions": INSTRUCTIONS + (" " + CAREFUL[word] if word in CAREFUL else ""),
        "response_format": "wav"}).encode(), "application/json", key)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav); tmp = f.name
    dest = OUT / (slug(word) + ".mp3")
    # trim long leading/trailing silence so the word lands promptly, but keep a
    # 0.1 s cushion each side: a tight -50 dB trim clipped soft onsets and
    # final -d ("brisk" played as "risk", "tumbled" as "tumble").
    # Mono 24 kHz 48 kbps: a few KB per word.
    trim = "silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.1"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-af",
                    f"{trim},areverse,{trim},areverse",
                    "-ac", "1", "-ar", "24000", "-b:a", "48k", str(dest)], check=True)
    os.unlink(tmp)


def transcribe(word: str, key: str) -> str:
    path = OUT / (slug(word) + ".mp3")
    boundary = uuid.uuid4().hex
    parts = []
    for name, val in [("model", STT_MODEL), ("language", "en"),
                      ("prompt", "One English word, spoken alone by a teacher in a spelling test.")]:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{val}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="w.mp3"\r\n'
                 'Content-Type: audio/mpeg\r\n\r\n'.encode() + path.read_bytes() + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    raw = api("https://api.openai.com/v1/audio/transcriptions", b"".join(parts),
              "multipart/form-data; boundary=" + boundary, key)
    return json.loads(raw).get("text", "")


_CMU = None


def cmu():
    """CMU pronouncing dictionary via nltk when available (the tools venv); a
    clip heard as a true homophone (coarse/course, gait/gate) is a pass,
    because the sentence on screen tells the child which spelling."""
    global _CMU
    if _CMU is None:
        try:
            from nltk.corpus import cmudict
            _CMU = cmudict.dict()
        except Exception:  # noqa: BLE001 - stdlib-only fallback
            _CMU = {}
    return _CMU


def us(word: str) -> str:
    # transcribers write US spelling; the corpus is Australian
    w = re.sub(r"our(s|ed|ing)?$", r"or\1", word)
    w = re.sub(r"is(e|es|ed|ing|ation)$", r"iz\1", w)
    return w.replace("sceptic", "skeptic")


def sounds_same(a: str, b: str) -> bool:
    d = cmu()
    pa, pb = d.get(a) or d.get(us(a)), d.get(b) or d.get(us(b))
    return bool(pa and pb and any(x == y for x in pa for y in pb))


def heard_ok(word: str, heard: str) -> bool:
    h, w = letters(heard), letters(word)
    return (h == w or us(h) == us(w) or h == us(w) or h in HOMOPHONES_OK.get(w, [])
            or sounds_same(w, h))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--verify", action="store_true", help="re-transcribe every clip")
    ap.add_argument("--only", default="")
    ap.add_argument("--retry", type=int, default=3, help="re-record a misheard clip up to N times")
    args = ap.parse_args()
    key = os.environ.get("OPENAI_API_KEY") or sys.exit("OPENAI_API_KEY not set")
    OUT.mkdir(parents=True, exist_ok=True)
    words = targets()
    if args.only:
        want = {norm(w) for w in args.only.split(",")}
        words = [w for w in words if w in want]
    check = json.loads(CHECK.read_text()) if CHECK.exists() else {}

    todo = [w for w in words if args.force or not (OUT / (slug(w) + ".mp3")).exists()]
    print(f"generate-voice: {len(words)} target word(s), {len(todo)} to record")
    with concurrent.futures.ThreadPoolExecutor(6) as pool:
        for w, err in zip(todo, pool.map(lambda w: _safe(generate, w, key), todo)):
            if err: print(f"  FAILED {w}: {err}")
            else: check.pop(w, None)  # a fresh clip needs a fresh check

    verify = [w for w in words if (OUT / (slug(w) + ".mp3")).exists() and (args.verify or w not in check)]
    print(f"  verifying {len(verify)} clip(s) with {STT_MODEL}")
    with concurrent.futures.ThreadPoolExecutor(6) as pool:
        for w, res in zip(verify, pool.map(lambda w: _safe(transcribe, w, key, ret=True), verify)):
            heard = res if isinstance(res, str) else ""
            check[w] = {"heard": heard.strip(), "ok": heard_ok(w, heard)}
    # TTS samples vary: a misheard clip is usually fixed by recording it again
    for attempt in range(args.retry):
        again = [w for w in words if w in check and not check[w]["ok"]]
        if not again:
            break
        print(f"  retry {attempt + 1}: re-recording {len(again)} misheard clip(s)")
        with concurrent.futures.ThreadPoolExecutor(6) as pool:
            list(pool.map(lambda w: _safe(generate, w, key), again))
            for w, res in zip(again, pool.map(lambda w: _safe(transcribe, w, key, ret=True), again)):
                heard = res if isinstance(res, str) else ""
                check[w] = {"heard": heard.strip(), "ok": heard_ok(w, heard)}
    CHECK.parent.mkdir(parents=True, exist_ok=True)
    CHECK.write_text(json.dumps(dict(sorted(check.items())), indent=1, ensure_ascii=False) + "\n")

    missing = [w for w in words if not (OUT / (slug(w) + ".mp3")).exists()]
    bad = [w for w in words if w in check and not check[w]["ok"]]
    for w in bad: print(f"  MISHEARD {w!r} -> {check[w]['heard']!r}")
    for w in missing: print(f"  MISSING {w}")
    size = sum(p.stat().st_size for p in OUT.glob("*.mp3"))
    print(f"generate-voice: {len(words) - len(missing)} clip(s), {size // 1024} KB, {len(bad)} misheard, {len(missing)} missing")
    return 1 if (bad or missing) else 0


def _safe(fn, w, key, ret=False):
    try:
        r = fn(w, key)
        return r if ret else None
    except Exception as e:  # noqa: BLE001 - report and keep going
        return ("" if ret else str(e))


if __name__ == "__main__":
    sys.exit(main())
