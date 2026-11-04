# Licensed PDF data

These are licensed data for PageNarrator's PDF engine, not GPL-relicensed code. `manifest.json` pins each source package, size, SHA-256, and license.

- `standard_fonts/`: ten Foxit fonts with the PDFium redistribution notice (their `.pfb` files contain CFF font data), and four Liberation Sans fonts under SIL Open Font License 1.1.
- `iccs/`: the CC0 CGATS001 compatibility color profile and its notice.
- `standard14_metrics/`: four unmodified Adobe Helvetica AFM metric data files retained from Apache PDFBox commit `e314c402afd4cac4d60d6d16dbe6525d83637ba8`. `SOURCE.json` pins official source URLs and hashes; the exact complete unmodified Adobe AFM permission paragraph accompanies the data. SOURCE.json also pins the full upstream license retrieval, retained externally as provenance rather than shipping unrelated component notices. Copyright comments remain in each AFM. These metrics are data, not Apache PDFBox executable code or GPL-relicensed font programs.

The 168 Adobe textual character mappings and their notices live in `../pdf-cmaps/`. Unused PDF.js compressed `.bcmap` copies have been removed after independent font rendering and selection verification.

No PDF.js worker, renderer, codec, QCMS, JBIG2, OpenJPEG, QuickJS, JavaScript fallback or WebAssembly executable is included here. Font charstrings and CMap records are interpreted as bounded font/mapping data, never evaluated as general-purpose code.

Run `node scripts/import-pdf-data.mjs --check` to verify this directory without an installed PDF.js package. Fresh imports need `pdfjs-dist` as a development tool. The importer verifies committed metrics and notices first and never downloads them implicitly. Missing or changed canonical data fails before writing font/profile copies. Keeping these data does not establish that the original engine has implemented every font, CMap, color or image variant; see its explicit unsupported errors and renderer acceptance results.
