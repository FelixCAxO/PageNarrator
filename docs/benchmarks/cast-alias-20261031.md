# Half casts through value-preserving aliases

This iteration follows the [attention scale/mask fusion](attention-fusion-20261031.md). It extends existing redundant-cast elimination to recognize a known half value through repeated float32 casts and ordinary Identity aliases. The accepted model calculation is preserved while unnecessary GPU conversions and a large float32 buffer disappear. Whole-job CPU, commitment and latency measurements are reported separately below.

## Why the wider array adds no precision

The current prepared graph remains SHA-256 `8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb`. Its attention probabilities have already been rounded to half precision. Each of 28 layers then contains:

`half → Cast(float32) → Cast(float32) → Cast(half)`

The middle cast performs no GPU work, but hides the original half source from the old direct-pair optimizer. Following the aliases allows the final half cast to become Identity of the original half tensor. A float32 array containing widened half values adds no precision; the later narrowing recovers the same finite values, signed zeros and infinities.

The new pass tracks origins in one forward traversal. It follows only ordinary, single-input/output casts to float32 and attribute-free Identity nodes. Arithmetic, indexing, reshaping, integer conversion and unsupported attributes/domains stop propagation. A lossy initial float32-to-half conversion remains. Requested float32 outputs and side computations retain their original producers. Original names, output shapes/types and tensor lifetime checks remain in place.

For the actual audio output plan, 3,274 nodes become 3,218. Each nonempty main pass removes 56 GPU conversion dispatches; a full 24-step conditional/unconditional request removes 2,688. The graph pass and its focused tests are the only application-code changes. Shader code, matrix multiplication, full attention, sampling, weights, seeds, diffusion steps, the 128 MiB cache limit and bounded submissions remain unchanged.

The avoided half-to-float32 and reverse conversion nominally read/write 12 bytes per probability element. This is logical storage I/O, not measured physical GPU bandwidth. There is no meaningful timestamp ratio for a replacement that performs zero GPU dispatches; complete-request timings provide the performance comparison.

## GPU allocation

Both adapters produce the same engine allocation change for the 19-second native request. The intermediate-capacity reduction exactly matches a 16 × 710 × 710 float32 probability buffer: 32,262,400 bytes. The retained union also removes 896 bytes of dispatch parameters across two cached plans:

| Main-model capacity | Baseline bytes | Candidate bytes | Reduction |
| --- | ---: | ---: | ---: |
| First-pass allocated intermediates | 97,108,308 | 64,845,908 | 33.22% |
| First captured plan, including inputs/parameters | 100,712,328 | 68,449,480 | 32.03% |
| Retained union of the two main plans | 102,711,672 | 70,448,376 | 31.41% |

Decoder allocated capacities remain 402,753,376 bytes on the first long request and 175,106,048 bytes on the matching repeat, with zero retained decoder GPU plans. The saving concerns engine-owned buffer capacity; model weights and other processes remain outside this table, and complete resident VRAM is unmeasured.

## Complete-request A/B

Four counterbalanced packaged pairs synthesize the same 19-second paragraph twice. PCM, length and sample rate match exactly in every pair. The enforced 6 GiB browser-job commitment ceiling and original strict process-membership gate apply to all before/after observations. Job CPU includes renderer/worker/GPU-process host work, request transport and diagnostics; initialization, controller and fixture server are excluded. Commitment peaks include initialization through the last observation.

| Request | Baseline median | Candidate median | Paired median time reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| First / 24 steps | 3828.79 ms | 3756.86 ms | 1.66% | -2.09–4.70% |
| Following / 12 steps | 1878.92 ms | 1866.22 ms | 0.25% | -4.02–3.52% |

The paired median job user+kernel CPU reduction is **10.65%**, with a range of -13.19–17.44%. 3 of four pairs improve. Negative reductions mean higher CPU. The paired median peak-commitment saving is **32.96 MiB**, ranging from 4.45–56.89 MiB; 4 of four pairs improve. These host measurements have substantial variability and do not establish an exclusive hardware, physical RAM residency or energy result.

Four additional short-request packaged pairs give:

| Request | Baseline median | Candidate median | Paired median time reduction |
| --- | ---: | ---: | ---: |
| First / 24 steps | 1785.89 ms | 1760.33 ms | 1.54% |
| Following / 12 steps | 976.63 ms | 966.21 ms | 0.19% |

Initialization has no improvement claim. Intel's native full request completes in 90.29 seconds for 19 seconds of speech. That instrumented control verifies correctness and cleanup; it is not a counterbalanced throughput result and remains slower than real time.

## Correctness and sustained playback

All 1,602 engine, TTS and reader tests across 138 files, strict/boundary types, changed-file lint, build, native source/binary checks and browser artifact checks pass. Focused tests cover alias chains, separately requested outputs, arithmetic/shape/indexing barriers, lossy narrowing, integer conversions and invalid domains/attributes.

NVIDIA and Intel each pass 66 native precision controls plus nine new alias/lifecycle controls. These exercise every finite half input plus signed zeros and infinities, mutable named-output arrays, changed inputs on cached replay, zero-command half-only plans, uncached lifetime cleanup, preserved lossy float32 narrowing and float32 arithmetic. All tensors/buffers release normally. NaN payload preservation is outside this finite-value control.

All 192 short-request and 96 long-request half-logit tensors match baseline byte-for-byte. Full codes, float32 PCM and WAV hashes match within each adapter. Long controls use the actual shared engine with two main plans and one decoder plan. The final bundle also preserves 17 packaged speech pairs, eight long cost pairs and eight Kokoro CPU/GPU controls, including PCM, feeds and source chunks.

The final varied-paragraph playback test keeps startup inventory separately, then requires strict coverage from the first post-startup snapshot through the final pre-export observation. Kernel peaks remain cumulative from launch:

| Observation | Result |
| --- | ---: |
| Duration | 300.73 seconds |
| Complete source-aligned clips / prepared event handoffs | 38 / 38 |
| Unprepared waits | 0 |
| Added render gap, p95 / maximum | 13.33 / 13.33 ms |
| Minimum source/capture correlation | 0.99999986 |
| Precise browser commitment peak | 4.689 GiB |
| Strict inventory observations | 65 |

This muted render-thread capture does not measure audio-device latency. Raw data, baseline/candidate snapshots, planning evidence, test scripts and final source/bundle verification are in `artifacts/cast-alias-20261031/`. The baseline bundle is verified against the preceding accepted candidate. Measurements are serialized on the development Ultra 9 / RTX 5090, with Intel Xe-LPG controls and variable unrelated host activity.

Physical 8 GiB RAM/8 GiB VRAM machines, weaker dedicated GPUs, device audio, energy use and broad PDF/OCR workloads remain unqualified. The continuous-playback hardware goal remains active.
