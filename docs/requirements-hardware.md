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

Physical minimum and recommended tiers remain unverified. See [verification status](release-readiness.md) and [hardware testing](weak-hardware-testing.md).
