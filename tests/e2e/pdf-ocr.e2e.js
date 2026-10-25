import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { hasPrivateOcrFixtures, readPrivateOcrFixture } from '../../scripts/lib/ocr-private-fixtures.mjs';
import { writeFile } from 'node:fs/promises';
import { ocrWordErrorRate } from '../helpers/ocr-word-error-rate.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';
import { createReaderEnginePageHighlightController } from '../../src/lib/reader-engine-page-highlight-controller.js';
import { launchExtensionContext, getExtensionId, seedFlowTestFlags, seedRealTtsFlowFlags,
  startReadFromToolbarPopup } from './extension-fixture.js';

async function scannedPdf(imagePath = null) {
  const jpeg = imagePath ? await sharp(imagePath).resize(1200, 600, { fit: 'contain', background: 'white' }).jpeg().toBuffer() : await sharp(Buffer.from('<svg width="1200" height="600"><rect width="100%" height="100%" fill="white"/><text x="80" y="200" font-size="42" font-family="Arial">Requirements engineering begins with clear goals.</text><text x="80" y="270" font-size="42" font-family="Arial">Stakeholders describe the system they need.</text></svg>')).jpeg().toBuffer();
  const stream = 'q 600 0 0 300 0 0 cm /Im1 Do Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
  ];
  let pdf = Buffer.from('%PDF-1.4\n');
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf = Buffer.concat([pdf, Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
  });
  return Buffer.concat([pdf, Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF`)]);
}

test('historical curved photo PDF reaches real Kokoro playback from the popup', async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_REAL_MODEL !== '1', 'Set PN_E2E_REAL_MODEL=1 for real OCR-to-audio playback.');
  test.skip(!hasPrivateOcrFixtures(), 'Historical curved image unavailable: set PN_OCR_PRIVATE_FIXTURE_DIR. This skip is not a quality pass.');
  const fixtureBytes = await readPrivateOcrFixture('curved-lines.png');
  test.setTimeout(300_000);
  const { context, cleanup } = await launchExtensionContext();
  let worker;
  try {
    await seedRealTtsFlowFlags(context, { playbackSettings: {
      language: 'en', voice: 'af_heart', speed: 1, sectionPauseSeconds: 0,
      ttsPerformanceProfile: 'quality',
    } });
    const id = await getExtensionId(context);
    const page = await context.newPage();
    const bytes = await scannedPdf(fixtureBytes);
    await page.goto(`chrome-extension://${id}/src/pdf-viewer.html?src=${encodeURIComponent(`data:application/pdf;base64,${bytes.toString('base64')}`)}`);
    await expect(page.locator('#pdf-status')).toContainText('page loaded');
    worker = context.serviceWorkers()[0];
    await startReadFromToolbarPopup(context, page);
    await expect.poll(() => page.evaluate(() =>
      [...CSS.highlights.get('pagenarrator-word-0') || []].some((range) => range.toString().trim())),
    { timeout: 120_000 }).toBe(true);
    await expect.poll(async () => {
      const state = await worker.evaluate(() => chrome.storage.session.get('readerEngineState'));
      expect(state.readerEngineState?.state).not.toBe('error');
      return state.readerEngineState?.state;
    }, { timeout: 240_000 }).toBe('finished');
    const { log } = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
    const starts = log.filter((entry) => entry.kind === 'chunk_play');
    const ends = log.filter((entry) => entry.kind === 'chunk_end');
    expect(starts.map((entry) => entry.speechText).join(' ')).toContain('system requirements');
    expect(ends.length).toBe(starts.length);
    expect(ends.map((entry) => entry.chunkIndex)).toEqual(starts.map((entry) => entry.chunkIndex));
    expect(Math.max(...ends.map((entry) => Number(entry.mediaTime) || 0))).toBeGreaterThan(1);
    expect(log.some((entry) => entry.kind === 'audio_decode_latency')).toBe(true);
    expect(log.some((entry) => entry.kind === 'synthesis_failure')).toBe(false);
  } finally {
    if (worker) await writeFile(testInfo.outputPath('ocr-playback.json'), JSON.stringify(
      await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' })), null, 2));
    await cleanup();
  }
});

test('scanned PDF narration reports document pages through the real reader and popup', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    await seedFlowTestFlags(context);
    const id = await getExtensionId(context);
    const page = await context.newPage();
    // Original synthetic text keeps silent playback active for the pause/stop controls.
    // This is lifecycle coverage, not a replacement for private OCR quality evidence.
    const progressLines = [
      'Garden paths connect the library with the quiet courtyard.',
      'Evening buses stop beside the community workshop and reading room.',
      'Local volunteers label the shelves before the weekly book exchange.',
      'A paper calendar records opening hours and small repair sessions.',
      'The notice board lists activities for the coming weekend.',
      'Visitors can pause this narration and check the page number.',
      'The player keeps the document open while the controls change.',
      'Stopping returns the same popup to its ready state.',
    ];
    const progressImage = Buffer.from(`<svg width="1200" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/>${progressLines.map((text, i) => `<text x="60" y="${65 + i * 64}" font-size="30" font-family="Arial">${text}</text>`).join('')}</svg>`);
    const bytes = await scannedPdf(progressImage);
    await page.goto(`chrome-extension://${id}/src/pdf-viewer.html?src=${encodeURIComponent(`data:application/pdf;base64,${bytes.toString('base64')}`)}`);
    await expect(page.locator('#pdf-status')).toContainText('page loaded');
    // Real PDF/OCR/reader wiring, with silent synthesis to isolate progress reporting.
    const popup = await startReadFromToolbarPopup(context, page, { closePopup: false });
    await expect(popup.locator('#popup-status')).toHaveText('Reading', { timeout: 30_000 });
    await popup.locator('#popup-toggle').click();
    await expect(popup.locator('#popup-status')).toHaveText('Paused');
    await expect(popup.locator('#popup-progress')).toContainText('Page 1 of 1');
    await popup.locator('#popup-stop').click();
    await expect(popup.locator('#popup-status')).toHaveText('Ready to read');
  } finally {
    await cleanup();
  }
});

test('built viewer recognizes a raster PDF offline and emits anchored speech', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    const id = await getExtensionId(context);
    const page = await context.newPage();
    const external = [];
    context.on('request', (request) => {
      if (/^https?:/.test(request.url())) external.push(request.url());
    });
    const bytes = await scannedPdf();
    await page.goto(`chrome-extension://${id}/src/pdf-viewer.html?src=${encodeURIComponent(`data:application/pdf;base64,${bytes.toString('base64')}`)}`);
    await expect(page.locator('#pdf-status')).toContainText('page loaded');
    const worker = context.serviceWorkers()[0];
    const started = Date.now();
    const tabId = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const response = await worker.evaluate(async (tabId) => {
      const metadata = await chrome.tabs.sendMessage(tabId, { type: 'getPdfStreamMetadata', startPage: 1 });
      return chrome.tabs.sendMessage(tabId, { type: 'getPdfChunk', instanceToken: metadata.instanceToken,
        streamId: 'ocr-test', startPage: 1, count: 1 });
    }, tabId);
    console.log('OCR response', JSON.stringify(response), 'elapsedMs', Date.now() - started);
    expect(response.ok).toBe(true);
    const chunk = response.chunks?.[0] || response.value;
    expect(chunk.speech).toContain('Requirements engineering begins with clear goals');
    expect(chunk.speech).toContain('Stakeholders describe the system they need');
    expect(chunk.pageNumber).toBe(1);
    expect(chunk.anchorId).toBe('pdf-page-1');
    const highlight = await worker.evaluate(({ tabId, chunk }) => chrome.tabs.sendMessage(tabId,
      { type: 'highlightChunk', anchorId: chunk.anchorId, text: chunk.anchorText,
        chunkText: chunk.speech, domWordOffset: chunk.domWordOffset }), { tabId, chunk });
    expect(highlight.ok).toBe(true);
    await expect(page.locator('.textLayer[data-ocr="true"] span').first()).toBeAttached();
    const box = await page.locator('.textLayer[data-ocr="true"] span').first().boundingBox();
    expect(box.width).toBeGreaterThan(10);
    expect(box.height).toBeGreaterThan(5);
    const wordHighlight = await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId,
      { type: 'highlightWord', index: 0 }), tabId);
    expect(wordHighlight.ok).toBe(true);
    expect(await page.evaluate(() => [...CSS.highlights.keys()].some((key) => key.includes('word')))).toBe(true);
    const markedWord = () => page.evaluate(() => [...CSS.highlights.get('pagenarrator-word-0') || []].map((range) => range.toString()).join(''));
    await expect.poll(markedWord).toBe('Requirements');
    await page.locator('#pdf-zoom-in-btn').click();
    await expect.poll(markedWord).toBe('Requirements');
    await page.locator('#pdf-rotate-right-btn').click();
    await expect.poll(async () => page.locator('.textLayer[data-ocr="true"] span').first().getAttribute('style')).toContain('rotate(1.570');
    await expect.poll(markedWord).toBe('Requirements');
    await page.locator('#pdf-rotate-left-btn').click();
    await expect.poll(async () => page.locator('.textLayer[data-ocr="true"] span').first().getAttribute('style')).toContain('rotate(0rad)');
    const timed = await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId,
      { type: 'highlightWordPlan', plan: [{ index: 1, word: 'engineering', start: 0, end: 10 }],
        currentTime: 0, playbackRate: 1 }), tabId);
    expect(timed.ok).toBe(true);
    await expect.poll(markedWord).toBe('engineering');
    await page.screenshot({ path: 'tmp/ocr-highlight.png' });
    expect(external).toEqual([]);
  } finally {
    await cleanup();
  }
});


test('historical rating matrix diagram reads its words without reciting cells and keeps word highlights', async ({}, testInfo) => {
  test.skip(!hasPrivateOcrFixtures(), 'Historical matrix image unavailable: set PN_OCR_PRIVATE_FIXTURE_DIR. This skip is not a quality pass.');
  const fixtureBytes = await readPrivateOcrFixture('rating-matrix.png');
  const { context, cleanup } = await launchExtensionContext();
  try {
    const id = await getExtensionId(context);
    const page = await context.newPage();
    const bytes = await scannedPdf(fixtureBytes);
    await page.goto(`chrome-extension://${id}/src/pdf-viewer.html?src=${encodeURIComponent(`data:application/pdf;base64,${bytes.toString('base64')}`)}`);
    await expect(page.locator('#pdf-status')).toContainText('page loaded');
    const worker = context.serviceWorkers()[0];
    const tabId = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const response = await worker.evaluate(async (tabId) => {
      const metadata = await chrome.tabs.sendMessage(tabId, { type: 'getPdfStreamMetadata', startPage: 1 });
      return chrome.tabs.sendMessage(tabId, { type: 'getPdfChunk', instanceToken: metadata.instanceToken,
        streamId: 'rating-matrix', startPage: 1, count: 16, speechChunkOptions: { maxLen: 10000 } });
    }, tabId);
    expect(response.ok).toBe(true);
    const chunks = response.chunks || [response.value];
    const speech = chunks.map((chunk) => chunk.speech).join(' ');
    await worker.evaluate(({ tabId, chunk }) => chrome.tabs.sendMessage(tabId,
      { type: 'highlightChunk', anchorId: chunk.anchorId, text: chunk.anchorText, chunkText: chunk.speech }), { tabId, chunk: chunks[0] });
    await expect(page.locator('#pdf-status')).toHaveText('1 page loaded');
    await writeFile(testInfo.outputPath('matrix-reading.json'), JSON.stringify({ speech,
      spans: await page.locator('.textLayer span').evaluateAll((nodes) => nodes.map((node) => ({
        text: node.textContent, narrated: node.dataset.pagenarratorPdfNarrated, style: node.getAttribute('style'),
      }))),
    }, null, 2));
    await page.screenshot({ path: testInfo.outputPath('matrix-viewer.png') });
    expect(speech).toMatch(/Rating matrix/i);
    expect(speech).toMatch(/Calculate the similarity between active user and all the rest/i);
    expect(speech).toMatch(/Order users by similarity/i);
    expect(speech).not.toMatch(/\bu\s*[1-6]\b|0[.]21|0[.]10|0[.]30|0[.]08|0[.]14|\b[3-6]\b/i);
    for (const chunk of chunks) {
      const highlight = await worker.evaluate(({ tabId, chunk }) => chrome.tabs.sendMessage(tabId,
        { type: 'highlightChunk', anchorId: chunk.anchorId, text: chunk.anchorText,
          chunkText: chunk.speech, domWordOffset: chunk.domWordOffset }), { tabId, chunk });
      expect(highlight.ok).toBe(true);
      for (const [index, token] of tokenizeSpokenWords(chunk.speech).entries()) {
        const result = await worker.evaluate(({ tabId, index }) => chrome.tabs.sendMessage(tabId,
          { type: 'highlightWord', index }), { tabId, index });
        expect(result.ok, token.text).toBe(true);
        const marked = await page.evaluate(() => [...CSS.highlights.get('pagenarrator-word-0') || []]
          .map((range) => range.toString()).join(''));
        expect(marked.replace(/\s/g, '').toLowerCase()).toBe(token.text.toLowerCase());
      }
    }
    const selectedCell = await page.locator('.textLayer span').evaluateAll((nodes) => {
      const cell = nodes.find((node) => /^u1\s*$/i.test(node.textContent));
      if (!cell) throw new Error('Missing visible matrix cell');
      const range = document.createRange();
      range.selectNodeContents(cell);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      return cell.textContent.trim();
    });
    const selection = await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId,
      { type: 'getPdfSelection' }), tabId);
    expect(selection.selection.text).toBe(selectedCell);
    const selectedChunk = selection.selection.chunks[0];
    const selectionHighlighter = createReaderEnginePageHighlightController({
      sendPageMessage: (id, message) => worker.evaluate(({ id, message }) => chrome.tabs.sendMessage(id, message), { id, message }),
    });
    await selectionHighlighter.highlightChunk(tabId, selectedChunk);
    await worker.evaluate(({ tabId, index }) => chrome.tabs.sendMessage(tabId,
      { type: 'highlightWord', index }), { tabId, index: selectedChunk.domWordOffset });
    expect(await page.evaluate(() => [...CSS.highlights.get('pagenarrator-word-0') || []]
      .map((range) => range.toString()).join(''))).toBe(selectedCell);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect.poll(() => page.evaluate(() => [...CSS.highlights.get('pagenarrator-word-0') || []]
      .map((range) => range.toString()).join(''))).toBe(selectedCell);
  } finally {
    await cleanup();
  }
});

test('historical curved scanned lines retain speech order and each word highlights its own box', async ({}, testInfo) => {
  test.skip(!hasPrivateOcrFixtures(), 'Historical curved image unavailable: set PN_OCR_PRIVATE_FIXTURE_DIR. This skip is not a quality pass.');
  const fixtureBytes = await readPrivateOcrFixture('curved-lines.png');
  const referenceText = await readPrivateOcrFixture('curved-body.txt', 'utf8');
  const { context, cleanup } = await launchExtensionContext();
  try {
    const id = await getExtensionId(context);
    const page = await context.newPage();
    const bytes = await scannedPdf(fixtureBytes);
    await page.goto(`chrome-extension://${id}/src/pdf-viewer.html?src=${encodeURIComponent(`data:application/pdf;base64,${bytes.toString('base64')}`)}`);
    await expect(page.locator('#pdf-status')).toContainText('page loaded');
    const worker = context.serviceWorkers()[0];
    const tabId = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const response = await worker.evaluate(async (tabId) => {
      const metadata = await chrome.tabs.sendMessage(tabId, { type: 'getPdfStreamMetadata', startPage: 1 });
      return chrome.tabs.sendMessage(tabId, { type: 'getPdfChunk', instanceToken: metadata.instanceToken,
        streamId: 'curved-ocr', startPage: 1, count: 16, speechChunkOptions: { maxLen: 10000 } });
    }, tabId);
    expect(response.ok).toBe(true);
    const chunk = response.chunks?.[0] || response.value;
    chunk.speech = (response.chunks || [response.value]).map((part) => part.speech).join(' ');
    console.log('Curved speech', chunk.speech);
    const reference = referenceText;
    const bodyStart = chunk.speech.indexOf('The documented');
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    const quality = ocrWordErrorRate(reference, chunk.speech.slice(bodyStart));
    console.log('Curved body WER', JSON.stringify(quality));
    expect(quality.rate).toBeLessThanOrEqual(0.15);
    expect(chunk.speech).toContain('system requirements');
    expect(chunk.speech).not.toContain('requiresolution');
    expect(chunk.speech).toMatch(/goals, which document.*intentions.*concerning the system.*scenarios.*which describe concrete.*examples of achieving/s);
    const highlight = await worker.evaluate(({ tabId, chunk }) => chrome.tabs.sendMessage(tabId,
      { type: 'highlightChunk', anchorId: chunk.anchorId, text: chunk.anchorText,
        chunkText: chunk.speech, domWordOffset: chunk.domWordOffset }), { tabId, chunk });
    expect(highlight.ok).toBe(true);
    const tokens = tokenizeSpokenWords(chunk.speech);
    const marked = [];
    for (const [index, token] of tokens.entries()) {
      const result = await worker.evaluate(({ tabId, index }) => chrome.tabs.sendMessage(tabId,
        { type: 'highlightWord', index }), { tabId, index });
      expect(result.ok, `word ${index}: ${token.text}`).toBe(true);
      const word = await page.evaluate(() => [...CSS.highlights.get('pagenarrator-word-0') || []]
        .map((range) => range.toString()).join(''));
      // A dehyphenated spoken word can correctly mark two printed spans.
      expect(word.replace(/[-\s]/g, '').toLowerCase()).toBe(token.text.replace(/-/g, '').toLowerCase());
      marked.push(word);
    }
    console.log('Curved matched words', marked.length);
    await page.screenshot({ path: testInfo.outputPath('curved-highlight.png') });
  } finally {
    await cleanup();
  }
});
for (const gpuFailure of ['unavailable', 'adapter-rejection', 'model-rejection']) {
  test(`scanned PDF retains CPU OCR when WebGPU is ${gpuFailure}`, async () => {
    const { context, cleanup } = await launchExtensionContext();
    try {
      const id = await getExtensionId(context), page = await context.newPage();
      await page.addInitScript((mode) => {
        globalThis.__ocrAdapterAttempts = 0;
        globalThis.__ocrModelAttempts = 0;
        if (mode === 'model-rejection') {
          const fetch = globalThis.fetch.bind(globalThis);
          globalThis.fetch = (...args) => {
            if (String(args[0]?.url || args[0]).endsWith('/assets/ocr/tiny-det.onnx')) {
              globalThis.__ocrModelAttempts++;
              return Promise.reject(new Error('Injected model loading failure'));
            }
            return fetch(...args);
          };
          return;
        }
        Object.defineProperty(navigator, 'gpu', { configurable: true, value: mode === 'unavailable'
          ? undefined : { requestAdapter: async () => { globalThis.__ocrAdapterAttempts++; throw new Error('Injected adapter failure'); } } });
      }, gpuFailure);
      const bytes = await scannedPdf();
      await page.goto(`chrome-extension://${id}/src/pdf-viewer.html?src=${encodeURIComponent(`data:application/pdf;base64,${bytes.toString('base64')}`)}`);
      await expect(page.locator('#pdf-status')).toContainText('page loaded');
      if (gpuFailure === 'model-rejection') test.skip(!await page.evaluate(async()=>!!await navigator.gpu?.requestAdapter()),'Model-failure coverage requires a GPU adapter.');
      const tabId = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
      const worker = context.serviceWorkers()[0];
      const result = await worker.evaluate(async tabId => {
        const meta = await chrome.tabs.sendMessage(tabId, {type:'getPdfStreamMetadata',startPage:1});
        return chrome.tabs.sendMessage(tabId,{type:'getPdfChunk',instanceToken:meta.instanceToken,streamId:'gpu-fallback',startPage:1,count:1});
      }, tabId);
      expect(result.ok).toBe(true);
      if (gpuFailure === 'adapter-rejection') expect(await page.evaluate(()=>globalThis.__ocrAdapterAttempts)).toBeGreaterThan(0);
      if (gpuFailure === 'model-rejection') expect(await page.evaluate(()=>globalThis.__ocrModelAttempts)).toBeGreaterThan(0);
      const chunk = result.value || result.chunks?.[0];
      expect(chunk.speech).toContain('Requirements engineering begins with clear goals');
      expect(chunk.speech).toContain('Stakeholders describe the system they need');
      expect(await worker.evaluate(({tabId,chunk})=>chrome.tabs.sendMessage(tabId,{type:'highlightChunk',anchorId:chunk.anchorId,text:chunk.anchorText,chunkText:chunk.speech,domWordOffset:chunk.domWordOffset}),{tabId,chunk})).toMatchObject({ok:true});
      expect(await worker.evaluate(tabId=>chrome.tabs.sendMessage(tabId,{type:'highlightWord',index:0}),tabId)).toMatchObject({ok:true});
      await expect.poll(()=>page.evaluate(()=>[...CSS.highlights.get('pagenarrator-word-0')||[]].map(r=>r.toString()).join(''))).toBe('Requirements');
    } finally { await cleanup(); }
  });
}
