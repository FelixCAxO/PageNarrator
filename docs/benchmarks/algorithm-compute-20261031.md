# Inference algorithm A/B — 2026-10-31

The candidate reduces repeated tensor work and accelerates FP16 matrix multiplication. On this development host, paired full OmniVoice synthesis is about 26% faster for English and 29% faster for Swedish, with identical PCM and diffusion codes. A packaged playback capture also passes continuity checks. The broader goal of smooth reading on 8 GiB PCs and weaker dedicated GPUs remains active and unverified.

## Calculations changed

1. **Load two half values per word.** The packed MatMul kernel reads two FP16 values with one 32-bit access, converts them to FP32, and keeps the original accumulation order. Outputs use native FP16 conversion and packed stores. Odd inner/output dimensions retain the existing kernel; FP32 inference retains its kernel. No weights or precision policy change.
2. **Fuse the feed-forward gate.** Three kernels become one. Intermediate FP16 rounding is retained explicitly:

   ```text
   s = round16(sigmoid(x))
   a = round16(x × s)
   y = round16(a × up)
   ```

   This removes intermediate memory traffic and two dispatches per gate. Equal-shape temporary storage halves in the kernel diagnostic.
3. **Remove FP16 → FP32 → FP16 round trips.** Widening an existing half value and narrowing it back adds no precision. The optimizer retains the original named output as an alias. It preserves lossy FP32 → FP16 conversions and the corrected FP32 normalization calculations.
4. **Reuse identical casts and shape queries.** Matching operations on the same input share their result. Named outputs, input updates, output ownership and execution-plan replay remain covered by tests.

The main graph has 28 feed-forward gates and 56 removable half round trips. Repeated transforms also account for 164 Cast and 197 Shape duplicates before dependency pruning. The selected main plan decreases from 4,644 to 4,505 nodes; aliases still count as nodes. Two cached plans for the frozen English/Swedish requests retain about 9.9/10.7 MiB less storage.

## Paired speech results

Three baseline/candidate pairs per language alternate execution order. Each uses the same pinned local model, tokenizer, text, seed, speed and complete 24-step bidirectional diffusion. Profiles are fresh; later diffusion steps reuse the two bounded execution plans.

| Frozen request | Audio duration | Baseline median | Candidate median | Paired median change | Candidate median RTF |
| --- | ---: | ---: | ---: | ---: | ---: |
| English | 3.08 s | 3.332 s | 2.469 s | −25.8% | 0.802 |
| Swedish | 3.16 s | 3.400 s | 2.430 s | −29.7% | 0.769 |

Every candidate repetition stays ahead of its audio duration, with observed RTF 0.755–0.837. All twelve clips have identical raw PCM, WAV and diffusion-code hashes within each language. These short, fixed requests are diagnostics; they do not establish sustained performance on other hardware.

A separate packaged worker comparison passes all 24 samples, including cloned voices, English, Swedish, Hindi, Arabic, Japanese, whisper, variation changes and fresh initialization. Every paired PCM hash and speaker identity matches. The existing continuation policy uses 12 steps for some same-speaker requests; baseline and candidate use the same request in each pair. Historical reference-tensor, ASR and listening acceptance results are unchanged.

## GPU kernel evidence

The first conditional main-graph profile attributes about 80% of its summed timestamp intervals to matrix multiplication. Profiling adds pass boundaries and is used to locate work, not to qualify end-to-end timing.

The reproducible kernel check uses five alternating pairs of repeated dispatches. Representative main-graph matrix cases show these median GPU-time reductions against the original scalar half kernel:

| Kernel / shapes | NVIDIA RTX 5090 | Intel Xe-LPG |
| --- | ---: | ---: |
| Q/K/V projection, 192×1024×2048 | 31% | 21% |
| Feed-forward up, 320×1024×3072 | 18% | 20% |
| Feed-forward down, 320×3072×1024 | 30% | 20% |
| Attention, 16 batches of 192×128×192 | 25% | 18% |
| Fused gate, 320×3072 elements | 83% | 61% |

Native GPU checks cover every finite FP16 input for the gate, half widening/narrowing, and a MatMul conversion control. Larger random matrix cases, broadcasting, even/odd tails and the odd-dimension fallback also retain exact bits. This does not exhaust every possible matrix combination or GPU implementation.

GPU timestamps measure command intervals, not device power or energy. Short cases are quantized and noisy; timing conclusions use the larger cases. See the [WebGPU timestamp-write definition](https://www.w3.org/TR/webgpu/#dictdef-gpucomputepasstimestampwrites).

Rejected experiments remain in the local evidence directory: 32×32 scalar/vector tiles and alternative inner-tile sizes did not give a portable improvement. `pack2x16float`/`unpack2x16float` changed bits in the diagnostic; explicit native FP16 conversions passed. A padded shared-memory layout also failed to improve the main NVIDIA cases and was not promoted. No vendor-specific policy or runtime autotuning was added.

## Playback and memory

The packaged reader starts on OmniVoice, switches to Kokoro and back, then exercises pause/resume, 3× playback advancement, stopping an incoming engine and restart. Capture is muted and taken from an AudioWorklet with a non-rendering sink.

Ten complete 1× chunks span 77.25 seconds of rendered speech. Source-wave cross-correlation is at least 0.99865. All nine handoffs are prepared; no unprepared waits or dropped-frame warnings are recorded. Added render gaps are 5.3–15.7 ms, with p95 14.7 ms. Playback-event gaps peak at 7.5 ms. The continuity result covers the captured 1× reading and engine switches; it does not claim gap-free 3× reading or OS/device output.

Sampled browser-process peaks across that test:

| Resource | Peak |
| --- | ---: |
| Private committed memory | 6.26 GiB |
| Unique resident memory | 3.77 GiB |
| Dedicated GPU memory | 3.14 GiB |
| Shared GPU memory | 0.17 GiB |

There are 1,019 RAM and 226 complete GPU samples, with no sampler errors. These exclude controller/model-server memory and other applications. Sampling can miss short spikes; shared GPU memory may overlap other memory accounting and is not added to resident RAM. Private commitment is not physical residency. The host reports 63.27 GiB RAM and has a 32 GiB RTX 5090, so these numbers do not qualify an 8 GiB system or prove that 8 GiB VRAM is a minimum.

## Validation and reproduction

- 959 engine/TTS tests pass; both type checks, changed-file lint and the production build pass.
- 64 native GPU parity cases pass on NVIDIA and another 64 on Intel, with cleanup.
- Eight original Kokoro cold/warm CPU/GPU clips retain the earlier baseline's exact PCM, model feeds and chunks.
- Packaged multilingual parity and muted playback/control tests pass. Source-wave analysis passes independently of playback events.

Run the GPU correctness/timing diagnostic on a selected, verified adapter:

```text
node scripts/benchmarks/inference-kernels.mjs --output=artifacts/<new-report>.json
```

It requires `shader-f16` and `timestamp-query`, uses the measurement lock, pins sources, checks exact bits and cleanup, and refuses to overwrite a report. Set the current adapter variables described in [README.md](README.md); DXGI LUIDs can change.

Evidence is in ignored `artifacts/algorithm-compute-20261031/`: source snapshots, rejected variants/logs, timestamped operator profiles, paired source-runtime trials, baseline/candidate extension builds, packaged voice PCM comparisons, waveform capture, process/GPU samples, `summary.json` and validation logs. The baseline retains the previous [resource optimizations](compute-cost-20261031.md), isolating this algorithm change. The packaged harness seeds test settings and uses verified local fixtures; this is not clean-install or representative hardware acceptance.

The first paired-run wrapper incorrectly expected the speech producer's status to be `pass` rather than its deliberate `review-required`; only that wrapper assertion was corrected. The older packaged parity listener also treated synthesis-progress notifications as completed replies; it now matches the production client's filtering. A partially switched test source copy during packaging was detected, restored from verified snapshots and rebuilt using serialized atomic replacement. Failed attempt logs/traces remain preserved.

Remaining goal work: sustained long reading and memory behavior under constrained RAM, representative weaker dedicated GPUs, physical 8 GiB hardware, and real device-output continuity. The measured 6.26 GiB private commitment makes cold-load verification and staging memory a useful next target; reducing GPU work alone does not establish the whole-machine budget.
