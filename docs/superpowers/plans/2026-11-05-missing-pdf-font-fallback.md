# Missing PDF font fallback implementation plan

**Goal:** Keep narration working when an unembedded PDF font has an unfamiliar name.

**Design:** Use bundled Liberation Sans as the last-resort visual font. Preserve the PDF's ToUnicode semantics, declared encodings, glyph widths, spacing and CID writing direction. Unknown characters remain marked as unmapped for the existing OCR path. Never replace embedded font programs or suppress corrupt-data errors. Record substitution in inspection diagnostics without showing a blocking error.

**Approaches:** More font aliases leave the same failure for the next name. A separate extraction-only parser duplicates the text/layout pipeline. A shared fallback font in the existing parser covers both extraction and rendering with a small integration point.

**Tech stack:** Existing JavaScript PDF engine, bundled licensed fonts, Vitest.

## Work

- [x] Add failing tests for unfamiliar simple fonts (Type1/TrueType), Unicode overrides, encodings, missing widths, symbolic unmapped characters and embedded-font precedence.
- [x] Reuse the existing TrueType fallback path for unrecognized unembedded simple fonts.
- [x] Cover unembedded composite fonts using explicit ToUnicode or canonical CID mappings; preserve vertical metrics and mark absent mappings as unmapped.
- [x] Run focused tests, lint, full suite and build; review the final diff.

Validation: the new regression file initially failed for missing-font errors. Focused tests, changed-file ESLint, type checking, the full Vitest suite (45,356 passed, 4 skipped), and the production extension build passed. The suite emits existing PDF.js font-data and DOM scroll warnings.

## Review focus

- Font names are diagnostics only: never interpolate arbitrary names into CSS or asset paths.
- Explicit Unicode mappings can be empty or contain multiple Unicode scalars.
- A substitute's glyph IDs must never be treated as the source font's Unicode or CIDs.
- Malformed mappings/metrics, cancellation and resource limits must still propagate.
- Existing embedded programs and standard font rendering retain their existing behavior.
