# Architecture

PageNarrator is a Chrome extension for local webpage, selected-text, and PDF narration.

## Engineering decisions

The product problem is keeping speech, the original page, and reading position together while narration stays on the user's device. Felix Olsson's original implementation covers the extension lifecycle, extraction, highlighting, speech scheduling, ONNX execution, WebGPU kernels, and native speech/OCR/PDF engines. Pretrained models, dictionaries, fonts, and character maps are third-party data; their provenance and licenses remain separate.

- **Keep playback outside the popup.** An offscreen document owns synthesis and audio, so closing the toolbar popup preserves the read. This adds message and lifecycle boundaries, covered by popup-close, cancellation, recovery, and resume tests.
- **Ship the executable engines.** Original WebGPU and C++/WASM paths keep executable code inside the extension and make supported operators, allocations, PDF formats, and failure limits explicit. This creates a substantial numerical and compatibility maintenance cost. It does not establish parity with upstream inference or PDF libraries; comparison packages remain development tools.
- **Download model data when needed.** Revision and SHA-256 pins verify every cached or downloaded file. The extension stays smaller, at the cost of first-use downloads and separate CPU/GPU caches.
- **Bound document work.** PDF parsing, images, fonts, and compositing have resource budgets. Unsupported documents fail with an error rather than expanding work without a limit. Compatibility is narrower than a general-purpose PDF editor.

See [verification status](release-readiness.md) for current hardware, listening, and PDF coverage.

## Main flow

See the [reading model](reading-model.md) for extraction, scrolling, and resume behavior.

1. The toolbar popup sends an action through `src/lib/reader-engine-host.js`.
2. The service worker starts the offscreen reader. Speech keeps running when the popup closes.
3. An on-demand content script extracts text and draws reversible highlights. PDFs use the extension's viewer, parser, renderer, and English OCR.
4. The reader owns synthesis, audio, preloading, cancellation, and reading position.

PDF scripts never execute. Highlights leave the host page's layout intact.

## Engines and storage

Kokoro is the default: ten English voices, WebGPU when available, and a CPU / WebAssembly fallback. OmniVoice is experimental and requires WebGPU. During active reading, switching prepares the incoming engine and audio before releasing the previous model; both may be resident during the handoff. An idle switch releases the previous model first.

Incognito access is disabled in the manifest until reading metadata can be isolated from persistent extension storage. Kokoro workers get up to two seconds for graceful shutdown before forced termination, including after a stalled GPU operation.

Original C++ / WebAssembly and WebGPU / WGSL code handles inference, audio, OCR, PDF parsing, and codecs. JavaScript connects these engines to the browser. Models, pronunciation dictionaries, fonts, and character maps are third-party data. See the [engine reference](browser-engine.md).

`chrome.storage.session` holds popup state. Extension-local storage holds preferences and resume data, including URLs, titles, positions, and short text excerpts. Content scripts cannot access it. Voice files download on demand; narration text stays local.

## Build and checks

Vite and CRXJS build `dist/`. Checked-in binaries and source manifests allow ordinary builds without a native compiler. Build and package checks verify executable hashes, local loading, retained-data notices, version agreement, and size limits. On-demand voice weights stay out of the package.

Tests live in `tests/`. Browser and profile tests run separately. Run the gates locally. See [verification status](release-readiness.md) for the current release checks.

`npm run package` produces the extension ZIP and matching source ZIP. Both exclude credentials, private documents, cached speech weights, and local reports. See [contributing](./CONTRIBUTING.md) and [verification status](release-readiness.md).

The static site is in `website/public/`. Its separate support mailbox Worker is `website/workers/support-mailbox.js`.
