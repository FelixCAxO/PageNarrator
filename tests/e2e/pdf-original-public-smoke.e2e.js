import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { launchExtensionContext, navigatePdfViewer } from './extension-fixture.js';

// Versioned public inputs are cached locally; enabling this lane requires them.
// This checks packaged parsing/viewer behavior, not transcription or timing quality.
for (const id of ['2604.17745v2', '2604.19299v1', '2604.19638v1']) {
  test(`packaged original PDF viewer reads and selects public input ${id}`, async ({}, testInfo) => {
    test.skip(process.env.PN_PDF_ORIGINAL_VIEWER_CORPUS !== '1', 'Set PN_PDF_ORIGINAL_VIEWER_CORPUS=1 with the cached versioned public PDFs.');
    test.setTimeout(240_000);
    const directory = process.env.PN_PDF_ORIGINAL_VIEWER_CORPUS_DIR || '.cache/pdf-corpus';
    const bytes = await readFile(path.resolve(directory, `${id}.pdf`));
    const report = { id, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      workers: [], originalParserLoaded: false, pages: [], errors: [], externalRequests: [] };
    const server = createServer((request, response) => {
      if (request.url !== '/document.pdf') { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length });
      response.end(bytes);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let cleanup = async () => {};
    try {
      const launched = await launchExtensionContext({ testInfo, hostPermissions: ['http://127.0.0.1/*'] });
      cleanup = launched.cleanup;
      const { context } = launched;
      context.on('request', request => {
        if (/^https?:/.test(request.url()) && !request.url().startsWith(`${origin}/`)) report.externalRequests.push(request.url());
      });
      const page = await context.newPage();
      page.on('worker', worker => report.workers.push(worker.url()));
      page.on('pageerror', error => report.errors.push(error.message));
      page.on('requestfinished', request => {
        if (request.url().endsWith('/assets/pdf-engine/pdf.wasm')) report.originalParserLoaded = true;
      });
      const started = performance.now();
      await navigatePdfViewer(page, `${origin}/document.pdf`);
      await expect(page.locator('[data-page-number="1"] .textLayer')).not.toBeEmpty({ timeout: 60_000 });
      report.firstSelectablePageMs = performance.now() - started;
      const tabId = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
      const worker = context.serviceWorkers()[0];
      const metadata = await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: 'getPdfStreamMetadata', startPage: 1 }), tabId);
      expect(metadata.ok).toBe(true);
      expect(metadata.pageCount).toBeGreaterThanOrEqual(3);
      report.pageCount = metadata.pageCount;
      for (const pageNumber of [1, 3, metadata.pageCount]) {
        const pageStarted = performance.now();
        await page.locator('#pdf-page-input').fill(String(pageNumber));
        await page.locator('#pdf-page-input').dispatchEvent('change');
        const layer = page.locator(`[data-page-number="${pageNumber}"] .textLayer`);
        await expect(layer).not.toBeEmpty({ timeout: 60_000 });
        const selectableMs = performance.now() - pageStarted;
        const result = await worker.evaluate(({ tabId, instanceToken, pageNumber }) => chrome.tabs.sendMessage(tabId,
          { type: 'getPdfChunk', instanceToken, streamId: `public-${pageNumber}`, startPage: pageNumber, count: 1 }),
        { tabId, instanceToken: metadata.instanceToken, pageNumber });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        const chunk = result.value || result.chunks?.[0];
        expect(chunk?.pageNumber).toBe(pageNumber);
        expect(chunk?.speech?.length).toBeGreaterThan(20);
        const highlight = await worker.evaluate(({ tabId, chunk }) => chrome.tabs.sendMessage(tabId,
          { type: 'highlightChunk', anchorId: chunk.anchorId, text: chunk.anchorText,
            chunkText: chunk.speech, domWordOffset: chunk.domWordOffset }), { tabId, chunk });
        expect(highlight.ok).toBe(true);
        const selectedText = await layer.evaluate(layer => {
          const span = [...layer.querySelectorAll('span')].find(span => span.firstChild?.nodeType === Node.TEXT_NODE && span.textContent.trim().length > 3);
          if (!span) return null;
          const range = document.createRange(); range.selectNodeContents(span);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          return selection.toString().replace(/\s+/g, ' ').trim();
        });
        expect(selectedText?.length).toBeGreaterThan(3);
        const selection = await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: 'getPdfSelection' }), tabId);
        expect(selection.ok).toBe(true);
        expect(selection.selection).toMatchObject({ pageNumber, text: selectedText });
        report.pages.push({ pageNumber, selectableMs, chunkAndHighlightMs: performance.now() - pageStarted,
          speechCharacters: chunk.speech.length, selectedCharacters: selectedText.length,
          canvases: await page.locator('.pdf-page canvas').count() });
      }
      expect(report.originalParserLoaded).toBe(true);
      expect(report.workers.some(url => url.includes('pdf.worker'))).toBe(true);
      expect(report.errors).toEqual([]);
      expect(report.externalRequests).toEqual([]);
    } finally {
      await testInfo.attach('original-pdf-public-smoke', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
      await cleanup();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
