# Profile-driven OmniVoice MatMul experiment

Continue from restored production baseline, revision `5fcaa1091113f99dd1d74c732a15538c66e470d5`. Preserve all pre-existing local work. Starting status/diff and engine/runtime snapshots are in ignored `artifacts/omnivoice-profile-20261105/`. The earlier empty-cache and sampler candidates remain rejected; their gates/results are unchanged.

## Profile and candidate

Actual synthesis stage evidence places about 96% of wall time in 48 transformer passes, versus 25–30 ms sampling and about 10 ms decoding. A diagnostic profiler captures real cached dispatches at steps 0, 12 and 23 of both guidance arms, using GPU timestamps and preserving dispatch order. It splits passes for attribution, so its timings cannot qualify a speedup. Host replay/write times are recorded; overlapping readback waits are not additive.

Initial diagnostic evidence: packed-half MatMul accounts for 79–82% of timestamped GPU time. Host command replay is about 0.24 ms per ordinary 18–20 ms inference call. Large 1024->3072 and 3072->1024 dense projections dominate. Test a 32-by-32 output tile, retaining K blocks of 16 and the original sequential float32 accumulation/half stores. Route only FP16 even-inner/even-output dense matrices with M>=128, K>=1024, N>=1024; retain the original tile for other shapes. No weight, precision, model-pass, voice, sampling or segmentation changes. No new native C++ is justified for a GPU bottleneck.

## Fixed gates, before candidate measurements

- Exact half bits in independent GPU comparisons across real projection dimensions, tails, broadcasts, cancellation/subnormal/overflow controls. Identical logits at every pass, input feeds, decoder tokens, RNG traces and raw float32 PCM in full synthesis; no validation/cleanup errors.
- GPU microkernel: fixed dominant shapes and threshold/tail controls, interleaved A/A then A/B blocks, >=5% lower median GPU interval for each routed dominant shape. Keep every failed attempt and timing control.
- Full synthesis: unchanged English female-1 / Swedish male-1 requests, seeds 42/45, speed 1, guidance 2, 24 diffusion steps and pinned models/reference bytes. Serial fresh workers in ABBAAB order, five warm repeats after one shape-cold sample per voice/worker (72 generations, 30 warm observations per arm). A/A control first. Adopt only >=5% lower pooled median warm synthesis wall time, lower per-voice median wall time, <=5% pooled warm browser-CPU regression, and no increase in peak allocated GPU-buffer bytes. Cold/setup separate. Exactness instrumentation is equal in both arms; profile instrumentation is disabled during A/B.

These are criteria for a new GPU-compute candidate, not a rescore of the rejected cache-transfer experiment. Resource equality is expected for a tile change. Latency is synthesis readiness, not audible output. A single host cannot establish cross-device performance or all-language parity.

## Slices

- [x] Snapshot and inspect restored baseline; profile actual synthesis and GPU dispatches.
- [x] Add failing routing/dispatch regressions, implement the bounded tile candidate and run local checks.
- [x] Compare exactness/performance of GPU kernels; reject if this gate fails.
- [x] Run identical full-runtime A/A and A/B with frozen rules; keep only a qualifying candidate.
- [x] Verify affected boundaries and required local gates, review, audit preserved changes, and record exact commands/counts/results/limitations.

Review focus: float32 addition order, paired stores at even tails, batch broadcast offsets, uniform configuration binding, unchanged small/odd/float32 routes, 256-command submission bound, resource cleanup and baseline engine-source isolation between arms.

## Experiment ledger

Completed profile: English packed MatMul 80.871424/101.253120 ms of six timestamped passes (79.87%); Swedish 75.497472/92.012544 ms (82.05%). Ordinary median host replay 0.155/0.185 ms versus call wall 19.835/18.957 ms. Quantized timestamps and split-pass perturbation limit attribution precision. All four profiled generations retained identical quality hashes and cleaned up. Two development-only profiler failures are preserved: an incorrect callback argument before generation, then an inappropriate two-arm scoring call after four successful single-arm diagnostic generations. The final diagnostic completed without those errors.

- 32x32 everywhere above the initial threshold: exact bits in 11 shapes, but down/q lacked 5% savings and narrow controls regressed 35–52%. Rejected; source/report retained.
- 16x32 fixed accumulators at the same threshold: exact bits, up/q about 19–20% faster, down only 1.9%; narrow controls regressed 9–12%. One up A/A timing control failed (10.3% variation). Rejected; source/report retained.

Architecture reassessment before the third candidate: increasing output width helps wide projections but does not justify routing narrow outputs. Keep the original 16x16 path for N<2048. For M>=128, K>=1024, N>=2048 with even K/N, use 16x32; use 32x32 only when M>=192 and N>=3072. These are matrix-shape rules, independent of voice/text/model identity. The new kernel gate still requires >=5% for every routed dominant projection; unchanged down/narrow routes are A/A controls with the same <=5% regression/noise bounds. Add unseen 256x1024x4096 and 512x2048x2048 cases, square/wide tails and the row boundary before measurements.

Timing-method correction before third-candidate timing: single-dispatch calibration includes several ms of fixed readback wall latency and sometimes caps blocks at 8–9 replays, leaving coarse 65,536 ns timestamps too influential. Calibrate eight dispatch replays per interval, dividing measured GPU/wall estimates by eight before the existing bounded repeat selection. Keep five interleaved pairs, the same A/A bound and adoption thresholds. Retain both earlier reports; this is not a rescore or a waiver. Final full-runtime gates remain unchanged.

Hybrid result: 16 exact GPU cases with passing A/A controls; dominant routed reductions 28.46% up-English, 16.03% up-Swedish, 17.38% q-Swedish; held-out cases 21–23%. Full 72-generation A/A had 1.95% pooled median wall variation and 8.61% CPU variation. Review found its candidate metadata listed the on-disk candidate hash even though control served baseline bytes to both arms. Raw report is preserved; `speech-aa-provenance.json` records effective baseline hashes and all 72 baseline-only dispatch checks. Hash reporting was fixed with two failing-then-passing tests before A/B; no timing/inference code changed.

Full 72-generation hybrid A/B: every feed/logits/token/RNG/PCM hash identical, all cleanups successful; median wall 983.5575 -> 950.5125 ms (3.36% faster), pooled warm CPU 10.014441 -> 9.966416 s, identical peak allocated GPU-buffer bytes. English improved 5.26%, Swedish 1.95%. Rejected because pooled median failed the fixed 5% gate. Both production engine files restored to baseline before the next candidate; hybrid source/tests/reports remain in artifacts.

Architecture reassessment: output tiling improves only some conditional projections and does not address the full transformer workload. Next hypothesis is synchronization overhead inside the original 16x16 packed kernel: K=1024 requires 64 inner blocks with two workgroup barriers per block. Load 32 inner terms at once, retaining 16x16 output tiles and four scalar accumulators. Evaluate the first 16 terms, then the next 16 only when the original kernel would have evaluated that half-block. This preserves exact operation order/count including K=258/272/274 tails, while halving barriers on full blocks. Select only even FP16 K>=256 and N>=128; retain original small/odd/float32 paths. No weight/model/sampling changes. Keep all full-synthesis and kernel gates unchanged; the new kernel must qualify on every newly routed dominant shape, including short unconditional rows and down projections. Before measurement, add inner-tail and small/odd controls. If this approach also fails, retain the restored baseline and report the measured limits rather than adjust acceptance thresholds.

Broad K32 result: 20 exact GPU cases and all controls passed; large projections slowed about 5–7%, short-row cases improved about 8–12%. Broad routing rejected. Additional 13 short-row cases (all exact): K32 improved the 45/55-row 1024/2048-column and down projections by about 7–16%, but 55/64-row 3072-column cases missed 5%. The 1024x1024x128 held-out tall projection improved 11.96%. These results suggest the larger shared-memory working set helps only with a limited number of concurrently available workgroups; actual occupancy/cache counters were not measured.

Final composition ruling, before its measurements: use K32 only for even FP16 K>=256,N>=128 when the **original** 16x16 output grid has at most 512 workgroups including broadcast batches. Keep the qualified wide/square routes for larger grids, and the original kernel otherwise. The bound excludes the observed 768-workgroup short cases that failed, while including the independently authored tall case and 512-workgroup boundary. This is a new, explicitly recorded routing candidate, not a rescore of either rejected broad kernel. Test all existing shapes, all 13 short cases, inner tails, and the above-boundary fallback with the same exactness/A/A/performance gates. Full synthesis still requires 5% pooled latency improvement and both voices faster; do not keep a failing composition. No further candidate will be tried in this run if it fails.

First composition measurement: all 34 cases bit-exact, but two inner-tail A/A controls failed; the extreme cancellation/overflow control measured a 5.13% regression against the 5% bound. This run does not qualify. Before one unchanged-code remeasurement, increase calibration from 8 to 64 replays and target intervals from 8 to 32 ms; keep the 4096-repeat/estimated 100 ms block limits, five interleaved pairs, all 34 fixed inputs, source pins and every adoption threshold unchanged. Coarse 65,536 ns ticks are too influential in small intervals. Both attempts remain in the ledger; no per-case selective rerun or source change. A failing precise rerun ends candidate work.

The precise rerun passed all 34 exactness/control/performance cases. Its first launch stopped before measurement because the inline repeat-count checks still expected the old 8 ms target; those expectations were updated consistently with 32 ms and all 13 timing checks passed. No engine source or acceptance gate changed. The polished, retained `omnivoice-matmul.mjs` then independently passed the same 34 GPU cases and 13 timing checks with correctly scoped metadata. Earlier prototype reports inherited generic timing/scope prose from another diagnostic; the executed sources and explicit `calibrationReplays` values preserve the actual method. The final tool/report records 64-replay calibration and 32 ms targets accurately.

## Accepted implementation and results

**Keep the final projection-kernel composition.** It preserves the original ascending float32 products/additions and FP16 stores, every model weight, tokenizer, diffusion step, sampling setting, reference and voice. It chooses K32 for the bounded original output grid, larger output tiles for qualified larger grids, and the original kernels for other inputs. Float32 and odd-inner/output routes remain unchanged. No C++ or dependency changes were needed.

| Default workload, 30 warm observations/arm | Baseline | Candidate | Difference |
| --- | ---: | ---: | ---: |
| Pooled median synthesis wall ms | 974.9675 | 918.0575 | **5.84% faster** |
| English female-1 median ms (15/arm) | 1,012.790 | 938.615 | 7.32% faster |
| Swedish male-1 median ms (15/arm) | 946.835 | 902.230 | 4.71% faster |
| Recorded pooled browser CPU seconds | 9.142908 | 8.519098 | 6.82% lower in this run |
| Peak allocated live GPU-buffer bytes | 1,403,280,372 | 1,403,280,372 | Equal |
| Median engine input-write bytes/generation | 15,436,384 | 15,436,384 | Equal |

All 72 generations retained identical raw PCM, decoder tokens, complete RNG traces, speaker metadata, cache descriptors/zeros/aliases, and non-cache feed hashes. Every one of the 3,456 main logits buffers matched. All six workers cleaned up successfully; no GPU validation errors occurred. Effective baseline/candidate source pins and actual dispatch labels were checked. The independent reviewer recomputed these statistics and audited every recorded equality/cleanup/source pin with no actionable finding.

Additional boundary A/B was chosen after default qualification to check different languages, references and longer shapes: French female-2 (seed 43, 24 steps, 128 generated frames) and Japanese male-2 (seed 43, 32 steps, 255 frames), speed 1 and guidance 2, whisper disabled. Identical request/model descriptors are recorded per arm; Japanese uses its production preset's 32 steps. ABBAAB with one cold/one warm generation per voice/worker gave 24 generations and six warm observations per arm (three per voice). It also passed the unchanged compute rule:

| Longer-passage metric | Baseline | Candidate | Difference |
| --- | ---: | ---: | ---: |
| Pooled median warm ms | 2,013.3925 | 1,815.9400 | 9.81% faster |
| French median warm ms | 1,354.715 | 1,207.865 | 10.84% faster |
| Japanese median warm ms | 2,670.275 | 2,478.865 | 7.17% faster |
| Recorded pooled browser CPU seconds | 4.065884 | 4.063831 | Essentially equal |
| Peak allocated live GPU-buffer bytes | 1,610,694,388 | 1,610,694,388 | Equal |

All 24 boundary generations and their 1,344 logits buffers matched exactly, with successful cleanup and no GPU errors. Across the two accepted full-runtime comparisons this is **96 generations, four fixed requests and 4,800 checked logits buffers**. These are scoped parity observations, not all-language or cross-device proof.

Cold/setup observations stay separate. Default A/B: six shape-cold samples per arm, median wall 1,063.115 -> 1,014.543 ms; pooled CPU 2.865052 -> 2.731379 s. Three setups per arm: median wall 4,141.470 -> 4,181.770 ms, pooled CPU 21.729302 -> 21.835465 s. Boundary A/B cold median 2,078.320 -> 1,941.177 ms, setup median 4,130.175 -> 4,189.660 ms. Pipeline preparation adds work; no initialization improvement is claimed. Startup observations include loading, compilation and cache/order effects.

Environment: Windows 11 x64 10.0.26300, Core Ultra 9 285K, 24 logical CPUs, 67,939,164,160 bytes RAM, Chromium 156.0.8078.4, NVIDIA Blackwell adapter. Driver, power mode, background load, physical VRAM residency, pipeline/driver memory and energy were not measured. All automated audio was muted. CPU/latency include identical development hashing and CDP instrumentation; synthesis readiness is not audible latency. The A/A control's CPU variation was 8.61%, so the CPU reduction is descriptive and not a significance or energy claim. This non-exclusive single host, two default passages and two longer passages do not qualify other hardware, all voices/languages, long sessions, UI/offline flows or human listening. No such improvement is claimed.

## Retained files

- `src/engines/webgpu-shaders.js`: three exact packed-half projection kernels, preserving the original reference kernel.
- `src/engines/webgpu-compute.js`: preparation, uniform parameter binding and disjoint shape-based routing; original submission/ownership/cleanup paths retained.
- `tests/engines/gpu-packed-matmul.test.js`: 22 new routing/uniform/broadcast/boundary cases, 29 total.
- `tooling/scripts/benchmarks/omnivoice.mjs`: explicit engine overlays, separate compute-v1 rule, effective source pins, observed dispatch checks and identical compute-cache inputs.
- `tooling/scripts/lib/omnivoice-runtime-comparison.mjs` and its `tests/engines/omnivoice-runtime-comparison.test.js`: separate compute scoring, 9 new regression cases, 25 total; original cache rule unchanged.
- `tooling/scripts/lib/engine-source-pins.mjs` and `tests/engines/engine-variant-pins.test.js`: effective A/A/A/B hash reporting and two regressions.
- `tooling/scripts/benchmarks/omnivoice-matmul.mjs`: reusable 34-case exact GPU comparison with 13 timing self-checks.
- `docs/benchmarks/omnivoice.md` and this report: reproduction, rules, provenance, rejected attempts and limits.

## Reproduction and exact commands

Run from `F:\Github\PageNarrator` in PowerShell. Ignored evidence is under `artifacts/omnivoice-profile-20261105/`; choose new report names because outputs refuse overwrite. `baseline-engine/` contains the exact starting compute/shader files. Rejected sources use `rejected-32x32-`, `rejected-16x32-`, `rejected-hybrid-` or `rejected-broad-k32-` prefixes. Saved `measured-*-harness.mjs` files preserve the actually executed prototypes; the boundary harness fixes its two request descriptors. Model files must already be available and are fully length/SHA verified before each full-runtime run.

```powershell
git rev-parse HEAD
git status --porcelain=v1
node artifacts/omnivoice-profile-20261105/profile.mjs --baseline=src/tts/omnivoice/runtime.js --control --warm-repeats=1 --output=artifacts/omnivoice-profile-20261105/profile-final.json
npx vitest run --config tooling/vite.config.js tests/engines/gpu-packed-matmul.test.js tests/engines/gpu-pipeline-preparation.test.js tests/engines/gpu-replay-passes.test.js tests/engines/gpu-bounded-submissions.test.js
node artifacts/omnivoice-profile-20261105/matmul.mjs --output=artifacts/omnivoice-profile-20261105/kernel-composite-precise-2.json
node tooling/scripts/benchmarks/omnivoice-matmul.mjs --output=artifacts/omnivoice-profile-20261105/final-kernel-tool.json
node tooling/scripts/benchmarks/omnivoice.mjs --criterion=compute --baseline=src/tts/omnivoice/runtime.js --baseline-engine-dir=artifacts/omnivoice-profile-20261105/baseline-engine --control --output=artifacts/omnivoice-profile-20261105/speech-aa.json
node tooling/scripts/benchmarks/omnivoice.mjs --criterion=compute --baseline=src/tts/omnivoice/runtime.js --baseline-engine-dir=artifacts/omnivoice-profile-20261105/baseline-engine --output=artifacts/omnivoice-profile-20261105/composite-speech-ab.json
node artifacts/omnivoice-profile-20261105/boundary-speech.mjs --criterion=compute --warm-repeats=1 --baseline=src/tts/omnivoice/runtime.js --baseline-engine-dir=artifacts/omnivoice-profile-20261105/baseline-engine --output=artifacts/omnivoice-profile-20261105/boundary-speech-ab.json
npx vitest run --config tooling/vite.config.js tests/engines/omnivoice-runtime-comparison.test.js tests/engines/engine-variant-pins.test.js
npx eslint --config tooling/eslint.config.js src/engines/webgpu-compute.js src/engines/webgpu-shaders.js tooling/scripts/benchmarks/omnivoice.mjs tooling/scripts/lib/omnivoice-runtime-comparison.mjs tests/engines/gpu-packed-matmul.test.js tests/engines/omnivoice-runtime-comparison.test.js
npm run verify:fast
npm run typecheck:boundaries
git diff --check
```

Earlier exact prototype invocations use the same `node .../matmul.mjs --output=...` pattern and the corresponding saved harness/source: `kernel-ab.json` (32x32), `kernel-ab-16x32.json`, `kernel-ab-hybrid.json`, `kernel-ab-k32.json`, `kernel-short-k32.json`, `kernel-composite.json`, and `kernel-composite-precise-2.json`. The first precise launch failed its timing self-check before measurement (`kernel-composite-precise.log`). The hybrid full comparison used the same compute command with `--output=.../speech-ab.json`. Failed/negative attempts are retained and were not rescored under weaker rules. The current polished harness should be used for future comparisons; historical A/A metadata has its explicit provenance erratum.

Test-first evidence: final routing/uniform cases failed against the preceding candidate, then 49 affected tests passed in four files. The nine compute-scoring cases failed before implementation, then 25 scoring tests passed. Two effective-source-pin cases failed before the helper fix, then the combined scoring/pin suite passed 27 tests. Deliberate red tests, prototype/self-check errors and rejected performance exits are development evidence, not pre-existing suite failures. Final required gate counts and preservation audit follow below.

## Final verification and preservation

`npm run verify:fast` exited 0 through all configured stages:

| Check | Observed result |
| --- | --- |
| Repository structure / full lint | Passed |
| Benchmark suite | 41 passed, 0 failed, 0 skipped |
| Full discovered suite | **45,503 passed, 0 failed, 4 optional skips**; 498 files passed, 1 skipped |
| Profiles | 56 passed in 8 files |
| Strict typecheck | Passed |
| PDF corpus | 124 passed, 0 failed, 1 optional local-corpus skip |
| Production build / native source/binary / 640 preset bindings | Passed |
| Separate boundary typecheck | Passed |
| Final CLI control `--prepare` / diff check | Passed |
| Independent numerical/routing/source/quality/evidence review |No remaining actionable findings |
| Final source/equality/cleanup audit | Passed |

No pre-existing test failure was observed in baseline controls or final required checks. Four optional PDF lanes remain skipped (`PN_PDF_ACCEPTANCE`, `PN_PDF_LIBRARY_ACCEPTANCE`, `PN_REAL_PDF_CORPUS`, `PN_SUMMER2026_PDF_CORPUS`); the corpus command separately skipped its unconfigured local corpus. These are unverified lanes. Node v24.16.0 / npm 11.17.0 differ from the declared toolchain pins; that declared toolchain was not tested. Full logs are `verify-fast.log` and `typecheck-boundaries.log` in the artifact directory.

The task added 33 discovered regression cases (22 projection dispatch/binding, 9 compute scoring, 2 effective source pinning). Numerical GPU coverage is the separately executed 34-case tool, not an implication that CPU unit mocks execute WGSL. Both the prototype precise measurement and final retained GPU tool passed; no starting test or gate was removed or weakened.

`audit.py` / `final-audit.json` independently recheck every accepted PCM/token/RNG/feed/logits/speaker/cache equality, cleanup result and source pin. Of 74 starting engine/runtime source files, 72 are unchanged; only the intended compute/shader modules differ. The OmniVoice runtime, learned weights and request settings are unchanged. Accepted reports match the final source hashes.

An unrelated hardware/media commit advanced HEAD concurrently from the recorded starting revision to `5d6ad8a19ae263fe78e1441527c771f0f62cf838`. PDF/media/website/requirements work and all other starting local changes were left untouched. This task made no commits, pushes, GitHub Actions changes/triggers, deployments or publications. Tests cover the observed local state; later unrelated edits are not covered by that run.

Historical profiler source fixes were small and occurred before measurements of candidates. Their first two source files were reconstructed afterward by reversing those edits; their SHA-256 values match the original report pins exactly. They are explicitly labeled `profile-reconstructed.mjs` / `profile-2-reconstructed.mjs` with a reconstruction manifest, rather than presented as original snapshots. Raw reports remain untouched. The A/A source-label erratum remains separate and explicit.

Additional final commands:

```powershell
node tooling/scripts/benchmarks/omnivoice.mjs --criterion=compute --baseline=src/tts/omnivoice/runtime.js --baseline-engine-dir=artifacts/omnivoice-profile-20261105/baseline-engine --control --prepare --output=artifacts/omnivoice-profile-20261105/final-cli-smoke.json
python artifacts/omnivoice-profile-20261105/audit.py
git log -3 --oneline
git status --short
git diff --check
```

**Status:** profiling, implementation, A/B qualification, boundary parity, regression coverage and local verification complete. Retain the qualified GPU-kernel change. No remaining blocker for the requested local scope; hardware/language/UI/long-session limitations above remain unverified.
