# Reject further CPU confidence-selection changes — 1 November 2026

Four sampler designs were explored. Neither packaged finalist reduces measured browser CPU: the signed-zero-corrected version uses **11.43% more pooled CPU**, and the simpler version uses **8.10% more**. Both are rejected. Production TTS source and its reachable worker dependency graph remain unchanged from the [qualified uniform-parameter implementation](uniform-parameters-recovery-20261101.md).

## Calculation and alternatives

The sampler already finds the best of 1,024 non-MASK logits while choosing its predicted token. Its separate maximum over all 1,025 logits can therefore reuse that result and compare it with the MASK logit once. This removes 1,024 Math.max calls per masked row, while retaining every logit load, guidance calculation, finite-value check, random draw and normalization term. Source call counts do not establish hardware instruction, CPU, GPU or energy savings.

One detail needs care: Math.max prefers positive zero on a zero tie, while the existing strict comparison for the winning token keeps the first tie. The corrected prototype scans zero ties to reproduce the intermediate maximum exactly. The simpler prototype omits that scan. [ECMAScript specifies the positive-zero maximum tie rule](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-math.max) and [equal exponential results for both zero signs](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-math.exp).

Our reasoning for the simpler version: the intermediate maximum can differ only in zero sign. This leaves every exponential result and the ordered normalization sum identical. A differing maximum sign requires at least two zero-valued maxima, so the sum is at least two; subtracting its positive logarithm removes the zero-sign difference from the final confidence score. The pruning comparison also orders either zero sign equally. The numerical witness checks 6,144 complete scores, including four intermediate sign differences, with bit-identical sums and scores. This is supported by differential tests; it is not a claim that intermediate exponential arguments always have identical bits.

| Design | Evidence and decision |
| --- | --- |
| Bounded heap for the confidence cutoff | Adds a score heap and removes periodic sorts. Exploratory sampling reductions range from 0.48–5.26%, with diminishing gains on larger shapes. Additional complexity and allocation are not justified; reject. |
| Explicit finite maximum comparison | Exploratory results range from 16.76% faster to 34.90% slower. Reject the inconsistent result. |
| Reuse winning maximum, correct zero ties | Controlled synthetic stage is 5.28–6.05% faster, but packaged speech uses more CPU. Reject. |
| Reuse winning maximum, omit zero scan | Small real sampling benefit, mixed latency, more browser CPU. Reject. |

## Packaged speech A/B

Each cohort uses four fresh-browser pairs, alternating which variant runs first. The corrected variant runs a 24-step paragraph followed by one 12-step request per browser. The simpler variant runs the same first request followed by six 12-step requests. All **36 corresponding PCM comparisons are exact** across the two cohorts. Text, seeds, models and diffusion schedules match within each comparison. Timing and CPU measurements contain no sampler spies.

The CPU metric is Windows browser-Job user plus kernel time around synthesis, including the worker, renderer and GPU-process host work. It excludes model initialization, the controller and fixture server. Latency medians pair corresponding requests; the warm figure is the median of the four within-pair medians. CPU figures compare pooled time totals. Results from the two variants are not added together.

| Candidate | Exact pairs | First latency | Warm latency | All-request CPU | Warm CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| Correct zero ties | 8 | 2.90% higher | 0.11% higher | 11.43% higher | 3.57% higher |
| Simple maximum merge | 28 | 5.68% higher | 3.47% lower | 8.10% higher | 5.81% higher |

The simpler variant's first-request sampling time falls 4.40%, but warm sampling improves only 0.91%. Its total CPU increases in three of four pairs. These observations do not isolate why CPU rises; they are sufficient to withhold a compute-saving claim. Peak commitment is mixed, and the simple variant peaks higher in three pairs. Main retained GPU workspace stays 63,096,452 bytes. No RAM or VRAM saving is established.

Every accepted process observation meets the existing strict Job membership predicate. The corrected cohort has 32 before/after observations; the simpler cohort has 112. Both enforce the same 6 GiB browser commitment ceiling. No membership exception or cost threshold is relaxed.

## Correctness and benchmark controls

The artifact-only corrected sampler passes 39 differential tests; the simpler sampler passes 80. These include the existing complete-scoring oracle, all four half/float input combinations, signed zero, zero/one random boundaries, MASK maxima, ties and non-finite validation. Synthetic runs compare decisions and random draws after each of 24 steps. The simple test also confirms the maximum-call reduction and nonpositive, finite normalization arguments.

An early maximum-reuse timing probe replaced Math.max between shapes to count operations. This polluted subsequent V8 call feedback and made the baseline artificially slower. The original script, logs and results are retained and excluded from performance claims. The corrected probe completes **all timings before any operation spy**. Its corrected-zero candidate passes all identical-code timing controls. The simpler candidate fails the predefined ±5% control on the 100- and 240-frame shapes; those timing rows remain excluded. Heap and explicit-comparison timings are exploratory and are not used as adoption evidence.

Source hashes reproduce the accepted engine/TTS pins. The packaged simple sampler is present in the worker's reachable dependency graph; baseline and candidate workers have distinct pinned hashes. The current production TTS worker graph matches the preserved baseline. Separate PDF asset changes in the shared production directory are recorded and preserved; whole-package identity is not claimed. No production source or production test is changed by this iteration, and the previous 1,656-test qualification is inherited rather than rerun. New continuity, integrated-GPU and native-precision runs are unnecessary for these rejected candidates and were not performed.

Evidence lives in ignored `artifacts/confidence-heap-20261101/`: prototype sources and packages, all raw results and rejected probes, unit/build logs, proofs, `analyze.mjs`, `summary.json`, `verification.json` and `goal-evidence.json`. Measurements and builds use the host-wide measurement lock and run serially. Physical playback remains muted.

Only the current Ultra 9 / RTX 5090 PC is available. A browser commitment cap does not emulate physical 8 GiB RAM, total system pressure, an 8 GiB VRAM limit or a weaker dedicated GPU. Energy and real device output remain unmeasured. The earlier intermittent inference stall cause remains unresolved. The broader continuous-reading goal stays active; the next useful target is a larger share of inference or CPU preparation work rather than another maximum-loop variation.
