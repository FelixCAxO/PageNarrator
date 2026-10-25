import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getExtensionId, launchExtensionContext } from './extension-fixture.js';

const FIXTURE_DIR = path.resolve('tests/fixtures/pdfs');

async function createPdfDataUrl(fileName) {
  const bytes = await readFile(path.join(FIXTURE_DIR, fileName));
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  return `data:application/pdf;base64,${bytes.toString('base64')}`;
}

async function getServiceWorker(context) {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  return serviceWorker;
}

async function getActiveTabId(context) {
  const serviceWorker = await getServiceWorker(context);
  return serviceWorker.evaluate(() => new Promise((resolve, reject) => {
    void chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const [tab] = tabs;
      if (!tab?.id) {
        reject(new Error('Could not find the active tab'));
        return;
      }
      resolve(tab.id);
    });
  }));
}

async function sendTabMessage(context, tabId, message) {
  const serviceWorker = await getServiceWorker(context);
  return serviceWorker.evaluate(({ id, payload }) => chrome.tabs.sendMessage(id, payload), {
    id: tabId,
    payload: message,
  });
}

test('round-trips PDF viewer streaming messages through chrome.runtime', async () => {
  const { context, cleanup } = await launchExtensionContext();
  try {
    const extensionId = await getExtensionId(context);
    const page = await context.newPage();
    const pdfUrl = await createPdfDataUrl('single-column.pdf');

    await page.goto(`chrome-extension://${extensionId}/src/pdf-viewer.html?src=${encodeURIComponent(pdfUrl)}`);
    await expect(page.locator('#pdf-status')).toContainText('1 page loaded', { timeout: 15_000 });

    await page.bringToFront();
    const tabId = await getActiveTabId(context);
    await expect(sendTabMessage(context, tabId, { type: 'pagenarratorPing' }))
      .resolves.toEqual({ ok: true });

    const metadata = await sendTabMessage(context, tabId, { type: 'getPdfStreamMetadata' });
    expect(metadata).toMatchObject({
      ok: true,
      pageCount: 1,
      url: pdfUrl,
    });
    expect(metadata.instanceToken).toEqual(expect.any(String));

    const chunk = await sendTabMessage(context, tabId, {
      type: 'getPdfChunk',
      streamId: 'e2e-stream',
      instanceToken: metadata.instanceToken,
      startPage: 1,
      speechChunkOptions: { maxLen: 320, targetMinLen: 180 },
    });
    expect(chunk).toMatchObject({
      ok: true,
      done: false,
      value: {
        type: 'pdf-page',
        pageNumber: 1,
        anchorId: 'pdf-page-1',
      },
    });
    expect(chunk.value.speech).toContain('PageNarrator single column fixture');

    await expect(sendTabMessage(context, tabId, {
      type: 'getPdfChunk',
      streamId: 'stale-stream',
      instanceToken: 'old-viewer-load',
      startPage: 1,
    })).resolves.toMatchObject({
      ok: false,
      code: 'stale_pdf_stream',
    });

    await expect(sendTabMessage(context, tabId, {
      type: 'closePdfChunkStream',
      streamId: 'e2e-stream',
      instanceToken: metadata.instanceToken,
    })).resolves.toEqual({ ok: true });
  } finally {
    await cleanup();
  }
});
