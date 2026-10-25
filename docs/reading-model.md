# Reading model

The toolbar popup controls reading. The offscreen engine owns speech, so closing the popup keeps playback running. See the [reader guide](reader-ui.md) for controls.

## Webpages

The popup records the active tab and asks the service worker to start the engine. An on-demand content script extracts visible text, removes navigation and repeated page furniture, preserves source anchors, and draws highlights. Its fallback walks visible text without cloning the page.

### Where a webpage read starts

Read page starts at the first visible block or saved position. A trailing block is skipped when it occupies less than 30% of the viewport and less than half its own height remains visible. A tall block that still fills the view stays included.

The engine follows the block's DOM anchor through the stream. Without an anchor, it scans a few sections and starts at the top rather than delaying first audio. Restart and finished-page reads start at the top.

### Following the reading position

`src/lib/page-highlighter-scroll-follow.js` scrolls the nearest scrollable container, including chat apps' inner containers.

- Text within 20% of an edge, capped at 160px, or covered by another element counts as off-screen.
- Forward reading places new text one-third down the view. Backward reading clears the top margin.
- Dynamically rendered pages are measured again after scrolling, with up to two corrections.
- Wheel, touch, and scroll keys outside text fields pause following for 4 seconds. The “resume here” flash always scrolls.
- Highlights reposition when inner containers scroll.

### Tables

Tables use a title section, then one section per row: “Table: <caption>. 3 columns: A, B, and C.” and “A, cell - B, cell.” Added labels are mapped with `speechWordMap` so highlights stay on source words, including after splitting or progressive playback.

A numeric diagram matrix needs at least three distinct symbolic row IDs, such as u1–u3, followed only by numbers. Automatic reading keeps the caption and surrounding prose but skips symbolic headers, IDs, and cells. Ordinary descriptive or measurement tables stay narrated. PDF/OCR geometry uses the same distinction; source text remains selectable.

### AI chat pages (ChatGPT, Claude, Gemini)

`src/lib/core/chat-transcript.js` detects message-turn markup. It reads prompts and answers with role labels such as “You said:” and “Claude said:”. The whole turn is outlined during the role label. Hidden accessibility previews, sidebars, prompt rails, message boxes, and action buttons are skipped. Repeated prompts remain.

Reading starts at the visible turn, or an earlier turn with at least 30% of the viewport or half its own height visible. When the first turn is on screen, reading starts at the top.

ChatGPT's `data-testid="conversation-turn-N"` and Claude's `aria-posinset` / `aria-setsize` expose turn numbers. Missing turns trigger a scroll and a wait of up to 2.5 seconds; unavailable turns are skipped. The stream loads later turns until the declared end or no further scrolling is possible. Restart scrolls to turn 1. Gemini has no numbers, so restart loads older history until it stops growing.

Markup was checked on 2026-09-24: ChatGPT share pages used numbered `section` turns; Claude used `user-message` / `assistant-message` in `role="article"` rows; Gemini used `user-query` / `model-response` in an `infinite-scroller`. Each had hidden labels and an inner scroller. The ChatGPT check read all 22 turns, including previously missed turns 7–17. Claude/Gemini fixtures in `tests/reading/chat-transcript-extraction.test.js` mirror those observations. Changed markup falls back to generic viewport reading.

## PDFs

The PDF viewer owns rendering, selection, navigation, and highlights. Playback stays in the toolbar. The engine requests metadata and bounded text batches from the viewer. Progress uses page counts instead of scanning the whole book. Image-only pages use local English OCR; unreadable pages return an extraction error.

### Where a PDF read starts

Read page uses the page with the largest visible share. IntersectionObserver updates that share in 5% steps; only toolbar page jumps reset its observations.

- Resume applies when the saved position belongs to that page. Scrolling from saved page 3 to page 9 starts page 9. A chunk index from another starting page is never reused. With page 1 visible, a saved position elsewhere in the PDF can still resume.
- After completion, Play uses a newly selected page. If the viewer still shows the ending page, it restarts at page 1. Finished webpage reads restart at the top.
- Chrome's built-in PDF viewer exposes no readable page or `postMessage` API; scrolling does not update its URL, and only its empty embedder frame is scriptable (checked in Chromium 148). Starting there opens PageNarrator's viewer at `#page=N` or page 1. Scroll in that viewer and press Read page to start elsewhere.

## Playback state

The engine broadcasts title, status, progress, remaining words, setup progress, and hardware path. Transcript and queue text stay in engine memory and transfer only on popup state sync; session storage does not persist them.

Resume uses the source URL and section. Back, Next, queue jumps, and resume share the same engine actions for webpages and PDFs.

## Voices and checks

Kokoro prefers WebGPU and falls back to CPU / WebAssembly. Advanced settings show the active path. Missing files download from Hugging Face. Offline use needs the same cached voice and mode; clearing or evicting files requires another download. See [hardware](requirements-hardware.md).

Tests: `tests/reading`, `tests/pdf`, `tests/speech`, `tests/reader-engine`, `tests/voice`, `tests/tts`, and packaged journeys in `tests/e2e`.
