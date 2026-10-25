import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { privateOcrFixturePath, readPrivateOcrFixture } from '../../scripts/lib/ocr-private-fixtures.mjs';
import { launchExtensionContext, getExtensionId, resolveExtensionDir } from './extension-fixture.js';
import { ocrWordErrorRate, isOcrWordInRegion, validateOcrReferenceRegions } from '../helpers/ocr-word-error-rate.js';
import { measureOcrReadingOrder } from '../helpers/ocr-reading-order.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';

test('photographed PDF corpus measures real viewer OCR against manually transcribed regions', async ({}, testInfo) => {
  test.skip(!process.env.PN_OCR_QUALITY_PDF, 'Set PN_OCR_QUALITY_PDF to the photographed corpus source.');
  test.setTimeout(600_000);
  const manifestPath = process.env.PN_OCR_MANIFEST || privateOcrFixturePath('photo-corpus.json');
  const manifest = JSON.parse(await (process.env.PN_OCR_MANIFEST
    ? readFile(manifestPath, 'utf8') : readPrivateOcrFixture('photo-corpus.json', 'utf8')));
  const bytes = await readFile(process.env.PN_OCR_QUALITY_PDF);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.sourceSha256);
  const split = process.env.PN_OCR_SPLIT || 'held-out';
  expect(['development', 'held-out']).toContain(split);
  const selected = manifest.pages.filter((entry) => entry.split === split);
  const report = { split, sourceSha256: manifest.sourceSha256, startedAt: new Date().toISOString(),
    viewerSha256: createHash('sha256').update(await readFile(`${resolveExtensionDir()}/assets/pdfViewer.js`)).digest('hex'),
    pages: [], missingReferences: [], externalRequests: [], highlightFailures: [], status: 'incomplete',
    maximumLatencyRatio: null, highlightScope: 'Every spoken token in the complete page, requested as one large chunk' };
  const baseline = process.env.PN_OCR_BASELINE_REPORT
    ? JSON.parse(await readFile(process.env.PN_OCR_BASELINE_REPORT, 'utf8')) : null;
  if (baseline) {
    expect(baseline.sourceSha256).toBe(manifest.sourceSha256);
    expect(baseline.split).toBe(split);
  }
  const server = createServer((_, response) => {
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length });
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let cleanup = async () => {};
  try {
    const launched = await launchExtensionContext({ hostPermissions: ['http://127.0.0.1/*'] });
    cleanup = launched.cleanup;
    const { context } = launched;
    context.on('request', (request) => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:')) report.externalRequests.push(request.url());
    });
    const id = await getExtensionId(context);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/src/pdf-viewer.html?src=${encodeURIComponent(`http://127.0.0.1:${server.address().port}/book.pdf`)}`);
    await expect(page.locator('#pdf-status')).toContainText(`${manifest.sourcePageCount} page${manifest.sourcePageCount === 1 ? '' : 's'} loaded`, { timeout: 60_000 });
    const worker = context.serviceWorkers()[0];
    const tabId = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const metadata = await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId,
      { type: 'getPdfStreamMetadata', startPage: 1 }), tabId);
    expect(metadata.ok).toBe(true);
    for (const entry of selected) {
      let reference, referencePath;
      try {
        const referenceFile = entry.referenceFile || `tests/fixtures/ocr/photo-page-${entry.page}.json`;
        referencePath = referenceFile.startsWith('tests/fixtures/ocr/')
          ? privateOcrFixturePath(referenceFile) : referenceFile;
        const referenceBytes = await readFile(referencePath);
        expect(createHash('sha256').update(referenceBytes).digest('hex')).toBe(entry.referenceSha256);
        reference = JSON.parse(referenceBytes);
      }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        (report.missingReferenceFiles ||= []).push({ page: entry.page, path: referencePath, code: error.code });
      }
      if (reference?.referenceStatus !== 'transcribed') {
        report.missingReferences.push(entry.page);
        continue;
      }
      validateOcrReferenceRegions(reference.regions);
      const started = performance.now();
      const result = await worker.evaluate(({ tabId, instanceToken, startPage }) => chrome.tabs.sendMessage(tabId,
        { type: 'getPdfChunk', instanceToken, streamId: `quality-${startPage}`, startPage, count: 1 }),
      { tabId, instanceToken: metadata.instanceToken, startPage: entry.page });
      const elapsedMs = performance.now() - started;
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const chunk = result.value || result.chunks?.[0];
      expect(chunk?.pageNumber).toBe(entry.page);
      const highlight = await worker.evaluate(({ tabId, chunk }) => chrome.tabs.sendMessage(tabId,
        { type: 'highlightChunk', anchorId: chunk.anchorId, text: chunk.anchorText,
          chunkText: chunk.speech, domWordOffset: chunk.domWordOffset }), { tabId, chunk });
      expect(highlight.ok).toBe(true);
      const layerLocator = page.locator(`[data-pagenarrator-id="pdf-page-${entry.page}"] .textLayer[data-ocr="true"]`);
      await expect(layerLocator).toBeAttached({ timeout: 10_000 });
      const words = await layerLocator.evaluate((layer) => {
        const area = layer.getBoundingClientRect();
        return [...layer.querySelectorAll('span')].map((span) => {
          const box = span.getBoundingClientRect();
          return { text: span.textContent.trim(), order: span.getAttribute('data-pagenarrator-pdf-order'),
            narrated: span.getAttribute('data-pagenarrator-pdf-narrated'),
            x: (box.left + box.width / 2 - area.left) / area.width,
            y: (box.top + box.height / 2 - area.top) / area.height };
        });
      });
      expect(words.length).toBeGreaterThan(0);
      const complete = await worker.evaluate(({ tabId, instanceToken, startPage }) => chrome.tabs.sendMessage(tabId,
        { type: 'getPdfChunk', instanceToken, streamId: `quality-full-${startPage}`, startPage, count: 1,
          speechChunkOptions: { maxLen: 100000, targetMinLen: 100000 } }),
      { tabId, instanceToken: metadata.instanceToken, startPage: entry.page });
      expect(complete.ok).toBe(true);
      const fullChunk = complete.value || complete.chunks?.[0];
      expect(fullChunk.pageNumber).toBe(entry.page);
      // Chunk splitting normalizes anchor whitespace; an unsplit page retains line breaks.
      expect(fullChunk.anchorText.replace(/\s+/g, ' ').trim()).toBe(chunk.anchorText.replace(/\s+/g, ' ').trim());
      expect(fullChunk.speech.length).toBeLessThan(100000);
      const fullHighlight = await worker.evaluate(({ tabId, chunk }) => chrome.tabs.sendMessage(tabId,
        { type: 'highlightChunk', anchorId: chunk.anchorId, text: chunk.anchorText,
          chunkText: chunk.speech, domWordOffset: chunk.domWordOffset }), { tabId, chunk: fullChunk });
      expect(fullHighlight.ok).toBe(true);
      const regions = reference.regions.map((region) => {
        const text = words.filter((word) => isOcrWordInRegion(word, region))
          .map((word) => word.text).join(' ');
        // Ignore discretionary/compound hyphens consistently on both sides; no spelling correction.
        const score = ocrWordErrorRate(region.text.replace(/[-–]/g, ''), text.replace(/[-–]\s*/g, ''));
        return { ...region, recognized: text, ...score, ...(region.kind === 'table' && Array.isArray(region.rows) ? { rowOrder: measureOcrReadingOrder(text, region.rows) } : {}) };
      });
      const measurement = { page: entry.page, elapsedMs, referenceSha256: entry.referenceSha256,
        regions, words, chunk: fullChunk, highlightedTokens: 0, spokenTokens: 0, latencyRatio: null };
      report.pages.push(measurement);
      const tokens = tokenizeSpokenWords(fullChunk.speech);
      measurement.spokenTokens = tokens.length;
      for (const [index, token] of tokens.entries()) {
        const response = await worker.evaluate(({ tabId, index }) => chrome.tabs.sendMessage(tabId,
          { type: 'highlightWord', index }), { tabId, index });
        expect(response.ok).toBe(true);
        const marked = await page.evaluate(() => [...CSS.highlights.get('pagenarrator-word-0') || []]
          .map((range) => range.toString()).join(''));
        if (!marked) measurement.emptyHighlight = await page.evaluate(() =>
          [...CSS.highlights.get('pagenarrator-word-0') || []].map((range) => ({
            connected: range.startContainer.isConnected, startOffset: range.startOffset,
            endOffset: range.endOffset, node: range.startContainer.nodeName,
            parent: range.startContainer.parentElement?.className,
          })));
        if (marked.replace(/[-\s]/g, '').toLowerCase() === token.text.replace(/-/g, '').toLowerCase()) {
          measurement.highlightedTokens++;
        } else {
          report.highlightFailures.push({ page: entry.page, index, expected: token.text, marked });
        }
      }
      if (baseline) {
        const prior = baseline.pages.find((p) => p.page === entry.page);
        expect(prior?.elapsedMs).toBeGreaterThan(0);
        measurement.latencyRatio = elapsedMs / prior.elapsedMs;
      }
      console.log('OCR quality page', entry.page, Math.round(elapsedMs), regions.filter((r) => r.kind === 'prose')
        .map((r) => ({ errors: r.errors, words: r.referenceWords })));
    }
    expect(report.missingReferences, 'Missing references must never count as passing samples').toEqual([]);
    const prose = report.pages.flatMap((entry) => entry.regions).filter((region) => region.kind === 'prose');
    report.proseWer = prose.length ? prose.reduce((sum, region) => sum + region.errors, 0)
      / prose.reduce((sum, region) => sum + region.referenceWords, 0) : null;
    const tables = report.pages.flatMap(entry => entry.regions).filter(region => region.kind === 'table');
    expect(prose.length + tables.length, 'At least one scored region is required').toBeGreaterThan(0);
    report.tableWer = tables.length ? tables.reduce((sum, r) => sum + r.errors, 0) / tables.reduce((sum, r) => sum + r.referenceWords, 0) : null;
    expect(report.externalRequests).toEqual([]);
    expect(report.highlightFailures, 'Every checked spoken token must map to its printed spans').toEqual([]);
    if (baseline) {
      report.maximumLatencyRatio = Math.max(...report.pages.map((p) => p.latencyRatio));
      expect(report.maximumLatencyRatio).toBeLessThanOrEqual(manifest.targets.maximumLatencyRatio);
    }
    if (prose.length) expect(report.proseWer).toBeLessThanOrEqual(manifest.targets.heldOutProseWer);
    if (tables.length && manifest.targets.tableWer !== undefined) {
      expect(report.tableWer).toBeLessThanOrEqual(manifest.targets.tableWer);
      for (const region of tables) {
        expect(region.rowOrder?.length).toBeGreaterThan(0);
        expect(region.rowOrder.every(row => row.unique && row.inOrder)).toBe(true);
      }
    }
    report.status = baseline ? 'passed-measured-scope' : 'quality-passed-latency-unmeasured';
  } catch (error) {
    report.status = 'failed';
    report.failure = error.message;
    throw error;
  } finally {
    await writeFile(testInfo.outputPath('ocr-quality.json'), JSON.stringify(report, null, 2));
    await cleanup();
    await new Promise((resolve) => server.close(resolve));
  }
});
