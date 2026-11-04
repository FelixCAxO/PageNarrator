# Matrix vectors and grouped traversal: rejected full-request tradeoff

This follows the accepted [direct head-layout normalization](norm-transpose-20261101.md). It investigates the dominant matrix calculations using two vector-storage variants, three unconditional tile orders and one guarded order. All **400 native controls** preserve exact output bits and release their resources. The guarded prototype also preserves all **eight paired long-request PCM outputs**. Nevertheless, it increases browser CPU in three pairs and ties in one, with a **5.69% paired median increase** and a 7.33% aggregate increase. The candidates are rejected. Application source, the accepted build and the preceding validated behavior remain unchanged.

## Follow the calculation and memory access

The accepted packed half matrix kernel computes a 16×16 output tile with an 8×8 workgroup. Each lane accumulates four float32 results. Each packed word carries two half values; input pairs become float32 values in shared storage. The dot-product loop visits K in its original order and narrows to half only when storing its outputs.

The first candidate stores the right-hand pair as `vec2<f32>` and loads both components together. The second also holds each adjacent output pair in a vector accumulator. These forms retain the same float32 products, ordered sums, tile size, bindings, dispatch dimensions and half rounding. Shared storage remains 2,048 declared bytes; global buffer capacities stay unchanged. Shorter shader source and fewer source-level statements do not establish fewer GPU instructions or lower compute cost. The representative timing differences are too small or mixed to justify adoption.

The next three candidates change the workgroup-to-output-tile mapping. They visit four, eight or sixteen row tiles for the same column region before moving onward, seeking better weight-cache reuse. Each output tile still executes the original arithmetic. A CPU proof checks 240 shape/group combinations and 284,130 mapped tiles: every destination tile is in bounds and is visited exactly once. Workgroup Z, batched broadcasting, tails and the original scalar fallback remain intact. Actual hardware scheduling and cache traffic are not assumed from this mapping.

Unconditional grouping improves some projections but regresses Intel down-projections, by about 26–31% for the larger groups. The final guarded prototype uses four-row grouping only when **K ≥ 512 and N > K**. Its uniform size predicate retains the original order for attention, square and contracting matrices. This is a performance hypothesis derived from the first controls; it adds no new GPU feature requirement. The follow-up includes ten extra threshold and shape controls, including 510/512 inner widths, square/contracting cases, long QKV/down matrices and row counts 511/512/513. A branch retaining the old order can still change compiler scheduling, so its ungrouped shapes are measured too.

## Native A/B controls

Both NVIDIA Blackwell and Intel Xe-LPG execute 60 vector-series controls, 80 unconditional-group controls and 60 guarded-series controls: **200 per adapter, 400 total**. These include unchanged-code variants as well as local original/original timing controls. They cover empty output and inner dimensions, every finite half bit pattern through a conversion/identity case, odd fallbacks, even tails, multidimensional broadcasting, cancellation, half-output overflow and production-sized matrices. Eligible candidate dispatches, fallback choice, buffer capacity, exact output bits, GPU errors and cleanup are checked.

Five interleaved ABBA/BAAB timestamp pairs follow five original/original controls. Blocks target approximately 8 ms with bounded repetitions. Every interval must be positive and the control median must stay within 5% before a row supports a speed claim. Invalid rows remain in the raw reports. This diagnostic screen is not a statistical confidence interval, exclusive-host measurement or full-application acceptance gate.

Positive percentages below indicate time reductions; negative percentages indicate regressions. QKV uses M=192, K=1,024, N=2,048; down uses M=320, K=3,072, N=1,024; head uses M=77, K=1,024, N=8,200.

| Variant | NVIDIA QKV | Intel QKV | NVIDIA down | Intel down | NVIDIA head | Intel head |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| right-vector | 0.40% | 0.74% | 0.39% | 0.29% | 0.00% | 0.58% |
| vector-accumulation | -0.41% | 1.48% | 0.00% | 1.46% | -0.39% | 0.87% |
| group4 | 8.98% | 4.04% | 5.62% | -4.06% | -2.05% | 4.00% |
| group8 | 4.82% | 5.56% | 4.05% | -25.58% | -6.33% | 2.59% |
| group16 | 6.43% | 5.88% | 3.08% | -31.10% | -5.86% | 3.71% |
| group4-guarded | 8.43% | 3.35% | 2.83% | 1.17% | -2.45% | 3.19% |

The complete shape data, including the guarded long and threshold rows, remain in the summary and raw interval reports. Grouping changes locality opportunities; it removes no matrix multiply-adds, GPU dispatches or tensor allocations.

## Complete-request comparison

Only the guarded candidate proceeds to full synthesis. An artifact-only extension build overrides `webgpu-shaders.js`. Four fresh-browser pairs alternate execution order on the RTX 5090 and synthesize the fixed long paragraph at 24 steps followed by 12 steps. All eight candidate PCM hashes, lengths and sample rates match their baseline. A dependency walk pins both executed workers and verifies that the guarded source is reachable in the candidate worker graph and absent from the accepted baseline graph.

Every accounting observation remains under the enforced 6 GiB browser-job commitment cap and requires verified process membership, retaining only the existing listed-in-job/closed-process exception for error 87. The accounting logic is unchanged.

| Pair | Browser CPU reduction | First request reduction | Following request reduction | Peak commitment saved |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.00% | 5.21% | 1.31% | 2.86 MiB |
| 2 | -5.34% | -0.58% | 0.49% | 295.18 MiB |
| 3 | -18.70% | -2.46% | 0.99% | 283.11 MiB |
| 4 | -6.04% | -4.35% | 1.47% | 75.54 MiB |

Across these pairs, first-request latency is **1.52% slower at the paired median**. Following requests improve in all four pairs, with a 1.15% paired median reduction. All pairs, including the faster first request in pair 1, remain in the decision. Paired medians compare corresponding runs; a ratio of separately aggregated medians can differ.

Browser-job commitment peaks are lower in all four candidate pairs, with a 179.33 MiB median difference. This observation is retained, but it does not establish lower resident physical RAM or explain a buffer-lifetime saving. Both variants retain exactly **63,096,452 B** in their two main GPU plans, with 2,826 selected main nodes. Decoder cold/repeat intermediate allocation stays **402,753,376 / 175,106,048 B**, and no decoder GPU plan remains retained. Model graph, weights, seeds, diffusion steps, CPU transport and resource limits are unchanged. The increased CPU and slower first-request median outweigh the small following-request gain for the current continuous-reading compute target.

CPU counters include Windows job user/kernel time for the browser, worker/renderer and GPU-process host work around synthesis, including request transport, PCM hashing and diagnostics. They exclude initialization, the controller and fixture server; commitment peaks include startup. Engine-owned GPU buffer capacity is not adapter VRAM residency. No PageNarrator power or energy claim follows from these experiments.

## Preserved application and next evidence

Source pins and a complete accepted-build hash check link this unchanged application to the preceding **1,654 passing tests**, 288 native logit comparisons, exact speech/Kokoro controls and five-minute zero-unprepared-wait playback result. Those broad application checks are not repeated for the rejected prototypes. No full-language native-logit, packaged-short-speech or new sustained-playback qualification is claimed for the candidate.

After all benchmark browsers closed, a separate ordinary-browser inventory reads the available feature names and adapter limits without creating a GPU device or changing application settings. Both tested adapters advertise `subgroups` and `subgroup-size-control`. Those names are a concrete input to a future subgroup experiment; the inventory establishes no matrix-instruction capability, speed, exact arithmetic or support on other PCs. The accepted portable kernel remains in place.

Physical 8 GiB RAM/VRAM PCs, weaker dedicated GPUs, device audio, energy and broad PDF/OCR remain unqualified. The broader goal remains active.

## Evidence

- Verified summary (`artifacts/vector-matmul-20261101/summary.json`), tile-map proof (`artifacts/vector-matmul-20261101/tile-mapping-proof.json`), raw whole-request pairs (`artifacts/vector-matmul-20261101/long-speech-resources.json`), current feature inventory (`artifacts/vector-matmul-20261101/gpu-capabilities.json`).
- NVIDIA vectors (`artifacts/vector-matmul-20261101/micro-nvidia.json`), Intel vectors (`artifacts/vector-matmul-20261101/micro-intel.json`), NVIDIA groups (`artifacts/vector-matmul-20261101/group-micro-nvidia.json`), Intel groups (`artifacts/vector-matmul-20261101/group-micro-intel.json`).
- NVIDIA guarded (`artifacts/vector-matmul-20261101/guarded-micro-nvidia.json`), Intel guarded (`artifacts/vector-matmul-20261101/guarded-micro-intel.json`), preserved application verification (`artifacts/norm-transpose-20261101/verification.json`).
