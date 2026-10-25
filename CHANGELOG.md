# Changelog

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
