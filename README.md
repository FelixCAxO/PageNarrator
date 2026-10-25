# PageNarrator

**Recommended: a dedicated NVIDIA RTX 30 series GPU or newer, with 8 GB+ VRAM and 8 GB+ system RAM.**

Read webpages, selected text, and PDFs aloud in Chrome. Speech runs on your device. Follow the highlights, use the transcript, and resume where you stopped. Free. No account or usage quota.

[Build locally](#build-and-test) · [Website](https://pagenarrator.com) · [Support](https://pagenarrator.com/support)

This private repository starts from one initial commit. Previous GitHub releases and tags were removed; build from source for installation.

[Engineering decisions and results](docs/project-architecture.md#engineering-decisions)

Chrome Web Store availability is pending.
Incognito access is disabled while private reading metadata lacks separate storage handling.

![PageNarrator reading an article](docs/cws-listing/screenshot-02-toolbar-player-reading.png)

## Install

1. Follow [Build and test](#build-and-test) to produce the `dist/` folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the `dist/` folder.
4. Open an article, click the PageNarrator toolbar icon, and choose **Read page**.
5. Wait for the first voice download and setup to finish.

For local PDFs, enable **Allow access to file URLs** in the extension's details. Use **Read selected** to hear a highlighted passage. Playback continues when you close the popup.

### Update an unpacked installation

Stop playback. Extract the new release ZIP into a temporary folder, then copy its contents over the **original extension folder**, replacing existing files. Keep that folder's path. Open `chrome://extensions` and click **Reload** on the existing PageNarrator entry, then refresh your reading tabs. Chrome keeps the same extension identity, settings, and saved positions. Cached voices can be reused when their pinned files are unchanged.

For a source build, update the checkout, run `npm ci` and `npm run build`, and reload the existing entry that points to the same `dist/` folder. Removing the extension or clearing its storage deletes local data. See the [reader guide](docs/reader-ui.md#updating).

## Voices and hardware

- **Kokoro:** ten English voices. Uses WebGPU when available, with a slower CPU / WebAssembly fallback.
- **First Kokoro setup:** about 93 MB on CPU or 326 MB on GPU, including one voice. Another voice needs about 0.5 MB. Switching processing mode can download the other model.
- **OmniVoice:** experimental multilingual speech. Requires WebGPU with fp16 support and a separate download of about 1.35 GB. Its 646 upstream language entries have not all been checked for pronunciation or performance.
- **Playback:** 0.5× to 3×, section pauses, reading cleanup, and highlight colors.
- **PDFs:** selectable text and local English OCR. Scan quality and layout affect accuracy. Unsupported formats and resource limits return an error.

Use desktop Chromium 120 or newer. The hardware above is a recommendation, not a verified minimum. See [hardware guidance](docs/requirements-hardware.md), [voice details](docs/multilingual-tts.md), and [PDF limits](docs/browser-engine.md#pdf-resource-limits).

## Privacy

Narrated text stays on your device. Missing voice files download from Hugging Face; the hosts receive your IP address and requested file paths. Cached files work offline for the same voice and processing mode. Switching modes or clearing the cache may require another download.

Online PDFs are fetched from their document host. Resume saves the URL, title, position, and a short text excerpt locally. PageNarrator does not request always-on website access. Highlights leave the page layout intact. See [privacy](https://pagenarrator.com/privacy) and [security](SECURITY.md).

## How it is built

The popup controls an offscreen reader so closing it keeps speech running. Content scripts extract text and draw highlights on demand. Original C++ / WebAssembly and WebGPU engines handle speech, OCR, and PDF processing. Models, dictionaries, fonts, and character maps are third-party data.

Start with the [engineering decisions and measured results](docs/project-architecture.md#engineering-decisions), [reader guide](docs/reader-ui.md), or [engine reference](docs/browser-engine.md).

## Build and test

Use Node.js **22.13+ (22.x) or 24+**:

```sh
git clone https://github.com/FelixCAxO/PageNarrator.git
cd PageNarrator
npm ci
npm run build
```

Load `dist/` through `chrome://extensions`. OCR data and native binaries are checked in; building needs no Git LFS, native compiler, or speech-model download.

```sh
npx playwright install chromium
npm test
npm run lint
npm run typecheck
npm run typecheck:boundaries
npm run test:models
npm run verify:integration
```

`test:models` downloads hash-verified test data into ignored `.cache/kokoro/`. The full `verify:release` gate also needs private PDF reference files. Run validation locally; non-deployment GitHub Actions are prohibited. See [contributing](CONTRIBUTING.md) and [verification status](docs/release-readiness.md).

## Package and license

`npm run package` builds the extension ZIP and matching source ZIP in `releases/`. Distribute **both ZIPs together**. Native rebuilds use Zig 0.15.2; see [build instructions](docs/browser-engine.md#reproduction).

Copyright (c) 2026 Felix Olsson. Original code: [GPL-3.0-or-later](LICENSE). Retained UK pronunciation data: GPL-3.0-only, making the combined distribution GPL version 3. Other data keep their own licenses. See [third-party licenses](docs/third-party-voice-licenses.md) and [packaged notices](public/legal/THIRD_PARTY_NOTICES.txt).

The separate support mailbox is `website/workers/support-mailbox.js`. See [setup](docs/support-mailbox.md) to reply as `support@pagenarrator.com`.
