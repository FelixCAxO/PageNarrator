# Tighten the confidence cutoff using completed scores

This follows the [first confidence-pruning experiment](confidence-pruning-20261031.md). Its baseline already skips softmax sums using the minimum score of the first requested number of completed positions. All preceding model-loading, GPU, projection, indexing and readback optimizations are included. This iteration changes only the OmniVoice CPU sampler and its differential tests.

## Keep the bound, improve its cutoff

The existing upper bound is unchanged: replacing `log(sum(exp(value − maximum)))` with zero bounds the final confidence score from above. A position is rejected only when that bound is strictly below the cutoff. All vocabulary values are still scanned and validated, and every masked position consumes its original seeded random draw.

The first completed positions can give a weak cutoff. Later positions may have much higher scores, but the initial implementation never uses them to improve that threshold. The candidate periodically sorts the existing completed-candidate array using the original score/index comparator. Its requested-rank score becomes the new cutoff. This runs every 32 positions when enough scores exist and the count is a positive integer. Boundary counts retain the prior path.

At least the requested number of completed positions score at or above the refreshed cutoff. A later position strictly below it cannot enter the selection. The cutoff can only become stronger as completed scores accumulate. Previously rejected positions cannot become relevant: their upper bounds were already below an earlier, weaker cutoff. Strict rejection preserves score ties and the original index tie-break. The final sort and token update are unchanged.

The other production change replaces the typed-array iterator in exponential summation with an indexed loop. It visits every retained value in the same order and uses the same float64 operations. There is no new heap, dependency, retained buffer, approximate normalizer, precision change or configuration. The sort mutates the existing candidate array; JavaScript's temporary sorting storage is not assumed free.

## Compare simpler alternatives

Each isolated variant uses four deterministic FP16 shapes, all 24 sampling steps, warmups and five counterbalanced timing pairs. An untimed pass compares codes and random-call counts after every step; timed passes also check final codes and draws. Exponential-call instrumentation is separate from latency measurements. No variant runs concurrently with another inference measurement.

| Variant | Paired median sampling-time reduction across four shapes | Decision |
| --- | ---: | --- |
| Refresh at codebook boundaries | 28.1–38.9% | Superseded by the finer refresh |
| Refresh every 32 positions | 33.3–48.7% | Retain |
| Partial-sum check every 128 exponentials | 11.9–18.5% | Exclude the extra control flow |
| Partial-sum check every 256 exponentials | 11.1–19.8% | Exclude the extra control flow |
| Indexed summation alone | 11.6–18.0% | Retain |
| Every-32 refresh plus indexed summation | 41.4–56.7% | Validate in the production source |

The partial-sum variants also use indexed loops. Their small additional operation reduction, about 5–6%, does not establish an advantage over the simpler indexed-loop control across these separate comparisons. Percentages from different variants are not added together, and the fixed refresh interval is not claimed optimal for all hardware.

The final source rerun gives:

| Generated frames / prefix | Baseline median | Candidate median | Paired median time reduction | Exponentials, baseline → candidate |
| --- | ---: | ---: | ---: | ---: |
| 77 / 0 | 44.3 ms | 26.2 ms | 40.3% | 3,643,875 → 1,470,875 |
| 100 / 180 | 82.7 ms | 44.2 ms | 46.5% | 4,914,875 → 1,884,975 |
| 240 / 200 | 212.6 ms | 103.1 ms | 51.5% | 13,429,550 → 4,175,850 |
| 512 / 512 | 496.5 ms | 234.5 ms | 53.2% | 31,695,050 → 8,698,150 |

The candidate removes another 59.6–72.6% of the baseline's remaining exponentials on these synthetic tensors. This is a sampling-stage measurement, not complete synthesis or GPU speed. The prefix cases control the retained input interface; the production projected head uses prefix zero.

A separate V8 statistical profile of repeated 512-frame sampling, without the exponential spy, attributes 982/1,658 baseline sampler samples to the exponential-summation line, versus 185/839 candidate samples: about 59% → 22%. The remainder is mainly logit loading, guidance, finite checks and maxima. These are line samples inside the sampler; sort callbacks and native work have separate attribution. Warmup and correctness controls are included, and all profiler timings are excluded from performance claims.

## Correctness controls

The 1,502 engine, TTS and reader tests pass. The confidence suite now has 31 differential cases against the independent original complete-scoring oracle. This iteration adds an explicit weak-cutoff case and three boundary-count cases, and expands boundary, constant-random/tie and non-finite inputs beyond multiple refresh points. The weak-cutoff control proves that a later completed score tightens the threshold: exponential calls fall from the complete oracle's 128 rows to 32 while codes and all random draws remain identical.

All 72 actual diffusion steps across English, Swedish and Arabic on NVIDIA Blackwell and 24 English steps on Intel Xe-LPG preserve every selected code and random draw against complete CPU scoring on the same real logits. That instrumented probe is used only for correctness and operation counts. All 17 packaged speech pairs preserve exact float32 PCM, length, rate and speaker identity, including five languages, variation, Hindi whisper, recovery and a long passage.

Strict/boundary type checks, changed-file lint and the production build pass. Models, corrected graph, shaders, GPU engine, precision, inference steps, seeds and acceptance thresholds are unchanged. The corrected graph remains `d4de7933bfa728c1724c03778c65eacffce3f93dcd7b26b110b2c5314be38258`. Native GPU primitive and Kokoro controls are not rerun for this OmniVoice-only CPU change; their preceding verified implementations remain unchanged.

## Complete requests and native resource counters

Four counterbalanced packaged pairs repeat two short English requests. Another four pairs run two 19-second requests with native Windows job accounting under an enforced 6 GiB commitment ceiling. All eight long-request PCM comparisons are exact. Wall times exclude initialization, profiling and sampler instrumentation:

| Request | Baseline median | Candidate median | Paired median time reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| Short first / 24 steps | 2613.8 ms | 2590.9 ms | 0.8% | −0.5–1.6% |
| Short following / 12 steps | 1420.3 ms | 1383.1 ms | 2.3% | −1.5–7.6% |
| Long first / 24 steps | 6544.2 ms | 6257.5 ms | 4.5% | 3.0–5.0% |
| Long following / 12 steps | 3282.3 ms | 3207.4 ms | 2.3% | 0.7–6.3% |

Short-request wall times are mixed. Both long requests improve in every pair. Their sampler time falls 30.3% and 27.2%; the short-request sampler falls 23.8% and 35.3%. These real-logit results are smaller than the isolated synthetic-stage results.

Native browser CPU includes the complete browser tree, renderer/worker and GPU-process host work, transport, PCM hashing and diagnostics around both requests, including terminated children. It excludes initialization, the controller and fixture server. The measured CPU pairs are:

| Pair | Baseline CPU | Candidate CPU | Reduction |
| --- | ---: | ---: | ---: |
| 1 | 4.422 s | 4.344 s | 1.8% |
| 2 | 4.594 s | 3.953 s | 13.9% |
| 3 | 4.453 s | 4.391 s | 1.4% |
| 4 | 5.047 s | 4.422 s | 12.4% |

All four CPU pairs improve; the paired median reduction is 7.1%, with a wide 1.4–13.9% range. Every observed browser process is covered by the same job. These numbers apply to this immediate baseline and workload; they are not added to the preceding experiment's percentage. Absolute host timings differ between iterations, so cross-iteration wall-time comparisons are excluded.

Browser commitment peaks increase in three pairs by 16.5–240.0 MiB and decrease in one by 116.0 MiB, giving a paired median increase of 80.4 MiB. Startup peaks already differ before the first measured request; high-water marks do not isolate the sampler's allocation cost. No RAM or VRAM reduction is established, and the higher observed commitment peaks remain part of the result. Explicit sampler array sizes and model/GPU diagnostics remain unchanged. Commitment includes initialization through the final observation and is not resident physical RAM.

## Continuous playback

The final uninstrumented package passes the varied-paragraph playback workload with ordinary initial buffering, muted render capture, stop/cleanup checks and an enforced 6 GiB browser-job commitment ceiling:

| Observation | Result |
| --- | ---: |
| Playback duration | 300.5 s |
| Completed chunks / prepared handoffs | 38 / 38 |
| Complete source-aligned clips / boundaries | 38 / 37 |
| Unprepared waits | 0 |
| Added render gap, p95 / maximum | 13.3 / 13.3 ms |
| Minimum source/capture correlation | 0.99999986 |
| Precise browser commitment peak | 4.719 GiB |
| Native accounting observations | 65 |

This waveform analysis measures render-thread continuity, excluding OS/device output. The commitment high-water mark covers initialization through the last pre-export observation and excludes the controller and fixture server. It is not evidence of a memory improvement over differently timed earlier reads.

## Reproduction and limits

Evidence is retained in the ignored `artifacts/confidence-refinement-20261031/` directory: the immediate baseline source/package, the original complete-scoring source, six prototype sources, paired measurements, per-step comparisons, the separate CPU profile, command logs, muted audio and reproduction/verifier scripts. Source pins bind the current worker and diagnostic modules to the measurements. Instrumented correctness probes, statistical profiles and uninstrumented performance runs remain separate.

The host has a Core Ultra 9 285K, about 63.3 GiB physical RAM, and an RTX 5090 with nominal 32 GiB dedicated memory. Intel Xe-LPG provides additional correctness checks. The Intel instrumented English request takes about 26 seconds for 3.08 seconds of audio and does not establish real-time performance. Physical 8 GiB RAM/VRAM PCs, weaker dedicated GPUs, audio-device routing, power and the broader PDF/OCR matrix remain unqualified. A browser commitment ceiling is not physical 8 GiB hardware pressure or resident RAM.
