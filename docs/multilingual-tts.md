# Voices

Choose an engine in the toolbar popup, then open **Voice settings**.

| Engine | Voices | Requirements |
| --- | --- | --- |
| OmniVoice | Built-in voices in 32 languages | WebGPU with fp16 and about 1.35 GB of model data |
| Kokoro | Ten English voices | WebGPU or CPU / WebAssembly |
| OmniVoice Voice Cloning | Personal presets with the same 32 reading languages | OmniVoice requirements and about 654 MB for the encoder on first import |

Models download when you prepare a voice or start reading. Narration stays local. Cached files work offline for the same voice and processing mode. See [hardware requirements](requirements-hardware.md) and [voice licenses](third-party-voice-licenses.md).

OmniVoice is the initial choice on devices with WebGPU and fp16. Kokoro is the initial choice on other devices. Saved engine choices are kept.

## OmniVoice

OmniVoice narration and voice cloning use pretrained weights that k2-fsa publishes under CC BY-NC. Commercial use of those weights requires separate permission from the rights holders. [Voice licenses](third-party-voice-licenses.md#experimental-omnivoice).

Choose a language, a female or male voice, and optional whisper. If a saved preset has retired, PageNarrator selects the default for that language and voice type. Cantonese and Thai whisper can omit words. Compare with the text.

Each supported language has its own [fixed speaker references](omnivoice-fixed-voices.md). Previously saved languages outside the picker can use the English reference fallback. Word timing is estimated. Long reads can pause when synthesis falls behind playback.

The adapter in `src/tts/omnivoice/tts.js` uses the pinned browser runtime. A signal check rejects silence, severe clipping, static, and non-finite samples. Recovery keeps the speaker and uses a fresh worker where needed. Stop cancels pending playback and synthesis.

## Kokoro

The catalog lives in `src/tts/voices/voice-registry.js`. `src/lib/kokoro-multilingual.js` handles warmup, inference, and streaming. Voice selection is saved separately from OmniVoice. See [language detection](language-rollout.md#offline-speech-language-detection) for suggestions on non-English pages.

## OmniVoice Voice Cloning

Choose **Clean up background noise** to run Sidon locally on a recorded or imported clip. Cleanup trims quiet space at the start and end while keeping at least three seconds of audio. It requires WebGPU with fp16 and downloads about 493 MB on first use. Listen to the cleaned clip before saving or choose **Use original clip**. If cleanup fails, the original clip remains available.

Open **Manage personal voices** and choose the recording language. Select **Record a clip** and read the displayed prompt in your normal voice. After recording, play back the clip and edit the filled-in transcript if you said something different. For an imported audio file, enter the words yourself. Use 3–10 seconds of clear speech. Audio files can be up to 20 MB. Save a named preset, preview it, then select **Use for reading**.

The extension keeps the preset name, recording language, transcript, and encoded voice locally. It releases the original file after import. Delete a preset from **Manage personal voices**.

## Verification

Build the extension and download pinned test data with `node tooling/scripts/download-browser-models.mjs --speech`. Set `PN_E2E_OMNIVOICE=1` and run the tests with `npm run test:e2e:local -- <test-file> --project=extension --workers=1`.

- `tests/e2e/omnivoice-read.e2e.js` covers packaged reading and cache reuse.
- `tests/e2e/omnivoice-settings.e2e.js` covers controls, persistence, and changing settings during a read.
- `tests/e2e/omnivoice-continuity.e2e.js` records reference hashes and playback gaps.

Use the [catalog screening workflow](omnivoice-fixed-voices.md#screening) for all presets. Automatic signal, recognition, and identity checks cover different properties. [Independent listening](voice-listening-qa.md) is still required for perceptual claims.
