# Packed matrix scheduling and GPU timing controls

This follows the [confidence-cutoff refinement](confidence-refinement-20261031.md). That verified application package is the baseline. This iteration investigates GPU calculations and improves the reusable benchmark; it adopts no shader change and establishes no additional application CPU, RAM, VRAM or energy saving.

## Recheck the dominant calculations

A fresh first-conditional-pass operator profile records 1,375 dispatches and about 31.0 ms of diagnostic GPU intervals. Matrix multiplication accounts for 254 dispatches and 24.4 ms, about 79% of the total. The largest groups are feed-forward and projection matrices. This confirms that matrix calculations remain the main GPU target after the CPU sampling improvements.

The profile uses separate timestamped passes, so its absolute time is not ordinary application throughput. Its original pinned model, corrected graph, input and shader implementation remain unchanged.

## Test scheduling and shared storage

Five prototypes retain the existing 16×16 output tile and float32 accumulation sequence:

- Explicit inner-loop unrolling by 2, 4 or 16. This changes compiler scheduling opportunities without changing dot-product order.
- Packed left-hand workgroup storage, reducing shared storage from 2,048 to 1,536 bytes.
- Packed storage on both sides, reducing shared storage to 1,024 bytes.

The packed shared-storage versions retain raw half words until the inner loop. This reduces shared-memory traffic but repeats half-to-float conversion during computation. Reduced storage alone does not prove reduced GPU cost.

An unchanged-code control accompanies the prototypes. Each runs 13 half-precision cases with five counterbalanced timestamp pairs, including odd-dimension fallback, tails, broadcasting, QKV, feed-forward, attention, conditional/unconditional and generated-head shapes. All 156 controlled cases across NVIDIA Blackwell and Intel Xe-LPG preserve exact output bits, report no GPU validation errors and release their owned resources. That count includes 26 unchanged-code controls.

## Reject unstable timing before selecting a shader

The initial method submits a repeated A block, waits for readback, then submits B. Its unchanged-code control shows median ratios from about 0.70 to 2.07 on major shapes. Those timings cannot distinguish an algorithm improvement from host/scheduler effects and are excluded. The initial raw files remain in the evidence directory.

The revised method submits four timestamped blocks in one command buffer, alternating ABBA and BAAB between pairs. Repeats target about 8 ms per block, with a cap. This reduces gaps between compared workloads and balances gradual clock/load changes. On the matrix experiment's major-shape unchanged-code controls, NVIDIA median differences are about 0–1.3% and Intel differences about 0–0.9%. Small-shape controls can still be noisy.

A snapshot taken before the next benchmark series, while our preceding inference process had closed, records 87% global NVIDIA utilization, about 18,147 MiB allocated globally and 408 W board power. These global values are not PageNarrator attribution or exclusive-host evidence. Interleaving improves paired diagnostics; it does not remove competing GPU work or establish an energy saving.

## Reject all five production candidates

The controlled comparisons still show no consistent cross-device gain:

| Candidate | NVIDIA observations | Intel major-shape regression | Decision |
| --- | --- | ---: | --- |
| Unroll 2 | Mixed; QKV about 14% slower, some other shapes improve | 93–114% slower | Reject |
| Unroll 4 | Mixed; QKV/head about 8–9% slower | 95–116% slower | Reject |
| Unroll 16 | Mostly small differences; no broad improvement | 5–9% slower | Reject |
| Pack left shared storage | Some shapes improve 17–25%; head about 8% slower | 55–71% slower | Reject |
| Pack both shared arrays | Down-projection improves about 32%; up-projection about 16% slower | 9–13% slower | Reject |

Percentages are medians of paired ratios for the indicated diagnostic shapes, not full-speech or broad-hardware acceptance. NVIDIA remains a loaded-host comparison. Intel's near-equal control and large repeatable regressions are enough to reject these as portable replacements. None of the prototype strings enters the application shader.

## Improve the reusable benchmark

[inference-kernels.mjs](../../scripts/benchmarks/inference-kernels.mjs) now uses the interleaved method and runs original/original controls before each comparison. Existing numerical checks and resource cleanup remain required. Reports retain both raw intervals and control samples:

- Every interval must be finite and positive to yield a usable per-dispatch time. Invalid intervals retain their raw values and produce null averages.
- Every timed row records `controlMedianRatio` and `timingControlPassed`. The row passes its noise screen only when all its intervals are valid and the control median is within 5% of equality.
- A failed noise screen keeps the raw data but supports no speed claim. The 5% screen is a diagnostic heuristic, not a statistical confidence interval or a performance acceptance threshold.
- Invalid warmup estimates use the existing bounded repeat count rather than expanding to the maximum repeat cap.

The first Intel run with a strict positive-interval assertion failed on a zero-duration timestamp. Its log and original timer source are retained. The final implementation treats this as unusable timing while retaining correctness/resource checks. Seven deterministic self-checks cover known ABBA attribution, zero/backward timestamps and adaptive-repeat boundaries.

The final benchmark passes all 19 numerical/resource cases and seven timing self-checks on both architectures. Of 13 timed rows per device, NVIDIA excludes two rows (`odd`, `matmul-odd-output`) for failed noise controls; Intel excludes none. These exclusions remain visible despite the overall correctness status passing. Changed-file lint and whitespace checks pass.

The application source, shader and packaged OmniVoice worker match the preceding verified iteration. Its 1,502 engine/TTS/reader tests, exact speech controls and five-minute playback evidence remain linked by source/package hashes. Full application tests, a build and sustained playback are not repeated for this benchmark-only change. There is no new application performance claim.

## Evidence and remaining work

The ignored `artifacts/packed-matmul-scheduling-20261031/` directory retains the baseline package/source, five rejected shader variants, unchanged control, initial excluded timing data, interleaved raw pairs, operator profile, global GPU snapshot, failed timing log, final native reports and `summarize.mjs`. The summary verifies source pins, exact bits, cleanup, timing flags and the unchanged application worker before writing `verification.json`.

The next algorithm investigation should inspect the 56 observed `[1,8,1,L,128] → [1,8,2,L,128]` indexing expansions. Their shape suggests grouped-query key/value repetition; the graph topology must confirm that before any rewrite. Existing batched-matrix broadcasting may avoid materializing duplicates while retaining full bidirectional attention and accumulation order. This is a hypothesis, not an implemented saving.

The development host is a Core Ultra 9 285K with about 63.3 GiB physical RAM and an RTX 5090 with nominal 32 GiB dedicated memory; Intel Xe-LPG supplies additional controls. Physical 8 GiB RAM/VRAM PCs, weaker dedicated GPUs, device-output continuity, power and broader PDF/OCR qualification remain unverified.
