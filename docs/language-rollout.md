# Language and translation checks

The extension packages 26 UI catalogs for 25 languages, with separate Brazilian and European Portuguese. Chrome chooses the interface language. Voice language is selected separately. Source text, voice IDs, and model filenames stay intact.

## Extension catalogs

1. Run `node tooling/scripts/sync-ui-catalog.mjs` after changing UI copy.
2. Update the reviewed overrides in `tooling/config/ui-translations-reviewed.json` and `tooling/config/ui-translations-critical.json`. For drafts, use `tooling/scripts/translate-ui-catalog.py` with a pinned local model.
3. Run `node tooling/scripts/install-ui-translations.mjs` and `npm test -- tests/reader-engine/ui-localization.test.js`.
4. Build the extension, set `PN_E2E_UI_LOCALIZATION=1`, and run `npm run test:e2e:local -- tests/e2e/ui-localization.e2e.js --project=extension --workers=1`. Use `PN_E2E_UI_LOCALES` to limit the run.

Use `data-i18n` for static captions and accessibility labels and `t()` for dynamic text. Keep placeholders and brand names intact. Independent native-speaker review is still open.

## Offline speech language detection

Chrome detects from up to 3,000 characters. PageNarrator requires 80 characters, reliable detection, at least 70% detected text share, and a 20-point lead. Ambiguous text keeps the selected voice. OmniVoice can select a supported language automatically. Kokoro suggests OmniVoice for reliably detected non-English text and waits for the reader to choose.

Set `PN_E2E_LANGUAGE_DETECTION=1` and run `npm run test:e2e:local -- tests/e2e/language-detection-offline.e2e.js --project=extension --workers=1`. For real speech measurements, see [voice verification](multilingual-tts.md#verification).

## Website translations

Edit `website/locales/home.json` for shared and homepage copy, and `website/locales/pages/*.json` for the other pages. Preserve inline links and code. Run `npm run build:website` and commit the regenerated localized pages and sitemap. Use `node tooling/scripts/build-localized-website.mjs --check` to detect stale pages or `--extract` to list required text blocks.

Navigation uses ordinary links to equivalent pages. The English page is the default, and each indexed locale has its own canonical URL. After shared CSS changes, regenerate the fingerprint with `node tooling/scripts/build-homepage-css.mjs`.
