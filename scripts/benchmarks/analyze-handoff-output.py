"""Match source WAVs to WASAPI output; report added handoff gaps, excluding source silence."""
import argparse
import json
import math
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import fftconvolve, resample_poly


def mono(filename, target=24000):
    rate, values = wavfile.read(filename)
    scale = max(abs(np.iinfo(values.dtype).min), np.iinfo(values.dtype).max) if np.issubdtype(values.dtype, np.integer) else 1
    values = values.astype(np.float64) / scale
    if values.ndim == 2:
        values = values.mean(axis=1)
    if rate != target:
        divisor = math.gcd(int(rate), target)
        values = resample_poly(values, target // divisor, int(rate) // divisor)
    return values


def align(output, source):
    assert len(output) >= len(source) > 0
    correlation = fftconvolve(output, source[::-1], mode="valid")
    integral = np.concatenate(([0.0], np.cumsum(output * output)))
    energy = integral[len(source):] - integral[:-len(source)]
    active = energy > max(float(np.max(energy)) * 1e-12, 1e-30)
    normalized = np.zeros_like(correlation)
    normalized[active] = correlation[active] / np.sqrt(energy[active] * np.dot(source, source))
    index = int(np.argmax(normalized))
    return index, float(normalized[index])


def analyze(root):
    flow = json.loads((root / "flow.json").read_text(encoding="utf-8"))
    capture = json.loads((root / "output.wav.json").read_text(encoding="utf-8"))
    output = mono(root / "output.wav")
    ends = [event for event in flow["diagnostics"]["log"] if event["kind"] == "chunk_end"]
    starts = [event for event in flow["diagnostics"]["log"] if event["kind"] == "chunk_play"]
    matches = []
    for index, clip in enumerate(flow["clips"][:len(ends)]):
        assert clip["rate"] == 1, "Acoustic alignment requires unchanged playback rate"
        source = mono(root / f"clip-{index}.wav")
        expected = clip["at"] / 1000 - capture["startedEpochSeconds"]
        start = max(0, round((expected - .2) * 24000))
        stop = min(len(output), round((expected + len(source) / 24000 + 1.5) * 24000))
        offset, score = align(output[start:stop], source)
        position = (start + offset) / 24000
        matches.append(dict(index=index, score=score, startSeconds=position, endSeconds=position + len(source) / 24000))
    gaps = [1000 * (right["startSeconds"] - left["endSeconds"]) for left, right in zip(matches, matches[1:])]
    ready = []
    for index, end in enumerate(ends[:len(gaps)]):
        following = starts[index + 1]
        decoded = [event for event in flow["diagnostics"]["log"] if event["kind"] == "audio_preload_decode_latency"
                   and event["chunkIndex"] == following["chunkIndex"] and event["t"] <= following["t"]]
        ready.append(bool(decoded and decoded[-1]["t"] <= end["t"]))
    ready_gaps = [gap for gap, prepared in zip(gaps, ready) if prepared]
    assert len(ready_gaps) >= 5, "Too few ready, warm acoustic handoffs"
    p95 = float(np.percentile(np.maximum(ready_gaps, 0), 95))
    peak = max(ready_gaps)
    failures = []
    aligned = min(match["score"] for match in matches) >= .9
    if not aligned:
        failures.append("Capture cannot be reliably aligned to source PCM; acoustic continuity is inconclusive")
    if capture.get("captureWarnings"):
        failures.append("Capture reported dropped input or render frames")
    if aligned and min(gaps) < -10:
        failures.append("Detected source overlap or shortened playback")
    if aligned and (p95 > 50 or peak > 100):
        failures.append("Added acoustic gap exceeds p95 50 ms / maximum 100 ms")
    report = dict(method="source WAV normalized cross-correlation against captured output at 24 kHz", scope=capture.get("scope"), matches=matches,
                  gapsMs=gaps if aligned else None, readyWarmGapsMs=ready_gaps if aligned else None,
                  unpreparedWaitsMs=[gap for gap, prepared in zip(gaps, ready) if not prepared] if aligned else None,
                  p95AddedGapMs=p95 if aligned else None, maximumAddedGapMs=peak if aligned else None,
                  status="inconclusive" if not aligned else "failed" if failures else "passed", failures=failures, passed=not failures)
    (root / "acoustic-analysis.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))
    return not failures


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        source = np.random.default_rng(42).normal(size=2400)
        output = np.concatenate((np.zeros(480), source, np.zeros(1000)))
        offset, score = align(output, source)
        assert offset == 480 and score > .99999
        print("Known 20 ms offset recovered with exact source correlation.")
    else:
        assert args.root
        raise SystemExit(0 if analyze(args.root) else 1)
