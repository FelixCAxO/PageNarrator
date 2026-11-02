# Generated-row output projection

This experiment follows the [identity-indexing and bounded-cache A/B](index-views-20261031.md). Its baseline includes those optimizations and the preceding FP16 sampling, packed-matrix and model-loading changes. Model weights, original download/cache pins, diffusion steps, guidance, random draws and decoder remain unchanged.

## Measured work and algorithm change

A muted, instrumented English request reads 48 FP16 logit tensors over 24 diffusion steps. The conditional output has shape `[1,8,259,1025]`, including 182 text/reference rows that sampling skips. The unconditional output has 77 generated rows. Combined readback is 132,249,600 bytes. Separating queued GPU work from readback records about 204 ms for these transfers plus host handling. This diagnostic adds an explicit queue-completion wait and is not an uninstrumented timing benchmark.

The final learned projection is a row-independent `[1024,8200]` matrix multiplication after the complete transformer and final normalization. The new ephemeral graph inserts a slice of generated hidden rows before that projection. Its existing reshape and transpose then operate on those rows. Both conditional and unconditional outputs contain only the generated frames. All attention calculations and positional inputs still cover the full bidirectional sequence on every pass; all KV outputs and learned tensors are identical in the structural contract test.

For the profiled request, the conditional head processes 77 rows instead of 259. Combined logit readback falls to 60,614,400 bytes, **54.2% less**. The conditional head performs 70.3% fewer row projections; 24 steps avoid `24 × 182 × 1024 × 8200 = 36,677,222,400` multiply-accumulate operations at that head. These are calculated operation counts, not a measured reduction in total GPU time, off-chip bandwidth or energy. The large transformer computation still runs in full.

The conditional retained-plan estimate falls from 27,238,072 to 22,990,568 bytes in the profile; the unconditional plan remains 8,160,156 bytes. This is local plan storage, not total VRAM or physical RAM.

## Exactness controls

On both NVIDIA Blackwell and Intel Xe-LPG, all 48 complete generated-row logit tensors match the baseline exactly in raw half bits over 24 steps. Token-code, float32 PCM and WAV hashes also match within each architecture. The profiler compacts the baseline CPU output only for comparison; the candidate actually reduces the GPU head and returned tensor. Baseline runtime and graph-transform source overrides are recorded explicitly in the report pins. No cross-architecture PCM identity is claimed.

`prepareOmniVoiceGraph` accepts only the exact original graph and combines RMSNorm correction and row selection in one parse/write pass. It asserts the deterministic derived hash `d4de7933bfa728c1724c03778c65eacffce3f93dcd7b26b110b2c5314be38258`. The separate normalization-only function retains its existing model interface and derived hash for independent numerical controls. The internal `pn_audio_start [1]` feed belongs to the metadata cache key, so a change in selected rows cannot replay a stale slice. The original graph remains the only cached download. Diagnostics retain the original, normalization-stage and final derived graph hashes.

Structural checks compare every original node: only the head and its two shape inputs change; two constants and one slice are added. Original inputs, other outputs, model values, opsets and all learned tensor data remain unchanged. Sampler controls compare every decision and random draw through 24 steps for full and compact float32/FP16 inputs, including ignored NaN prefix rows. Runtime controls retain full attention positions and verify tensor disposal.

All 17 packaged request pairs also preserve exact float32 PCM, length, sample rate and speaker identity. They cover English, Swedish, Hindi, Arabic, Japanese, a changed variation, male Hindi whisper, runtime disposal/recovery and a 19-second long clip.

## Paired request timing

Four counterbalanced pairs repeat the first two packaged English requests. Wall time excludes initialization and uses the ordinary packaged worker without profiling hooks.

| Request | Baseline median | Candidate median | Paired median reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| First / 24 steps | 2023.0 ms | 1920.5 ms | 5.01% | −2.03–14.22% |
| Following / 12 steps | 1054.5 ms | 1048.0 ms | 0.24% | −0.41–6.78% |

The first request regressed in one pair; continuation differences are mostly small. This is not evidence of a stable workload-wide speedup. The transfer and projection work removed is established more directly by shapes, byte counts and exact generated-row comparisons. All 17 pairs pass again after combining graph preparation into one pass.

## Isolated GPU cost and native resource comparison

GPU timestamps compare the original full head with the generated-row head **including its added slice**, using finite synthetic FP16 inputs, identical projection weights and five counterbalanced pairs. Each timestamp averages eight repeated dispatch sequences with hot weights. All generated output half bits match. The first shape reproduces the profiled English dimensions; the longer shape is synthetic.

| Head shape, prefix / generated rows | NVIDIA paired time reduction | Intel paired time reduction |
| --- | ---: | ---: |
| 182 / 77 | 67.74% | 68.66% |
| 255 / 475 | 33.75% | 37.72% |
| 34 / 33, unaligned boundary | 20.00% | 37.58% |
| 0 / 33, unchanged-work control | 0.00% | 0.00% |

For the English shape, NVIDIA median stage time is 254.0 → 81.9 microseconds and Intel is 12.04 → 3.78 milliseconds. This is a small part of total inference. Repeated hot-weight timings cannot establish whole-model GPU time or energy. Timestamps are quantized; use paired ratios rather than subtracting independently rounded medians.

Four further counterbalanced pairs run a fresh 24-step long request and a 12-step continuation under the same native Windows 6 GiB browser-job commitment ceiling. All eight request pairs preserve exact PCM and pass process-coverage checks.

| Native accounting for both requests | Baseline median | Candidate median | Paired result |
| --- | ---: | ---: | ---: |
| Combined browser CPU | 5.063 CPU s | 4.914 CPU s | 2.62% lower median paired CPU |
| Whole-run browser commitment peak | 4.909 GiB | 4.963 GiB | 56.6 MiB higher median paired peak |

All four final CPU pairs improve, ranging from 1.6% to 19.3%; the first baseline is a high outlier. This is preliminary: the earlier two-pass cohort with identical inference graph bytes had essentially unchanged CPU. Three of four final commitment peaks increase, ranging from 115.5 MiB higher to 119.4 MiB lower. The earlier cohort's 112.2 MiB median saving did not repeat, so no browser-memory improvement is established. Native commitment includes initialization through the final request observation and is not resident physical RAM or dedicated GPU memory. CPU accounting sums job user/kernel time around synthesis, including worker/renderer work, GPU-process host work, transport, PCM hashing and diagnostics; it excludes initialization, the controller and the fixture server.

## Scope and evidence

The 1,466 engine, TTS and reader tests, strict/boundary type checks, changed-file lint and production build pass. Evidence lives in `artifacts/readback-compute-20261031/`, including the baseline package, source snapshots, original/derived graph hashes, native logit controls, raw counters and WAV files. Automated output stays muted.

The first native CPU-accounting attempt failed its process-membership assertion and is excluded from measurements. Its log and partial baseline record remain as `long-speech-membership-failure*`. The rerun records raw failing observations before rejecting unverified coverage; membership acceptance is unchanged.

The final package passes a fresh five-minute varied-paragraph read under an enforced 6 GiB browser-job commitment ceiling. Its streamed waveform capture passes source alignment and the unchanged handoff thresholds:

| Final playback observation | Result |
| --- | ---: |
| Duration | 300.5 s |
| Completed chunks / prepared event handoffs | 38 / 38 |
| Unprepared waits | 0 |
| Complete source-aligned clips / boundaries | 38 / 37 |
| Added render gap, p95 / maximum | 13.3 / 21.3 ms |
| Minimum source/capture correlation | 0.99999986 |
| Precise browser commitment peak | 4.767 GiB |
| Native accounting observations | 65 |

Stop returns the controls to ready and cleanup passes. Commitment includes initialization and playback through the last pre-export observation; the controller and fixture server are outside the browser job. These are muted render-thread results, not physical-device audio latency or a resident-RAM measurement. The final run has no concurrent test execution. The earlier two-pass run is retained separately, including its brief controller-side contract-test/lint activity.

`summary.json` derives paired results and validates hashes, process coverage and accounting limits. `verification.json` records final source pins and verifies that the combined initializer emits exactly the saved graph bytes used by the raw-logit controls. Reproduction procedures remain in `profile.mjs`, `head-kernel.mjs`, `graph-prepare-ab.mjs`, `long-speech.mjs`, `summarize.mjs` and `verify.mjs` alongside the evidence; the packaged parity and sustained-read commands use the existing E2E harnesses.

Development hardware remains the Core Ultra 9 / RTX 5090 host. Intel validates exactness, but its instrumented 3.08-second clip takes roughly 26 seconds, so it does not demonstrate smooth OmniVoice playback. No physical 8 GiB RAM/8 GiB dedicated-GPU, weaker dedicated-GPU, device-output, power or wider PDF/OCR qualification follows from this experiment.

The first implementation used two parse/write passes and initialized 208–335 ms slower in every packaged pair. Combining the passes emits byte-identical graph data and reduces isolated preparation wall time by about 36% across five counterbalanced Node pairs. Process CPU counters remain noisy. Final packaged initialization ranges from 154 ms faster to 75 ms slower, with a paired median 11.5 ms increase; the systematic startup regression is no longer reproduced. The raw logit and isolated-head controls use the same derived graph bytes as this final initializer. The two-pass measurements and first passing sustained read remain preserved separately.
