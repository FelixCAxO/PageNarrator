# TTS compute comparison against the current worktree

**Adopted implementation:** SIMD evaluation of the existing Snake sine
polynomial in both CPU binaries. Recurrent widening was rejected and removed.
Full speech performance/quality gates and required local verification pass.
No model, precision, voice or segmentation change. See the concurrent-work
boundary below before interpreting whole-repository results.

## Scope and starting point

User requested autonomous local implementation and identical-input A/B testing,
preserving voice quality and unrelated work. No actual feedback/attachment was
provided; the feedback field is a placeholder. Starting revision:
`5fcaa1091113f99dd1d74c732a15538c66e470d5`, with an existing recurrent-kernel
optimization and other local edits. This experiment uses those existing edits
as baseline, not HEAD. Snapshot, binaries, manifests and file hashes are in
ignored `artifacts/tts-compute-followup-20261105/`.

## Investigation and decision

Confirmed: quantized recurrent projection currently shares activation loads
across eight columns. Hypothesis: sharing across sixteen columns reduces
loads and loop overhead further without changing integer sums, float
operations, recurrent ordering or model inputs. Alternative: retain eight
columns if register pressure or full-synthesis overhead defeats the savings.
Changing model precision or inference quality is outside this experiment.

Predefined adoption criteria: bit-exact finite output/state and raw PCM hashes,
unchanged feeds, chunks, voices and models; >=5% lower median kernel process
CPU in both existing fixed shapes; lower pooled warm browser CPU with <=5%
median warm latency regression and no increased engine arena peak. Compare
serial muted speech under the same browser and worker topology. Keep cold and
warm observations separate. Reject a candidate that fails any gate.

## Slices

- [x] Freeze current worktree baseline, binaries and manifests; run affected tests.
  `npx vitest run --config tooling/vite.config.js tests/engines/kokoro-recurrent-exact.test.js tests/engines/kokoro-cpu.test.js tests/engines/kokoro-parallel-native.test.js`
  passed 131 tests in 3 files, no skips.
- [x] Capture baseline worker samples and A/A control. Extend exact baseline
  fixtures to cover the new sixteen-column path and remainder combinations.
- [x] Measure sixteen-column projection; rebuild serial and shared binaries;
  retain only if exact regression checks and both kernel performance gates pass.
- [x] Run counterbalanced full worker A/B, apply predefined quality/CPU/latency/
  memory gates, then run required local checks and record commands and counts.

Review focus: integer bounds, signed/unsigned zero points, per-channel scales,
SIMD/scalar remainders, state update ordering, invalid input rejection, unchanged
initial edits and matching binary manifests. No GitHub workflows or publication.

## Kernel evidence

The current-worktree A1 worker baseline completed three syntheses (one
runtime-cold, two warm), all exact across repeats with four observed workers.
The frozen extra cases cover hidden widths 15, 16, 17, 20, 31 and 32, reverse
and bidirectional traversal, signed/unsigned asymmetric weights, scalar and
per-channel scales and batch 2. Combined tests: **155 passed in 3 files**.

The isolated A/A control rejected a speedup: 0% median process CPU reduction
in both shapes; median wall differences below 1%. An earlier A/A attempt
overlapped compilation near its end; retained as `kernel-aa.json`, excluded
from measurement conclusions. The independent A/B run was isolated from
builds and tests. Four counterbalanced samples per arm, 30 replays per sample:

| Shape (steps / features / hidden / batch) | CPU reduction | Wall reduction |
| --- | ---: | ---: |
| 32 / 640 / 256 / 1 | 20.38% | 13.16% |
| 128 / 640 / 256 / 1 | 16.85% | 16.28% |

Both output sequences and both final states are exact. This qualifies only
the kernel, pending full-worker A/B. Generated binaries grew from 60,775 to
63,260 bytes (serial) and 61,986 to 64,471 bytes (shared). There is no extra
model, arena allocation or scheduling change.

## Scope decision before serial results

The completed four-worker primary comparison (6 warm samples per arm) has
31.683808 s versus 31.881012 s mean browser CPU: **0.62% higher**, despite
0.36% lower median latency. It fails the predefined CPU gate. The second
voice's warm CPU improved, but this does not override the primary failure.
Reject sixteen-column scheduling in the shared engine.

Independent slice: qualify sixteen-column scheduling only in the existing
single-worker engine, keeping the shared engine's compiled code identical
to its starting binary. At this decision point the serial A/B pair is still
running. Retain only if its existing full-speech CPU/latency/memory rule
passes and a reverse-order pair confirms it; both pairs must pass separately.
Use the standard WebAssembly atomics compile feature to select the unchanged
eight-column scheduling for shared builds; no runtime policy or worker
selection changes. If either serial pair fails, reject the serial change too.
This is a narrower independent slice, not a changed acceptance threshold for
the rejected shared-engine candidate.

## Rejected recurrent slice and new profile evidence

The serial confirmation failed too: reverse pair CPU **+3.94%**, pooled serial
CPU **+1.43%** (4 warm samples/arm); median latency essentially unchanged and
arena peaks equal. Both recurrent production candidates were removed and the
starting source/binaries/manifests restored before further investigation.
All 18 valid speech PCM/feed/chunk pairs were exact. No full-synthesis CPU
improvement is claimed for the recurrent candidates.

Fresh production-model Node profiling (`--quick --profile`) passed the
independent ONNX CPU comparison in both repeats. Recurrent projection took
about 29 ms / 2.04–2.14 s; Snake activation took 236–245 ms. This explains why
the kernel improvement could not reliably clear the full-worker CPU gate.

New independent slice: evaluate the existing sine polynomial four values at
a time in Snake's contiguous-input, broadcast-alpha/scale layout. Keep the
same constants and float32 operation order. Fall back to the existing scalar
range reduction if any argument is large/nonfinite; keep noncontiguous and
global-tail behavior. Changing approximations or quality is not authorized.

Adoption criteria remain unchanged: exact production-capture output hashes,
>=5% kernel CPU reduction for every captured shape, no >5% wall regression;
exact full-speech PCM/feeds/chunks and lower warm CPU for the primary voice,
second voice and serial control, with <=5% median latency regression and no
increased arena peak. Main speech order ABBAAB, 3 paired processes; other
profiles one pair each. Measure separately from builds/tests. Reject on failure.

The new baseline edge tests pass before editing the kernel. Coverage includes
four-wide and odd rows, broadcast layouts, global double-precision tails,
signed zeros, subnormals and arguments above/below the packet range cutoff.
The native A/A control rejected a speedup on both actual captured shapes.

## Adopted Snake results

The native A/B uses captured production operands of shapes `[1,128,6721]`
and `[1,256,1120]`, four counterbalanced samples per arm, 100 replays/sample.
Outputs match the frozen original output hashes for all 1,147,008 elements.
Median kernel CPU fell **81.68% / 87.47%** and wall time **81.49% / 86.24%**.
These are kernel figures, not full-speech savings. The A/A control rejected a
speedup (2.81% / 0.27% CPU differences, below the predefined 5% threshold).
Post-gate validation of the final harness, including its capture/binary hash
guard, again passed exact outputs and both performance gates: CPU reductions
83.46% / 86.91%, wall reductions 84.08% / 85.40%. This additional attempt is
retained as `snake-ab-validation.json`; the original adoption figures above
are unchanged.

Fresh full-worker order: A1/B1/B2/A2/A3/B3. Each process records one
runtime-cold and two warm syntheses. Second voice and serial each use one
A/B process pair, so their evidence is weaker than the main comparison.
Models, corpus, browser, hardware capabilities, feeds, segmentation, mode and
observed worker topology match across arms; all source pins except the
intended native binaries/manifest remain equal. Every attempt is retained.

| Warm workload | Samples/arm | Mean browser CPU seconds, A → B | CPU reduction | Median synthesis ms, A → B | Peak arena bytes, A = B |
| --- | ---: | ---: | ---: | ---: | ---: |
| af_heart, four workers | 6 | 33.960528 → 32.576004 | 4.08% | 19,586 → 17,628 (−10.00%) | 451,280,896 |
| bf_emma, four workers | 2 | 33.457482 → 29.612748 | 11.49% | 21,299 → 16,671 (−21.73%) | 425,984,000 |
| af_heart, serial | 2 | 28.760196 → 24.899973 | 13.42% | 29,111 → 24,941 (−14.32%) | 450,363,392 |

Cold mean browser CPU seconds, separately: main 36.772269 → 34.616843
(3 samples/arm), second voice 40.451436 → 35.404594 (1/arm), serial
30.781105 → 27.399862 (1/arm). Cold setup includes local file/cache and model
compilation costs, not an internet-download or cold-driver-cache comparison.

All **15 A/B speech pairs (30 syntheses)** have identical raw float32 PCM,
token/style/speed feeds, audio durations and source chunks. Audio is finite,
non-silent and 24 kHz. Worker closure was observed with zero live targets
before browser shutdown. Native counters cannot be read after
`Worker.terminate`; no zero-retained-native-byte claim follows from closure.

Serial WASM grew 60,775 → 61,605 bytes; shared WASM grew 61,986 → 62,816
bytes. There is no new arena allocation. The recurrent implementation and
all prior local changes outside the intended files are preserved.

## Exact commands and artifacts

From `F:\Github\PageNarrator`, PowerShell; reports and matching A/B binaries
are retained under ignored `artifacts/tts-compute-followup-20261105/`.
The scripts print the exact per-process speech commands and restore the
candidate in `finally`; they switch both binaries and matching manifests.
Use new report names when repeating experiments.

```powershell
git rev-parse HEAD
git status --short
node tooling/scripts/probe-kokoro-model-cpu.mjs --quick --profile --output artifacts/tts-compute-followup-20261105/profile-current.json
node tooling/scripts/probe-kokoro-model-cpu.mjs --quick --profile --capture-kernels artifacts/tts-compute-followup-20261105/snake-capture --capture-operations pn_kokoro_snake --output artifacts/tts-compute-followup-20261105/profile-snake.json
$env:PN_ZIG = (Resolve-Path '.cache/toolchain/upgrade-v1.0.3/zig-x86_64-windows-0.17.0/zig.exe').Path
node tooling/scripts/build-kokoro-engine.mjs
node tooling/scripts/build-kokoro-parallel.mjs
node tooling/scripts/benchmarks/kokoro-snake.mjs --baseline artifacts/tts-compute-followup-20261105/kokoro-engine.wasm --candidate artifacts/tts-compute-followup-20261105/kokoro-engine.wasm --fixtures artifacts/tts-compute-followup-20261105/snake-capture/manifest.json --output artifacts/tts-compute-followup-20261105/snake-aa.json
node tooling/scripts/benchmarks/kokoro-snake.mjs --baseline artifacts/tts-compute-followup-20261105/kokoro-engine.wasm --fixtures artifacts/tts-compute-followup-20261105/snake-capture/manifest.json --output artifacts/tts-compute-followup-20261105/snake-ab.json
node tooling/scripts/benchmarks/kokoro-snake.mjs --baseline artifacts/tts-compute-followup-20261105/kokoro-engine.wasm --fixtures artifacts/tts-compute-followup-20261105/snake-capture/manifest.json --output artifacts/tts-compute-followup-20261105/snake-ab-validation.json
node artifacts/tts-compute-followup-20261105/run-snake-ab.mjs
node artifacts/tts-compute-followup-20261105/summarize-snake.mjs
npm run verify:fast
npx vitest run --config tooling/vite.config.js tests/engines/kokoro-snake-exact.test.js tests/engines/kokoro-cpu.test.js tests/engines/kokoro-recurrent-exact.test.js tests/engines/kokoro-parallel-native.test.js
node tooling/scripts/build-kokoro-engine.mjs --check
node tooling/scripts/build-kokoro-parallel.mjs --check
npm run typecheck:boundaries
node tooling/scripts/probe-kokoro-registry.mjs --backend wasm --output artifacts/tts-compute-followup-20261105/lifecycle-wasm.json
node artifacts/tts-compute-followup-20261105/final-audit.mjs
git diff --check
```

The first profiling invocation also included ignored `--model-mode production`;
production is already the default. A/A and rejected-candidate scripts exit 1
intentionally when the adoption rule fails; these are not test-suite failures.
The earlier recurrent experiment commands are retained in `run-ab.mjs`,
`run-serial-reverse.mjs`, `summary.log` and `serial-decision.json`; their rejected
source/binaries/manifests and raw reports are preserved. The excluded first
recurrent A/A overlapped compilation; its isolated rerun is retained too.

## Limits and review

One non-exclusive Windows 11 Pro x64 host, Intel Core Ultra 9 285K, 24 logical
CPUs, about 68 GB system memory, High performance power scheme, Chromium
156.0.8078.4 (Playwright chromium-1248). Actual installed Node v24.16.0 and npm
11.17.0 differ from the repository's declared ranges/package-manager pin;
the declared toolchain has not been requalified. Details: `environment.json`.

The benchmark measures instrumented browser-process CPU and app PCM readiness,
not energy, inference-only CPU or audible playback latency. A large final warm
latency outlier remains in the main candidate samples; no observations were
discarded. Small samples do not establish tail latency, all-voice gains or
statistical significance. No WebGPU, OmniVoice, physical low-end hardware,
cross-platform, new perceptual listening or independent full-corpus model
quality claim is made. Quality is preserved relative to the starting worktree
for the measured inputs; existing documented reference/listening limits remain.

Independent read-only review found no actionable issues in the adopted native
delta, exact regression tests or kernel benchmark. It did not run tests and
declined pending full-worker acceptance, fresh shared-test execution and
cross-platform/exhaustive float32 claims. Fresh execution and final artifact
checks are reported separately below; cross-platform/exhaustive claims remain
outside the evidence. No release, publication or workflow change was requested.

## Final slice status and verification

| Slice | Status | Evidence |
| --- | --- | --- |
| Baseline and feedback validation | Complete | Starting revision/status/diff/hashes; affected baseline 131 tests passed; pinned worker and native baselines |
| Wider recurrent projection | Complete, rejected | Exact outputs, but shared primary CPU +0.62%; serial confirmation failed; production changes removed |
| SIMD Snake activation | Complete, adopted | Captured native CPU gates and all 3 full-speech profile gates passed; 15 exact speech pairs |
| Regression and local verification | Complete | Results below; final measured TTS runtime/source/binary audit passed |

`npm run verify:fast` exited **0** with all configured stages completed:

| Check | Reported result |
| --- | --- |
| Repository structure and lint | Passed |
| Benchmark suite | 41 passed, 0 failed, 0 skipped |
| Full discovered suite | **45,356 passed, 0 failed, 4 optional skips**; 493 files passed, 1 skipped |
| Profiles | 56 passed in 8 files |
| Typecheck | Passed |
| PDF corpus | 124 passed, 0 failed, 1 optional skip |
| Production build and native/preset checks | Passed; existing dynamic-import notices for unchanged imports |
| Additional targeted engine run | **153 passed in 4 files**, no failures/skips |
| Serial/shared native manifest checks | Passed |
| Boundary typecheck | Passed |
| Actual worker lifecycle/recovery probe | 4 cases passed |
| Final TTS source/binary/runtime/preservation audit | Passed |
| `git diff --check` | Passed; a CRLF notice concerns an unrelated concurrent PDF test |

The lifecycle probe exercised normal streaming, active cancellation/disposal
with recovery, offline registry restart, and required-style corruption
rejection/eviction/repair. The new regression file ran through normal test
discovery; 18 serial/shared cases plus 4 added configurations in the existing
CPU test cover the adopted path. Rejected-only recurrent test additions were
removed, returning the pre-existing recurrent test/fixture to their starting
hashes. No starting tests or quality gates were weakened.

Existing optional skips remain the PDF lanes controlled by `PN_PDF_ACCEPTANCE`,
`PN_PDF_LIBRARY_ACCEPTANCE`, `PN_REAL_PDF_CORPUS` and `PN_SUMMER2026_PDF_CORPUS`.
The corpus command also skipped its unconfigured optional local corpus. These
lanes remain unverified. No pre-existing test failures were observed in the
starting affected run or final gate; rejected benchmark decisions are not
test-suite failures. Release/end-to-end/human listening and physical-device
qualification were not run as part of this local compute change.

**Concurrent-work boundary:** unrelated PDF source/tests/plans and a changelog
entry appeared while this task ran, and continued after the full gate. They
were left intact and are inventoried in `concurrent-pdf-work.json`. The full
gate result is the recorded run, not a claim that later concurrent PDF edits
were reverified. The final audit separately checks every measured TTS runtime
pin, current native source, both binaries/manifests, starting local-file
preservation, and absence of workflow edits. All measured TTS pins still match.
Twelve unrelated starting local files remain byte-identical; the six intended
starting files changed, and the changelog received the concurrent PDF entry.

Files changed by this TTS task relative to the starting worktree:

- `engines/native/kokoro-engine.cpp`
- `extension/public/native/kokoro-engine.wasm` and `kokoro-engine.json`
- `extension/public/native/kokoro-parallel.wasm` and `kokoro-parallel.json`
- `tests/engines/kokoro-cpu.test.js`
- `tests/engines/kokoro-snake-exact.test.js`
- `tooling/scripts/benchmarks/kokoro-snake.mjs`
- `docs/benchmarks/README.md`
- `docs/superpowers/plans/2026-11-05-tts-compute-followup.md`

Detailed logs: `verify-fast.log`, `final-tests.log`, `lifecycle-wasm.log`.
Machine-readable evidence: `snake-summary.json`, `snake-ab.json`,
`lifecycle-wasm.json`, `final-audit.json`, plus all retained raw A/B reports.
No in-scope implementation slice remains blocked; unmeasured lanes and the
concurrent-work boundary limit the claims as described above.
