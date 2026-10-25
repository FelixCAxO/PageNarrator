# Generated PDF corpus

`tests/pdf/pdf-1000-corpus-e2e.test.js` checks 1,000 deterministic PDFs: ten layout families with 100 variants each. `tests/helpers/pdf-1000-generator.js` creates them. These are synthetic controls, not 1,000 independent publications.

Run `npx vitest run tests/pdf/pdf-1000-corpus-e2e.test.js`. This uses the isolated PDF.js development oracle with PageNarrator's extraction, reading-order, streaming, and highlight checks. Run `node scripts/test-original-pdf-corpus.mjs` for the same assertions through the extension's original parser, including document-open and cleanup records.

Both lanes check ordered text, forbidden tokens, empty or unsupported inputs, and layout rules. Image-only extraction tests are separate from the viewer's OCR path. Keep inputs deterministic and add a regression case for each repaired layout bug.

Synthetic passes do not establish naturalness, real-scan accuracy, or general document quality. See [PDF acceptance](pdf-corpus.md) and [OCR](pdf-ocr.md).
