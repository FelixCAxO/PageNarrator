# OCR fixture provenance

Public OCR fixtures in `tests/fixtures/ocr/` are authored controls and owned UI captures. They do not qualify real-document accuracy.

- `authored-packing.png`, `authored-line-fragments.json`, `authored-offset-diagram.svg` and `authored-reference-*.json` are original synthetic controls. `scripts/generate-original-ocr-fixtures.mjs` generates their pixels, text, geometry and hash manifest without reading document images or OCR output.
- `authored-stacked-glyphs.png` and `authored-stacked-control.json` are original source-ownership controls. `scripts/generate-ocr-stacked-control.mjs` derives the expected bounds and foreground/exclusion masks from its drawing before running product code.
- The retained `source-word-*.png` files show PageNarrator interface labels or authored demonstration text. Their companion JSON records preserve exact capture bytes, word geometry and mask checks. The Listening capture remains unchanged.
- `english-rec-candidate.json` and `latin-rec-candidate.json` record model identities, hashes and declared data licenses. They contain no downloaded model executable runtime or document transcription.

These original controls use GPL-3.0-or-later. Model data retain their own notices under `vendor/`.

Photographed-book, DocUNet, curved-page, and teaching-diagram fixtures remain private regression inputs. Their redistribution rights were not established; images and transcripts stay out of public source. Configure `PN_OCR_PRIVATE_FIXTURE_DIR` to run the corresponding historical checks with the preserved inputs. Explicit missing or changed inputs fail. Private references, hashes, thresholds, and failures stay unchanged. Replacing public controls does not turn quality failures into passes.
