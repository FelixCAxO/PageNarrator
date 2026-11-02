# Bound GPU work without changing inference calculations

This follows the [long-request device-loss investigation](cold-workspace-20261031.md). A single large submission loses the Intel device with `DXGI_ERROR_DEVICE_HUNG`; separate bounded submissions complete the same work. Compute-pass boundaries alone and multiple command buffers submitted together do not fix that control.

The application candidate caps command buffers at 256 dispatch/copy commands and submits each buffer separately, preserving order. Shader code, tensor arithmetic, weights, diffusion steps, GPU allocation sizes and the existing 128 MiB plan-cache limit remain unchanged. The accepted lifetime allocator still uses 402,753,376 bytes on the first long decode and 175,106,048 bytes on a matching repeat; those capacity savings precede this change.

## Keep captures intact and stream replay

Fresh batches retain their existing eager encoding and ordered pipeline/bind-group/copy records. At a boundary, a finished buffer waits until explicit submit, preserving cancellation before execution. Cached replay submits each completed buffer before encoding the next one, allowing GPU execution to overlap remaining host encoding. Both paths cap buffers at 256 commands. Cancellation discards all unsubmitted finished buffers. Initial capture is encoded once; the diagnostic prototype's first-capture re-encoding is absent.

Validation flags reset once before a replay, rather than between segments. Immutable parameters and input/weight ownership retain their existing rules. Failed partial submissions leave no encoder references behind; cleanup waits for submitted work, and a valid later replay can recover. The change does not lower model precision or alter the production diffusion setting.

## Iterate on host cost

All variants use four counterbalanced baseline/candidate browser pairs. Each pair generates the same 19-second passage at 24 steps, then at 12 steps. Exact raw float32 PCM, sample rate and length must match. CPU counts cover user+kernel time for the verified browser job, including renderer, worker and GPU-process host work. Initialization, controller and fixture server are excluded. Commitment peaks include initialization and are not physical resident RAM. Timings have no correctness instrumentation.

| Candidate | Combined paired-median browser CPU | Paired-median commitment peak | First long time reduction | Following long time reduction |
| --- | ---: | ---: | ---: | ---: |
| 128 commands, eager encoding | +7.1% | +1.9 MiB | 1.94% | 1.42% |
| 256 commands, eager encoding | −12.7% | +47.4 MiB | 1.87% | 0.77% |
| 256 commands, deferred capture | +4.5% | +25.8 MiB | 1.90% | 1.99% |
| **256 commands, eager capture / streamed replay** | **−5.6%** | **−19.5 MiB** | **3.04%** | **6.14%** |

These are separate counterbalanced experiments against the same saved baseline, not a direct percentage subtraction between candidates. The last row is selected. Mixed individual pairs and unrelated host GPU activity limit claims about fixed CPU or timing savings. Earlier candidates, their measured packages and tests remain preserved.

The selected candidate's complete CPU and commitment comparison is:

| Pair | Baseline browser CPU | Candidate browser CPU | CPU reduction | Commitment peak saved |
| --- | ---: | ---: | ---: | ---: |
| 1 | 3.969 s | 2.109 s | 46.9% | 60.1 MiB |
| 2 | 2.313 s | 2.297 s | 0.7% | 80.8 MiB |
| 3 | 2.797 s | 2.500 s | 10.6% | −21.1 MiB |
| 4 | 2.375 s | 2.797 s | −17.8% | −79.5 MiB |

CPU improves in three pairs and regresses in one; its paired-median reduction is 5.6%, with a −17.8% to 46.9% range. Commitment improves in two pairs and regresses in two, with a 19.5 MiB paired-median saving. These observations do not establish a fixed RAM or CPU saving across machines.

The selected candidate's timing comparisons are:

| Request | Baseline median | Candidate median | Paired median time reduction |
| --- | ---: | ---: | ---: |
| Long first / 24 steps | 4,087.8 ms | 3,966.6 ms | 3.04% |
| Long following / 12 steps | 2,065.8 ms | 1,924.4 ms | 6.14% |
| Short first / 24 steps | 1,926.6 ms | 1,805.3 ms | 5.85% |
| Short following / 12 steps | 1,037.7 ms | 997.7 ms | 4.53% |

All four long-request pairs improve in both timing rows. The short rows come from a separate four-pair frozen-corpus comparison. Initialization pairs are 8,639→7,901, 7,704→7,572, 7,802→7,805 and 7,602→8,004 ms; no consistent startup saving is established.

## Keep measurement coverage strict

The first refined cost run stops at pair 3 because an unrelated `adb.exe` appears in the browser ancestry inventory. Its creation time is the previous day; its recorded parent PID has been reused by the newly launched browser. The incomplete run and raw PID observations are retained and excluded from performance acceptance.

The Windows supervisor now checks process creation times before following a parent-PID edge. A child provably older than that parent cannot belong through that edge. Equal or unknown times remain included, and every kernel job-listed process is still included. The strict acceptance rule remains `inJob === true`, or a job-listed process that exited with Windows error 87. No unrelated process is terminated.

The actual C# supervisor is compiled in Windows PowerShell for five timestamp cases: older, newer, equal, unknown child and unknown parent. Those checks and the related job/evidence tests pass: 132 tests across three files. New raw process entries include creation timestamps for subsequent audits. CPU/commitment accounting continues to come from the same kernel job counters.

## Correctness and remaining qualification

The selected implementation passes **1,583 engine/TTS/reader tests across 136 files**, including 14 bounded-submission tests. Tests cover both sides of the 256-command boundary, ordered copies, empty work, initial versus replay encoding, canceled finished buffers, streamed replay prefixes, partial queue failure, delayed resource release, validation reset and recovery. Types, changed-source lint, production build and whitespace checks pass.

Six additional controls execute on each real GPU using a 258-command checked-Gather graph: valid output, invalid replay rejection, flag reset with cached recovery, partial queue failure with recovery, independent sessions/private flags, and cancellation without submitting finished work. Both NVIDIA and Intel pass with clean resource counts.

All **66 native precision/error cases per GPU** pass. Native English, Swedish and Arabic on NVIDIA plus English on Intel preserve **192 generated-row half-logit tensors across 96 diffusion steps**, along with codes, PCM and WAVs. The shared-engine long request adds **48 exact half-logit comparisons per GPU**: NVIDIA compares with saved unmodified source; Intel compares with the earlier working 128-command prototype because unmodified long execution loses its device.

The packaged Intel worker completes the full 24-step, 19-second request in **94,798.9 ms**, with exact PCM against the native control, 6.172 seconds of browser-job CPU and a **4,559,917,056-byte commitment peak** under the enforced 6 GiB ceiling. This verifies the actual shared-engine worker and cleanup, while remaining much slower than real-time on that integrated GPU.

All **17 packaged speech pairs**, **eight selected long-request pairs** and **eight Kokoro CPU/GPU controls** preserve their raw PCM. Packaged speaker identity, Kokoro native feeds and chunk boundaries also match.

## Continuous playback and evidence binding

The selected package passes **300.558 seconds** of varied-paragraph muted playback: **38 completed clips, 38 prepared handoffs and zero unprepared waits**. Added render gaps have p95 and maximum 13.3 ms; minimum source/capture correlation is 0.99999986. All 65 process-accounting observations stay inside the 6 GiB browser-job ceiling, with a **5,074,677,760-byte commitment peak**. Stop and cleanup checks pass. This is render-thread continuity; OS/device audio remains untested.

`summary.json` checks unchanged arithmetic source regions, shader/model pins, native validation/recovery, exact logits/audio, expected engine capacities, worker hashes, strict process coverage and waveforms before deriving results. `verification.json` binds current source and every reachable measured worker module to the selected package and successful checks. Native source/binary, browser-artifact and whitespace checks pass. The current prepared main graph retains SHA-256 `8deaf4fa4d77c8147711fda95f763b76b9d6259b93be127df95c99af896b8afb`.

The source snapshots, earlier variants, failed accounting run and raw reports live in ignored `artifacts/bounded-submissions-20261031/`. Timed/synthesis work is serialized under the host measurement lock; unit/build checks run separately. The failed partial accounting run is excluded, and the creation-time inventory fix leaves the kernel CPU accounting code and strict membership acceptance unchanged.

The host is a Core Ultra 9 285K with about 63.3 GiB RAM and an RTX 5090 with nominal 32 GiB VRAM; Intel Xe-LPG supplies additional controls. Physical 8 GiB RAM/VRAM systems, weaker dedicated GPUs, audio-device continuity, energy and broad PDF/OCR remain unqualified. Successful Intel execution is separate from real-time synthesis. The broader goal remains active.
