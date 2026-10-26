# Language retest and interface translations

`config/language-rollout.json` fixes the requested scope: 25 languages from the EU/gaming shortlist, including Slovak, Estonian and Bulgarian, plus Spanish, French, Dutch and Japanese. Portuguese has separate `pt_BR` and `pt_PT` interface targets. Voice quality and interface translation readiness are independent.

## Current-runtime speech benchmark

Run `node scripts/prepare-language-retest.mjs` after obtaining the attributed native-source cache described in `multilingual-tts.md`. It preserves the original native control and chooses seven additional distinct, verbatim FLEURS inputs per language, bounded to the production section size. Eight samples cover female/male voices and variations 1/2; other variations, whispering and long-form continuity remain outside this experiment.

Build the extension, then set `PN_E2E_LANGUAGE_AUDIT=1` and `PN_E2E_LANGUAGE_AUDIT_DIR=artifacts/omnivoice-language-retest` and run `npx playwright test tests/e2e/omnivoice-language-audit.e2e.js --project=extension --workers=1`. The host measurement lock serializes capture with other scored runs. Real packaged workers use pinned local model bytes. Records retain exact requests, worker/WAV hashes, timings, and both attempts on failure. Matching checkpoints resume; failed recordings remain failures.

Analyze with the existing isolated Python environment: `python scripts/analyze-omnivoice-languages.py --directory artifacts/omnivoice-language-retest --device cuda`. After synthesis, `--strong-review` adds independent 7B recognition for flagged samples. Expected text is used only for scoring, never supplied to the recognizer. Keep GPU capture and GPU analysis serial. Finish with `node scripts/report-language-retest.mjs`. The report verifies bindings and includes each failure in the pass denominator. Weighted CER and acoustic averages cover available scored recordings, so inspect pass counts and worst cases as well as averages.

### Recorded result: 2026-10-25

The current packaged worker on NVIDIA Blackwell generated all **200/200** recordings. Independent CTC recognition and DNSMOS screening, followed by 7B recognition of all **31** flagged samples, produced **180 automatic sample passes, 16 acoustic reviews and four transcript reviews**. Every request/WAV binding verified; no analysis errors or pending second opinions remain. The original analyzer lookup error affecting eight Estonian scores was corrected and those eight were reanalyzed; the diagnostic copies remain in the local artifact folder.

| Language | Passing samples | Weighted CER |
|---|---:|---:|
| English | 7/8 | 5.2% |
| German | 5/8 | 2.3% |
| Polish | 7/8 | 3.5% |
| Italian | 7/8 | 0.5% |
| Czech | 8/8 | 2.1% |
| Portuguese | 6/8 | 3.1% |
| Swedish | 8/8 | 0.9% |
| Danish | 8/8 | 1.8% |
| Finnish | 8/8 | 0.7% |
| Romanian | 7/8 | 0.9% |
| Slovak | 8/8 | 1.5% |
| Estonian | 8/8 | 0.9% |
| Bulgarian | 7/8 | 20.7% |
| Chinese | 8/8 | 4.0% |
| Russian | 8/8 | 2.2% |
| Korean | 6/8 | 15.6% |
| Turkish | 8/8 | 2.3% |
| Thai | 8/8 | 4.9% |
| Ukrainian | 8/8 | 0.3% |
| Vietnamese | 8/8 | 3.6% |
| Indonesian | 7/8 | 2.9% |
| Spanish | 6/8 | 2.3% |
| French | 7/8 | 4.5% |
| Dutch | 5/8 | 3.2% |
| Japanese | 7/8 | 6.1% |

The failed Bulgarian and Korean samples show why averages and successful playback are insufficient. Bulgarian's worst sample had 249% CER, including recognizer insertions; Korean's worst had 94.4% CER. Both also failed the acoustic screen. Spanish, French and Dutch retain acoustic flags; Japanese retains one transcript mismatch. This experiment does not establish human listening approval, reliability across every voice variation, or performance on other hardware.

The worker SHA-256 is `2464c10b4f03142639098c07dc749446370a221ea3e7a8d79d7c2e16c6c2827d`. It remained unchanged after the language-suggestion UI changes. Local evidence is under `artifacts/omnivoice-language-retest`: `index.html`, `report.md`, `verified-summary.json`, `build-provenance.json`, `asr-provenance.json`, per-sample analyses and WAVs. The pinned source is US English, Brazilian Portuguese and Simplified Mandarin for those language entries; other regional accents were not separately qualified.

## Offline language suggestions

Chrome's built-in `chrome.i18n.detectLanguage` analyzes text locally without a language-model download. The extension samples at most 3,000 characters, requires at least 80 characters, respects Chrome's reliability flag, and requires at least 70% text share with a 20-point lead over the next candidate. These percentages describe detected text share, not a calibrated probability. A detector failure leaves manual selection available.

With a reliable supported detection, OmniVoice selects the matching catalog language. Kokoro currently has ten English voices: a detected non-English page gets an OmniVoice suggestion and stops before English synthesis. This never downloads or switches engines without the reader's choice. Short or ambiguous text retains the selected voice.

Set `PN_E2E_LANGUAGE_DETECTION=1` and run `npx playwright test tests/e2e/language-detection-offline.e2e.js --project=extension --workers=1`. A fresh extension profile runs with networking disabled and HTTP requests blocked. The report includes three independent longer passages and all eight individual inputs per language, short/numeric challenges, actual Chrome results and suggestions for both engines. See `artifacts/omnivoice-language-retest/offline-language-detection.json` for measured accuracy and uncertain cases.

The 2026-10-25 run on Chromium 148 identified **75/75 longer passages**, accepted **126/200 individual sentences**, and made **zero reliable incorrect detections** with **zero network requests**. The remaining sentences were too short or uncertain. A separate packaged-player journey detected German from the text despite incorrect English page metadata and displayed the OmniVoice suggestion while retaining Kokoro until the reader chooses another engine. [Chrome's API reference](https://developer.chrome.com/docs/extensions/reference/api/i18n#method-detectLanguage) describes the built-in CLD interface.

## Packaged interface translations

All 25 requested languages are wired into the popup, reader controls, PDF toolbar, onboarding, errors, status updates and accessible captions. The 26 packaged `_locales` catalogs include separate Brazilian and European Portuguese. Chrome's interface language selects the catalog; it does not select the speech language. Article titles, transcript text, PDF text, voice identifiers and model filenames retain their source values. Language names use the browser's local `Intl.DisplayNames` data.

`src/lib/i18n.js` supplies English fallbacks and safe positional substitutions. Static captions and accessibility attributes use `data-i18n` markers; labels surrounding interactive controls are separate text nodes. Dynamic messages use `t()`. Translations are inserted as text, never interpreted as HTML.

The catalogs were drafted locally with [M2M100 1.2B](https://huggingface.co/facebook/m2m100_1.2B), revision `7b36184180524c1a1bbfa37f120a608046250b98` (MIT). The drafting script requires a separately downloaded local model and runs with hub networking disabled. The model and Python authoring dependencies are not packaged with the extension. Core captions, privacy/offline notices, language suggestions, variable counts and model requirements have explicit authored overrides in `config/ui-translations-reviewed.json` and `config/ui-translations-critical.json`. Native-speaker review of the complete catalogs remains outstanding; automated completeness and layout checks do not establish linguistic approval.

To maintain the catalogs:

1. Run `node scripts/sync-ui-catalog.mjs` after changing UI copy. It regenerates the English catalog and `config/ui-message-sources.json` from wired call sites, HTML markers, model help and error records.
2. Update the authored overrides or use `scripts/translate-ui-catalog.py` with a pinned local model to draft missing entries under `artifacts/ui-translations/drafts`. Existing valid drafts are preserved.
3. Run `node scripts/install-ui-translations.mjs`. It merges reviewed wording, checks missing messages and substitution parity, and writes all non-English catalogs only if every locale validates. The legacy preparation inventory remains available through `scripts/prepare-translations.mjs`; it is not the packaged catalog.
4. Run `npx vitest run tests/reader-engine/ui-localization.test.js` to check all catalogs, preserved model sizes/brand names, static accessibility coverage, and literal text insertion.
5. Build, then set `PN_E2E_UI_LOCALIZATION=1` and run `npx playwright test tests/e2e/ui-localization.e2e.js --project=extension --workers=1`. `PN_E2E_EXTENSION_DIR` selects an isolated build; `PN_E2E_UI_LOCALES` optionally limits the comma-separated locale list.

The layout matrix opens real Chromium extension pages with each locale, networking disabled and HTTP requests blocked. It checks popup settings at 350, 320 and 175 CSS pixels, player controls at 350 and 175, the internal reader's diagnostic controls at 400, and a loaded PDF toolbar at 900 and 320. Screenshots and overflow/clipping findings are saved in `artifacts/ui-translations/layout`. The narrow popup represents the space available at approximately 200% zoom; it is a width stress test rather than a browser zoom simulation. PDF and article source text must remain unchanged. Both native select controls and inputs are checked for bounds; native select text truncation is excluded from the custom caption clipping check.

The offline detection suite additionally runs English, Swedish and Japanese player journeys. Each detects German from article text despite incorrect HTML language metadata, displays the localized Kokoro suggestion, retains Kokoro until the reader changes engines, and then lets OmniVoice select German automatically. These journeys use silent fixture playback to test routing and language selection without downloading a voice model; the real speech benchmark above measures synthesis separately.

### Interface verification: 2026-10-25

Each of the 26 packaged catalogs has 321 messages. Catalog coverage, placeholder/brand preservation, model-size checks and literal insertion pass. The Chromium 148 matrix passes all 26 locales across 260 surface/width checks, including both engine settings and the visible narrow PDF toolbar, with zero HTTP requests. The offline detector and three translated player journeys pass all four browser tests. The full unit/integration suite passes 6,514 tests with four skipped; lint, strict type checking, boundary type checking and the production build pass. Native-speaker review remains separate from these checks.
