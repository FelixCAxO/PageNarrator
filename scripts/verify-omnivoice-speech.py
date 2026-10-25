"""Offline ASR diagnostic for the frozen paired speech corpus; not listening acceptance."""
# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import unicodedata


def words(text):
    text = unicodedata.normalize("NFKC", text).casefold()
    return "".join(c if c.isalnum() or c.isspace() else " " for c in text).split()


def edit_distance(expected, actual):
    row = list(range(len(actual) + 1))
    for i, left in enumerate(expected, 1):
        new = [i]
        for j, right in enumerate(actual, 1):
            new.append(min(new[-1] + 1, row[j] + 1, row[j - 1] + (left != right)))
        row = new
    return row[-1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--case", choices=["english", "swedish", "arabic"])
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--original-only", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    out_dir = args.directory.resolve() if args.directory else root / "artifacts/engines/omnivoice-original-speech"
    corpus = json.loads((root / "tests/fixtures/browser-speech-quality.json").read_text(encoding="utf-8"))
    files = [args.model / name for name in ["model.bin", "config.json", "tokenizer.json", "vocabulary.txt"]]
    if not all(path.is_file() for path in files):
        raise RuntimeError("The explicit offline ASR snapshot is incomplete.")
    pins = [{"name": path.name, "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in files]
    from faster_whisper import WhisperModel
    model = WhisperModel(str(args.model), device="cpu", compute_type="int8", cpu_threads=2, local_files_only=True)
    cases = []
    for item in corpus["cases"]:
        if args.case and item["id"] != args.case:
            continue
        expected = words(item["text"])
        for backend in (["original"] if args.original_only else ["reference", "original"]):
            path = out_dir / f"{item['id']}-{backend}.wav"
            if not path.is_file():
                raise RuntimeError(f"Missing paired recording: {path}")
            segments, _ = model.transcribe(str(path), language="ar" if item["lang"] == "arb" else item["lang"], beam_size=5, temperature=0,
                                            vad_filter=False, condition_on_previous_text=False)
            transcript = " ".join(segment.text.strip() for segment in segments)
            actual = words(transcript)
            edits = edit_distance(expected, actual)
            result = {"id": item["id"], "backend": backend, "text": item["text"], "transcript": transcript,
                      "expectedWords": len(expected), "edits": edits, "wer": edits / max(1, len(expected)),
                      "wavSha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            cases.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
    output = out_dir / f"asr{('-' + args.case) if args.case else ''}.json"
    output.write_text(json.dumps({"status": "diagnostic-only", "modelFiles": pins,
                                  "fasterWhisperVersion": importlib.metadata.version("faster-whisper"), "cases": cases,
                                  "listeningPassed": False, "scope": "Offline ASR corroboration only; human pronunciation, naturalness and noise review remain required."},
                                 ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
