# PDF page navigation investigation — 2026-11-05

## Starting state and feedback

Starting revision: `5fcaa1091113f99dd1d74c732a15538c66e470d5`.
The working tree already had 412 modified/untracked paths, including PDF engine,
renderer, native speech, documentation, and website work. No changes were reset.
The starting status and binary diff are saved locally in
`artifacts/pdf-navigation/starting-status.txt` and `starting.diff`; the original
viewer is `pdf-viewer.before.js`. Existing store media and website files were also
backed up before the required media refresh.
Additional unrelated Omnivoice edits appeared during verification and were left
untouched.

Feedback: a user experienced approximately 20 seconds between PDF pages, possibly
hidden by the development machine's faster CPU/GPU.

* **Confirmed:** render-window requests were chained onto one promise. Every old
  window finished before the latest request could start. Within each window,
  ascending page order put preceding neighbors ahead of the requested page.
  Initial viewer readiness also waited for every speculative neighbor.
* **Unresolved:** the exact 20-second report, the responsible PDF features, and
  physical low-end hardware performance. The reporter's file and device were not
  provided. A single expensive page can still take time to parse or paint.
* **Disproved claims:** none. The report is plausible; a controlled reproduction
  demonstrates the delay mechanism without asserting it was the reporter's only
  cause. These measurements do not establish any particular GPU requirement.

## Criteria, slices, and decision rule

1. **Complete — reproduce scheduling latency.** Run the real viewer/controller
   and virtual renderer with a 20-page test document and deterministic five-second
   page paints. Capture requested-page latency and obsolete page starts. The first
   three regressions failed against the original viewer for the expected reasons.
2. **Complete — requested page first, bounded prefetch.** A cold requested page
   must become selectable within one page-paint interval; a superseding jump must
   meet the same bound without draining older windows. Metadata readiness must
   depend on the requested page. Cancel out-of-window paints, preserve shared and
   protected pages, and stop obsolete prefetch. Keep existing render budgets.
3. **Complete — layout and lifecycle boundaries.** Preserve prefetched pages,
   continue after a failed neighbor, stop after teardown, rerender at the new zoom,
   and prevent old zoom completions or queued layout jobs from overriding a newer
   page. Restore protected narration after background/shared repaints. These races
   received failing regressions before their respective fixes.
4. **Complete — browser and repository verification.** Exercise the built
   extension with its real worker, WASM parser, canvas and text layer. Keep every
   measured browser jump below two seconds for the fixed fixture, with bounded
   canvases and no page errors. Refresh screenshot provenance through the existing
   capture workflow, without changing test assertions.

The decision rule was defined before implementation: eliminate work ahead of the
requested page while satisfying the existing memory and highlight contracts.
Serial speculative prefetch after the foreground page meets this rule; rendering
the whole window concurrently would add resource contention and was unnecessary.

## Implementation

`src/pdf-viewer.js` uses a monotonically increasing render-window request ID and
captures the document/renderer owning each request. A new request immediately
unloads obsolete pages and starts the requested page. Only its completion controls
readiness and layout anchoring. Background pages render one at a time, nearest
first (ahead wins a distance tie), and stop when superseded. Background failures
do not prevent later neighbors from loading. Existing render deduplication,
protected narration pages, canvas recycling, and memory profiles remain in use.

Layout completion and its animation-frame scroll now check that the requested
anchor is still current. A newer page jump therefore keeps control of the view.
Queued layout requests are coalesced and use the current page when they execute.
The viewer also tracks the text layer owning the active highlight: a replacement
layer regains passage/word ranges after its paint, including shared in-flight
repaints. An unchanged layer does not replay the highlighter or restart scrolling.

New regression coverage:

* `tests/pdf/pdf-viewer-navigation-latency.test.js`: eleven deterministic tests,
  discovered by the default Vitest configuration.
* `tests/e2e/pdf-navigation-latency.e2e.js`: two built-extension tests, discovered
  by the existing Playwright `extension` project.

The source freshness gate required recapturing store media. The existing Linux
Xvfb/Openbox capture workflow ran through Ubuntu/WSL against a frozen local build.
It regenerated all five native screenshots, provenance, website screenshots and
derivatives. The website build refreshed dependent asset versions/localized pages.
No GitHub Actions, deployment, or store submission was performed.

Relative to the starting working tree, 55 generated files changed content:
`docs/cws-listing/capture-provenance.json`,
`docs/cws-listing/screenshot-04-toolbar-player-pdf.png`,
`website/public/assets/screenshots/toolbar-player-pdf.png`, and 52 website HTML
files carrying the refreshed image version. Their exact paths are listed in
`artifacts/pdf-navigation/generated-changed-files.txt`. Other recaptured images
were byte-identical to the starting files.

## Identical-input comparison

Both arms used the same DOM fixture, page content, five-second paint cost, page
count, navigation sequence, and virtual clock. This isolates scheduling overhead
from the host's CPU/GPU. These are simulated slow-page timings, not physical-device
measurements.

| Scenario | Before | After | Result |
| --- | ---: | ---: | --- |
| Cold jump from page 1 to page 6 | 15,000 ms | 5,000 ms | One page cost instead of three |
| Jump to 6, then to 10 after 1,000 ms | 34,000 ms | 5,000 ms | Latest request bypasses old windows |
| All paint starts in the rapid-jump scenario | 4, 5, 6, 7, 8, 9, 10, 11, 12 | 6, 10, 11, 9, 12, 8 | No queued windows are drained |

Before: `artifacts/pdf-navigation/regression-before.txt` (3 failed tests).
After and boundary cases: `zoom-green.txt` and `targeted-final.txt`.

The final built-extension check used a generated 20-page PDF with 40 distinct text
lines per page, Chromium, a 1280×720 viewport, CDP CPU throttle rate 6, and navigator
hints of two logical CPUs and 4 GB or 8 GB memory. Each cold sequence requested
pages 6, 10, 14, 18; the rapid sequence requested 4, 10, 16; page 17 exercised reuse
after prefetch. Timing includes selectable text and two animation frames.

| Memory hint | Cold jumps (ms) | Rapid jump (ms) | Prefetched jump (ms) |
| --- | --- | ---: | ---: |
| 4 GB | 113.7, 85.8, 161.9, 173.3 | 271.3 | 52.8 |
| 8 GB | 176.3, 143.8, 91.1, 135.0 | 240.5 | 44.2 |

All samples met the predefined two-second bound. Canvas counts remained within
three/five respectively, with no page errors. Raw results and attachments are in
`artifacts/pdf-navigation/browser-final.txt` and `browser-final/`.

CPU throttling does not reproduce a different CPU architecture, memory bandwidth,
RAM limit, GPU, or all worker execution characteristics. Navigator values are
profile hints, not OS resource limits. The fixture contains text rather than a
representative set of scanned/image-heavy user PDFs. Physical-device qualification
and the reporter's exact document remain unverified. Parser work already executing
in the PDF worker is not interrupted by cancellation of a viewer paint.

## Verification commands and results

All commands ran from the repository root in PowerShell unless indicated. Logs
are local under `artifacts/pdf-navigation/`.
The Windows host used Node `v24.16.0` and npm `11.17.0`; the media capture used
Linux Node `v22.23.3`, Playwright `1.64.1`, and Chromium `156.0.8078.4` as recorded
in capture provenance.

```powershell
# Starting behavior: 56 passed, no failures or skips.
npm test -- tests/pdf/pdf-viewer-rendering.test.js tests/pdf/pdf-viewer-fit-layout.test.js tests/pdf/pdf-viewer-page-indicator.test.js tests/pdf/pdf-viewer-messages.test.js tests/pdf/pdf-viewer-stability-self-repair.test.js --reporter=json --outputFile=artifacts/pdf-navigation/baseline-existing-tests.json

# Same performance cases before/after; original code: 3 failed; fixed code: passed.
npm test -- tests/pdf/pdf-viewer-navigation-latency.test.js

# Eleven new regressions plus message/layout/page-indicator coverage: 26 passed.
npm test -- tests/pdf/pdf-viewer-navigation-latency.test.js tests/pdf/pdf-viewer-messages.test.js tests/pdf/pdf-viewer-fit-layout.test.js tests/pdf/pdf-viewer-page-indicator.test.js --reporter=verbose

npm run lint
npm run typecheck
npm run typecheck:boundaries
npm run check:repo-structure
npm run check:reader-engine-composition
npm run test:profiles
npm run test:benchmarks
npm run test:pdf-corpus
npm run build
npm run test:e2e:local -- tests/e2e/pdf-navigation-latency.e2e.js tests/e2e/pdf-start-page.e2e.js --project=extension --workers=1 --output=artifacts/pdf-navigation/browser-final

# Frozen-build native capture, using the already installed Linux tools/sharp loader:
wsl -d Ubuntu -- bash /mnt/f/Github/PageNarrator/artifacts/pdf-navigation/run-capture.sh
npm run build:website

# Final full suite:
npm test -- --reporter=json --outputFile=artifacts/pdf-navigation/full-final-tests.json
```

An independent code review caught the protected-highlight and queued-layout races;
both were fixed and regression-tested. No outstanding code findings remained.

The initial full run reported 45,450 passed, one failed, four skipped. The failure
was the source-bound screenshot provenance check invalidated by this viewer
change, not a pre-existing failure. It was addressed through real recapture rather
than editing recorded hashes. The starting whole-checkout suite was not run; the
starting focused 56-test set passed.

Existing opt-in skips: fixed PDF definition-of-done benchmark, all100 acceptance,
real open PDF corpus highlighting, and the configured Summer2026 local corpus.
No skip or quality-gate configuration was changed.
The separate original-facade PDF corpus run passed 124 tests with one existing
opt-in local-corpus skip: 1,106 documents opened/closed, 1,086 unique inputs, no
retained documents or backend errors, and unchanged source pins. Profiles passed
56 tests across eight files; the Node benchmark suite passed 41 tests, none skipped.

### Final results

* Full default suite: **45,470 passed, 0 failed, 4 skipped**, 498 test files.
  This includes concurrent unrelated tests added to the shared checkout during
  the task; it is the result of the final working-tree run, not a clean-HEAD run.
* Focused viewer/navigation/message/layout checks: **26 passed**, four files,
  including all eleven new deterministic regressions.
* Final built-extension Playwright run: **7 passed**, including both new
  throttled navigation cases and five existing narration/start-position journeys.
* Profiles: **56 passed**. Node benchmarks: **41 passed**. Original PDF corpus:
  **124 passed, 1 existing skip**, with every opened document closed.
* Full lint, both TypeScript checks, repository structure, reader composition,
  extension build, website build, and `git diff --check`: passed.
* Media source freshness: final source hash matches the actual capture provenance;
  the full suite's screenshot checks pass.

No local implementation blocker remains. The reporter's exact PDF/device,
physical low-end hardware performance, heavy scanned/image PDFs, and cancellation
of parser work already executing in the worker remain unverified/unchanged as
described above. No gates, skips, or existing assertions were weakened.
