import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import {
  getExtensionId,
  launchExtensionContext,
  seedFlowTestFlags,
  startReadFromToolbarPopup,
} from './extension-fixture.js';

const FIXTURE_DIR = path.resolve('tests/fixtures/pdfs');

async function createPdfDataUrl(fileName) {
  const bytes = await readFile(path.join(FIXTURE_DIR, fileName));
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  return `data:application/pdf;base64,${bytes.toString('base64')}`;
}

test('loads the built extension PDF viewer on deterministic PDF fixtures', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    const extensionId = await getExtensionId(context);
    const page = await context.newPage();
    const pdfUrl = await createPdfDataUrl('single-column.pdf');

    await page.goto(`chrome-extension://${extensionId}/src/pdf-viewer.html?src=${encodeURIComponent(pdfUrl)}`);

    await expect(page.locator('#pdf-status')).toContainText('1 page loaded', { timeout: 15_000 });
    await expect(page.locator('[data-pagenarrator-id="pdf-page-1"] .textLayer')).toContainText(
      'PageNarrator single column fixture',
    );
  } finally {
    await cleanup();
  }
});

test('reads an HTTP PDF through the toolbar player contract', async () => {
  const fixture = await readFile(path.join(FIXTURE_DIR, 'single-column.pdf'));
  // Extension worker requests can bypass Playwright routes; serve the actual fixture bytes.
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': fixture.length });
    response.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pdfUrl = `http://127.0.0.1:${server.address().port}/single-column.pdf`;
  let cleanup;
  try {
    const launched = await launchExtensionContext({ hostPermissions: ['http://127.0.0.1/*'] });
    cleanup = launched.cleanup;
    const { context } = launched;
    await context.route(pdfUrl, async (route) => {
      // A stable source-tab shell avoids depending on Chrome's built-in PDF UI;
      // the extension's viewer fetch still receives the original PDF bytes.
      if (route.request().isNavigationRequest()) {
        await route.fulfill({ contentType: 'text/html', body: '<title>AI in Finance</title><p>PDF source</p>' });
        return;
      }
      const frameUrl = route.request().frame().url();
      if (frameUrl.includes('/src/reader-engine.html')) {
        await route.abort('failed');
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/pdf', body: fixture });
    });
    await seedFlowTestFlags(context);
    const pdfPage = await context.newPage();
    await pdfPage.goto(pdfUrl);
    const popup = await startReadFromToolbarPopup(context, pdfPage, { closePopup: false });

    const serviceWorker = context.serviceWorkers()[0];
    const getEngineState = () => serviceWorker.evaluate(
      () => chrome.storage.session.get('readerEngineState').then((value) => value.readerEngineState?.state || 'idle'),
    );
    await expect.poll(getEngineState, { timeout: 30_000 }).toMatch(/reading|finished/);
    const activeViewer = context.pages().find((page) => page.url().includes('/src/pdf-viewer.html?') && page.url().includes(encodeURIComponent(pdfUrl)));
    expect(activeViewer).toBeTruthy();
    await expect(activeViewer.locator('#pdf-status')).toContainText('1 page loaded', { timeout: 15_000 });
    await expect(activeViewer.locator('.textLayer')).toContainText('PageNarrator single column fixture');
    await expect.poll(async () => {
      return activeViewer.evaluate(() => (
        CSS.highlights?.has('pagenarrator-chunk')
        || Boolean(document.querySelector('[data-pagenarrator-region-overlay]'))
      ));
    }, { timeout: 30_000 }).toBe(true);
    // The short silent fixture can finish before the stop button is clicked.
    await popup.locator('#popup-stop').click({ timeout: 5_000 }).catch(async (error) => {
      if (await getEngineState() !== 'finished') throw error;
    });
    await expect(popup.locator('#popup-status')).toHaveText(/^(?:Ready to read|Finished)$/);
  } finally {
    try { await cleanup?.(); } finally { await new Promise((resolve) => server.close(resolve)); }
  }
});
