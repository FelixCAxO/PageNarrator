# Attention scaling, masking and softmax A/B

This iteration starts from the [bounded-submission runtime](bounded-submissions-20261031.md). It keeps the smaller scale/mask/softmax fusion after rejecting two softmax/value-multiply fusions. Complete requests become modestly faster; whole-browser CPU and commitment do not improve reliably. The decision is based on lower GPU time for the affected work and consistent long-request latency improvements, with the CPU tradeoff reported below.

## Preserve the calculation and remove storage passes

The prepared main graph remains SHA-256 `8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb`. Current graph inspection and a one-step real-model trace confirm 28 attention softmax nodes, 16 query heads, 8 key/value heads and width 128. The short conditional and unconditional attention shapes are 259 × 259 and 77 × 77.

The baseline writes a half-precision array after scaling and another after masking. The candidate computes the same rounded input inside the existing softmax reads:

`z[i] = round16(round16(float32(x[i]) * float32(scale)) + float32(mask[i]))`

It retains the original 64-lane float32 maximum/sum reduction, exponential calculation, output half rounding, attention value multiply, full diffusion steps, weights and seeds. Scaling and mask addition are recomputed during softmax's three scans; this trades cheap arithmetic for fewer storage passes. It removes 56 GPU dispatches from each nonempty main inference pass, or 2,688 over a complete 24-step request with conditional and unconditional inference.

The graph rewrite requires half types throughout the chain, a scalar constant scale, ordinary operator attributes/domains and last-axis softmax. Original intermediate nodes remain available when independently requested as outputs. The GPU fast path handles the runtime's batch-one, repeated-per-head matrix mask. Other shapes execute the original multiply, add and softmax operations. The implementation reuses the existing softmax shader and adds one shared pipeline. The 128 MiB plan limit, 256-command submission bound, validation and workspace ownership remain unchanged.

## Reject the wider fusion

The first candidate keeps softmax probabilities in workgroup memory and fuses the value multiply. A second candidate enlarges its row tile while staying within the default workgroup storage limit. Both preserve every tested output bit on NVIDIA and Intel, but their timing does not support a portable improvement. At the actual 259-token conditional shape:

| Candidate / GPU | Paired median GPU time | Decision |
| --- | ---: | --- |
| 4 rows / nvidia | 1.73× baseline time | Reject |
| larger row tile / nvidia | 1.33× baseline time | Reject |
| 4 rows / intel | 2.14× baseline time | Reject |
| larger row tile / intel | 0.92× baseline time | Reject |

Longer square shapes also regress substantially. These prototypes remain only in ignored experiment artifacts.

## Isolated GPU comparison

The accepted kernel uses one dispatch in place of three. The baseline benchmark recycles intermediates, allocating two workspace buffers; the candidate allocates one. Five counterbalanced ABBA/BAAB pairs use GPU timestamps, adaptive 8 ms blocks capped at 4,096 repeats, and original/original controls. Only rows with positive intervals and a control median within 5% support timing claims. The higher-repeat run estimates block length from 64 initial repeats. Earlier rows with zero/invalid intervals remain preserved and excluded.

| Attention score shape | NVIDIA paired median GPU time reduction | Intel paired median GPU time reduction |
| --- | ---: | ---: |
| 77 × 77, 16 heads | 56.58% | inconclusive |
| 259 × 259, 16 heads | 67.35% | 50.99% |
| 512 × 512, 16 heads | 86.29% | 55.64% |
| 1024 × 1024, 16 heads | 78.40% | 46.53% |

These are timings for scaling, masking and softmax together, excluding the attention matrix multiplies and the rest of speech generation. They do not measure exclusive GPU utilization, power, or complete-model throughput.

The isolated workspace saving does not carry through as a large model allocation saving: the runtime already reuses those buffers. Main-plan retained capacity changes only from 102,725,784 to 102,711,672 bytes, a 14,112-byte parameter reduction. Decoder first/repeat capacities remain 402,753,376 / 175,106,048 bytes. Complete VRAM residency is unmeasured.

## Complete request cost

Four counterbalanced packaged pairs synthesize the same 19-second paragraph twice. Initialization is excluded from request latency and job CPU. Every pair preserves exact PCM, length and sample rate under the enforced 6 GiB browser-job commitment ceiling. Every inventoried browser process passes the unchanged strict membership gate. Raw before/after accounting remains preserved.

| Request | Baseline median | Candidate median | Paired median reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| First / 24 steps | 3538.53 ms | 3437.41 ms | 2.85% | 2.12–3.66% |
| Following / 12 steps | 1708.35 ms | 1663.77 ms | 3.02% | 1.99–3.44% |

Both request rows improve in all four pairs. Job user+kernel CPU, summed over the two requests, has a paired median reduction of **-3.85%**; negative means higher CPU. The range is -18.60–22.41%. Three CPU pairs regress and one improves. There is no established whole-browser CPU saving.

Peak commitment has a paired median saving of **-15.71 MiB**; negative means higher commitment. Two pairs improve and two regress, with a saving range of -340.27–385.22 MiB. Peaks include initialization through the final observation. These mixed values do not establish a RAM improvement or measure resident physical memory.

Four additional packaged short-request pairs give:

| Request | Baseline median | Candidate median | Paired median reduction |
| --- | ---: | ---: | ---: |
| First / 24 steps | 1681.33 ms | 1631.40 ms | 2.98% |
| Following / 12 steps | 883.96 ms | 876.44 ms | 0.59% |

Initialization remains separate and has no improvement claim. Intel's complete native long request finishes in 91.08 seconds for 19 seconds of speech. It verifies correctness and cleanup on that adapter; it remains much slower than real time.

## Correctness and continuity

All 1,594 engine/TTS/reader tests across 138 files, strict and boundary type checks, changed-file lint, production build, native source/binary checks and browser artifact checks pass. Focused tests cover graph selection, independently requested intermediates, type/attribute/domain/axis restrictions, runtime fallback, invalid broadcasting, empty axes and explicit rounding.

Each adapter passes 66 native precision controls and 14 attention shapes, including an input containing every finite half value. All 192 short-request and 96 long-request logit tensors match baseline byte-for-byte. Full speech codes, float32 PCM and WAV hashes match within each adapter. Both long controls use the actual shared engine with two main plans and one decoder plan, and release all tensors/buffers. The final bundle preserves all 17 packaged speech pairs, eight long cost pairs and eight Kokoro CPU/GPU controls, including PCM, source chunks and feeds.

The first playback run passes waveform continuity but its initial inventory includes one short-lived Chrome child that exits before membership verification. Its memory result is excluded. An immediate rerun with a new strict gate fails before playback at the same startup race. Both raw runs and the failed audit remain preserved.

The test now saves startup inventory separately, then requires a verified initial sample and strict coverage of every measured observation. It retains the same process-membership rule and kernel job limits. The accepted coverage window runs from the first post-startup sample through the last pre-export observation. The kernel commitment peak remains cumulative from launch. This narrows the inventory claim to the measured window; it does not qualify startup residency or physical hardware.

The final five-minute muted playback test records:

| Observation | Result |
| --- | ---: |
| Duration | 301.30 seconds |
| Complete source-aligned clips | 38 |
| Prepared event handoffs | 38 |
| Unprepared waits | 0 |
| Added render gap, p95 / maximum | 13.33 / 13.33 ms |
| Minimum source/capture correlation | 0.99999986 |
| Precise browser-job commitment peak | 4.756 GiB |
| Strict accounting observations | 65 |

This is a muted render-thread check; physical audio-device latency remains unverified.

Raw data, source snapshots, rejected prototypes, timing controls, runner scripts, summary assertions and final source/bundle hashes are in `artifacts/attention-fusion-20261031/`. Verification checks that the baseline bundle is the previously accepted candidate and that the new measurements use the final unchanged source and package. Measurements are serialized by the host lock on the development Ultra 9 / RTX 5090, with Intel Xe-LPG controls and variable unrelated host activity.

Physical 8 GiB RAM/8 GiB VRAM machines, weaker dedicated GPUs, device audio, energy use and broad PDF/OCR workloads remain unqualified. The continuous-playback hardware goal remains active.
