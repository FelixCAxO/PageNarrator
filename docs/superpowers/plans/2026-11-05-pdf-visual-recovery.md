# PDF visual recovery plan

**Goal:** Recover readable text when unsupported visual features prevent page compilation or canvas painting.

**Design:** Retry unsupported page compilation once with the existing interpreter in text-only mode. Keep text state, graphics transforms, Form recursion, marked content and annotation appearance text; ignore visual effects, image decoding and annotation decoration. Require readable, fully mapped text before accepting recovery. Preserve strict rendering with recoverUnsupportedArtwork=false, text parsing errors, cancellation, and resource budgets. Report omitted artwork through the existing notice. If canvas or font painting still fails with an unsupported/rendering error, show a selectable plain-text page without depending on font rendering.

**Alternatives:** Catching individual visual exceptions leaves more abort paths and risks stale graphics state. A separate text parser duplicates character decoding and layout. A bounded retry using the current interpreter shares those semantics and discards partially built visual state.

- [x] Reproduce unsupported blend/color/soft-mask/group/annotation/image/text-paint failures with readable text before and after the artwork.
- [x] Implement reduced interpretation and one recovery attempt in the document core.
- [x] Add viewer recovery for unsupported canvas and font painting, retaining selection/highlighting and the artwork notice.
- [x] Verify strict mode, text transforms/spacing, annotation/Form text, fatal text errors, no-text pages, cancellation and limits.
- [x] Run focused/full tests, lint, type checking and build; review the final changes.

Review corrections: preserve path geometry and device colors for the outlined-text OCR source; preserve native text paint in that source; use reading order and original source indices for the plain text view. Viewer-only canvas allocation limits can fall back after successful bounded text extraction; parser/text limits still propagate. Detect recovered text before allocating canvas/loading browser fonts.

Real Chromium smoke: actual worker, selectable fallback text and exact speech passed. The reduced OCR raster retained a white background and black foreground, with needsOcr=true for an outlined body. Screenshot: C:/Users/Felix/.codex/visualizations/2026/11/05/01a1ab45-a3c3-73f3-be8f-9dfa6b54a8e2/pdf-visual-recovery.png.

The initial full suite found the CWS screenshot source-freshness check after the CSS change. The capture tool requires Linux/Xvfb; a follow-up refresh used the existing Ubuntu/WSL environment with its own Xvfb display and browser profile on this Windows host.

Initial validation: 26 targeted recovery regressions pass; all PDF/viewer tests pass in the full suite. Full suite: 45,397 passed, 4 skipped, 1 failed (tests/website/cws-listing-assets.test.js screenshot source freshness). Changed-file ESLint, type checking, production build and the real Chromium worker/raster/selection/speech smoke pass. Repeated unsupported color/pattern selections retain their logical state separately from reduced paint state.

Media refresh: recaptured all five native popup/display states from the frozen local 1.0.4 extension build, including actual Kokoro synthesis and webpage/PDF highlights. The capture workflow regenerated accurate source/package/raw-image hashes, website copies and derivatives. Website assets and all localized pages were regenerated to propagate the new image cache versions. All 26 focused media/copy tests passed. Raw captures and logs are in artifacts/product-media-refresh/.

Follow-up validation: website build passed; full suite passed with 495 test files and 45,450 tests passing (4 tests skipped). The screenshot freshness, localized website, asset cache and sharing-metadata checks all pass. No test assertions were weakened.
