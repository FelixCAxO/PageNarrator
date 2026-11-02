# Decoder windows: exact memory prototype, compute regression

This iteration follows the [half-cast alias improvement](cast-alias-20261031.md). The current application stays unchanged. An artifact-only windowed decoder reduces peak intermediate allocation and browser commitment, but adds convolution work, increases paired-median job CPU and usually slows the following request. It is rejected for the current compute-cost goal.

## Inspect the dependency before changing execution

The decoder is pinned to SHA-256 `12ddfca66e030e9ece90106d117a9b61ea25e64e510ca4c677e65d6ecabb9cc2`. The optimized graph contains 37 convolution operators, 36 pointwise Snake activations and residual additions. The only reduction belongs to the quantizer; there is no acoustic global normalization or Fourier transform in the inspected graph.

The acoustic stages upsample by 8, 5, 4, 2 and 3, producing 960 samples per code frame. Residual dilations 1, 3 and 9 give a radius of 39 at each stage. Propagating convolution dependency intervals backwards over all 960 output phases gives a conservative ten-code-frame context on each side. Right-tail constants cannot enlarge that dependence. The calculation script checks the pinned convolution kernels, padding, dilations and strides; its stated scope leaves quantizer locality to graph inspection and full-model comparison rather than claiming a generic ONNX streaming theorem.

The prototype slices code frames with ten frames of context, runs the original complete decoder on each window, then copies only the central output samples. First and last windows keep the original model boundary. It uses the same weights, shaders, operator order, precision, main transformer and sampler. It does not blend samples or introduce a crossfade.

## Exactness and allocation

Sixteen frame counts from 1 through 719 cover small inputs, window boundaries and requests up to 28.76 seconds. The 128-frame variant matches every float32 output bit on NVIDIA and Intel. A 96-frame variant matches all sixteen NVIDIA cases. All 48 comparisons validate output lengths and clean up every engine tensor/buffer without GPU validation errors.

For the 475-frame, 19-second decoder case:

| Adapter / output window | Exact cases | Full cold allocation, bytes | Maximum window allocation, bytes | Input frames processed |
| --- | ---: | ---: | ---: | ---: |
| nvidia / 128 frames | 16 | 402,753,376 | 125,488,768 | 535 |
| nvidia / 96 frames | 16 | 402,753,376 | 98,830,976 | 555 |
| intel / 128 frames | 16 | 402,753,376 | 125,488,768 | 535 |

The 128-frame variant processes 535 frames to produce 475 central frames, adding **12.63%** decoded-frame work. The 96-frame variant processes 555, adding **16.84%**. These are algorithmic work counts, not measured physical GPU memory-bus traffic or power. Model weights remain outside the intermediate table. Engine allocation capacity is not total resident VRAM.

Smaller captures also change retention: the 128-frame prototype finishes this request with about 86 MB of retained decoder-plan storage; the full long decode retains zero GPU decoder plans. Thus lower peak temporary capacity does not imply lower idle allocation. The existing 128 MiB cache budget is preserved.

## Packaged counterbalanced cost

The candidate is built into a separate extension with a Vite source override; source files and the current application bundle remain byte-identical to the preceding accepted version. Four counterbalanced pairs synthesize the same 19-second paragraph at 24 and then 12 steps. All eight paired request outputs preserve exact PCM, sample rate and length. The original six-GiB job ceiling and strict browser-process membership gate pass every before/after observation.

| Request | Baseline median | Candidate median | Paired median time reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| First / 24 steps | 4272.50 ms | 4158.83 ms | 2.41% | -1.25–3.24% |
| Following / 12 steps | 2078.76 ms | 2101.21 ms | -2.19% | -2.32–2.23% |

Paired median whole-job user+kernel CPU reduction is **-3.19%**; negative means higher CPU. Three pairs regress and one improves, with a reduction range of -28.57–9.76%. CPU counters include worker/renderer/GPU-process host work, transport and diagnostics, excluding initialization and the controller/fixture server. They have substantial host variability.

Peak job commitment is lower in all four pairs, with a median saving of **58.17 MiB** and range 42.46–85.04 MiB. Kernel peaks include initialization. Commitment is not resident physical RAM, and this development host has variable unrelated activity.

First-request timing improves in three pairs, while following-request timing regresses in three. The repeated 148-frame interior window in the 475-frame native test also misses its cache despite having the same shape. Integer range validation stays enabled; the direct main-model trace below independently isolates range-triggered misses. The experiment does not add artificial input sentinels or weaken bounds checking to improve a benchmark.

## Decision and remaining scope

The current variant trades lower transient memory for overlapping convolution work, more decoder calls, higher paired-median CPU and larger retained idle decoder storage. It is not installed in production. Current `dist` and all previously verified application sources are checked against the preceding accepted source/bundle hashes. The accepted runtime remains the half-cast alias version, with its prior exact-speech and sustained-playback evidence.

No new production tests or five-minute acceptance run is claimed for this rejected prototype. Its scripts contain assert-based controls, and it passes 48 full-model bit comparisons plus eight packaged request pairs. Raw RF analysis, native controls, source overrides, bundle hashes and job accounting are preserved in `artifacts/decoder-window-20261031/`.

A separate trace of the unchanged accepted main model confirms four extra rebuilds after its two initial captures. All four have an existing cache key and an expanded input_ids range: the minimum falls from 1024 to 176, then 59, 54 and 2, while the maximum remains 1024. Its codes, PCM and WAV match the preceding accepted English output exactly. Trace timing is excluded from performance claims.

These range-related capture misses provide a concrete next profiling target. Any replay optimization must prove that expanded input ranges preserve integer-overflow and index-validation requirements; skipping invalidation on the strength of these valid examples would be unsafe.

Physical 8 GiB RAM/8 GiB VRAM machines, weaker dedicated GPUs, device audio and broad PDF/OCR workloads remain unqualified. The continuous-playback hardware goal remains active.
