# Compute-cost A/B experiment — 2026-10-31

Kept two small changes: release Kokoro's uploaded host weights, including q8 weights, and group fresh GPU dispatches into compute passes. Model files, precision, inference math, voices, chunking and generated speech stay unchanged.

## Measured memory

These are initializer backing buffers and engine allocation counters, **not browser RSS**. MiB means 1,048,576 bytes. Allocation results repeat exactly across both main baseline/final trials.

| Metric | Baseline | Final | Saved |
| --- | ---: | ---: | ---: |
| CPU q8 initializer backing buffers | 88.084 MiB | 0.495 MiB | 87.588 MiB |
| CPU arena high-water mark, Heart | 474.375 MiB | 423.875 MiB | 50.500 MiB |
| CPU arena high-water mark, Emma | 441.938 MiB | 402.500 MiB | 39.438 MiB |
| GPU fp32 host initializer backing buffers | 310.453 MiB | 0.354 MiB | 310.099 MiB |
| Peak engine-owned GPU buffers, Heart | 573.045 MiB | 573.045 MiB | 0 |
| Peak engine-owned GPU buffers, Emma | 554.842 MiB | 554.842 MiB | 0 |

CPU live tensor bytes also stay unchanged. Uploading weights before temporary tensors reduces arena fragmentation; releasing host copies removes another allocation. Small metadata constants retain independent bytes so they cannot pin the full model payload. CPU arena plus initializer backing storage falls by approximately 127–138 MiB on these two passages; pronunciation data, other JS objects and browser overhead are excluded.

## CPU and GPU work

Six alternating B/C and C/B pairs isolate pass batching from weight release. Each variant uses a fresh browser profile, one runtime-cold synthesis and three warm syntheses for each voice. Each pair compares the median of six warm samples per variant.

Browser process CPU seconds fall by a **paired median of 5.4%** with batching, improving in five of six pairs. The geometric mean ratio is 0.919. The existing diagnostic paired-log calculation gives a nominal one-sided 95% upper ratio of 0.990. The experiment was extended from three to six pairs after the initial CPU interval was inconclusive; this is exploratory evidence, not a preregistered significance result or representative hardware acceptance.

CDP CPU deltas include browser, workers, GPU-process CPU work, transport and allocation instrumentation. They do not measure GPU execution time or energy. CPU q8 synthesis has no demonstrated speed improvement: main-trial median completion changes were +2.8% for Heart and +0.2% for Emma.

**No GPU latency, utilization, VRAM or energy reduction is established.** Pass batching's paired median completion change is −3.1%, but its geometric mean ratio is 1.007 and the upper timing bound is 1.111. Whole-device NVIDIA samples include substantial unrelated activity, reaching 85% before the initial CPU-only workload. Timing variation prevents attribution of the larger apparent baseline/final GPU speed difference. Engine-owned GPU allocation peaks are unchanged; driver/process VRAM was not measured here.

Fresh dispatches now share a compute pass until a buffer copy, submission or cancellation closes it. This follows the existing replay path and WebGPU's per-dispatch compute usage scopes. See the [WebGPU specification](https://www.w3.org/TR/webgpu/#programming-model-resource-usages).

## Controls and correctness

- Baseline: `522cf92e79c8f44feca31374aee3a60f62ffda16` production inference with development instrumentation.
- A: baseline. B: host-weight release. C: B plus fresh-dispatch pass batching.
- Main order: A1, B1, C1, C2, A2. Both A and C have six warm samples per voice/backend, plus two runtime-cold samples.
- Isolated GPU order: B/C, C/B, B/C, C/B, B/C, C/B. All twelve trials and the initially inconclusive first three pairs are retained.
- Frozen `tests/fixtures/kokoro-connected-prose.json`; Heart and Emma, speed 1; CPU q8 with the production four-worker shared arena and NVIDIA fp32. Verified local model revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231`.
- 176 synthesis samples total; all 160 samples after the initial 16 match their baseline raw float32 PCM SHA-256, token/style/speed feeds and source chunks/phonemes exactly within their backend. Within-trial cold/warm identity also passes.
- Every probe passes source-stability, requested-backend and worker-closure checks, with no recorded GPU loss or submission errors. GPU cleanup counters reach zero. CPU workers close through termination; post-termination native counters are unavailable.
- All synthesis is PCM-only with no playback. The initial A1/B1 probes did not explicitly set the mute flag; subsequent probes do, and the harness now always adds `--mute-audio`.

Windows 10.0.26300.0; Intel Core Ultra 9 285K, 24 logical processors; NVIDIA RTX 5090; Chromium 156.0.8078.4; Node 26.12.1. The current NVIDIA DXGI LUID was `0,100999`. Separate correctness checks also use the physical Intel Xe-LPG adapter. Power mode and representative low-end hardware are unverified. The measurement lock serializes participating probes, not other desktop applications.

## Reproduction and evidence

Use the same instrumented harness, pinned browser, model cache and workload in isolated baseline/candidate checkouts. Select and verify the current adapter as described in [README.md](README.md); LUIDs can change. Alternate variants and keep inference serial:

```text
node scripts/weak-hardware/measurement-lock.mjs run -- node scripts/benchmarks/kokoro.mjs --backend both --mode stream --repeats 3 --output artifacts/<new-trial>.json
```

The harness now records unique initializer backing bytes and browser CPU seconds. Keep exact PCM/feed/chunk comparisons as a gate before interpreting resource results. A fresh profile is runtime-cold, not a cold driver or download measurement.

Local evidence is in ignored `artifacts/compute-ab-20261031/`: `plan.json`, A/B/C source snapshots, five main reports, twelve isolated GPU reports, `summary.json`, `gpu-summary.json`, reproduction runners and assertion-based comparison scripts. Original reports contain model/source hashes and all host samples. The final harness indentation was cleaned up after measurement; production source bytes match the candidate snapshots.

Validation: 945 engine/TTS tests and all 41 benchmark/harness/website checks pass; 64 real GPU fp16/fp32 parity cases pass on NVIDIA and another 64 on Intel, including cleanup. Both type checks, changed-file lint, the production build and `git diff --check` pass. Logs are recorded alongside the reports.

Full OmniVoice speech, installed-extension playback, long-reading soak, device output, process RSS, GPU energy and representative hardware measurements were outside this experiment.
