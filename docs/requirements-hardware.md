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

Physical hardware tiers and broad listening quality are unverified. Those reviews were waived for v1.0.0 on 2026-10-24. Kokoro duration and PCM reference comparisons still fail their original thresholds; the maintainer accepted that limitation for v1.0.0 on 2026-10-25. See the [release policy](../config/release-policy.json) and [verification record](release-readiness.md).

Development-host timings and simulated limits do not qualify other devices. The [benchmark record](benchmarks/README.md) keeps the measurements and their scope. Run real-model browser tests and `npm run requirements:tts` for diagnostics; see [hardware testing](weak-hardware-testing.md) for physical-tier acceptance.

## Runtime details

Kokoro runs synthesis in a worker. Eligible isolated hosts with shared memory and four logical threads use three CPU helper workers in one 512 MiB arena. Other hosts use one worker. A helper failure rejects pending work; the next read starts a fresh single-worker engine.

Stop terminates CPU workers. GPU work already submitted can finish before disposal. A GPU call that never settles can block orderly recovery.

Development and packaging require Node.js 22.13+ (22.x) or 24+. Native rebuilds use Zig 0.15.2; ordinary builds use the checked-in binaries.
