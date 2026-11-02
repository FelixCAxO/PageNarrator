# Share workspace between serialized GPU plans

This follows the [grouped-query broadcasting A/B](grouped-query-broadcast-20261031.md). The candidate shares mutable GPU workspace between cached plans that already execute serially. Four counterbalanced long-request pairs use **41.6% less browser CPU** at the paired median and finish **9.2–10.6% sooner**, with exact audio. The existing two-plan/128 MiB cache limit remains unchanged.

## Find the repeated work

The long workload alternates conditional `[1,8,710]` and unconditional `[1,8,475]` inputs. A diagnostic trace records 36 passes of each. Previously the conditional plan hits its cache 35 times, while the unconditional plan hits zero times. There are no input-bound invalidations in that baseline. This is a storage-budget problem: separate plans need 100,719,384 and 60,475,284 bytes, exceeding the 134,217,728-byte budget together. The existing admission guard correctly prevents them from evicting each other on every pass, but the unconditional plan must repeatedly rebuild, allocate and record commands.

Both plans execute behind the same session run gate. Each run finishes GPU validation and output transfers before the next begins. Their mutable intermediate results therefore need no simultaneous storage. The candidate lets a new plan borrow the cached plans' output/scratch buffers, choosing the smallest adequate buffer alongside its existing local recycling pool. GPU arithmetic, dispatch count, accumulation order, precision, model graph, weights, masks, sampling, seeds and diffusion steps are unchanged.

Only buffers allocated as batch outputs enter the lendable set. Inputs, learned weights, views of inputs/weights, uploaded constants, command parameters and validation flags remain private. A buffer cannot be recycled while a current-batch view still uses it. Other captured plans' owners remain alive, and explicit per-plan ownership holds preserve shared scratch across eviction. These holds allocate no GPU memory. Partial-capture failures release any holds already created.

The validation flag receives a private four-byte allocation: a host reset must never alias an earlier GPU dispatch or another plan's workspace. Bounds checks, alias checks, validation/output draining, LRU eviction and cleanup remain active. Unrelated sessions never borrow each other's buffers, including when they run concurrently on one engine. Cache admission and diagnostics count the union of physical GPU buffers, avoiding double counting shared storage. CPU and single-plan paths retain their existing accounting.

## Cache and allocation evidence

The candidate diagnostic trace records 35 conditional and 32 unconditional cache hits. Three unconditional passes still invalidate on the existing bounds guard; no guard is relaxed. The two plans share 64 workspace buffers and retain **102,725,784 unique bytes**, about 97.97 MiB. This is **2,006,400 bytes more persistent GPU storage**, about 1.91 MiB, than the baseline's one retained conditional plan: the second plan's private inputs and parameters now remain cached.

| Last reported unconditional run in each resource pair | Baseline | Candidate |
| --- | ---: | ---: |
| Cache hit | No | Yes |
| New intermediate allocations | 66 | 0 |
| Intermediate bytes allocated in that run | 58,468,884 | 0 |
| Reused buffers | 1,305 | 1,371 |
| Planned nodes | 3,330 | 3,330 |
| Dynamic metadata readbacks | 0 | 0 |
| Total retained main-plan bytes | 100,719,384 | 102,725,784 |
| Main GPU weight bytes | 1,225,154,680 | 1,225,154,680 |

The candidate's individual unconditional-plan buffer capacities total 66,852,304 bytes because borrowed buffers can exceed a requested tensor's logical size. Adding individual plan totals would count shared buffers twice. The baseline's simultaneously retained conditional plan plus temporary unconditional plan need 161,194,668 bytes; the candidate's union removes 58,468,884 bytes, about 55.76 MiB, from that stage's storage requirement. This is engine buffer accounting, not a complete VRAM-peak reduction. The later decoder has larger temporaries, and the extra private cached storage remains during decoding.

Diagnostic tracing and per-step hashing run separately from performance comparisons. Their elapsed times support no speed claim.

## Paired requests and browser counters

Four counterbalanced packaged pairs measure short requests; another four pairs measure two long requests under a 6 GiB Windows browser-job commitment ceiling. All timings exclude initialization. Percentages are paired reductions against this iteration's immediate baseline and are not added to earlier iterations.

| Request | Baseline median | Candidate median | Paired median time reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| Short first / 24 steps | 1858.3 ms | 1781.1 ms | 2.7% | −0.8–6.2% |
| Short following / 12 steps | 931.6 ms | 940.2 ms | −0.9% | −4.4–0.01% |
| Long first / 24 steps | 4080.1 ms | 3697.8 ms | 9.2% | 7.5–11.3% |
| Long following / 12 steps | 2035.7 ms | 1820.5 ms | 10.6% | 8.9–11.3% |

All long timing pairs improve. The short following request is slightly slower; the change is retained for the larger CPU reduction and long-request gains. No short-request latency improvement is established. Initialization pairs are 7,852→7,923, 7,475→7,753, 7,650→7,446 and 7,634→7,729 ms; initialization also has no established gain.

Browser-job CPU across both long requests falls in all four pairs:

| Pair | Baseline CPU | Candidate CPU | Reduction | Commitment peak saved |
| --- | ---: | ---: | ---: | ---: |
| 1 | 3.953 s | 2.141 s | 45.8% | −8.3 MiB |
| 2 | 4.219 s | 2.359 s | 44.1% | 99.3 MiB |
| 3 | 3.703 s | 2.641 s | 28.7% | 47.0 MiB |
| 4 | 3.750 s | 2.281 s | 39.2% | 148.4 MiB |

The paired median CPU reduction is **41.6%**. Counters cover the entire browser process tree, including terminated children and GPU-process host work, transport, hashing and diagnostics. Initialization, the controller and fixture server are excluded. All observed browser processes belong to the measured job.

Commitment high-water marks fall in three pairs and rise by 8.3 MiB in one. The paired median saving is **73.1 MiB**. Commitment includes initialization and is not resident physical RAM. These mixed peaks do not establish a fixed resident-RAM saving.

## Correctness, failure handling and continuity

Five new ownership/recycling unit cases pass, alongside the complete 1,507-test engine/TTS/reader suite across 132 files. Strict and boundary types, changed-file lint, production build, native source/binary checks, browser artifact checks and whitespace checks pass.

Five native controls on each architecture cover alternating plans within a budget smaller than their separate storage, LRU eviction and unchanged returned CPU arrays; learned-weight aliases and private parameters; injected failure while creating ownership holds; checked-Gather invalid replay draining and recovery through the other plan; and unrelated-session isolation. All controls release resources without GPU validation errors on NVIDIA Blackwell and Intel Xe-LPG. The initial native weight fixture was promoted to CPU metadata; it was corrected to use a genuine GPU-resident weight before successful validation. Failed fixture logs remain available.

The existing 66 native precision/error/recovery cases pass on each GPU. Raw generated-row half-logit hashes match for all 192 tensors across 96 diffusion steps: English, Swedish and Arabic on NVIDIA, plus English on Intel. Corresponding codes, raw PCM and WAVs match exactly. The prepared graph remains `8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb` on both sides.

All 17 packaged speech pairs and eight long-request pairs preserve exact float32 PCM, length and sample rate. Speaker identity also matches in the packaged controls. Eight Kokoro CPU/GPU cold/warm controls preserve their previous raw PCM, input feeds and chunk boundaries exactly.

The final package passes **300.3 seconds** of varied-paragraph playback: **38 complete clips, 38 prepared handoffs and zero unprepared waits**. Added render gaps have p95 and maximum 13.3 ms; minimum source/capture correlation is 0.99999986. All 65 native accounting observations remain within the enforced 6 GiB browser-job ceiling, with a 5,081,014,272-byte commitment peak. Stop/cleanup checks pass. Audio remains muted, so this qualifies render-thread continuity only.

## Evidence and remaining qualification

Reproduction scripts, immutable baseline/candidate source snapshots and raw reports are in the ignored `artifacts/plan-workspace-20261031/` directory. `summary.json` asserts source pins, exact logits/audio, native cleanup, cache observations, job coverage, memory limits and waveform checks before deriving results. `verification.json` binds those results to the current source, measured worker and its reachable runtime modules. Measurements run serially with the existing measurement lock; unit/build checks are separate.

The development host has a Core Ultra 9 285K, about 63.3 GiB RAM and an RTX 5090 with nominal 32 GiB VRAM. Unrelated GPU activity prevents exclusive-host or energy claims. Intel supplies additional correctness evidence, not a weaker dedicated-GPU performance qualification. Physical 8 GiB RAM/VRAM PCs, weaker dedicated GPUs, audio-device output and the wider PDF/OCR workload remain unverified.
