# Normalize directly into the attention-head layout

This follows the accepted [RMSNorm register-sum change](rms-register-sum-20261101.md). The candidate combines head normalization and its following transpose by writing each completed row directly into the required destination layout. It removes **56 copy dispatches per main pass**, retains **2.78 MiB less main workspace**, and roughly halves the isolated stage time on both GPUs. It is accepted for GPU work and retained workspace savings. **The full-request comparison establishes no reliable CPU or latency benefit.** The physical 8 GiB hardware goal remains active.

## Calculation and data dependency

An attention projection has shape `[batch, time, heads, 128]`. Normalization reduces only the last 128 values of each row. The next transpose changes its layout to `[batch, heads, time, 128]`, leaving those 128 values in their original order. Thus every normalized value can be written straight to its final row; no intermediate normalized tensor needs to be copied.

For input row `r`, with time length `T` and head count `H`:

`batch = floor(r / (T * H))`

`time = floor(r / H) % T`

`head = r % H`

`destinationRow = (batch * H + head) * T + time`

The 64-lane normalization workgroup still reads the same input row, squares and accumulates in the same order, uses the same shared reduction tree and epsilon, and rounds to half before and after learned-weight scaling. Only the destination row changes. Source proof strips that integer mapping and verifies that the new shader's normalization arithmetic is byte-identical to the accepted kernel. Both ordinary width-128 and width-1,024 normalization shader strings, all other audio shader exports, model bytes, weights, sampling and diffusion steps remain unchanged.

The graph rewrite requires the exact four-axis permutation, a known 128-wide half normalization weight, half input/output types, ordinary ONNX domains, supported attributes and single-output arities. Other layouts retain their original operations and validation. The original normalization producer remains available for named or subset output requests. Debug requests that explicitly ask for both layouts can compute normalization twice; the ordinary audio graph has one transpose consumer for each of the 56 matched normalizations.

## Exact native controls and GPU-stage timing

Twenty isolated controls on each GPU cover empty dimensions, unit dimensions, multiple batches, odd shapes, actual speech shapes, a 65,552-row case spanning two dispatch-grid dimensions, signed zeros, maximum finite values, subnormals, mixed magnitudes and all 63,488 finite half bit patterns in ordered and permuted rows. Every output half bit matches the original normalization followed by transpose. Resources release without GPU validation errors.

Ten integrated internal-graph controls on each GPU check capture/replay, swapped time/head shape keys with equal element counts, returning to the original cached shape, multiple batches, named normalization ownership, unused invalid transpose subsets, invalid-rank rejection, recovery and empty time. Full-model speech separately checks the production ONNX normalization pattern and its integration. The first native harness failed on a missing comparison helper; that failed script/log are preserved as `native-v1.mjs` and `native-nvidia-v1.log`. The corrected harness passes; no product code changed for that repair.

Timing uses five interleaved ABBA/BAAB pairs with adaptive approximately 8 ms blocks and original/original controls. A row requires positive timestamp intervals and a control median within 5%. Failed timing rows remain in raw evidence and make no speed claim.

| Adapter | Time positions | Heads | Paired median stage-time reduction |
| --- | ---: | ---: | ---: |
| nvidia | 259 | 8 | 56.64% |
| nvidia | 259 | 16 | 52.80% |
| nvidia | 710 | 8 | 51.55% |
| nvidia | 710 | 16 | 50.79% |
| intel | 259 | 8 | 51.43% |
| intel | 259 | 16 | 51.44% |
| intel | 710 | 8 | 53.88% |
| intel | 710 | 16 | 52.23% |

The isolated stage retains both original outputs versus one fused output, halving its allocated tensor bytes for ordinary nonempty cases. The application instead pools intermediates, so that isolated 50% allocation reduction must not be described as a 50% application-memory saving.

## Application GPU work and storage

The actual long-request trace confirms the following changes. The baseline dispatch trace comes from the accepted rotary experiment; the subsequent register-sum change alters no scheduling or graph nodes. The baseline build and source chain are pinned.

| Observation | Baseline | Candidate |
| --- | ---: | ---: |
| Conditional main dispatches | 703 | 647 |
| Unconditional main dispatches | 702 | 646 |
| Decoder dispatches | 133 | 133 |
| Selected main nodes | 2,882 | 2,826 |
| First long main intermediate bytes | 60,483,676 | 57,575,520 |
| First long main plan bytes | 64,051,408 | 61,138,324 |
| Retained two-main-plan union bytes | 66,014,464 | 63,096,452 |

There are 56 fused head normalizations and 57 unchanged width-1,024 normalizations per main pass. The conditional/unconditional passes retain 86/85 half index dispatches, respectively. A complete 24-step request avoids **2,688 dispatches** and a nominal **4.56 GiB each of logical half-tensor reads and stores**. These are eliminated copy payloads, not measured physical GPU-bus traffic, total adapter VRAM or energy. Main matrix calculations remain unchanged and dominate inference work.

The decoder retains its 402,753,376 / 175,106,048 B cold/repeat intermediate allocations and zero retained decoder GPU plan. The main cache cap remains 128 MiB, with two shape plans. The separate-queue submission cap stays 256 commands, preserving the earlier Intel hang fix.

## Full-request A/B and limits

Four fresh-browser pairs alternate execution order on the NVIDIA RTX 5090. Each runs the fixed long paragraph at 24 steps and then 12 steps, under an enforced 6 GiB browser-job commitment ceiling. The PCM, length and sample rate match exactly in all eight paired requests. Strict process membership is required for every observation; the existing listed-in-job/closed-process exception remains limited to error 87.

Positive percentages below indicate reductions; negative percentages indicate increases. All pairs are retained, including the slower first request in pair 1.

| Pair | Browser CPU reduction | First request reduction | Following request reduction | Peak commitment saved |
| ---: | ---: | ---: | ---: | ---: |
| 1 | -5.71% | -10.39% | 2.38% | -118.95 MiB |
| 2 | 3.25% | 0.90% | 0.17% | 28.88 MiB |
| 3 | -9.63% | 0.01% | 1.67% | 47.53 MiB |
| 4 | 7.69% | 0.09% | -1.23% | 157.49 MiB |

The paired CPU median **increases 1.23%**; total CPU across all candidate runs increases 0.87%. Two CPU pairs improve and two regress. The paired median commitment saving is 38.21 MiB, with mixed individual results. Neither is attributed to the fixed workspace saving. CPU counters include browser renderer/worker and GPU-process host work around synthesis, excluding model initialization, the controller and fixture server. Commitment peaks include startup and are not resident physical RAM. The host has unrelated activity; no exclusive-host or power claim is made.

| Request | Baseline median | Candidate median | Median of paired time reductions |
| --- | ---: | ---: | ---: |
| First / 24 steps | 3586.83 ms | 3599.39 ms | 0.05% |
| Following / 12 steps | 1799.36 ms | 1782.61 ms | 0.92% |

The separate packaged short comparison has paired median reductions of 0.42% for the first request and 0.81% for the following request. These timings remain separate from the long-request cost comparison. The Intel native correctness control takes 87.63 seconds for 19 seconds of audio, so it provides no real-time hardware qualification.

## Regression acceptance

- 1,654 tests in 141 files; strict/boundary types, changed-file lint, production build, native sources/binaries, browser artifacts and whitespace checks pass.
- The entire production output tree is byte-identical to the A/B prototype. All changed application modules match the measured source snapshots.
- Both GPUs pass 66 native precision controls and the 20 isolated plus 10 integrated controls. **288 full-step short/long half-logit tensors** match the accepted baseline; codes, PCM and WAV hashes also match.
- **17 packaged short-speech pairs, 8 packaged long-request pairs and 8 Kokoro controls** are exact. The model graph remains `8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb`.
- The muted continuity run lasts 300.75 seconds, completes 38 clips and 38 prepared handoffs, and has **zero unprepared waits**. Maximum measured added render gap is 13.33 ms; minimum waveform correlation is 0.9999998611209724. All 65 strict accounting observations pass. Browser-job commitment peaks at 4.47 GiB.

Acceptance is for fewer GPU copies and lower engine-owned workspace. It does not establish lower CPU use, resident RAM, total adapter VRAM, energy, or reliable full-request latency gains. Physical 8 GiB RAM/VRAM PCs, weaker dedicated GPUs, device audio and broad PDF/OCR remain unqualified; the broader goal stays active.

## Evidence

- [Summary](../../artifacts/norm-transpose-20261101/summary.json), [verification](../../artifacts/norm-transpose-20261101/verification.json), [source proof](../../artifacts/norm-transpose-20261101/source-proof.json), [complete build proof](../../artifacts/norm-transpose-20261101/production-bundle-proof.json), [actual dispatch trace](../../artifacts/norm-transpose-20261101/commands.json).
- [NVIDIA stages](../../artifacts/norm-transpose-20261101/micro-nvidia.json), [Intel stages](../../artifacts/norm-transpose-20261101/micro-intel.json), [NVIDIA integration controls](../../artifacts/norm-transpose-20261101/native-head-layout-nvidia-0-100999.json), [Intel integration controls](../../artifacts/norm-transpose-20261101/native-head-layout-intel-0-114380.json).
- [Raw complete-request pairs](../../artifacts/norm-transpose-20261101/long-speech-resources.json), [packaged speech](../../artifacts/norm-transpose-20261101/voice-parity/results.json), [playback accounting](../../artifacts/norm-transpose-20261101/sustained/playback-accounting.json), [waveform analysis](../../artifacts/norm-transpose-20261101/sustained/acoustic-analysis.json).
