# OmniVoice empty-cache experiment

Goal: reduce redundant OmniVoice work with identical output quality. Execute locally and autonomously as requested; preserve unrelated work and all quality gates.

Starting revision: `5fcaa1091113f99dd1d74c732a15538c66e470d5`. Starting status (including untracked files), binary diff, runtime snapshot and engine/runtime hashes are saved under ignored `artifacts/omnivoice-micro-20261105/`. No AGENTS.md was found in this repository or its ancestors. Baseline: 134 tests passed in 3 affected files; Node v24.16.0, npm 11.17.0 (below declared toolchain pins).

## Evidence and approach

Confirmed: runtime allocates `[1,8,sequenceLength,128]` zero KV storage for each arm, shared across 56 cache inputs but uploaded again on replay. It always supplies complete target positions starting at zero. The graph replaces those positions and keeps only the unused prefix/suffix of the old cache. Hypothesis: a zero-length cache preserves all calculations while avoiding its allocation/upload.

All 313 learned initializers are dependencies of the requested audio output; there is no demonstrated whole-weight pruning opportunity. The runtime already selects generated output rows, uses FP16 and compact grouped attention. Selective embedding access already gathers rows. Arbitrary weight removal, lower precision and fewer diffusion steps would violate the quality constraint. New C++ is not justified by a measured bottleneck. A previous final-pass sampler optimization failed full-runtime qualification; it is not repeated.

## Slices and decision rule

- [x] Record local state, inspect runtime/graph and run baseline tests.
- [x] Test first: assert empty cache dimensions/data/aliasing across every model call, keeping full attention positions. Cover ordinary, no-reference, maximum-step, repeat and cancellation paths through existing and new tests.
- [x] Change only cache construction if the graph/runtime supports it. No engine, model, arithmetic, seed, voice, scheduling or decoder changes. Candidate tested, then reverted after rejection.
- [x] Add reusable serial A/B tooling with explicit baseline source, verified model pins, source hashes, fixed requests, A/A control, ABBA worker order, shape-cold samples and three warm repeats per voice/worker. Check every main logits buffer, non-cache feed, decoder token, RNG and PCM hash; validate the intentionally changed cache separately. Record live GPU-buffer peak, cleanup, browser CPU, wall and stage times. Run without overlapping builds/tests/synthesis.
- [x] Accept only exact outputs with no validation/cleanup errors, lower pooled warm browser CPU, <=5% median warm latency regression, and lower peak GPU-buffer bytes. Report each voice and cold data separately; no cross-device or audible-latency claim. A/A is a noise control, not evidence of a speedup. Reject/revert a failing candidate; preserve evidence rather than relax the gate.
- [x] Run all affected tests, required fast local gate, boundary typecheck and diff audit. Document exact commands, counts, outcomes, skips and limitations.

Review focus: zero-size buffers through the actual WebGPU path; every layer/key/value aliases the same empty tensor; retained complete positions/attention; cache shape changes isolated from all other feeds; exact logits at every diffusion pass; failed/cancelled generation still disposes tensors and allows recovery. Final status and measured results will be appended here.

Ruling before candidate timing: the first A/A control (32 generations) varied by 4.45% CPU and 2.47% wall. Move cache-content scans to a separate worker command after the CPU snapshot, so shrinking the baseline cache cannot manufacture a benchmark win from validation overhead. Preserve the initial control and rerun A/A before A/B. Keep all acceptance rules unchanged.

## Results and feedback disposition

**No production optimization qualified.** The candidate and its three additional empty-cache tests are retained only in ignored artifacts as `rejected-runtime.js` and `rejected-runtime.test.js`. Production runtime and original runtime tests are restored exactly; no starting test was removed or weakened.

Confirmed resource inefficiency: complete-sequence recomputation does not need the old cache slots. The candidate preserved every raw main-logits buffer, all non-cache feeds, decoder tokens, RNG traces, speaker metadata and raw float32 PCM for the 32 A/B generations. There were 48 main passes per generation (1,536 checked logits buffers), no GPU validation errors, and successful zero-live-buffer cleanup in all four workers.

Not supported by measurements: removing those transfers makes full synthesis faster on this workload. The candidate failed the predefined CPU gate. Existing whole-tensor waste was also not found: graph inspection showed 313 initializers, all used by the selected audio-output dependencies (7,181 of 9,477 prepared nodes). The largest initializer is a 151,676-by-1,024 FP16 text embedding; its runtime access already gathers selected rows.

Unresolved: sparse arithmetic, dynamic embedding compaction, different GPU architectures or a new native sampler could have different tradeoffs. Graph dependency does not prove every scalar weight is essential. No evidence here justifies pruning learned weights, changing precision/steps, or introducing C++ for an unmeasured calculation. These alternatives are not claimed impossible or validated.

| Warm metric, 12 observations per arm | Baseline | Empty cache | Decision |
| --- | ---: | ---: | --- |
| Pooled browser CPU seconds | 4.116736 | 4.205812 | +2.16%, fail |
| Median synthesis ms | 1,043.625 | 1,063.295 | +1.88%, within 5% bound |
| Maximum allocated live GPU-buffer bytes | 1,403,280,372 | 1,400,832,788 | 2,447,584 fewer |
| Median engine input-write bytes/generation | 15,436,384 | 297,568 | 98.07% fewer |

English (six warm observations per arm): CPU 2.107107 -> 2.078006 seconds; median wall 1,119.308 -> 1,108.520 ms. Swedish: CPU 2.009629 -> 2.127806 seconds; median wall 1,035.523 -> 1,030.470 ms. Pooled medians differ from per-voice medians because their distributions overlap; no per-voice exception overrides the pooled gate.

Shape-cold (four observations per arm), reported separately: CPU 2.222507 -> 2.233794 seconds; median wall 1,192.963 -> 1,197.625 ms. Initialization (two workers per arm): median wall 4,508.373 -> 5,154.705 ms; pooled CPU 16.693678 -> 16.481492 seconds. No cold/setup win is attributed to the candidate. Final A/A control (32 generations): identical outputs/storage, CPU variation 1.74%, wall variation -1.35%; it cannot qualify as an optimization. The initial control is also preserved, for 96 real generations across all attempts.

Environment: Windows 11 x64 (10.0.26300), Intel Core Ultra 9 285K, 24 logical CPUs, 67,939,164,160 bytes system memory, Chromium 156.0.8078.4, NVIDIA Blackwell adapter. Driver, power mode and background load were not measured. Timing includes equal development hashing/validation/CDP work; cache-content scans are excluded. One non-exclusive host and two short requests do not establish statistical significance, actual energy savings, physical VRAM residency, all-voice parity or audible latency. No new listening, UI, offline, long-session, physical low-end or all-language qualification was performed. Exact output evidence covers only the fixed requests. All automated audio was muted.

## Retained changes

- `tooling/scripts/benchmarks/omnivoice.mjs`: reusable serial, pinned, exact-output runtime A/B.
- `tooling/scripts/lib/omnivoice-runtime-comparison.mjs`: testable warm scoring and per-voice summaries.
- `tests/engines/omnivoice-runtime-comparison.test.js`: 16 discovered regression cases for CPU/latency/storage gates, the exact 5% boundary, cold separation, invalid/incomplete evidence and A/A controls.
- `docs/benchmarks/omnivoice.md`: reproduction, metric definitions and limits.
- This report.

The scoring helper was extracted after measurement and checked against both saved reports, preserving the rejection. It directly compares the 1.05 latency ratio so floating-point percentage formatting cannot reject the exact 5% boundary. `measured-harness.mjs` retains the actually executed source; original JSON reports are untouched. Generated `*-summary.json` files contain the extracted helper's per-voice output.

## Exact commands and verification

Run from `F:\Github\PageNarrator` in PowerShell. Reports refuse existing output names; choose fresh names for reruns. To reproduce the rejected candidate, pass `--candidate=artifacts/omnivoice-micro-20261105/rejected-runtime.js`; production files need not be swapped.

```powershell
git rev-parse HEAD
git status --porcelain=v1
npx vitest run --config tooling/vite.config.js tests/tts/omnivoice-runtime.test.js tests/tts/omnivoice-confidence.test.js tests/engines/omnivoice-rmsnorm-contract.test.js
npx vitest run --config tooling/vite.config.js tests/tts/omnivoice-runtime.test.js -t 'uses one empty KV tensor'
node artifacts/omnivoice-micro-20261105/inspect-graph.mjs
node tooling/scripts/benchmarks/omnivoice.mjs --baseline=artifacts/omnivoice-micro-20261105/baseline-runtime.js --control --output=artifacts/omnivoice-micro-20261105/speech-aa.json
node tooling/scripts/benchmarks/omnivoice.mjs --baseline=artifacts/omnivoice-micro-20261105/baseline-runtime.js --control --output=artifacts/omnivoice-micro-20261105/speech-aa-final.json
node tooling/scripts/benchmarks/omnivoice.mjs --baseline=artifacts/omnivoice-micro-20261105/baseline-runtime.js --output=artifacts/omnivoice-micro-20261105/speech-ab.json
npx vitest run --config tooling/vite.config.js tests/engines/omnivoice-runtime-comparison.test.js
npm run verify:fast
npm run typecheck:boundaries
git diff --check
```

The A/B command ran with the candidate installed, then that runtime was reverted. Initial control code included cache-content scans; the amended control and A/B excluded them. The exact measured source and both scoring plans are retained, rather than representing the current extracted helper as byte-identical to the earlier harness.

Baseline affected suite: 134 passed in three files. Candidate test-first run: three intended failures, 92 tests filtered out; subsequent affected candidate suite: 137 passed in three files. These three candidate-specific tests were removed with the rejected candidate. Scoring helper initially failed collection because it did not yet exist, then exposed a parameterization mistake (fixed); final targeted scoring suite: 16 passed. These deliberate development failures and rejected A/B exit 1 are not pre-existing suite failures. Full final checks and review results will be recorded below.

**Remaining objective:** a faster production OmniVoice runtime is unachieved. Adoption of this slice is blocked by its measured warm CPU gate; no model access or permission is missing. A different optimization needs new causal evidence and unchanged quality gates. No GitHub Actions, release, external publication or dependency changes were made.

## Final verification

`npm run verify:fast` exited 0, including every configured stage:

| Check | Observed result |
| --- | --- |
| Repository structure / full lint | Passed |
| Benchmark suite | 41 passed, 0 failed, 0 skipped |
| Full discovered suite | **45,470 passed, 0 failed, 4 skipped**; 497 files passed, 1 skipped |
| Profiles | 56 passed in 8 files |
| Strict typecheck | Passed |
| PDF corpus | 124 passed, 0 failed, 1 optional skip |
| Production build / native / preset checks | Passed; 640 OmniVoice preset bindings checked |
| Separate boundary typecheck | Passed |
| Final CLI `--prepare` / JavaScript syntax checks | Passed |
| Independent read-only review | No actionable findings; independently checked every A/B quality hash and cleanup result |
| `git diff --check` / new-file whitespace check | Passed |

Full gate log: `artifacts/omnivoice-micro-20261105/verify-fast.log`. No pre-existing test failure was observed in the affected baseline or final full suite. The four full-suite skips are the optional lanes controlled by `PN_PDF_ACCEPTANCE`, `PN_PDF_LIBRARY_ACCEPTANCE`, `PN_REAL_PDF_CORPUS` and `PN_SUMMER2026_PDF_CORPUS`. The corpus command separately skipped the unconfigured optional local corpus (`localCorpus: null`). They remain unverified. The installed Node/npm versions differ from the declared toolchain; that declared toolchain was not tested.

Final audit (`audit.py`, `final-audit.json` in the artifact directory): all 74 starting engine/runtime source hashes are unchanged; runtime SHA-256 is `957d36ec8d37ac42468ac6f4d656e5ea1f66ae8455f6430d632fa538be625153`, identical to its saved baseline. Original runtime test blob matches HEAD (`e990ede3971ccd7acee2b7e6d3bf259e2401b283`), with no diff. Unrelated PDF/navigation/media/localized website work changed concurrently and was left untouched; the audit records those differences rather than claiming the whole dirty tree stayed frozen. Full gate counts apply to the source state observed during that run, not later unrelated edits. No commits were made.

Additional final commands:

```powershell
node tooling/scripts/benchmarks/omnivoice.mjs --baseline=artifacts/omnivoice-micro-20261105/baseline-runtime.js --control --prepare --output=artifacts/omnivoice-micro-20261105/final-cli-smoke.json
node --check tooling/scripts/benchmarks/omnivoice.mjs
node --check tooling/scripts/lib/omnivoice-runtime-comparison.mjs
python artifacts/omnivoice-micro-20261105/audit.py
git hash-object tests/tts/omnivoice-runtime.test.js
git rev-parse HEAD:tests/tts/omnivoice-runtime.test.js
git diff --check
```
