# Replay pipeline bindings: fewer calls, no reliable compute saving

This follows the [final feed-forward row experiment](final-layer-rows-20261101.md). A replay-only prototype skips consecutive setPipeline calls when a compute pass already uses the same pipeline. It removes about 26% of main-pass pipeline-binding calls, preserves checked output, and adds no GPU storage. Direct encoding and complete-request comparisons do not demonstrate a useful saving. The candidate is rejected; the accepted [lookup-range version](index-range-20261031.md), application source and current extension remain unchanged.

## Count before changing the algorithm

The unmodified English request captures conditional/unconditional plans with 1,207 and 1,206 dispatches. Each contains 311 redundant consecutive bindings after accounting for the 256-command submission boundaries and copies. The decoder has 133 dispatches and 16 redundant bindings. The trace preserves baseline codes, PCM and WAVs.

The candidate adds one local variable and a conditional in cached replay. Every dispatch and bind group remains in the original order. Each new compute pass resets the local pipeline, including after a copy or submission boundary. Capture, validation, queue submission, error handling, cleanup, shaders, model calculations, weights, shapes, sampling and steps remain unchanged. No state is retained across replay calls. A source reconstruction check verifies that all other code is identical to baseline.

This skips 14,306 pipeline bindings across the 46 cached main replays of the 24-step English request. Fewer WebGPU calls alone do not establish lower CPU time or GPU work.

## Direct synchronous encoding A/B

Four counterbalanced baseline/candidate pairs run complete 24-step English requests. A performance timer surrounds each actual synchronous replay call, with no wrapper around setPipeline and no synthetic GPU dispatches. All 192 checked half-logit tensors, codes, float32 PCM and WAV hashes match within the four pairs. Timings cover synchronous API work and possible blocking, not thread CPU seconds or asynchronous driver CPU.

| Pair | Baseline median replay | Candidate median replay | Reduction | Total baseline / candidate across 46 replays |
| --- | ---: | ---: | ---: | ---: |
| 0 | 0.2275 ms | 0.3000 ms | -31.87% | 11.33 / 13.57 ms |
| 1 | 0.2200 ms | 0.2425 ms | -10.23% | 10.97 / 11.54 ms |
| 2 | 0.2225 ms | 0.2225 ms | 0.00% | 12.00 / 11.24 ms |
| 3 | 0.2550 ms | 0.2325 ms | 8.82% | 12.27 / 11.16 ms |

Median replay time improves in only 1 of four pairs; the paired median reduction is **-5.11%**, a regression. Total replay time has a paired median reduction of only **0.63%**. The unmodified request spends about 11–12 ms in these synchronous encoding intervals, compared with roughly 1.8 seconds for the request. That identifies this synchronous portion as a small target without attributing the asynchronous driver work or whole-job CPU.

## Packaged long-request costs

Four additional counterbalanced packaged pairs synthesize the same 19-second paragraph twice, at 24 and 12 steps. All eight request pairs preserve exact float32 PCM, lengths and sample rates. An enforced 6 GiB browser Job commitment cap and the original strict process-membership gate apply to every before/after observation. Timing runs are serialized outside builds, unit checks and native diagnostics.

| Request | Baseline median | Candidate median | Paired median time reduction |
| --- | ---: | ---: | ---: |
| First / 24 steps | 4122.04 ms | 4173.65 ms | -1.26% |
| Following / 12 steps | 2046.00 ms | 2050.79 ms | -1.68% |

Whole-browser job CPU has a paired median reduction of 6.52%, but only 2/4 pairs improve, with pair reductions ranging from -16.28% to 20.83%. That mixed result and the direct encoding check do not establish a CPU improvement. The median peak-commitment saving is 48.93 MiB, with all four pairs lower. Peaks include startup and remain subject to host variability; the result does not identify a reduced engine allocation or physical-RAM requirement.

Retained main GPU plans remain 70,448,376 bytes. Decoder intermediates remain 402,753,376 bytes cold and 175,106,048 bytes on the matching repeat, with zero decoder GPU plans retained. Job user+kernel CPU includes browser/renderer/worker/GPU-process host work and diagnostics, excluding initialization, controller and fixture server. Job commitment is not resident RAM, and engine capacity is not total adapter VRAM residency. No energy claim is made.

## Correctness and final state

Eleven executable controls verify exact command/bind-group order, repeated replay, empty batches, 255/256/257/512/513-command boundaries, copies around boundaries and recovery after partial queue failure. NVIDIA and Intel each pass all 66 native precision/validation controls with the candidate source route confirmed active. GPU validation errors and retained test resources are zero.

The final verifier checks all accepted source pins, the complete unchanged current extension tree, the baseline worker dependency graph against the accepted bundle, and the actual measured candidate bundle's conditional pipeline-binding code. Scripts, source snapshots, native results, counters, replay intervals and bundle pins are under `artifacts/pipeline-binding-20261101/`.

No production source changes are made. Full application tests, broad-language speech acceptance and sustained playback are not repeated for this rejected candidate. The next iteration should profile redundant GPU operations shared across layers, including concatenations around empty KV-cache slices, before implementing another candidate.

Physical 8 GiB RAM/VRAM systems, weaker dedicated GPUs, audio-device continuity, energy and broad PDF/OCR workloads remain unqualified. The goal remains active.
