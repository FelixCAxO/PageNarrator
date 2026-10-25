// Adapter unit controls use original metadata and a mock browser; real browser smoke is recorded separately.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfAcceptanceBrowser } from '../../scripts/lib/pdf-acceptance-browser.mjs';

const roots = [], sessions = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const text = { items: [{ str: 'Original authored text', transform: [10, 0, 0, 10, 20, 30], width: 50, height: 10 }],
  styles: { own: { fontFamily: 'own', ascent: .8 } }, unknownType3Glyphs: 2 };
const inspection = { hasRasterImage: true, hasOutlinedText: false, unknownType3Glyphs: 2, decodingWarnings: [{ authored: true }] };
async function fixture({ rejectLaunch = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pn-browser-backend-')); roots.push(root);
  const files = ['src/pdf/pdf-engine.js', 'src/pdf/pdf.worker.js', 'native/pdf.wasm'];
  for (const file of [...files, 'browser.exe']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), 'Original unit source placeholder.');
  }
  const readImplementationPins = async () => files.map(file => {
    const bytes = readFileSync(path.join(root, file)); return { path: file, bytes: bytes.length, sha256: hash(bytes) };
  });
  const page = new EventEmitter(), workers = [], calls = [], open = new Set();
  let origin, routeHandler, active = 0, maximumActive = 0, closed = false;
  page.setDefaultTimeout = vi.fn();
  page.goto = vi.fn(async url => { origin = url; expect((await fetch(url)).status).toBe(200); });
  page.evaluate = vi.fn(async (_callback, request) => {
    if (closed) throw new Error('Unit context closed.');
    if (!request?.method) {
      expect((await fetch(`${origin}/src/pdf/pdf-engine.js`)).status).toBe(200);
      return { isPageNarratorPdfEngine: true, createImageBitmap: true, offscreenCanvas: true };
    }
    active++; maximumActive = Math.max(maximumActive, active); calls.push(request.method);
    try {
      let value;
      if (request.method === 'open') {
        const response = await fetch(request.url); expect(response.status).toBe(200);
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
        expect((await fetch(`${origin}/src/pdf/pdf.worker.js`)).status).toBe(200);
        const worker = new EventEmitter(); worker.url = () => `${origin}/src/pdf/pdf.worker.js`; workers.push(worker); page.emit('worker', worker);
        open.add(request.id); value = { numPages: 3 };
      } else if (request.method === 'page') value = { view: [0, 0, 600, 800], rotate: 90, userUnit: 2, pageNumber: request.pageNumber };
      else if (request.method === 'text') value = structuredClone(text);
      else if (request.method === 'inspect') value = structuredClone(inspection);
      else if (request.method === 'cleanup') { await new Promise(resolve => setTimeout(resolve, 2)); value = null; }
      else if (request.method === 'destroy') { open.delete(request.id); value = { closed: true }; }
      else if (request.method === 'closeAll') { value = [...open].map(id => ({ id, closed: true })); open.clear(); }
      else throw new Error('Unexpected unit operation');
      return { ok: true, value };
    } finally { active--; }
  });
  const context = { route: vi.fn(async (_pattern, handler) => { routeHandler = handler; }),
    newPage: vi.fn(async () => page), close: vi.fn(async () => { closed = true; for (const worker of workers) worker.emit('close'); }) };
  const browser = { version: () => 'authored-browser-stub', newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  const launchBrowser = vi.fn(async () => { if (rejectLaunch) throw new Error('Authored launch failure'); return browser; });
  const create = () => createPdfAcceptanceBrowser({ root, readImplementationPins, launchBrowser, executablePath: path.join(root, 'browser.exe') });
  return { root, create: async () => { const session = await create(); sessions.push(session); return session; }, rawCreate: create,
    browser, context, page, calls, launchBrowser, maximumActive: () => maximumActive,
    route: route => routeHandler(route), origin: () => origin };
}
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
  for (const root of roots.splice(0)) {
    const relative = path.relative(tmpdir(), root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe browser-test cleanup.');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('real browser acceptance adapter contract', () => {
  it('returns exact page/text/inspection data and queues ignored cleanup before later RPCs', async () => {
    const f = await fixture(), session = await f.create();
    const task = session.engine.getDocument({ data: new Uint8Array([1, 2, 3]), disableWorker: true });
    const document = await task.promise, page = await document.getPage(2);
    expect(document.numPages).toBe(3); expect(page).toMatchObject({ rotate: 90, userUnit: 2, view: [0, 0, 600, 800] });
    expect(await page.getTextContent()).toEqual(text); expect(await page.inspect()).toEqual(inspection);
    page.cleanup(); const following = page.getTextContent(); await following;
    expect(f.calls.slice(-2)).toEqual(['cleanup', 'text']); expect(f.maximumActive()).toBe(1);
    await task.destroy();
    const result = await session.dispose();
    expect(result.pass).toBe(true); expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({ opened: true, closed: true, requests: 1, bytes: 3, sha256: hash(Buffer.from([1, 2, 3])) });
    expect(result.allWorkersClosed).toBe(true); expect(result.serverClosed).toBe(true);
    expect(session.engine.GlobalWorkerOptions).toBeUndefined();
    expect(f.launchBrowser.mock.calls[0][0]).toEqual({ headless: true, args: ['--disable-gpu', '--disable-webgpu', '--mute-audio'] });
  });
  it('closes forgotten documents and every worker during disposal', async () => {
    const f = await fixture(), session = await f.create();
    await session.engine.getDocument(new Uint8Array([1, 2, 3])).promise;
    const result = await session.dispose();
    expect(result).toMatchObject({ pass: true, allDocumentsClosed: true, allWorkersClosed: true, browserClosed: true, contextClosed: true });
    expect(await session.dispose()).toBe(result); expect(f.context.close).toHaveBeenCalledOnce();
  });
  it('never accepts an arbitrary source URL and still closes its task', async () => {
    const f = await fixture(), session = await f.create(), task = session.engine.getDocument({ url: 'https://example.test/private.pdf' });
    await expect(task.promise).rejects.toThrow('registered PDF input bytes'); await task.destroy();
    expect((await session.dispose()).pass).toBe(true); expect(f.calls).not.toContain('open');
  });
  it('preserves original remote errors without substituting inspection metadata', async () => {
    const f = await fixture(), session = await f.create(), task = session.engine.getDocument(new Uint8Array([1, 2, 3]));
    const page = await (await task.promise).getPage(1);
    f.page.evaluate.mockImplementationOnce(async () => ({ ok: false, error: { name: 'PdfEngineError', code: 'pdf_unsupported', message: 'Original refusal', browserStack: 'original stack' } }));
    await expect(page.inspect()).rejects.toMatchObject({ name: 'PdfEngineError', code: 'pdf_unsupported', message: 'Original refusal', browserStack: 'original stack' });
    await task.destroy(); expect((await session.dispose()).pass).toBe(true);
  });
  it('blocks off-origin requests and refuses unregistered local paths', async () => {
    const f = await fixture(), session = await f.create();
    const abort = vi.fn(), proceed = vi.fn();
    await f.route({ request: () => ({ url: () => 'https://example.test/model.bin' }), abort, continue: proceed });
    expect(abort).toHaveBeenCalledOnce(); expect(proceed).not.toHaveBeenCalled();
    expect((await fetch(`${f.origin()}/private-gold.json`)).status).toBe(404);
    const result = await session.dispose(); expect(result.pass).toBe(false);
    expect(result.unexpectedRequests).toHaveLength(1); expect(result.serverErrors).toHaveLength(1);
    expect(result.browserClosed && result.serverClosed).toBe(true);
  });
  it('fails integrity after served source changes while still closing browser/server', async () => {
    const f = await fixture(), session = await f.create();
    writeFileSync(path.join(f.root, 'src/pdf/pdf-engine.js'), 'Changed owned source.');
    const result = await session.dispose();
    expect(result.pass).toBe(false); expect(result.sourcePinsUnchanged).toBe(false);
    expect(result.browserClosed && result.serverClosed).toBe(true);
  });
  it('closes a started server when browser launch fails', async () => {
    const f = await fixture({ rejectLaunch: true });
    await expect(f.rawCreate()).rejects.toMatchObject({ message: 'Authored launch failure', backendIntegrity: { serverClosed: true, pass: false } });
  });
  it('bounds a hung RPC and closes the browser without claiming acknowledged document disposal', async () => {
    const f = await fixture(), session = await f.create();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      f.page.evaluate.mockImplementationOnce(() => new Promise(() => {}));
      const task = session.engine.getDocument(new Uint8Array([1, 2, 3]));
      const rejected = expect(task.promise).rejects.toMatchObject({ code: 'PDF_ACCEPTANCE_BROWSER_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(120_000); await rejected;
    } finally { vi.useRealTimers(); }
    const result = await session.dispose();
    expect(result).toMatchObject({ pass: false, browserClosed: true, serverClosed: true, allDocumentsClosed: false });
    expect(result.browserErrors[0].code).toBe('PDF_ACCEPTANCE_BROWSER_TIMEOUT');
  });
});
