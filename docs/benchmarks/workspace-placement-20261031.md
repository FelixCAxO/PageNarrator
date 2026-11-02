# Pack repeated decoder work into four buffers

This follows the rejected [transposed-tail experiment](transpose-zero-tail-20261031.md) and starts from the accepted [direct-tail decoder](decoder-zero-tail-20261031.md). Instead of changing convolution calculations, it changes where temporary tensors live. On the measured 19-second request, a repeated decoder shape needs **175,106,048 bytes rather than 402,753,376 bytes**: **56.5% less allocated intermediate capacity**, with four allocations instead of 15. The first request still uses the original allocator to learn the lifetimes.

The following same-shape request is 3.4% faster at the paired median. Whole-browser CPU is mixed and rises 2.2% at the paired median across both requests. This is a workspace-memory improvement; it does not establish a general CPU saving or lower first-request memory requirements.

## Use lifetimes instead of best fit alone

The existing allocator chooses the smallest available buffer large enough for the next tensor. Decoder tensors grow through successive upsampling stages. Smaller allocations become stranded even though relatively few buffers are live together. The restored-baseline trace has 133 logical output intervals, 402,753,376 bytes of allocated buffers and a 175,119,200-byte maximum active capacity.

The candidate records output sizes and closes each interval when its last tensor owner retires. Views keep that owner count live. It sorts intervals by decreasing size, then assigns each interval to the first large-enough slot whose intervals do not overlap. For this workload, all 133 outputs fit three 58,368,000-byte slots and one 2,048-byte slot. It preserves every arithmetic operation, shader, learned weight, dtype, diffusion step and output value.

Only oversized, uncached, single-plan GPU sessions learn these hints. A session keeps CPU placement metadata for at most two shapes, keyed by the existing outputs/shapes/feed-alias/host-metadata key. Tracing stops after 512 outputs, so larger graphs keep the ordinary allocator. Two-plan workspace sharing and the 128 MiB GPU-plan limit remain in place. A packed plan that fits that limit can use the normal GPU-plan cache. The measured 19-second decoder remains too large and retains **zero GPU-plan bytes** after either request.

Slots allocate lazily during the next matching request. Before each reuse, the allocator checks actual capacity, engine ownership and the absence of live owners. An occupied or undersized slot, an exhausted hint, or storage no longer owned by the engine falls back to the existing allocator. Changed output counts, fallback, dynamic metadata readback and failed requests discard the hint. Inputs, weights, validation flags and immutable command parameters keep their existing storage rules. Independent sessions allocate their own slots; the hint contains no GPU buffers.

## Actual allocations and whole-browser A/B

Both the instrumented GPU trace and all four packaged candidate repetitions show the same transition:

| Decoder observation | First request: learn | Following request: place |
| --- | ---: | ---: |
| Allocated intermediate capacity | 402,753,376 B | 175,106,048 B |
| Maximum active buffer capacity | 175,119,200 B | 175,106,048 B |
| Fresh allocations | 15 | 4 |
| Logical outputs | 133 | 133 |
| Placement hits / fallbacks | not applied | 133 / 0 |
| Retained GPU-plan bytes after request | 0 | 0 |

The saving is **227,647,328 bytes, or 217.1 MiB**, per matching decoder invocation. These are actual engine-owned GPU buffer capacities, not a full resident-VRAM measurement. The maximum active capacity barely changes; this removes stranded allocation capacity.

Four counterbalanced baseline/candidate pairs each synthesize the same long paragraph first at 24 steps and then at 12 steps. Both produce 456,000 samples at 24 kHz; equal decoder shapes permit reuse of the CPU hint. The unchanged frozen corpus, source snapshots, package worker hashes, prepared graph and strict browser-process accounting bind the comparisons. Allocation profiling runs separately and contributes no timing or process-memory measurements.

| Request | Baseline median | Candidate median | Paired median time reduction |
| --- | ---: | ---: | ---: |
| Long first / 24 steps | 5,542.0 ms | 5,566.5 ms | −0.25% |
| Long following / 12 steps | 2,769.1 ms | 2,672.3 ms | 3.35% |
| Short first / 24 steps | 2,624.0 ms | 2,593.2 ms | 1.85% |
| Short following / 12 steps | 1,372.0 ms | 1,367.8 ms | 1.60% |

The long repeat-request timing range is −0.66% to 4.33%; three pairs improve. Long first-request timing is slightly slower in all four pairs. The short frozen requests also have four pairs, with one regression in each timing row. Initialization pairs are 8,388→8,044, 8,188→7,974, 7,990→7,977 and 9,262→7,876 ms; no isolated startup improvement is attributed to workspace placement. These measurements compare with the immediate accepted baseline; they are not added to earlier percentages. Unrelated GPU activity limits interpretation of small differences.

| Pair | Baseline browser CPU | Candidate browser CPU | CPU reduction | Commitment peak saved |
| --- | ---: | ---: | ---: | ---: |
| 1 | 2.531 s | 2.672 s | −5.6% | 158.9 MiB |
| 2 | 2.438 s | 2.594 s | −6.4% | 53.3 MiB |
| 3 | 2.781 s | 2.328 s | 16.3% | −24.2 MiB |
| 4 | 2.547 s | 2.516 s | 1.2% | 37.3 MiB |

Combined browser CPU increases **2.2% at the paired median**, with two improving and two worsening pairs. The following request alone has a 4.4% paired-median CPU reduction, including one 27.3% regression and one tie. These mixed observations do not support a fixed CPU-saving claim.

Commitment peaks fall in three pairs and rise in one, with a paired median **45.3 MiB saving**. Peaks include initialization and the unoptimized first request. Every observed browser process belongs to the measured job, enforced at 6 GiB commitment. User+kernel CPU covers browser/worker/renderer/GPU-process host work and request transport; it excludes initialization, controller and fixture server. Commitment is not resident physical RAM. No energy or isolated GPU-time saving is claimed.

## Correctness and portability

All **1,569 engine/TTS/reader tests across 135 files** pass, including 19 placement tests. They cover view lifetimes, immutable metadata, capacity validation, stale/exhausted assignments, independent batches, private flags and inputs, the tracing bound, partial allocation failure, cleanup, metadata boundaries, failed reads, overlapping runs and disposal. Strict and boundary types, changed-source lint, production build and whitespace checks pass.

All 66 native precision/error/recovery cases pass on NVIDIA and Intel with deliberately stale 256-byte slot advice. This exercises both placement and safe fallback across the existing operators, dtypes and checked-Gather replay/recovery contracts. The final advice fits the native test's explicit 4 KiB plan budget; an earlier artificial 64 KiB reservation correctly prevented that test from retaining a plan and is excluded from acceptance.

All **192 generated-row half-logit tensors across 96 diffusion steps** match exactly: English, Swedish and Arabic on NVIDIA plus English on Intel. Corresponding codes, returned float32 PCM and WAVs match. All **17 packaged speech pairs** and **eight long-request pairs** preserve exact PCM, length and sample rate; packaged speaker identity also matches. Eight Kokoro CPU/GPU controls preserve PCM, native feeds and chunk boundaries.

Intel's larger 19-second diagnostic lost its device with placement enabled, with the inactive prototype, and with all three saved baseline engine/session/API sources restored through pinned routes. No decoder invocation began in the source-restored control. Short Intel native controls pass. The large packed decoder is established on NVIDIA; the Intel long-request failure remains unresolved.

## Continuous playback

The final package passes **300.429 seconds** of varied-paragraph, muted playback: **38 completed clips, 38 prepared handoffs and zero unprepared waits**. Added render gaps have p95 13.3 ms and maximum 21.3 ms; minimum source/capture correlation is 0.99999986. All 65 process-accounting observations stay within the 6 GiB browser-job ceiling, with a 5,027,303,424-byte commitment peak. Stop and cleanup checks pass. This verifies render-thread continuity; OS/device audio remains untested.

## Reproduction and remaining work

Ignored `artifacts/workspace-placement-20261031/` holds the source snapshots, exact request, fixed-plan prototype, real allocation traces, stale-hint native checks, raw packaged/process reports and derivation scripts. `resource-summary.mjs` checks all eight long PCM pairs, expected allocations, graph correction, unchanged retained-main storage, job limits and process coverage before calculating results. `summary.json` and `verification.json` bind current source and every reachable measured package module to these results. Native source/binary and browser-artifact checks pass. Timed/synthesis work runs serially under the host measurement lock; unit/build work runs separately.

An additional offline simulation exactly reproduces the baseline's 15 allocations, 402,753,376-byte total and 175,119,200-byte active peak from the 133 traced intervals. Rounding fresh capacities to 4 KiB projects 383,299,584 total bytes and 175,120,384 active bytes for this trace. Power-of-two capacities project 337,657,856 total bytes but increase the active peak to 201,342,976 bytes. These are diagnostic possibilities for first-request work, not application changes or measured GPU savings.

The host has a Core Ultra 9 285K, about 63.3 GiB RAM and an RTX 5090 with nominal 32 GiB VRAM. Intel Xe-LPG supplies additional native correctness evidence. Physical 8 GiB RAM/VRAM PCs, weaker dedicated GPUs, audio-device continuity, energy and the wider PDF/OCR workload remain unverified. Shape changes can miss the two CPU hints; the first request's memory peak remains. The broader continuous-speech goal stays active.
