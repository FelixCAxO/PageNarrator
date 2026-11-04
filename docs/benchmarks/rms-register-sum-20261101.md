# RMSNorm register accumulation

This iteration follows the accepted [rotary fusion](rotary-fusion-20261101.md). It removes redundant shared-memory scratch and one synchronization from half-precision RMS normalization. The measured candidate is accepted for its lower GPU-stage cost and modest full-request latency improvement. **CPU results remain mixed, and retained GPU buffer allocation is unchanged.** No general CPU, RAM, energy or physical 8 GiB qualification is claimed.

## Calculation and minimal change

Each normalization workgroup has 64 lanes. The old shader squares each input into a shared array, synchronizes all lanes, then has each lane read back exactly the elements it wrote. No other lane needs those individual squares. The candidate accumulates the same squares directly into each lane's register sum. It preserves the original column order, shared 64-lane reduction tree, epsilon, reciprocal and two final half-precision rounding boundaries.

For each row, the calculation remains:

`root = sqrt(sum(x * x) / width + 0.000001)`

`output = half(half(x / root) * weight)`

The implementation continues to calculate one reciprocal and multiply by it, exactly as the baseline does; the compact formula above describes the normalization. Finite half inputs have at most 11 significant bits, so their exact square needs at most 22 bits and fits float32's precision and exponent range. The exhaustive CPU proof checks all **63,488 finite half bit patterns**. The multiplication is therefore exact before the existing ordered float32 additions. Physical GPU comparisons check compiler behavior as well.

Only `halfRmsNormShader` in `src/engines/webgpu-audio-shaders.js` changes. The per-lane sum moves into the first loop; the square array, its synchronization and its readback loop disappear. There are no model, weight, sampling, step-count, graph or dependency changes. All other audio shader exports, the final reduction and output rounding are checked unchanged.

| Width | Baseline declared shared storage | Candidate declared shared storage |
| ---: | ---: | ---: |
| 128 | 772 B | 260 B |
| 1,024 | 4,356 B | 260 B |

These are shader-declared workgroup bytes. Driver allocation, register pressure and physical traffic are not inferred from them. Global GPU buffers and dispatch counts stay unchanged. The accepted main pass has 56 width-128 and 57 width-1,024 normalizations; each workgroup avoids one barrier and one shared store/read per squared input.

## Native A/B controls

Each GPU runs 30 exact-bit cases covering both widths, empty and small tensors, odd row counts, representative and stress shapes, signed zeros, maximum finite magnitudes, subnormals, mixed magnitudes and all finite half bit patterns in both ordered and permuted rows. Every checked output half bit matches; buffers and tensors release without validation errors.

Timing uses five interleaved ABBA/BAAB comparisons with original/original controls. Each block targets 8 ms and caps repetitions at 4,096; a timing row requires positive intervals and a control median within 5%. The first exploratory version sometimes fell below timestamp resolution; its raw results are retained. The final v2 uses 64 initial repetitions before adapting. No invalid timing row is used to claim a gain.

| Adapter | Width | Rows | Paired median stage-time reduction |
| --- | ---: | ---: | ---: |
| nvidia | 128 | 4144 | 3.79% |
| nvidia | 128 | 11360 | 1.85% |
| nvidia | 1024 | 259 | 8.80% |
| nvidia | 1024 | 710 | 9.88% |
| intel | 128 | 4144 | 22.22% |
| intel | 128 | 11360 | 16.39% |
| intel | 1024 | 259 | 51.88% |
| intel | 1024 | 710 | 52.44% |

These repeated isolated stages are not ordinary request throughput, total GPU busy time or power measurements. The 1,024-wide 710-row case represents hidden-state normalization; the larger width-128 row counts represent flattened attention-head rows or nearby stress shapes.

## Full-request counterbalance and CPU confirmation

The full-request pairs use the NVIDIA RTX 5090. Two predeclared sets of four counterbalanced fresh-browser pairs run the same long paragraph at 24 steps, then at 12 steps. The second set follows a large CPU increase in one initial pair. All eight pairs are retained and pooled. Each synthesis is muted, uses the accepted worker or the one-module prototype, and runs under a 6 GiB Windows browser-job commitment cap. Strict process membership remains required: verified membership, or the existing listed-in-job/closed-process exception with error 87. No permissive accounting fallback is added.

The separate Intel correctness diagnostic takes 87.73 seconds to synthesize 19 seconds of audio. That probe's time is excluded from performance acceptance and does not qualify Intel for real-time speech.

Positive percentages indicate a reduction; negative percentages indicate an increase.

| Pair | Set | CPU seconds baseline / candidate | CPU reduction | First request reduction | Following request reduction |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | Initial | 2.30 / 2.25 | 2.04% | 1.25% | 1.47% |
| 2 | Initial | 2.03 / 1.98 | 2.31% | -0.23% | 2.18% |
| 3 | Initial | 2.23 / 2.11 | 5.59% | 2.40% | 0.43% |
| 4 | Initial | 1.95 / 2.69 | -37.60% | 1.59% | 2.08% |
| 5 | Confirmation | 1.88 / 2.36 | -25.83% | 2.13% | -4.81% |
| 6 | Confirmation | 2.31 / 2.14 | 7.43% | 3.77% | 1.49% |
| 7 | Confirmation | 2.03 / 2.11 | -3.85% | 2.70% | 2.98% |
| 8 | Confirmation | 2.28 / 1.91 | 16.44% | 0.56% | 2.19% |

First-request latency improves in 7/8 pairs, with a **1.86% paired median reduction**. Following-request latency improves in 7/8 pairs, with a **1.78% paired median reduction**.

The paired CPU median reduces by 2.17%, but total measured CPU across all candidate runs **increases by 3.12%**. Initial-set pooled CPU increases by 6.06%; confirmation-set pooled CPU increases by 0.18%. This disagreement supports no CPU-saving claim. CPU is measured as Windows job user plus kernel time around synthesis; initialization and the controller are excluded. The development host has unrelated activity, and no exclusive-host or energy claim is made.

The separate packaged short-request comparison records paired median latency reductions of 0.74% for the first request and 1.33% for the following request. Its raw pairs remain separate from the long-request CPU comparison.

Main retained allocation stays **66,014,464 B** on both sides. Decoder cold/repeat intermediate allocation stays **402,753,376 / 175,106,048 B**, with no retained decoder GPU plan. Whole-job peak commitment varies; its paired median change is -4.11 MiB saved. Commitment is not resident physical RAM, and engine-owned allocation is not total adapter VRAM residency.

## Regression acceptance

- 1,637 tests in 141 files; strict and boundary types, changed-file lint, production build, native binary/source and browser-artifact checks pass.
- The complete production output tree is byte-identical to the measured prototype. Source pins preserve the accepted baseline and candidate; the model graph remains `8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb`.
- Both adapters pass 66 native precision controls. All **288** full-step short/long half-logit tensors match the accepted baseline. Codes, PCM and WAV controls match, and the captured shapes still use two main plans.
- **17 packaged short-speech pairs, 16 packaged long-request pairs and 8 Kokoro controls** remain exact.
- 300.75 seconds of muted rendered playback complete 38 clips and 38 prepared handoffs with **zero unprepared waits**. Maximum measured added gap is 13.33 ms; minimum waveform correlation is 0.9999998611209722. All 65 strict process-accounting observations pass; job peak is 4.51 GiB.

The change is a GPU-stage improvement with small end-to-end latency gains. It does not establish lower CPU or RAM use. Physical 8 GiB RAM/VRAM PCs, weaker dedicated GPUs, device audio, energy and broad PDF/OCR remain unqualified. The broader goal remains active.

## Evidence

- Verified summary (`artifacts/rms-register-sum-20261101/summary.json`), verification (`artifacts/rms-register-sum-20261101/verification.json`), source proof (`artifacts/rms-register-sum-20261101/source-proof.json`), whole production-tree proof (`artifacts/rms-register-sum-20261101/production-bundle-proof.json`).
- NVIDIA native stages (`artifacts/rms-register-sum-20261101/micro-nvidia-v2.json`), Intel native stages (`artifacts/rms-register-sum-20261101/micro-intel-v2.json`), finite-square proof (`artifacts/rms-register-sum-20261101/square-proof.json`).
- Initial cost runs (`artifacts/rms-register-sum-20261101/long-speech-resources.json`), confirmation runs (`artifacts/rms-register-sum-20261101/long-speech-confirm.json`), all cost runs (`artifacts/rms-register-sum-20261101/long-speech-combined.json`), packaged speech (`artifacts/rms-register-sum-20261101/voice-parity/results.json`).
- Playback accounting (`artifacts/rms-register-sum-20261101/sustained/playback-accounting.json`), rendered waveform analysis (`artifacts/rms-register-sum-20261101/sustained/acoustic-analysis.json`).
