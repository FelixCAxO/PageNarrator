"""Offline acoustic, CLAP and ASR diagnostics for installed-browser settings recordings."""
# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path

import numpy as np
import parselmouth
import torch
from faster_whisper import WhisperModel
from transformers import ClapModel, ClapProcessor

MODEL = "laion/clap-htsat-unfused"
REVISION = "8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a"
PROMPTS = ["A woman is speaking.", "A man is speaking.", "A child is speaking.",
           "A teenager is speaking.", "A young adult is speaking.", "A middle-aged person is speaking.",
           "An elderly person is speaking.", "A person is whispering.", "A person is speaking normally."]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--cache", default=".cache/settings-oracles")
    parser.add_argument("--asr-model", required=True, type=Path)
    args = parser.parse_args()
    sources = list(args.directory.rglob("settings.json"))
    if len(sources) != 1:
        raise ValueError("Select one complete settings-matrix recording directory.")
    root = sources[0].parent
    cases = json.loads(sources[0].read_text(encoding="utf-8"))
    if {case["id"] for case in cases} != {"baseline", "male", "whisper", "variation-4", "variation-10", "swedish", "playback-slow", "playback-fast"} or len(cases) != 8:
        raise ValueError("The complete eight-case browser matrix is required.")
    if not all((args.asr_model / name).is_file() for name in ["model.bin", "config.json", "tokenizer.json"]):
        raise ValueError("An explicit, complete offline faster-whisper snapshot is required.")
    asr_files = sorted(path for path in args.asr_model.iterdir() if path.is_file())
    pins = [{"name": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in asr_files]
    torch.set_num_threads(2)
    options = dict(revision=REVISION, cache_dir=args.cache, local_files_only=True)
    clap = ClapModel.from_pretrained(MODEL, **options).eval()
    processor = ClapProcessor.from_pretrained(MODEL, **options)
    asr = WhisperModel(str(args.asr_model), device="cpu", compute_type="int8", cpu_threads=2, local_files_only=True)
    spec = importlib.util.spec_from_file_location("speech", Path(__file__).with_name("verify-omnivoice-speech.py"))
    speech = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(speech)
    results = []
    report = {"clap": {"model": MODEL, "revision": REVISION}, "asrFiles": pins,
              "versions": {name: importlib.metadata.version(name) for name in ["praat-parselmouth", "transformers", "faster-whisper", "torch"]},
              "listeningPassed": False,
              "scope": "Independent diagnostics; semantic scores do not prove perceived age, pronunciation or naturalness.", "cases": results}
    for case in cases:
        path = root / case["wav"]
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != case["sha256"]:
            raise ValueError(f"Recording hash mismatch: {path}")
        sound = parselmouth.Sound(str(path))
        if sound.n_channels != 1 or sound.sampling_frequency != 24000:
            raise ValueError(f"Unexpected recording format: {path}")
        f = sound.to_pitch_ac(time_step=.01, pitch_floor=60, pitch_ceiling=700).selected_array["frequency"]
        h = sound.to_harmonicity_cc(time_step=.01, minimum_pitch=60).values.ravel()
        inputs = processor(text=PROMPTS, audio=sound.resample(48000).values[0].astype(np.float32), sampling_rate=48000, return_tensors="pt", padding=True)
        with torch.inference_mode():
            scores = clap(**inputs).logits_per_audio[0].tolist()
        segments, _ = asr.transcribe(str(path), language=case["language"], beam_size=5, temperature=0, vad_filter=False, condition_on_previous_text=False)
        transcript = " ".join(segment.text.strip() for segment in segments)
        expected = speech.words(case["jobs"][0]["text"])
        result = {"id": case["id"], "sha256": digest, "medianF0": float(np.median(f[f > 0])) if np.any(f > 0) else None,
                  "voicedFraction": float(np.mean(f > 0)), "harmonicityDb": float(np.median(h[h > -100])),
                  "semanticScores": dict(zip(PROMPTS, scores)), "transcript": transcript,
                  "expectedWords": len(expected), "edits": speech.edit_distance(expected, speech.words(transcript))}
        results.append(result)
        (root / "acoustic-asr.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
