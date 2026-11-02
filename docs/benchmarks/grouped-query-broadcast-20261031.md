# Broadcast grouped-query attention without copying heads

This follows the [packed-matrix scheduling experiment](packed-matmul-scheduling-20261031.md). The baseline includes all preceding CPU, loading, projection and GPU improvements. This iteration changes the pinned OmniVoice playback graph preparation, its contract test and provenance. GPU shaders, native binaries, model/evaluation pins, sampling, seeds, precision and diffusion steps remain unchanged.

## Remove duplication rather than changing the dot products

The actual graph repeats eight key/value heads twice to match sixteen query heads. Each layer expands `[1,8,1,L,128]` to `[1,8,2,L,128]`, flattens the head axes, and then performs attention. Both keys and values are copied. Keys are subsequently transposed after duplication.

The candidate keeps keys and values compact. Metadata reshapes expose query heads as `[1,8,2,Q,128]`, and the existing batched MatMul broadcasts compact keys across the two-head group. Its result is restored to `[1,16,Q,K]` before the original scaling, mask and softmax. Value multiplication uses the same grouping and restores `[1,16,Q,128]` afterward. Dynamic key length comes from tensor shape metadata, so query/key lengths need not be equal. The specialized pinned model retains batch one, sixteen query heads, eight KV heads and width 128.

Each head reads the same values in the same accumulation order. There are no fewer attention heads, dot-product terms, generated rows or diffusion steps. Full bidirectional attention and all public KV outputs remain intact. The work removed is duplicate storage, copies, dispatches and associated planning/recording.

This uses existing standard ONNX operations and batched-matrix broadcasting. There is no new shader, backend, dependency, device-specific branch or user setting. The existing parser/writer applies normalization, generated-row selection and grouped attention in one pass. Only original hash-verified graph bytes enter CacheStorage; learned tensors are unchanged.

The final derived graph is pinned to `8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb`. The original graph remains `cab55e2fe02dc4239cf9c6674cc8f83e41c645b96db92baa02d6515c90fe745e`, and the normalization-only graph remains `4ace0df24c6b611fd19f47bc5c44b482ef0e20acd868d81e4f2a2f24f807a0e0`. Runtime diagnostics distinguish the original, normalization and final hashes.

## Check the algorithm on native GPUs first

Ten matrix cases per architecture compare materialized repetition with broadcasting. They cover unequal lengths, batch two, differing group counts, even/odd dimensions and the actual 77-, 259- and 475-position attention sizes. All 20 cases preserve exact half output bits and release their resources without GPU errors.

Each comparison has five interleaved ABBA/BAAB timestamp pairs and original/original controls. A failed noise screen retains the raw timings and supports no speed claim. Temporary bytes are engine allocations for the isolated stage, including its output; they are not whole-process VRAM peaks:

| Stage | Baseline temporary bytes | Candidate temporary bytes | Valid NVIDIA time reduction | Valid Intel time reduction |
| --- | ---: | ---: | ---: | ---: |
| 77-position scores | 820,512 | 347,424 | 17.9% | 22.1% |
| 77-position values | 630,784 | 315,392 | 31.8% | 20.6% |
| 259-position scores | 4,268,320 | 2,677,024 | 19.6% | 8.2% |
| 259-position values | 2,121,728 | 1,060,864 | Excluded | 8.3% |
| 475-position scores | 11,111,200 | 8,192,800 | Excluded | 5.9% |
| 475-position values | 3,891,200 | 1,945,600 | Excluded | 3.1% |

The excluded NVIDIA rows fail their noise controls on the loaded development host. One additional tiny unequal-length row fails its control on each architecture. Exactness and allocation checks still pass. These stage results are not full-speech speedups or exclusive-host measurements.

## Verify the full graph and package

The production graph matches the independently tested prototype's serialized bytes exactly. All 144 conditional/unconditional generated-row logit tensors across the English, Swedish and Arabic 24-step requests match the baseline bit for bit on NVIDIA. Another 48 tensors match on Intel using the same pinned prototype bytes. All corresponding codes, raw PCM and WAVs match. Hashes cover every generated-row half-logit byte, not only final selected codes.

All 17 packaged speech pairs preserve exact float32 PCM, length, rate and speaker identity across five languages, variation, Hindi whisper, recovery and a long passage. Eight additional paired long requests also preserve exact PCM under an enforced 6 GiB browser-job commitment ceiling.

The 1,502 engine/TTS/reader tests, strict/boundary type checks, changed-file lint, build and native/browser artifact checks pass. The expanded pinned-graph contract verifies every learned tensor and public interface, the exact whitelist of rewired nodes, dynamic shape construction, removal of stale internal rank annotations, unchanged softmax/scaling/masking, and all other node definitions. The generic GPU primitive and Kokoro suites are not repeated because their code is unchanged; the new native broadcast cases cover the changed layouts directly.

The wider validation initially stopped on an argument-splatting error before candidate inference, and the first playback invocation did not start because of an executable-path typo. Successful corrected runs are retained with the completed baseline and failed-command evidence. Neither failed invocation contributes measurements.

## Less GPU work and retained plan storage

The actual first conditional English profile drops from 1,375 to 1,319 dispatches: all 56 duplication expansions disappear. The number of matrix operations is unchanged, and the checked Gather validations remain unchanged. Key-transpose outputs also contain half as many heads.

For the observed English shapes—259 conditional positions and 77 unconditional positions—24 diffusion steps avoid about 1.723 GiB of expansion destination writes plus 0.431 GiB of key-transpose destination writes, about 2.153 GiB total. This is cumulative logical write payload, not resident memory, measured bus traffic or an energy claim.

The paired 19-second workload reports:

| Engine observation | Baseline | Candidate |
| --- | ---: | ---: |
| Retained main GPU plan bytes | 105,087,000 | 100,719,384 |
| Last reported main plan bytes | 63,399,060 | 60,475,284 |
| Nodes in that main plan | 4,506 | 3,330 |
| Dynamic metadata readbacks | 0 | 0 |
| Main GPU weight bytes | 1,225,154,680 | 1,225,154,680 |

All four resource pairs show the same 4,367,616-byte retained-plan reduction, about **4.17 MiB**. Unused shape-building paths are omitted from execution planning after the duplicate expansions are bypassed. The existing two-plan/128 MiB cache policy is unchanged. Five small int64 shape constants add 136 retained host bytes; learned-weight storage is unchanged. Engine-owned plan savings do not prove an equal drop in whole-process VRAM or physical RAM.

## Whole requests and native CPU counters

Four counterbalanced pairs repeat two English requests; another four pairs measure two long requests. Wall times exclude initialization and all diagnostic hashing/profiling:

| Request | Baseline median | Candidate median | Paired median time reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| Short first / 24 steps | 2639.4 ms | 2591.2 ms | 1.6% | 0.2–17.5% |
| Short following / 12 steps | 1398.1 ms | 1378.0 ms | 1.1% | −0.2–17.4% |
| Long first / 24 steps | 6074.9 ms | 6021.5 ms | 2.3% | −2.7–13.6% |
| Long following / 12 steps | 3102.6 ms | 3022.5 ms | 2.0% | 0.8–4.1% |

The wide ranges include all pairs. Startup pairs are 8,907→7,705, 7,456→7,440, 7,410→7,489 and 7,334→7,281 ms. One startup pair regresses; no general initialization speedup is established.

Whole-browser CPU around both long requests has paired reductions of 6.7%, 8.5%, −2.0% and 5.5%, a median **6.1% reduction**. Three of four improve. Job counters cover the complete browser tree, including terminated children, renderer/worker and GPU-process host work, transport, hashing and diagnostics. They exclude initialization, the controller and fixture server. Every observed browser process is covered by the same job.

Browser commitment peaks remain mixed: two rise by 26.0 and 32.3 MiB and two fall by 69.3 and 24.4 MiB. The paired median change is a 0.75 MiB increase. There is no established whole-browser RAM reduction. These commitment high-water marks include initialization and are not resident physical RAM. CPU and latency percentages apply to this immediate baseline; they are not added to earlier iterations.

## Continuous playback and limits

The final package passes 300.7 seconds of varied-paragraph playback under the enforced 6 GiB job commitment ceiling: 38 complete clips, 38 prepared handoffs, zero unprepared waits, and p95/maximum added render gaps of 13.3 ms. Minimum source/capture correlation is 0.99999986. Native accounting records 66 observations and a precise commitment peak of 4.692 GiB. Stop/cleanup checks pass. The muted waveform capture excludes OS/audio-device routing.

Evidence and reproduction scripts are in the ignored `artifacts/grouped-query-broadcast-20261031/` directory. `summary.json` verifies logit hashes, audio, native process coverage, memory limits and waveform checks before deriving metrics. `verification.json` binds source files, the measured worker and its reachable runtime bundle, prototype graph bytes and the final checks.

The host has a Core Ultra 9 285K, about 63.3 GiB physical RAM and an RTX 5090 with nominal 32 GiB dedicated memory. NVIDIA has substantial unrelated GPU activity; Intel Xe-LPG provides further correctness and controlled-stage evidence. Physical 8 GiB RAM/VRAM PCs, weaker dedicated GPUs, audio-device continuity, energy and the broader PDF/OCR matrix remain unqualified.
