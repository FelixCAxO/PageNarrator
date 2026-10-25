// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Product extraction in real Chromium; this is not an independent reference.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { readPdfCorpusImplementationPins } from './pdf-corpus-control-integrity.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARGS = ['--disable-gpu', '--disable-webgpu', '--mute-audio'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const describeError = error => ({ name: error?.name, code: error?.code ?? null, message: String(error?.message || error) });
async function pin(filename) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(filename)) { bytes += chunk.length; hash.update(chunk); }
  return { path: filename, bytes, sha256: hash.digest('hex') };
}

// The callback runs in the browser, against the original facade and module worker.
async function installBridge() {
  const engine = await import(new URL('/src/pdf/pdf-engine.js', location.href).href);
  if (engine.isPageNarratorPdfEngine !== true) throw new Error('Wrong browser PDF implementation.');
  const tasks = new Map(), documents = new Map();
  const close = async id => {
    const task = tasks.get(id), document = documents.get(id);
    if (task) await task.destroy();
    if (document) {
      let rejected = false;
      try { await document.getPage(1); } catch (error) { rejected = error.code === 'pdf_closed'; }
      if (!rejected) throw new Error('Destroyed production PDF remained usable.');
    }
    tasks.delete(id); documents.delete(id); return { closed: true };
  };
  globalThis.__pnPdfAcceptance = async ({ method, id, pageNumber, url, password, useSystemFonts }) => {
    try {
      let value;
      if (method === 'open') {
        const task = engine.getDocument({ url, password, useSystemFonts, useWorker: true, disableWorker: false,
          wasmUrl: `${location.origin}/native/pdf.wasm`, assetBaseUrl: `${location.origin}/vendor/pdf-data/`, enableScripting: false });
        tasks.set(id, task);
        const document = await task.promise; documents.set(id, document); value = { numPages: document.numPages };
      } else if (method === 'destroy') value = await close(id);
      else if (method === 'closeAll') {
        const records = [];
        for (const current of tasks.keys()) {
          try { records.push({ id: current, ...await close(current) }); }
          catch (error) { records.push({ id: current, closed: false, error: { name: error.name, code: error.code, message: error.message } }); }
        }
        value = records;
      } else {
        const document = documents.get(id);
        if (!document) throw new Error('Browser acceptance document is not open.');
        const page = await document.getPage(pageNumber);
        if (method === 'page') value = { view: page.view, rotate: page.rotate, userUnit: page.userUnit, pageNumber };
        else if (method === 'text') value = await page.getTextContent();
        else if (method === 'inspect') value = await page.inspect();
        else if (method === 'cleanup') { page.cleanup(); value = null; }
        else throw new Error('Unknown browser PDF acceptance operation.');
      }
      return { ok: true, value };
    } catch (error) { return { ok: false, error: { name: error.name, code: error.code ?? null, message: error.message, browserStack: error.stack } }; }
  };
  return { isPageNarratorPdfEngine: engine.isPageNarratorPdfEngine,
    createImageBitmap: typeof createImageBitmap === 'function', offscreenCanvas: typeof OffscreenCanvas === 'function' };
}

export async function createPdfAcceptanceBrowser({ root = ROOT, readImplementationPins = readPdfCorpusImplementationPins,
  launchBrowser = options => chromium.launch(options), executablePath = chromium.executablePath() } = {}) {
  root = path.resolve(root);
  const sourcePins = await readImplementationPins(root), sources = new Map(), pdfs = new Map(), served = new Map();
  const driverPins = await Promise.all(['./pdf-acceptance-browser.mjs', './pdf-acceptance-backend.mjs'].map(relative => pin(fileURLToPath(new URL(relative, import.meta.url)))));
  for (const expected of sourcePins) {
    const relative = expected.path;
    if (!(relative.startsWith('src/') && relative.endsWith('.js') || relative === 'native/pdf.wasm' || relative.startsWith('vendor/'))) continue;
    const filename = path.resolve(root, relative), inside = path.relative(root, filename);
    assert(inside && !inside.startsWith('..') && !path.isAbsolute(inside), 'Unsafe browser acceptance source path.');
    const bytes = await readFile(filename);
    assert.equal(bytes.length, expected.bytes); assert.equal(sha(bytes), expected.sha256);
    sources.set(relative, { bytes, pin: expected });
  }
  let browser, context, page, server, closing = false, disposed = false, disposal, forcedContextClose, queue = Promise.resolve();
  const evidence = { backend: 'original-browser', sourceRoot: root, sourcePins, driverPins, servedPins: [], documents: [], workers: [],
    unexpectedRequests: [], serverErrors: [], browserErrors: [], cleanupErrors: [], operationFailures: [], requestFailures: [],
    browserArguments: [...ARGS], headless: true, browserClosed: false, contextClosed: false, serverClosed: false };
  const enqueue = action => {
    if (closing) return Promise.reject(new Error('Browser PDF acceptance backend is closing.'));
    const result = queue.then(action); queue = result.catch(error => evidence.operationFailures.push(describeError(error))); return result;
  };
  const evaluate = async (callback, payload) => {
    let timer;
    try {
      return await Promise.race([page.evaluate(callback, payload), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Browser PDF acceptance RPC exceeded 120 seconds.'),
          { code: 'PDF_ACCEPTANCE_BROWSER_TIMEOUT' })), 120_000);
      })]);
    } catch (error) {
      if (error.code === 'PDF_ACCEPTANCE_BROWSER_TIMEOUT') {
        evidence.browserErrors.push(describeError(error));
        forcedContextClose ??= context.close().then(() => { evidence.contextClosed = true; }, closeError => evidence.cleanupErrors.push(describeError(closeError)));
      }
      throw error;
    } finally { clearTimeout(timer); }
  };
  const rpc = async payload => {
    const result = await evaluate(payload => globalThis.__pnPdfAcceptance(payload), payload);
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
    return result.value;
  };
  const dispose = () => disposal ??= (async () => {
    closing = true;
    await queue;
    if (page && !forcedContextClose) {
      try {
        for (const record of await rpc({ method: 'closeAll' })) {
          const node = evidence.documents.find(row => row.id === record.id);
          if (node) node.closed = record.closed;
          if (record.error) evidence.cleanupErrors.push(record.error);
        }
      } catch (error) { evidence.cleanupErrors.push(describeError(error)); }
    }
    try { if (forcedContextClose) await forcedContextClose; else await context?.close(); evidence.contextClosed = true; } catch (error) { evidence.cleanupErrors.push(describeError(error)); }
    try { await browser?.close(); evidence.browserClosed = true; } catch (error) { evidence.cleanupErrors.push(describeError(error)); }
    if (server) {
      try { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); evidence.serverClosed = true; }
      catch (error) { evidence.cleanupErrors.push(describeError(error)); }
    } else evidence.serverClosed = true;
    pdfs.clear();
    try {
      evidence.sourcePinsUnchanged = JSON.stringify(sourcePins) === JSON.stringify(await readImplementationPins(root));
      evidence.driverPinsUnchanged = JSON.stringify(driverPins) === JSON.stringify(await Promise.all(driverPins.map(row => pin(row.path))));
      evidence.servedPins = [...served.values()].sort((a, b) => a.path.localeCompare(b.path));
      for (const expected of evidence.servedPins) assert.deepEqual(await pin(path.join(root, expected.path)), { ...expected, path: path.join(root, expected.path) });
      evidence.servedPinsUnchanged = true;
    } catch (error) { evidence.cleanupErrors.push(describeError(error)); }
    evidence.allDocumentsClosed = evidence.documents.every(row => row.closed);
    evidence.allWorkersClosed = evidence.workers.every(row => row.closed);
    evidence.productionWorkerObserved = !evidence.documents.some(row => row.opened)
      || served.has('src/pdf/pdf.worker.js') && evidence.workers.some(row => row.url.endsWith('/src/pdf/pdf.worker.js'));
    evidence.pass = evidence.contextClosed && evidence.browserClosed && evidence.serverClosed && evidence.allDocumentsClosed
      && evidence.allWorkersClosed && evidence.sourcePinsUnchanged && evidence.driverPinsUnchanged && evidence.servedPinsUnchanged
      && evidence.productionWorkerObserved
      && !evidence.initializationError
      && !evidence.unexpectedRequests.length && !evidence.serverErrors.length && !evidence.browserErrors.length && !evidence.cleanupErrors.length;
    disposed = true; return evidence;
  })();
  try {
    evidence.browserExecutable = await pin(executablePath);
    server = createServer((request, response) => { void (async () => {
      const relative = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).slice(1);
      if (request.method !== 'GET') throw new Error('Unexpected browser acceptance HTTP method.');
      if (!relative) { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Production PDF acceptance</title>'); return; }
      if (relative === 'favicon.ico') { response.writeHead(204).end(); return; }
      const pdf = relative.startsWith('pdf/') ? pdfs.get(relative.slice(4)) : null;
      const source = sources.get(relative);
      if (!pdf && !source) throw new Error(`Unregistered browser acceptance resource: ${relative}`);
      const bytes = pdf?.bytes ?? source.bytes;
      if (pdf) { assert.equal(sha(bytes), pdf.record.sha256); pdf.record.requests++; }
      else served.set(relative, source.pin);
      const mime = pdf ? 'application/pdf' : relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.json') ? 'application/json'
        : relative.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length }).end(bytes);
    })().catch(error => { evidence.serverErrors.push(describeError(error)); if (!response.headersSent) response.writeHead(404); response.end(); }); });
    server.on('error', error => evidence.serverErrors.push(describeError(error)));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await launchBrowser({ headless: true, args: [...ARGS] }); evidence.browserVersion = browser.version();
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      evidence.unexpectedRequests.push(route.request().url()); return route.abort();
    });
    page = await context.newPage(); page.setDefaultTimeout(120_000);
    page.on('worker', worker => { const record = { url: worker.url(), closed: false }; evidence.workers.push(record); worker.on('close', () => { record.closed = true; }); });
    page.on('pageerror', error => evidence.browserErrors.push(describeError(error)));
    page.on('requestfailed', request => evidence.requestFailures.push({ url: request.url(), failure: request.failure() }));
    await page.goto(origin);
    evidence.capabilities = await evaluate(installBridge);
    assert(evidence.capabilities.isPageNarratorPdfEngine && evidence.capabilities.createImageBitmap && evidence.capabilities.offscreenCanvas,
      'Production browser decoder capabilities are missing.');
    const engine = { isPageNarratorPdfEngine: true, getDocument(input) {
      const params = input instanceof Uint8Array || input instanceof ArrayBuffer ? { data: input } : input ?? {};
      const id = randomUUID(), record = { id, opened: false, closed: false, requests: 0 };
      evidence.documents.push(record);
      let destruction;
      const destroy = () => destruction ??= enqueue(async () => {
        try { const result = await rpc({ method: 'destroy', id }); record.closed = result.closed; }
        finally { pdfs.delete(id); }
      });
      const promise = enqueue(async () => {
        const data = params.data instanceof ArrayBuffer ? new Uint8Array(params.data) : params.data;
        if (!(data instanceof Uint8Array)) throw new TypeError('Browser acceptance requires registered PDF input bytes.');
        const bytes = Buffer.from(data); record.bytes = bytes.length; record.sha256 = sha(bytes);
        pdfs.set(id, { bytes, record });
        const priorWorkers = evidence.workers.length;
        const actual = await rpc({ method: 'open', id, url: `${origin}/pdf/${id}`, password: params.password, useSystemFonts: params.useSystemFonts ?? true });
        assert(evidence.workers.slice(priorWorkers).some(worker => worker.url === `${origin}/src/pdf/pdf.worker.js`), 'Production PDF module worker was not observed.');
        record.opened = true; record.numPages = actual.numPages;
        return { numPages: actual.numPages, destroy, async getPage(pageNumber) {
          const geometry = await enqueue(() => rpc({ method: 'page', id, pageNumber }));
          return { ...geometry, getTextContent: () => enqueue(() => rpc({ method: 'text', id, pageNumber })),
            inspect: () => enqueue(() => rpc({ method: 'inspect', id, pageNumber })), cleanup() {
              const result = enqueue(() => rpc({ method: 'cleanup', id, pageNumber }));
              void result.catch(error => evidence.cleanupErrors.push(describeError(error))); return result;
            } };
        } };
      });
      void promise.catch(error => { record.openError = describeError(error); });
      return { promise, destroy };
    } };
    const identityPins = sourcePins.filter(row => ['src/pdf/pdf-engine.js', 'src/pdf/pdf.worker.js', 'native/pdf.wasm'].includes(row.path));
    return { engine, identity: { backend: 'original-browser', version: null, sourcePins: [...identityPins, ...driverPins],
      scope: 'Production source facade/module worker in headless software Chromium, not Node core mode or an independent reference.',
      browserVersion: evidence.browserVersion, browserExecutable: evidence.browserExecutable, browserArguments: [...ARGS] },
    dispose, integrity: () => ({ disposed, ...evidence }) };
  } catch (error) {
    evidence.initializationError = describeError(error);
    const integrity = await dispose(); error.backendIntegrity = integrity; throw error;
  }
}
