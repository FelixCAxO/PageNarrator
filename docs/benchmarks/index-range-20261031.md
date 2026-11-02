# Reuse lookup-index proofs as token values decrease

The [decoder-window experiment](decoder-window-20261031.md) traced repeated main-model GPU captures to progressively smaller minimum token IDs. This iteration widens the validated lookup-input proof down to zero when capturing a plan. The actual feed data and model calculations stay identical. The change is accepted for lower measured browser CPU: all four counterbalanced pairs improve, with a **12.24% paired median reduction**. GPU allocation stays unchanged; latency and whole-job commitment remain mixed.

## Why the cache was rebuilt

The main input contains encoded tokens and generated audio codes. Its maximum stays fixed at 1,024 in the traced request, while the observed minimum changes from 1,024 to 176, 59, 54 and finally 2. Captured plans previously proved only the observed interval. Each smaller value correctly invalidated that narrow proof, forcing CPU graph traversal, command encoding and GPU plan replacement even though the model shape, dispatch arithmetic and valid embedding table had not changed.

At capture, a validated nonnegative integer input that eventually supplies ordinary ONNX Gather indices can instead use the conservative interval [0, observed maximum]. Subsequent smaller nonnegative values fit that proof. Actual feed values are untouched. Higher maxima and negative values still fail the existing cached-range guard and rebuild; the upper bound is deliberately not generalized. Shape-control inputs and floating-point paths are excluded. Eligibility follows typed integer dependencies backwards from lookup indices, stopping at Shape and foreign domains; it does not hard-code OmniVoice input names.

For a 24-step conditional/unconditional native request:

| Adapter / language | Main passes | Baseline captures | Candidate captures |
| --- | ---: | ---: | ---: |
| nvidia / english | 48 | 6 | 2 |
| nvidia / swedish | 48 | 5 | 2 |
| nvidia / arabic | 48 | 7 | 2 |
| intel / english | 48 | 6 | 2 |

The remaining two captures are the initial conditional and unconditional plans. All following passes reuse them. The node count remains 3,218. This removes redundant planning and upload work; it does not remove model steps or change a GPU shader.

## Keep the integer and lifecycle guarantees

Every actual input still passes the original shape, declared-type, element-count and exact int32-value validation. The cached-feed bounds check is byte-identical to baseline. An eligible feed sharing its array with an ineligible input keeps an exact proof, so one shared upload cannot broaden a shape or arithmetic input accidentally.

Conservative intervals can reject valid correlated arithmetic. For example, exact positive and negative operands can cancel safely even when their independently widened intervals suggest overflow. Arithmetic interval failures now have a RangeError subclass; when widening caused such a failure, the session drains and releases the failed inference, disables widening for that session, and retries once with the original exact ranges. Invalid raw inputs, out-of-range indices, device loss and unrelated errors never trigger this retry. Real arithmetic overflow remains rejected. One stable active-inference promise covers both attempts so concurrent calls remain rejected and disposal waits for the complete operation.

The source proof reconstructs all three baseline modules by removing only the documented error-classification, eligibility, upload, retry and cleanup additions. All other engine-source pins match the preceding accepted [half-cast alias version](cast-alias-20261031.md), including shaders, model correction, sampling and workspace allocation. The prepared main graph remains SHA-256 `8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb`.

## Complete-request A/B

Four counterbalanced packaged pairs each synthesize the same 19-second paragraph twice, with 24 steps followed by 12. All eight request pairs match PCM bytes, lengths and sample rates exactly. Synthesis is serialized; no build or test load runs concurrently. The enforced browser Job commitment ceiling is 6 GiB, with the unchanged strict process-membership gate at every before/after observation. Job user+kernel CPU includes browser/renderer/worker/GPU-process host work and diagnostics; model initialization, controller and fixture server are outside the request CPU intervals. Commitment peaks remain cumulative from launch.

| Request | Baseline median | Candidate median | Paired median time reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| First / 24 steps | 4179.02 ms | 4119.66 ms | 0.12% | -1.36–2.58% |
| Following / 12 steps | 2050.67 ms | 2093.69 ms | -2.10% | -6.71–0.80% |

Browser CPU falls in 4 of four pairs, with a paired median reduction of **12.24%** and a 8.50–16.44% pair range. The following-request paired median is slower; the change is accepted for CPU cost, with no general latency improvement claim.

The paired median peak-commitment saving is 26.30 MiB. Only 3 of four pairs improve, with a -205.16–69.07 MiB range. One substantial regression prevents a reliable whole-job memory-saving claim. Job commitment is not resident physical RAM.

Engine-owned GPU capacities stay unchanged: 64,845,908 bytes of first-pass main intermediates and 70,448,376 bytes in the retained two-plan main union. Decoder intermediates remain 402,753,376 bytes cold and 175,106,048 bytes on the matching repeat, with no decoder GPU plan retained. This is allocation capacity, not total adapter VRAM residency. No GPU-energy reduction was measured.

Four additional short-request packaged pairs give:

| Request | Baseline median | Candidate median | Paired median time reduction |
| --- | ---: | ---: | ---: |
| First / 24 steps | 1952.25 ms | 1870.81 ms | 3.49% |
| Following / 12 steps | 1046.78 ms | 929.76 ms | 11.17% |

Intel's instrumented native long candidate completes in 89.30 seconds for 19 seconds of speech. This verifies correctness on another adapter; it is not a counterbalanced speed result and remains slower than real time.

## Validation and playback

All 1,611 engine, TTS and reader tests across 139 files pass, along with strict/boundary types, changed-file lint, production build, native source/binary checks and browser artifact checks. Focused tests cover eligibility barriers, arithmetic-error classification, one-shot retry, error propagation, concurrent inference and disposal. The WebGPU test double now remains a class so the production backend identity check works in existing device-contract tests.

Each adapter passes 66 native precision controls and 13 new range/cache/lifecycle controls: lower/higher/negative/zero indices, cache reuse, positive and negative out-of-range errors with recovery, exact retry after conservative arithmetic rejection, real overflow rejection, shared-array proof isolation, independent inputs, invalid int64 feeds and full resource cleanup. There are no GPU validation errors.

All 192 short-request and 96 long-request half-logit tensors match baseline byte-for-byte. Complete codes, float32 PCM and WAV hashes match within each adapter. Final packaged validation preserves 17 speech pairs, eight long cost pairs and eight Kokoro CPU/GPU controls, including feeds and source chunks. The measured baseline bundle is verified against the preceding accepted candidate, and the candidate bundle and source pins are checked after measurement.

The five-minute varied-paragraph test uses muted render-thread audio capture. Startup inventory is saved separately; all retained observations from the first post-startup sample through the final pre-export observation require strict process coverage. Kernel commitment peaks still cover startup:

| Observation | Result |
| --- | ---: |
| Duration | 300.66 seconds |
| Complete source-aligned clips / prepared handoffs | 38 / 38 |
| Unprepared waits | 0 |
| Added render gap, p95 / maximum | 13.33 / 18.67 ms |
| Minimum source/capture correlation | 0.99999986 |
| Browser commitment peak | 4.635 GiB |
| Strict inventory observations | 65 |

Raw data, exact baseline/candidate snapshots, controls and source/bundle verification are in `artifacts/index-range-20261031/`. These results come from the development Ultra 9 / RTX 5090, with Intel Xe-LPG correctness controls and variable unrelated host activity. The timing is not an exclusive hardware or energy measurement.

Physical 8 GiB RAM/8 GiB VRAM systems, weaker dedicated GPUs, audio-device continuity and broad PDF/OCR workloads remain unqualified. The hardware goal remains active.
