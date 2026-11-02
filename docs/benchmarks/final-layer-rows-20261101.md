# Final feed-forward rows: exact GPU saving, rejected full-request tradeoff

This iteration follows the accepted [lookup-range cache improvement](index-range-20261031.md). It tests moving generated-audio row selection before the final transformer feed-forward block. The candidate preserves checked output exactly and speeds that isolated GPU block, but both complete-request comparisons show higher paired-median browser CPU. The single-pass version increases CPU in all four pairs, with an **8.28% paired median increase**. Retained GPU allocation stays unchanged. The candidate is rejected for the current compute-cost target; application source and the accepted extension remain unchanged.

## Follow the data dependency

OmniVoice uses full bidirectional attention. Prefix activations depend on changing audio tokens, so this experiment does not cache earlier prefix layers or omit their attention. In the final layer, after attention has already used every query, key and value, each feed-forward row and final normalization is independent of other sequence positions. Prefix rows are then discarded before the audio head.

The prototype moves the existing selection to the residual entering the final post-attention normalization. It computes the same two normalizations, three feed-forward matrices, SiLU gate and residual addition only for generated-audio rows. The later selection becomes Identity. Every retained row keeps its original arithmetic and rounding order; attention, weights, shapes at public interfaces, sampling, seeds and diffusion steps remain unchanged.

The prepared graph changes from `8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb` to artifact-only `075f9d84d8f27878928b50e1109f84997d96bf5d7df40e0157bb22deff9eef83`. The proof checks all learned tensors and public interfaces, the exact two changed node definitions, the one added Slice, the two relocated constants and unchanged other node definitions. Thirty-one stale internal value annotations are removed. The executed audio plan grows from 3,218 to 3,219 nodes, while the measured isolated block retains eight dispatches. Conditional and unconditional shapes still need only two captures.

## Measure the stage and its share of the full calculation

Seven native stage controls on each adapter cover whole-sequence selection, a single selected row, odd offsets, nearly full selection and the representative speech shapes. They use production half kernels and deterministic synthetic weights with pinned model dimensions: gate/up matrices of 1,024 × 3,072 and a down matrix of 3,072 × 1,024. Every selected output half bit matches. All tensors/buffers release normally, without GPU validation errors.

Five interleaved ABBA/BAAB timestamp pairs follow original/original controls. Only rows whose control median ratio stays within 5% support a speed claim. These repeated stage intervals are not ordinary application throughput, power or exclusive-host measurements:

| Adapter | Full rows → selected rows | Paired median stage time reduction | Full-stage allocated bytes | Selected-stage allocated bytes |
| --- | ---: | ---: | ---: | ---: |
| nvidia | 259 → 77 | 29.18% | 7,053,312 | 2,207,744 |
| nvidia | 710 → 475 | 29.43% | 19,875,840 | 13,619,200 |
| intel | 259 → 77 | 67.04% | 7,053,312 | 2,207,744 |
| intel | 710 → 475 | 39.82% | 19,875,840 | 13,619,200 |

Stage byte counts retain all stage intermediates for this isolated comparison. They are not the main model's pooled workspace or whole-process VRAM.

The matrix-work calculation reads the pinned learned dimensions, counts all 196 transformer projections, adds both generated-row audio heads and both full 28-layer attention branches, and derives actual request lengths using the tokenizer and speaker reference. The savings occur in just the three final conditional feed-forward projections:

| Request | Conditional / unconditional rows | Discarded conditional rows | Avoided matrix MAC pairs per diffusion step | Share of nominal main matrix work |
| --- | ---: | ---: | ---: | ---: |
| short | 259 / 77 | 182 | 1,717,567,488 | 1.09% |
| long | 710 / 475 | 235 | 2,217,738,240 | 0.36% |

For the long request this avoids about 53.23 billion scalar multiply-accumulate pairs across 24 steps, but only **0.36%** of the counted main matrix work. Elementwise operations, embedding, normalization, sampling, padding, driver work and the decoder are outside that count. It is a logical calculation, not executed GPU instruction or energy accounting. A large local speedup therefore does not establish a useful full-request saving.

## Two complete-request comparisons

The first prototype prepares the accepted graph, then rewrites it with additional parse/write passes. A second version integrates the same rewrite into the existing preparation pass. Their derived graph bytes match exactly. The extra-pass result is retained; it is not silently replaced by the later result. Preparation happens outside request CPU intervals, and these measurements do not establish whether garbage collection or unrelated host activity causes the observed differences.

Each series has four counterbalanced packaged baseline/candidate pairs. Each browser starts fresh, initializes the same models and synthesizes the same 19-second paragraph at 24 steps and again at 12 steps. All sixteen paired requests across both series preserve exact float32 PCM, length and sample rate. Builds, native diagnostics and other tests are serialized outside the cost measurements. A strict 6 GiB browser Job commitment ceiling and unchanged process-membership gate apply to every before/after observation.

Positive reductions mean lower candidate cost; negative values mean regression:

| Series | Paired median CPU reduction | CPU-improving pairs | Median peak-commitment saving | First-request time reduction | Following-request time reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| extra-pass-prototype | -9.09% | 1/4 | -7.07 MiB | -1.27% | -0.14% |
| single-pass | -8.28% | 0/4 | -21.20 MiB | -1.97% | -0.31% |

Single-pass wall times are:

| Request | Baseline median | Candidate median | Paired median time reduction |
| --- | ---: | ---: | ---: |
| First / 24 steps | 4095.89 ms | 4178.12 ms | -1.97% |
| Following / 12 steps | 2070.89 ms | 2086.82 ms | -0.31% |

Job user+kernel CPU covers browser/renderer/worker/GPU-process host work and diagnostics, excluding initialization, controller and fixture server. Commitment peaks include initialization and remain cumulative from launch. Variability from unrelated host activity remains; commitment is not resident RAM. The results support no request CPU, reliable RAM or general latency saving.

Both variants retain 70,448,376 main-plan GPU bytes. The unchanged decoder allocates 402,753,376 bytes cold and 175,106,048 bytes on the matching repeat, retaining no decoder GPU plans. Smaller isolated feed-forward outputs do not lower the existing main workspace capacity, which earlier layers still need.

## Exactness, unchanged application and limits

All 192 short-request generated-row half-logit tensors match the accepted baseline across NVIDIA English/Swedish/Arabic and Intel English. Another 48 long-request tensors match on NVIDIA, including exact codes, float32 PCM and WAV hashes. The long control uses the actual shared engine with two main plans and one decoder plan; every submission remains bounded and all resources release normally.

All recorded accepted source pins still match after testing. The baseline worker dependency graph matches the accepted lookup-range bundle, and the complete current extension file tree remains byte-identical to the snapshot taken before the cost measurements. The measured prototype and single-pass worker dependency graphs, graph bytes, source snapshots, scripts, raw counters and timestamps are pinned in `artifacts/final-layer-rows-20261101/summary.json`. No production source or current bundle changes are made. The existing 1,611-test verification remains applicable through unchanged source pins; the full suite, five-language packaged acceptance and sustained playback are not repeated for this rejected candidate.

This result directs the next iteration toward work shared across many transformer layers or CPU command encoding, where a small per-pass reduction can affect the full workload. The final-row prototype remains available for future representative slower-GPU evaluation, without introducing an unverified runtime option.

Physical 8 GiB RAM/8 GiB VRAM systems, weaker dedicated GPUs, audio-device continuity, energy and broad PDF/OCR workloads remain unqualified. The goal remains active.
