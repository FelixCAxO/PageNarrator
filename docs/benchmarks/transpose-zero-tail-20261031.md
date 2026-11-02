# Reject transposed-convolution tail fusion after whole-app A/B

The candidate passed exact-output checks and reduced one GPU stage's allocation, but **was rejected and removed**. Browser commitment peaks rose by **164.2 MiB** at the paired median, browser CPU rose **2.3%**, and request timings were mixed. The previous [direct decoder zero-tail implementation](decoder-zero-tail-20261031.md) is restored byte for byte and remains the application baseline.

## Candidate and scoped GPU result

The remaining decoder Pad extends a transposed-convolution result from `[1,256,18999]` to `[1,256,19000]`. The candidate writes the final positive-zero feature position directly from the stride-phase shader. Valid columns retain their weights, bias, output-padding attributes and accumulation sequence. The appended value is literal positive zero even when bias would be nonzero.

Fusion requires a private, unobserved pre-pad result, a known float32 one-dimensional path, unit kernel dilation, the exact right-pad vector, and default or explicit scalar positive zero. Changed modes, values, axes, domains, attributes, unknown shapes and unsupported backends keep the original path. The candidate adds a separate prepared pipeline; all four existing convolution shader texts remain unchanged.

| GPU observation | Baseline | Candidate |
| --- | ---: | ---: |
| Large stage allocation | 38,910,976 bytes | 19,456,000 bytes |
| Large stage dispatches | 2 | 1 |
| Full decoder allocated capacity | 402,753,376 bytes | 383,298,400 bytes |
| Full decoder allocations | 15 | 14 |
| Planned decoder nodes | 679 | 678 |
| Maximum active intermediate capacity | 175,119,200 bytes | 175,119,200 bytes |

The candidate removes **18.55 MiB** of allocated capacity. It leaves the later active-capacity maximum unchanged. Engine capacity is not complete resident VRAM.

Thirteen native cases per architecture cover batch/group handling, channel tails, stride phases with no contributing taps, kernel/tile boundaries, signed zero, mixed scales, bias omission and nonzero underlying output padding. All float32 bits match on NVIDIA Blackwell and Intel Xe-LPG. The actual large case uses 512 input channels, 256 output channels, width 3,800, kernel 10, stride 5 and symmetric padding 3.

Five interleaved ABBA/BAAB timestamp pairs per case include original/original controls. The large stage records 7.3% less GPU time on NVIDIA and 1.4% less on Intel, with passing noise screens. One smaller NVIDIA row fails its screen and is excluded from timing claims while retaining correctness evidence. These are isolated stage results; they do not establish a whole-app win.

## Whole-app result and rejection

Four counterbalanced resource pairs measure two long requests under an enforced 6 GiB browser-job commitment limit:

| Pair | Baseline CPU | Candidate CPU | CPU reduction | Commitment peak increase |
| --- | ---: | ---: | ---: | ---: |
| 1 | 2.250 s | 2.219 s | 1.4% | 212.1 MiB |
| 2 | 2.109 s | 2.234 s | −5.9% | −1.0 MiB |
| 3 | 2.000 s | 2.250 s | −12.5% | 287.7 MiB |
| 4 | 2.313 s | 2.141 s | 7.4% | 116.2 MiB |

CPU rises in two pairs and falls in two, with a paired median **2.3% increase**. Commitment peaks rise in three pairs, with a paired median **164.2 MiB increase**. Counters cover the full browser tree, including terminated children and GPU-process host work, request transport, hashing and diagnostics. Initialization, the controller and fixture server are excluded from CPU deltas. All observed browser processes are covered by the same job.

Commitment high-water marks include initialization and are not resident physical RAM. The measurements do not establish how much of the increase comes from compilation, allocation behavior or other browser/driver variation. The isolated GPU saving does not justify retaining the candidate given these whole-app results and unchanged active-capacity maximum.

| Request | Baseline median | Candidate median | Paired median time reduction |
| --- | ---: | ---: | ---: |
| Short first / 24 steps | 1803.9 ms | 1783.5 ms | 1.0% |
| Short following / 12 steps | 935.6 ms | 933.6 ms | 0.2% |
| Long first / 24 steps | 3731.4 ms | 3665.6 ms | 1.9% |
| Long following / 12 steps | 1782.5 ms | 1796.5 ms | −1.1% |

Pairs remain mixed; the following long request slows in three pairs. All pairs and startup observations remain in the raw summary, including the unusually slow first baseline initialization. No general latency or initialization gain is claimed. Percentages compare this candidate only with its immediate baseline and are not added to earlier results.

## Correctness and restoration

Candidate correctness passes: 1,574 engine/TTS/reader tests across 135 files, including 24 new transposed-tail guard cases; strict/boundary types, changed-file lint, build, native source/binary checks, browser artifact checks and whitespace. All 66 native precision/error/recovery cases pass on each GPU. All 192 generated-row half-logit tensors across 96 diffusion steps match exactly, with corresponding codes, returned raw PCM and WAVs. All 17 packaged speech pairs, eight long-request pairs and eight Kokoro CPU/GPU cold/warm controls retain their expected exact outputs.

The candidate also passes 300.3 seconds of muted render-thread playback: 38 complete clips, 38 prepared handoffs and zero unprepared waits. Added render gaps have p95/maximum 13.3 ms. All 65 native accounting observations remain under the 6 GiB job limit; peak commitment is 5,068,312,576 bytes. Correct playback does not override the unfavorable resource result.

Before restoration, the candidate package, four source snapshots and added test were preserved with their measured hashes. Restoration checks the current files against those candidate hashes before writing the baseline snapshots, then removes only the measured candidate test. The restored source exactly matches the prior validated baseline. Its **1,550 tests across 134 files**, strict/boundary types, lint, build and whitespace checks pass again. The rebuilt OmniVoice worker and every reachable runtime module match the measured baseline package byte for byte. Playback is not repeated after restoration because the restored package matches that previously validated baseline.

Evidence lives in ignored `artifacts/transpose-zero-tail-20261031/`: `summary.json` and `verification.json` describe the measured candidate, while `restoration-verification.json` verifies the current restored application. Candidate source/package evidence is retained; the new pipeline and rewrite are absent from current application source.

## Larger next target

An offline replay of the restored baseline trace follows all 133 output intervals and their view lifetimes. A descending-size interval assignment fits them into three 58,368,000-byte slots and one 2,048-byte slot: **175,106,048 bytes** instead of 402,753,376 allocated bytes. Three small self-checks and pairwise non-overlap/capacity assertions pass. This is a diagnostic hypothesis, not an implemented allocator or measured runtime saving. Real ownership checks, dynamic-shape fallback, metadata boundaries, concurrency and cleanup still need validation.

The production loader already shares one GPU engine between the model and decoder, and pipeline preparation is cached. Duplicated device initialization is therefore not the next target. Investigating allocation placement offers a larger opportunity than retaining another small shader variant with unfavorable whole-app measurements.

The host is a Core Ultra 9 / RTX 5090 with about 63.3 GiB RAM and nominal 32 GiB VRAM, with unrelated GPU activity. Intel provides additional native controls. Physical 8 GiB RAM/VRAM PCs, weaker dedicated GPUs, audio-device output, energy and broader PDF/OCR qualification remain unverified.
