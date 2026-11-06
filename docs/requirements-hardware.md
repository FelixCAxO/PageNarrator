# Hardware

**Suggested GPU setup: a dedicated GPU with 8 GB+ VRAM (NVIDIA RTX 20 series or newer, or a recent AMD Radeon with WebGPU support) and 8 GB+ system RAM.**

For CPU-only Kokoro, aim for a **modern 6-core CPU or better and 8 GB+ system RAM**. Expect longer startup times and likely pauses between speech segments while audio is generated, especially on slower hardware.

Use desktop Chromium 120 or newer. These are suggested starting points, not verified minimums or guarantees of smooth playback. Performance depends on the voice, processing mode, and document. GPU compatibility also depends on the browser, operating system, and driver; OmniVoice specifically requires WebGPU with fp16 support, which is an [optional WebGPU feature](https://developer.chrome.com/blog/new-in-webgpu-120#support_for_16-bit_floating-point_values_in_wgsl).

## Choose a voice engine

| Engine | Processing | Download |
| --- | --- | --- |
| Kokoro | WebGPU when available. Slower CPU / WebAssembly fallback. | Missing model and voice files download on first use. |
| OmniVoice | WebGPU with fp16 support. No CPU fallback. Experimental. | About 1.35 GB, separate from Kokoro. |

Advanced settings show the active processing path after reading starts. Cached files work offline for the same voice and mode. Changing either, clearing storage, or browser eviction can require another download.

Some PDF transparency and mask features also need float16 Canvas support. Unsupported features and resource limits return an error; see [PDF limits](browser-engine.md#pdf-resource-limits).

Physical minimum and recommended tiers remain unverified. See [verification status](release-readiness.md) and [hardware testing](weak-hardware-testing.md).
