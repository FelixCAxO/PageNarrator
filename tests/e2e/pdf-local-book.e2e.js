import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { launchExtensionContext, getExtensionId } from './extension-fixture.js';

test('local book produces speech through the built PDF viewer', async ({}, testInfo) => {
  test.skip(!process.env.PN_TEST_PDF, 'Set PN_TEST_PDF to a local book.');
  test.setTimeout(240_000);
  const bytes = await readFile(process.env.PN_TEST_PDF);
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length });
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['http://127.0.0.1/*'] });
  const report = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    startedAt: new Date().toISOString(), samples: [], externalRequests: [] };
  await mkdir('tmp/ocr-book', { recursive: true });
  try {
    context.on('request', (request) => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:')) report.externalRequests.push(request.url());
    });
    const id = await getExtensionId(context);
    const page = await context.newPage();
    const url = `http://127.0.0.1:${server.address().port}/book.pdf`;
    await page.goto(`chrome-extension://${id}/src/pdf-viewer.html?src=${encodeURIComponent(url)}`);
    await expect(page.locator('#pdf-status')).toContainText('pages loaded', { timeout: 60_000 });
    const tabId = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const worker = context.serviceWorkers()[0];
    const metadataStarted = Date.now();
    const metadata = await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId,
      { type: 'getPdfStreamMetadata', startPage: 1 }), tabId);
    report.metadataMs = Date.now() - metadataStarted;
    report.metadata = metadata;
    expect(metadata.ok).toBe(true);
    expect(report.metadataMs).toBeLessThan(8000);
    for (const startPage of [...new Set([1, 20, 100, Math.floor(metadata.pageCount / 2), metadata.pageCount - 20])]) {
      const started = Date.now();
      const result = await worker.evaluate(({ tabId, instanceToken, startPage }) => chrome.tabs.sendMessage(tabId,
        { type: 'getPdfChunk', instanceToken, streamId: `book-${startPage}`, startPage, count: 1 }),
      { tabId, instanceToken: metadata.instanceToken, startPage });
      report.samples.push({ startPage, elapsedMs: Date.now() - started, result });
      console.log(JSON.stringify(report.samples.at(-1)));
      expect(result.ok).toBe(true);
      expect(report.samples.at(-1).elapsedMs).toBeLessThan(30_000);
      expect((result.value || result.chunks?.[0])?.speech?.length).toBeGreaterThan(20);
      const chunk = result.value || result.chunks?.[0];
      const cachedStarted = Date.now();
      const cached = await worker.evaluate(({ tabId, instanceToken, startPage }) => chrome.tabs.sendMessage(tabId,
        { type: 'getPdfChunk', instanceToken, streamId: `cached-${startPage}`, startPage, count: 1 }),
      { tabId, instanceToken: metadata.instanceToken, startPage });
      report.samples.at(-1).cachedMs = Date.now() - cachedStarted;
      expect(cached.ok).toBe(true);
      expect((cached.value || cached.chunks?.[0])?.speech).toBe(chunk.speech);
      expect(report.samples.at(-1).cachedMs).toBeLessThan(1000);
      const highlight = await worker.evaluate(({ tabId, chunk }) => chrome.tabs.sendMessage(tabId,
        { type: 'highlightChunk', anchorId: chunk.anchorId, text: chunk.anchorText,
          chunkText: chunk.speech, domWordOffset: chunk.domWordOffset }), { tabId, chunk });
      expect(highlight.ok).toBe(true);
      const wordHighlight = await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId,
        { type: 'highlightWord', index: 0 }), tabId);
      console.log('word highlight', startPage, JSON.stringify(wordHighlight));
      expect(wordHighlight.ok).toBe(true);
      report.samples.at(-1).highlight = highlight;
      report.samples.at(-1).wordHighlight = wordHighlight;
      await expect(page.locator('#pdf-page-input')).toHaveValue(String(startPage));
      await expect.poll(() => page.evaluate(() => {
        const range = [...CSS.highlights.get('pagenarrator-word-0') || []][0];
        const rect = range?.getBoundingClientRect();
        return Boolean(rect && rect.top >= document.querySelector('.viewer-header').getBoundingClientRect().bottom
          && rect.bottom <= innerHeight);
      })).toBe(true);
      if (startPage === 20) await page.screenshot({ path: 'tmp/ocr-book/page-20-highlighted.png' });
    }
    expect(report.externalRequests).toEqual([]);
  } finally {
    await mkdir('tmp/ocr-book', { recursive: true });
    await writeFile('tmp/ocr-book/result.json', JSON.stringify(report, null, 2));
    await writeFile(testInfo.outputPath('ocr-book.json'), JSON.stringify(report, null, 2));
    await cleanup();
    await new Promise((resolve) => server.close(resolve));
  }
});
