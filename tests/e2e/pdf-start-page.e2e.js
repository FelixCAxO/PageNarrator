import { expect, test } from '@playwright/test';
import { buildPdfBytes } from '../helpers/pdf-test-generator.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';
import { getDomWordIndexForSpeechWord } from '../../src/lib/reading-model.js';
import {
  launchExtensionContext,
  openExtensionPage,
  openPdfViewer,
  seedFlowTestFlags,
  seedReadableTabTarget,
  startReadFromToolbarPopup,
} from './extension-fixture.js';

// Every page carries distinct marker text, so the first highlighted page shows where a read started.
function createNumberedPdfDataUrl(pageCount) {
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    items: [0, 1, 2, 3].map((line) => ({
      text: `Marker page ${index + 1} line ${line + 1} reads a complete sentence for narration.`,
      x: 54,
      y: 700 - line * 24,
    })),
  }));
  return `data:application/pdf;base64,${Buffer.from(buildPdfBytes(pages)).toString('base64')}`;
}

async function openNumberedPdf(context, pageCount, source = createNumberedPdfDataUrl(pageCount)) {
  const pdfPage = await openPdfViewer(context, source);
  await expect(pdfPage.locator('#pdf-status')).toContainText(`${pageCount} pages loaded`, { timeout: 15_000 });
  await seedReadableTabTarget(context, pdfPage, { allowActiveExtensionTab: true });
  // Records each page the chunk highlight moves to, starting from the first one.
  await pdfPage.evaluate(() => {
    window.__pnHighlightedPages = [];
    let requestedPage = null;
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'highlightChunk') requestedPage = Number(message.anchorId?.match(/^pdf-page-(\d+)$/)?.[1]) || null;
      return false;
    });
    const setHighlight = CSS.highlights.set.bind(CSS.highlights);
    CSS.highlights.set = (name, highlight) => {
      const result = setHighlight(name, highlight);
      if (name !== 'pagenarrator-chunk') return result;
      const [range] = highlight || [];
      const node = range?.startContainer;
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      const pageNumber = Number(element?.closest?.('[data-page-number]')?.dataset?.pageNumber) || 0;
      if (pageNumber !== requestedPage) return result;
      requestedPage = null;
      if (pageNumber && window.__pnHighlightedPages.at(-1) !== pageNumber) window.__pnHighlightedPages.push(pageNumber);
      return result;
    };
  });
  return pdfPage;
}

// Scrolls like a reader who stops with the target page filling the view below a sliver of the page above.
async function scrollViewerToPage(pdfPage, pageNumber) {
  await pdfPage.evaluate((target) => {
    const pageEl = document.querySelector(`[data-page-number="${target}"]`);
    window.scrollTo({ top: pageEl.getBoundingClientRect().top + window.scrollY - 60, behavior: 'instant' });
  }, pageNumber);
  await expect(pdfPage.locator('#pdf-page-input')).toHaveValue(String(pageNumber));
}

function getEngineState(context) {
  return context.serviceWorkers()[0].evaluate(
    () => chrome.storage.session.get('readerEngineState').then((value) => value.readerEngineState?.state || 'idle'),
  );
}

async function playAndGetStartPage(context, pdfPage, { fromStart = false } = {}) {
  // Record rendered narration highlights; layout can reapply the previous
  // read's final range while the user opens the toolbar popup to start again.
  const getPlayedChunks = () => context.serviceWorkers()[0].evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'getFlowLog' }).catch(() => null);
    return (response?.log || []).filter((event) => event.kind === 'chunk_play');
  });
  const previousPlayCount = (await getPlayedChunks()).length;
  await pdfPage.evaluate(() => { window.__pnHighlightedPages = []; });
  await startReadFromToolbarPopup(context, pdfPage, { fromStart });
  await expect.poll(() => pdfPage.evaluate(() => window.__pnHighlightedPages.length), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await getPlayedChunks()).length, { timeout: 30_000 }).toBeGreaterThan(previousPlayCount);
  const speechText = (await getPlayedChunks())[previousPlayCount].speechText;
  const spokenPage = Number(speechText.match(/Marker page (\d+)/)?.[1]);
  const highlightedPage = await pdfPage.evaluate(() => window.__pnHighlightedPages[0]);
  console.log(`[pdf-start] ${JSON.stringify({ previousPlayCount, spokenPage, highlightedPage, speechText })}`);
  expect(highlightedPage).toBe(spokenPage);
  return highlightedPage;
}

async function stopReading(context) {
  const popup = await openExtensionPage(context, 'popup');
  await popup.locator('#popup-stop').click();
  await expect.poll(() => getEngineState(context), { timeout: 10_000 }).toMatch(/idle|finished/);
  await popup.close();
}

test('starts a PDF read on the page the reader scrolled to', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    await seedFlowTestFlags(context);
    const pdfPage = await openNumberedPdf(context, 12);
    await scrollViewerToPage(pdfPage, 7);

    expect(await playAndGetStartPage(context, pdfPage)).toBe(7);
    await stopReading(context);
  } finally {
    await cleanup();
  }
});

test('Read from start returns a stopped PDF to page 1 despite its saved position and viewport', async ({}, testInfo) => {
  const { context, cleanup } = await launchExtensionContext({ testInfo });
  try {
    await seedFlowTestFlags(context);
    const pdfPage = await openNumberedPdf(context, 12);
    await scrollViewerToPage(pdfPage, 7);
    expect(await playAndGetStartPage(context, pdfPage)).toBe(7);
    await expect.poll(() => context.serviceWorkers()[0].evaluate(() => chrome.storage.local.get(null)
      .then(all => Math.max(0, ...Object.entries(all).filter(([key]) => key.startsWith('pos:')).map(([, value]) => Number(value.pageNumber) || 0)))),
    { timeout: 15_000 }).toBeGreaterThanOrEqual(7);
    await stopReading(context);
    await scrollViewerToPage(pdfPage, 9);
    expect(await playAndGetStartPage(context, pdfPage, { fromStart: true })).toBe(1);
    await stopReading(context);
  } finally {
    await cleanup();
  }
});

test('a delayed word scroll does not undo a PDF toolbar page jump', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    await seedFlowTestFlags(context);
    const pages = [1, 2].map((pageNumber) => ({
      items: [700, 80].map((y, line) => ({
        text: `Marker page ${pageNumber} line ${line + 1} reads a complete sentence for narration.`, x: 54, y,
      })),
    }));
    const source = `data:application/pdf;base64,${Buffer.from(buildPdfBytes(pages)).toString('base64')}`;
    const pdfPage = await openNumberedPdf(context, 2, source);
    const tabId = await seedReadableTabTarget(context, pdfPage, { allowActiveExtensionTab: true });
    const send = (message) => context.serviceWorkers()[0].evaluate(
      ({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message },
    );
    const { instanceToken } = await send({ type: 'getPdfStreamMetadata', startPage: 2 });
    let lastChunk;
    for (let i = 0; i < 10; i += 1) {
      const result = await send({ type: 'getPdfChunk', instanceToken, streamId: 'last-page-scroll', startPage: 2 });
      expect(result.ok).toBe(true);
      if (result.done) break;
      lastChunk = result.value;
    }
    expect(lastChunk?.pageNumber).toBe(2);
    expect(await send({ type: 'highlightChunk', anchorId: lastChunk.anchorId, text: lastChunk.anchorText,
      chunkText: lastChunk.chunkText || lastChunk.anchorText, domWordOffset: lastChunk.domWordOffset,
      pdfNarration: lastChunk.pdfNarration })).toMatchObject({ ok: true });
    expect(await send({ type: 'highlightWord', index: getDomWordIndexForSpeechWord(lastChunk,
      tokenizeSpokenWords(lastChunk.speech).length - 1) })).toMatchObject({ ok: true });

    await pdfPage.locator('#pdf-page-input').fill('1');
    await pdfPage.locator('#pdf-page-input').press('Enter');
    await pdfPage.waitForTimeout(1100); // Let both delayed 450 ms scroll corrections run.
    await expect(pdfPage.locator('#pdf-page-input')).toHaveValue('1');
    expect(await playAndGetStartPage(context, pdfPage)).toBe(1);
    await stopReading(context);
  } finally {
    await cleanup();
  }
});

test('a saved position from an earlier read does not override the page scrolled to', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    await seedFlowTestFlags(context);
    const pdfPage = await openNumberedPdf(context, 12);
    expect(await playAndGetStartPage(context, pdfPage)).toBe(1);
    // Let narration follow onto later pages so a saved position exists past page 1.
    await expect.poll(() => pdfPage.evaluate(() => window.__pnHighlightedPages.length), { timeout: 30_000 }).toBeGreaterThan(2);
    await stopReading(context);
    const savedPositions = await context.serviceWorkers()[0].evaluate(() => chrome.storage.local.get(null)
      .then((all) => Object.entries(all).filter(([key]) => key.startsWith('pos:')).map(([, value]) => value.pageNumber)));
    expect(savedPositions.length).toBe(1);
    expect(savedPositions[0]).toBeGreaterThan(1);

    // Scrolling back above the stop point, then further down past it.
    await scrollViewerToPage(pdfPage, 2);
    expect(await playAndGetStartPage(context, pdfPage)).toBe(2);
    await stopReading(context);
    await scrollViewerToPage(pdfPage, 9);
    expect(await playAndGetStartPage(context, pdfPage)).toBe(9);
    await stopReading(context);
  } finally {
    await cleanup();
  }
});

test('after a PDF read finishes, play starts on a page scrolled to since, otherwise from page 1', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    await seedFlowTestFlags(context);
    const pdfPage = await openNumberedPdf(context, 4);

    expect(await playAndGetStartPage(context, pdfPage)).toBe(1);
    await expect.poll(() => getEngineState(context), { timeout: 60_000 }).toBe('finished');
    await expect(pdfPage.locator('#pdf-page-input')).toHaveValue('4');

    // Nothing moved since the read ended on the last page: restart from the top.
    expect(await playAndGetStartPage(context, pdfPage)).toBe(1);
    await expect.poll(() => getEngineState(context), { timeout: 60_000 }).toBe('finished');

    await scrollViewerToPage(pdfPage, 2);
    expect(await playAndGetStartPage(context, pdfPage)).toBe(2);
    await stopReading(context);
  } finally {
    await cleanup();
  }
});
