# Guarded rotary fusion with original half rounding

This follows the [single-nonempty Concat improvement](concat-views-20261101.md). The accepted change combines a half-precision rotary-position chain into one GPU dispatch while preserving its original intermediate rounding. A runtime guard validates the Slice plans; other valid arrangements retain the original operations. Full-request output remains exact in the checked cases, main GPU allocation falls, and all four first-request cost pairs are faster.

## Preserve the calculation while removing temporary arrays

Each query/key rotation uses two slices, a sign flip, two-input concatenation, two multiplications and an addition. The concatenation requires two dispatches, so the normal chain uses eight. The original computation rounds the negated values and each multiplication result to half precision before the final addition. The new kernel retains those conversions explicitly; it does not combine the multiplication and addition into a higher-precision expression.

The transform recognizes 56 ordinary ONNX chains across the 28 layers. It retains every original intermediate producer for separately requested outputs and replaces only the final Add dependency with a fused node. All data operands must be half tensors; unknown attributes, foreign domains, different source tensors and other patterns remain unchanged.

At execution, both original Slice plans are validated using the existing shape helper. Only complementary, contiguous last-axis partitions use the fused kernel. Overlapping, reversed, strided or otherwise different valid plans use the original slice/negate/concat/multiply/add operations, with all temporary tensors retired. Dynamic Slice controls remain metadata parameters and part of captured-plan keys. Invalid controls still fail; unused invalid Slice branches remain irrelevant when only a separately named multiplication output is requested.

Sine/cosine generation, normalization, learned weights, full bidirectional attention, sampling, seeds and diffusion steps stay unchanged. The prepared graph remains SHA-256 `8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb`; this is a runtime execution transform.

## Native stage and full-plan work

Fifteen production-native stage controls per adapter cover every finite half input, signed zeros, broadcast factors, empty tensors, odd widths, empty partitions and both guarded fallbacks. Every checked output half bit matches. NaN payload preservation is outside the finite-input control. Five interleaved ABBA/BAAB timestamp pairs follow original/original controls; a control median outside 5%, or an invalid timestamp interval, excludes that row's speed claim.

| Adapter | Heads / sequence positions | Baseline / fused dispatches | Paired median stage time reduction |
| --- | ---: | ---: | ---: |
| nvidia | 16 / 77 | 8 / 1 | Excluded |
| nvidia | 16 / 259 | 8 / 1 | 84.07% |
| nvidia | 8 / 259 | 8 / 1 | 86.21% |
| nvidia | 16 / 710 | 8 / 1 | 80.14% |
| nvidia | 8 / 710 | 8 / 1 | Excluded |
| intel | 16 / 77 | 8 / 1 | Excluded |
| intel | 16 / 259 | 8 / 1 | 70.11% |
| intel | 8 / 259 | 8 / 1 | 67.91% |
| intel | 16 / 710 | 8 / 1 | 72.59% |
| intel | 8 / 710 | 8 / 1 | 72.02% |

These are isolated repeated-kernel intervals, not whole speech, exclusive-host, power or representative-device results. Raw failed noise screens remain in the evidence.

The actual 19-second request trace confirms 56 fused rotations in each conditional/unconditional main pass:

| Pass | Baseline dispatches | Candidate dispatches | Removed |
| --- | ---: | ---: | ---: |
| Conditional | 1095 | 703 | 392 |
| Unconditional | 1094 | 702 | 392 |
| Decoder | 133 | 133 | 0 |

The full 24-step request removes 18,816 dispatches. The selected audio plan shrinks from 3,218 to 2,882 nodes. The 256-command submission bound and two-plan/128 MiB cache policy remain unchanged.

For a complete nonempty half rotation, the original chain writes 5.5 half elements per input element; the fused kernel writes one. Nominal loads fall from 8.5 to four. The observed 710/475-position request therefore avoids about 20.505 GiB of logical stores and the same logical load payload across 24 steps. Broadcast cache reuse, register spilling and actual memory-bus traffic are not measured; these are not energy figures.

## Main-model GPU allocation

| Long-request capacity | Baseline bytes | Candidate bytes |
| --- | ---: | ---: |
| First-pass allocated intermediates | 63,391,832 | 60,483,676 |
| First captured plan | 66,992,716 | 64,051,408 |
| Retained union of both main plans | 68,988,924 | 66,014,464 |

Retained main allocation falls by **2,974,460 bytes / 2.84 MiB / 4.31%**. Model weights and shader/driver residency are outside this capacity table. Decoder intermediates remain 402,753,376 bytes cold and 175,106,048 bytes on the matching repeat, with no decoder GPU plan retained.

## Complete-request A/B

Four counterbalanced packaged pairs synthesize the same 19-second paragraph at 24 steps, then 12 steps. All eight request pairs preserve exact float32 PCM, length and sample rate. The production extension tree is byte-identical to the measured prototype. Builds, tests and other diagnostics run outside the serialized timing measurements. Every before/after observation satisfies the enforced 6 GiB browser Job commitment cap and original strict process-membership gate.

| Request | Baseline median | Candidate median | Paired median time reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| First / 24 steps | 4171.61 ms | 3988.26 ms | 4.24% | 2.58 to 5.61% |
| Following / 12 steps | 2072.00 ms | 1997.54 ms | 3.59% | -3.74 to 8.64% |

All four first requests improve. Following requests improve in 3/4 pairs. Browser-job user+kernel CPU has a paired median reduction of 2.92%; two pairs improve and two tie at the counter resolution. There is no general CPU guarantee. Peak commitment has a paired median saving of 2.90 MiB, with a -37.82 to 107.34 MiB range; it remains mixed and does not establish a reduced physical-RAM requirement.

Job CPU includes browser/renderer/worker/GPU-process host work and diagnostics, excluding initialization, controller and fixture server. Commitment peaks include startup. Unrelated host activity remains variable; commitment is not resident RAM, and engine allocation is not total adapter VRAM.

Four additional short-request pairs give:

| Request | Baseline median | Candidate median | Paired median time reduction |
| --- | ---: | ---: | ---: |
| First / 24 steps | 1552.06 ms | 1456.58 ms | 7.38% |
| Following / 12 steps | 763.27 ms | 734.17 ms | 4.02% |

## Fidelity, lifecycle and continuity

All 1,636 engine/TTS/reader tests across 141 files, strict/boundary types, changed-source lint, production build and native/browser artifact checks pass. Thirteen new permanent tests cover pattern boundaries, preserved intermediate producers, runtime partitions, fallback retirement, invalid Slice parameters and metadata keys. Source reconstruction verifies that existing code and original shader text outside the explicit additions remain unchanged.

Each adapter passes 66 native precision controls and eleven new session controls: normal capture/replay, overlapping and reversed fallbacks, empty partitions, separately named outputs, unused invalid branches, invalid-control rejection and recovery. These verify actual cached-plan behavior and zero retained test tensors/buffers. There are no GPU validation errors.

All 192 short-request and 96 long-request half-logit tensors match the accepted baseline byte-for-byte. Complete codes, float32 PCM and WAVs match within each adapter. Seventeen packaged speech pairs, eight long cost pairs and eight Kokoro CPU/GPU controls also preserve exact output.

The five-minute varied-paragraph run uses muted render-thread capture. Startup inventory is separate; every retained observation from the first post-startup sample through final pre-export requires strict process coverage, while kernel commitment peaks remain cumulative from launch:

| Observation | Result |
| --- | ---: |
| Duration | 300.30 seconds |
| Complete clips / prepared handoffs | 38 / 38 |
| Unprepared waits | 0 |
| Added render gap, p95 / maximum | 13.33 / 13.33 ms |
| Minimum source/capture correlation | 0.99999986 |
| Browser commitment peak | 4.505 GiB |
| Strict inventory observations | 65 |

Raw vectors, timestamps, source snapshots, traces, builds, counters and final source/bundle pins are under `artifacts/rotary-fusion-20261101/`. Intel's instrumented long control still takes 87.96 seconds for 19 seconds of speech. It verifies correctness and remains slower than real time; it is not a representative-throughput acceptance result.

Physical 8 GiB RAM/8 GiB VRAM systems, weaker dedicated GPUs, audio-device continuity, energy and broad PDF/OCR workloads remain unqualified. The goal remains active.
