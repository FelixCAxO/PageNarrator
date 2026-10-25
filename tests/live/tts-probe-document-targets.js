import { createServer } from 'node:http';
import { cp, readFile, writeFile } from 'node:fs/promises';

import path from 'node:path';

import { PROBE_WORKLOADS, loadPdfWorkloadBytes } from './tts-probe-workloads.js';

import { sha256 } from '../../scripts/weak-hardware/run-provenance.mjs';
import { attachToTarget, evaluateExpression, getTabIdByUrl, closeTargetBestEffort } from './tts-probe-cdp.js';
import { waitFor, PROBE_DOCUMENT_TYPES, DIST_DIR } from './tts-probe-settings.js';
import { hashProbeDocument } from './tts-probe-results.js';
import { createProbePdfOcrHooksSource, PDF_OCR_SNAPSHOT_EXPRESSION } from './tts-probe-ocr.js';

export async function startProbeArticleServer() {
  const articleHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>PageNarrator TTS Probe Article</title>
  </head>
  <body>
    <main>
      <article>
        <h1>PageNarrator TTS Probe Article</h1>
        <p>This local article is deterministic and used to measure PageNarrator Kokoro synthesis on the current browser hardware.</p>
        <h2>First measured section</h2>
        <p>The first section has enough spoken text to produce a normal audio chunk while staying short enough for repeated probe runs.</p>
        <h2>Second measured section</h2>
        <p>The second section lets the probe measure how long the reader takes to move from one completed section into the next one.</p>
        <h2>Third measured section</h2>
        <p>The third section exposes pauses between read sections and records whether the next section was already prepared before playback needed it.</p>
        <h2>Fourth measured section</h2>
        <p>The fourth section gives the flow probe another transition without turning the live hardware run into a long benchmark.</p>
      </article>
    </main>
  </body>
</html>`;
  const pages = new Map([['/probe.html', articleHtml]]);
  for (const workload of Object.values(PROBE_WORKLOADS)) {
    if (workload.kind === 'html' && workload.render) pages.set(workload.path, workload.render());
  }
  const server = createServer((request, response) => {
    const html = pages.get(new URL(request.url || '/', 'http://127.0.0.1').pathname);
    if (request.method !== 'GET' || !html) {
      response.writeHead(request.method !== 'GET' ? 405 : 404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
    });
    response.end(html);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local probe article server did not start.');
  return {
    url: `http://127.0.0.1:${address.port}/probe.html`,
    urlFor: (pathname) => `http://127.0.0.1:${address.port}${pathname}`,
    contentSha256: sha256(articleHtml),
    contentSha256For: (pathname) => sha256(pages.get(pathname) || ''),
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

export async function openProbeArticleDocument(cdp, serviceWorkerSessionId, documentType = 'article') {
  const workload = PROBE_WORKLOADS[documentType];
  const localArticle = await startProbeArticleServer();
  const url = localArticle.urlFor(workload.path);
  let targetId;
  try {
    const createdArticle = await cdp.send('Target.createTarget', { url });
    targetId = createdArticle.targetId;
    const articleSessionId = await attachToTarget(cdp, targetId);
    await cdp.send('Target.activateTarget', { targetId });
    await waitFor(async () => {
      const result = await evaluateExpression(cdp, articleSessionId, 'document.readyState');
      return ['interactive', 'complete'].includes(result.result.value);
    }, 'Probe article did not finish loading', 10_000);

    const tabId = await waitFor(
      () => getTabIdByUrl(cdp, serviceWorkerSessionId, url),
      'Probe article tab was not visible to the extension',
      10_000,
    );

    return {
      documentType,
      title: workload.title || 'PageNarrator TTS Probe Article',
      url,
      contentSha256: localArticle.contentSha256For(workload.path),
      tabId,
      targetId,
      sessionId: articleSessionId,
      close: async () => {
        if (targetId) await closeTargetBestEffort(cdp, targetId);
        await localArticle.close();
      },
    };
  } catch (error) {
    if (targetId) await closeTargetBestEffort(cdp, targetId);
    await localArticle.close();
    throw error;
  }
}

export async function openProbePdfDocument(cdp, extensionId, serviceWorkerSessionId, documentType = 'pdf', profile = {}) {
  const workload = PROBE_WORKLOADS[documentType];
  const bytes = await loadPdfWorkloadBytes(workload);
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error(`Probe PDF workload is not a PDF: ${documentType}`);
  const pdfUrl = `data:application/pdf;base64,${bytes.toString('base64')}`;
  const viewerUrl = `chrome-extension://${extensionId}/src/pdf-viewer.html?src=${encodeURIComponent(pdfUrl)}`;
  let targetId;
  try {
    const observedOcr = documentType === 'scanned-pdf';
    const createdPdf = await cdp.send('Target.createTarget', { url: observedOcr ? 'about:blank' : viewerUrl });
    targetId = createdPdf.targetId;
    const pdfSessionId = await attachToTarget(cdp, targetId);
    if (observedOcr) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: createProbePdfOcrHooksSource(profile) }, pdfSessionId);
      await cdp.send('Page.navigate', { url: viewerUrl }, pdfSessionId);
    }
    await cdp.send('Target.activateTarget', { targetId });
    await waitFor(async () => {
      const result = await evaluateExpression(cdp, pdfSessionId, `(() => ({
        readyState: document.readyState,
        status: document.getElementById('pdf-status')?.textContent || '',
        text: document.querySelector('[data-pagenarrator-id="pdf-page-1"] .textLayer')?.textContent || '',
        title: document.title || '',
      }))()`);
      const value = result.result.value;
      return ['interactive', 'complete'].includes(value.readyState)
        && /page(s)? loaded/.test(value.status)
        && (!workload.readyText || value.text.includes(workload.readyText))
        ? value
        : null;
    }, `Probe PDF viewer did not finish loading the ${documentType} workload`, 30_000);

    const tabId = await waitFor(
      () => getTabIdByUrl(cdp, serviceWorkerSessionId, viewerUrl),
      'Probe PDF viewer tab was not visible to the extension',
      10_000,
    );

    return {
      documentType,
      title: 'PageNarrator TTS Probe PDF',
      url: viewerUrl,
      contentSha256: sha256(bytes),
      tabId,
      targetId,
      sessionId: pdfSessionId,
      close: async () => {
        if (targetId) await closeTargetBestEffort(cdp, targetId);
      },
    };
  } catch (error) {
    if (targetId) await closeTargetBestEffort(cdp, targetId);
    throw error;
  }
}

export async function openProbeDocuments(cdp, extensionId, serviceWorkerSessionId, documentTypes = PROBE_DOCUMENT_TYPES, profile = {}) {
  const documents = [];
  try {
    for (const documentType of documentTypes) {
      documents.push(PROBE_WORKLOADS[documentType].kind === 'pdf'
        ? await openProbePdfDocument(cdp, extensionId, serviceWorkerSessionId, documentType, profile)
        : await openProbeArticleDocument(cdp, serviceWorkerSessionId, documentType));
    }
    return documents;
  } catch (error) {
    await closeProbeDocuments(documents);
    throw error;
  }
}

export async function closeProbeDocuments(documents = []) {
  await Promise.allSettled(documents.map((documentTarget) => documentTarget.close?.()));
}

export async function prepareProbeExtension(extensionDir) {
  await cp(DIST_DIR, extensionDir, { recursive: true });
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = Array.from(new Set([
    ...(manifest.host_permissions || []),
    'http://127.0.0.1/*',
  ]));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// A run that closed its toolbar player has disposed this PDF's viewer (see
// needsFreshDocumentTarget), so the next run reads the same PDF in a new viewer.
export async function reopenProbePdfDocument(session, documentType) {
  const index = session.probeDocuments.findIndex((entry) => entry.documentType === documentType);
  const previous = session.probeDocuments[index];
  await previous?.close?.();
  // The new viewer has the same URL, so the old tab must be gone before the new one is looked up.
  if (previous?.tabId) {
    await waitFor(async () => {
      const result = await evaluateExpression(session.cdp, session.serviceWorkerSessionId,
        `chrome.tabs.get(${JSON.stringify(previous.tabId)}).then(() => false, () => true)`);
      return result.result.value === true;
    }, 'Probe PDF viewer tab did not close before it was reopened', 10_000);
  }
  const reopened = await openProbePdfDocument(session.cdp, session.extensionId, session.serviceWorkerSessionId, documentType, session.profile);
  reopened.sha256 = await hashProbeDocument(reopened);
  session.probeDocuments[index] = reopened;
  return reopened;
}

// Read failure remains explicit evidence; it cannot qualify CPU-only measurement.
export async function captureProbePdfOcr(cdp, documentTarget) {
  if (documentTarget.documentType !== 'scanned-pdf') return null;
  try {
    const result = await evaluateExpression(cdp, documentTarget.sessionId, PDF_OCR_SNAPSHOT_EXPRESSION);
    return result.exceptionDetails ? { error: result.exceptionDetails.text || 'PDF OCR snapshot evaluation failed' } : (result.result?.value ?? null);
  } catch (error) { return { error: String(error?.message || error) }; }
}
