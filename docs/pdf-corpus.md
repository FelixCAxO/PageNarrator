# PDF tests and acceptance

The extension uses PageNarrator's original PDF parser. Tests importing `pdfjs-dist` use it only as a development oracle. Run the original parser against generated, layout, adversarial, and optional local fixtures:

```powershell
$env:PN_PDF_FIXTURE_DIR = 'D:\PDFs'
npm run test:pdf-corpus
Remove-Item Env:\PN_PDF_FIXTURE_DIR
```

Omit `PN_PDF_FIXTURE_DIR` for checked-in/generated fixtures only. Fast and release gates use this command. Reports include source hashes, actual backend opens, and document cleanup. Text/geometry checks do not qualify raster accuracy, OCR, or listening quality.

## Table and mixed-element reading order

`tests/pdf/pdf-table-reading-order.test.js` covers text/date and numeric tables, sparse and wrapped cells, OCR order, scale, and real decoding. Negative controls keep prose columns and chart axes out. Webpage order and word mapping use `tests/reading/structured-elements-order.test.js`, `tests/speech/table-word-highlight-sync.test.js`, and `tests/e2e/table-reading-order.e2e.js`. Geometry is conservative; arbitrary untagged tables are not guaranteed.

## Real-book narration flow

`tests/pdf/pdf-dynamic-flow.test.js` checks headers learned from nearby pages, gutter-confirmed columns, figures, headings, glyph artifacts, and margin notes. `scripts/pdf-flow-report.mjs` measures broken sentences, upward jumps, and header leaks in a PDF folder. `--src` compares source trees. Record source hashes; alignment is separate from recognition and naturalness.

## Public corpus

`tests/pdf/pdf-real-corpus.test.js` checks 100 fixed versioned arXiv URLs in `tests/fixtures/open-pdf-corpus.js`. These source identities do not grant redistribution rights. The default test validates only the manifest. Enable live downloads explicitly:

```powershell
npx cross-env PN_REAL_PDF_CORPUS=1 vitest run tests/pdf/pdf-real-corpus.test.js
```

Set `PN_REAL_PDF_LIMIT=5` for a short run. This lane uses PDF.js with PageNarrator extraction and highlights, separately from the original-parser command.

It validates PDF bytes, parses early readable pages, orders text, builds a test text layer, splits speech, and checks highlights using `pdf-page-N` and `domWordOffset`. It handles columns, RTL, repeated headers, citations, symbols, and soft wraps. At least 98% of sampled split sections need a visible active region; at least 95% of sampled spoken words must match the rendered word after soft-hyphen normalization. Failures retain source IDs and sample text.

## Local Summer2026 PDFs

`tests/pdf/pdf-summer2026-corpus.test.js` opens each local PDF and checks first speech output. Its ordinary lane uses PDF.js; `test:pdf-corpus` uses the same assertions with the extension's parser.

```powershell
$env:PN_SUMMER2026_PDF_DIR = 'D:\PDFs'
npm run test:summer2026-pdfs
Remove-Item Env:\PN_SUMMER2026_PDF_DIR
```

## Fixed PDF acceptance benchmark

`npm run test:pdf-acceptance` evaluates `private-library-v1-20261024`: 90 independently referenced native-text pages from 30 private PDFs and ten unchanged authored controls. The public manifest, `tests/fixtures/pdf-library-acceptance-manifest.json`, contains random fixture IDs, categories, expected routing codes, and integrity pins for private metadata. PDF hashes, page numbers, source identities, books, excerpts, previews, reference layouts, and gold stay private and out of both ZIPs. A document's SHA-256 is never used as its public identity.

Revision 05 gold is 270,942 bytes, SHA-256 `c528b5f58f5704acbf82fc562c95eaa6714965923f094a03da73295973c37251`. It defaults to `.cache/pdf-library-v1-20261024-reference-05/gold.json`; set `PN_PDF_LIBRARY_BENCHMARK_GOLD` for another location of the same file. Keep the pinned `manifest.private.json` beside that gold file. It preserves the original PDF/page mapping without changing the frozen gold. The loader verifies both manifests, roster, reference, and PDF hashes. Missing or changed inputs fail. Candidate output never supplies reference text. Reports contain private runtime evidence and must remain local unless explicitly redacted.

### References and scoring

`config/pdf-library-reference-protocol.json` freezes selection, eligibility, matching, and page-furniture rules. Independent references use PDF.js raw items, PDFMiner/pdfplumber coordinates, and Poppler previews. Captures include preceding/following context; positive eligibility covers the target and three preceding narration pages. Original five sample positions are excluded. This is a page sample from a consumed library, not unseen-document evidence.

Forbidden margin text needs three spatial witnesses, separation from body, and no body collision. Numeric labels also need a three-page printed/physical page sequence. Positive anchors use a separate rule: repeated complete marginal spans at the same position on two pages are ambiguous and excluded, without declaring them forbidden. Qualify references before product scoring; keep failed attempts.

| Automatic gate | Threshold |
| --- | --- |
| Reading order | At least 95/100 pages |
| Narration errors | At most 10 |
| Internal chunk grounding | At least 98% |
| Internal word alignment | At least 95% |
| Image-only routing | 100% |

Empty or exceptional readable pages stay in the 100-page denominator and fail. Score complete target-page speech from the contextual stream beginning three pages earlier. Internal speech/DOM checks do not prove independent completeness, raster geometry, OCR accuracy, or audio quality.

Checkpoint matching accepts segmentation differences within eight complete tokens per side. Prefixes, missing letters, reordering, and reused overlapping matches fail. Scoring removes numeric citations and explicit prose URL tokens. Quoted URLs in leading code calls/assignments, including hosts and parameters, remain required. URL-only prose checkpoints fail; adjacent body words remain required. Never rewrite candidate narration for scoring.

Naturalness is `waived` only for explicitly covered versions under the dated [policy](../config/release-policy.json), with a null score. V1.0.2 requires current independent reviews. Numerical gates are unchanged. `npm run report:pdf-acceptance` writes a new report under `artifacts/pdf-acceptance/library-v1/` with counts, failed pages, pins, and review evidence. Explicit output paths refuse overwrite.

### Library human-review receipts

The fixed 50-passage sample uses 40 library pages ranked by SHA-256 of their existing public fixture IDs, plus all ten authored controls. Selection never depends on candidate output or ratings; the original 100-page order benchmark and gold remain unchanged. `tests/fixtures/pdf-library-naturalness-sample.js` defines the roster.

Generate a private packet with `node scripts/run-pdf-acceptance.mjs --write-naturalness-packet --benchmark=library-v1 --backend=original-browser --output=artifacts/pdf-review-packet.json`. Create the local blind form with `node scripts/pdf-naturalness-reviews.mjs --packet artifacts/pdf-review-packet.json --html artifacts/pdf-review.html`. Keep transcripts, original human responses and reviewer identities out of Git and public releases.

Two independent humans score each passage from 1–5 for structural reading quality; disagreements greater than one point require a third independent reviewer. Import their unchanged responses with `node scripts/pdf-naturalness-reviews.mjs --packet artifacts/pdf-review-packet.json --review RESPONSE_A.json --review RESPONSE_B.json --output artifacts/pdf-review-ratings.json`, adding a third response when needed. Preserve the generated provenance receipt and original responses. Set `PN_PDF_NATURALNESS_RATINGS` to that ratings file before the release gate.

Acceptance recomputes every sampled transcript through the current parser and rejects stale hashes, missing or duplicate panels, invalid reviewer identities and changed inputs. The unchanged naturalness threshold is an average passage-panel score of at least 4. `--report-incomplete-naturalness` produces a failing diagnostic report when evidence is missing; it grants no waiver or quality pass. These text-structure reviews do not establish speech audio quality or replace listening reviews.

Reports separate commit identity from byte verification. Checkouts use their own HEAD and reject conflicting IDs. Exports without Git need a full validated `PN_CANDIDATE_ID` or `GITHUB_SHA`, labelled externally supplied. An ancestor repository cannot supply HEAD; broken local Git is an error. Identity, implementation, input, and reference pins must stay stable during evaluation. Canonical packaging separately binds exported bytes to the commit.

For a new reference version, run `npm run prepare:pdf-gold -- --source-root <private-library> --output <fresh-private-folder> --python <python> --pdftoppm <pdftoppm> --private-manifest <frozen-private-manifest>` with pinned extraction dependencies. The private manifest supplies frozen routing identities; the generator writes separate `manifest.private.json` and `manifest.public.json` files. Only the latter belongs in Git. Review and freeze the independent evidence before evaluating the product. Never regenerate expectations from a failing run.

<details>
<summary>Reference revision records</summary>

Reference revision 03 preserves the initial reference attempts and the first Node-core product report (46/100 ordered pages). Source-position review corrected running-header anchors and boundary-truncated word fragments; independently confirmed malformed image data and undefined native glyph references are not treated as readable positive gold. The same predeclared hash-ranked reserves supply replacements. Two separately pinned native-routing controls retain the unresolved-Type3/OCR refusal and the nonconforming-JPEG2000 refusal, with exact expected codes checked both at the target alone and in context. These checks are additional to the 100 positives and five authored image-only controls; they do not claim successful OCR recognition or malformed-input rendering.

Revision 05 retains exactly the same 90 pages as revision 03. It reconciles complete furniture spans across parser word segmentation, adds independent forward witnesses and separates positive-anchor ambiguity from strict forbidden-narration proof. Physical word geometry also prevents a dangling continuation fragment becoming a checkpoint when layout containers interleave a formula. Five complete, unique, common-monotonic anchors remain on every page. All 450 anchors, 330 positive and six negative reference files, original PDFs and generator/data hashes were independently checked before product evaluation. Revision 04 was never product-evaluated; its data and the failed revision 03 browser result (69/100 ordered pages) remain unchanged.

</details>

### Optional historical benchmark and human-review protocol

The older benchmark is optional and keeps its original identity and hashes. Missing historical gold is not a v1.0.0 prerequisite. No new reference is labelled recovered historical gold.

`tests/fixtures/pdf-acceptance-manifest.js` freezes 90 versioned arXiv papers and ten authored PDFs. Source links preserve attribution, not redistribution permission. The ten controls retain exact checkpoints and forbidden tokens. Real-paper gold remains unavailable; its fixed hash is in `tests/helpers/pdf-benchmark-gold.js`.

Strict historical runs require `PN_PDF_BENCHMARK_GOLD` pointing to that unchanged JSON. Missing, empty, or changed inputs fail before document work, including generated-only selections. Generated unit/lifecycle checks, identity-only raster/font diagnostics, and live highlights do not require excerpt gold.

```powershell
$env:PN_PDF_BENCHMARK_GOLD = 'C:\PrivateBenchmarks\pdf-benchmark-gold-v1.json'
npm run test:pdf-acceptance:historical
```

The default 100-source `scripts/probe-pdf-engine.mjs` and `scripts/probe-pdf-corpus-parity.mjs` need the same gold. `node scripts/probe-pdf-engine.mjs fixture-table` remains available without it. Keep gold private.

Historical thresholds are 95/100 ordered pages, at most 10 narration errors, naturalness >= 4.0/5 on 50 fixed passages, grounding >= 98%, word alignment >= 95%, and image-only routing 100%. Order uses complete production speech. Matching normalizes only suppressed numeric citations, repaired soft wraps, and canonical Latin diacritics. Passages are the first deterministic sentence-bounded speech section on each sampled page: 650-character target, 900-character cap. Other metrics score the complete page.

Ratings bind to each exact UTF-8 `transcript`. Two independent blinded humans rate each passage; add a third only when scores differ by more than one point. The current ratings file is `[]`. Earlier agent-generated scores were removed and never migrated. Missing reviews leave all 50 slots, a null average, and `passed:false`. Reviews are waived only for the active v1.0.0 lane.

Each rating retains `passageId`, `transcriptSha256`, `ratings`, `median`, and `categories`. Its ordered `reviews` entries need `kind:'human'`, distinct `reviewerId` values, canonical UTC `reviewedAt` timestamps with milliseconds, and the packet's exact transcript hash. Verify actual human responses; metadata cannot prove human review. Model scores, duplicate reviews, and generic voice approvals do not qualify. The rubric covers wraps, split words, punctuation, and structural pauses, not voice timbre.

### Collect historical reviews

1. Generate the packet: `node scripts/run-pdf-acceptance.mjs --write-naturalness-packet --backend=original`. Default: `artifacts/pdf-naturalness-original.json`. `--output=PATH` chooses a new path; existing files are refused.
2. Build the local form: `node scripts/pdf-naturalness-reviews.mjs --packet artifacts/pdf-naturalness-original.json --html artifacts/pdf-naturalness-review.html`.
3. Give each reviewer only that HTML. Scores start blank. A stable ID and explicit independent blinded-human confirmation are required. Keep downloaded JSON unchanged and other reviewers' responses out of their session. Assign language-competent subsets, including Arabic competence for Arabic passages. The form sends nothing over the network.
4. Import the original responses:

```powershell
node scripts/pdf-naturalness-reviews.mjs --packet artifacts/pdf-naturalness-original.json --review C:/PrivateReviews/reviewer-a.json --review C:/PrivateReviews/reviewer-b.json --existing tests/fixtures/pdf-naturalness-ratings.json --output artifacts/pdf-naturalness-ratings-reviewed.json
```

The importer lists passages needing a third reviewer. Give that person the same blank form, then import with another `--review` and new output. It verifies hashes, dates, distinct IDs, panels, medians, and the unchanged third-review rule; conflicts and existing output files fail. The `.provenance.json` receipt hashes original responses. Verify human authorship before copying ratings into `tests/fixtures/pdf-naturalness-ratings.json`. Merge completed panels with `--existing` without reimporting their responses.

After fixing the candidate commit, `node scripts/run-pdf-acceptance.mjs --benchmark=historical-v1 --write-report` writes `artifacts/pdf-acceptance-original.json` with commit, manifest/source hashes, categories, counts, page evidence, rating provenance, routing outcomes, and failures.

## PDF Splitting Taxonomy Testing

`tests/pdf/pdf-splitting-taxonomy.test.js` checks 12 cases: titles, LTR columns, RTL columns, mixed direction, soft-wrap repairs and hard compounds, tables, lists, deferred captions, repeated headers/footers, citation/symbol suppression, bounded sentence streaming, and DOM word mapping. Source anchors remain intact. Streaming protects abbreviations and decimals and respects `maxLen` / `targetMinLen`.

## 100 PDF Types & Natural Flow Benchmark

`tests/pdf/pdf-100-types-flow-benchmark.test.js` checks 100 layout variations in eight families. See the [full type list](pdf-100-types.md). These are structural checks, not human naturalness scores.

## 1,000 generated binary PDF fixtures

`tests/pdf/pdf-1000-corpus-e2e.test.js` generates ten families with 100 variants each. It checks columns, tables, lists, noise, streaming, and monotonic DOM word mapping. See [generated corpus](pdf-1000-corpus.md). Synthetic cases do not qualify independent publications.

## Real Wild PDF Acceptance Benchmark

Despite the historical name, `tests/pdf/pdf-wild-acceptance.test.js` uses ten authored adversarial controls. See [fixture details](pdf-wild-acceptance.md).

Run any suite directly with `npx vitest run <test-file>`. For the original parser and cleanup records, use `npm run test:pdf-corpus`.
