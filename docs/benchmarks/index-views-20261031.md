# Identity indexing and bounded execution-plan reuse

This follows the [FP16 sampling experiment](logit-sampling-20261031.md). The baseline already includes that change and the earlier model-loading, packed-matrix and gate optimizations. It uses the same pinned models, graph correction, diffusion steps, sampler and decoder as the candidate.

## Remove copies that do not change data

A read-only first-pass profile found 112 identity `Slice` copies in each OmniVoice main inference. They copy complete `[1, 8, sequence, 128]` FP16 tensors without changing their order. The decoder also has one singleton-axis transpose that preserves linear order.

`executeIndexNode` now uses the existing tensor-view helper for GPU/compute tensors when the validated index plan starts at zero, covers every input element, and has contiguous strides on every non-singleton axis. Real transposes, subsets, offsets, reverse slices and stepped slices still execute the original indexing operation. CPU metadata handling and attribute validation are unchanged.

This optimization belongs to immutable ONNX operations. The low-level `batch.index` still makes a copy: Kokoro's `ScatterND` uses it to obtain writable storage. Globally aliasing that helper would corrupt inputs. Tests cover that distinction, public output independence, changing replay inputs and cleanup.

For the profiled English request, the two retained main plans fall from 66.44 to 33.76 MiB, a 49.2% reduction. Each main pass removes 112 copy dispatches; the graph still selects 4,505 nodes. At the measured conditional/unconditional sequence lengths of 259/77, 24 steps avoid 1.723 GiB of logical copied payload, or 3.445 GiB counting both reads and writes. These are calculated operation bytes, not measured off-chip bandwidth, power, total VRAM or RAM savings.

## A/B caught a cache regression

The initial view-only candidate preserved all speech bytes, but repeated long-paragraph comparisons were slower. The original conditional plan exceeded the existing 128 MiB shared cache budget, leaving the unconditional plan reusable. After copy removal, either plan fit individually but both together still exceeded the budget. Admitting each new plan evicted the preceding one, so neither was reused during alternating conditional/unconditional diffusion passes.

Cache admission now preserves a retained plan used by the immediately preceding inference when it cannot coexist with the new plan. The uncached pass still runs and releases its temporary storage. A change to new shapes can replace the old plan once that old plan was not the preceding inference. Consecutive new requests can also replace it. The default single-plan cache and the 128 MiB budget stay unchanged. A native WASM regression exercises alternating requests, changed feed values, two replacement shapes, consecutive replacement, budget enforcement and complete disposal.

The view-only intermediate was 14.0% slower for the first long request and 10.8% slower for its continuation, using the median of four paired percentage differences. Its final unconditional pass was rebuilt in every trial. Those failed results remain in `index-only-long-speech-results.json`; they are not counted as the final candidate.

## Packaged speech A/B

Each row below has four counterbalanced baseline/candidate pairs. Complete speech-request wall time excludes model initialization. The first two rows reuse the multilingual packaged parity workload; the long rows use a fresh worker for the 24-step request, followed by the same long text with the reader's existing 12-step continuation policy. The long clip contains 19 seconds of audio.

| Request | Baseline median | Candidate median | Paired median reduction | Paired reduction range |
| --- | ---: | ---: | ---: | ---: |
| Short English, first / 24 steps | 2040.7 ms | 1999.8 ms | 1.50% | 1.27–4.19% |
| Short English, following / 12 steps | 1095.0 ms | 1076.8 ms | 1.56% | 1.08–2.22% |
| Long English, first / 24 steps | 5164.3 ms | 4771.5 ms | 7.54% | 1.24–10.42% |
| Long English, following / 12 steps | 2508.0 ms | 2406.1 ms | 3.85% | −0.40–10.49% |

All 17 packaged parity pairs match exactly in raw float32 PCM, length, sample rate and speaker identity. They include five languages, a changed variation, male Hindi whisper, runtime disposal/recovery and the longer text. The separate long-passage cohort adds eight exact pairs. Kokoro's eight CPU/GPU cold/warm controls also preserve raw PCM, token/style/speed feeds and source chunks against the preceding verified regression.

Timing variation is material, especially for the long continuation. Cache contents depend on the preceding shapes: the policy preserves a recently used plan and does not promise to select the most expensive plan. The long request after the multilingual sequence improved only 1.1% in its single pair. These measurements do not establish a universal reading-speed gain, measured GPU time, bandwidth, power or energy savings.

## Native CPU and browser commitment comparison

A separate four-pair cohort runs the same two long requests under the native Windows browser job, with a 6 GiB commitment ceiling for both variants. Each run creates a fresh worker, synthesizes 24 steps and then 12 steps, and disposes it. All eight request pairs retain the same PCM as the preceding long-request cohort. Native accounting verifies process membership and includes child processes that exit during measurement. Both variants use the same native/CDP launch; compare timings within this cohort, not across launch methods.

| Native accounting metric | Baseline median | Candidate median | Paired result |
| --- | ---: | ---: | ---: |
| Combined CPU, two requests | 5.664 CPU s | 5.273 CPU s | 7.39% median reduction |
| Whole-run browser commitment peak | 5.189 GiB | 4.916 GiB | 274.4 MiB median saving |
| First-request completion | 5873.6 ms | 5720.7 ms | 2.30% median reduction |
| Following-request completion | 2931.0 ms | 2893.7 ms | 1.70% median reduction |

All four commitment peaks improve, with paired savings of 231.4–350.7 MiB. This is an enforced browser-job commitment measure, not resident physical RAM or dedicated GPU memory. Peak accounting includes initialization and the two requests through their final observation.

CPU accounting sums job user and kernel time around synthesis, including renderer/worker work, GPU-process host work, request transport, PCM hashing and diagnostics. It excludes initialization, the controller and local fixture server. It does not measure GPU execution or energy. Combined CPU results range from **1.8% worse to 22.6% better**, with three of four pairs improving; the last baseline first request is an outlier. One candidate continuation uses 17.9% more CPU than its pair. The CPU median is preliminary evidence, not a stable reduction across workloads. Raw counters and process coverage are retained in `long-speech-resources.json`.

## Evidence and limits

Evidence lives in `artifacts/index-views-20261031/`. It retains the baseline package and source, first-pass index profiles, the failed view-only timing experiment, exact WAV/PCM controls and subsequent verification logs. All automated output is muted; render-thread captures do not measure physical audio-device latency.

`summary.json` verifies the paired hashes, native accounting coverage and final source snapshots before deriving the tables. Reproduce the native primitives and speech comparison with the pinned local model fixtures, Node toolchain and a freshly verified adapter LUID:

```powershell
$env:PN_GPU_ADAPTER_LUID = '<verified-high,low-LUID>'
$env:PN_GPU_VENDOR = 'nvidia' # Use intel for the Intel primitive lane.
node scripts/benchmarks/inference-kernels.mjs --output=artifacts/<new-kernel-report.json>
$env:PN_E2E_MEMORY_PARITY = '1'
$env:PN_E2E_WORKERS = '1'
$env:PN_PARITY_TRIALS = '4'
$env:PN_PARITY_BASELINE = '<pre-change-packaged-extension>'
$env:PN_PARITY_CANDIDATE = 'dist'
$env:PN_PARITY_OUTPUT = 'artifacts/<new-speech-directory>'
node node_modules/playwright/cli.js test tests/e2e/omnivoice-memory-parity.e2e.js --project=extension --reporter=line
```

The artifact-local `long-speech-unlimited.mjs`, `long-speech.mjs`, `kokoro-control.mjs` and `summarize.mjs` retain the additional experiment procedures. The existing sustained harness and waveform analyzer reproduce the five-minute read using the environment variables documented in the [memory experiment](ram-verification-20261031.md).

The 1,462 engine, TTS and reader tests, strict and boundary type checks, changed-file lint and production build pass. Nineteen native WebGPU primitive controls pass on both NVIDIA and Intel, including all finite FP16 encodings, signed zeros/subnormals, odd FP16 lengths, float32/int32 views, empty tensors, replay updates and independent writable copies. The five new view controls allocate no GPU output buffers and issue no copy dispatch; a zero-work view has no GPU timestamp measurement.

The final package also passes a five-minute varied-paragraph read with streamed render capture under an enforced 6 GiB browser-job commitment ceiling:

| Playback and memory observation | Result |
| --- | ---: |
| Observation | 301.3 s |
| Completed chunks / prepared event handoffs | 38 / 38 |
| Complete clips aligned in render output | 38 |
| Unprepared waits | 0 |
| Added render gap, p95 / maximum | 13.3 / 13.3 ms |
| Minimum source/capture correlation | 0.99999986 |
| Precise browser-job commitment peak | 4.731 GiB |
| Native accounting observations | 65 |

The render analysis covers 37 boundaries between complete clips. Stop returns the controls to ready and cleanup passes. The peak includes initialization and playback through the last pre-export observation; it is commitment rather than resident RAM, and excludes the controller and fixture server. This shorter run cannot establish a peak-memory improvement over the preceding ten-minute run or rule out long-session growth.

Current hardware is the development Core Ultra 9 / RTX 5090 host. Native primitive controls additionally run on Intel Xe-LPG. A browser-job commitment ceiling does not emulate a physical 8 GiB RAM/8 GiB VRAM PC. Weaker dedicated-GPU performance, physical audio routing and the wider PDF/OCR acceptance matrix remain open.
