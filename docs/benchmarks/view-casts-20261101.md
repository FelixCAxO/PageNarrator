# Half casts through shape views, 2026-11-01

Accepted: the existing redundant-cast helper now reuses half values through one Reshape, Squeeze or Unsqueeze. The current voice-catalog cohort records **four fewer GPU commands per main pass**, **1,658,940 fewer retained main-buffer bytes (1.58 MiB)** and **3.36% lower pooled repeat browser CPU**. All four pairs improve synthesis CPU and browser commitment peaks. Exact speech, 1,696 unit tests and five-minute muted playback under a 5 GiB browser-job cap pass. Startup CPU is higher; this is a continuous-synthesis improvement, with no established startup CPU saving.

## Reuse and correctness

The [fixed-input trace](fixed-inputs-20261101.md) identified this repeated position-calculation sequence:

`half → Cast(float32) → shape view → Cast(half)`

The existing helper followed float casts and Identity aliases. It now recognizes one ordinary Reshape, Squeeze or Unsqueeze and replaces the final narrowing with that view applied to the original half input. It preserves the final output name, view attributes and metadata inputs. Separately requested float outputs retain their original producers. Lossy narrowing, arithmetic, indexing, transposes, foreign domains, nested view chains and unsupported cast attributes remain outside this extension. The view executor retains its validation.

No persistent result cache is added. Model weights, prepared graph, shaders, matrix operations, sampling order, steps, seed, two-plan/128 MiB cache and 256-command submission bounds are preserved. Only `onnx-optimize.js` differs functionally between each paired baseline and candidate. Two packaged test harnesses now use the existing inherited-lock helper, allowing one host lease across qualification; assertions, durations and caps are unchanged.

The 28 focused unit tests pass, including invalid attributes, side outputs and negative controls. Eighteen native controls on each GPU cover all 63,488 finite half values, both infinities, signed zeros, empty/scalar/large views, mutable replay, requested float outputs and cleanup. The current-catalog native corpus matches **288 actual-step half-logit tensors and six source recordings** across NVIDIA and Intel, including decoder codes, PCM hashes and WAV bytes. Instrumented native timings are excluded from cost claims.

## Current catalog and source boundaries

A concurrent voice update replaced twenty English presets while initial qualification waited. The long request's reference changed from 141 frames/94 text characters to a recorded 198 frames/123 characters. The current cohort freezes the same catalog on both sides at SHA-256 `1b9f1e59c1351fd2440e181f4a3601e387599a8f62e789b7e38aea8c4559adc2`. Results from the older catalog are retained separately and are not pooled.

The timed runtime is `2d4b0b233481292947b885f71a1eb60b278129d385b6be76d32e123dfa8f76ed`. A later concurrent edit added two explicit null guards for TypeScript narrowing, producing `fc8c6814e23b1b9418f5d8b51debcc8cdf5a0d7daa170c669bc57942fc81223b`. The exact two replacements were reviewed, and 15,432 frame estimates agree across all 640 references plus null/zero-weight/derived controls, eight texts and three speeds. Both packaged qualification variants were rebuilt with those guards. The complete production worker graph equals the qualified candidate; its optimizer bytes equal the timed candidate. The timed and production worker graphs are not claimed byte-identical.

## Allocation and command counts

| Main session, both adapters | Baseline | Candidate |
| --- | ---: | ---: |
| Conditional captured commands, length 810 | 647 | 643 |
| Unconditional captured commands, length 507 | 646 | 642 |
| Retained union after both plans | 73,746,376 B | 72,087,436 B |

A 24-step paragraph avoids **192 conversion dispatches**. For the tested sequence lengths, eliminating widen/narrow operations on 128 values per position avoids a calculated 97,099,776 bytes (92.60 MiB) of logical conversion reads/writes per request. This is not measured bus traffic or energy. Retained buffer capacity is not total VRAM usage. Both captured shapes retain 23 replay hits.

## Four counterbalanced paired workloads

Fresh muted Chromium 156.0.8078.4 browser trees use the Ultra 9 / RTX 5090 PC, a 6 GiB browser-job cap, one 24-step long paragraph and six 12-step repeats. All **28 corresponding recordings** match exactly. All **128 initialization/synthesis process observations** satisfy the unchanged strict membership and cap checks. One host measurement lease covers native controls, builds and the cost cohort, excluding concurrent measurements.

Positive percentages and saved peaks mean an improvement.

| Pair | Synthesis CPU reduction | Repeat CPU reduction | Median repeat latency reduction | Browser peak saved |
| --- | ---: | ---: | ---: | ---: |
| 0, baseline first | 3.85% | 2.34% | 0.03% | 47.31 MiB |
| 1, candidate first | 6.71% | 0.79% | 0.26% | 63.70 MiB |
| 2, baseline first | 0.91% | 5.26% | -0.17% | 215.25 MiB |
| 3, candidate first | 9.43% | 5.08% | 0.51% | 306.87 MiB |

Pooled synthesis CPU falls **5.29% overall / 3.36% on repeats**; paired medians are 5.28% / 3.71%. Paired median first and repeat synthesis latencies improve by only **0.12% / 0.15%**, effectively unchanged. Every pair has a lower browser-job peak, with a paired median saving of **139.48 MiB**. This is an observed commitment saving for this cohort, not an attribution of the entire difference to 1.58 MiB of retained GPU workspace or a physical-RAM saving.

Initialization is reported separately: pooled CPU is **3.36% higher**, and CPU including initialization plus all seven requests is **1.35% higher**. Median loading time is 0.36% faster and initialization plus first synthesis is 0.54% faster. No startup or end-to-end short-session CPU saving is established. CPU is Windows browser-job user plus kernel time, including host work in the renderer, worker and GPU processes; it excludes the controller and fixture server. Commitment is not RAM residency.

The earlier catalog cohort in `artifacts/view-casts-20261101/` records 1.44% lower pooled synthesis CPU / 2.37% lower repeat CPU, mixed browser peaks (median 136.56 MiB higher), and 1.39 MiB less retained main workspace. It supports the command rewrite and supplies the exhaustive precision controls, but does not establish a universal peak-memory improvement. Both cohorts, failed source-boundary checks and unstarted-waiter cancellation records are preserved.

## Production qualification

The full suite passes **1,696 tests across 144 files**, strict and boundary TypeScript checks, changed-file lint, production build, all three native-artifact checks and whitespace checks. Four packaged baseline/candidate trials preserve **17 exact PCM/speaker pairs**.

The final muted narration test completes **36 clips over 300+ seconds** under the unchanged **5 GiB browser commitment cap**, with strict process coverage on every observation, no unprepared handoffs and no errors. Independent source-WAV alignment against render-thread capture passes all 36 waveforms; the maximum and p95 added render gaps are both **13.34 ms**. This checks browser rendering with a non-rendering sink; OS/device routing is outside the measurement. The latest source catalog changes the audio workload, so clip count and WAV identity are not compared to earlier catalog soaks.

Final raw evidence, source/build pins, reviewed runtime equivalence, summaries and checksums are in `artifacts/view-casts-current-20261101/`. Only this PC is available. Physical 8 GiB RAM/VRAM, weaker dedicated GPUs, energy and physical audio output remain unqualified; earlier intermittent inference stalls remain unexplained. The broader optimization goal remains active.
