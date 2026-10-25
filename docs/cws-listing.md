# Chrome Web Store Listing

## Short description

Read webpages and PDFs aloud with local on-device voices and synchronized highlighting.

The dashboard has no summary field: it shows the packaged `manifest.json` description, so change both together and rebuild. `tests/ci/launch-docs.test.js` keeps them identical.

## Full description

**Recommended: a dedicated NVIDIA RTX 30 series GPU or newer, with 8 GB+ VRAM and 8 GB+ system RAM.**

PageNarrator is a free reader for Google Chrome™. Read webpages, selected text, and PDFs aloud on your device. No account or usage quota.

- Ten English Kokoro voices.
- Experimental multilingual OmniVoice, with voice variations and whisper mode.
- Highlights, transcript navigation, and saved reading position.
- Playback from 0.5× to 3×, reading cleanup, and section pauses.
- Scanned PDFs use local English OCR. Accuracy depends on scan quality and layout.

Use the toolbar player for setup and playback. Closing it keeps speech running. Access restrictions and paywalls are not bypassed.

Missing voice files download from Hugging Face and its delivery hosts. They receive your IP address and requested file paths, not narration text. OmniVoice's separate download is about 1.35 GB. Cached files work offline for the same voice and processing mode, including after a restart. Changing either, clearing storage, or browser eviction may require another download.

PageNarrator does not receive reading content, URLs, or browsing history for narration. Resume saves page and PDF URLs, titles, positions, and a short text excerpt locally. Online PDFs are fetched from their document host.

Kokoro supports WebGPU and a slower CPU / WebAssembly fallback. OmniVoice requires WebGPU with fp16 support. Physical hardware tiers and broad listening quality are unverified. Experimental language quality varies.

JavaScript, WebAssembly, and model runtime code ships inside the extension package. English OCR files are included.

Google Chrome is a trademark of Google LLC. Use of this trademark is subject to Google Permissions. PageNarrator is independent and is not affiliated with or endorsed by Google.

## Media

Run `npm run capture:cws-media` in an isolated Linux container with a 1280×880 Xvfb display, Openbox, and ImageMagick, explicitly selecting the extracted release through `PN_E2E_EXTENSION_DIR`. Capture the actual browser and toolbar popup directly from the X11 display, then crop the 80-pixel tabs/address bar: no composites, generated frames, resizing, or DOM/CSS layout changes. The capture command does not rebuild the extension. Its disposable copy adds local-server and tab-metadata permissions for automation; the release files remain unchanged.

The website and store previews show owned demo content and actual extension controls.
The local capture fixture `website/public/cws-demo.html` is excluded from the
website deployment by `npm run build:website`; `noindex` alone does not make a page private.
`docs/cws-listing/capture-provenance.json` records capture versions, source hashes,
image hashes, and visible controls. Recapture the native browser display when these
inputs change; never relabel an older capture as a new build. Store submission and
website deployment require separate verification.

Project media uses owned demo content. For this repository, CWS screenshots must not include install CTAs, Add to Chrome buttons, Chrome Web Store listing text, or acquisition-page copy. The 440x280 promo tile is intentionally unbadged. Upload only the extension UI screenshots and promo tile:

- `docs/cws-listing/screenshot-01-toolbar-player-idle.png`
- `docs/cws-listing/screenshot-02-toolbar-player-reading.png`
- `docs/cws-listing/screenshot-03-toolbar-player-settings.png`
- `docs/cws-listing/screenshot-04-toolbar-player-pdf.png`
- `docs/cws-listing/screenshot-05-omnivoice-controls.png`
- `docs/cws-listing/promo-tile-440x280.png`

## Reviewer steps

1. Install the single `pagenarrator-<version>.zip` artifact.
2. With an internet connection, open an article and choose Prepare voice or Read page. Allow the initial model download and preparation to finish. After success, verify the same voice and processing mode work with cached files offline; clearing the cache makes a new download necessary.
3. Verify voice selection, 3× speed, highlighting, reading cleanup, section pauses, and resume state.
4. Open a text-based PDF and verify reading, selected text, zoom, rotate, fit, highlighting, and transcript navigation.
   Also open a clear English scanned PDF and verify local OCR, allowing time for recognition and checking the result against the image.
5. Confirm every built-in feature works without an account or purchase step.

## Privacy practices

### Single purpose

Read chosen webpages, selected text, and PDFs aloud, highlight the passage, and save settings and position locally.

### Permission justifications

- `activeTab`: temporarily accesses the active tab when the user opens the toolbar, for requested text extraction and highlights.
- `storage`: stores playback settings, selected voice, local diagnostics, and resume URL, title, position, and short text excerpt. During an upgrade, legacy custom-voice settings and credentials are removed automatically. Failed cleanup is retried at the next background startup; retired data stays local until that succeeds. The current version accepts no new custom-provider credentials.
- `offscreen`: creates a hidden document with AUDIO_PLAYBACK and WORKERS reasons for voice preparation, workers, and audio. Playback continues after the popup closes; prepared models can be reused between reads.
- `scripting`: injects packaged text extraction and highlights for the page or selection the user asks to read.
- Optional host permissions: request access to the specific HTTP or HTTPS origin needed to read a user-chosen source. Local-file access is used for user-chosen local PDFs and requires Chrome's Allow access to file URLs setting. Access is requested on demand, not to monitor browsing.

Remote code: No. All executable JavaScript, WebAssembly, and model runtime code ships inside the extension package.

Built-in model downloads: uncached Kokoro or OmniVoice model data is fetched from `https://huggingface.co/` at pinned revisions, following its official `hf.co` file-delivery redirects. Downloads start only when the user prepares or uses a built-in voice. These are model-data files, not downloaded JavaScript or WebAssembly. Hugging Face and its delivery hosts receive normal connection information, including the IP address and requested files; they do not receive narration text for built-in speech. Browser cache storage is reused after restart but may be cleared or evicted. Network access is required again for missing files. These model requests do not grant access to users' webpages.

### Data use

Select these handled-data types in the dashboard, including data kept only in the browser:

- Website content: webpage text, selected text, and PDF content the user asks PageNarrator to read, including a short text excerpt stored locally for resume.
- Web history: the page or PDF URL and title stored locally with reading position for resume.
- Authentication information: legacy credentials from earlier custom-voice versions can remain stored locally until automatic upgrade cleanup succeeds. The current version accepts no new custom-provider credentials and makes no custom-provider authentication requests.

Keep that legacy handling disclosed for this upgrade path. A clean installation has no custom-provider credential input. Failed cleanup can retain previous credentials, so removal of the feature alone does not prove their immediate deletion. [Chrome's user-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) requires disclosure of local data handling too. Copying text does not preserve dashboard selections. Verify categories and all three certifications in the form.

Certify that the data is used only for PageNarrator's disclosed reading purpose, is not sold or used for advertising or lending, is not transferred for unrelated purposes, and is not read by humans. Privacy policy: https://pagenarrator.com/privacy

Check all three Limited Use certifications. Narrated text stays on the device. Online documents are retrieved from their source hosts; model downloads contain data only.

### Dashboard URLs

- Homepage: https://pagenarrator.com/chrome-extension
- Support: https://pagenarrator.com/support
- Privacy policy: https://pagenarrator.com/privacy
