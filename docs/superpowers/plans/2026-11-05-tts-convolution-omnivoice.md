# Exact Kokoro convolution and OmniVoice compute reduction

**Outcome:** no new production optimization qualified. Kokoro source and both
native binary/manifest pairs are exactly restored, as are OmniVoice runtime and
tests. Prior optimizations remain intact. This is a negative experiment result,
not an additional TTS compute improvement. New convolution regression coverage
and the reusable captured-kernel benchmark remain for future work.

Starting revision: `5fcaa1091113f99dd1d74c732a15538c66e470d5` with existing
Snake/recurrent optimizations and unrelated PDF/local changes. Snapshot,
starting file hashes, baseline native source/binaries/manifests and all
experiments: ignored `artifacts/tts-conv-omni-20261105/`. Preserve this work.

User requested targeting Kokoro integer convolution next, keeping identical
audio and the preceding A/B criteria, and also trying to improve OmniVoice.

## Criteria and slices

Freeze model pins, voices, seeds, text, feeds, speed, precision, diffusion
steps, browser, backend, worker topology and segmentation. Require exact finite
output/PCM/feed/chunk hashes. Native/sampler kernels must reduce median process
CPU >=5% in every fixed measured shape; median wall regression <=5%. Qualify
through full synthesis separately: pooled warm browser CPU lower, median
latency regression <=5%, no increased native arena peak. Measure cold separately.
Counterbalance main synthesis ABBAAB (three pairs, one cold and two warm samples
per process), plus second voice and serial control for Kokoro. Benchmarks run
serially, without tests/builds or another synthesis workload. Keep every attempt;
reject candidates that miss adoption gates. No model/quality changes.

- [x] Freeze current baseline. Existing affected native tests: 84 passed in 3 files.
  Production short-model oracle/profile/capture passed both repeats.
- [x] Kokoro experiment, rejected: factor weight-zero-point correction out of repeated dot products.
  Compute each packed activation-column sum once, keep integer accumulation
  and unchanged shapes/tiling/resources. Compare actual captured production
  tensors and independent signed/unsigned/group/tail/boundary tests.
- [x] OmniVoice experiment, rejected: independently investigate exact redundant work, then test and
  measure any justified candidate without altering model iterations or quality.
- [x] Apply qualification gates, run local checks, audit preserved
  changes and document commands/counts/results/limits.

## Causal evidence and bounds

Captured dominant convolutions use unsigned weights with nonzero weight zero
points (67–76). The same zero subtraction is repeated in every vector load for
every spatial tile. Identity: `dot(a,w-z) = dot(a,w) - z*sum(a)`. Admission bounds
already ensure products*65025 <= INT32_MAX. Both raw sums and corrections stay
within this bound, and the corrected dot has the existing bound; signed weights
and zero points share a type, so their difference stays within +/-255. Packed
activation differences also stay within +/-255. The change must preserve padded
zeros, output-channel zero points, group offsets, SIMD/scalar tails and wrapper
refusal-before-write behavior. Extra fixed stack sums must not allocate arena
storage or change shared-worker reservations.

## Experiment ledger

- Baseline A/A: rejected a speedup in all three actual captured convolution
  shapes, as required. All original captured integer outputs matched.
- Factored correction: exact and 84 existing tests passed; CPU savings
  3.79% / 8.21% / 3.37%. Rejected: two shapes missed the 5% gate.
- Bounded prepared-weight vectors: exact and 109 tests passed, but CPU costs
  increased 80.95% / 66.05% / 20.04%. Rejected and removed. Extra weight-packing
  and load costs did not pay off; no full-synthesis claim or memory waiver.
- Final kernel trial: six spatial columns per filter pair, keeping one
  activation vector live at a time and leaving four-column remainders. Reuses
  each widened/centered weight vector across more dots without weight copies
  or a larger arena. Integer reduction order within each output is unchanged.
  Native qualification pending. If this misses its gates, retain the baseline
  and document that no local kernel candidate qualified, rather than selecting
  a faster-looking sample or changing the scoring rule.

Six-column timing also failed (CPU +59.78% / +70.08% / +37.12%), despite
133 passing tests. All three variants were removed. Architectural reassessment:
arithmetic/SIMD reuse is not delivering savings on this V8 implementation.
Separate cache-working-set hypothesis: retain the original microkernel but cap
its internal spatial tile at 16 rather than 32. A 32-column packed activation tile
is about 90 KiB for the dominant 1408-product shape, versus 45 KiB at 16. This is a
source-derived working-set hypothesis, not a measured cache-miss diagnosis.
It changes neither integer arithmetic nor the public scratch reservation.
Keep the same frozen three captured shapes and >=5% per-shape CPU gate. Reject
this candidate too if it fails; do not infer a speech win from a kernel result.

Cache16 also failed: CPU improvements 5.98% / 1.94% / -1.31%, with exact
captured outputs and 133 passing tests. Rejected because two shapes missed the
5% threshold. All Kokoro production source and both binary/manifest pairs were
restored byte-for-byte to this task's starting state. No full-speech Kokoro A/B
is run for these rejected candidates; the native gate is the blocker. The new
independent regression coverage and captured-kernel harness are retained for
future work. No per-dilation specialization is inferred from noisy shape
differences, and no acceptance criteria are weakened.

## OmniVoice experiment

The current runtime already uses target-row projection, compact GQA and fused
half-precision kernels. The investigated change skipped the confidence
normalizer and sorting only when every remaining masked position is selected.
It retained guided argmax arithmetic, finite checks, random draws/order,
deferred mutation, model passes, precision and decoder behavior.

Test-first evidence: three new cases failed against the original implementation
(72,775 exp calls each versus zero required). The candidate then passed 136
tests in 2 files, including exact independent token/RNG/error-order comparisons.
Candidate source/tests and logs remain in the `omni/` artifact subdirectory.

Sampler A/A calibration exposed Windows CPU-timer noise at 60 replays. Both
controls rejected an overall speedup, but some individual small shapes showed
false positives. Replay count was raised to 1,200 **before any candidate timing**;
the amended plan and both controls remain. A/B passed exact code/RNG hashes:
CPU reductions 67.89%, 66.19%, 65.29% for 40-frame half, 150-frame half and 40-frame
float logits. Wall reductions 68.28%, 67.06%, 63.76%. These are final-pass sampler
figures, not full-synthesis savings.

Full-runtime qualification used actual English female-1 and Swedish male-1
presets, seeds 42/45, 24 diffusion steps, speed 1, guidance 2, whisper disabled and
pinned references/models. ABBA worker order, two voices, one shape-cold and one
warm generation per voice/worker: 16 generations total, 4 warm observations/arm.

| Warm full-runtime metric | Baseline | Candidate | Decision |
| --- | ---: | ---: | --- |
| Pooled browser CPU seconds (4 samples) | 1.022943 | 1.084325 | +6.00%, fail |
| Median synthesis ms | 969.915 | 1,073.468 | +10.68%, fail |
| Maximum live GPU-buffer bytes | 1,403,280,372 | 1,403,280,372 | Equal |

Cold observations are separate: two setups per arm averaged 7.025 s baseline
versus 6.756 s candidate browser CPU; four shape-cold samples per arm pooled
1.649451 s versus 1.602665 s CPU, with median wall 1,201.608 ms versus 1,198.155 ms.
Setup includes loading/compilation and order/cache effects; no setup or cold
performance improvement is attributed to the sampler change. Adoption was
defined on warm synthesis and still failed.

All 16 generations had identical raw float32 PCM, decoder tokens, all 48 main
model feeds, complete RNG traces and speaker metadata for their matching
request. Every worker cleaned up successfully; no GPU errors were observed.
The sampler improvement did not qualify through full synthesis. It was
rejected and reverted, including its optimization-specific tests; both files
match the pre-edit snapshots exactly. No lower-step/precision compromise or
voice change was used to obtain a passing result.

## Reproduction and preserved evidence

Run from `F:\Github\PageNarrator` in PowerShell. Artifact directory is
`artifacts/tts-conv-omni-20261105/`; reports refuse to overwrite existing files,
so choose new output names for reruns. Each candidate's native source, serial
binary and manifest are saved under `factored-`, `prepack-`, `six-column-` or
`cache16-`. Baseline shared/serial binaries and manifests are also retained.
To rebuild a rejected candidate, copy its saved source into the native source
path and rebuild both variants; restore the current source afterward.

```powershell
git rev-parse HEAD
git status --short
node tooling/scripts/probe-kokoro-model-cpu.mjs --quick --profile --capture-kernels artifacts/tts-conv-omni-20261105/conv-capture --capture-operations pn_kokoro_conv_integer --output artifacts/tts-conv-omni-20261105/profile-baseline.json
npx vitest run --config tooling/vite.config.js tests/engines/kokoro-cpu.test.js tests/engines/kokoro-parallel-native.test.js tests/engines/kokoro-cpu-numerical-boundaries.test.js
$env:PN_ZIG=(Resolve-Path '.cache/toolchain/upgrade-v1.0.3/zig-x86_64-windows-0.17.0/zig.exe').Path
node tooling/scripts/build-kokoro-engine.mjs
node tooling/scripts/build-kokoro-parallel.mjs
npx vitest run --config tooling/vite.config.js tests/engines/kokoro-conv-exact.test.js tests/engines/kokoro-cpu.test.js tests/engines/kokoro-parallel-native.test.js
node tooling/scripts/benchmarks/kokoro-conv-integer.mjs --baseline artifacts/tts-conv-omni-20261105/baseline-kokoro-engine.wasm --candidate artifacts/tts-conv-omni-20261105/baseline-kokoro-engine.wasm --fixtures artifacts/tts-conv-omni-20261105/conv-capture/manifest.json --output artifacts/tts-conv-omni-20261105/kernel-aa.json
node tooling/scripts/benchmarks/kokoro-conv-integer.mjs --baseline artifacts/tts-conv-omni-20261105/baseline-kokoro-engine.wasm --fixtures artifacts/tts-conv-omni-20261105/conv-capture/manifest.json --output artifacts/tts-conv-omni-20261105/kernel-ab-1.json
node tooling/scripts/benchmarks/kokoro-conv-integer.mjs --baseline artifacts/tts-conv-omni-20261105/baseline-kokoro-engine.wasm --fixtures artifacts/tts-conv-omni-20261105/conv-capture/manifest.json --output artifacts/tts-conv-omni-20261105/kernel-ab-2.json
node tooling/scripts/benchmarks/kokoro-conv-integer.mjs --baseline artifacts/tts-conv-omni-20261105/baseline-kokoro-engine.wasm --fixtures artifacts/tts-conv-omni-20261105/conv-capture/manifest.json --output artifacts/tts-conv-omni-20261105/kernel-ab-3.json
node tooling/scripts/benchmarks/kokoro-conv-integer.mjs --baseline artifacts/tts-conv-omni-20261105/baseline-kokoro-engine.wasm --fixtures artifacts/tts-conv-omni-20261105/conv-capture/manifest.json --output artifacts/tts-conv-omni-20261105/kernel-ab-cache16.json
npm run verify:fast
git diff --check
```

The four native A/B commands ran after rebuilding their corresponding candidate,
not consecutively against the restored current binary. Every rejected benchmark
exited 1 by design. For direct comparison without production-file swapping, pass
`--candidate artifacts/tts-conv-omni-20261105/<prefix>-kokoro-engine.wasm`.
Both binary hashes are recorded in every report. Three frozen captured shapes
are `[1,128,6721]`,128output channels, 128 input channels, kernel 11 and respective
dilations 3/1/5; every original output hash matched in every trial.

Omni's exact commands, initial and amended scoring plan, model/request/source
pins, test logs, directly runnable sampler and full-runtime harness are in
`omni/experiment-plan.md`. Its full report is `omni/speech-ab-1.json`. The sampler
artifact was moved only after measurements; the actual initially executed
`tooling/scripts/benchmarks/omnivoice-sampler.mjs` source is retained as
`omni/rejected-omnivoice-sampler.mjs` and its runnable artifact copy adjusts
only its relative lock import. No failed attempt or cold sample was discarded.

## Limits and review

One non-exclusive Windows 11 x64 host, Core Ultra 9 285K, Chromium 156.0.8078.4.
OmniVoice used the same NVIDIA Blackwell adapter in every arm. Browser CPU
includes development hashing/validation/CDP instrumentation; latency is PCM
readiness, not audible playback. Native timings include synchronous Node replay.
Small samples and observed timing variance do not establish significance,
cross-device gains, energy savings or all-voice performance. Optional browser UI,
physical low-end hardware, new listening and full-corpus quality qualification
were not performed. Negative results are scoped to these implementations and
measurements, not proof that these engines cannot be optimized further.

Independent read-only review found no actionable numerical/bounds/order/test
issues in the six-column or Omni candidates; it did not run tests or claim
performance acceptance. Both were nevertheless rejected by the measured gates.
No release, GitHub Actions change/trigger or external publication occurred.

## Final verification and scope

`npm run verify:fast` exited 0 after every configured stage:

| Check | Reported result |
| --- | --- |
| Repository structure / lint | Passed |
| Benchmark suite | 41 passed, 0 failed, 0 skipped |
| Full discovered suite | **45,443 passed, 0 failed, 4 optional skips**;495 files passed, 1 skipped |
| Profiles | 56 passed in 8 files |
| Typecheck | Passed |
| PDF corpus | 124 passed, 0 failed, 1 optional skip |
| Production build / native / preset checks | Passed |
| Additional targeted Kokoro/OmniVoice suite after restoration | **265 passed in 6 files**, no failures/skips |
| Native source/binary manifests | Both passed |
| Boundary typecheck | Passed |
| Final restoration / source-pin / result audit | Passed |
| `git diff --check` | Passed; CRLF notice concerns unrelated concurrent PDF work |

The new 52 convolution cases ran through normal test discovery. Production
Kokoro source and all 4 native assets match the starting hashes; Omni runtime
and confidence tests match their pre-edit snapshots. Every other measured
Omni runtime source pin is unchanged. Candidate-specific exp-call tests were
reverted with the rejected candidate; no starting test or gate was weakened.

Four optional PDF lanes remain skipped (controlled by `PN_PDF_ACCEPTANCE`,
`PN_PDF_LIBRARY_ACCEPTANCE`, `PN_REAL_PDF_CORPUS`, `PN_SUMMER2026_PDF_CORPUS`).
The PDF corpus command separately skipped its unconfigured optional local
corpus. These are unverified lanes, not passed tests. No pre-existing test
failure was observed in the baseline affected run or the full local gate.
Rejected A/A/A/B benchmark exits are expected decisions, not suite failures.

Additional final commands:

```powershell
node tooling/scripts/build-kokoro-engine.mjs --check
node tooling/scripts/build-kokoro-parallel.mjs --check
npm run typecheck:boundaries
npx vitest run --config tooling/vite.config.js tests/engines/kokoro-conv-exact.test.js tests/engines/kokoro-cpu.test.js tests/engines/kokoro-parallel-native.test.js tests/engines/kokoro-cpu-numerical-boundaries.test.js tests/tts/omnivoice-confidence.test.js tests/tts/omnivoice-runtime.test.js
node artifacts/tts-conv-omni-20261105/audit.mjs
git diff --check
```

Retained repository changes from this task:

- `tests/engines/kokoro-conv-exact.test.js`: independent grouped/batched/tail/
  signedness/zero-point/int32-bound regression coverage for both native engines.
- `tooling/scripts/benchmarks/kokoro-conv-integer.mjs`: reusable frozen-capture
  exactness and counterbalanced CPU/wall comparison.
- `docs/benchmarks/README.md`: reproduction and acceptance instructions.
- This experiment report.

Unrelated PDF/changelog/website/media/localization work continued during this
task. None was reverted or attributed to the TTS experiment. Starting status,
binary diff and file hashes are retained; the final audit lists unchanged
starting files and concurrently changed starting files separately. Full gate
counts include concurrent work at the observed run; later unrelated edits are
not covered by that result. No commits or publication were performed here.

The actual installed Node v24.16.0/npm 11.17.0 differ from the repository's declared
toolchain pins; the declared toolchain was not requalified. Environment and
restoration evidence: `final-audit.json`. Full log: `verify-fast.log`; targeted
log: `final-tests.log`. Detailed rejected-native and Omni reports retain every
sample, fixed input/model/source hash and cold/warm observation.

**Remaining goal:** additional production compute reduction is unachieved.
Kokoro full-speech qualification is blocked by the per-shape native CPU gate;
Omni adoption is blocked by the measured full-runtime CPU and latency gates.
There is no missing model, runtime access or user permission. Further work
needs a new justified architecture/candidate; the failed trials do not justify
shipping a regression or weakening the requested decision rule.
