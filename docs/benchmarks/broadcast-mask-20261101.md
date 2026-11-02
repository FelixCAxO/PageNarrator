# Broadcast the constant attention mask — 1 November 2026

The selected two-module change reduces pooled browser CPU by **8.55%** in four paired long-speech workloads and saves **2.78 MiB of retained main GPU workspace**. All corresponding audio remains exact. Five-minute muted playback passes under a 5 GiB browser Job commitment cap, with 38 completed clips, zero unprepared handoffs and 13.33 ms maximum added gap. Whole-browser peak commitment remains mixed; physical 8 GiB hardware remains unqualified.

## Remove repeated data, preserve the calculation

OmniVoice recomputes its complete bidirectional sequence. Its runtime previously supplied an attention mask containing length² identical boolean ones. Each diffusion pass validated and widened this dense input, uploaded it and converted it for attention.

The runtime now supplies one boolean value with shape [1,1,1,1]. The graph's cast and addition broadcast it across every head and position under the existing [ONNX broadcasting rules](https://onnx.ai/onnx/repo-docs/Broadcasting.html). Each score still receives the original +1 after half-rounded scaling. Keeping that addition preserves the existing half-rounding behavior.

The existing fused scaled/masked softmax already addresses its mask with index modulo mask length. A narrow shape-guard change admits the one-element 4-D mask, so every lookup selects its sole value. Full-size masks retain their existing path; other shapes retain the ordinary fallback. No shader, model graph, weight, matrix accumulation, frame position, sampling rule or diffusion step changes. The lifecycle proof now checks the compact mask's exact shape and value, and the runtime test retains its complete-position assertions.

Input-mask storage and validation fall from quadratic size to one element. The measured paragraph uses conditional/unconditional lengths 710 and 475: their two source masks contain 729,725 bytes before this change and two bytes afterward. The GPU widens boolean storage to four bytes per element; the corresponding reduction is exactly 4 × (729,725 − 2) = 2,918,892 bytes. That allocation calculation is distinct from measured browser commitment.

## Full-request A/B

Four fresh-browser pairs alternate execution order. Each browser synthesizes the same 19-second paragraph once at 24 steps, followed by six 12-step requests. All **28 corresponding PCM comparisons are exact**. Browser Job user plus kernel time covers synthesis and host work in the worker, renderer and GPU process; it excludes initialization, controller and fixture server. Peak commitment includes initialization. All 112 before/after observations satisfy the unchanged strict process-membership predicate and the same 6 GiB cap.

Positive percentages mean lower cost. Warm latency is the median of six corresponding comparisons within each pair.

| Pair | First latency | Warm latency | All-request CPU | Warm CPU |
| --- | ---: | ---: | ---: | ---: |
| 1 | -1.37% | -0.04% | -3.80% | -0.41% |
| 2 | 3.55% | 2.06% | 14.65% | 19.63% |
| 3 | 1.94% | 1.88% | 11.99% | 16.54% |
| 4 | 2.65% | 1.54% | 10.11% | 2.33% |

Paired median first/warm latency reductions are **2.29% / 1.71%**. All-request CPU improves in three pairs: paired median reduction **11.05%**, pooled reduction **8.55%**. Warm CPU reductions are 9.44% paired median and 9.89% pooled. These are development-host measurements, with one slightly worse pair; they are not universal speedups or energy measurements.

Retained main GPU workspace falls from **63,096,452 to 60,177,560 bytes**, a 2,918,892-byte saving. Decoder retention remains zero. Cold/repeated decoder intermediate capacity remains 402,753,376 / 175,106,048 bytes. Peak browser commitment improves in two pairs and worsens in two, with a paired median increase of 25.43 MiB. No reduction in resident RAM, total VRAM or whole-browser peak requirement is established.

## Qualification

- 1,668 engine/TTS/reader tests across 142 files pass, plus strict/boundary types, changed-file lint, production build, native source/binary checks, browser artifact checks and whitespace checks. The initial lint run caught an unused lifecycle-helper variable; removing it resolved lint without changing behavior.
- NVIDIA and Intel each pass 16 new GPU comparisons against separate half scaling, dense-mask addition and softmax. These cover all 63,488 finite half values, signed zero, nonzero constants, odd dimensions and short/long shapes. GPU errors and retained test resources are zero.
- All **288 actual diffusion-step half-logit tensors** match their dense-mask baseline within each adapter. Six source recordings preserve decoder codes, float32 PCM hashes and WAV bytes. Generic arithmetic/shader qualification is inherited through unchanged source pins.
- All **17 packaged speech pairs** preserve PCM and speaker metadata, including multiple languages, variation, whisper, restart recovery and a long paragraph.
- Production's complete reachable TTS worker dependency graph is byte-identical to the measured prototype. Non-target engine/TTS sources and native pins remain unchanged. Separate PDF changes in the shared workspace are preserved; whole-extension byte identity is not claimed.

The five-minute run lasts **300.41 seconds** at the enforced 5 GiB cap. Its 66 final process observations pass strict membership and cap checks. Peak Job commitment is **4,808,355,840 bytes (4.48 GiB)**. All 38 handoffs are prepared. Independent render-thread waveform alignment passes with minimum correlation 0.999999861 and maximum/p95 added gap 13.33 ms. All 38 completed source WAVs match the previous accepted five-minute run. Physical output remains muted; OS/device routing is outside this proof.

## Investigation and remaining work

An instrumented real-request trace records 60.39 ms of feed normalization across 70 cached passes, about 1.80% of their 3,352.20 ms elapsed inference intervals. Integer conversion alone is only part of that work. Inspecting the dense boolean feed led to this broadcast change. These diagnostic intervals include observer overhead and are not CPU-seconds attribution.

A separate matrix/residual fusion preserves exact bits in eight cases on each GPU, including an intermediate-rounding witness. It removes a dispatch and intermediate allocation, but stage speed is mixed or flat and short NVIDIA work regresses. It is rejected without application integration. Its initial tiny zero-duration timing intervals remain excluded. The earlier [sampler round](confidence-maximum-20261101.md) is also preserved as a rejected result.

Ignored artifacts/broadcast-mask-20261101/ holds source/package snapshots, raw costs, native checks, parity, playback, waveform analysis, summaries and verifiers. Earlier feed and residual probes remain in their own artifact directories. Builds and measurements use the host-wide measurement lock and run serially.

Only the current Ultra 9 / RTX 5090 PC is available, with Intel Xe-LPG controls. Browser commitment is not resident RAM or total VRAM. Physical 8 GiB RAM/VRAM, weaker dedicated GPUs, energy and real device audio remain unqualified. The earlier intermittent inference-stall cause remains unresolved. The goal remains active; next, trace whether full-replacement passes still upload KV-cache data that GPU commands never consume.
