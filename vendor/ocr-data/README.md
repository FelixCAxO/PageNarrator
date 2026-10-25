# Retained English learned data

PageNarrator's independent English line verifier executes original PageNarrator C++/WASM code. Its learned int8 matrices and character recoder are data derived from the Apache-2.0 licensed `eng.traineddata` at `tesseract-ocr/tessdata` revision `590567f20dc044f6948a8e2c61afc714c360ad0e`.

The original file is 23,466,654 bytes, SHA-256 `daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047`, Git blob `f4744c201359d02ced6914c77f0de68ee9bbdd74`. The retained local mirror is `@tesseract.js-data/eng@1.0.0/4.0.0/eng.traineddata.gz`; its gzip SHA-256 is `ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468`.

`scripts/import-tesseract-english-data.mjs INPUT public/assets/ocr --accepted-independent` checks both source pins and writes 1,473,804 bytes of learned weights, plus the pinned topology/recoder manifest. It extracts no DAWG dictionaries, legacy classifier, upstream executor or upstream activation tables. Quantization scales are represented as float32 in the derived file. The manifest records the exact upstream source and license URLs, transformation, and all data/license hashes.

`tessdata-COPYING.txt` preserves the original upstream data notice. The public data directory carries that notice as `english-lstm-COPYING.txt` and the full Apache License 2.0 as `english-lstm-LICENSE.txt`.

Production uses these data only to check suspicious OCR lines. Whole-page traineddata, compact-recognizer, and beam experiments remain development work. Their failed quality results do not qualify production.
