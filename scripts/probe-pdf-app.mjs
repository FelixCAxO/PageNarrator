// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development-only installed-extension proof. Never runs inference or publishes.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { launchExtensionContext, getExtensionId } from '../tests/e2e/extension-fixture.js';
import { simplePdf, stream } from '../tests/pdf-engine/fixtures.js';
import { verticalCidCffPdf } from '../tests/pdf-engine/cmap-cff-fixture.js';
import { buildPdfBytes } from '../tests/helpers/pdf-test-generator.js';
import { tinyPdfBytes } from '../tests/pdf/pdf-extraction.fixtures.js';
import { croppedRotatedSidewaysPdf, croppedRotatedUprightPdf } from '../tests/pdf-engine/app-viewer-fixtures.js';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url))), candidate = path.resolve(process.env.PN_E2E_EXTENSION_DIR || 'artifacts/engines/integrated-extension');
const output = path.join(root, 'artifacts/engines/pdf-app'), sha = value => createHash('sha256').update(value).digest('hex');
await mkdir(output, { recursive: true });
async function pins(directory) {
  const files = await readdir(directory, { recursive: true, withFileTypes: true }), result = {};
  for (const entry of files.filter(entry => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.relative(directory, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/');
    if (/\.(?:js|mjs|wasm|css|html|json)$/u.test(relative) || /^assets\/pdf-(?:data|cmaps)\//u.test(relative)) result[relative] = sha(await readFile(path.join(directory, relative)));
  }
  return result;
}
const before = await pins(candidate), cases = new Map();
cases.set('standard', buildPdfBytes([{ items: [{ text: 'Original viewer page one preserves selectable source text.', x: 54, y: 700 }] }, { items: [{ text: 'Original viewer page two preserves streaming narration.', x: 54, y: 700 }] }]));
cases.set('cropped-rotated', croppedRotatedSidewaysPdf());
cases.set('cropped-rotated-upright', croppedRotatedUprightPdf());
cases.set('vertical-cid', verticalCidCffPdf());
cases.set('repaired-source', tinyPdfBytes());
cases.set('raster-only', simplePdf('q 200 0 0 200 40 500 cm /I Do Q', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [stream(Uint8Array.of(0, 255, 255, 0), '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8')] }));
if (process.env.PN_PDF_FIXTURE_DIR) for (const id of ['2606.23670v1', '2604.25611v1']) cases.set(`real-${id}`, await readFile(path.join(process.env.PN_PDF_FIXTURE_DIR, `${id}.pdf`)));
// Independent MuPDF metadata counts; original source bytes stay pinned by the strict100 report.
const symbolSources = {
  'symbol-2604.23575v2': { pages: 25, symbols: ['\uf09b'] },
  'symbol-2604.20398v1': { pages: 34, symbols: ['\ufffc'] },
  'symbol-2606.24040v1': { pages: 7, symbols: ['\uf2b6', '\uf8d2'] },
};
if (process.env.PN_PDF_SYMBOL_PROOF === '1') {
  if (!process.env.PN_PDF_FIXTURE_DIR) throw new Error('Actual symbol proof requires PN_PDF_FIXTURE_DIR.');
  for (const id of Object.keys(symbolSources)) cases.set(id, await readFile(path.join(process.env.PN_PDF_FIXTURE_DIR, `${id.slice(7)}.pdf`)));
}
const retired = /pdfjs|pdf\.worker\.mjs|\/ort-wasm[^/]*\.(?:m?js|wasm)|\/tesseract[^/]*\.js|\/espeak[^/]*\.(?:m?js|wasm)|\/transformers(?:\.min)?\.js/iu;
const errors = [], requests = [], forbiddenRequests = [], records = [], requestFailures = [], httpErrors = [];
let activeCase = null, phase = 'startup';
const server = createServer((request, response) => { const match = /^\/([a-z0-9.-]+)\.pdf$/u.exec(new URL(request.url, 'http://127.0.0.1').pathname), bytes = match && cases.get(match[1]);
  if (!bytes) { response.writeHead(404); response.end(); return; } response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length, 'Access-Control-Allow-Origin': '*' }); response.end(bytes); });
await new Promise(done => server.listen(0, '127.0.0.1', done));
let launched, failure, copiedPinsMatch = false, profileClosed = false;
try {
  launched = await launchExtensionContext({ extensionDir: candidate, hostPermissions: ['http://127.0.0.1/*'] });
  const { context } = launched, copied = await pins(launched.extensionDir);
  copiedPinsMatch = Object.entries(before).every(([name, value]) => name === 'manifest.json' || copied[name] === value);
  if (!copiedPinsMatch) throw new Error('Installed runtime/data differs from the frozen candidate.');
  context.on('request', request => { requests.push(request.url()); if (retired.test(request.url())) forbiddenRequests.push(request.url()); });
  context.on('requestfailed', request => requestFailures.push({ id: activeCase, phase, url: request.url(), failure: request.failure()?.errorText }));
  context.on('response', response => { if (response.status() >= 400) httpErrors.push({ id: activeCase, phase, url: response.url(), status: response.status() }); });
  await context.route(url => retired.test(url.href), route => route.abort('blockedbyclient'));
  const extensionId = await getExtensionId(context); let [worker] = context.serviceWorkers(); if (!worker) worker = await context.waitForEvent('serviceworker');
  for (const [id, bytes] of cases) {
    activeCase = id; phase = 'navigation';
    const page = await context.newPage(), pageErrors = [], consoleMessages = [], beforeRequest = requests.length;
    page.on('pageerror', error => { errors.push({ id, message: error.message }); pageErrors.push(error.message); });
    page.on('console', message => { if (['warning', 'error'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text() }); });
    await page.addInitScript(() => {
      const OriginalWorker = window.Worker; window.__pnPdfWorkers = { opened: 0, closed: 0, urls: [] };
      window.Worker = class extends OriginalWorker { constructor(url, settings) { super(url, settings); window.__pnPdfWorkers.opened++; window.__pnPdfWorkers.urls.push(String(url)); } terminate() { window.__pnPdfWorkers.closed++; return super.terminate(); } };
    });
    const sourceUrl = `http://127.0.0.1:${server.address().port}/${id}.pdf`, started = performance.now(); let record, loadedMs, firstSourceTextMs;
    try {
      await page.goto(`chrome-extension://${extensionId}/src/pdf-viewer.html?src=${encodeURIComponent(sourceUrl)}`);
      await expect(page.locator('#pdf-status')).toContainText('loaded', { timeout: 20000 });
      loadedMs = performance.now() - started; phase = 'source-readiness';
      await expect.poll(() => page.locator('.pdf-page canvas').count(), { timeout: 20000 }).toBeGreaterThan(0);
      if (id !== 'raster-only') {
        await expect.poll(() => page.locator('.textLayer span').count(), { timeout: 20000 }).toBeGreaterThan(0);
        firstSourceTextMs = performance.now() - started;
      }
      await expect.poll(() => page.evaluate(() => {
        const canvas = document.querySelector('.pdf-page canvas'), pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let at = 0; at < pixels.length; at += 4) if (pixels[at] < 220 && pixels[at + 1] < 220 && pixels[at + 2] < 220) return true; return false;
      }), { timeout: 20000 }).toBe(true);
      await page.bringToFront();
      const tabId = await page.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0]?.id));
      if (!tabId) throw new Error('Installed PDF viewer tab was not found.');
      phase = 'viewer-contracts';
      const send = message => worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });
      const expectedPageCount = symbolSources[id]?.pages ?? (id === 'standard' ? 2 : id === 'real-2606.23670v1' ? 15 : id === 'real-2604.25611v1' ? 36 : 1);
      const metadata = await send({ type: 'getPdfStreamMetadata' }); if (!metadata.ok || metadata.pageCount !== expectedPageCount) throw new Error(`Viewer metadata mismatch: ${JSON.stringify(metadata)}`);
      const visual = await page.evaluate(() => {
        const canvas = document.querySelector('.pdf-page canvas'), context = canvas.getContext('2d'), pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; let ink = 0;
        for (let at = 0; at < pixels.length; at += 4) if (pixels[at] < 220 && pixels[at + 1] < 220 && pixels[at + 2] < 220) ink++;
        return { width: canvas.width, height: canvas.height, ink, text: [...document.querySelectorAll('.textLayer span')].map(span => span.textContent).join(' '), spans: document.querySelectorAll('.textLayer span').length,
          fontFamilies: [...document.fonts].map(face => face.family) };
      });
      if (!visual.ink) throw new Error('Installed viewer painted no source ink.');
      if (id === 'standard') {
        const chunk = await send({ type: 'getPdfChunk', streamId: 'original-app-start2', instanceToken: metadata.instanceToken, startPage: 2 });
        if (!chunk.ok || chunk.value?.pageNumber !== 2 || !chunk.value.speech.includes('page two preserves streaming')) throw new Error(`Native viewer streaming mismatch: ${JSON.stringify(chunk)}`);
        const stale = await send({ type: 'getPdfChunk', streamId: 'old-app', instanceToken: 'stale-instance', startPage: 1 }); if (stale.code !== 'stale_pdf_stream') throw new Error('Stale native stream was accepted.');
        await send({ type: 'closePdfChunkStream', streamId: 'original-app-start2', instanceToken: metadata.instanceToken });
        await page.locator('#pdf-rotate-right-btn').click();
        await expect.poll(() => page.locator('.pdf-page canvas').first().evaluate(canvas => canvas.width / canvas.height)).toBeGreaterThan(1);
        await page.locator('#pdf-rotate-left-btn').click();
        await expect.poll(() => page.locator('.pdf-page canvas').first().evaluate(canvas => canvas.width / canvas.height)).toBeLessThan(1);
      }
      let selected = null, sourceSelection = null;
      if (id !== 'raster-only') {
        await expect.poll(() => page.locator('.textLayer span').count()).toBeGreaterThan(0);
        sourceSelection = await page.evaluate(id => {
          const spans = [...document.querySelectorAll('.textLayer span')], span = id === 'real-2604.25611v1' ? spans.find(span => span.style.fontFamily.includes('Local') && span.hasAttribute('data-pagenarrator-pdf-order'))
            : id.startsWith('symbol-') ? spans.find(span => span.hasAttribute('data-pagenarrator-pdf-order') && /\p{L}/u.test(span.textContent)) : spans[0];
          if (!span) throw new Error('The installed standard source font did not select a local face.');
          const range = document.createRange(); range.selectNodeContents(span); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          const rect = range.getBoundingClientRect();
          return { text: selection.toString(), sourceIndex: span.getAttribute('data-pagenarrator-pdf-source-index'), order: span.getAttribute('data-pagenarrator-pdf-order'),
            width: rect.width, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, fontFamily: getComputedStyle(span).fontFamily };
        }, id);
        selected = await send({ type: 'getPdfSelection' });
        if (!sourceSelection.text || sourceSelection.width <= 0 || !selected.ok || !JSON.stringify(selected).includes(sourceSelection.text)) throw new Error(`Native selectable layer mismatch: ${JSON.stringify({ sourceSelection, selected })}`);
        if (sourceSelection.sourceIndex === null) throw new Error('Native source association was lost.');
        if (id === 'cropped-rotated') {
          if (sourceSelection.order !== null) throw new Error('Sideways source text acquired fabricated automatic narration order.');
        } else if (sourceSelection.order === null) throw new Error('Native reading-order association was lost.');
      } else if (visual.spans) throw new Error('Image-only native page fabricated selectable text.');
      if (['standard', 'real-2604.25611v1'].includes(id) && (!visual.fontFamilies.some(name => name.endsWith('Local')) || !sourceSelection?.fontFamily.includes('Local'))) throw new Error('Installed local-font alias/source selection was not exercised.');
      if (id === 'vertical-cid' && visual.spans !== 5) throw new Error('Vertical source glyph associations changed.');
      const recognizedSourceSelections = []; let symbolNarration = null;
      if (symbolSources[id]) {
        for (const symbol of symbolSources[id].symbols) {
          const native = await page.evaluate(symbol => {
            const spans = [...document.querySelector('.pdf-page').querySelectorAll('.textLayer span')], span = spans.find(span => span.textContent.includes(symbol));
            if (!span) throw new Error(`Documented source symbol ${symbol.codePointAt(0).toString(16)} is missing.`);
            const start = span.textContent.indexOf(symbol), range = document.createRange(); range.setStart(span.firstChild, start); range.setEnd(span.firstChild, start + symbol.length);
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); const rect = range.getBoundingClientRect();
            return { text: selection.toString(), sourceIndex: span.getAttribute('data-pagenarrator-pdf-source-index'), order: span.getAttribute('data-pagenarrator-pdf-order'),
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, fontFamily: getComputedStyle(span).fontFamily };
          }, symbol);
          const reply = await send({ type: 'getPdfSelection' });
          if (native.text !== symbol || native.sourceIndex === null || native.order !== null || native.rect.width <= 0 || native.rect.height <= 0 || !reply.ok || !JSON.stringify(reply).includes(symbol)) throw new Error(`Recognized nontext source selection lost its geometry/association: ${JSON.stringify({ native, reply })}`);
          recognizedSourceSelections.push({ symbol, native, reply });
        }
        const streamId = `recognized-${id}`, chunk = await send({ type: 'getPdfChunk', streamId, instanceToken: metadata.instanceToken, startPage: 1 });
        if (!chunk.ok || chunk.value?.pageNumber !== 1 || !/\p{L}/u.test(chunk.value.speech) || symbolSources[id].symbols.some(symbol => chunk.value.speech.includes(symbol))) throw new Error(`Recognized nontext symbols leaked into narrative prose: ${JSON.stringify(chunk)}`);
        symbolNarration = chunk.value.speech; await send({ type: 'closePdfChunkStream', streamId, instanceToken: metadata.instanceToken });
      }
      await page.screenshot({ path: path.join(output, `${id}.png`) });
      phase = 'teardown';
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      const lifecycle = await page.evaluate(() => ({ workers: window.__pnPdfWorkers, fonts: document.fonts.size, pages: document.querySelectorAll('.pdf-page').length }));
      if (!lifecycle.workers.opened || lifecycle.workers.opened !== lifecycle.workers.closed || lifecycle.fonts || lifecycle.pages) throw new Error(`Installed viewer teardown leaked resources: ${JSON.stringify(lifecycle)}`);
      const caseRequests = requests.slice(beforeRequest);
      if (!caseRequests.some(url => url.endsWith('/assets/pdf-engine/pdf.wasm')) || !lifecycle.workers.urls.some(url => /\/assets\/pdf\.worker-[^/]+\.js$/u.test(url))) throw new Error('Installed app did not request the original parser/Worker paths.');
      record = { id, sourceSha256: sha(bytes), sourceBytes: bytes.length, metadata, visual, selected, sourceSelection, recognizedSourceSelections, symbolNarration, lifecycle, loadedMs, firstSourceTextMs,
        firstSourceTextWithinOriginalFiveSeconds: firstSourceTextMs === undefined ? null : firstSourceTextMs - loadedMs <= 5000,
        elapsedMs: performance.now() - started, requests: caseRequests, consoleMessages, passed: pageErrors.length === 0 };
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({ status: document.querySelector('#pdf-status')?.textContent, spans: document.querySelectorAll('.textLayer span').length,
        canvases: [...document.querySelectorAll('.pdf-page canvas')].map(canvas => ({ width: canvas.width, height: canvas.height })), fonts: document.fonts.size, workers: window.__pnPdfWorkers })).catch(error => ({ failed: error.message }));
      record = { id, sourceSha256: sha(bytes), passed: false, message: error.message, phase, loadedMs, firstSourceTextMs, diagnostics, consoleMessages, requests: requests.slice(beforeRequest) };
    }
    finally { phase = 'teardown'; await page.close(); }
    records.push(record);
  }
} catch (error) { failure = error.message; }
finally {
  if (launched) {
    // Existing fixture removes only these newly-created temporary roots; validate its exact targets first.
    const temporary = path.resolve(tmpdir()), profile = path.resolve(launched.userDataDir), copyRoot = path.dirname(path.resolve(launched.extensionDir));
    if (path.dirname(profile) !== temporary || !path.basename(profile).startsWith('pagenarrator-e2e-') || path.dirname(copyRoot) !== temporary || !path.basename(copyRoot).startsWith('pagenarrator-extension-')) throw new Error('Refusing cleanup outside the created proof temporary roots.');
    await launched.cleanup(); profileClosed = true;
  }
  await new Promise(done => server.close(done));
}
const unchanged = JSON.stringify(before) === JSON.stringify(await pins(candidate)), passed = !failure && copiedPinsMatch && unchanged && profileClosed && !errors.length && !forbiddenRequests.length && !httpErrors.length && !requestFailures.some(item => item.phase !== 'teardown') && records.length === cases.size && records.every(record => record.passed);
const report = { schemaVersion: 1, scope: 'Installed original PDF viewer: fixed source cases, real chrome.runtime messages, source selection, crop/rotation, image-only painting and teardown. No OCR inference/audio/performance/release acceptance.',
  candidate, candidatePins: before, candidateUnchanged: unchanged, installedRuntimePinsMatch: copiedPinsMatch,
  testOnlyManifestChange: 'An isolated copy adds localhost fixture-server host permission; every other pinned candidate runtime/data byte is unchanged.',
  originalBackendUsed: true, productionPublicationPending: true, fullRendererAcceptance: false,
  readinessPolicy: '20-second correctness wait; original five-second failed attempt is archived and first-source timing remains diagnostic, not a performance acceptance.',
  sidewaysFixtureClassification: { id: 'cropped-rotated', sourceSha256: sha(cases.get('cropped-rotated')),
    evidence: 'tests/pdf-engine/app-adapter.test.js compares unchanged source through original parser and independent PDF.js into the same current page model.',
    expectation: 'Visible native source remains selectable with its original index; intentionally sideways text has no automatic narration order. The prior incorrect order assertion and failed report remain archived.' },
  records, requests, forbiddenRequests, requestFailures, httpErrors, errors, failure, profileClosed, passed };
const destination = path.join(output, 'report.json');
try { await copyFile(destination, path.join(output, `report-${Date.now()}.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed, cases: records.length, failures: records.filter(record => !record.passed), errors, forbiddenRequests, candidateUnchanged: unchanged, installedRuntimePinsMatch: copiedPinsMatch, profileClosed }, null, 2));
if (!passed) process.exitCode = 1;
