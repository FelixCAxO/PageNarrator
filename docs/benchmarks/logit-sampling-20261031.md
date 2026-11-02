# Direct FP16 sampling A/B, 2026-10-31

OmniVoice now reads FP16 logits as a `Uint16Array` view and decodes values when the sampler uses them. Previously each conditional and unconditional inference expanded every logit into a new float32 buffer before sampling. Prefix/reference rows and already-decided audio rows were expanded even though sampling skips them.

The change removes those full-tensor conversions and copies. It keeps the existing float32 lookup values, double-precision guidance and confidence arithmetic, vocabulary order, random draws, tie-breaking, unmask schedule, model, diffusion steps and decoder. Float32 output support is unchanged. Every finite FP16 value has the same numeric value through the old and new paths, including signed zero and subnormals; used non-finite values still fail the same quality check. Unused rows remain skipped.

## Isolated CPU stage

Chromium 156.0.8078.4 ran the original and candidate runtime modules against identical deterministic raw FP16 tensors. Each shape uses 24 decoding/sampling steps, identical random draws, warmups, and five counterbalanced pairs. All 20 pairs produced identical audio codes. Timings cover FP16 access/conversion plus sampling on the CPU, without GPU inference, transfer time, decoding audio or playback.

| Audio frames / prefix frames | Baseline median | Candidate median | Paired median time reduction | Avoided float32 allocations per request |
| --- | ---: | ---: | ---: | ---: |
| 77 / 0 | 169.9 ms | 112.4 ms | 33.5% | 115.6 MiB |
| 100 / 180 | 354.4 ms | 188.0 ms | 48.2% | 285.3 MiB |
| 240 / 200 | 726.4 ms | 436.4 ms | 39.7% | 510.5 MiB |
| 512 / 512 | 1529.1 ms | 919.7 ms | 39.3% | 1153.1 MiB |

Allocation totals are calculated from the removed float32 buffers over 24 steps: `24 × 8 × (prefix + 2 × frames) × 1025 × 4` bytes. They are cumulative allocations, not simultaneously live RAM or reduced VRAM. Large shapes are synthetic controls within the existing section limit. The original GPU readback still occurs; no GPU computation or GPU-to-CPU transfer is eliminated by this change.

## Packaged speech controls

The baseline package was copied before rebuilding the candidate. Four counterbalanced trials compare the first two English requests; the first trial additionally covers Swedish, Hindi, Arabic, Japanese, an English variation, male Hindi whisper, and fresh runtime recovery. All 16 request pairs (32 audio samples) match exactly in float32 PCM SHA-256, length, sample rate and speaker identity. The recovery request repeats the original Swedish PCM. Tests preserve the existing 24-step first-request and 12-step same-speaker continuation policy.

| Repeated English request | Pairs | Paired median completion reduction | Pair range |
| --- | ---: | ---: | ---: |
| First request, 24 steps | 4 | 8.5% | 6.1–14.1% |
| Following request, 12 steps | 4 | 7.0% | 0.4–14.7% |

These are complete speech-request wall times, not process CPU time, GPU timing, power or hardware acceptance. The fourth trial slowed for both variants, so device/host timing variation remains material. All paired candidates completed faster; one following-request difference was only 6.6 ms. The isolated CPU stage establishes the intended mechanism more directly than the end-to-end timings.

The `inferenceMs` diagnostic includes readback conversion, so part of its reduction is CPU work. On-demand half lookup happens inside sampling and can raise `unmaskMs`; reading either field alone would misattribute the result. No GPU speedup is claimed here.

## Verification and reproduction

The 1,449 engine, TTS and reader tests, strict and boundary type checks, changed-file lint and production build pass. Added controls exercise all finite half patterns, mixed float32/FP16 inputs, offset views, 24-step selection and random-call equality, used NaN/infinity rejection, and skipping invalid unused prefix/decided rows. The first-party backend's readback owns an independent CPU copy; tensor disposal clears its reference and does not invalidate the returned view.

Evidence is under `artifacts/logit-sampling-20261031/`: original and candidate source snapshots, prototype/final native-browser microbenchmarks, baseline package, `voice-parity/results.json`, WAV controls and command logs. Reports record source hashes and browser version. No model/evaluation pins or acceptance thresholds change.

The muted memory-ceiling playback harness now accepts `PN_SUSTAINED_MINUTES=1..10` (default 5), and includes short paragraphs alongside longer passages to change synthesis shapes. Render capture streams half-second PCM blocks to disk through a bounded queue, checks frame continuity and final byte count, and writes an IEEE float32 WAV header at completion. An exact two-second source control verifies the streamed PCM bytes and WAV framing. Source-clip controls still retain their small reference WAVs for alignment. Physical 8 GiB machines, weaker dedicated GPUs, OS/device audio routing and PDF/OCR remain separate qualification gaps.

The first ten-minute read completed 77 chunks with every event handoff prepared and a 5.377 GiB job peak, but its old full-recording export exceeded the test deadline. That attempt is retained as scheduling/memory evidence, not a passing waveform capture. Streaming addresses the test's output transport and recording retention, without changing the application package.

The complete streaming rerun passes, including stop and cleanup:

| Ten-minute varied read under a 6 GiB browser-job ceiling | Result |
| --- | ---: |
| Playback observation | 601.1 s |
| Completed chunks | 76 |
| Prepared event handoffs / unprepared waits | 76 / 0 |
| Aligned complete-clip render handoffs | 75 |
| Added render gap, p95 / maximum | 13.3 / 21.3 ms |
| Minimum source/capture correlation | 0.99999952 |
| Precise job peak | 5.244 GiB |
| Native accounting observations | 126 |

The initial analysis was inconclusive because the non-rendering audio clock drifted relative to wall timestamps, moving later clips outside the old fixed search window. The analyzer now carries forward the last verified PCM alignment offset for the next search. It still measures gaps between actual source-aligned render positions; gap, overlap and correlation thresholds are unchanged. The observed offset moved from −108 ms to −1910 ms. Independent synthetic controls recover exact 20 ms gaps despite accumulating clock drift and still reject an inserted 250 ms stall. The two-second streaming control also matches every source PCM byte.

Raw median browser private commitment rose from 4.750 GiB in minute two to 4.958 GiB in minute nine; minute ten was 4.940 GiB. This does not prove or disprove a production memory leak. The harness deliberately retains about 27.8 MiB of reference WAV data, additional Blob/copy storage, tracing and flow records, while shape changes also affect allocator/cache high-water marks. Render output itself was streamed to a 114.1 MiB file instead of retained in the browser. Peak commitment stayed below the enforced ceiling throughout the read. Longer sessions without retained controls are still needed to isolate growth.

Reproduce the extended read with the existing pinned fixtures, verified adapter LUID, muted harness and analysis interpreter:

```powershell
$env:PN_E2E_SUSTAINED_OV = '1'
$env:PN_E2E_WORKERS = '1'
$env:PN_SUSTAINED_MINUTES = '10'
$env:PN_SUSTAINED_OUTPUT = 'artifacts/<new-output-directory>'
node node_modules/playwright/cli.js test tests/e2e/omnivoice-sustained.e2e.js --project=extension --reporter=line
python scripts/benchmarks/analyze-handoff-output.py --self-test
python scripts/benchmarks/analyze-handoff-output.py $env:PN_SUSTAINED_OUTPUT
```

The complete derived record is in `artifacts/logit-sampling-20261031/summary.json`; final source pins and verification details are in `verification-final.json`. Reanalysis of the previous five-minute real capture produces exactly the same gaps as its original analysis. Current hardware remains the Core Ultra 9 / RTX 5090 development host; a browser commitment ceiling does not emulate a physical 8 GiB RAM or VRAM machine. No physical-device audio, power or weaker-GPU claim follows from this result. The full goal remains active.
