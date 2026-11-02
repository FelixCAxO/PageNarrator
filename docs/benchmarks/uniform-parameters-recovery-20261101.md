# Uniform parameters after continuity requalification — 1 November 2026

The selected two-module change reduces paired median long-request latency by **5.10%** on first requests and **6.93%** on warm requests. All 24 warm comparisons improve; one of four first requests is 2.31% slower. Exact output and five-minute playback pass at a **5 GiB browser Job commitment cap**. CPU savings remain unproved, and retained GPU allocation stays unchanged.

This follows the [deferred uniform-parameter experiment](uniform-parameters-20261101.md). Its failed runs and source snapshots remain intact. Qualification is now recovered; the original stall cause remains unresolved.

## Implementation and calculation

Packed half matrix multiplication reads its 32 dispatch integers through a uniform binding, using eight vec4 slots. The same host payload remains 128 bytes: offset(i)=16×floor(i/4)+4×(i mod 4)=4i. No CPU repacking is added. The vec4 stride satisfies the ordinary [WGSL uniform-layout rules](https://www.w3.org/TR/WGSL/#address-space-layout-constraints), including implementations without uniform_buffer_standard_layout.

The dispatcher chooses UNIFORM|COPY_DST only when the pipeline is the packed matrix pipeline. Every other pipeline keeps STORAGE|COPY_DST. This narrows the earlier prototype, which unnecessarily added uniform capability to all parameter buffers, including decoder buffers. The selected variant removes that extra capability; the measurements do not establish a causal CPU saving from this refinement.

The output tile, workgroup geometry, ordered FP32 accumulation, half rounding, batching, input validation, model, steps, sampling and caches are unchanged. Other shader exports remain byte-identical. The existing odd-dimension and other-dtype paths remain intact. This optimizes how constants reach the shader; it does not reduce matrix arithmetic or establish an energy saving. No subgroup code or feature request is added.

## Controlled cost comparison

Four fresh-browser pairs reverse baseline/candidate order on alternating pairs. Each browser runs one 24-step paragraph and six following 12-step requests. All 28 corresponding outputs are exact. Browser CPU includes Job user and kernel time around synthesis and excludes model initialization and the controller. Peak Job commitment includes initialization. Both sides use the same text, seed, graph, weights and 6 GiB measurement cap. Actual executed worker dependency graphs are pinned; the selected branch is present only in the candidate graph.

Positive percentages mean lower cost. Warm latency is the paired median across six corresponding warm requests within each browser pair. CPU columns compare totals, not clock time.

| Pair | First latency | Warm latency | All-request CPU | Warm CPU | Peak commitment saved |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 4.91% | 7.94% | -14.20% | -5.74% | 304.89 MiB |
| 2 | 5.30% | 5.92% | 12.40% | 6.20% | 24.83 MiB |
| 3 | -2.31% | 5.38% | 3.27% | 0.74% | -20.38 MiB |
| 4 | 7.16% | 8.03% | 5.17% | 0.35% | -36.90 MiB |

CPU results remain mixed: all-request paired median reduction 4.22%, pooled reduction 2.30%; warm paired median 0.55%, pooled 0.47%. Three CPU pairs improve and one worsens. Warm CPU is approximately flat, so no reliable CPU saving is claimed. Earlier union-usage cohorts remain separately recorded; percentages from different variants are not added.

Peak commitment improves in two pairs and worsens in two. The median saving is only 2.22 MiB. Retained main workspace remains exactly 63,096,452 bytes; decoder retention remains zero. Cold and repeated decoder temporary capacity remain 402,753,376 and 175,106,048 bytes. These are allocation/commitment observations, not resident RAM or total adapter VRAM measurements.

## Playback and stricter memory proxy

| Run | Cap | Seconds | Completed clips | Unprepared waits | Maximum added gap | Peak Job commitment |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| recovered-baseline | 6 GiB | 301.26 | 38 | 0 | 13.33 ms | 4.47 GiB |
| recovered-candidate | 6 GiB | 301.20 | 38 | 0 | 13.33 ms | 4.49 GiB |
| selective-5gib | 5 GiB | 300.72 | 38 | 0 | 21.33 ms | 4.48 GiB |

The final selective variant completes 38 prepared handoffs at the 5 GiB cap. Independent render-thread waveform alignment passes, with minimum correlation 0.999999861. All 38 completed source WAV files are byte-identical between baseline, the recovered earlier prototype and the selected variant. Both the cap and the strict browser-process membership requirement hold throughout the accepted runs. Physical output stays muted.

## Investigate the earlier stalls

An artifact-only worker-message observer separates inference, token selection and decoding. In the failing restored build, some diffusion steps take 0.5–9 seconds while most take 60–80 ms. The matched-request median is 10100.58 ms. Decoding takes only about 20–27 ms; the long delays are inside the main inference call, which includes CPU preparation and GPU waits.

A deeper method observer records buffer creation, submission, mapping, queue completion and session calls. That run recovers to 1947.76 ms and passes its one-minute handoffs. A later plain worker also recovers, at 1952.60 ms. The first six source WAV files match exactly in all three runs, and the observer confirms NVIDIA selection. Its concurrent native-call durations overlap and are not added as components of latency.

Recovery without an application edit prevents attributing it to the instrumentation. The observations do not isolate the original cause within inference. Separate Python processes previously observed on the host are later absent, but their causal contribution was not measured. No other process or host setting is changed. The earlier failures, including one strictly rejected transient process observation, remain failures; no threshold or membership exception is relaxed. The recovery is established by new baseline and candidate continuity evidence, not by reclassifying those failures.

## Validation and evidence

- 1,656 tests in 141 files, strict/boundary types, changed-file lint, production build, native source/binary checks and browser artifact checks pass.
- Both GPUs pass 19 exact kernel/resource cases and 13 timing self-checks. The allocation observer sees exactly the intended parameter usage values: 72 for uniform/copy-destination and 136 for storage/copy-destination. This is a correctness/control check; those mixed-kernel timings do not measure the selected shader against its packed baseline.
- Each GPU passes 66 WebGPU/C++ precision cases. All 288 full-step short/long half-logit tensors, native codes, PCM and WAV match the prior accepted baseline. All source-runtime controls clean up without device loss.
- Eight Kokoro CPU/GPU controls retain exact PCM, native inputs and chunks.
- Independent source proof checks all 32 parameter offsets, unchanged matrix arithmetic, legacy buffer usage, preserved test prefix and unchanged non-target sources.
- The complete production tree is byte-identical to the measured selective prototype. Actual worker graph hashes match the measured runs.

Ignored artifacts/continuity-profile-20261101/ contains the observers, raw timings, all cost cohorts, source and bundle proofs, native recordings/logit hashes, three successful five-minute captures, source snapshots, summary.json and verification.json. The earlier experiment retains its rejected subgroup variants and failed continuity captures. GPU measurements and builds use the host-wide measurement lock; timing checks are serialized.

## Remaining limits

One Ultra 9 / RTX 5090 development PC, with Intel Xe-LPG controls. The user has no other PC. Job commitment is not resident RAM, total system RAM or VRAM. Initial intermittent inference stalls disappear without an application fix; their cause remains unresolved. Physical 8 GiB RAM/VRAM, weaker dedicated GPUs, real device output and energy remain unqualified. The full goal remains active. The user explicitly confirms that only this PC is available. The 5 GiB cap is a tighter browser commitment proxy, not physical 8 GiB qualification. It does not bound total host RAM, GPU VRAM, other applications or OS overhead. Next work remains reducing actual matrix and CPU work without shifting cost into memory, and understanding environmental latency outliers. The full continuous-reading objective remains active.
