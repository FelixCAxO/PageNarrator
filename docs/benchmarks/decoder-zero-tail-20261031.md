# Write the decoder's zero tail inside convolution

This refines the [compact decoder upsampling A/B](decoder-workspace-20261031.md). The candidate eliminates the following one-position padding copy while preserving its literal positive-zero tail. It removes another **55.66 MiB of decoder temporary allocation** and returns the allocation count from 16 to 15. Paired browser CPU falls 2.0% at the median, but the range includes a large regression; whole-speech timings remain nearly flat.

## Preserve the tail's meaning

The previous candidate produces `[1,32,455999]`, then pads the final axis to `[1,32,456000]`. Its first result needs 58,367,872 bytes. That buffer is 128 bytes too small to serve subsequent 58,368,000-byte tensors, so it remains stranded in the batch's recycling pool. The output pad also reads and writes the full feature tensor.

The refinement writes the final positive-zero feature position directly from the convolution shader. Every valid convolution column retains its original weights, bias, padding, strides, dilation, groups and float32 accumulation sequence. The final position selects literal `0.0`, including when the computed value or bias would be nonzero. This preserves the reference Pad semantics. Ordinary convolution output padding would produce a different tail.

The ordinary and compact-input convolution shaders remain byte-identical to the immediate baseline. A separate shader variant changes only the output store. The larger output can require another GPU tile at tile-boundary widths; valid columns retain the same arithmetic. The large workload uses the same tile count on both sides. This optimization removes a materialization and transfer, without reducing precision or diffusion steps.

## Protect observable values and backend support

The existing zero-insertion rewrite retains all its shape, type, constant, domain and privacy guards. Tail fusion additionally requires the exact right-pad vector `[0,0,0,0,0,1]`, constant mode, and default or explicit scalar float32 positive zero. Changed axes, larger tails, edge mode, unknown attributes, dynamic padding, nonzero values, negative zero and nonscalar values retain the separate Pad.

The pre-pad convolution result must have one consumer and must not be a declared output. Public or shared pre-pad values remain available through the previous path. Fusion requires the prepared zero-tail pipeline; a backend exposing only compact convolution keeps its separate Pad, and CPU backends retain their original operations. The low-level flag must be boolean and requires compact zero-insert convolution. Existing ownership, channel/group, shape, spatial-option, bias and dispatch checks remain active.

No dependency, user setting, model/evaluation file, learned tensor, seed or sampler changes. The prepared main graph remains `8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb`. The change is confined to decoder execution planning and its output-store variant.

## Native A/B and full decoder allocation

Thirteen native cases per GPU compare compact convolution plus explicit padding with direct zero-tail output. Cases cover grouped/batched convolution, strides and kernel dilation, channel tails, differing insertion factors, signed zero, mixed scales, one-position input and widths crossing GPU tile boundaries. Every float32 output bit matches on NVIDIA Blackwell and Intel Xe-LPG, including positive-zero tails with nonzero bias.

The final source comparison uses five interleaved ABBA/BAAB timestamp pairs per row and original/original controls. Positive intervals and a median original/original ratio within 5% of one are required for a timing claim. All final rows pass the screen. Native resources are released without GPU validation errors.

| Large upsampling stage | Previous candidate | Refined candidate |
| --- | ---: | ---: |
| Intermediate allocation | 116,735,872 bytes | 58,368,000 bytes |
| GPU dispatches | 2 | 1 |
| NVIDIA paired median stage-time reduction | — | 11.1% |
| Intel paired median stage-time reduction | — | 4.9% |

The prototype was tested first on both architectures; the table uses the final production source. These stage measurements are scoped diagnostics, not full-speech speedups. The eliminated Pad avoids 58,368,000 bytes of logical destination writes per large decode; memory-bus traffic and energy are not measured.

A separate instrumented long-request trace records:

| Full decoder observation | Previous candidate | Refined candidate |
| --- | ---: | ---: |
| Planned nodes | 680 | 679 |
| Intermediate allocations | 16 | 15 |
| Allocated intermediate capacity | 461,121,248 bytes | 402,753,376 bytes |
| Maximum active intermediate-buffer capacity | 175,119,200 bytes | 175,119,200 bytes |
| Retained decoder plan bytes | 0 | 0 |
| Dynamic metadata readbacks | 0 | 0 |

Allocated capacity falls by **58,367,872 bytes**, about **55.66 MiB or 12.7%**. Active capacity is unchanged: three full-width feature buffers still coexist later in the decoder. The saving removes the stranded pre-pad buffer rather than lowering that later live-set requirement. Trace timings and process-memory observations are excluded from performance claims. Its codes, returned raw PCM and WAVs match the previous trace exactly.

The two traces run at different times, with the earlier trace bound to the baseline source snapshots. Current paired resource trials independently reproduce the same allocation/node counts in all eight long requests. The 128 MiB plan-cache limit is unchanged; the decoder remains uncached. Main retained plans remain at 102,725,784 bytes, and main/decoder GPU weights are unchanged. Engine capacity is not complete resident VRAM.

## Whole requests and browser accounting

Four counterbalanced packaged pairs measure two short requests; another four pairs measure two long requests under an enforced 6 GiB browser-job commitment ceiling. Timings exclude initialization and diagnostic instrumentation. Percentages compare this refinement with the immediate previous candidate, not the original materializing graph. They are not added to earlier percentages.

| Request | Baseline median | Refined median | Paired median time reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| Short first / 24 steps | 1808.7 ms | 1801.6 ms | 0.4% | −3.2–3.2% |
| Short following / 12 steps | 939.1 ms | 935.2 ms | 0.1% | −2.1–1.5% |
| Long first / 24 steps | 3621.7 ms | 3615.2 ms | 0.5% | −3.7–3.9% |
| Long following / 12 steps | 1786.1 ms | 1786.2 ms | −0.01% | −0.5–0.5% |

Timing pairs remain mixed, with no established general latency gain. Initialization pairs are 7,762→8,707, 7,430→7,528, 7,494→7,473 and 7,455→7,420 ms. The first initialization is substantially slower; no startup improvement is established.

| Long-request pair | Baseline browser CPU | Refined browser CPU | CPU reduction | Commitment peak saved |
| --- | ---: | ---: | ---: | ---: |
| 1 | 2.094 s | 2.547 s | −21.6% | 28.7 MiB |
| 2 | 2.313 s | 2.250 s | 2.7% | 44.2 MiB |
| 3 | 2.297 s | 2.266 s | 1.4% | 63.5 MiB |
| 4 | 2.516 s | 2.078 s | 17.4% | −0.6 MiB |

Browser CPU falls in three pairs, with a paired median **2.0% reduction**. The −21.6% to 17.4% range includes every pair and limits confidence in a fixed CPU saving. It does not prove that the earlier CPU regression is fully recovered. Counters cover the full browser tree, including terminated children, worker/renderer/GPU-process host work, request transport, hashing and diagnostics. Initialization, the controller and fixture server are excluded. Every observed browser process belongs to the measured job.

Commitment peaks fall in three pairs and rise by 0.64 MiB in one, with a paired median **36.4 MiB saving**. These high-water marks include initialization and do not measure resident physical RAM. The result is a scoped, mixed whole-browser observation rather than a fixed RAM guarantee.

## Correctness

All **1,550 engine/TTS/reader tests across 134 files** pass. The fusion test file now has 37 cases, including 13 new tail/privacy/value/backend guards. Strict and boundary types, changed-file lint, production build, native source/binary checks, browser artifact checks and whitespace checks pass. The shader self-check proves that both existing convolution variants retain their exact text and that the new variant matches the native-tested prototype.

All 66 native precision/error/recovery cases pass on each GPU, alongside the 13 direct-tail cases per architecture. All **192 generated-row half-logit tensors across 96 diffusion steps** match exactly: English, Swedish and Arabic on NVIDIA, plus English on Intel. Corresponding codes, returned raw PCM and WAVs match. All 17 packaged speech pairs and eight long-request pairs preserve exact float32 PCM, length and sample rate; packaged speaker identity also matches. Eight Kokoro CPU/GPU cold/warm controls retain previous PCM, feeds and chunk boundaries.

## Continuous playback and remaining qualification

The final package passes **300.4 seconds** of varied-paragraph playback: **38 complete clips, 38 prepared handoffs and zero unprepared waits**. Added render gaps have p95 and maximum 13.3 ms; minimum source/capture correlation is 0.99999986. All 65 native accounting observations remain within the enforced 6 GiB browser-job ceiling, with a 5,132,222,464-byte commitment peak. Stop and cleanup checks pass. Audio remains muted, so this verifies render-thread continuity and excludes OS/audio-device routing.

Reproduction scripts, source snapshots and raw reports are in the ignored `artifacts/decoder-zero-tail-20261031/` directory. `summary.json` asserts source pins, unchanged existing shaders, the new shader/prototype match, exact logits/audio, native cleanup, allocation counts, process membership, memory limits and waveform checks before deriving results. It also checks that the earlier diagnostic trace matches the current baseline source snapshots. `verification.json` binds the results to current source, the measured worker, reachable runtime modules and final checks. Timed work runs serially under the existing measurement lock; unit/build checks run separately.

The host has a Core Ultra 9 285K, about 63.3 GiB RAM and an RTX 5090 with nominal 32 GiB VRAM. Unrelated GPU activity prevents exclusive-host or energy claims. Intel Xe-LPG supplies additional native correctness and controlled-stage timing evidence. Physical 8 GiB RAM/VRAM PCs, weaker dedicated GPUs, audio-device continuity and the wider PDF/OCR workload remain unverified.
