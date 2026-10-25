// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development-only browser oracle. Source PDF and CID CFF outlines are original.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { verticalCidCffPdf } from '../tests/pdf-engine/cmap-cff-fixture.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url))), fixture = verticalCidCffPdf();
const output = resolve(root, 'artifacts/engines/pdf-vertical-cid-cff');
await mkdir(output, { recursive: true }); await writeFile(resolve(output, 'fixture.pdf'), fixture);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = [...(await readdir(resolve(root, 'src/pdf'))).filter(file => file.endsWith('.js')).map(file => `src/pdf/${file}`),
  'src/lib/pdf-page-model.js', 'src/lib/pdf-vertical-model.js', 'src/lib/numeric-matrix.js', 'tests/pdf-engine/cmap-cff-fixture.js',
  'scripts/probe-pdf-cmaps.mjs', 'native/pdf.wasm', 'vendor/pdf-cmaps/manifest.json', 'vendor/pdf-glyphs/mappings.json', 'vendor/pdf-unicode/saslprep.json', 'vendor/pdf-symbols/manifest.json', 'vendor/pdf-symbols/mappings.json'];
const pins = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await readFile(resolve(root, file)))])));
const implementationPins = await pins(), errors = [], externalRequests = [];
const server = createServer((request, response) => { void (async () => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><style>body{margin:0;background:#ddd}main{display:flex}section{position:relative}.textLayer{position:absolute;inset:0;color:transparent;line-height:1}</style><main><section><canvas id="own"></canvas><div class="textLayer"></div></section><canvas id="reference"></canvas></main>'); return; }
  if (pathname === '/fixture.pdf') { response.setHeader('Content-Type', 'application/pdf'); response.end(fixture); return; }
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  const filename = resolve(root, `.${pathname}`), allowed = ['/src/pdf/', '/native/', '/vendor/pdf-data/', '/vendor/pdf-cmaps/', '/vendor/pdf-glyphs/', '/vendor/pdf-unicode/', '/vendor/pdf-symbols/', '/node_modules/pdfjs-dist/'].some(prefix => pathname.startsWith(prefix))
    || ['/src/lib/pdf-page-model.js', '/src/lib/pdf-vertical-model.js', '/src/lib/numeric-matrix.js'].includes(pathname);
  if (!filename.startsWith(`${root}${sep}`) || !allowed) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', /\.m?js$/.test(filename) ? 'text/javascript' : filename.endsWith('.wasm') ? 'application/wasm' : filename.endsWith('.json') ? 'application/json' : 'application/octet-stream');
  response.end(await readFile(filename));
})().catch(error => { response.writeHead(500); response.end(error.message); }); });
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser, report = { status: 'incomplete', fixtureSha256: sha(fixture), implementationPins, scope: 'Original miniature CID CFF + licensed Adobe vertical CMap browser integration, not the full real PDF corpus.' };
try {
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1240, height: 810 } });
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:') && !request.url().startsWith('blob:')) externalRequests.push(request.url()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const ownModule = '/src/pdf/browser-pdf.js', modelModule = '/src/lib/pdf-page-model.js', oracleModule = '/node_modules/pdfjs-dist/build/pdf.mjs';
    const { openPdfDocument, renderPdfTextLayer } = await import(ownModule), { createPdfPageModel } = await import(modelModule), oracle = await import(oracleModule);
    oracle.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';
    const WorkerBefore = window.Worker, workers = { opened: 0, closed: 0 };
    window.Worker = class extends WorkerBefore { constructor(...args) { super(...args); workers.opened++; } terminate() { workers.closed++; return super.terminate(); } };
    let own, reference; let completed = false;
    try {
      const data = new Uint8Array(await (await fetch('/fixture.pdf')).arrayBuffer()), wasm = await (await fetch('/native/pdf.wasm')).arrayBuffer();
      own = await openPdfDocument(data, { wasm, useWorker: true, assetBaseUrl: new URL('/vendor/pdf-data/', location.href).href });
      const page = await own.getPage(1), viewport = page.getViewport(), a = document.querySelector('#own'), b = document.querySelector('#reference');
      for (const canvas of [a, b]) { canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); }
      const ctx = a.getContext('2d', { willReadFrequently: true }), referenceCtx = b.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: ctx, viewport }).promise;
      const layer = document.querySelector('.textLayer'); await renderPdfTextLayer({ page, container: layer, viewport });
      reference = oracle.getDocument({ data: data.slice(), cMapUrl: new URL('/node_modules/pdfjs-dist/cmaps/', location.href).href, cMapPacked: true });
      const referenceDocument = await reference.promise, referencePage = await referenceDocument.getPage(1);
      await referencePage.render({ canvasContext: referenceCtx, viewport: referencePage.getViewport({ scale: 1 }) }).promise;
      const text = await page.getTextContent(), referenceItems = (await referencePage.getTextContent()).items, expected = 'A、AA、';
      const actualText = text.items.map(item => item.str).join(''), referenceText = referenceItems.map(item => item.str).join('');
      if (actualText !== expected || referenceText !== expected || !text.items.every(item => item.vertical && item.dir === 'ttb')) throw new Error(`Vertical source text mismatch: ${actualText}/${referenceText}.`);
      const reversed = [...text.items].reverse(), model = createPdfPageModel(reversed), sourceAssociations = model.orderedItems.every(item => item.glyphs === reversed[item.originalIndex].glyphs && item.transform === reversed[item.originalIndex].transform);
      // Existing app narration adds a Latin column separator and terminal period;
      // source lines and their associations remain exact before that normalization.
      if (model.speech !== 'A、A A、.' || model.lines.map(line => line.text).join('') !== expected || model.narratedOriginalIndices.join(',') !== '1,0' || !sourceAssociations) throw new Error(`Vertical app narration lost reading order or exact source associations: ${JSON.stringify({ speech: model.speech, indices: model.narratedOriginalIndices, sourceAssociations })}`);
      const selections = [...layer.children].map(span => {
        const range = document.createRange(); range.selectNodeContents(span); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        const rect = range.getBoundingClientRect(), selected = selection.toString(), baseline = { x: parseFloat(span.style.left), y: parseFloat(span.style.top) };
        return { text: span.textContent, selected, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, baseline };
      });
      getSelection().removeAllRanges();
      if (selections.map(value => value.selected).join('') !== expected || selections.some(value => value.selected !== value.text || value.rect.width <= 0 || value.rect.height <= 0)) throw new Error('Actual browser source selection failed.');
      const ownPixels = ctx.getImageData(0, 0, a.width, a.height).data, refPixels = referenceCtx.getImageData(0, 0, b.width, b.height).data;
      let ownInk = 0, referenceInk = 0, changedPixels = 0, sum = 0, maximum = 0;
      for (let i = 0; i < ownPixels.length; i += 4) {
        let pixelError = 0; for (let c = 0; c < 3; c++) { const delta = Math.abs(ownPixels[i + c] - refPixels[i + c]); sum += delta; pixelError = Math.max(pixelError, delta); }
        if (pixelError > 20) changedPixels++; maximum = Math.max(maximum, pixelError);
        if (ownPixels[i] < 230) ownInk++; if (refPixels[i] < 230) referenceInk++;
      }
      const raster = { ownInk, referenceInk, changedPixels, changedInkFraction: changedPixels / Math.max(ownInk, referenceInk, 1), meanAbsoluteChannelError: sum / ownPixels.length * 4 / 3, maximumChannelError: maximum };
      if (!ownInk || raster.changedInkFraction > .1 || Math.abs(ownInk - referenceInk) / referenceInk > .03) throw new Error(`Vertical glyph raster differs: ${JSON.stringify(raster)}`);
      const result = { text: actualText, referenceText, items: text.items, selections, sourceAssociations, speech: model.speech, narratedOriginalIndices: model.narratedOriginalIndices, raster, inspection: await page.inspect(), fontsBeforeDestroy: document.fonts.size };
      window.__cmapOwn = own; window.__cmapReference = reference; window.__cmapWorkers = workers; completed = true; return result;
    } finally { if (!completed) { own?.destroy(); await reference?.destroy(); } }
  });
  await page.screenshot({ path: resolve(output, 'side-by-side.png'), fullPage: true });
  const lifecycle = await page.evaluate(async () => { window.__cmapOwn.destroy(); await window.__cmapReference.destroy(); return { workers: window.__cmapWorkers, fontsAfterDestroy: document.fonts.size }; });
  const implementationUnchanged = JSON.stringify(implementationPins) === JSON.stringify(await pins());
  report = { ...report, ...result, lifecycle, errors, externalRequests, implementationUnchanged, gpuDisabled: true };
  if (errors.length || externalRequests.length || !implementationUnchanged || lifecycle.workers.opened !== lifecycle.workers.closed || lifecycle.fontsAfterDestroy) throw new Error('Browser lifecycle/source stability gate failed.');
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.failure = error.message; report.errors = errors; process.exitCode = 1; }
finally { await browser?.close(); await new Promise(done => server.close(done)); await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); }
console.log(JSON.stringify(report));
