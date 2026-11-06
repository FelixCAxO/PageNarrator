# Hardware testing

```sh
npm run build
npm run probe:weak-hardware:no-build
npm run test:weak-hardware
npm run requirements:tts
```

The matrix runs baseline, memory, faults, and lifecycle checks. Add `--workloads`, `--contention`, or `--soak` after `--` to opt in. Use `--stages=memory --runs=2` to repeat the memory lane. A soak shorter than 60 minutes stays exploratory. See `tooling/scripts/weak-hardware/run-matrix.mjs` for lane definitions.

For a packaged OmniVoice read lasting at least one hour, build the candidate and verify its pinned speech fixtures first. Run this separately from other synthesis or scored browser measurements:

```powershell
$env:PN_E2E_SUSTAINED_OV = '1'
$env:PN_SUSTAINED_MINUTES = '60'
$env:PN_SUSTAINED_OUTPUT = 'artifacts/omnivoice-sustained-60min'
npm run test:e2e:local -- tests/e2e/omnivoice-sustained.e2e.js --project=extension --workers=1
```

Use a new output directory for each attempt. Bind a GPU explicitly with `PN_GPU_VENDOR` and `PN_GPU_ADAPTER_LUID` when needed. The harness runs muted within a browser commit ceiling, streams audio evidence to disk, waits for a completed section covering the requested duration, and records transitions, speaker identity, package hashes, cleanup, and warmed memory observations. A one-minute run is useful for checking the harness but remains exploratory. This test does not establish physical low-spec support, output-device latency, pronunciation, or independent listening quality; its memory drift is descriptive rather than a leak verdict.

## Evidence

| Run | What it establishes |
| --- | --- |
| Native host | Behavior on the observed host and adapter |
| Capability simulation | Behavior under reported CPU, memory, or GPU overrides |
| Constrained Windows host | Behavior with a Job Object enforcing browser CPU affinity, CPU rate, or commit |
| Fault injection | Recovery after the injected GPU or network fault fires |
| Physical target | Behavior on an attested machine with the actual backend and valid samples |

The launcher verifies caps, job membership, adapter, and fired fault counters. Contradictory observations make a run invalid. Missing observations leave it unverified. Commit caps measure browser commitment. Core affinity and sampled GPU counters have limited coverage.

Run scored profiles serially with the measurement lock. Check it with `npm run measurement:lock -- status`. Explicit contention runs stay separate. Foreign CPU or GPU load at 25%, missing attribution, or an absent lock excludes timing from tier results. Keep reports under ignored `artifacts/weak-hardware/`, including failures and incomplete attempts.

## Physical tiers

1. Set `PAGENARRATOR_PHYSICAL_TARGET_ATTESTATION` to a private JSON file with `machine`, `cpuModel`, `logicalProcessors`, `ramGb`, `gpus`, and `attestedBy`.
2. Set `PAGENARRATOR_TTS_PROBE_PROFILE` to `native_wasm`, `igpu_webgpu`, or `dgpu_webgpu`. GPU timing requires explicit adapter binding and complete counters. Set `PAGENARRATOR_TTS_PROBE_DOCUMENTS=article,pdf`.
3. Run `npm run probe:tts:no-build` against one candidate. Use `PAGENARRATOR_TTS_PROBE_RUNS` and `PAGENARRATOR_TTS_PROBE_READS_PER_TARGET` to collect at least 30 cold and 100 warm valid samples per workload. Pool by observed host identity, build, and workload.
4. Run `npm run requirements:tts -- --fail-on-non-pass` to check both physical tiers against current `dist/` bytes. Plain `requirements:tts` is diagnostic. See the [release policy](../tooling/config/release-policy.json) for version-specific waivers.

## Measurement contract 3

A cold read starts in a fresh popup. A warm read follows a successful read in the same popup, with pinned model bytes verified in the production cache. Record model residency separately. Preserve unique attempt IDs and per-workload hashes.

Measure the first non-silent page signal for each click. This is a render-path measurement. Report device output separately. Missing signals or degraded sampling cannot qualify timing. Completed transitions need synthesis-ready and preceding-audio-end timestamps. The deadline budgets are 2,000 ms for minimum and 1,500 ms for recommended. The pinned two-page PDF must play at least two sections. Older contracts remain historical evidence.
