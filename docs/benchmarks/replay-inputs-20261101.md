# Captured replay input uploads, 2026-11-01

The prototype skips repeated uploads of inputs that no captured GPU command or requested output uses. It preserves cache tensor shapes, allocations, validation, model bytes and calculations. It removes 53.23 MiB of observed cache-upload payload per 24-step long paragraph and preserves exact checked speech. Repeated synthesis uses 5.3% less pooled browser CPU, but latency is effectively unchanged and whole-browser commitment peaks are higher in all four pairs. The prototype is rejected for now; the accepted engine remains in place.

## What was tested

The previous [empty-cache experiment](empty-kv-20261101.md) found that this graph never binds the previous-cache payloads. Changing their tensor length affected execution geometry and worsened warm latency. This experiment instead keeps the full `[1,8,L,128]` inputs and tracks buffers used by captured dispatches and copies. Cached replay writes only inputs in that set, including buffers exposed directly as requested outputs. Backends without complete usage tracking retain every write. Alias handling, input length checks, integer validation, range invalidation and capture keys remain intact.

Only `webgpu-compute.js` and `webgpu-onnx-session.js` differ between variants. The runtime is frozen identically in both. A concurrent recorded-voice pacing edit was reviewed and included in the fresh baseline: it changes duration estimates for recorded references; generated references keep their calculation. The runtime SHA-256 is `f2af940a9642e5a163256a0dc60c3feb0fca3db98e29734c7746defda288d964`. The earlier broadcast-mask package was not reused as this experiment's baseline.

The main session still retains two plans under 128 MiB, with separate submissions of at most 256 captured commands. Both variants report **60,177,560 bytes** of retained main allocation. Main/decoder weights, attention mask, sequence lengths, shaders, diffusion steps, seed and sampler are unchanged.

## Full-request cost

Four counterbalanced pairs use fresh muted Chromium 156.0.8078.4 browser trees on the Ultra 9 285K / RTX 5090 PC. Each tree synthesizes the same roughly 19-second paragraph once at 24 steps, then six times at 12 steps. The Windows Job Object has a 6 GiB commitment cap. All 112 before/after process observations satisfy strict membership checks; all 28 corresponding PCM outputs match exactly.

Positive CPU percentages mean less CPU. Positive peak values mean more commitment in the candidate.

| Pair | CPU reduction, all requests | CPU reduction, repeats | Median repeat latency change | Candidate peak increase |
| --- | ---: | ---: | ---: | ---: |
| 0, baseline first | 11.80% | 10.55% | 0.71% slower | 348.35 MiB |
| 1, candidate first | 11.68% | 12.70% | 0.23% faster | 281.46 MiB |
| 2, baseline first | 2.42% | 5.33% | 0.20% slower | 22.60 MiB |
| 3, candidate first | -10.58% | -7.82% | 0.05% slower | 116.61 MiB |

Pooled browser CPU falls **4.10% overall / 5.33% on repeats**; paired median reductions are 7.05% / 7.94%. One pair increases CPU. Paired median latency is **0.47% slower on first requests / 0.12% slower on repeats**, so no useful latency improvement is established. Peak commitment is higher in every candidate pair, with a **199.04 MiB paired median increase**.

The candidate also has a higher initialization peak before the first synthesis in every pair. Usage tracking has not captured a replay plan at that point. These observations do not establish that skipping uploads caused the memory difference, and subtracting initialization peaks would not establish an inference-memory saving. The current evidence is insufficient to accept this tradeoff for the RAM target. No repeat cohort was selected to improve these results.

CPU is browser-job user plus kernel time around synthesis, including worker, renderer, GPU-process host work and transport. Initialization, controller and fixture-server CPU are excluded. Peak commitment includes initialization and short spikes. This is neither GPU execution time nor physical RAM residency.

## Correctness and upload accounting

The 23 prototype unit tests pass. Fourteen native GPU controls, seven on NVIDIA and seven on Intel Xe-LPG, pass with no validation errors or retained buffers/tensors. They cover mutable inputs, shape-only inputs, direct output aliases, shared aliases, integer range invalidation/rejection, metadata-only outputs, empty/nonempty slice replay and copy source/destination tracking. Untracked backends retain their old behavior.

Source-runtime comparisons match **all 288 actual-step FP16 logit tensors and six recordings** across the two GPUs, including the shared-engine 24-step production paragraph. Decoder codes, PCM hashes and source WAV bytes agree within each adapter; cleanup leaves no buffers/tensors or device loss. Observer timings do not enter cost results.

A separate NVIDIA write observer checks the same 48 main passes for one long paragraph. The baseline uploads one shared previous-cache tensor on each pass, totaling 58,245,120 bytes. The candidate uploads only the two cold inputs, totaling 2,426,880 bytes. The **55,818,240-byte difference (53.23 MiB)** is observed logical upload payload, not a VRAM or resident-RAM saving. All 48 step logits, submission counts and the source recording remain exact against uninstrumented controls. These diagnostic timings and memory observations are excluded from the cost cohort.

## Decision and evidence

Keep the existing replay behavior. The prototype demonstrates avoidable work and a modest pooled CPU improvement, but does not yet establish a favorable overall tradeoff. No application source was changed by this iteration. After the A/B, concurrent pacing work also recognized `recording-derived` references; that reviewed runtime change (`8b8e710a2791cb553ba52fbd56e889047cd0f5d242411630f76dfb8cf03bcfe1`) remains preserved. It is separate from both measured, identically frozen runtimes. A new packaged continuity run was not required for this unaccepted prototype.

Local evidence is in `artifacts/replay-inputs-20261101/`: frozen source variants and source pins, fresh packaged builds and build pins, `long-speech-resources.json`, `cost-summary.json`, `parity.json`, both native-control reports, the write traces, `trace-summary.json`, `summary.json`, and sealed artifact hashes in `verification.json`. `baseline-delta.json` and `production-concurrent-delta.json` record the reviewed concurrent runtime changes. `goal-evidence.json` leaves the broader goal active.

Only this PC is available. Job limits and Intel correctness controls do not qualify physical 8 GiB RAM / 8 GiB VRAM machines or weaker dedicated GPUs. Energy use, long sessions and OS/device audio remain unmeasured for this prototype. The next RAM investigation is initialization staging: eager weight uploads currently enqueue the large payloads without awaiting completion between bounded groups.
