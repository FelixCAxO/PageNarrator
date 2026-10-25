# Adversarial PDF fixtures

`tests/pdf/pdf-wild-acceptance.test.js` checks ten deterministic PDFs made by `tests/helpers/wild-pdf-fixtures-generator.js`. “Wild” describes difficult layouts; these are authored controls, not collected documents.

Cases cover columns, spanning abstracts, fragmented kerning, ligatures, equations, wrapped table cells, cross-page sentences, rotation, superscripts, footnotes, drop caps, and OCR-like baseline jitter.

Run `npx vitest run tests/pdf/pdf-wild-acceptance.test.js` for the PDF.js development-oracle lane with PageNarrator's extraction and streaming checks. Run `node scripts/test-original-pdf-corpus.mjs` for the same assertions through the extension's parser, with backend and cleanup records.

Checks cover text order, unwanted narration, and geometry. They do not establish listening quality, real-scan OCR accuracy, or unseen-document acceptance. See [PDF acceptance](pdf-corpus.md).
