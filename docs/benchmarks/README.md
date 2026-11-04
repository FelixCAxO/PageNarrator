# Benchmarks

Run `npm run test:benchmarks` to check the harness and website layout. Use the [benchmark protocol](protocol.md) for performance and quality measurements, and the [hardware guide](../weak-hardware-testing.md) for device qualification.

## Measure Kokoro

1. Run `npm run test:models` to download pinned fixtures.
2. Run `node tooling/scripts/benchmarks/kokoro.mjs --help`. Choose WASM or WebGPU, streaming or batch, and an output file.
3. For Windows GPU comparisons, set `PN_GPU_ADAPTER_LUID` and `PN_GPU_VENDOR`. To hold the Chromium version fixed, set `PN_BENCHMARK_CHROMIUM`.
4. Run cold and warm measurements separately. Compare raw float32 PCM, inputs, and chunks before interpreting performance. Record worker and GPU cleanup.

## Check speech quality

Use `node tooling/scripts/probe-kokoro-quality.mjs --help`. Freeze the corpus, voices, models, and oracle before inference. Use the validation partition for development and reserve unseen material for final evaluation. The [listening guide](../voice-listening-qa.md) covers independent review.

Keep reports in ignored `artifacts/`. Use the pinned requirements files in `tooling/scripts/benchmarks/` for Python analysis. Run comparisons serially with automated audio muted. Record rendered PCM and audible output separately. Device loopback requires an explicitly selected isolated output.

## Profile reader memory

Run `npm run profile:memory` for retained JavaScript heap and process RSS. The harness forces garbage collection around each step. Use `PN_MEMORY_PROFILE_PARAGRAPHS`, `PN_MEMORY_PROFILE_MAX_CHUNK`, and `PN_MEMORY_PROFILE_TARGET_MIN` to vary the workload. Compare identical workloads before and after a change.

Run `npm run test:profiles` for baseline, low-power, long-session, and PDF checks. To refresh the reader baseline intentionally, set `PN_MEMORY_PROFILE_OUTPUT=tests/profiles/baselines/reader-pipeline-memory.json`. Measure temporary peaks separately.
