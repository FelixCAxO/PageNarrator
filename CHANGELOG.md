# Changelog

## 1.0.2 (2026-10-27)

- Give each of the 32 OmniVoice languages ten fixed female and ten fixed male references, stable across documents, reading positions and retries; add normal/whisper screening and exact restart checks.
- Render experimental whisper from the selected speaker with deterministic breath excitation; keep Cantonese and Thai whisper selectable with a word-loss warning.
- Preserve saved whisper when reopening the popup by restoring its language before its voice controls.
- Infer PDF table rows dynamically, including wrapped cells, compact sidebars and margin notes after their associated paragraph.
- Read numbered study questions with their complete answers and headerless definition tables in row order; preserve Swedish shared compounds.
- Render letters stored in symbolic Macintosh TrueType subset slots instead of missing-glyph boxes.
- Limit the OmniVoice language picker to 32 common languages with full names, retaining an existing uncommon selection.
- Show localized language names in locale order and retain reading errors when the player state refreshes.
- Keep local candidate browser checks separate from tests of published GitHub downloads.
- Add bound human-review receipts and blind review packets for the private PDF library benchmark.
- Preserve clamped Resize borders and rank-three float32 interpolation order in the native speech engine.
- Preserve small recurrent activations and signed zero on CPU, improve small GPU activations, and retain float32 STFT windowing precision.
- Require independent math checks and bound blind voice reviews under the maintainer's approved speech-quality target; retain earlier PCM failures as diagnostics.

Published at the maintainer's explicit instruction with the limitations in the [release verification report](https://github.com/FelixCAxO/PageNarrator/releases/download/v1.0.2/pagenarrator-1.0.2-verification.md). PDF reading order scored 97/100 on the fixed benchmark. Independent PDF/voice reviews remain pending; physical hardware qualification did not pass and three OmniVoice continuity timings remain unqualified. Historical PCM mismatches remain failed/unqualified diagnostics. Publication changes no thresholds or results and establishes no listening-quality or hardware qualification.

## 1.0.1

- Show transferred bytes during voice downloads and explain first-use download sizes.
- Cancel initial voice setup and warmup with Stop, reset the setup UI, and allow a clean retry.
- Apply the PDF source limit and cancellation to fallback downloads; reject non-PDF responses from a bounded prefix.
- Disable incognito access until reading metadata has separate private-storage handling.
- Retire stalled Kokoro workers after a bounded graceful shutdown.
- Verify the website release link and deployed page-build identity; clarify ZIP updates and refresh product screenshots.
- Run full-model numerical comparisons as part of future release verification.

This maintenance version improves reliability without changing inference arithmetic or model pins. On 2026-10-25 the maintainer explicitly extended the disclosed PCM acceptance and physical hardware/human-review waivers to v1.0.1. Numerical comparisons remain failed/unqualified; hardware tiers and broad listening quality remain unverified. These exceptions do not apply to v1.0.2. Previous release assets were removed when the repository was recreated; [build from source](README.md#build-and-test).

## 1.0.0

Initial public release. Previous release assets are no longer hosted in this repository.

- Read webpages, selected text, and PDFs with ten local English voices.
- Follow highlights, use the transcript, and resume saved reading positions.
- Adjust speed from 0.5× to 3×, section pauses, reading cleanup, and highlight colors.
- Read English scanned PDFs with local OCR.
- Use experimental OmniVoice for multilingual speech, voice variations, and whisper mode.
- Download voice files when needed and reuse cached files offline.
- Build original speech, OCR, and PDF engines from pinned sources. Packages include a matching source ZIP.

Kokoro duration and PCM reference comparisons remain failed/unqualified, accepted as a v1.0.0 limitation on 2026-10-25. Physical hardware testing and broad human/listening reviews were waived on 2026-10-24; they are unverified. See [verification status](docs/release-readiness.md) for the records, and the [engine reference](docs/browser-engine.md) for PDF support and limits.

Earlier private builds are outside the public release series.
