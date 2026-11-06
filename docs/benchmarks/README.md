# Benchmarks

Run `npm run test:benchmarks` to check the harness and website layout. Use the [benchmark protocol](protocol.md) for performance and quality measurements, and the [hardware guide](../weak-hardware-testing.md) for device qualification.

## Measure Kokoro

1. Run `npm run test:models` to download pinned fixtures.
2. Run `node tooling/scripts/benchmarks/kokoro.mjs --help`. Choose WASM or WebGPU, streaming or batch, and an output file.
3. For Windows GPU comparisons, set `PN_GPU_ADAPTER_LUID` and `PN_GPU_VENDOR`. To hold the Chromium version fixed, set `PN_BENCHMARK_CHROMIUM`.
4. Run cold and warm measurements separately. Compare raw float32 PCM, inputs, and chunks before interpreting performance. Record worker and GPU cleanup.

For changes to the quantized CPU recurrent kernel, save the original `kokoro-engine.wasm` before rebuilding, then run:

```powershell
node tooling/scripts/benchmarks/kokoro-recurrent.mjs --baseline path/to/original-kokoro-engine.wasm --output artifacts/recurrent-ab.json
```

This runs identical deterministic inputs through both binaries, checks exact sequence/final-state hashes, and measures process CPU and wall time in counterbalanced order after warmup. Each sample contains 30 replays to reduce Windows CPU-timer quantization. It exits unsuccessfully unless both shapes reduce median CPU by at least 5% without a wall-time regression above 5%. Reports refuse to overwrite an existing file. An A/A control should reject a speedup; use the original binary as both arguments to check noise before changing the kernel.

This stage measures Node's native kernel only. Qualify a candidate separately through the worker benchmark above, with unchanged model pins, browser, voices, text, speed, backend and segmentation. When switching binaries, switch their matching JSON manifests too: a hash mismatch can trigger a serial fallback. Check observed `cpuPoolWorkers` in every sample, as well as the requested backend. Compare raw PCM hashes, native feeds and chunks across arms, not just cold/warm repeats within one arm. Include every attempt, report cold/warm CPU separately, check engine arena peaks, and keep total synthesis claims separate from kernel results.

For the fused Snake activation, capture production operands and original outputs before rebuilding:

```powershell
node tooling/scripts/probe-kokoro-model-cpu.mjs --quick --profile --capture-kernels artifacts/snake-capture --capture-operations pn_kokoro_snake --output artifacts/snake-capture-profile.json
node tooling/scripts/benchmarks/kokoro-snake.mjs --baseline path/to/original-kokoro-engine.wasm --fixtures artifacts/snake-capture/manifest.json --output artifacts/snake-ab.json
```

Run an A/A control first by adding `--candidate path/to/original-kokoro-engine.wasm`; it should reject a speedup. The harness verifies the capture's baseline binary and operand hashes, checks both output hashes against the captured original output, then requires at least 5% lower median CPU time in every captured shape with no wall-time regression above 5%. Each counterbalanced sample has 100 replays. These kernel results require the same separate full-worker qualification described above. The [2026-11-05 experiment report](../superpowers/plans/2026-11-05-tts-compute-followup.md) records accepted and rejected candidates and measurement limits.

For native integer-convolution experiments, first save the current serial WASM
binary and capture frozen production operands/outputs before rebuilding:

```powershell
node tooling/scripts/probe-kokoro-model-cpu.mjs --quick --profile --capture-kernels artifacts/conv-capture --capture-operations pn_kokoro_conv_integer --output artifacts/conv-profile.json
node tooling/scripts/benchmarks/kokoro-conv-integer.mjs --baseline path/to/original-kokoro-engine.wasm --fixtures artifacts/conv-capture/manifest.json --output artifacts/conv-ab.json
```

Use `--candidate path/to/original-kokoro-engine.wasm` for an A/A control. Each
counterbalanced sample contains 30 replays. The harness verifies the frozen
binary/operand/output hashes and requires at least 5% lower median process CPU
in **every** captured shape with no median wall regression above 5%. Native
qualification remains separate from full synthesis. The
[convolution/OmniVoice experiment report](../superpowers/plans/2026-11-05-tts-convolution-omnivoice.md)
records rejected candidates as well as measurements; no candidate from that
experiment qualified for production adoption.

## Check speech quality

Use `node tooling/scripts/probe-kokoro-quality.mjs --help`. Freeze the corpus, voices, models, and oracle before inference. Use the validation partition for development and reserve unseen material for final evaluation. The [listening guide](../voice-listening-qa.md) covers independent review.

Keep reports in ignored `artifacts/`. Use the pinned requirements files in `tooling/scripts/benchmarks/` for Python analysis. Run comparisons serially with automated audio muted. Record rendered PCM and audible output separately. Device loopback requires an explicitly selected isolated output.

## Profile reader memory

Run `npm run profile:memory` for retained JavaScript heap and process RSS. The harness forces garbage collection around each step. Use `PN_MEMORY_PROFILE_PARAGRAPHS`, `PN_MEMORY_PROFILE_MAX_CHUNK`, and `PN_MEMORY_PROFILE_TARGET_MIN` to vary the workload. Compare identical workloads before and after a change.

Run `npm run test:profiles` for baseline, low-power, long-session, and PDF checks. To refresh the reader baseline intentionally, set `PN_MEMORY_PROFILE_OUTPUT=tests/profiles/baselines/reader-pipeline-memory.json`. Measure temporary peaks separately.
