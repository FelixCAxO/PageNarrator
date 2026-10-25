// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Phase diagnostics only: never changes the packaged runtime or claims a performance win.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect } from '@playwright/test';
import { launchExtensionContext, getExtensionId } from '../tests/e2e/extension-fixture.js';
import { observePdfPhases } from './lib/pdf-phase-observer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), candidate = path.resolve(process.env.PN_E2E_EXTENSION_DIR || 'artifacts/engines/integrated-extension-pdf-fixed-assets');
if (!process.env.PN_PDF_FIXTURE_DIR) throw new Error('Set PN_PDF_FIXTURE_DIR to the fixed PDF corpus.');
const source = new Uint8Array(await readFile(path.join(process.env.PN_PDF_FIXTURE_DIR, '2606.23670v1.pdf'))), sha = value => createHash('sha256').update(value).digest('hex');
if (sha(source) !== 'f517e613c9e519bdb0040eef286be11a71650cfee132214bcd9ece89fd8fcbbc') throw new Error('Actual PDF source hash changed.');
const output = path.join(root, 'artifacts/engines/pdf-app-phases', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
async function pins(directory, prefixes = null) {
  const result = {}, locations = prefixes || [''];
  for (const relative of locations) {
    const location = path.join(directory, relative);
    if (path.extname(location)) { result[relative] = sha(await readFile(location)); continue; }
    for (const entry of await readdir(location, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
      const filename = path.relative(directory, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/');
      result[filename] = sha(await readFile(path.join(directory, filename)));
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
const sourcePrefixes = ['src/pdf', 'src/lib/pdf-extraction.js', 'src/lib/pdf-page-model.js', 'src/lib/pdf-viewer-rendering.js', 'src/pdf-viewer.js', 'native/pdf.wasm', 'vendor/pdf-data', 'vendor/pdf-cmaps', 'vendor/pdf-glyphs', 'vendor/pdf-unicode', 'vendor/pdf-symbols'];
const before = { candidate: await pins(candidate), source: await pins(root, sourcePrefixes) };
const operationProfiling = process.env.PN_PDF_PROFILE_OPERATIONS === '1', instrumentedModules = {};
const mime = filename => filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.json') ? 'application/json' : filename.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1'), route = decodeURIComponent(url.pathname);
    if (route === '/fixture.pdf') { response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': source.length, 'Access-Control-Allow-Origin': '*' }); response.end(source); return; }
    if (route === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (route === '/phase.html') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><section class="pdf-page" data-page-number="1"><canvas></canvas><div class="textLayer" id="text" style="position:absolute;top:0;left:0"></div></section>'); return; }
    if (!/^\/(?:src\/pdf\/|native\/pdf\.wasm$|vendor\/pdf-(?:data|cmaps|glyphs|unicode)\/)/u.test(route)) { response.writeHead(404); response.end(); return; }
    const filename = path.resolve(root, `.${route}`);
    if (!filename.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid fixture-server path.');
    let bytes = await readFile(filename);
    if (operationProfiling && !url.searchParams.has('pn-original') && ['/src/pdf/icc-blend.js', '/src/pdf/shading.js'].includes(route)) {
      const original = `${route}?pn-original=1`, name = route.endsWith('/icc-blend.js') ? 'convertBlendPixels' : 'renderPdfShading';
      const asynchronous = name === 'renderPdfShading', wrapper = `import * as original from ${JSON.stringify(original)};\nexport * from ${JSON.stringify(original)};\nexport ${asynchronous ? 'async ' : ''}function ${name}(...args) {\n const record = globalThis.__pnPdfOperation; if (!record) return original.${name}(...args);\n const start = performance.now(); try { return ${asynchronous ? 'await ' : ''}original.${name}(...args); } finally { record(${JSON.stringify(name)}, performance.now()-start, ${asynchronous ? 'args[1].canvas.width*args[1].canvas.height' : 'args[0].length/4'}); }\n}\n`;
      instrumentedModules[route] = { originalSha256: sha(bytes), wrapperSha256: sha(wrapper), scope: 'Development HTTP control only; one timing call per shading or ICC band, no per-pixel wrappers.' };
      bytes = Buffer.from(wrapper);
    }
    response.writeHead(200, { 'Content-Type': mime(filename) }); response.end(bytes);
  } catch (error) { response.writeHead(404); response.end(error.code || 'fixture unavailable'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`, errors = [], requestsFailed = [], httpErrors = [], retiredRequests = [];
let networkPhase = 'startup';
let launched, installed, controlled, failure, profileClosed = false;
let cpuProfile = null;
try {
  launched = await launchExtensionContext({ extensionDir: candidate, hostPermissions: ['http://127.0.0.1/*'] });
  const context = launched.context;
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  context.on('request', request => { if (/pdf\.worker\.mjs|pdfjs-dist|ort-wasm|tesseract|transformers\.min/u.test(request.url())) retiredRequests.push(request.url()); });
  context.on('requestfailed', request => requestsFailed.push({ phase: networkPhase, url: request.url(), reason: request.failure()?.errorText }));
  context.on('response', response => { if (response.status() >= 400) httpErrors.push({ phase: networkPhase, url: response.url(), status: response.status() }); });
  const extensionId = await getExtensionId(context), page = await context.newPage();
  await page.addInitScript(observePdfPhases);
  const profiler = process.env.PN_PDF_CPU_PROFILE === '1' ? await context.newCDPSession(page) : null;
  if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.setSamplingInterval', { interval: 1000 }); await profiler.send('Profiler.start'); }
  networkPhase = 'installed';
  const start = performance.now();
  await page.goto(`chrome-extension://${extensionId}/src/pdf-viewer.html?src=${encodeURIComponent(`${origin}/fixture.pdf`)}`);
  await page.waitForFunction(() => document.querySelector('.pdf-page[data-page-number="1"] .textLayer')?.hasAttribute('data-pagenarrator-pdf-text'), null, { timeout: 30000 });
  const annotationObservedMs = performance.now() - start;
  if (profiler) { cpuProfile = (await profiler.send('Profiler.stop')).profile; await writeFile(path.join(output, 'installed-main-thread.cpuprofile'), JSON.stringify(cpuProfile)); await profiler.detach(); }
  installed = await page.evaluate(async () => {
    const phases = structuredClone(window.__pnPdfPhases), section = document.querySelector('.pdf-page[data-page-number="1"]'), canvas = section.querySelector('canvas'), layer = section.querySelector('.textLayer');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const pixelSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const spans = [...layer.querySelectorAll('span')].map(span => ({ text: span.textContent, source: span.getAttribute('data-pagenarrator-pdf-source-index'), order: span.getAttribute('data-pagenarrator-pdf-order'), left: span.style.left, top: span.style.top, transform: span.style.transform }));
    return { phases, width: canvas.width, height: canvas.height, viewportScale: Number(section.style.getPropertyValue('--total-scale-factor')), dpr: devicePixelRatio, pixelSha256, spans,
      resources: performance.getEntriesByType('resource').map(entry => ({ name: entry.name, startTime: entry.startTime, duration: entry.duration, transferSize: entry.transferSize })) };
  });
  installed.observedReadyMs = performance.now() - start;
  installed.annotationObservedMs = annotationObservedMs;
  await page.locator('.pdf-page[data-page-number="1"] canvas').screenshot({ path: path.join(output, 'installed-page1.png') });
  networkPhase = 'teardown'; await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  installed.cleanup = await page.evaluate(() => ({ workers: window.__pnPdfPhases.workers, fonts: document.fonts.size, pages: document.querySelectorAll('.pdf-page').length }));
  await page.close();
  networkPhase = 'controlled'; const isolated = await context.newPage(); await isolated.addInitScript(observePdfPhases); await isolated.goto(`${origin}/phase.html`);
  controlled = await isolated.evaluate(async ({ viewportScale, width, height }) => {
    const enginePath = '/src/pdf/pdf-engine.js', { getDocument, TextLayer } = await import(enginePath);
    const operationStats = {};
    globalThis.__pnPdfOperation = (name, elapsedMs, pixels) => { const record = operationStats[name] ||= { calls: 0, elapsedMs: 0, pixels: 0 }; record.calls++; record.elapsedMs += elapsedMs; record.pixels += pixels; };
    const stages = {}, measure = async (name, operation) => { const start = performance.now(); const value = await operation(); stages[name] = performance.now() - start; return value; };
    const bytes = await measure('sourceFetchMs', async () => new Uint8Array(await (await fetch('/fixture.pdf')).arrayBuffer()));
    const wasm = await measure('wasmFetchMs', async () => new Uint8Array(await (await fetch('/native/pdf.wasm')).arrayBuffer()));
    const task = getDocument({ data: bytes, wasm, assetBaseUrl: new URL('/vendor/pdf-data/', location.href).href, useWorker: true });
    let document;
    try {
      document = await measure('openNativeParseMs', () => task.promise);
      const page = await measure('pageInfoMs', () => document.getPage(1)), text = await measure('pagePayloadDisplayListFontsMs', () => page.getTextContent());
      await measure('fontFaceMs', () => page.ensureFonts());
      const viewport = page.getViewport({ scale: viewportScale }), canvas = window.document.querySelector('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      await measure('canvasMs', () => page.render({ canvasContext: context, viewport }).promise);
      const layer = window.document.querySelector('#text');
      await measure('textLayerMs', () => new TextLayer({ page, textContentSource: text, container: layer, viewport }).render());
      const phases = structuredClone(window.__pnPdfPhases);
      const pixels = context.getImageData(0, 0, width, height).data;
      const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const geometry = text.items.map(item => ({ str: item.str, transform: item.transform, width: item.width, height: item.height, dir: item.dir, textOrder: item.textOrder }));
      const spans = [...layer.querySelectorAll('span')].map(span => ({ text: span.textContent, source: span.getAttribute('data-pagenarrator-pdf-source-index'), left: span.style.left, top: span.style.top, transform: span.style.transform }));
      return { stages, phases, operationStats, spans, pageCount: document.numPages, width, height, viewportScale, itemCount: text.items.length, pixelSha256: await digest(pixels), geometry,
        geometrySha256: await digest(new TextEncoder().encode(JSON.stringify(geometry))), inspection: await page.inspect() };
    } finally { await task.destroy(); }
  }, installed);
  await isolated.locator('canvas').screenshot({ path: path.join(output, 'isolated-page1.png') });
  controlled.cleanup = await isolated.evaluate(() => ({ fonts: document.fonts.size, workers: window.__pnPdfPhases.workers })); networkPhase = 'teardown'; await isolated.close();
  expect(controlled.pageCount).toBe(15); expect(controlled.pixelSha256).toBe(installed.pixelSha256);
  expect(controlled.spans).toEqual(installed.spans.map(({ order: _order, ...source }) => source));
  expect(installed.cleanup.fonts).toBe(0); expect(installed.cleanup.pages).toBe(0); expect(controlled.cleanup.fonts).toBe(0);
  expect(installed.cleanup.workers.every(worker => worker.closedMs !== null)).toBe(true);
  expect(controlled.cleanup.workers.every(worker => worker.closedMs !== null)).toBe(true);
} catch (error) { failure = error.message; }
finally {
  if (launched) {
    const temporary = path.resolve(tmpdir()), profile = path.resolve(launched.userDataDir), copyRoot = path.dirname(path.resolve(launched.extensionDir));
    if (path.dirname(profile) !== temporary || !path.basename(profile).startsWith('pagenarrator-e2e-') || path.dirname(copyRoot) !== temporary || !path.basename(copyRoot).startsWith('pagenarrator-extension-')) throw new Error('Refusing cleanup outside created temporary proof roots.');
    await launched.cleanup(); profileClosed = true;
  }
  await new Promise(done => server.close(done));
}
const unchanged = JSON.stringify(before) === JSON.stringify({ candidate: await pins(candidate), source: await pins(root, sourcePrefixes) });
const report = { scope: 'Actual unchanged 2606.23670v1 page1: instrumented installed viewer and serial isolated exact-scale original facade control. Diagnostic phases only; prototype wrappers add overhead and do not prove a performance improvement.',
  candidate, sourceSha256: sha(source), pins: before, pinsUnchanged: unchanged, operationProfiling, instrumentedModules, cpuProfileCaptured: !!cpuProfile, installed, controlled, errors, requestsFailed, httpErrors, retiredRequests, failure, profileClosed,
  originalFiveSecondFailurePreserved: 'artifacts/engines/pdf-app/report-*.json', passed: !failure && unchanged && !errors.length && !retiredRequests.length && !httpErrors.length && !requestsFailed.some(item => item.phase !== 'teardown') && profileClosed };
await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, passed: report.passed, failure, pinsUnchanged: unchanged, installedReadyMs: installed?.observedReadyMs, controlledStages: controlled?.stages, pixelsEqual: installed?.pixelSha256 === controlled?.pixelSha256, errors, requestsFailed, retiredRequests, profileClosed }, null, 2));
if (!report.passed) process.exitCode = 1;
