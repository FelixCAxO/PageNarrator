// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const cff = process.argv.includes('--cff'), encrypted = process.argv.includes('--encrypted'), fontName = cff ? 'Times-Roman' : 'Helvetica', suffix = encrypted ? '-encrypted' : cff ? '-cff' : '';
const content = 'q .15 .3 .5 rg 40 620 500 95 re f Q\nBT /F1 22 Tf 1 1 1 rg 1 0 0 1 60 670 Tm (Original browser PDF) Tj ET\n0 g BT /F1 14 Tf 1 0 0 1 60 590 Tm (C++ / WASM parsing, Canvas rendering, selectable text.) Tj ET\nq 120 0 0 80 50 450 cm /Im1 Do Q\nq 1 0 0 RG 3 w 220 450 m 400 510 l S Q';
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, `<< /Type /Font /Subtype /Type1 /BaseFont /${fontName} /Encoding /WinAnsiEncoding >>`,
  `<< /Type /XObject /Subtype /Image /Width 3 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Length 18 >>\nstream\n${Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255]).toString('latin1')}\nendstream`];
let pdf = '%PDF-1.7\n'; const offsets = [0];
for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf, 'latin1'); pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const fixture = encrypted ? await readFile(new URL('../tests/pdf-engine/fixtures/encrypted-r6.pdf', import.meta.url)) : Buffer.from(pdf, 'latin1');
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><style>body{margin:0;background:#ddd}#page{position:relative;width:612px;height:792px}.textLayer{position:absolute;inset:0;color:transparent;line-height:1}</style><main id="page"><canvas width="612" height="792"></canvas><div class="textLayer"></div></main>'); return; }
    if (url.pathname === '/fixture.pdf') { response.setHeader('Content-Type', 'application/pdf'); response.end(fixture); return; }
    const filename = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!filename.startsWith(root) || !['/src/pdf/', '/native/', '/vendor/pdf-data/', '/vendor/pdf-cmaps/', '/vendor/pdf-glyphs/', '/vendor/pdf-unicode/', '/vendor/pdf-symbols/'].some(prefix => url.pathname.startsWith(prefix))) { response.writeHead(404); response.end(); return; }
    const bytes = await readFile(filename); response.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.wasm') ? 'application/wasm' : filename.endsWith('.json') ? 'application/json' : 'application/octet-stream'); response.end(bytes);
  })().catch(error => { response.writeHead(500); response.end(error.message); });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
const errors = [], page = await browser.newPage({ viewport: { width: 680, height: 850 } });
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async encrypted => {
    const modulePath = '/src/pdf/browser-pdf.js';
    const { openPdfDocument, renderPdfTextLayer } = await import(modulePath);
    const OriginalWorker = window.Worker, stats = { opened: 0, closed: 0 };
    window.Worker = class extends OriginalWorker { constructor(...args) { super(...args); stats.opened++; } terminate() { stats.closed++; return super.terminate(); } };
    const data = new Uint8Array(await (await fetch('/fixture.pdf')).arrayBuffer()), wasm = await (await fetch('/native/pdf.wasm')).arrayBuffer();
    if (encrypted) { let rejected = false; try { await openPdfDocument(data, { wasm, useWorker: true, password: 'incorrect' }); } catch (error) { if (error.code !== 'pdf_password') throw error; rejected = true; } if (!rejected) throw new Error('Encrypted PDF accepted an invalid password.'); }
    const document = await openPdfDocument(data, { wasm, useWorker: true, assetBaseUrl: new URL('/vendor/pdf-data/', location.href).href });
    let completed = false;
    try {
      const page = await document.getPage(1), canvas = window.document.querySelector('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true }), viewport = page.getViewport();
      await page.render({ canvasContext: ctx, viewport }).promise;
      const layer = window.document.querySelector('.textLayer'); await renderPdfTextLayer({ page, container: layer, viewport });
      const pixel = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      const range = window.document.createRange(); range.selectNodeContents(layer.querySelector('span')); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const selected = selection.toString(), rect = range.getBoundingClientRect();
      const text = (await page.getTextContent()).items.map(item => item.str);
      const report = { numPages: document.numPages, text, selected, selectionRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        vectorPixel: pixel(60, 85), imagePixel: pixel(70, 280), inspect: await page.inspect(), fontsBeforeDestroy: window.document.fonts.size };
      const expected = encrypted ? 'Original encrypted PDF fixture.' : 'Original browser PDF';
      if (text[0] !== expected || selected !== text[0] || rect.width < 100 || !encrypted && (report.vectorPixel[2] < 120 || report.imagePixel[0] !== 255 || report.imagePixel[1] !== 0)) throw new Error(`Original PDF browser mismatch: ${JSON.stringify(report)}`);
      if (encrypted && (await document.getMetadata()).info.Title !== 'Encrypted source title') throw new Error('Encrypted PDF metadata mismatch.');
      window.__pdfReport = report; window.__pdfDocument = document; completed = true; return report;
    } finally { if (!completed) document.destroy(); window.__pdfWorkerStats = stats; }
  }, encrypted);
  await mkdir(new URL('../artifacts/engines/', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL(`../artifacts/engines/pdf-original-browser${suffix}.png`, import.meta.url)) });
  const lifecycle = await page.evaluate(() => { window.__pdfDocument.destroy(); return { workers: window.__pdfWorkerStats, fontsAfterDestroy: window.document.fonts.size }; });
  if (errors.length || lifecycle.workers.opened !== lifecycle.workers.closed || lifecycle.fontsAfterDestroy !== 0) throw new Error(`Original PDF lifecycle errors: ${JSON.stringify({ errors, lifecycle })}`);
  const report = { originalBackend: true, fontName, encrypted, gpuDisabledForThisSmoke: true, fullRendererAcceptance: false, ...result, lifecycle, errors };
  await writeFile(new URL(`../artifacts/engines/pdf-original-browser${suffix}.json`, import.meta.url), `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
