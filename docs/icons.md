# Icons

Use the document-and-speech-bubble logo across the extension and website.

| Asset | Source |
| --- | --- |
| Square icon | `icons/PageNarrator_Icon.png` |
| Wordmark artwork | `icons/PageNarrator_Icon_With_Text.png` |
| Transparent sources | `icons/PageNarrator_Icon_Transparent.png` and `icons/PageNarrator_Icon_With_Text_Transparent.png` |
| Shared website and extension logo | `website/public/assets/pagenarrator-icon.png` |
| Extension sizes | `icons/icon-16.png`, `icons/icon-32.png`, `icons/icon-48.png`, `icons/icon-128.png` |
| Website tab and touch icons | `website/public/favicon.ico` and `website/public/apple-touch-icon.png` |

Run `node scripts/build-site-brand-icon.mjs` to build the shared transparent logo. Keep the source artwork, transparent copies, size-specific PNGs, and favicons in sync. Vite includes the shared logo in the extension.

Logo, stylesheet, screenshot, and social preview URLs use a `v` query with the first 12 SHA-256 characters of the file. Normalize CSS line endings to LF before hashing. Update these versions when assets change, then run `node scripts/build-homepage-css.mjs`.

`tests/website/website-brand.test.js` checks the shared artwork, transparency, version hashes, headings, and favicons. Capture provenance also pins the logo; changing it requires fresh product screenshots.
