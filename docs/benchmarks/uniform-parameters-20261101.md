# Uniform dispatch parameters and subgroup A/B — 1 November 2026

The two-module prototype gives all eight paired long-speech requests lower latency: paired median reductions are **5.98%** for first 24-step requests and **6.45%** for following 12-step requests. It remains **deferred** after two failed five-minute continuity runs. The accepted application and build are restored. Every checked speech output stays exact; CPU and memory savings remain unproved. All subgroup prototypes are rejected. This round keeps the safer benchmark calibration.

## Calculation and implementation

The packed half matrix kernel previously read its 32 dispatch integers through a storage binding. They are constant throughout the dispatch. It now reads the same 128 bytes through a uniform binding containing eight vectors of four integers. The host payload is unchanged: integer i has byte offset 16×floor(i/4)+4×(i mod 4)=4i. Using vec4 slots satisfies the 16-byte array stride required by the ordinary uniform layout, including implementations without uniform_buffer_standard_layout. See the [WGSL layout rules](https://www.w3.org/TR/WGSL/#address-space-layout-constraints).

The dispatcher adds UNIFORM usage to its existing parameter buffers. Only the packed matrix shader changes its binding type. Its 8×8 workgroup, 16×16 tile, ordered FP32 dot products, half rounding, guards and broadcast addressing stay intact. All other shader exports are byte-identical. The likely gain is compiler treatment of shared dispatch constants; instruction counts, cache traffic and energy were not measured. The inference is supported by timing, not a disassembly or hardware counter trace.

## Isolated stage A/B

Positive values below mean lower GPU timestamp duration. Each comparison retains five interleaved ABBA/BAAB pairs and preceding original/original controls. A row supports a timing claim only when every interval is positive and its median control ratio is within 5% of one.

| Shape | NVIDIA reduction | Intel reduction |
| --- | ---: | ---: |
| QKV, M=192, K=1024, N=2048 | 25.00% | 6.23% |
| Feed-forward expansion, M=320 | 6.62% | 4.06% |
| Feed-forward contraction, M=320 | 32.56% | 5.54% |
| Attention | 14.29% | 4.62% |
| Output head, N=8200 | 5.95% | 7.20% |
| Long expansion, M=710 | 8.69% | 3.67% |
| Long contraction, M=710 | -19.03% | 7.22% |

The large NVIDIA contraction regresses by 19.03%; this is a workload-specific improvement, not a claim that every matrix is faster. No vendor or shape selector is added. Complete-request latency and continuity both matter for acceptance.

## Complete-request A/B

Four fresh-browser pairs reverse order on alternating pairs. Both variants run the same long text, model, seed, 24-step request and following 12-step request, under a strict 6 GiB browser Job commitment cap. Initialization is outside synthesis CPU intervals; cumulative commitment peaks include initialization. Positive reductions mean lower cost.

| Pair | First latency | Following latency | Browser CPU | Peak commitment saved |
| --- | ---: | ---: | ---: | ---: |
| 1 | 1.37% | 6.27% | -11.90% | -232.75 MiB |
| 2 | 13.35% | 6.62% | 19.87% | -11.95 MiB |
| 3 | 6.67% | 6.91% | -2.38% | 329.73 MiB |
| 4 | 5.30% | 5.82% | 0.00% | 239.93 MiB |

The paired median CPU reduction is -1.19% and the pooled reduction is 2.39%; this establishes no reliable CPU saving. Peak commitment improves in two pairs and worsens in two, with 113.99 MiB median saving. This is not evidence of lower resident RAM or attributed GPU memory. Retained main workspace remains exactly 63,096,452 bytes in both variants; decoder retention remains zero. Commands, output capacity, model steps and matrix arithmetic are unchanged. The prototype production tree was byte-identical to the measured prototype at qualification; the final production tree is restored to the previous accepted build.

## Continuity failure and restoration

Both five-minute prototype attempts fail the unchanged handoff requirement. Short baseline and candidate controls also fail. The first run is followed by host-wide GPU activity around 61–73% and about 323 W, including an unrelated Python compute process; it is left untouched and exits independently. That is a confound, not a proven explanation: the short candidate control and second full attempt still fail after the GPU returns near idle. The cause remains unresolved.

| Run | Duration | Completed clips | Missed event handoffs | Largest event gap |
| --- | ---: | ---: | ---: | ---: |
| sustained | 300.44 s | 31 | 30/30 | 3551.26 ms |
| contended-baseline-1m | 61.08 s | 6 | 6/6 | 2487.37 ms |
| contended-candidate-1m | 61.00 s | 6 | 6/6 | 2483.32 ms |
| sustained-quiet | 301.33 s | 32 | 29/32 | 2680.24 ms |

The old build's short control also takes about 5–11 seconds for most synthesis requests, versus roughly two seconds in its earlier successful continuity evidence. This does not establish a candidate-specific regression or exonerate the candidate. No continuity requirement is relaxed. The first waveform analysis stops with too few prepared warm handoffs and provides no acoustic pass. Failed captures, accounting, logs and host snapshots remain preserved. The prototype is held until the baseline failure can be explained and a valid continuity comparison completed.

## Rejected subgroup experiments

The browser advertises subgroups on both adapters, with NVIDIA size 32 and Intel range 8–32. The experiments try logical subgroup indexing, scalar/pair register shuffles, bounded logical indices, an original-geometry ballot/contiguity guard and a shared-memory fallback. They retain FP32 accumulation order. WGSL promises no mapping between subgroup IDs and local invocation indices, so the prototypes either construct a logical layout or verify the mapping; inactive or unsupported layouts use safe fallback reads. See [WGSL subgroups](https://www.w3.org/TR/WGSL/#subgroups).

There are 576 exact matrix/control cases in six completed reports, covering 30 shapes in the initial and uniform series and 12 production shapes in the bounded series. The rejected shuffles are slower across the major shapes on both adapters; the final original-geometry shuffle is roughly 2.7–3.6 times baseline on Intel. Unchanged-code, geometry and forced-fallback controls remain in the raw evidence. Failed noise controls support no timing claim.

The first Intel attempt loses its device after 76 completed numerical rows, before MapAsync completes on the next large shape. Its 64-repeat initial calibration is a plausible contributor; the cause is not established. The preserved rerun with bounded calibration completes all 150 rows. Earlier native-layout drafts fail reserved-word or uniformity checks; diagnostics are retained, never suppressed. The final unconditional shuffle uses its own lane when a cross-lane read is ineligible, compiles, and is still rejected on cost. No subgroup code or new subgroup feature requirement enters the application.

## Benchmark calibration and validation

The reusable kernel benchmark now executes each captured batch once to estimate GPU duration and wall time before scheduling repeated work. Repetitions target 8 ms and are capped at 4096 and an estimated 100 ms per block, with at least one repetition. Zero timestamps use the caller fallback within that cap. One batch can still exceed the estimate; this is not a hard driver-timeout guarantee. Six new boundary checks bring timing self-checks to 13. Both adapters pass 19 canonical numerical/resource cases with the new calibration. Tiny noisy intervals remain reported without speed claims.

- The prototype passes 1,655 tests in 141 files, strict/boundary types, changed-file lint and build before continuity qualification. After restoration, all 1,654 accepted tests, types, lint and build pass again. Native binary/source and browser artifact checks pass.
- Each adapter passes 66 WebGPU/C++ precision cases. All 288 short/long half-logit tensors, native PCM/codes/WAV, 17 packaged short pairs and eight long pairs match their accepted baselines exactly.
- Eight Kokoro CPU/GPU controls retain exact PCM, native feeds and chunks.
- Continuity fails as recorded above; it is not claimed to pass. All attempts configure the 6 GiB Job cap; maximum observed Job commitment is 4.46 GiB. The second full run also contains one unverified transient process observation: openError 87 without positive Job listing. The strict membership rule rejects that sample; it is retained and no complete process-coverage claim is made for that run. The other three attempts and all cost pairs satisfy strict coverage. The predicate is unchanged.

The prototype parameter-upload unit test initially omitted the mock half feature and expected element strides where the existing format uses batch strides. Both test-fixture mistakes were corrected; failed logs remain in the evidence. The prototype test is preserved in artifacts and the accepted test file is restored.

## Evidence and limits

Evidence lives in ignored artifacts/subgroup-matmul-20261101/: immutable raw timing reports, failed logs, mapping/source proofs, before/candidate modules, both extension trees, strict process accounting, exact-output hashes, playback capture, summary.json and verification.json. The new report output is refused if it already exists; measurements use the host-wide lock. The benchmark command remains:

```text
node scripts/benchmarks/inference-kernels.mjs --output=artifacts/<new-report>.json
```

Ultra 9 / RTX 5090 development host and Intel Xe-LPG controls, Chromium 156.0.8078.4. Four counterbalanced browser pairs, one long text at 24 then 12 steps, variable unrelated host activity. Isolated stage effects vary by shape. Buffer capacity is not adapter VRAM residency; job commitment is not resident RAM. Physical 8 GiB RAM/VRAM, weaker dedicated GPUs, AMD, device audio, energy and broad PDF/OCR remain unqualified. Goal active. A browser commitment cap on a 63 GiB host with an RTX 5090 is not physical 8 GiB qualification. Remaining work includes representative weaker dedicated GPUs, physical 8 GiB RAM/VRAM, actual device-output continuity, and reducing the still-dominant matrix work without shifting cost into CPU or memory.
