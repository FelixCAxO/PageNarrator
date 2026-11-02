# Validate and widen boolean feeds in one pass

This follows the [serialized GPU workspace A/B](plan-workspace-20261031.md). The candidate combines boolean validation with conversion into GPU storage and reuses a bounded session-owned conversion buffer. All four paired long workloads use less browser CPU, with a **10.3% paired median reduction**. Browser commitment peaks remain mixed and usually rise; this iteration establishes no resident-RAM or GPU-compute saving.

## Remove a scan and repeated allocation

OmniVoice creates a full bidirectional attention mask as a `Uint8Array` of `length * length` ones. Each main inference previously called `some()` to validate every byte, then `Uint32Array.from()` to expand the mask for GPU storage. The same immutable-in-practice mask is normalized again at every diffusion step. Other callers can mutate their inputs, so skipping validation or caching converted values by object identity would be incorrect.

The candidate validates and widens each byte in one indexed loop. A byte above one still raises the same error before inference submits any input. Shape, element-count and declared-type checks remain ahead of conversion. Every call rewrites every destination element, including when the caller reuses and changes a source array.

Each session keeps conversion capacity by input name, bounded to **4 MiB total across its boolean inputs**. Smaller alternating shapes use views of existing capacity. Growth that would exceed the limit receives temporary storage; it does not enlarge the retained cache. Invalid growth is never cached. Different inputs and unrelated sessions have separate storage, and session disposal clears the cache after any active inference finishes. Calls outside a session retain independent output allocations. An overlapping source byte view also receives an independent copy to avoid overwriting unread bytes.

The existing session gate rejects concurrent inference in one session. GPU validation and output transfers still finish before another call can reuse host storage. GPU buffers, uploads, dispatches, shaders, precision, model graph, weights, masks, sampling, seeds and diffusion steps are unchanged. The algorithm remains linear in the mask size; it performs fewer passes and allocations.

## Isolated algorithm comparisons

The first experiment compares the original conversion, a single validated copy with fresh storage, and a bounded reusable copy. Fresh single-pass storage improves the observed long mask sizes by 76–79%; reuse improves them by about 89%. Those prototype results select the production approach. A separate final comparison measures the exact production source, including its ownership/overlap checks and memory bound.

Seven interleaved ABBA/BAAB pairs per size include original/original controls. Timing blocks are calibrated to about 20 ms, including small inputs. A row supports a speed claim only when durations are positive and the median original/original ratio is within 5% of one. All seven final rows pass this screen; raw timings and controls remain available.

| Boolean elements | Original median | Production median | Paired median time reduction |
| --- | ---: | ---: | ---: |
| 77² | 0.02792 ms | 0.00266 ms | 90.5% |
| 259² | 0.28313 ms | 0.02938 ms | 89.6% |
| 475² | 0.88043 ms | 0.09783 ms | 88.8% |
| 710² | 1.95455 ms | 0.21818 ms | 88.8% |
| 1,048,576 | 4.30000 ms | 0.47000 ms | 88.8% |
| 4,194,304 | 16.20000 ms | 3.35000 ms | 79.3% |

The last row exceeds the retention limit and uses fresh storage. These are warmed isolated conversions, not full-model speedups. The full model supplies many feed types and a different JIT/allocation workload.

## Actual inference feed path

A separate instrumented diagnostic runs the same two long requests at 24 then 12 diffusion steps. It records 144 boolean conversions, covering conditional/unconditional attention and audio masks. Its request timings and process-memory values are excluded from performance claims.

| Diagnostic observation | Original | Candidate |
| --- | ---: | ---: |
| Boolean conversion calls | 144 | 144 |
| Time inside conversion | 115.6 ms | 33.8 ms |
| Newly allocated conversion buffers | 144 | 2 |
| Cumulative conversion allocation | 105,251,040 bytes | 2,019,240 bytes |
| Persistent conversion capacity | 0 | 2,019,240 bytes |

The observed conversion stage takes **70.8% less time**, and cumulative allocation falls by **103,231,800 bytes**, about 98.45 MiB, across these two requests. About 1.93 MiB remains available for reuse. Cumulative allocated bytes are not simultaneously resident RAM. Source-mask creation and GPU transfer size remain unchanged. The diagnostic preserves exact codes, raw PCM and WAVs.

## Whole requests and browser resources

Four counterbalanced packaged pairs measure short requests. Another four pairs measure two long requests under a 6 GiB Windows browser-job commitment ceiling. Timings exclude initialization and diagnostic instrumentation. Percentages compare paired requests against this iteration's immediate baseline and are not added to earlier gains.

| Request | Baseline median | Candidate median | Paired median time reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| Short first / 24 steps | 1786.3 ms | 1791.2 ms | 0.2% | −4.6–4.1% |
| Short following / 12 steps | 936.4 ms | 931.8 ms | 0.7% | −0.8–1.6% |
| Long first / 24 steps | 3801.3 ms | 3729.4 ms | 1.5% | −1.3–4.5% |
| Long following / 12 steps | 1831.4 ms | 1788.3 ms | 2.0% | −2.0–2.7% |

The timing pairs are mixed. They do not establish a universal latency gain. Initialization pairs are 7,894→7,623, 7,539→7,878, 7,598→7,409 and 7,465→7,647 ms; there is no established startup gain.

| Long-request pair | Baseline browser CPU | Candidate browser CPU | CPU reduction | Commitment peak saved |
| --- | ---: | ---: | ---: | ---: |
| 1 | 2.313 s | 2.281 s | 1.4% | −16.6 MiB |
| 2 | 2.891 s | 2.375 s | 17.8% | 110.7 MiB |
| 3 | 2.906 s | 2.156 s | 25.8% | −68.4 MiB |
| 4 | 2.234 s | 2.172 s | 2.8% | −266.6 MiB |

The paired median CPU reduction is **10.3%**, with all four pairs improving. The wide range limits precision. Counters cover the entire browser tree, including terminated children, worker/renderer and GPU-process host work, request transport, hashing and diagnostics. They exclude initialization, the controller and fixture server. All observed browser processes belong to the measured job.

Commitment peaks rise in three pairs and fall in one. The paired median change is a **42.5 MiB increase**. These high-water marks include initialization and are not resident physical RAM. The candidate retains about 1.93 MiB of conversion capacity in this workload, but the much larger whole-browser peak changes cannot be attributed to that capacity alone. No whole-browser memory improvement is established.

Main retained GPU plans remain at 102,725,784 bytes, and both versions replay the last unconditional plan. Main GPU weights remain at 1,225,154,680 bytes. This change reduces host work; it makes no GPU arithmetic, complete-VRAM or energy claim.

## Correctness and failure controls

All **1,513 engine/TTS/reader tests across 133 files** pass, along with strict/boundary types, changed-file lint, the production build, native source/binary checks, browser artifact checks and whitespace checks. Six new unit cases cover all 256 byte values, shape/type/count checks, caller mutation, capacity growth/shrinkage, the total retention limit, oversized and invalid growth, independent callers, overlapping byte views, unchanged returned outputs, cached replay, session isolation and disposal. The final isolated harness also checks all 256 values against four implementations, 1,024 acceptance checks total.

Three native control groups pass on both NVIDIA Blackwell and Intel Xe-LPG. They cover arbitrary masks through boolean/Where operations, alternating shape replay and old output preservation; caller mutation after upload, rejection of concurrent same-session inference, and invalid-first/last-byte recovery; overlapping storage and concurrent unrelated-session isolation. All resources are released without GPU validation errors.

All **192 generated-row half-logit tensors across 96 diffusion steps** match exactly: English, Swedish and Arabic on NVIDIA, plus English on Intel. Corresponding codes, raw PCM and WAVs match. The prepared graph remains `8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb` on both sides. All 17 packaged speech pairs and eight long-request pairs retain exact float32 PCM, length and sample rate; packaged speaker identity also matches. Eight Kokoro CPU/GPU cold/warm controls preserve previous PCM, feeds and chunk boundaries.

The generic native precision matrix is not repeated because shaders and native arithmetic are unchanged. The native boolean/error/replay controls and complete generated logits exercise the affected feed path directly.

## Continuous playback and remaining qualification

The final package passes **300.3 seconds** of varied-paragraph playback: **38 complete clips, 38 prepared handoffs and zero unprepared waits**. Added render gaps have p95 and maximum 13.3 ms; minimum source/capture correlation is 0.99999986. All 65 native accounting observations remain within the enforced 6 GiB browser-job ceiling, with a 5,095,895,040-byte commitment peak. Stop and cleanup checks pass. Audio remains muted, so this verifies render-thread continuity and excludes OS/audio-device routing.

Reproduction scripts, baseline/candidate source snapshots, raw timings, reports and preserved failed fixture logs are in the ignored `artifacts/boolean-feeds-20261031/` directory. `summary.json` asserts exact logits/audio, source pins, allocation counts, native cleanup, process membership, memory limits and waveform checks before deriving results. `verification.json` binds those results to the current source, measured worker, reachable runtime modules and final checks. Timed work runs serially under the existing measurement lock; unit/build checks run separately.

The host has a Core Ultra 9 285K, about 63.3 GiB RAM and an RTX 5090 with nominal 32 GiB VRAM. Unrelated GPU activity prevents exclusive-host or energy claims. Intel Xe-LPG supplies further correctness evidence. Physical 8 GiB RAM/VRAM PCs, weaker dedicated GPUs, audio-device continuity and the wider PDF/OCR workload remain unverified.
