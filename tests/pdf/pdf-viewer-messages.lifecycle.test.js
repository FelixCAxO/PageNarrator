import { afterEach, expect, it } from 'vitest';
import { installViewerDom, installChromeRuntime, loadViewer, cleanupViewerDom } from './pdf-viewer-messages.fixtures.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
afterEach(cleanupViewerDom);

async function exerciseBoundary(blockImport) {
  const dom = await installViewerDom(), originalDocument = dom.window.document;
  installChromeRuntime();
  const importGate = deferred(), renderGate = deferred(), readyEntered = deferred(), importRegistered = deferred(), events = [];
  const realClose = dom.window.close.bind(dom.window);
  dom.window.close = () => { events.push('owned-close'); return realClose(); };
  dom.window.addEventListener('pagehide', () => events.push('owned-pagehide'));
  let continuationTouchedNext = false, loading, closing, next;
  try {
    loading = loadViewer(async () => {
      if (blockImport) await importGate.promise;
      events.push('import-settled');
      globalThis.chrome.runtime.onMessage.addListener((_message, _sender, respond) => {
        events.push('ready-entered'); readyEntered.resolve();
        void renderGate.promise.then(() => { events.push('render-settled'); respond({ ok: true }); });
        return true;
      });
      importRegistered.resolve();
    }).then(() => { continuationTouchedNext = true; }, error => { events.push(error.message); });
    if (!blockImport) {
      await importRegistered.promise;
      await Promise.resolve();
      expect(events).toContain('ready-entered');
    }
    closing = cleanupViewerDom();
    next = installViewerDom();
    expect(globalThis.document === originalDocument).toBe(true);
    expect(events).not.toContain('owned-pagehide');
    importGate.resolve();
    await readyEntered.promise;
    expect(globalThis.document === originalDocument).toBe(true);
    expect(events).not.toContain('owned-close');
    renderGate.resolve();
    await closing;
    const replacement = await next;
    await loading;
    expect(globalThis.document === replacement.window.document).toBe(true);
    expect(continuationTouchedNext).toBe(false);
    expect(events).toContain('Viewer fixture was closed while loading.');
    expect(events.indexOf('import-settled')).toBeLessThan(events.indexOf('render-settled'));
    expect(events.indexOf('render-settled')).toBeLessThan(events.indexOf('owned-pagehide'));
    expect(events.indexOf('owned-pagehide')).toBeLessThan(events.indexOf('owned-close'));
  } finally {
    importGate.resolve(); renderGate.resolve();
    await Promise.allSettled([loading, closing, next].filter(Boolean));
    try { (await next)?.window.close(); } catch { /* Preserve the original authored failure. */ }
    await cleanupViewerDom();
    dom.window.close();
  }
}

it('holds original globals through a delayed import and readiness, then rejects the stale test continuation', async () => {
  await exerciseBoundary(true);
});

it('holds original globals while the imported viewer initial render is still pending', async () => {
  await exerciseBoundary(false);
});

it('preserves initialization rejection while still dispatching pagehide and closing the original DOM', async () => {
  const dom = await installViewerDom(); installChromeRuntime();
  const events = [], realClose = dom.window.close.bind(dom.window), failure = new Error('authored initialization failure');
  dom.window.addEventListener('pagehide', () => events.push('pagehide'));
  dom.window.close = () => { events.push('close'); return realClose(); };
  await expect(loadViewer(() => Promise.reject(failure))).rejects.toBe(failure);
  await expect(Promise.resolve(cleanupViewerDom())).rejects.toBe(failure);
  expect(events).toEqual(['pagehide', 'close']);
  expect(globalThis.document).toBeUndefined();
});

it('waits for a real ready response without changing initialization count, and closes the owned DOM once', async () => {
  const dom = await installViewerDom(); installChromeRuntime();
  let imports = 0;
  const importer = async () => {
    imports++;
    globalThis.chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      expect(message.type).toBe('getPdfStreamMetadata'); respond({ ok: true }); return true;
    });
  };
  let hidden = 0, closed = 0;
  dom.window.addEventListener('pagehide', () => { hidden++; });
  const realClose = dom.window.close.bind(dom.window);
  dom.window.close = () => { closed++; return realClose(); };
  await loadViewer(importer);
  await cleanupViewerDom(); await cleanupViewerDom();
  expect(imports).toBe(1);
  expect(hidden).toBe(1);
  expect(closed).toBe(1);
});
