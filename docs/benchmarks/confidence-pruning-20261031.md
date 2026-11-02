# Skip confidence sums that cannot change token selection

This follows the [transformer and validated-readback A/B](transformer-compute-20261031.md). The baseline already contains the earlier loading, FP16, graph, indexing, sampling and readback changes. This iteration changes only OmniVoice's CPU confidence sampler and adds differential tests. Models, graph pins, precision, inference steps, seeds, GPU kernels and acceptance thresholds remain unchanged.

## Bound the score before calculating softmax

For each masked audio position, the sampler scans all 1,025 vocabulary values, validates them, calculates guided logits and finds the maximum and best non-mask token. It then sums 1,025 exponentials to calculate a confidence score. Only the highest-scoring requested positions become unmasked.

Let `maximum` include the mask token, `best` exclude it, and `noise` be the existing seeded random term. The original score is:

```text
sum   = Σ exp(value − maximum)
score = (best − maximum − log(sum) − book × 5) / 5 − noise
```

At least one exponential equals one, so `sum ≥ 1` and `log(sum) ≥ 0`. Substituting zero for the log-normalizer gives an upper bound on the score. After fully scoring the first requested number of positions, their minimum score provides a cutoff: at least that many positions already score at least as highly. A later position whose upper bound is strictly below the cutoff cannot be selected. Its exponential sum can be skipped.

The implementation keeps the original arithmetic order for that bound and for every completed score. It uses one scalar cutoff and the existing arrays; it adds no heap, model state or configuration. Strict comparison preserves score ties and the existing index tie-break. It keeps the cutoff from the first completed positions rather than maintaining a more expensive moving selection structure.

Every used logit is still scanned and checked for non-finite values before pruning. Each masked position still consumes exactly one random draw in the original order, using the private seeded generator that returns values strictly between zero and one. The random term is calculated before deciding whether to skip the sum. The model's vocabulary argmax, guidance, codebook penalty, steps and selected tokens are unchanged.

## Isolated calculation A/B

Chromium 156.0.8078.4 runs the old and current source modules on the same deterministic half-precision tensors, through all 24 sampling steps. Each shape has warmups and five counterbalanced pairs. The benchmark checks final codes and random-call counts. Separate untimed instrumentation counts exponentials; those instrumentation runs are excluded from latency measurements. The prefix cases also control the retained full-logit input interface; the production projected head uses prefix zero.

| Generated frames / prefix | Paired median CPU-stage time reduction | Exponentials, baseline → candidate | Fewer exponentials |
| --- | ---: | ---: | ---: |
| 77 / 0 | 58.6% | 12,695,650 → 3,643,875 | 71.3% |
| 100 / 180 | 60.5% | 16,496,350 → 4,914,875 | 70.2% |
| 240 / 200 | 56.3% | 39,861,225 → 13,429,550 | 66.3% |
| 512 / 512 | 55.1% | 85,133,425 → 31,695,050 | 62.8% |

These numbers measure the CPU sampling stage, including its unchanged logit views, rather than complete synthesis or GPU execution. Allocation sizes for scores, predictions and guided logits are unchanged. Operation counts alone establish no RAM, VRAM or power saving.

## Correctness on real logits and packaged speech

The 1,498 engine, TTS and reader tests pass, including 27 new differential cases against an independent complete-scoring oracle. They compare each intermediate step, codes, seeded random state and call counts across mixed float32/FP16 inputs, finite half bit patterns, ties, extreme values, boundary counts and 24/64-step schedules. A focused case checks that a losing position with a used NaN or infinity still raises the original quality error before code mutation.

An instrumented source-module probe compares every actual diffusion step against the baseline's complete scoring function on the same real GPU logits. It records and replays the same random draws without advancing the generator twice. All 72 steps across English, Swedish and Arabic on NVIDIA Blackwell, plus 24 English steps on Intel Xe-LPG, select identical codes and consume identical draws. Exponential calls fall 71.9% and 72.6%, respectively. This diagnostic temporarily replaces the served sampler module with a source-pinned wrapper; its timings and memory are excluded from performance claims.

All 17 uninstrumented packaged speech pairs preserve exact float32 PCM, length, rate and speaker identity, covering five languages, variation, Hindi whisper, recovery and long speech. Eight further paired long requests preserve exact PCM under an enforced 6 GiB browser-job commitment ceiling. The corrected graph remains `d4de7933bfa728c1724c03778c65eacffce3f93dcd7b26b110b2c5314be38258`.

Strict and boundary type checks, changed-file lint and the production build pass. The GPU primitive suite and Kokoro controls are unchanged from the preceding verified iteration and are not rerun for this OmniVoice-only CPU change. Actual-model checks cover both GPU architectures used here.

## Complete requests and native CPU accounting

Four counterbalanced packaged pairs repeat two English requests. A separate four-pair run measures two 19-second long requests under native Windows job accounting. Wall times exclude initialization and contain no sampler instrumentation:

| Request | Baseline median | Candidate median | Paired median time reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| Short first / 24 steps | 1868.4 ms | 1799.3 ms | 3.0% | −1.2–6.8% |
| Short following / 12 steps | 1117.3 ms | 959.5 ms | 13.2% | 4.9–21.9% |
| Long first / 24 steps | 4819.4 ms | 4339.7 ms | 9.9% | 6.8–13.1% |
| Long following / 12 steps | 2403.2 ms | 2170.1 ms | 9.7% | 9.4–10.6% |

The long-request sampler's own measured time falls 37.2% and 34.8%. Whole-browser CPU for both requests has a paired median reduction of 14.0%, ranging from 7.6% to 21.6%; all four pairs improve. Median CPU totals are 4.898 → 4.188 seconds. These counters include browser, renderer/worker and GPU-process host work, transport, PCM hashing and diagnostics, including terminated child processes. They exclude initialization, the controller and fixture server. Every observed browser process is covered by the same job.

Browser commitment peaks are mixed: two rise by 44–52 MiB and two fall by 44–86 MiB. The paired median change is effectively zero. This iteration establishes a scoped CPU reduction, with no established RAM or VRAM reduction. Commitment high-water marks include initialization and are not resident physical RAM measurements.

## Continuous playback

The final uninstrumented package passes the varied-paragraph playback test under an enforced 6 GiB browser-job commitment ceiling. It uses the ordinary initial buffering policy, the muted render capture, and the existing stop/cleanup checks:

| Observation | Result |
| --- | ---: |
| Playback duration | 301.0 s |
| Completed chunks / prepared handoffs | 38 / 38 |
| Complete source-aligned clips / boundaries | 38 / 37 |
| Unprepared waits | 0 |
| Added render gap, p95 / maximum | 13.3 / 13.3 ms |
| Minimum source/capture correlation | 0.99999986 |
| Precise browser commitment peak | 4.770 GiB |
| Native accounting observations | 65 |

The waveform check measures render-thread continuity, not OS/audio-device routing. The commitment peak covers initialization through the last pre-export observation, excludes the controller and fixture server, and does not establish a memory improvement over differently timed prior reads.

## Reproduction and limits

The ignored `artifacts/confidence-pruning-20261031/` directory retains baseline/current source snapshots, the previous packaged extension, raw measurements, muted audio, per-step comparisons, command logs, `summarize.mjs` and `verify.mjs`. Source hashes bind the measured package and probes to the implementation. Timed inference workloads use the existing cross-process measurement lock and run serially.

The development machine has a Core Ultra 9 285K, about 63.3 GiB physical RAM and an RTX 5090 with nominal 32 GiB dedicated memory; Intel Xe-LPG supplies additional correctness controls. The Intel instrumented English request takes about 26 seconds for 3.08 seconds of audio and does not demonstrate real-time playback. A browser commitment ceiling does not simulate physical memory pressure on an 8 GiB machine. Physical 8 GiB RAM/VRAM systems, weaker dedicated GPUs, device-output continuity, energy and broad PDF/OCR workloads remain unqualified.
