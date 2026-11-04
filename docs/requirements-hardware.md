# Hardware

**Recommended: a dedicated NVIDIA RTX 30 series GPU or newer, with 8 GB+ VRAM and 8 GB+ system RAM.**

Use desktop Chromium 120 or newer. These are recommendations, not verified minimums. Performance depends on the voice, processing mode, and document.

## Choose a voice engine

| Engine | Processing | Download |
| --- | --- | --- |
| Kokoro | WebGPU when available. Slower CPU / WebAssembly fallback. | Missing model and voice files download on first use. |
| OmniVoice | WebGPU with fp16 support. No CPU fallback. Experimental. | About 1.35 GB, separate from Kokoro. |

Advanced settings show the active processing path after reading starts. Cached files work offline for the same voice and mode. Changing either, clearing storage, or browser eviction can require another download.

Some PDF transparency and mask features also need float16 Canvas support. Unsupported features and resource limits return an error; see [PDF limits](browser-engine.md#pdf-resource-limits).

## What has been verified

The current 1.0.3 Kokoro waveform comparisons pass CPU q8/fp32 and NVIDIA/Intel GPU fp32 on both production and original graphs. Each lane covers the same three cases twice, with exact shapes and unchanged numerical limits. These are bounded results on one host; physical hardware tiers and broad listening quality remain unverified. Earlier failed reports and version-specific decisions remain historical evidence in the [release policy](../tooling/config/release-policy.json) and [verification record](release-readiness.md).

Development-host timings and simulated limits do not qualify other devices. The [benchmark record](benchmarks/README.md) keeps the measurements and their scope. Run real-model browser tests and `npm run requirements:tts` for diagnostics; see [hardware testing](weak-hardware-testing.md) for physical-tier acceptance.

## Runtime details

Kokoro runs synthesis in a worker. Eligible isolated hosts with shared memory and four logical threads use three CPU helper workers in one 512 MiB arena. Other hosts use one worker. A helper failure rejects pending work; the next read starts a fresh single-worker engine.

Stop terminates CPU workers. GPU work already submitted can finish before disposal. A GPU call that never settles can block orderly recovery.

Development and packaging are tested with Node.js 26.12.1 and npm 12.2.1. Compatible ranges are 22.23.4–22.x, 24.22.1–24.x and 26.12.1 or newer; see [build instructions](../README.md#build-and-test). Native rebuilds use Zig 0.17.0; ordinary builds use the checked-in binaries.
