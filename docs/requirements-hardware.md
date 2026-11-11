# Hardware

**A dedicated GPU is recommended for multilingual voices and voice cloning.** These features require WebGPU with fp16 support. Compatible integrated GPUs may work, but performance has not been verified.

The suggested 8 GB+ VRAM and 8 GB+ system RAM setup is provisional, not a tested minimum.

For CPU-only Kokoro, aim for a **modern 6-core CPU or better and 8 GB+ system RAM**. Expect longer startup times and likely pauses between speech segments while audio is generated, especially on slower hardware.

Use desktop Chromium 120 or newer. These are suggested starting points, not verified minimums or guarantees of smooth playback. Performance depends on the voice, processing mode, and document. GPU compatibility also depends on the browser, operating system, and driver; OmniVoice specifically requires WebGPU with fp16 support, which is an [optional WebGPU feature](https://developer.chrome.com/blog/new-in-webgpu-120#support_for_16-bit_floating-point_values_in_wgsl).

## Choose a voice engine

| Engine | Processing | Download |
| --- | --- | --- |
| Kokoro | WebGPU when available. Slower CPU / WebAssembly fallback. | Missing model and voice files download on first use. |
| OmniVoice | WebGPU with fp16 support. No CPU fallback. Experimental. | About 1.35 GB, separate from Kokoro. |
| OmniVoice Voice Cloning | Uses the same OmniVoice reader and a separate encoder for imports. | About 654 MB on first import, in addition to the OmniVoice reader model. |

Advanced settings show the active processing path after reading starts. Cached files work offline for the same voice and mode. Changing either, clearing storage, or browser eviction can require another download.

Some PDF transparency and mask features also need float16 Canvas support. Unsupported features and resource limits return an error; see [PDF limits](browser-engine.md#pdf-resource-limits).

Physical minimum and recommended tiers remain unverified. See [verification status](release-readiness.md) and [hardware testing](weak-hardware-testing.md).

## Use a dedicated GPU on Windows

PageNarrator's **Processing** setting selects WebGPU or CPU processing. For WebGPU, Chromium uses the GPU assigned to the browser. [Chrome WebGPU documentation](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips#windows-specific-limitations)

1. Open **Settings → System → Display → Graphics** in Windows and select your browser. If it is missing, add it as a desktop app. In Chrome, `chrome://version` shows the executable path.
2. In **Options**, choose **High performance** and check that Windows lists your dedicated GPU. Select **Save**. [Windows graphics settings](https://support.microsoft.com/en-au/windows/hardware/display-graphics/optimizations-for-windowed-games-in-windows-11)
3. Fully quit and reopen your browser. Open `chrome://gpu` and check that WebGPU is hardware accelerated and the dedicated GPU is marked **ACTIVE** under **Driver Information**.
