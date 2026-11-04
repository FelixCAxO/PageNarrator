# Voices

Choose an engine in the toolbar popup, then open **Voice settings**.

| Engine | Voices | Requirements |
| --- | --- | --- |
| Kokoro (default) | Ten English voices | WebGPU or CPU / WebAssembly |
| OmniVoice (experimental) | 32 common languages, ten variations per voice type | WebGPU with fp16 and about 1.35 GB of model data |

Models download when you prepare a voice or start reading. Narration stays local. Cached files work offline for the same voice and processing mode. See [hardware requirements](requirements-hardware.md) and [voice licenses](third-party-voice-licenses.md).

## OmniVoice

Choose a language, female or male voice type, a variation, and optional whisper. Variations are ordered by measured acoustic quality within each language and voice type. Saved selections retain their speaker. Cantonese and Thai whisper can omit words. Compare with the text.

Each supported language has its own [fixed speaker references](omnivoice-fixed-voices.md). Previously saved languages outside the picker can use the English reference fallback. Word timing is estimated. Long reads can pause when synthesis falls behind playback.

The adapter in `src/tts/omnivoice/tts.js` uses the pinned browser runtime. A signal check rejects silence, severe clipping, static, and non-finite samples. Recovery keeps the speaker and uses a fresh worker where needed. Stop cancels pending playback and synthesis.

## Kokoro

The catalog lives in `src/tts/voices/voice-registry.js`. `src/lib/kokoro-multilingual.js` handles warmup, inference, and streaming. Voice selection is saved separately from OmniVoice. See [language detection](language-rollout.md#offline-speech-language-detection) for suggestions on non-English pages.

## Verification

Build the extension and download pinned test data with `node tooling/scripts/download-browser-models.mjs --speech`. Set `PN_E2E_OMNIVOICE=1` and run the tests with `npm run test:e2e:local -- <test-file> --project=extension --workers=1`.

- `tests/e2e/omnivoice-read.e2e.js` covers packaged reading and cache reuse.
- `tests/e2e/omnivoice-settings.e2e.js` covers controls, persistence, and changing settings during a read.
- `tests/e2e/omnivoice-continuity.e2e.js` records reference hashes and playback gaps.

Use the [catalog screening workflow](omnivoice-fixed-voices.md#screening) for all presets. Automatic signal, recognition, and identity checks cover different properties. [Independent listening](voice-listening-qa.md) is still required for perceptual claims.
