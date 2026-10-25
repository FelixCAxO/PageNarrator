# PDF fixture provenance

Test documents, codec vectors, and original generators belong to matching source, not runtime assets. Python, ReportLab, image libraries, and external encoders are development tools and stay out of the extension.

## Frozen document fixtures

[pdf-fixture-fonts.json](pdf-fixture-fonts.json) records the SHA-256 of all 30 PDFs under `tests/fixtures/pdfs`, their producer metadata, and each embedded font's identity, hash, embedding flags and retained notice fields. The audit leaves documents unchanged and saves no extracted font programs.

The ten acceptance PDFs were generated with ReportLab and contain 21 embedded TrueType subsets: Arial, Arial Bold and, in the citations document, Segoe UI Symbol. All have `OS/2.fsType = 8` (editable document embedding). Their original copyright and license records remain inside the unchanged PDF documents; the metadata records the presence and hash of the license-description field. These font programs retain their original rights and are not relicensed under PageNarrator's GPL.

[Microsoft's document-embedding guidance](https://learn.microsoft.com/en-us/typography/fonts/font-faq#document-embedding) permits embedding eligible Windows fonts through compliant document authoring software and generally permits redistribution of those documents. This document permission does not grant font redistribution in application assets. Accordingly, retain these frozen PDFs as documents; do not extract their font programs into runtime assets, web fonts or standalone redistributable fonts. Runtime fallback-font data has its separate pinned manifests and notices under `vendor/pdf-data`.

Other original PDF controls use standard font references or original geometric outlines. In particular, the miniature CID-keyed CFF control in `tests/pdf-engine/cmap-cff-fixture.js` has PageNarrator-authored outlines. The private downloaded research corpus and diagnostic font extractions are not matching-source package inputs.

## Original JBIG2 vectors

`tests/pdf-engine/fixtures/jbig2-original.json` contains PageNarrator-authored deterministic bitmaps and encoded test data under GPL-3.0-or-later. Its source image definitions are in `scripts/generate-jbig2-original-inputs.py`; `scripts/generate-jbig2-fixtures.py` records the original interval/refinement encoder and assembles the fixture. Numeric probability tables and format rules are facts from ITU-T T.88, not copied implementation code or published example bytes.

The generic-region, typical-prediction and symbol-dictionary image controls were encoded from those authored PBMs using the external development tool [agl/jbig2enc](https://github.com/agl/jbig2enc/tree/d0dfca46216c98f11312a9c9f15615ed490cd7b3), revision `d0dfca46216c98f11312a9c9f15615ed490cd7b3` (v0.32, Apache-2.0), with Leptonica 1.82.0 (BSD-2-Clause). The fixture records the input/output hashes, command arguments and tool pins. The encoder binary SHA-256 is `42427b8f41a565cb00b043b3065307f7d61453fc51b47149d2dee094711d9ade`; the isolated container image is `sha256:bf1a837c26f7154f014e146099550e02e711d3ed51b3dded5d995a73e00bc17c`.

Neither encoder code nor library/runtime executables are copied into the extension. The external encoder's refinement option refused execution, so it supplies no refinement acceptance evidence. Refinement/Huffman/halftone structural controls instead use original bitmaps and original writers. Tests compare decoded pixels against the authored pre-encoding images and, where available, the independent development decoder.

The former 860-byte T.88 Annex H.1 file and 30-byte Annex H.2 arithmetic literal were removed from matching source because the publication's terms did not establish redistribution permission for its examples. The single-context replacement uses 32 authored source bytes and a 36-byte original encoding; refinement templates use two original seven-byte encodings. No published Annex H byte slices are retained in the shipped fixtures. `scripts/probe-jbig2-normative.mjs` can inspect privately supplied standards vectors through an explicit environment variable; it contains none of their sample bytes.

## Recognized nontext symbol fonts

`vendor/pdf-symbols/manifest.json` pins the original provider metadata and retained notices. Its mapping data contain only Font Awesome 5.15.4 glyph names, private Unicode values, styles and labels, plus the documented MarVoSym Letter symbol's original code. No provider artwork, icon paths, font programs, or executables are copied. `scripts/import-pdf-symbols.mjs` selects and validates those facts; the Font Awesome non-font/non-icon metadata retain MIT terms, and the MarVoSym facts retain the supplied SIL OFL notice.

`tests/pdf-engine/symbol-fixture.js` uses original geometric outlines, not recognizable copies of provider icons. The miniature fonts test declared font/glyph interpretation, source ranges, paint preservation and authoritative ToUnicode/ActualText overrides. Font Awesome's official private-use code points are identified nontext symbols. MarVoSym's Microsoft symbol cmap is not a Unicode mapping; U+FFFC explicitly represents that identified inline object while metadata retain its original font, glyph and code. These objects remain selectable and are counted separately from meaningful narrative text. Unknown fonts or glyphs retain strict unmapped failures.

The importer checks 1,458 Font Awesome mappings and the one MarVoSym mapping, together with each retained notice and source hash. Exact notice mirrors are packaged as `public/legal/Font-Awesome-LICENSE.txt`, `MarVoSym-OFL.txt` and `PDF-Symbols-NOTICE.txt`; `--download` regenerates those mirrors and `--check` verifies equality. Mapping facts are bundled once with the original JavaScript reader. Private source PDFs and diagnostic font extractions used for compatibility checks are not copied into the extension or matching-source package.
