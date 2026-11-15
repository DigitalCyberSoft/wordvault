#!/usr/bin/env python3
"""
qwen-voice-worker.py - render words with a local Qwen3-TTS checkpoint.

Runs inside the qwen3-tts venv (torch + qwen_tts), which the content tools
venv does not have; tools/generate-voice.py --engine qwen calls it as a
subprocess and does the trimming, levelling and transcription check itself.

  design:  the voice comes from a description (VoiceDesign checkpoint)
           -> used once to make the character's reference clip
  clone:   copy the reference clip's voice (Base checkpoint) for every word,
           so all 551 clips are the same person

Input is a JSON job on stdin:
  {"mode": "clone", "ref_audio": "...wav", "ref_text": "...",
   "items": [{"text": "patted", "out": "/tmp/x/patted.wav", "seed": 7}, ...]}
  {"mode": "design", "instruct": "...", "items": [...]}
One line per item is printed to stdout: {"out": ..., "ok": true, "secs": 0.8}
"""
import contextlib
import json
import os
import sys

QWEN_HOME = os.environ["QWEN3_TTS_HOME"]  # set by tools/generate-voice.py
CHECKPOINTS = {"design": "Qwen3-TTS-12Hz-1.7B-VoiceDesign", "clone": "Qwen3-TTS-12Hz-1.7B-Base"}


@contextlib.contextmanager
def quiet_fds():
    # qwen_tts prints import banners to stdout, which carries our results
    sys.stdout.flush(); sys.stderr.flush()
    saved, devnull = os.dup(1), os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, 1)
    try:
        yield
    finally:
        sys.stdout.flush(); os.dup2(saved, 1); os.close(saved); os.close(devnull)


def main() -> int:
    job = json.load(sys.stdin)
    mode = job["mode"]
    with quiet_fds():
        import numpy as np
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel
        model = Qwen3TTSModel.from_pretrained(os.path.join(QWEN_HOME, "models", CHECKPOINTS[mode]),
                                              device_map="cuda:0", dtype=torch.bfloat16)
        prompt = None
        if mode == "clone":
            prompt = model.create_voice_clone_prompt(ref_audio=job["ref_audio"], ref_text=job.get("ref_text"),
                                                     x_vector_only_mode=not job.get("ref_text"))
    sampling = job.get("sampling", {})
    for it in job["items"]:
        try:
            with quiet_fds():
                if "seed" in it:
                    torch.manual_seed(it["seed"])
                if mode == "design":
                    wavs, sr = model.generate_voice_design(text=it["text"], instruct=job["instruct"],
                                                           language="English", **sampling)
                else:
                    wavs, sr = model.generate_voice_clone(text=it["text"], language="English",
                                                          voice_clone_prompt=prompt, **sampling)
                audio = np.asarray(wavs[0], dtype=np.float32)
                sf.write(it["out"], audio, sr)
            print(json.dumps({"out": it["out"], "ok": True, "secs": round(len(audio) / sr, 2)}), flush=True)
        except Exception as e:  # noqa: BLE001 - report and keep going
            print(json.dumps({"out": it["out"], "ok": False, "error": str(e)[:200]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
