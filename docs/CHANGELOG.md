# Changelog

## 1.0.4 (Unreleased)

- Keep PDF narration working with unfamiliar unembedded font names by substituting bundled fonts while preserving character mappings and PDF spacing.
- Recover readable PDF text when unsupported visual effects, annotation artwork, or canvas/font painting fails; show a selectable text view when needed and retain OCR detection for outlined text.
- Prioritize the requested PDF page over speculative neighbors, stop obsolete prefetch, and preserve navigation and narration highlights through zoom and background repaints.
- Reduce Kokoro CPU work and OmniVoice GPU projection work while preserving the tested speech output. Performance measurements cover the recorded host and requests; other hardware remains unqualified.
- Preserve integrated-GPU performance by using the existing small-grid projection kernel outside the measured NVIDIA Blackwell path.
- Require real packaged OmniVoice reading, settings, and continuity journeys during release verification, and reject source packaging when required new files are still untracked.
- Localize the PDF sign-in instructions, original-link action, and artwork warning.
- Remove unused files and tools, and simplify contributor documentation.


## 1.0.3 (2026-11-04)

- Open PDF links with the browser session and hand sign-in redirects back to Chrome.
- Sort OmniVoice variations by measured acoustic quality while preserving saved voices. The catalog has 640 attributed presets across 32 languages.
- Reduce clicks, clipping, startup delays, and gaps between sections. Keep speech moving when background tabs delay highlights.
- Improve PDF font and artwork recovery, rendering cleanup, dark controls, and highlights for code expressions.
- Verify model downloads before caching. Reduce CPU storage and GPU work, and repair the tested Kokoro waveform comparisons.
- Target Chrome 120 explicitly, update the toolchain, and make paired ZIP replacement recoverable.

Independent listening and physical hardware qualification remain open. See the [verification report](https://github.com/FelixCAxO/PageNarrator/releases/download/v1.0.3/pagenarrator-1.0.3-verification.md).

## 1.0.2 (2026-10-27)

- Add stable OmniVoice references and deterministic whisper across 32 languages. Cantonese and Thai whisper carry a word-loss warning.
- Improve PDF table, sidenote, study-question, and font handling.
- Preserve saved whisper settings and reading errors. Localize and sort the language picker.
- Add bound review receipts and separate tests for local candidates and published packages.

The fixed PDF benchmark scored 97/100 for reading order. Independent reviews, physical hardware, and three continuity timings remained unqualified. See the [verification report](https://github.com/FelixCAxO/PageNarrator/releases/download/v1.0.2/pagenarrator-1.0.2-verification.md).

## 1.0.1

- Show voice download progress, cancel setup with Stop, and recover stalled Kokoro workers.
- Bound PDF fallback downloads and disable incognito access.
- Clarify ZIP updates and refresh the installation screenshots.

The [release policy](../tooling/config/release-policy.json) records the version-specific waivers and accepted PCM limitation.

## 1.0.0

Initial public release with local narration for webpages, selected text, and PDFs. Includes synchronized highlights, saved positions, English OCR, Kokoro, experimental OmniVoice, and matching source ZIPs. The [release policy](../tooling/config/release-policy.json) records its verification limits.
