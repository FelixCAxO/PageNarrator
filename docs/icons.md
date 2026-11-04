# Icons

Use the document-and-speech-bubble logo across the extension and website.

| Asset | Source |
| --- | --- |
| Square icon | `extension/artwork/PageNarrator_Icon.png` |
| Wordmark artwork | `extension/artwork/PageNarrator_Icon_With_Text.png` |
| Transparent sources | `extension/artwork/PageNarrator_Icon_Transparent.png` and `extension/artwork/PageNarrator_Icon_With_Text_Transparent.png` |
| Shared website and extension logo | `website/public/assets/pagenarrator-icon.png` |
| Extension sizes | `extension/public/icons/icon-16.png`, `extension/public/icons/icon-32.png`, `extension/public/icons/icon-48.png`, `extension/public/icons/icon-128.png` |
| Website tab and touch icons | `website/public/favicon.ico` and `website/public/apple-touch-icon.png` |

Run `node tooling/scripts/build-site-brand-icon.mjs` to build the shared transparent logo. Keep the source artwork, transparent copies, size-specific PNGs, and favicons in sync. Vite includes the shared logo in the extension.

Logo, stylesheet, screenshot, and social preview URLs use a `v` query with the first 12 SHA-256 characters of the file. Normalize CSS line endings to LF before hashing. Update these versions when assets change, then run `node tooling/scripts/build-homepage-css.mjs`.

`tests/website/website-brand.test.js` checks the shared artwork, transparency, version hashes, headings, and favicons. Capture provenance also pins the logo; changing it requires fresh product screenshots.
