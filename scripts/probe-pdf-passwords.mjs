// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Serial, CPU-only browser proof for original Unicode/password/font execution.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { simplePdf } from '../tests/pdf-engine/fixtures.js';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url))), sha = data => createHash('sha256').update(data).digest('hex');
const manifest = JSON.parse(await readFile(new URL('../tests/pdf-engine/fixtures/unicode-passwords/manifest.json', import.meta.url))), cases = [], fixtures = new Map();
for (const entry of manifest.entries) {
  const data = await readFile(new URL(`../tests/pdf-engine/fixtures/unicode-passwords/${entry.file}`, import.meta.url));
  if (sha(data) !== entry.sha256) throw new Error('Frozen encrypted Unicode fixture mismatch.');
  fixtures.set(entry.id, data); cases.push({ id: entry.id, sha256: entry.sha256, encrypted: true, password: entry.password, owner: entry.owner,
    raw: [...Buffer.from(entry.preparedBytesHex, 'hex')], expected: 'Original Unicode password fixture.', expectedTitle: 'Unicode password source title' });
}
for (const [id, font, code, expected] of [['dingbats', 'ZapfDingbats', '29', '\u2709'], ['symbol', 'Symbol', '414257', '\u0391\u0392\u2126']]) {
  const data = simplePdf(`BT /F1 30 Tf 1 0 0 1 54 700 Tm <${code}> Tj ET`, { font: `/Type /Font /Subtype /Type1 /BaseFont /${font}` });
  fixtures.set(id, data); cases.push({ id, sha256: sha(data), encrypted: false, expected });
}
async function pins() {
  const names = ['scripts/probe-pdf-passwords.mjs', 'native/pdf.wasm'];
  for (const directory of ['src/pdf', 'vendor/pdf-data', 'vendor/pdf-cmaps', 'vendor/pdf-glyphs', 'vendor/pdf-unicode', 'vendor/pdf-symbols']) {
    for (const entry of await readdir(path.join(root, directory), { recursive: true, withFileTypes: true })) if (entry.isFile()) names.push(path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
  }
  return Object.fromEntries(await Promise.all(names.sort().map(async name => [name, sha(await readFile(path.join(root, name)))])));
}
const before = await pins(), errors = [], requests = [], records = [];
const server = createServer((request, response) => { void (async () => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><style>body{margin:0}main{position:relative}.textLayer{position:absolute;inset:0;color:transparent;line-height:1}</style><main><canvas></canvas><div class="textLayer"></div></main>'); return; }
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  if (pathname.startsWith('/cases/')) { const data = fixtures.get(pathname.slice(7, -4)); if (!data) throw new Error('Unknown fixture.'); response.setHeader('Content-Type', 'application/pdf'); response.end(data); return; }
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(root + path.sep) || !['/src/pdf/', '/native/', '/vendor/pdf-data/', '/vendor/pdf-cmaps/', '/vendor/pdf-glyphs/', '/vendor/pdf-unicode/', '/vendor/pdf-symbols/'].some(prefix => pathname.startsWith(prefix))) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'); response.end(await readFile(file));
})().catch(error => { requests.push({ url: request.url, message: error.message }); response.writeHead(500); response.end(error.message); }); });
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser, failure;
try {
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 650, height: 820 } });
  page.on('pageerror', error => errors.push(error.message)); page.on('requestfailed', request => requests.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('response', response => { if (response.status() >= 400) requests.push({ url: response.url(), status: response.status() }); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for (const entry of cases) {
    const record = await page.evaluate(async entry => {
      const started = performance.now(), corePath = '/src/pdf/browser-pdf.js', enginePath = '/src/pdf/pdf-engine.js';
      const { renderPdfTextLayer } = await import(corePath), { getDocument } = await import(enginePath), loadingTasks = [];
      const openPdfDocument = (data, options) => { const task = getDocument({ data, ...options }); loadingTasks.push(task); return task.promise; };
      const data = new Uint8Array(await (await fetch(`/cases/${entry.id}.pdf`)).arrayBuffer()), wasm = await (await fetch('/native/pdf.wasm')).arrayBuffer();
      const OriginalWorker = window.Worker, workers = { opened: 0, closed: 0 }; let document;
      window.Worker = class extends OriginalWorker { constructor(...args) { super(...args); workers.opened++; } terminate() { workers.closed++; return super.terminate(); } };
      const options = { wasm, useWorker: true, assetBaseUrl: new URL('/vendor/pdf-data/', location.href).href };
      let invalidRejected = false, prohibitedRejected = false, ownerOpened = false, rawOpened = false, rawUnchanged = false, result;
      try {
        if (entry.encrypted) {
          for (const password of ['incorrect', '\u0007']) {
            let wrong;
            try { wrong = await openPdfDocument(data, { ...options, password }); throw new Error('Invalid password was accepted.'); }
            catch (error) { if (error.name !== 'PasswordException' || error.code !== 'pdf_password') throw error; if (password === 'incorrect') invalidRejected = true; else prohibitedRejected = true; }
            finally { wrong?.destroy(); }
          }
          const owner = await openPdfDocument(data, { ...options, password: entry.owner }); ownerOpened = owner.numPages === 1; owner.destroy();
          const raw = Uint8Array.from(entry.raw), saved = raw.slice(), rawDocument = await openPdfDocument(data, { ...options, password: raw }); rawOpened = rawDocument.numPages === 1; rawDocument.destroy(); rawUnchanged = raw.every((byte, index) => byte === saved[index]);
        }
        document = await openPdfDocument(data, { ...options, password: entry.password || '' });
        const page = await document.getPage(1), viewport = page.getViewport(), canvas = window.document.querySelector('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d', { willReadFrequently: true }); await page.render({ canvasContext: context, viewport }).promise;
        const layer = window.document.querySelector('.textLayer'); await renderPdfTextLayer({ page, container: layer, viewport });
        const range = window.document.createRange(); range.selectNodeContents(layer.querySelector('span')); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        const text = (await page.getTextContent()).items.map(item => item.str).join(''), selected = selection.toString(), rect = range.getBoundingClientRect(), inspection = await page.inspect();
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; let ink = 0; for (let at = 0; at < pixels.length; at += 4) if (pixels[at] < 220 && pixels[at + 1] < 220 && pixels[at + 2] < 220) ink++;
        const title = entry.expectedTitle ? (await document.getMetadata()).info.Title : null;
        result = { text, selected, width: rect.width, ink, unmappedGlyphs: inspection.unmappedGlyphs, title, fontsBeforeDestroy: window.document.fonts.size };
        if (text !== entry.expected || selected !== entry.expected || rect.width < 5 || !ink || inspection.unmappedGlyphs || entry.expectedTitle && title !== entry.expectedTitle) throw new Error(`Unicode browser contract mismatch: ${JSON.stringify(result)}`);
        if (entry.encrypted && (!invalidRejected || !prohibitedRejected || !ownerOpened || !rawOpened || !rawUnchanged)) throw new Error('Unicode encrypted authentication control failed.');
      } finally { document?.destroy(); for (const task of loadingTasks) await task.destroy(); window.Worker = OriginalWorker; }
      const fontsAfterDestroy = window.document.fonts.size;
      if (workers.opened !== workers.closed || fontsAfterDestroy) throw new Error(`Unicode browser resource leak: ${JSON.stringify({ workers, fontsAfterDestroy })}`);
      return { id: entry.id, sourceSha256: entry.sha256, ...result, invalidRejected, prohibitedRejected, ownerOpened, rawOpened, rawUnchanged, workers, fontsAfterDestroy, elapsedMs: performance.now() - started, passed: true };
    }, entry).catch(error => ({ id: entry.id, sourceSha256: entry.sha256, passed: false, error: error.message }));
    records.push(record);
  }
} catch (error) { failure = error.message; }
finally { await browser?.close(); await new Promise(done => server.close(done)); }
const unchanged = JSON.stringify(before) === JSON.stringify(await pins()), passed = !failure && !errors.length && !requests.length && unchanged && records.length === cases.length && records.every(record => record.passed);
const report = { schemaVersion: 1, scope: 'Original app loading-task facade, R6 Unicode/password and standard font data in real Workers, Canvas, FontFace and source selection; fixed eight cases only.', facadeUsed: true, productionSwitched: false,
  fullRendererAcceptance: false, gpuDisabled: true, implementationPins: before, implementationUnchanged: unchanged, records, errors, requests, failure, passed };
const output = new URL('../artifacts/engines/pdf-unicode-browser.json', import.meta.url); await mkdir(new URL('../artifacts/engines/', import.meta.url), { recursive: true });
try { await copyFile(output, new URL(`../artifacts/engines/pdf-unicode-browser-${Date.now()}.json`, import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify({ passed, cases: records.length, failures: records.filter(record => !record.passed), errors, requests, unchanged }, null, 2));
if (!passed) process.exitCode = 1;
