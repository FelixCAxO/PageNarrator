"""Match source WAVs to captured output; report added handoff gaps, excluding source silence."""
import argparse
import json
import math
import tempfile
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
    clock_offset = 0.0
    for index, clip in enumerate(flow["clips"][:len(ends)]):
        assert clip["rate"] == 1, "Acoustic alignment requires unchanged playback rate"
        source = mono(root / f"clip-{index}.wav")
        wall_expected = clip["at"] / 1000 - capture["startedEpochSeconds"]
        # Render and wall clocks drift; carry forward only a verified PCM anchor.
        expected = wall_expected + clock_offset
        start = max(0, round((expected - .2) * 24000))
        stop = min(len(output), round((expected + len(source) / 24000 + 1.5) * 24000))
        offset, score = align(output[start:stop], source)
        position = (start + offset) / 24000
        matches.append(dict(index=index, score=score, startSeconds=position, endSeconds=position + len(source) / 24000,
                            wallExpectedSeconds=wall_expected, clockOffsetMs=1000 * (position - wall_expected)))
        if score >= .9:
            clock_offset = position - wall_expected
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
        with tempfile.TemporaryDirectory(prefix="pn-handoff-control-") as directory:
            root = Path(directory).resolve()
            assert root.parent == Path(tempfile.gettempdir()).resolve() and root.name.startswith("pn-handoff-control-")
            for stalled in [False, True]:
                rng = np.random.default_rng(43)
                parts, clips, events = [np.zeros(3600, dtype=np.float32)], [], []
                position = .15
                for index in range(7):
                    source = rng.normal(0, .1, 2400).astype(np.float32)
                    wavfile.write(root / f"clip-{index}.wav", 24000, source)
                    # Advance the wall clock 80 ms per clip without changing render gaps.
                    wall = position + .08 * index
                    clips.append(dict(at=wall * 1000, rate=1))
                    events.extend([dict(kind="chunk_play", chunkIndex=index, t=wall),
                                   dict(kind="chunk_end", chunkIndex=index, t=wall + .1),
                                   dict(kind="audio_preload_decode_latency", chunkIndex=index, t=0)])
                    gap = .25 if stalled and index == 2 else .02
                    parts.extend([source, np.zeros(round(gap * 24000), dtype=np.float32)])
                    position += .1 + gap
                wavfile.write(root / "output.wav", 24000, np.concatenate(parts))
                (root / "flow.json").write_text(json.dumps(dict(diagnostics=dict(log=events), clips=clips)), encoding="utf-8")
                (root / "output.wav.json").write_text(json.dumps(dict(startedEpochSeconds=0, scope="Synthetic render-clock drift control")), encoding="utf-8")
                assert analyze(root) is not stalled
                report = json.loads((root / "acoustic-analysis.json").read_text(encoding="utf-8"))
                assert min(match["score"] for match in report["matches"]) > .99999
                assert abs(report["maximumAddedGapMs"] - (250 if stalled else 20)) < .01
                if stalled:
                    assert report["status"] == "failed", "Clock correction must not hide a real handoff stall"
        print("Clock drift preserved exact 20 ms gaps and still rejected an inserted 250 ms stall.")
    else:
        assert args.root
        raise SystemExit(0 if analyze(args.root) else 1)
