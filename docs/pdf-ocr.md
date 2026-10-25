# Scanned PDF reading

The PDF viewer uses local English OCR when a page has no usable text layer. Models ship in the extension. Images and recognized text stay on your device.

Accuracy depends on scan quality, typography, lighting, perspective, and layout. Photographs, curved pages, figures, and dense columns remain difficult. Check the text against the page. Highlight alignment does not prove correct transcription.

## Pipeline

Packaged PP-OCRv6 ONNX models run through PageNarrator's WebGPU executor or C++ / WebAssembly fallback. A separate English LSTM model checks bounded source crops. No executable runtime is downloaded.

| Module in `src/lib/` | Job |
| --- | --- |
| `pdf-ocr.js` | Render regions and own resources. |
| `pdf-ocr-detector.js` | Locate text lines. |
| `pdf-ocr-unwarp.js` | Apply eligible UVDoc correction. |
| `pdf-ocr-neural-batch.js` | Validate output and decode text. |
| `pdf-ocr-grid.js` | Map geometry to the source page. |
| `pdf-ocr-lines.js` | Order lines and columns. |

The recognizer returns `ocr_labels`, `ocr_scores`, and `ocr_spaces` as `[batch, steps]`. Only blank labels with enough space evidence become spaces; winning letters stay intact. Invalid output uses the fallback. These scores are heuristics, not calibrated confidence.

Fragments join only when size, baseline, and spacing support one word. Explicit spaces, normal gaps, raised letters, and separate lines stay distinct. Native and OCR text keep source geometry for selection and highlights; word boxes are estimates.

Automatic reading can skip compact symbolic numeric matrices. Nearby prose remains, and explicit selection still includes skipped cells.

## Models and checks

`public/assets/ocr/models.json` records sources, licenses, and SHA-256 hashes. `scripts/build-ocr-recognizer.mjs` rebuilds the graph from its pinned source. Private test documents and browser profiles stay out of packages.

Run `npm run test:pdf` and the packaged `tests/e2e/pdf-ocr.e2e.js` journeys. `tests/pdf/native-ocr.test.js` checks native preprocessing. Browser tests cover recognition, order, word geometry, selection, zoom, and rerendering. They do not qualify unseen documents, pronunciation, or physical hardware.
