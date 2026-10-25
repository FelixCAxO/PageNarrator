// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { readPrivateOcrFixture } from './lib/ocr-private-fixtures.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const referenceImport = "const { createBrowserInferenceEngine } = await import('../engines/browser-inference.js');";
const privateImages = new Map(await Promise.all(['curved-lines.png', 'rating-matrix.png'].map(async name =>
  [`/tests/fixtures/ocr/${name}`, await readPrivateOcrFixture(name)])));
const photoPath = resolve(root, '.cache/engine-fixtures/docunet-35_1.jpg');
const photoHash = createHash('sha256').update(await readFile(photoPath)).digest('hex');
if (photoHash !== 'aef29c038a795579cc4024eee0ee3e1f98fd407819c506c658d162fa89e5585f') throw new Error('The frozen DocUNet fixture changed.');
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
    if (pathname === '/') { response.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); response.end('<!doctype html><title>PageNarrator OCR pipeline verification</title>'); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (/^\/reference\/src\/lib\/[a-z0-9-]+\.js$/.test(pathname)) {
      // Vary the inference backend, keeping page preprocessing and geometry common.
      const relativePath = pathname.slice(11);
      let source = await readFile(resolve(root, relativePath), 'utf8');
      if (relativePath === 'src/lib/pdf-ocr-unwarp.js') {
        if (source.split(referenceImport).length !== 2) throw new Error('OCR reference adapter injection point changed.');
        source = source.replace(referenceImport, "const createBrowserInferenceEngine = () => ({ ...globalThis.__pnOcrReference, dispose: async () => {} });");
      }
      response.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }); response.end(source); return;
    }
    if (privateImages.has(pathname)) {
      response.writeHead(200, { ...headers, 'Content-Type': 'image/png' }); response.end(privateImages.get(pathname)); return;
    }
    const path = pathname.startsWith('/runtime/') ? resolve(root, 'node_modules/onnxruntime-web/dist', pathname.slice(9)) : resolve(root, `.${pathname}`);
    const type = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' }[extname(path)];
    if (!path.startsWith(`${root}${sep}`) || !type) { response.writeHead(404); response.end(); return; }
    const bytes = await readFile(path);
    response.writeHead(200, { ...headers, 'Content-Type': type }); response.end(bytes);
  } catch (error) { response.writeHead(500); response.end(error.message); }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
let browser;
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const candidateModule = '/src/lib/pdf-ocr-unwarp.js', baselineModule = '/reference/src/lib/pdf-ocr-unwarp.js';
    const candidateNative = '/src/lib/native-kernels.js', baselineNative = '/reference/src/lib/native-kernels.js';
    const ortModule = '/runtime/ort.webgpu.bundle.min.mjs';
    const ort = await import(ortModule); ort.env.logLevel = 'error';
    globalThis.__pnOcrReference = ort;
    const candidateInferenceModule = '/src/engines/browser-inference.js';
    const candidateInference = await import(candidateInferenceModule);
    const native = await import(candidateNative);
    const detectorRecords = { reference: [], candidate: [] };
    function capture(session, source, lane) {
      if (!String(source).endsWith('tiny-det.onnx')) return session;
      const run = session.run.bind(session);
      session.run = async feeds => {
        const output = await run(feeds), tensor = output[session.outputNames[0]];
        const [, , h, w] = tensor.dims;
        detectorRecords[lane].push({ shape: tensor.dims, boxes: native.detectorComponents(tensor.data.slice(), w, h, w, h) });
        return output;
      };
      return session;
    }
    const originalCreate = ort.InferenceSession.create;
    const originalCandidateCreate = candidateInference.InferenceSession.create;
    ort.InferenceSession.create = async function (source, options) { return capture(await originalCreate.call(this, source, { ...options, logSeverityLevel: 3 }), source, 'reference'); };
    candidateInference.InferenceSession.create = async function (source, options) { return capture(await originalCandidateCreate.call(this, source, options), source, 'candidate'); };
    const baselineApi = await import(baselineModule), candidateApi = await import(candidateModule);
    await (await import(baselineNative)).initializeNativeKernels(`${location.origin}/public/native/kernels.wasm`);
    await (await import(candidateNative)).initializeNativeKernels(`${location.origin}/public/native/kernels.wasm`);
    const runtime = { getURL: path => `${location.origin}/${path.startsWith('onnx/') ? `runtime/${path.slice(5)}` : `public/${path}`}` };
    const reference = baselineApi.createPdfOcrUnwarp(runtime), candidate = candidateApi.createPdfOcrUnwarp(runtime);
    try {
      const cases = [];
      for (const imageUrl of ['/tests/fixtures/ocr/curved-lines.png', '/tests/fixtures/ocr/rating-matrix.png', '/.cache/engine-fixtures/docunet-35_1.jpg']) {
        detectorRecords.reference = []; detectorRecords.candidate = [];
        const image = new Image(); image.src = imageUrl; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        const bounds = { left: 0, top: 0, right: image.width, bottom: image.height };
        const startReference = performance.now();
        const expected = await reference.retry(canvas, null, bounds);
        const referenceMs = performance.now() - startReference;
        const startCandidate = performance.now();
        const actual = await candidate.retry(canvas, null, bounds);
        const candidateMs = performance.now() - startCandidate;
        if (!expected?.length || !actual?.length) throw new Error(`OCR returned no lines: ${imageUrl}, reference=${expected?.length}, candidate=${actual?.length}`);
        const expectedWords = expected.flatMap(line => line.words), actualWords = actual.flatMap(line => line.words);
        const expectedText = expectedWords.map(word => word.text).join(' '), actualText = actualWords.map(word => word.text).join(' ');
        const textMatches = actualText === expectedText;
        let maximumCoordinateError = 0;
        const geometryDifferences = [];
        if (expectedWords.length === actualWords.length) for (let i = 0; i < expectedWords.length; i += 1) {
          let error = 0;
          for (const axis of ['x0', 'y0', 'x1', 'y1']) error = Math.max(error, Math.abs(expectedWords[i].bbox[axis] - actualWords[i].bbox[axis]));
          maximumCoordinateError = Math.max(maximumCoordinateError, error);
          if (error > 1.5) geometryDifferences.push({ i, expected: expectedWords[i], actual: actualWords[i], error });
        }
        else maximumCoordinateError = null;
        cases.push({ imageUrl, width: image.width, height: image.height, lines: actual.length, words: actualWords.length, actualText, expectedText,
          expectedWords: textMatches ? undefined : expectedWords, actualWords: textMatches ? undefined : actualWords,
          detectorRecords: textMatches ? undefined : structuredClone(detectorRecords),
          textMatches, maximumCoordinateError, geometryDifferences,
          referenceMs, candidateMs, timingScope: 'single cold or mixed-shape document pass; diagnostic only' });
        const reviewRegions = [...geometryDifferences];
        if (imageUrl.endsWith('rating-matrix.png')) for (let i = 0; i < actualWords.length; i++) {
          if (actualWords[i].text === '-0.08' || (actualWords[i].text === 'u1' && actualWords[i].bbox.x0 > 900)) reviewRegions.push({ expected: expectedWords[i], actual: actualWords[i] });
        }
        for (const difference of reviewRegions) {
          const a = difference.expected.bbox, b = difference.actual.bbox;
          const left = Math.floor(Math.min(a.x0, b.x0) - 12), top = Math.floor(Math.min(a.y0, b.y0) - 12);
          const width = Math.ceil(Math.max(a.x1, b.x1) - left + 12), height = Math.ceil(Math.max(a.y1, b.y1) - top + 12);
          const preview = document.createElement('canvas'); preview.width = width * 4; preview.height = height * 4;
          const context = preview.getContext('2d'); context.scale(4, 4); context.drawImage(image, left, top, width, height, 0, 0, width, height);
          context.lineWidth = 0.5;
          for (const [box, color] of [[a, 'red'], [b, 'blue']]) { context.strokeStyle = color; context.strokeRect(box.x0 - left, box.y0 - top, box.x1 - box.x0, box.y1 - box.y0); }
          document.body.append(preview);
        }
        canvas.width = canvas.height = 0;
      }
      return { cases };
    } finally {
      const closed = await Promise.allSettled([reference.destroy(), candidate.destroy()]);
      ort.InferenceSession.create = originalCreate;
      candidateInference.InferenceSession.create = originalCandidateCreate;
      const failed = closed.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
  });
  await page.screenshot({ path: resolve(root, 'artifacts/engines/ocr-geometry-diagnostic.png'), fullPage: true });
  if (errors.length) throw new Error(errors.join('\n'));
  const output = resolve(root, 'artifacts/engines/ocr-pipeline-parity.json');
  const pass = result.cases.every(item => item.textMatches && item.maximumCoordinateError !== null && item.maximumCoordinateError <= 1.5);
  const report = { status: pass ? 'pass' : 'fail', reference: 'Packaged ONNX Runtime WebGPU injected at the inference boundary', preprocessing: 'shared current page preprocessing and geometry', photoSha256: photoHash, fixtureSource: 'https://www3.cs.stonybrook.edu/~cvl/docunet.html', scope: 'Three development images; output parity, not held-out OCR quality acceptance', ...result };
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, cases: report.cases.map(({ actualText, expectedText, actualWords: _actualWords, expectedWords: _expectedWords, detectorRecords: _detectorRecords, ...item }) => ({ ...item, textCharacters: actualText.length, referenceTextCharacters: expectedText.length })) }, null, 2));
  if (!pass) throw new Error(`Full-page OCR parity differs; inspect ${output}.`);
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
