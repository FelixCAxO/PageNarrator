# PDF verification

Run `npm run test:pdf-corpus` to check the extension's original parser. The fast and release gates use this command. Set `PN_PDF_FIXTURE_DIR` to include local PDFs. Reports record source hashes, parser opens, and document cleanup. Keep local inputs and reports out of Git.

| Coverage | Test |
| --- | --- |
| 100 layout types and 1,000 generated PDFs | `tests/pdf/pdf-100-types-flow-benchmark.test.js`, `tests/pdf/pdf-1000-corpus-e2e.test.js` |
| Ten authored adversarial PDFs | `tests/pdf/pdf-wild-acceptance.test.js` |
| Tables, prose columns, margin notes, and OCR order | `tests/pdf/pdf-table-reading-order.test.js`, `tests/pdf/pdf-dynamic-flow.test.js` |
| Speech splitting and word alignment | `tests/pdf/pdf-splitting-taxonomy.test.js` |
| Structural reading-order patterns | `tests/pdf/reading-order-patterns.test.js`, `tests/pdf/reading-order-pattern-inventory.test.js` |

Run an individual suite with `npm test -- <test-file>`. The default direct tests that import PDF.js use it as a development oracle.

## Reading-order diagnostics

The pattern suite checks 38,016 synthetic table, prose, and sidenote cases against an independent expected order. Production infers order from text and geometry. Use `node tooling/scripts/audit-reading-order-patterns.mjs <run-id>` for per-case records or `node tooling/scripts/audit-reading-order-pdf.mjs <run-id>` to exercise generated PDF bytes. Use `node tooling/scripts/pdf-flow-report.mjs <folder-or-pdf>` for broken sentences, upward jumps, and header leaks in local documents.

## Optional live and private inputs

- Set `PN_REAL_PDF_CORPUS=1` and run `npm test -- tests/pdf/pdf-real-corpus.test.js` for the pinned public arXiv sample. Set `PN_REAL_PDF_LIMIT=5` for a short run. This lane uses PDF.js with PageNarrator extraction and highlighting.
- The frozen private-library and older arXiv acceptance runs are optional historical lanes. Their original references and results belong with the tested revision. The current gate uses the original-parser corpus and packaged PDF/OCR tests.

Structural scores cover the tested layouts. Raster accuracy, OCR recognition, speech naturalness, and coverage of independent publications require separate evidence. See [fixture provenance](pdf-fixture-provenance.md) and [OCR](pdf-ocr.md).
