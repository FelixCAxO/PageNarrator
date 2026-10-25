# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
"""Development-only paired ASR review using the already installed offline Whisper oracle."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
from faster_whisper import WhisperModel

parser = argparse.ArgumentParser()
parser.add_argument("--manifest", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
model_directory = Path(args.model).resolve()
model_sha = hashlib.sha256((model_directory / "model.bin").read_bytes()).hexdigest()
if model_sha != "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9":
    raise RuntimeError("The existing Whisper-base oracle model differs from its frozen data pin.")
manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8-sig"))
records = manifest["cases"]
model = WhisperModel(str(model_directory), device="cpu", compute_type="int8", cpu_threads=2, local_files_only=True)
report = {"scope": "Offline ASR diagnostic; does not establish human listening or pronunciation quality", "model": {
    "repository": "Systran/faster-whisper-base", "revision": "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
    "sha256": model_sha, "python": sys.version, "faster_whisper": importlib.metadata.version("faster-whisper"),
    "ctranslate2": importlib.metadata.version("ctranslate2"), "device": "cpu", "compute_type": "int8", "threads": 2,
    "local_files_only": True, "beam_size": 5, "vad_filter": False, "initial_prompt": None}, "cases": []}
for record in records:
    output = {"id": record["id"], "expectedText": record["expectedText"], "language": record.get("language", "en")}
    for variant in ["candidate", "reference"]:
        path = Path(record[variant]).resolve()
        segments, info = model.transcribe(str(path), language=output["language"], beam_size=5,
                                          vad_filter=False, condition_on_previous_text=False, word_timestamps=True)
        segments = list(segments)
        output[variant] = {"file": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                           "seconds": info.duration, "transcript": " ".join(segment.text.strip() for segment in segments).strip(),
                           "segments": [{"start": segment.start, "end": segment.end, "text": segment.text,
                                         "words": [{"word": word.word, "start": word.start, "end": word.end,
                                                    "probability": word.probability} for word in (segment.words or [])]}
                                        for segment in segments]}
        print(json.dumps({"id": record["id"], "variant": variant, "transcript": output[variant]["transcript"]}, ensure_ascii=False), flush=True)
    report["cases"].append(output)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
