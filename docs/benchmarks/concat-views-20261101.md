# Reuse single-nonempty ONNX concatenations

This follows the rejected [pipeline-binding experiment](pipeline-binding-20261101.md). It removes complete GPU copies rather than caching API state. The accepted change returns an owned tensor view for a pure ONNX Concat with one nonempty device input. Every other input still participates in ownership, type, dimension and axis validation. Model calculations and output remain unchanged.

## Inspect the actual copies

The unmodified conditional and unconditional main passes each contain 112 concatenations with one nonempty input. Each of 28 layers assembles both key and value caches by joining an empty prefix, the complete replacement tensor and an empty suffix. A following one-input concatenation copies each result again. Full bidirectional attention still requires those key/value values, but it does not require new storage for these concatenations.

The ONNX handler creates a registered view after validating the inputs. Existing ownership tracking keeps the storage alive until all views release it. Multiple nonempty inputs, all-empty cases, and mixed CPU/device inputs retain their original paths. The low-level concat primitive remains an independent writable copy, and ScatterND still copies before modifying its input. No model-specific names, new backend, shader, setting or precision change is introduced.

| English pass | Baseline dispatches | Candidate dispatches | Removed |
| --- | ---: | ---: | ---: |
| Conditional | 1207 | 1095 | 112 |
| Unconditional | 1206 | 1094 | 112 |
| Decoder | 133 | 133 | 0 |

The 24-step request removes 5,376 main copy dispatches. For the observed 259/77-position English shapes, about 1.723 GiB of logical destination writes disappear. At 710/475 positions in the long request, about 6.075 GiB disappear. Corresponding source reads are also avoided. These are logical copy payloads, not measured bus traffic, total VRAM residency or energy use.

## GPU allocation

The prepared main graph remains SHA-256 `8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb`. Its executed node count remains 3,218; the runtime represents the eligible nodes as views. Both adapters show:

| Main capacity for the long request | Baseline bytes | Candidate bytes |
| --- | ---: | ---: |
| First-pass allocated intermediates | 64,845,908 | 63,391,832 |
| First captured plan | 68,449,480 | 66,992,716 |
| Retained union of both main plans | 70,448,376 | 68,988,924 |

Retained main allocation falls by **1,459,452 bytes / 1.39 MiB / 2.07%**. This includes 5,376 fewer dispatch-parameter bytes across the two plans, plus the shared intermediate-capacity change. The two-plan, 128 MiB cache policy stays unchanged. Decoder intermediates remain 402,753,376 bytes cold and 175,106,048 bytes on the matching repeat, with no decoder GPU plans retained. Weights and total adapter residency are outside these capacity figures.

## Full-request A/B

Four counterbalanced packaged pairs synthesize the same 19-second paragraph twice. The production extension tree is byte-identical to the measured prototype tree. Every one of the eight request pairs preserves exact PCM, length and sample rate. Builds and other diagnostics are serialized outside these measurements. The enforced 6 GiB browser Job commitment ceiling and original strict process-membership gate apply to all before/after observations.

Positive reductions mean lower candidate cost:

| Request | Baseline median | Candidate median | Paired median time reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| First / 24 steps | 4153.21 ms | 4116.42 ms | 0.90% | -1.30 to 5.28% |
| Following / 12 steps | 2077.95 ms | 2036.93 ms | 3.00% | -1.69 to 4.06% |

The paired median browser-job CPU reduction is **6.17%**, with 3/4 pairs improving and a -13.79 to 9.68% range. One substantial regression prevents a general CPU-saving guarantee. Peak commitment has a paired median saving of 8.95 MiB, with 3/4 pairs improving and a -10.12 to 50.02 MiB range. This does not establish a lower physical-RAM requirement.

Job user+kernel CPU includes browser/renderer/worker/GPU-process host work and diagnostics, excluding initialization, controller and fixture server. Commitment peaks include startup through the last observation. Unrelated host activity remains variable; commitment is not resident RAM. The reliable allocation/dispatch changes and modest latency results support keeping this candidate, without an exclusive-hardware, power or universal-performance claim.

Four additional short-request pairs give:

| Request | Baseline median | Candidate median | Paired median time reduction |
| --- | ---: | ---: | ---: |
| First / 24 steps | 1869.67 ms | 1840.12 ms | 2.19% |
| Following / 12 steps | 923.04 ms | 935.30 ms | -1.95% |

The following short request is slower at the paired median. These measurements do not support a general latency guarantee.

## Correctness and continuous playback

All 1,623 engine/TTS/reader tests across 140 files, strict/boundary types, changed-source lint, production build and native/browser artifact checks pass. Twelve new permanent tests cover eligible types/shapes, invalid axes/dimensions/ownership, fallback behavior, named outputs, writable ScatterND isolation, cached input updates and CPU-engine disposal.

NVIDIA and Intel each pass 66 native precision controls and ten additional concat/lifetime controls. These include every finite half value, signed zeros and infinities, retained source aliases, independent low-level writable copies, integer proofs, all-empty behavior, invalid empty inputs, cache replay and mutable host-output isolation. No GPU validation errors or test buffers remain. NaN payload preservation is outside the finite-value control.

All 192 short-request and 96 long-request half-logit tensors match the accepted baseline byte-for-byte. Full codes, float32 PCM and WAVs match within each adapter. Seventeen packaged speech pairs, eight long cost pairs and eight Kokoro CPU/GPU controls also preserve exact output. The first long-control wrapper stopped before inference because of a wrong import; its failed report is retained, and only corrected completed runs contribute evidence.

The varied-paragraph run uses muted render-thread capture under the same 6 GiB commitment ceiling. Startup inventory is separate, and every retained observation from the first post-startup sample through final pre-export requires strict process coverage. Kernel peaks remain cumulative from launch:

| Observation | Result |
| --- | ---: |
| Duration | 300.69 seconds |
| Complete clips / prepared handoffs | 38 / 38 |
| Unprepared waits | 0 |
| Added render gap, p95 / maximum | 13.33 / 18.67 ms |
| Minimum source/capture correlation | 0.99999986 |
| Browser commitment peak | 4.586 GiB |
| Strict inventory observations | 65 |

Raw counters, command traces, exact source snapshots, builds, reports and final source/bundle pins are in `artifacts/concat-views-20261101/`. Intel's instrumented long control still takes 89.04 seconds for 19 seconds of speech; it verifies correctness rather than representative throughput acceptance.

Physical 8 GiB RAM/8 GiB VRAM systems, weaker dedicated GPUs, audio-device continuity, energy and broad PDF/OCR workloads remain unqualified. The goal remains active.
