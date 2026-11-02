# Eager weight-upload batching, 2026-11-01

The prototype waits for GPU completion after groups of eager weight uploads instead of queuing the whole model without intermediate waits. It preserves exact checked speech and lowers the paired median browser commitment peak by **137.91 MiB**, but increases median time to first speech by **2.47%** and establishes no overall CPU saving. Memory improves in three pairs and worsens in one. The tradeoff is left unaccepted; no application source changed in this iteration.

## Change and controls

`WebGpuOnnxSession.releaseHostWeights` becomes asynchronous, waits when accumulated payload reaches 64 MiB, and drains the final partial group. Its factory awaits completion and retains its existing failure cleanup. CPU backends keep the synchronous body before the returned promise settles. The 64 MiB threshold is a grouping target: one large initializer, including its shards, can exceed it. It is not a hard bound on staging, resident RAM or browser commitment.

Only this session module differs between the two packages. Runtime and compute-module snapshots are identical. Both include the reviewed concurrent recorded-voice pacing change recognizing `recording-derived` references (`8b8e710a2791cb553ba52fbd56e889047cd0f5d242411630f76dfb8cf03bcfe1`). All 48 reachable worker/runtime sources are pinned and checked before native tests, after them and after both fresh builds. The model, prepared graph, weights, tensor geometry, two-plan cache, 128 MiB limit, submission bounds, shaders, sampler and speech settings remain intact.

All 17 prototype unit tests pass, including group waits, tail completion, CPU fallback and failure propagation. Both GPUs preserve all **288 actual-step FP16 logit tensors and six source recordings**, with matching decoder codes/PCM/WAV and successful resource cleanup. These observers are excluded from performance claims.

## Four paired cost runs

Fresh muted Chromium 156.0.8078.4 browser trees run on the Ultra 9 / RTX 5090 PC in counterbalanced order. Initialization is measured separately, followed by one 24-step long paragraph and six 12-step repeats. The Windows browser-job cap is 6 GiB. All **128 process observations** satisfy strict membership and cap checks; all **28 corresponding recordings** are exact.

Positive memory values mean less commitment in the candidate. CPU includes initialization and all seven speech requests.

| Pair | Initialization peak saved | Whole-job peak saved | Time to first speech | Total CPU reduction |
| --- | ---: | ---: | ---: | ---: |
| 0, baseline first | -83.51 MiB | 68.62 MiB | 3.01% faster | 3.81% |
| 1, candidate first | 34.26 MiB | 207.20 MiB | 5.08% slower | -3.21% |
| 2, baseline first | 253.59 MiB | 275.23 MiB | 3.06% slower | 0.19% |
| 3, candidate first | 145.65 MiB | -34.30 MiB | 1.87% slower | -2.59% |

Paired median initialization/whole-job peak savings are **89.96 / 137.91 MiB**. Median initialization latency is **3.38% slower**; the sum of initialization and first synthesis is **2.47% slower**. First speech is slower in three of four pairs. Pooled CPU is **0.23% higher overall**, **0.23% higher during initialization**, and **0.49% higher through the first synthesis**. No overall CPU reduction is established.

Synthesis alone is similarly mixed: pooled CPU is 0.22% higher across all requests and 1.15% lower on repeats. Repeat latency improves by a 0.34% paired median. Both variants retain **60,177,560 bytes** in the main plans. Initial eager GPU weights and the small constants uploaded lazily on first inference match in every run. These measurements do not establish a useful reduction in calculations or GPU execution time.

The job records user plus kernel CPU, excluding the controller and fixture server. Its peak includes initialization and short-lived commitment; it is not physical RAM residency or total VRAM. No extra cohort was selected to improve the outcome.

## Repeated-calculation investigation

Following the request to prioritize reuse, a separate static inventory checks the optimized **2,826-node main plan**. Existing optimization reduces the raw 9,477 nodes to this selected plan. No additional duplicates appear among the inspected single-output math, shape and index operations; this does not rule out duplicates outside that inspected set or work repeated across passes.

The inventory identifies candidate work depending only on feeds that the source runtime leaves unchanged between diffusion steps, including one position matrix multiply, one sine and one cosine. It also lists many views and metadata operations. Those counts are **not GPU dispatch counts** and do not establish that retaining results would help: shared workspace can overwrite output buffers. The next investigation traces actual captured commands, complete feed hashes and output-buffer lifetimes before proposing a shared implementation.

## Evidence and limits

Evidence is in `artifacts/upload-backpressure-20261101/`: frozen variants, source/build pins, native parity reports, `long-speech-resources.json`, `init-summary.json`, `cost-summary.json`, prototype test logs and `static-repeats.json`. The initial unit failure from missing fixture metadata and an inventory-launch path error are preserved separately. An initial summary assumption used post-inference weight counts during initialization; the checker now asserts the distinct eager and lazy counts in both phases. These were test/analysis issues, not successful controls or application inference failures.

`accept.mjs`, `check.ps1`, `production-proof.mjs` and `run-e2e.ps1` are prepared paths that were **not run** for this unaccepted candidate. No new full production test suite or continuity qualification is claimed. Current source pins, raw results and report hashes are sealed in `verification.json`; the broader goal remains active.

Only this PC is available, with Intel Xe-LPG correctness controls. Physical 8 GiB RAM/VRAM, weaker dedicated GPUs, power and OS/device audio remain unqualified. Future changes will prioritize computing unchanged work once and reusing it, and will be retained only after measured gains.
