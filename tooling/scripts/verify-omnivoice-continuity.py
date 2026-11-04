"""Independent, offline WavLM speaker-similarity diagnostic for installed-browser recordings."""
# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import argparse
import hashlib
import itertools
import json
from pathlib import Path
import wave

import numpy as np
import torch
from transformers import WavLMForXVector

MODEL = "microsoft/wavlm-base-plus-sv"
REVISION = "feb593a6c23c1cc3d9510425c29b0a14d2b07b1e"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directories", nargs="+", type=Path)
    parser.add_argument("--cache", default=".cache/speaker-verification")
    args = parser.parse_args()
    directories = [group for root in args.directories for group in sorted({path.parent for path in root.rglob("sentence-*.wav")})]
    if not directories:
        raise ValueError("No installed-browser sentence recordings found.")
    torch.set_num_threads(2)
    model = WavLMForXVector.from_pretrained(MODEL, revision=REVISION, cache_dir=args.cache, local_files_only=True).eval()
    for directory in directories:
        paths = sorted(directory.glob("sentence-*.wav"))
        if len(paths) < 2:
            raise ValueError(f"At least two actual sentence recordings are required: {directory}")
        embeddings, files = [], []
        for path in paths:
            with wave.open(str(path), "rb") as audio:
                assert audio.getnchannels() == 1 and audio.getsampwidth() == 2
                rate = audio.getframerate()
                samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float32) / 32768
            # Band-limited Fourier resampling to the speaker model's required 16 kHz.
            count = round(len(samples) * 16000 / rate)
            spectrum = np.fft.rfft(samples)[: count // 2 + 1].copy()
            if count % 2 == 0 and rate > 16000:
                spectrum[-1] *= 2
            samples = (np.fft.irfft(spectrum, n=count) * count / len(samples)).astype(np.float32)
            samples = (samples - samples.mean()) / np.sqrt(samples.var() + 1e-7)
            with torch.inference_mode():
                embedding = model(input_values=torch.from_numpy(samples)[None, :]).embeddings
                embeddings.append(torch.nn.functional.normalize(embedding, dim=-1)[0])
            files.append({"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        pairs = [{"left": i, "right": j, "cosineSimilarity": float(torch.dot(embeddings[i], embeddings[j]))}
                 for i, j in itertools.combinations(range(len(paths)), 2)]
        report = {"model": MODEL, "revision": REVISION, "files": files, "pairs": pairs,
                  "minimumSimilarity": min(pair["cosineSimilarity"] for pair in pairs),
                  "referenceThreshold": 0.86,
                  "scope": "Independent speaker diagnostic; the upstream example threshold is dataset-dependent. Does not establish human listening or transcript accuracy."}
        (directory / "speaker-similarity.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"directory": str(directory), **report}), flush=True)


if __name__ == "__main__":
    main()
