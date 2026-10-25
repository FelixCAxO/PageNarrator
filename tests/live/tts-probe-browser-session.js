import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { launchProbeBrowser } from './tts-probe-browser.js';
import { runCpuCalibration } from './tts-probe-calibration.js';

import { evaluateExpression, getExtensionId } from './tts-probe-cdp.js';
import { CHROME_EXE, SUPERVISOR_REQUEST, HEADLESS, NATIVE_BACKGROUNDING, waitFor, getProfileDocumentTypes } from './tts-probe-settings.js';
import { recordConsole } from './tts-probe-lifecycle.js';
import { openProbeDocuments, closeProbeDocuments } from './tts-probe-document-targets.js';
import { hashProbeDocument } from './tts-probe-results.js';

/** Resolve roles from the exact built module, never a generic worker filename. */
export async function readKokoroWorkerAssets(extensionDir) {
  const asset = 'assets/worker-client.js';
  const bytes = await readFile(path.join(extensionDir, asset));
  const source = bytes.toString('utf8');
  const paths = [...source.matchAll(/new URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g)]
    .map(match => match[2]);
  const find = prefix => {
    const matches = paths.filter(file => new RegExp(`^(?:\\./)?${prefix}-[A-Za-z0-9_-]+\\.js$`).test(file));
    if (matches.length !== 1) throw new Error(`Cannot identify the packaged Kokoro ${prefix} worker.`);
    return `assets/${matches[0].replace(/^\.\//, '')}`;
  };
  const coordinatorPath = find('worker'), helperPath = find('cpu-pool-worker');
  const [coordinator, helper] = await Promise.all([coordinatorPath, helperPath].map(file => readFile(path.join(extensionDir, file))));
  const hash = value => createHash('sha256').update(value).digest('hex');
  return { asset, sha256: hash(bytes), coordinatorPath, helperPath, coordinatorSha256: hash(coordinator), helperSha256: hash(helper) };
}

export function annotateProbeWorker(target, binding) {
  let pagenarratorRole = null;
  if (target?.type === 'worker' && binding) {
    if (target.url === binding.coordinatorUrl) pagenarratorRole = 'kokoro-coordinator';
    else if (target.url === binding.helperUrl) pagenarratorRole = 'kokoro-cpu-helper';
  }
  return { ...target, pagenarratorRole, workerBindingSha256: binding?.sha256 ?? null };
}

/** Keep active targets, so a retired pool cannot satisfy a later serial run. */
export function trackProbeWorkerTargets(cdp, workersBySession, getBinding) {
  cdp.on('Target.attachedToTarget', (params, parentSessionId) => {
    if (!parentSessionId || !workersBySession.has(parentSessionId)) return;
    workersBySession.get(parentSessionId).push({ ...annotateProbeWorker(params.targetInfo, getBinding()), sessionId: params.sessionId });
  });
  cdp.on('Target.detachedFromTarget', params => {
    if (typeof params.sessionId !== 'string') return;
    for (const workers of workersBySession.values()) {
      const index = workers.findIndex(worker => worker.sessionId === params.sessionId);
      if (index !== -1) workers.splice(index, 1);
    }
  });
}

export async function resetColdStartCaches(cdp, extensionPageSessionId, profile) {
  if (!profile?.coldStart) return;
  await evaluateExpression(cdp, extensionPageSessionId, `
    (async () => {
      const databases = typeof indexedDB.databases === 'function'
        ? await indexedDB.databases()
        : [];
      await Promise.all((databases || [])
        .map((database) => database?.name)
        .filter(Boolean)
        .map((name) => new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        })));
      return true;
    })()
  `);
}

export async function startProbeBrowserSession({ profile, userDataDir, liveExtensionDir }) {
  const workerAssets = await readKokoroWorkerAssets(liveExtensionDir);
  const nativeBackgrounding = NATIVE_BACKGROUNDING || Boolean(profile.nativeBackgrounding);
  const browser = await launchProbeBrowser({
    chromeExe: CHROME_EXE,
    userDataDir,
    extensionDir: liveExtensionDir,
    profile,
    supervisor: SUPERVISOR_REQUEST,
    headless: HEADLESS && !nativeBackgrounding,
    nativeBackgrounding,
  });
  const session = {
    browser,
    profile,
    cdp: browser.cdp,
    workersBySession: new Map(),
    crashedSessions: new Set(),
    consoleBySession: new Map(),
    probeDocuments: [],
    usedDocumentTypes: new Set(),
  };
  try {
    const { cdp } = browser;
    const browserVersion = await cdp.send('Browser.getVersion').catch(() => null);
    trackProbeWorkerTargets(cdp, session.workersBySession, () => session.kokoroWorkerBinding);
    cdp.on('Inspector.targetCrashed', (_params, sessionId) => {
      if (sessionId) session.crashedSessions.add(sessionId);
    });
    cdp.on('Runtime.consoleAPICalled', (params, sessionId) => {
      if (!['error', 'warning', 'assert'].includes(params.type)) return;
      recordConsole(session.consoleBySession, sessionId, params.type, (params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' '));
    });
    cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
      const details = params.exceptionDetails || {};
      recordConsole(session.consoleBySession, sessionId, 'exception', details.exception?.description || details.text || 'exception');
    });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const serviceWorkerTarget = await waitFor(async () => {
      const targets = await cdp.send('Target.getTargets');
      return targets.targetInfos.find((target) => (
        target.type === 'service_worker'
        && target.url.startsWith('chrome-extension://')
        && target.url.endsWith('/service-worker-loader.js')
      ));
    }, 'PageNarrator service worker was not started');
    const attached = await cdp.send('Target.attachToTarget', { targetId: serviceWorkerTarget.targetId, flatten: true });
    session.serviceWorkerSessionId = attached.sessionId;
    await cdp.send('Runtime.enable', {}, session.serviceWorkerSessionId);
    session.extensionId = await getExtensionId(cdp, session.serviceWorkerSessionId);
    session.kokoroWorkerBinding = {
      ...workerAssets,
      coordinatorUrl: `chrome-extension://${session.extensionId}/${workerAssets.coordinatorPath}`,
      helperUrl: `chrome-extension://${session.extensionId}/${workerAssets.helperPath}`,
    };
    session.probeDocuments = await openProbeDocuments(cdp, session.extensionId, session.serviceWorkerSessionId, getProfileDocumentTypes(profile), profile);
    for (const documentTarget of session.probeDocuments) documentTarget.sha256 = await hashProbeDocument(documentTarget);
    // Achieved CPU availability, measured once per supervised browser.
    const calibration = browser.supervisorMode === 'job'
      ? { ...(await runCpuCalibration({ cdp, browser, workers: os.cpus().length })), hostLogicalProcessors: os.cpus().length }
      : null;
    session.browserInfo = {
      workerAssets: session.kokoroWorkerBinding,
      calibration,
      version: browserVersion ? { product: browserVersion.product, revision: browserVersion.revision, userAgent: browserVersion.userAgent } : null,
      supervisor: browser.supervisorMode,
      supervisorReason: browser.supervisorReason,
      launch: browser.launch,
      resolvedAffinity: browser.resolvedAffinity,
      gpuAdapterSelection: browser.gpuAdapterSelection,
      requestedLimits: browser.requestedLimits || null,
    };
    return session;
  } catch (error) {
    await stopProbeBrowserSession(session);
    throw error;
  }
}

export async function stopProbeBrowserSession(session) {
  await closeProbeDocuments(session.probeDocuments);
  return session.browser.close().catch((error) => ({ verified: false, error: error.message }));
}
