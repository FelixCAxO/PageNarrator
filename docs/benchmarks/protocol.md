# Reader benchmark protocol v1

Freeze the scoring rules before testing. Record the candidate commit, package and model hashes, and environment. Keep every attempt under ignored `artifacts/`.

Use a fresh profile with visible setup and settings. Do not seed storage, use test hooks, force entitlements, or edit the manifest. Test defaults first; record other free local settings separately. Hash the built package tree and model files.

## Ordered execution and uncertainty

1. Test a development webpage through the packaged UI, with output-loopback audio and a machine-readable result. A library call or playback callback cannot pass this gate.
2. Freeze 24 independent authored fixtures: 8 HTML, 8 text PDFs, 4 long PDFs of 100–300 pages, and 4 raster PDFs. Half are English and half Swedish. Write references from the authored source, never extractor output. Hash documents and references. Keep development fixtures outside the scored set.
3. Run the unchanged baseline, then competitors. Counterbalance repeated product comparisons. Never synthesize concurrently. Record blocked installations and unavailable hardware or settings.
4. Collect 30 cold and 100 warm short-passage samples and 60 minutes of continuous reading per accessible product. Keep failures and blocked attempts. Report sample counts and p50/p95 only where samples support them. Do not infer named low-end hardware performance from simulations.

## Gates and measurement boundaries

- Ordered word recall must be >= 0.99 for straightforward text. No duplicated or skipped lifecycle sentences; unambiguous column/page order must be exact. Case, punctuation, and Unicode normalization are allowed. Declare number/date alternatives before scoring. Score equations and ambiguous tables separately.
- No stale audio from another document, voice, or session. No crash, unrecoverable hang, or out-of-memory failure during long runs.
- First audible time runs from immediately before Play to the first non-silent output-loopback frame. Report capture resolution. Synthesis completion and media callbacks cannot substitute. Missing, silent, contaminated, or truncated audio fails.
- Synthesis real-time factor (RTF) needs observed synthesis boundaries and audio duration; otherwise report null. Record requested and observed backends separately. A mismatch fails the requested-backend check.
- For offline checks, block network access after setup and repeat opening, generation, navigation, and browser restart. Report local inference, offline use, and observed content transmission separately. Partial logs cannot prove no transmission.
- Warm synthesis must stay ahead of playback, with no post-buffer underruns on the reference workload. Record CPU, process RSS, GPU/VRAM, and disk use when observable; otherwise null.
- Unsupported languages, OCR, or backends must return an explicit unsupported/error state. Correct handling still leaves a coverage limit.
- Missing evidence is null, never zero. Perceptual winners require randomized blind listener ratings. Pinned-model ASR is a diagnostic, not exact extraction evidence.
- Test pause/resume, previous/next/seek, speed and voice changes, stop/restart, tab/background/document changes, extension/browser restart, model failure, and network loss. Missing controls are unsupported; exposed broken controls fail.
- Later fixes need a separate pinned revision and three identical consecutive acceptance passes. Keep baseline failures. Never tune against scored fixtures.

## Environment record

Keep `--mute-audio` enabled for automated tests, probes, and screenshots, including headed runs. Analyze saved PCM or render-thread captures without playing test speech through desktop speakers or headphones. These captures cannot qualify OS/device output latency. Device loopback needs an explicitly selected isolated output; the capture script rejects the default route.

For waveform analysis, install `tooling/scripts/benchmarks/requirements-audio-analysis.txt` in an isolated Python environment. Run `tooling/scripts/benchmarks/analyze-handoff-output.py` with that interpreter. Pinned NumPy/SciPy versions are benchmark tools, not extension dependencies. Analysis never plays the audio.

Record OS, browser and Node versions, CPU, RAM, GPU, driver, power mode, background load, and actual backend. Keep physical measurements separate from capability overrides and constrained-host runs. Missing target hardware remains a coverage limit.
