# Exact OmniVoice runtime A/B

Run from the repository root in PowerShell. Save the baseline **before** changing `src/tts/omnivoice/runtime.js`. By default both arms share all other source files. Engine comparisons can additionally overlay saved `src/engines/` modules as described below. Graph-transform or other shared-module changes require their own isolation and are not covered by this harness.

```powershell
New-Item -ItemType Directory -Force artifacts/omnivoice-micro-20261105 | Out-Null
Copy-Item src/tts/omnivoice/runtime.js artifacts/omnivoice-micro-20261105/baseline-runtime.js
# Make the candidate runtime change, then run serially:
node tooling/scripts/benchmarks/omnivoice.mjs --baseline=artifacts/omnivoice-micro-20261105/baseline-runtime.js --control --output=artifacts/omnivoice-micro-20261105/control.json
node tooling/scripts/benchmarks/omnivoice.mjs --baseline=artifacts/omnivoice-micro-20261105/baseline-runtime.js --output=artifacts/omnivoice-micro-20261105/comparison.json
```

The parent output directory must exist. Reports and scoring plans refuse to overwrite existing names. The default is three warm repeats, configurable with `--warm-repeats=N` before starting measurements. `--candidate=PATH` selects a saved candidate runtime. `--prepare` writes only the pinned plan. Models must already exist at `.cache/engine-models/MarkShark2/omnivoice-onnx-kv-b1-fp16/`, or below `PN_BROWSER_MODEL_DIR`; every model file is verified against the production length and SHA-256 pin. Playwright's Chromium must be installed. Optional `PN_GPU_VENDOR` and `PN_GPU_ADAPTER_LUID` use the existing adapter selection/verification helper.

Measurements acquire the repository measurement lock and run module workers serially in ABBA order. Each worker initializes fresh sessions and runs English female-1 and Swedish male-1 requests, one shape-cold generation followed by three warm generations each: 32 generations total, 12 warm observations per arm. Voices, references, seeds, speed, guidance, diffusion steps, tokenizer, precision and model bytes remain fixed. Shape-cold and initialization observations are kept separately.

Every generation must have identical raw logits hashes for all 48 main passes, non-cache feed hashes, decoder token hashes, complete RNG trace hashes, speaker metadata and raw float32 PCM hashes. Cache shape, type and aliases are checked separately because the empty-cache candidate intentionally changes them. Zero contents are validated by a separate worker command **after** the timing/CPU snapshot, so scanning the larger baseline cache cannot create a false performance gain. GPU validation errors, invalid PCM or failed resource cleanup fail the run.

Adoption requires lower pooled warm browser-process CPU, no more than 5% median warm synthesis latency regression, and lower maximum live GPU-buffer bytes. A/A is a noise control and never an adoption decision. A rejected candidate exits 1; a completed control exits 0. Each report contains raw samples, source/model/harness hashes, adapter/browser/environment evidence, initialization and cleanup results, and the fixed decision rule. Keep rejected and interrupted attempts.

`replayUploadBytes` measures calls to the engine's `write` method, including input uploads, but excludes weight `writeBytes` calls. It is a resource diagnostic, not a GPU bus measurement. Live GPU-buffer bytes are allocated buffer sizes, not physical VRAM residency. CPU/latency include equal development instrumentation (feed/logits/RNG/PCM hashing and CDP observation); they are not product UI latency or audible output latency. Test audio is muted. One host and two short passages cannot establish cross-device gains or all-voice quality. Exact PCM proves parity only for the measured requests.

The empty-cache experiment's status, exact commands, test counts and results are recorded in [the experiment report](../superpowers/plans/2026-11-05-omnivoice-empty-cache.md).

## Engine compute comparisons

Save every engine module that will change into a directory containing only those `.js` files. For the projection-kernel experiment these are `webgpu-compute.js` and `webgpu-shaders.js`. Keep the runtime snapshot even when it remains unchanged.

```powershell
New-Item -ItemType Directory -Force artifacts/omni-compute/baseline-engine | Out-Null
Copy-Item src/tts/omnivoice/runtime.js artifacts/omni-compute/baseline-runtime.js
Copy-Item src/engines/webgpu-compute.js,src/engines/webgpu-shaders.js artifacts/omni-compute/baseline-engine/
# Make the candidate engine changes, then run serially:
node tooling/scripts/benchmarks/omnivoice.mjs --criterion=compute --baseline=artifacts/omni-compute/baseline-runtime.js --baseline-engine-dir=artifacts/omni-compute/baseline-engine --control --output=artifacts/omni-compute/control.json
node tooling/scripts/benchmarks/omnivoice.mjs --criterion=compute --baseline=artifacts/omni-compute/baseline-runtime.js --baseline-engine-dir=artifacts/omni-compute/baseline-engine --output=artifacts/omni-compute/comparison.json
```

Baseline workers import a separate engine module graph whose saved files are overlaid by the local server. Other engine files remain shared and pinned. A/A serves the saved engine files to **both** arms; A/B serves them only to baseline workers. Reports record effective source hashes, harness/scoring/pinning-helper hashes, and observed optimized dispatch labels outside timed CPU observations. All compute cache inputs must also match; zero contents and alias validation remain outside timed samples. Adapter identity must remain the same between arms.

`--criterion=compute` selects a separate, explicit rule: at least 5% lower pooled median warm synthesis latency, a lower median for each voice, at most 5% pooled warm browser-CPU regression, and no increase in peak allocated GPU-buffer bytes. Exact feeds, logits, tokens, RNG, speaker metadata and PCM plus successful cleanup are mandatory. This does not change the earlier cache-transfer rule or its rejected results. Default compute order is ABBAAB, five warm repeats after one shape-cold sample per voice/worker: 72 generations, 30 warm observations per arm. Optional `--warm-repeats=N` is recorded in the plan; choose it before testing.

## Projection microkernel diagnostic

```powershell
node tooling/scripts/benchmarks/omnivoice-matmul.mjs --output=artifacts/omni-compute/kernels.json
```

This separate WebGPU tool compares raw half bits against the unchanged original 16x16 packed kernel (or original half fallback for odd dimensions). Its 34 fixed cases include actual projection shapes, short rows, held-out shapes, batch broadcasts, even/inner tails, the 512-workgroup boundary, all finite half patterns and overflow/cancellation controls. Thirteen inline timing-attribution and bounded-repeat checks run before GPU measurements. The device must support `shader-f16` and `timestamp-query`.

Each case runs an A/A timing control followed by five interleaved ABBA/BAAB pairs. Calibration uses 64 replays, target blocks are 32 ms, and repeat count is bounded by 4096 and an estimated 100 ms wall budget per block. Zero/backward timestamp intervals are invalid; median A/A ratio must be within 5%. Routed dominant/short-row kernels must improve median GPU intervals by at least 5%; other controls may not regress more than 5%. Exact bits are always required. Failure exits 1 and retains raw observations; kernel acceptance is separate from full-synthesis acceptance. Output/scratch allocation bytes are recorded; they do not include physical register/shared-memory residency.

The profile, rejected candidates, accepted default and longer-passage A/B evidence, exact commands and verification counts are recorded in [the profile-driven experiment report](../superpowers/plans/2026-11-05-omnivoice-matmul.md). Performance evidence is from one NVIDIA Blackwell host; other adapters and languages remain unqualified.
