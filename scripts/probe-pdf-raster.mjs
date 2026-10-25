// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development oracle only; the app's original facade is verified separately.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { simplePdf, stream, pdf, show, loadAsset, nonIsolatedBlendPdf } from '../tests/pdf-engine/fixtures.js';
import { readTrueTypeMetrics } from '../src/pdf/font-metrics.js';
import { deflateSync } from 'node:zlib';
import { strokeAdjustmentPdf } from '../tests/pdf-engine/stroke-fixture.js';
import { axialShadingPdf } from '../tests/pdf-engine/shading-fixture.js';
import { radialShadingPdf } from '../tests/pdf-engine/radial-shading-fixture.js';
import { iccBlendPdf } from '../tests/pdf-engine/icc-fixture.js';
import { PDF_ACCEPTANCE_BENCHMARK } from '../tests/fixtures/pdf-acceptance-manifest.js';
const root = fileURLToPath(new URL('../', import.meta.url)), fixtures = new Map(), fixturePages = new Map(), requestFailures = [];
const corpusMode = process.env.PN_PDF_RASTER_CORPUS === '1', corpusOffset = Number(process.env.PN_PDF_RASTER_OFFSET || 0), corpusLimit = Number(process.env.PN_PDF_RASTER_LIMIT || 10), latinMode = process.env.PN_PDF_RASTER_LATIN === '1';
if (corpusMode && latinMode) throw new Error('Select one frozen corpus or Latin encoding raster lane.');
if (corpusMode && (!Number.isSafeInteger(corpusOffset) || corpusOffset < 0 || corpusOffset >= PDF_ACCEPTANCE_BENCHMARK.length || !Number.isSafeInteger(corpusLimit) || corpusLimit < 1 || corpusLimit > 100)) throw new Error('Invalid bounded PDF raster corpus offset/limit.');
const reportName = corpusMode ? `pdf-raster-corpus-${corpusOffset}-${corpusLimit}` : latinMode ? 'pdf-raster-latin-encodings' : 'pdf-raster-smoke', reportUrl = new URL(`../artifacts/engines/${reportName}.json`, import.meta.url);
try { await copyFile(reportUrl, new URL(`../artifacts/engines/${reportName}-${Date.now()}.json`, import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
fixtures.set('type3', simplePdf(show('AA'), { font: '/Type /Font /Subtype /Type3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 600 700] /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [600] /CharProcs << /A 6 0 R >>', extra: [stream('600 0 0 0 600 700 d1 0 0 600 700 re f')] }));
fixtures.set('isolated-group', simplePdf('q 2 0 0 2 30 100 cm /G gs /F Do Q', { page: '/Resources << /XObject << /F 6 0 R >> /ExtGState << /G 7 0 R >> >>', extra: [stream('1 0 0 rg 0 0 50 50 re f 0 0 1 rg 25 25 50 50 re f', '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /I true /CS /DeviceRGB >>'), '<< /Type /ExtGState /ca .5 >>'] }));
fixtures.set('nonisolated-group', nonIsolatedBlendPdf());
const groupOracle = JSON.parse(await readFile(new URL('../tests/pdf-engine/fixtures/nonisolated-mupdf.json', import.meta.url), 'utf8')), groupPng = await readFile(new URL('../tests/pdf-engine/fixtures/nonisolated-mupdf.png', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
async function implementationPins() {
  const files = ['scripts/probe-pdf-raster.mjs', 'tests/fixtures/pdf-acceptance-manifest.js'];
  for (const directory of ['src/pdf', 'vendor/pdf-data', 'vendor/pdf-cmaps', 'vendor/pdf-glyphs', 'vendor/pdf-unicode', 'vendor/pdf-symbols']) for (const relative of await readdir(path.join(root, directory), { recursive: true, withFileTypes: true })) {
    if (relative.isFile()) files.push(path.relative(root, path.join(relative.parentPath, relative.name)).replaceAll('\\', '/'));
  }
  for (const name of await readdir(path.join(root, 'native'))) if (/^pdf.*\.(?:cpp|h|json|wasm)$/.test(name)) files.push(`native/${name}`);
  files.sort(); return Object.fromEntries(await Promise.all(files.map(async name => [name, sha(await readFile(path.join(root, name)))])));
}
const sourcePins = await implementationPins();
if (sha(fixtures.get('nonisolated-group')) !== groupOracle.sourceSha256 || sha(groupPng) !== groupOracle.pngSha256) throw new Error('Non-isolated group oracle source/raster hash mismatch.');
fixtures.set('encrypted-r6', await readFile(new URL('../tests/pdf-engine/fixtures/encrypted-r6.pdf', import.meta.url)));
fixtures.set('stroke-adjustment', strokeAdjustmentPdf());
fixtures.set('axial-shading', axialShadingPdf());
fixtures.set('radial-shading', radialShadingPdf());
fixtures.set('radial-degenerate', simplePdf('q 1 0 0 1 10 10 cm /D0 sh Q q 1 0 0 1 120 10 cm /D1 sh Q BT /F1 12 Tf 1 0 0 1 10 105 Tm (Degenerate radial controls) Tj ET', {
  page: '/MediaBox [0 0 220 120] /Resources << /Font << /F1 5 0 R >> /Shading << /D0 6 0 R /D1 7 0 R >> >>',
  extra: [[40, 40, 20, 40, 40, 20], [0, 0, 0, 50, 50, 0]].map(coords => `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [${coords.join(' ')}] /BBox [0 0 80 80] /Extend [true true] /Function << /FunctionType 2 /Domain [0 1] /C0 [0 0 1] /C1 [1 0 0] /N 1 >> >>`),
}));
fixtures.set('axial-explicitclip', axialShadingPdf({ explicitClip: true }));
const axialOracle = JSON.parse(await readFile(new URL('../tests/pdf-engine/fixtures/axial-mupdf.json', import.meta.url), 'utf8')), axialPng = await readFile(new URL('../tests/pdf-engine/fixtures/axial-mupdf.png', import.meta.url));
if (sha(fixtures.get('axial-shading')) !== axialOracle.sourceSha256 || sha(axialPng) !== axialOracle.pngSha256) throw new Error('Independent axial oracle source/raster hash mismatch.');
const axialComparison = JSON.parse(await readFile(new URL('../tests/pdf-engine/fixtures/axial-oracle-comparison.json', import.meta.url), 'utf8')), axialControlPng = await readFile(new URL('../tests/pdf-engine/fixtures/axial-explicitclip-mupdf.png', import.meta.url)), axialPopplerPng = await readFile(new URL('../tests/pdf-engine/fixtures/axial-poppler.png', import.meta.url));
if (axialComparison.classification !== 'oracle_discrepancy_verified' || axialComparison.originalSourceSha256 !== sha(fixtures.get('axial-shading')) || axialComparison.equivalentExplicitClipSourceSha256 !== sha(fixtures.get('axial-explicitclip'))
  || axialComparison.oracles.originalPoppler.sha256 !== sha(axialPopplerPng) || axialComparison.oracles.explicitClipMuPDF.sha256 !== sha(axialControlPng)) throw new Error('Axial independent renderer comparison hashes changed.');
fixtures.set('icc-blending', iccBlendPdf());
const iccOracle = JSON.parse(await readFile(new URL('../tests/pdf-engine/fixtures/icc-blending-oracle.json', import.meta.url), 'utf8')), iccPng = await readFile(new URL('../tests/pdf-engine/fixtures/icc-blending-mupdf.png', import.meta.url));
if (sha(fixtures.get('icc-blending')) !== iccOracle.sourceSha256 || sha(iccPng) !== iccOracle.pngSha256) throw new Error('Independent ICC oracle source/raster hash mismatch.');
const strokeOracle = JSON.parse(await readFile(new URL('../tests/pdf-engine/fixtures/stroke-mupdf.json', import.meta.url), 'utf8')), strokePng = await readFile(new URL('../tests/pdf-engine/fixtures/stroke-mupdf.png', import.meta.url));
if (sha(fixtures.get('stroke-adjustment')) !== strokeOracle.sourceSha256 || sha(strokePng) !== strokeOracle.pngSha256) throw new Error('Independent stroke oracle source/raster hash mismatch.');
const bandWidth = 2000, bandHeight = 4200, bandRgb = new Uint8Array(bandWidth * bandHeight * 3), bandAlpha = new Uint8Array(bandWidth * bandHeight);
for (let y = 0; y < bandHeight; y++) for (let x = 0; x < bandWidth; x++) {
  const i = y * bandWidth + x; bandRgb[i * 3] = Math.round(x / (bandWidth - 1) * 255); bandRgb[i * 3 + 1] = Math.round(y / (bandHeight - 1) * 255); bandRgb[i * 3 + 2] = Math.floor(y / 32) % 2 ? 60 : 180; bandAlpha[i] = 128 + x % 128;
}
fixtures.set('image-bands', simplePdf('q 300 0 0 630 40 90 cm /I Do Q', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [stream(deflateSync(bandRgb), `/Type /XObject /Subtype /Image /Width ${bandWidth} /Height ${bandHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 7 0 R`), stream(deflateSync(bandAlpha), `/Type /XObject /Subtype /Image /Width ${bandWidth} /Height ${bandHeight} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`)] }));
fixtures.set('cmyk-calibrated', simplePdf('0 1 1 0 k 30 600 100 70 re f 1 0 0 0 k 150 600 100 70 re f /L cs 100 0 0 sc 270 600 100 70 re f /L cs 50 0 0 sc 390 600 100 70 re f', { page: '/Resources << /ColorSpace << /L [/Lab << /WhitePoint [.95047 1 1.08883] >>] >> >>' }));
const mask = stream(Uint8Array.of(0, 85, 170, 255), '/Type /XObject /Subtype /Image /Width 4 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8');
fixtures.set('soft-mask', simplePdf('q 320 0 0 80 50 500 cm /I Do Q', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [stream(Uint8Array.of(0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255), '/Type /XObject /Subtype /Image /Width 4 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 7 0 R'), mask] }));
const font = await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), gid = readTrueTypeMetrics(font).glyphId(65), code = gid.toString(16).padStart(4, '0');
fixtures.set('cid-truetype', pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', stream(`BT /F1 40 Tf 1 0 0 1 54 700 Tm <${code}${code}> Tj ET`), '<< /Type /Font /Subtype /Type0 /BaseFont /LiberationSans /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 9 0 R >>', `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /LiberationSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /CIDToGIDMap /Identity /W [${gid} [667]] >>`, '<< /Type /FontDescriptor /FontName /LiberationSans /FontBBox [-600 -400 2000 1100] /Flags 32 /Ascent 900 /Descent -200 /CapHeight 700 /ItalicAngle 0 /StemV 80 /FontFile2 8 0 R >>', stream(font), stream(`begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <${code}> <0041> endbfchar endcmap`)]));
fixtures.set('mac-cmap', await readFile(new URL('../tests/fixtures/pdfs/acceptance/title-single-column.pdf', import.meta.url)));
const corpus = process.env.PN_PDF_FIXTURE_DIR; if (corpus) for (const id of ['2604.27543v1', '2604.19405v1', '2604.22542v1', '2604.25135v1', '2606.24133v1', '2604.23296v1', '2606.23670v1']) fixtures.set(`real-${id}`, await readFile(path.join(corpus, `${id}.pdf`)));
if (latinMode) {
  for (const [name, encoding, codes] of [['latin-winansi', 'WinAnsiEncoding', '80e9c49e7f81a0ad'], ['latin-macroman', 'MacRomanEncoding', '808edbcadedf']]) {
    fixtures.set(name, simplePdf(`BT /F1 30 Tf 1 0 0 1 54 700 Tm <${codes}> Tj ET`, { font: `/Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /${encoding}` }));
  }
  fixtures.set('latin-logical-replacement', simplePdf('BT /F1 30 Tf 1 0 0 1 54 700 Tm <e9> Tj ET', { font: '/Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding /ToUnicode 6 0 R',
    extra: [stream('begincmap 1 beginbfchar <e9> <0058> endbfchar endcmap')] }));
}
const selectedCorpus = corpusMode ? PDF_ACCEPTANCE_BENCHMARK.slice(corpusOffset, corpusOffset + corpusLimit) : [];
if (corpusMode && !corpus) throw new Error('Full raster corpus requires PN_PDF_FIXTURE_DIR.');
for (const entry of selectedCorpus) {
  const filename = entry.source.startsWith('tests/') ? path.join(root, entry.source) : path.join(corpus, `${entry.id}.pdf`), data = await readFile(filename);
  if (sha(data) !== entry.sha256 || !Number.isSafeInteger(entry.pageNumber) || entry.pageNumber < 1) throw new Error(`Frozen raster source/page changed: ${entry.id}.`);
  fixtures.set(`corpus-${entry.id}`, data); fixturePages.set(`corpus-${entry.id}`, entry.pageNumber);
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><style>body{margin:0;background:#ddd}main{display:flex;align-items:flex-start}canvas{background:white;border:1px solid #999}</style><main><canvas id="own"></canvas><canvas id="reference"></canvas></main>'); return; }
  if (url.pathname === '/oracles/nonisolated-group.png') { response.setHeader('Content-Type', 'image/png'); response.end(groupPng); return; }
  if (url.pathname === '/oracles/stroke-adjustment.png') { response.setHeader('Content-Type', 'image/png'); response.end(strokePng); return; }
  if (url.pathname === '/oracles/icc-blending.png') { response.setHeader('Content-Type', 'image/png'); response.end(iccPng); return; }
  if (url.pathname === '/oracles/axial-shading.png') { response.setHeader('Content-Type', 'image/png'); response.end(axialPng); return; }
  if (url.pathname === '/oracles/axial-poppler.png') { response.setHeader('Content-Type', 'image/png'); response.end(axialPopplerPng); return; }
  if (url.pathname === '/oracles/axial-explicitclip-mupdf.png') { response.setHeader('Content-Type', 'image/png'); response.end(axialControlPng); return; }
  if (url.pathname.startsWith('/cases/')) { const data = fixtures.get(url.pathname.slice(7, -4)); if (data) { response.setHeader('Content-Type', 'application/pdf'); response.end(data); return; } }
  const filename = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!filename.startsWith(root) || !['/src/pdf/', '/native/', '/vendor/pdf-data/', '/vendor/pdf-cmaps/', '/vendor/pdf-glyphs/', '/vendor/pdf-unicode/', '/vendor/pdf-symbols/', '/node_modules/pdfjs-dist/'].some(prefix => url.pathname.startsWith(prefix))) { response.writeHead(404); response.end(); return; }
  const data = await readFile(filename); response.setHeader('Content-Type', /\.m?js$/.test(filename) ? 'text/javascript' : filename.endsWith('.wasm') ? 'application/wasm' : filename.endsWith('.json') ? 'application/json' : 'application/octet-stream'); response.end(data);
})().catch(error => { requestFailures.push({ url: request.url, message: error.message }); response.writeHead(500); response.end(error.message); }); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] }), page = await browser.newPage({ viewport: { width: 1260, height: 850 } }), errors = [], records = [];
page.on('pageerror', error => errors.push(error.message));
page.on('requestfailed', request => requestFailures.push({ url: request.url(), message: request.failure()?.errorText }));
page.on('response', response => { if (response.status() >= 400) requestFailures.push({ url: response.url(), status: response.status() }); });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const jpeg = await page.evaluate(async () => { const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgb(128,128,255)'; ctx.fillRect(0, 0, 1, 1); return [...new Uint8Array(await (await fetch(canvas.toDataURL('image/jpeg', 1))).arrayBuffer())]; });
  fixtures.set('jpeg-matte', simplePdf('q 120 0 0 80 50 500 cm /I Do Q', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [stream(Uint8Array.from(jpeg), '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /SMask 7 0 R'), stream(Uint8Array.of(128), '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Matte [1 1 1]')] }));
  await mkdir(new URL('../artifacts/engines/', import.meta.url), { recursive: true });
  const requested = process.env.PN_PDF_RASTER_CASES?.split(',').filter(Boolean), names = requested || (corpusMode ? selectedCorpus.map(entry => `corpus-${entry.id}`) : latinMode ? [...fixtures.keys()].filter(name => name.startsWith('latin-')) : [...fixtures.keys()]);
  if (corpusMode && requested) throw new Error('Use bounded offset/limit without PN_PDF_RASTER_CASES for the frozen100 corpus.');
  if (names.some(name => !fixtures.has(name))) throw new Error('Unknown requested PDF raster fixture.');
  for (const name of names) {
    const pageNumber = fixturePages.get(name) || 1;
    const record = await page.evaluate(async ({ name, pageNumber }) => {
      let own, reference;
      try {
        const ownPath = '/src/pdf/browser-pdf.js', oraclePath = '/node_modules/pdfjs-dist/build/pdf.mjs';
        const { openPdfDocument } = await import(ownPath), oracle = await import(oraclePath);
        oracle.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';
        const data = new Uint8Array(await (await fetch(`/cases/${name}.pdf`)).arrayBuffer()), wasm = await (await fetch('/native/pdf.wasm')).arrayBuffer();
        const started = performance.now(); own = await openPdfDocument(data, { wasm, useWorker: true, assetBaseUrl: new URL('/vendor/pdf-data/', location.href).href });
        const ownPage = await own.getPage(pageNumber), viewport = ownPage.getViewport(), a = document.querySelector('#own'), b = document.querySelector('#reference');
        for (const canvas of [a, b]) { canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); }
        const ctx = a.getContext('2d', { willReadFrequently: true }), refCtx = b.getContext('2d', { willReadFrequently: true });
        await ownPage.render({ canvasContext: ctx, viewport }).promise; const ownElapsedMs = performance.now() - started;
        reference = oracle.getDocument({ data: data.slice(), standardFontDataUrl: new URL('/vendor/pdf-data/standard_fonts/', location.href).href,
          cMapUrl: new URL('/node_modules/pdfjs-dist/cmaps/', location.href).href, cMapPacked: true, wasmUrl: new URL('/node_modules/pdfjs-dist/wasm/', location.href).href, iccUrl: new URL('/node_modules/pdfjs-dist/iccs/', location.href).href });
        const refDoc = await reference.promise, refPage = await refDoc.getPage(pageNumber), refViewport = refPage.getViewport({ scale: 1 });
        if (Math.ceil(refViewport.width) !== a.width || Math.ceil(refViewport.height) !== a.height) throw new Error('Original/reference page geometry differs.');
        await refPage.render({ canvasContext: refCtx, viewport: refViewport }).promise;
        const ownPixels = ctx.getImageData(0, 0, a.width, a.height).data; let refPixels = refCtx.getImageData(0, 0, b.width, b.height).data, pdfjsDiscrepancy = null;
        if (['nonisolated-group', 'stroke-adjustment', 'image-bands', 'icc-blending', 'axial-shading', 'axial-explicitclip'].includes(name)) {
          let error = 0; for (let i = 0; i < ownPixels.length; i += 4) for (let c = 0; c < 3; c++) error += Math.abs(ownPixels[i + c] - refPixels[i + c]);
          pdfjsDiscrepancy = { meanError: error / (a.width * a.height * 3 * 255), reason: name === 'image-bands' ? 'Compare image band boundaries against the same full-surface Canvas raster.' : name === 'stroke-adjustment' ? 'MuPDF ignores SA too; its raster is a visual diagnostic. Normative horizontal pixel widths are asserted separately.' : name === 'icc-blending' ? 'Compare ICC numeric blending and nested color-space conversion with independent MuPDF color management.' : 'Compare original axial shading/non-isolated blending with the independent MuPDF raster.' };
          if (name === 'image-bands') {
            const width = 2000, height = 4200, pixels = new Uint8ClampedArray(width * height * 4);
            for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
              const i = y * width + x; pixels[i * 4] = Math.round(x / (width - 1) * 255); pixels[i * 4 + 1] = Math.round(y / (height - 1) * 255); pixels[i * 4 + 2] = Math.floor(y / 32) % 2 ? 60 : 180; pixels[i * 4 + 3] = 128 + x % 128;
            }
            const surface = new OffscreenCanvas(width, height); surface.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
            refCtx.save(); try { refCtx.setTransform(1, 0, 0, 1, 0, 0); refCtx.fillStyle = 'white'; refCtx.fillRect(0, 0, b.width, b.height); refCtx.transform(...viewport.transform); refCtx.transform(300, 0, 0, 630, 40, 90); refCtx.scale(1 / width, -1 / height); refCtx.drawImage(surface, 0, -height); } finally { refCtx.restore(); surface.width = surface.height = 0; }
            refPixels = refCtx.getImageData(0, 0, b.width, b.height).data;
          } else {
            const oracleName = name === 'axial-shading' ? 'axial-poppler' : name === 'axial-explicitclip' ? 'axial-explicitclip-mupdf' : name;
            const bitmap = await createImageBitmap(await (await fetch(`/oracles/${oracleName}.png`)).blob());
            try { if (bitmap.width !== a.width || bitmap.height !== a.height) throw new Error('Independent oracle dimensions differ.'); refCtx.drawImage(bitmap, 0, 0); refPixels = refCtx.getImageData(0, 0, b.width, b.height).data; } finally { bitmap.close(); }
          }
        }
        let error = 0, changed = 0, ownInk = 0, referenceInk = 0, maximumChannelError = 0;
        for (let i = 0; i < ownPixels.length; i += 4) { let maximum = 0; for (let c = 0; c < 3; c++) { const delta = Math.abs(ownPixels[i + c] - refPixels[i + c]); error += delta; maximum = Math.max(maximum, delta); } maximumChannelError = Math.max(maximumChannelError, maximum); if (maximum > 20) changed++; if (Math.min(...ownPixels.subarray(i, i + 3)) < 230) ownInk++; if (Math.min(...refPixels.subarray(i, i + 3)) < 230) referenceInk++; }
        const ownText = (await ownPage.getTextContent()).items.map(i => i.str).join(' '), referenceText = (await refPage.getTextContent()).items.map(i => i.str).join(' '), normalize = s => s.normalize('NFKC').replace(/\s+/g, '');
        const meanError = error / (a.width * a.height * 3 * 255), changedFraction = changed / (a.width * a.height);
        let strokeGeometry = null;
        if (name === 'stroke-adjustment') {
          const expected = [1, 1, 1, 1, 1, 1, 2, 3], measured = expected.map((_, i) => {
            const center = a.height - 20.2 - i * 14; let coverage = 0;
            for (let y = Math.floor(center - 4); y <= Math.ceil(center + 4); y++) for (let x = 25; x < 215; x++) coverage += (255 - ownPixels[(y * a.width + x) * 4]) / 255 / 190;
            return coverage;
          });
          strokeGeometry = { expectedDeviceWidths: expected, measuredDeviceWidths: measured, passed: measured.every((n, i) => Math.abs(n - expected[i]) < 1e-8), independentSaRasterAvailable: false };
        }
        if (name === 'axial-shading') window.pdfAxialOriginalPixels = ownPixels.slice();
        let equivalentClip = null;
        if (name === 'axial-explicitclip' && window.pdfAxialOriginalPixels) {
          const expected = window.pdfAxialOriginalPixels; let changed = 0, maximumChannelError = 0;
          for (let i = 0; i < ownPixels.length; i++) { const delta = Math.abs(ownPixels[i] - expected[i]); if (delta) changed++; maximumChannelError = Math.max(maximumChannelError, delta); }
          equivalentClip = { changedBytes: changed, maximumChannelError, passed: changed === 0 }; delete window.pdfAxialOriginalPixels;
        }
        return { name, oracle: name === 'stroke-adjustment' ? 'MuPDF visual diagnostic (SA ignored); normative device widths asserted' : name === 'axial-shading' ? 'Poppler frozen full-page raster; original MuPDF clipping discrepancy retained' : ['nonisolated-group', 'icc-blending', 'axial-explicitclip'].includes(name) ? 'MuPDF frozen full-page raster' : name === 'image-bands' ? 'Canvas full-surface fixed source control' : 'PDF.js', strokeGeometry, equivalentClip, pdfjsDiscrepancy, width: a.width, height: a.height, ownElapsedMs, meanError, changedFraction, maximumChannelError, ownInk, referenceInk, textEquivalent: normalize(ownText) === normalize(referenceText), ownText: ownText.slice(0, 300), referenceText: referenceText.slice(0, 300), passed: (!equivalentClip || equivalentClip.passed) && (!strokeGeometry || strokeGeometry.passed) && (!['nonisolated-group', 'image-bands'].includes(name) || maximumChannelError <= 2) && (name !== 'icc-blending' || maximumChannelError <= 3) && meanError < .025 && changedFraction < .06 && ownInk >= referenceInk * .7 && ownInk <= referenceInk * 1.3 };
      } catch (error) { return { name, passed: false, message: error.message, stack: error.stack }; }
      finally { own?.destroy(); await reference?.destroy(); }
    }, { name, pageNumber });
    record.pageNumber = pageNumber;
    record.sourceSha256 = sha(fixtures.get(name)); record.wasmSha256 = sha(await readFile(new URL('../native/pdf.wasm', import.meta.url)));
    if (name === 'axial-shading') record.originalOracleDiscrepancy = axialComparison;
    records.push(record); await page.screenshot({ path: fileURLToPath(new URL(`../artifacts/engines/pdf-raster-${name}.png`, import.meta.url)), fullPage: true });
    console.log(JSON.stringify(record));
  }
  const sourcesUnchanged = JSON.stringify(sourcePins) === JSON.stringify(await implementationPins());
  const report = { gpuDisabledForThisSmoke: true, fullRendererAcceptance: false, productionIntegrationEvidence: 'Separate installed original-facade report at artifacts/engines/pdf-app/report.json',
    scope: corpusMode ? 'Frozen100-source manifest referenced pages; bounded batch, isolated PDF.js oracle, unchanged physical scale/pixel thresholds; unsupported/static appearance failures retained.' : latinMode ? 'Three original Latin-encoding and ToUnicode source-paint controls; independent PDF.js oracle, unchanged scale/pixel thresholds.' : 'Original21 fixed raster controls; independent oracle discrepancies retained.',
    cohort: corpusMode ? { manifestCount: PDF_ACCEPTANCE_BENCHMARK.length, offset: corpusOffset, limit: corpusLimit, selected: selectedCorpus.map(entry => ({ id: entry.id, sha256: entry.sha256, pageNumber: entry.pageNumber })) } : null,
    thresholds: { meanErrorExclusive: .025, changedFractionExclusive: .06, changedPixelChannelThreshold: 20, minimumInkRatio: .7, maximumInkRatio: 1.3 },
    sourcePins, sourcesUnchanged, passed: records.filter(r => r.passed).length, total: records.length, errors, requestFailures, records };
  await writeFile(reportUrl, `${JSON.stringify(report, null, 2)}\n`);
  if (!sourcesUnchanged || errors.length || requestFailures.length || records.some(record => !record.passed)) process.exitCode = 1;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
