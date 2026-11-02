# Transformer kernels and overlapping validated readbacks

This follows the [generated-row projection experiment](output-projection-20261031.md). Its baseline already includes that projection, single-pass graph preparation and the earlier packed-matrix, sampling, loading and execution-cache optimizations. Model/evaluation pins, steps, seeds, precision and speech quality checks remain unchanged.

## Profile the dominant work first

The current first conditional English pass has 1,375 GPU dispatches. Instrumented operator timestamps total about 35.0 ms, including 27.0 ms in 197 packed half matrix multiplications and 1.70 ms in 56 other half matrix multiplications. Matrix multiplication accounts for about 82% of this diagnostic GPU time. The profiler creates separate timestamped passes, so its absolute timings are not ordinary application throughput or an exclusive-host measurement.

The initial attempt with a larger timestamp query set produced an invalid profiling command buffer. Its failed report and zero timestamps are retained and excluded. The rerun uses the previously working 4,096-query setup and captures the complete pass without reaching its 2,048-operation cap.

Four matrix alternatives preserve all output bits but fail the performance comparison. Each uses 13 half-precision shapes and five counterbalanced GPU timestamp pairs:

| Candidate | Representative result | Decision |
| --- | --- | --- |
| Packed inner tile 32 instead of 16 | NVIDIA conditional feed-forward matrix 20% slower | Reject |
| XOR permutation of shared left-hand storage | Same NVIDIA shape 41% slower; Intel 77% slower | Reject |
| Explicit 16×32 output tile | Some NVIDIA shapes improve, but continuation 38% slower; Intel regressions | Reject |
| Explicit 32×16 output tile | NVIDIA continuation 31% slower; Intel head 11% slower | Reject |

The wider tiles use explicit accumulators rather than the earlier array-based wider-tile experiment. Accumulation order and float32 arithmetic are preserved. None of these shaders enters production. Previously measured shared-memory padding also remains rejected. Fewer barriers or workgroups alone do not establish lower compute cost on the measured hardware.

## Queue validation and output copies together

The profile also finds one checked audio-embedding Gather in the conditional pass. Its conservative integer range includes prefix text IDs outside the audio table even though masking makes the actual lookup valid. The required bounds flag is read back before audio logits, creating two serial CPU/GPU readback waits.

The candidate keeps that validation, its shaders and both readbacks. It queues validation and output readback together, then awaits both with `Promise.allSettled`. Outputs remain private until validation succeeds. A validation error takes precedence, and both reads settle before cleanup or a subsequent inference. Direct calls to the lower-level output reader retain validation by default. New inference and cached replay both use the same helper.

The change adds no retained GPU buffers, alters no model calculations, and does not reduce transferred bytes or GPU dispatches. It overlaps existing waits. No CPU, RAM, bandwidth or energy reduction follows merely from that overlap.

## Correctness and lifecycle controls

The 1,471 engine, TTS and reader tests, strict/boundary type checks, changed-file lint and production build pass. Focused tests cover immediate copy queuing, withholding output while validation is pending, draining an in-flight read after invalid indices, validation-error precedence, read failures and default validation for direct output reads.

Both NVIDIA Blackwell and Intel Xe-LPG pass 66 native GPU/C++ controls. A new actual ONNX Gather test produces two simultaneously active reads, rejects invalid indices on a captured replay, recovers through the same cached plan, and releases every added buffer and tensor. These controls exercise the integrated output reader as well as the primitive Gather check.

All 17 packaged speech pairs preserve exact float32 PCM, length, sample rate and speaker identity. They cover five languages, variation, Hindi whisper, recovery and a 19-second clip. Eight further paired long requests under an enforced 6 GiB browser-job ceiling also match exactly. Kokoro's eight CPU/GPU cold/warm controls preserve raw PCM, feeds and source chunks against the preceding verified controls.

## Request timings and resource accounting

Four counterbalanced packaged pairs repeat the first two English requests without profiling hooks. Wall times exclude initialization:

| Request | Baseline median | Candidate median | Paired median reduction | Pair range |
| --- | ---: | ---: | ---: | ---: |
| First / 24 steps | 1942.7 ms | 1934.9 ms | 1.56% | −0.75–4.52% |
| Following / 12 steps | 1033.5 ms | 994.3 ms | 2.97% | 1.42–5.06% |

The continuation improves in all four pairs, while one first-request pair regresses. These are modest development-host latency results, not a representative hardware qualification.

Native job accounting around two long requests gives a median paired CPU reduction of only 0.18%, ranging from 2.6% higher to 6.9% lower CPU. Browser commitment peaks are mixed: three increase and one decreases, with a median paired increase of 17.3 MiB. There is no established CPU or RAM saving. CPU counters include renderer/worker and GPU-process host work, transport, PCM hashing and diagnostics, while excluding initialization, the controller and fixture server. Commitment peaks include initialization through the last observation and do not measure resident physical RAM or dedicated VRAM.

The final package passes a five-minute varied-paragraph read under the enforced 6 GiB browser-job commitment ceiling, including streamed waveform alignment, stop and cleanup:

| Playback observation | Result |
| --- | ---: |
| Duration | 301.2 s |
| Completed chunks / prepared event handoffs | 38 / 38 |
| Complete source-aligned clips / boundaries | 38 / 37 |
| Unprepared waits | 0 |
| Added render gap, p95 / maximum | 13.3 / 13.3 ms |
| Minimum source/capture correlation | 0.99999986 |
| Precise browser commitment peak | 4.847 GiB |
| Native accounting observations | 65 |

This muted render capture does not measure audio-device latency. Commitment includes initialization and playback through the last pre-export observation, excluding the controller and fixture server. Its peak cannot establish a memory improvement over differently timed prior reads.

Evidence is under `artifacts/transformer-compute-20261031/`: original/candidate source, rejected shader variants, raw timestamp pairs, complete model profiles, baseline package, native validation controls, WAVs, counters and command logs. Automated audio is muted. Current hardware remains the development Core Ultra 9 / RTX 5090 host; Intel supplies additional native correctness and kernel-timing controls. Physical 8 GiB RAM/VRAM PCs, weaker dedicated GPUs, device audio, power and the wider PDF/OCR matrix remain unverified.

`summary.json` validates paired speech hashes, native recovery, GPU errors, process coverage and accounting limits before deriving results. `verification.json` records final source pins and checks the packaged worker hash. Reproduction scripts are retained with the evidence; native checked-output regression coverage is part of `scripts/probe-native-engine.mjs --precision`. Its original correctness-only scope is unchanged.
