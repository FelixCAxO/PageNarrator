# Dynamic reading order audit

The target is dynamic layout inference with at least 98% correct cases. Pattern IDs and fixture metadata are test inputs only; production inference uses text and page geometry. There is no lookup by document, test ID, or known sentence.

## Individually recorded patterns

`tests/helpers/reading-order-patterns.js` and `tests/helpers/sidenote-reading-order-patterns.js` enumerate 38,016 structural combinations. Every combination has its own stable ID, independent semantic oracle, test case, and audit record. These are synthetic combinations, not 38,016 independently sourced documents.

| Set | Exhaustive declared dimensions | Cases |
| --- | --- | ---: |
| Tables | 2/3/4/6 columns × 3/5 data rows × 6 content/wrapping shapes × header present/absent × interior empty cell present/absent × left/center/right alignment × 4 source drawing orders × line/word fragments × 0.5/1/2 scale × PDF/OCR boxes | 27,648 |
| Prose controls | 1/2/3/4 columns × 3/6/9 lines × uniform/staggered/headings/indented layout × 4 drawing orders × line/word fragments × 0.5/1/2 scale × 9/12/18 font height | 3,456 |
| Sidenote controls | Left/right margin × first/middle/last paragraph × 2/5/11 note lines × 3/6 body lines per paragraph × 0.6/0.8 relative note font × 4 drawing orders × line/word fragments × 0.5/1/2 scale × 0/90/180/270 page rotation | 6,912 |

The semantic row/cell/line sequence is built before coordinates, alignment, source ordering, and fragmentation. Checks require exact source-fragment order, including duplicates and omissions. Prose controls additionally reject a `table-row` classification. Six table shapes cover short text, numeric values, dates, uniform wrapping, unequal wrapping, and wrapped row labels.

Run the named regression tests:

```sh
npx vitest run tests/pdf/reading-order-patterns.test.js tests/pdf/reading-order-pattern-inventory.test.js
```

Create a separate record for every case:

```sh
node scripts/audit-reading-order-patterns.mjs latest
```

Outputs go to `artifacts/reading-order-patterns/latest/`:

- `results.jsonl`: one record per ID, with every parameter, input text/geometry/transforms, model options, full expected and actual source/text order, inferred roles, and explicit failure.
- `report.html`: inspect each ID separately; filter by parameter, ID, or failures.
- `summary.json`: complete axes, per-family rates, the 98% target, and SHA-256 pins before and after the run.

## Actual generated PDF bytes

```sh
node scripts/audit-reading-order-pdf.mjs expanded-pdf-verified
```

All 24,192 native-text patterns are encoded as real PDF bytes and decoded separately through the extension's original parser and PDF.js: 48,384 checks. Independent Helvetica AFM advances place actual text at the requested left, center, or right alignment. Sidenote PDFs also preserve the page rotation in the PDF page dictionary. This avoids calling a visually misaligned PDF a test of aligned cells.

Each parser result must match the complete expected speech token sequence. The speech is split into bounded chunks, whose page anchors and word offsets must select the corresponding expected tokens without loss or repetition. Each ID/parser pair gets a record containing PDF SHA-256, parameters, full expected/actual tokens, chunks, word checks, and errors. Files are `results.jsonl`, `report.html`, `failures.json`, and `summary.json` in the named artifact directory. Interrupted runs without a completed summary are incomplete evidence.

The smaller packaged browser journey remains `tests/e2e/table-reading-order.e2e.js`. It checks the actual CSS word highlight ranges against speech tokens on the reconstructed Swedish table and other tables.

To rerun only the separately recorded sidenote PDF family, use `node scripts/audit-reading-order-pdf.mjs sidenote-pdf-probe --family=sidenote`. The family filter is recorded in its summary; do not present a filtered run as all families.

## Findings and general corrections

The first table-only run, `artifacts/reading-order-patterns/baseline/`, passed 13,250 of 27,648 cases. Failures were retained individually. Shared geometry corrections address absent headers, centered/right-aligned cell lines, sparse rows, dates split into word items, wrapped labels, and wider fonts/scales. Prose controls exposed word spaces mistaken for column gutters or margin notes, and staggered column starts mistaken for page introductions.

The runtime determines cells using shared left/center/right edges, observes interline spacing, and requires repeated table evidence. Empty cells retain row structure. Words after a numeric value prevent date words from being split into independent numeric columns. Existing figure, matrix, caption, and surrounding-prose regression tests remain required.

## What the percentage proves

Report rates separately by family and parser. A large table set must not hide failures in prose controls. A synthetic pass percentage measures the declared axes only; it is not an estimate that 98% of arbitrary real documents are now correct.

The complete space of possible PDF layouts is unbounded. This matrix does not exhaust row/column spans, nested tables, all empty-cell positions, merged headers, RTL/vertical writing, mixed-direction cells, arbitrary gutters/font metrics, cross-page rows, mixed table/figure/prose regions, or image recognition errors. All four page rotations are tested for the single-sidenote family; multiple notes per page and other rotated structures remain unenumerated. The generated text is English; Swedish screenshot regressions are separate. Existing tests cover some of these individually; they still need systematic inventories and separate results. OCR-box cases test ordering after recognition, not recognition accuracy. Sidenote cases currently exercise native text, not OCR output.

Before claiming 98% on real usage, freeze the inference changes and evaluate a separately labelled set of independently sourced documents and actual OCR outputs. Keep the denominator, expected sequences, selection method, failure cases, and per-family rates. Real-document accuracy is currently unproven. The screenshot's original PDF was not provided.

## Verified snapshot, 2026-10-26

The source hash of `src/lib/pdf-page-model.js` is `14146f2161b2587e0897cfdec497e4cbeb74b4232e4bb5b874332a1b10636ca0`. Completed audit summaries verify that source pins were unchanged during execution.

| Check | Observed result | Local evidence |
| --- | --- | --- |
| Individually named model patterns | 31,104/31,104; every family 100% | `artifacts/reading-order-patterns/latest/summary.json`, `results.jsonl`, `report.html` |
| Real generated PDF bytes, original parser | 17,280/17,280 complete token/offset checks | `artifacts/reading-order-patterns/pdf-final/` |
| Same PDFs, PDF.js parser | 17,280/17,280 | Same per-ID/per-parser ledger |
| PDF regression suite, including matrix cases and 12 captioned dense-table cases | 34,734 passed; 3 opt-in cases skipped | `npm run test:pdf` |
| Packaged reading and CSS word highlights | 4/4 browser journeys | `artifacts/reading-order-patterns/browser-final/` |
| Existing original-parser corpus | 124 tests passed; 1 skipped; 1,106 opens, 1,086 unique PDFs, all destroyed | `artifacts/reading-order-patterns/original-corpus.log` |
| Pinned independent library sample plus authored controls | 96/100 ordered pages; 860/860 grounded chunks; 29,038/29,042 aligned words | `artifacts/reading-order-patterns/private-library-browser-final.json` |

The independent sample contains 90 real pages and 10 authored controls. Four real pages fail, so the real-page subset is **86/90 (95.56%)**, and the controls are 10/10. The existing release gate accepts 95/100; its `passed: true` does **not** satisfy the user's 98% target. This sample was consumed in earlier development and is not an unseen holdout. Keep the private report and diagnostic excerpts local.

The dense captioned-table correction resolved one of the first run's five failures. Four unchanged-gold deviations remain separately recorded:

| Opaque page ID | Diagnostic category | Status |
| --- | --- | --- |
| `library-596ade4a-7159-4d3b-9478-b3babf7bff50` | Marginal heading order | Open |
| `library-b44cd75c-6066-4180-9adb-ab89df51c7f6` | Right sidenote versus main-text order | Open |
| `library-96a65132-1f87-43eb-9159-25ee36c2e3ba` | Contact text filtered from narration | Open |
| `library-f8a0cf91-22fe-4a2d-8282-6edc4eed2d0a` | Left sidenote versus main-text order | Open |

Do not reverse sidenote policy or restore discarded metadata merely to improve this score. Resolve the intended reading sequence against the independent page evidence, keep original gold/results intact, and separately measure any reviewed policy. Wider real-document and OCR validation, the four deviations, and the unenumerated families above remain required work; the overall goal is still active.

## Expanded verified snapshot, 2026-10-26

The user explicitly selected sidenotes after their attached paragraph. `insertSideNotesAfterTextBlocks` now finds the nearest body line, finishes its paragraph using spacing, font size and indentation, and inserts the complete note block. Sentence punctuation alone does not split a paragraph. Sidenotes use their own baselines and do not determine body heading size. Short notes need only one shared body baseline; larger body words cannot create false note gutters. A larger prose column beside smaller note text is not a wrapped table merely because a few lines align.

The initial sidenote baseline passed 1,344/6,912 cases. All failures remain in `artifacts/reading-order-patterns/sidenote-baseline/`. The final model source SHA-256 is `b5d493f4324f32fbe21accc8bb45f04744f460f4eccefa6e8d4613a81c907125`.

| Check | Observed result | Evidence |
| --- | --- | --- |
| Complete declared model inventory | 38,016/38,016, each family 100% | `artifacts/reading-order-patterns/latest/` |
| Real generated PDF bytes | 24,192/24,192 per parser; 48,384 checks total | `artifacts/reading-order-patterns/expanded-pdf-verified/` |
| PDF regression suite | 41,671 passed; 3 opt-in cases skipped | `artifacts/reading-order-patterns/pdf-unit-expanded-repaired.log` |
| Actual CSS word highlight ranges | 5/5 journeys, including the new after-paragraph sidenote journey | `artifacts/reading-order-patterns/browser-expanded/` |
| Existing original-parser corpus | 124 tests passed; 1 skipped; 1,106 opens, 1,086 unique PDFs, all destroyed | `artifacts/reading-order-patterns/original-corpus-expanded.log` |
| Unchanged independent library benchmark | 97/100 ordered pages; 859/859 grounded chunks; 29,036/29,040 aligned words | `artifacts/reading-order-patterns/private-library-expanded.json` |

The displaced marginal heading now precedes the content below it. It had been mistaken for a parallel right column beside short program lines. The correction still preserves genuine sentence continuations between columns and deferred captions; 24 displaced-heading regression combinations cover source order, alignment and scale.

The unchanged library denominator remains 90 real pages plus 10 controls: **87/90 real pages (96.67%)**, 10/10 controls. Three frozen-reference deviations remain. Two expect margin notes before the main paragraph, conflicting with the user's selected policy. The other requires contact text that the established narration policy suppresses. They remain failures in the original benchmark; no gold, threshold or denominator was changed.

`node scripts/check-library-sidenote-policy.mjs` separately checks the two note cases against the selected after-paragraph sequence, using the original independent checkpoints and reviewed Poppler pages. Both pass, and gold/source hashes remain unchanged. Its private output is `artifacts/reading-order-patterns/private-sidenote-policy.json`. This is targeted agent-reviewed policy conformance on two known pages, not a new benchmark, a human review score, or unseen-document accuracy. Never add those passes to the frozen score or claim 99% real-world accuracy from them.

The prior 31,104-case report is preserved at `artifacts/reading-order-patterns/model-31104-verified/`. The 98% target on unseen documents/OCR and the broader families listed above remain unproven; the overall goal stays active.

## Accepted result, 2026-10-26

The user accepted the observed 97/100 benchmark result as sufficient ("97% är good enough"). The verification task is complete against that accepted result: 38,016 individually documented model patterns, 48,384 PDF checks, and the confirmed after-paragraph sidenote policy. The benchmark, gold, denominator and reported failures remain unchanged. Wider unseen-document/OCR accuracy and the unenumerated families remain documented limitations and possible future work; this acceptance does not establish 97% accuracy on arbitrary documents.
