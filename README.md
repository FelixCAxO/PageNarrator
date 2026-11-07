# PageNarrator — Private Text-to-Speech for Webpages and PDFs

Free, open-source text-to-speech (TTS) extension for Chrome and desktop Chromium browsers. Read webpages, selected text, and PDFs aloud with on-device AI voices.

> **Hardware recommendations:** on-device AI speech benefits from a dedicated GPU with **8 GB+ VRAM** (NVIDIA RTX 20 series or newer, or a recent AMD Radeon with WebGPU support) and **8 GB+ system RAM**. For CPU-only Kokoro, aim for a **modern 6-core CPU or better** and **8 GB+ system RAM**; expect longer startup times and likely pauses between speech segments while audio is generated. OmniVoice requires a GPU with WebGPU and fp16 support.
>
> These are suggested starting points; minimum specs and smooth playback at these specs have not been verified. See [hardware recommendations](docs/requirements-hardware.md).

[Download v1.0.4](https://github.com/FelixCAxO/PageNarrator/releases/download/v1.0.4/pagenarrator-1.0.4.zip) · [Source ZIP](https://github.com/FelixCAxO/PageNarrator/releases/download/v1.0.4/pagenarrator-1.0.4-source.zip) · [Website](https://pagenarrator.com) · [Support](https://pagenarrator.com/support)

Independent listening reviews, physical hardware qualification, and valid timing measurements on lower-spec devices remain open for v1.0.4. [Verification report](https://github.com/FelixCAxO/PageNarrator/releases/download/v1.0.4/pagenarrator-1.0.4-verification.md)

- **Private and offline:** narration stays on your device. Cached voices work offline until the cache is cleared or evicted.
- **Free without quotas:** no account, subscription, or usage quota.
- **Read along and resume:** synchronized word highlights, transcript navigation, saved positions, and 0.5×–3× speed. Playback continues when you close the popup.
- **PDFs, including scans:** read online and local PDFs. Scans use local English OCR; accuracy depends on scan quality and layout.
- **Voice choice:** ten English Kokoro voices, plus experimental OmniVoice speech in 32 languages.

![PageNarrator text-to-speech player reading a webpage with synchronized highlighting](docs/cws-listing/screenshot-02-toolbar-player-reading.png)

## Install

1. Download and extract the extension ZIP above.
2. Open your browser's Extensions page (`chrome://extensions`, `edge://extensions`, or `brave://extensions`) and enable **Developer mode**.
3. Choose **Load unpacked** and select the folder containing `manifest.json`.
4. Open a webpage, click PageNarrator, and choose **Read page**. Wait for the first voice download and setup.

For local PDFs, enable **Allow access to file URLs** in the extension's details. [Reader guide and updates](docs/reader-ui.md).

Chrome Web Store availability is pending. Incognito is disabled.

## Browser and hardware support

Requires desktop Chromium 120+. Edge, Brave, Opera, and Vivaldi compatibility is expected but not separately verified; automated browser tests use Chromium.

Kokoro supports WebGPU and a slower CPU fallback. OmniVoice requires WebGPU with fp16 and a separate ~1.35 GB download. See [hardware recommendations](docs/requirements-hardware.md) and [voice details](docs/multilingual-tts.md).

## Privacy

Voice downloads send Hugging Face your IP address and file requests. Narration and resume data stay local. Online PDFs load from their host. PageNarrator does not request always-on website access. [Privacy policy](https://pagenarrator.com/privacy) · [Security](docs/SECURITY.md).

## Repository map

| Folder | What lives here |
| --- | --- |
| [src/](src/) | Extension UI, reading, speech, and PDF code |
| [extension/](extension/) | Chrome manifest, runtime assets, translations, and icon artwork |
| [engines/](engines/) | Native sources, reference binaries, and vendored data |
| [tooling/](tooling/) | Build, release, benchmark, and maintenance tools |
| [tests/](tests/) | Test suites and fixtures |
| [website/](website/) | Website templates, translations, generated pages, and Cloudflare config |
| [docs/](docs/) | Architecture, guides, [changelog](docs/CHANGELOG.md), and release documentation |

## Build and test

Use Node.js **26.12.1** with **npm 12.2.1**. `.nvmrc` selects the tested Current release; update npm with `npm install --global npm@12.2.1`.

The supported ranges are 22.23.4–22.x, 24.22.1–24.x and 26.12.1 or newer, matching the dependency engine requirements. Build locally:

```sh
npm ci
npm run build
```

Load `dist/` as an unpacked extension.

| Command | Purpose |
| --- | --- |
| `npm test` | Run the unit suite |
| `npm run verify:fast` | Run the local verification gate |
| `npm run preview` | Build and launch the extension in a local browser |
| `npm run build:website` | Regenerate localized pages and stage the site |
| `npm run package` | Build the extension and matching source ZIPs |

See [contributing and tests](docs/CONTRIBUTING.md), [architecture](docs/project-architecture.md), and [release notes](https://github.com/FelixCAxO/PageNarrator/releases/tag/v1.0.4).

Original code: [GPL-3.0-or-later](LICENSE); combined distribution: GPLv3. Keep [third-party notices](extension/public/legal/THIRD_PARTY_NOTICES.txt) and distribute the matching source ZIP with the extension. [License details](docs/third-party-voice-licenses.md).

[Support mailbox setup](docs/support-mailbox.md) to reply as `support@pagenarrator.com` (`website/workers/support-mailbox.js`).
