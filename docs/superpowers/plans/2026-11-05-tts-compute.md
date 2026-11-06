# Exact Kokoro CPU compute reduction

> **For agentic workers:** Execute the slices sequentially using the executing-plans and verification-before-completion skills. The user explicitly authorized autonomous local implementation and verification.

**Goal:** Reduce CPU compute for Kokoro synthesis while retaining identical float32 audio, voices, feeds and segmentation.

**Architecture:** Factor repeated weight-zero-point subtraction out of quantized LSTM dot products. Reuse each quantized activation sum for all gate columns. Share each activation load across two SIMD packs (eight columns), with four-column and scalar remainders. Keep the arithmetic integral until the existing float conversion and scaling; retain all validation, scheduling and resource ownership.

**Tech stack:** C++20, Zig 0.17.0, WebAssembly SIMD, JavaScript, Vitest and Chromium.

**Spec:** User request in this chat; benchmark and numerical policies in `docs/benchmarks/` and `docs/browser-engine.md`.

## Starting evidence and feedback validation

- Revision: `5fcaa1091113f99dd1d74c732a15538c66e470d5`.
- Existing changes: `docs/CHANGELOG.md`, `extension/manifest.json`, `package-lock.json`, `package.json`, `tests/ci/guardrails.test.js`, `tests/pdf-engine/devicen-shading.test.js`, `tests/website/website-copy.test.js`. Preserve these. Snapshot in ignored `artifacts/tts-compute-20261105/starting-local.patch`.
- No concrete feedback or attachment supplied; template placeholders do not constitute claims.
- Confirmed: all six CPU Kokoro recurrent nodes use DynamicQuantizeLSTM; native SIMD and scalar dot products repeatedly subtract invariant weight zero points.
- Disproved optimization hypothesis: additional identical non-Cast/Shape graph transforms are absent in the four cached speech graphs.
- Unresolved before measurement: whether factoring zero-point correction reduces full synthesis CPU cost. Prior local experiments show kernel-only improvements need not reduce total CPU.

## Predefined decision rule

Freeze models, source text, voice, speed, browser, backend and chunking. Synthesize serially, muted. Require bit-identical finite non-silent raw float32 PCM, model feeds and chunk lengths across A/B. Kernel regression tests cover signed/unsigned weights, scalar/per-channel zero points, reverse/bidirectional traversal, batch, SIMD tails and feature bounds; compare against frozen baseline output hashes and the existing independent oracle.

Accept only if paired, counterbalanced native-kernel runs reduce median CPU time by at least 5%, and repeated worker runs reduce pooled browser-process CPU with no >5% median warm synthesis latency regression or increased engine arena peak. Measure cold initialization separately. Report scoped results, never energy, audible latency or untested-device claims. Reject the production change if these gates fail.

## Dependency-ordered slices

- [x] 1. Freeze baseline binaries, regression vectors and repeatable native-kernel A/B harness. Run existing affected tests before edits. Baseline worker report already captured in `artifacts/tts-compute-20261105/baseline-wasm.json` (1 cold + 2 warm). 95 tests passed. Initial A/A showed CPU quantization noise; calibrated from 3 to 30 replays per sample. Calibrated A/A correctly rejected a speedup.
- [x] 2. Factor zero-point correction and share activation loads across eight columns; rebuild both speech binaries and manifests. Verify exact regression vectors, replay, invalid inputs and independent numerical tests. Run native-kernel A/B before full speech. Final affected run: 131 tests passed in 3 files, including 54 new serial/shared regression cases.
- [x] 3. Counterbalance worker A/B under identical inputs; compare exact PCM/feeds/chunks, CPU, latency, arena peaks and cleanup. Keep only a qualified change. All 15 valid speech pairs were exact; all three measured profiles passed the predefined warm CPU/latency/memory rule.
- [x] 4. Run repository local checks, review final diff, document commands/counts/results and limits. The initial pre-existing version/license-document failure was fixed on explicit follow-up request; the complete `verify:fast` rerun passed. No GitHub workflow edits or external publication.

## Review focus

Integer overflow bounds during factored corrections; asymmetric zero points and signed weights; zero steps; state update order; invalid scales/data must still fail; both serial and shared-memory binaries must match source manifests. A/B timings exclude test/build activity. Existing local changes must remain intact.

## Experiment ledger

- Factored correction alone: exact outputs; 2.27%/7.29% median kernel CPU reductions on 32/128 steps. Rejected: short shape missed the predefined 5% gate.
- Factored correction plus eight columns: exact outputs; 27.33%/28.88% median kernel CPU reductions, 30.28%/26.94% wall reductions. Qualified for full worker A/B; no full-speech claim yet.
- Measurement setup correction: `a2-wasm` and interrupted `a3-wasm` swapped original binaries without original manifests, which correctly triggered production's serial fallback. Excluded from four-worker comparisons because observed worker counts differ. Preserve reports/logs; rerun `a2-corrected`, `b2-corrected`, `b3-corrected`, `a3-corrected` with both manifests and explicit observed-worker assertions. Original A1/B1 are valid; B2/B3 remain exploratory extra candidate runs and are reported separately.

## Measured results

Reports and baseline binaries are retained in ignored `artifacts/tts-compute-20261105/`. `summary.json` applies the acceptance rules and checks matching model pins, browser, hardware capabilities, worker topology, PCM hashes, model feeds and chunks. Main order: A1/B1/A2/B2/B3/A3. Each browser process records one runtime-cold and two warm samples. The second voice and serial checks each use one A/B process pair and have less evidence.

| Warm workload | Samples per arm | Mean browser CPU seconds, A → B | CPU reduction | Median synthesis ms, A → B | Peak engine arena bytes, A = B |
| --- | ---: | ---: | ---: | ---: | ---: |
| af_heart, four workers | 6 | 32.674 → 32.196 | 1.46% | 19,386 → 19,738 (+1.81%) | 451,280,896 |
| bf_emma, four workers | 2 | 35.676 → 31.841 | 10.75% | 21,987 → 18,409 (−16.27%) | 425,984,000 |
| af_heart, serial | 2 | 28.855 → 27.836 | 3.53% | 29,419 → 28,027 (−4.73%) | 450,363,392 |

Cold mean browser CPU seconds: af_heart four-worker 36.487 → 36.074 (3 per arm), bf_emma 35.973 → 35.042 (1 per arm), serial 29.802 → 30.391 (1 per arm, regression). Cold model setup, compilation and snapshot costs are included; the acceptance rule concerns warm synthesis. Do not describe cold serial CPU as improved.

Native kernel A/B (4 counterbalanced samples per arm per shape, 30 replays per sample): 32 steps reduced median CPU 27.33% and wall time 30.28%; 128 steps reduced CPU 28.88% and wall time 26.94%. Both used batch 1, hidden width 256, 640 features and two directions, with exact sequence and final-state hashes. Baseline A/A calibration rejected a false speedup. The first candidate's short shape missed the 5% gate and was rejected.

All 15 valid before/after speech pairs (30 syntheses) matched raw float32 PCM, input IDs/style/speed bits and source chunk boundaries. Audio was finite, non-silent and 24 kHz. Worker closure was observed with no live worker targets before browser shutdown. CPU native counters cannot be read after `Worker.terminate`; this is an explicit cleanup evidence boundary, not a zero retained-byte claim.

The lifecycle probe passed 4 cases: normal streaming, active CPU cancellation/disposal with lazy recovery, offline registry restart, and finite-bit-flipped required-style rejection/eviction/repair. Boundary typechecking passed. A read-only independent reviewer found no actionable findings; no tests ran in that review.

## Exact commands

From the repository root, using PowerShell:

```powershell
git rev-parse HEAD
git status --short
$env:PN_ZIG = (Resolve-Path '.cache/toolchain/upgrade-v1.0.3/zig-x86_64-windows-0.17.0/zig.exe').Path
node tooling/scripts/build-kokoro-engine.mjs
node tooling/scripts/build-kokoro-parallel.mjs
npx vitest run --config tooling/vite.config.js tests/engines/kokoro-recurrent-exact.test.js tests/engines/kokoro-cpu.test.js tests/engines/kokoro-parallel-native.test.js
node tooling/scripts/benchmarks/kokoro-recurrent.mjs --baseline artifacts/tts-compute-20261105/baseline-kokoro-engine.wasm --candidate artifacts/tts-compute-20261105/baseline-kokoro-engine.wasm --output artifacts/tts-compute-20261105/kernel-aa-calibrated.json
node tooling/scripts/benchmarks/kokoro-recurrent.mjs --baseline artifacts/tts-compute-20261105/baseline-kokoro-engine.wasm --candidate artifacts/tts-compute-20261105/factored-kokoro-engine.wasm --output artifacts/tts-compute-20261105/kernel-ab-1.json
node tooling/scripts/benchmarks/kokoro-recurrent.mjs --baseline artifacts/tts-compute-20261105/baseline-kokoro-engine.wasm --output artifacts/tts-compute-20261105/kernel-ab-2.json
node tooling/scripts/benchmarks/kokoro.mjs --backend wasm --mode stream --case heart-connected --repeats 2 --output artifacts/tts-compute-20261105/baseline-wasm.json
node artifacts/tts-compute-20261105/run-ab.mjs
node artifacts/tts-compute-20261105/summarize.mjs
npm run verify:fast
npm run test:profiles
npm run typecheck
npm run test:pdf-corpus
npm run build
npm run typecheck:boundaries
node tooling/scripts/probe-kokoro-registry.mjs --backend wasm --output artifacts/tts-compute-20261105/lifecycle-wasm.json
git diff --check
```

The worker script prints each exact underlying command and switches both binary/JSON pairs together, restoring the candidate in `finally`. It runs `--case heart-connected` or `emma-connected`, adds `--serial-cpu` for the serial control, and requires the observed worker count in every result. B1 used the baseline command with output `b1-wasm.json`. Preserve original and candidate binaries/manifests before switching. Outputs must use new filenames; the native benchmark intentionally rejects overwrite. A/A and the rejected first candidate exit 1 by design, not as test-suite failures.

## Changed files

- `engines/native/kokoro-engine.cpp`: exact quantized projection optimization; no ABI, model, precision, voice or segmentation changes.
- `extension/public/native/kokoro-engine.{wasm,json}` and `kokoro-parallel.{wasm,json}`: rebuilt executable data and source/binary manifests, preserving import restrictions.
- `tests/engines/kokoro-recurrent-exact.test.js`: serial/shared output/state/replay, empty-sequence, overflow-bound, extreme-cancellation and non-finite validation coverage; normally discovered by Vitest.
- `tests/helpers/kokoro-recurrent-fixture.js` and `tests/fixtures/kokoro-recurrent-exact.json`: deterministic vectors and 19 output/state controls generated by the original binary, including 4/8/scalar mixed tails and the maximum feature count.
- `tooling/scripts/benchmarks/kokoro-recurrent.mjs`: repeatable counterbalanced kernel comparison and exactness gate.
- `docs/benchmarks/README.md` and this file: reproduction, decision rules, results and limitations.

## Verification results

| Command | Observed result |
| --- | --- |
| Affected Vitest command above | 3 files, 131 tests passed; includes 54 new regression tests |
| `npm run verify:fast` | Failed at `test:ci` because of the pre-existing failure below; preceding structure/lint/benchmark steps passed |
| `npm run test:benchmarks` (inside gate) | 41 passed, 0 failed, 0 skipped |
| `npm run test:ci` (full default test discovery, inside gate) | 490 files passed, 1 failed, 1 skipped; **45,296 passed, 1 failed, 4 skipped** (45,301 tests) |
| `npm run test:profiles` (continued independently after gate stopped) | 8 files, 56 tests passed |
| `npm run typecheck` and `npm run typecheck:boundaries` | Both passed |
| `npm run test:pdf-corpus` | 124 passed, 0 failed, 1 optional skip; 1,106 document opens, 0 retained opens/backend errors |
| `npm run build` | Passed, including native source/binary/data/preset hash checks; existing ineffective-dynamic-import notices for unchanged JS imports |
| CPU registry lifecycle probe | 4 cases passed |
| Native kernel A/B | Both shapes accepted; initial A/A and rejected candidate are explicitly retained |
| Final diff/preservation audit | `git diff --check` passed; all seven initial modified-file diffs are byte-identical to the starting snapshot; measured candidate binary hashes equal the final rebuilt binaries; no `.github` changes |

**Initial pre-existing failure, subsequently fixed:** `tests/voice/voice-license-readiness.test.js:83`, “documents the Kokoro Apache license and release scope,” expected `PageNarrator 1.0.4` from the already-modified package version, while `docs/third-party-voice-licenses.md` still contained `PageNarrator 1.0.3`. The initial `pre-existing-failure.json` recorded that both test and document matched HEAD and that the starting package diff was preserved. On explicit follow-up request, the document was synchronized to `1.0.4`; the complete gate then passed as recorded below. The initial failing run above is retained as historical evidence.

**Existing skips:** the four optional PDF lanes controlled by `PN_PDF_ACCEPTANCE`, `PN_PDF_LIBRARY_ACCEPTANCE`, `PN_REAL_PDF_CORPUS` and `PN_SUMMER2026_PDF_CORPUS` were not enabled. Native Web Locks coverage ran. The corpus command separately reported its optional configured-local-corpus skip. These are unverified optional lanes, not passed tests.

**Review:** independent read-only review found no actionable critical, important or minor findings. It checked integer bounds, recurrent state ordering, tails, empty sequences, signedness/zero points, manifest hashes and normal test discovery. No deferred code findings or unresolved in-scope implementation slices remain.

## Environment and limits

Windows 11 Pro x64 (10.0.26300), Intel Core Ultra 9 285K, 24 logical CPUs, 67,939,164,160 visible memory bytes; Chromium 156.0.8078.4 (Playwright chromium-1248). High performance power scheme was observed after measurement. Node v24.16.0 and npm 11.17.0 were used; these pre-existing installed versions differ from the package's declared Node range (`^22.23.4 || ^24.22.1 || >=26.12.1`) and package manager (`npm@12.2.1`). The checks above describe the actual installed environment; the declared toolchain was not requalified. Full details and hashes are in `environment.json`.

These are observations on one non-exclusive Windows host, with instrumented process CPU rather than energy or hardware cycle counts. The 1.46% main-path observation is small and timing varies; the stronger kernel result must not be presented as a full-speech speedup. Only two voices were synthesized for this comparison. Exact integer equivalence preserves the existing math; this is quality preservation relative to the starting revision, not a new perceptual listening or independent reference-model qualification. WebGPU and OmniVoice performance, physical low-end hardware, energy and audible output latency were not measured. Existing documented duration/PCM reference limitations are outside this compute-preservation change. No release, deployment or workflow change was requested or performed.

## Follow-up: license version synchronization

On 2026-11-05 the user explicitly requested fixing the version mismatch and rerunning the full gate. Updated only the release number in `docs/third-party-voice-licenses.md` from `1.0.3` to the package's `1.0.4`, then ran `npm run verify:fast` from the repository root. Exit code: **0**, with every configured stage completed:

- Repository structure and lint: passed.
- Benchmarks: 41 passed, 0 failed, 0 skipped.
- Full suite: **45,297 passed, 0 failed, 4 existing optional skips**; 491 files passed and 1 skipped.
- Profiles: 56 passed across 8 files.
- Typecheck: passed.
- PDF corpus: 124 passed, 0 failed, 1 optional skip.
- Production build and native artifact checks: passed.
- `git diff --check`: passed.

Full log: `artifacts/tts-compute-20261105/verify-fast-license-fixed.log`. Existing optional skips and the environment limits described above remain applicable. The compute-preservation criteria and the complete `verify:fast` gate are now satisfied; no tests or quality gates were weakened or waived.

## Current-state completion audit

On the goal's continuation, classified the preceding turn as **progress**: it corrected the authorized document and completed the full gate. Reopened completion as unproven and inspected the current native diff, test bodies/discovery, benchmark implementation, gate configuration and raw reports. Executed these additional checks:

```powershell
npx vitest run --config tooling/vite.config.js tests/engines/kokoro-recurrent-exact.test.js tests/engines/kokoro-cpu.test.js tests/engines/kokoro-parallel-native.test.js tests/voice/voice-license-readiness.test.js
node tooling/scripts/build-kokoro-engine.mjs --check
node tooling/scripts/build-kokoro-parallel.mjs --check
node artifacts/tts-compute-20261105/completion-audit.mjs
git diff --check
```

Fresh tests: **135 passed in 4 files**, no failures or skips. Both native source/binary manifest checks passed. The audit executable recalculates adoption metrics from the retained raw samples, checks the original binary against HEAD, regenerates tensor-input hashes, verifies current model-data hashes and runtime source pins, and checks built binaries against the measured candidate. It also validates A/A and rejected-candidate controls, all 15 PCM/feed/chunk pairs, all four lifecycle cases, completed gate stages, original local-change preservation and absence of workflow changes. Eight requirement groups covering every numbered objective and reporting invariant passed. Machine-readable evidence: `artifacts/tts-compute-20261105/completion-audit.json`; fresh test log: `completion-audit-tests.log` in the same directory. The measured optimization and verification results remain applicable to the current worktree. No implementation slice is blocked or incomplete; the documented optional/unmeasured lanes remain outside the claims.
