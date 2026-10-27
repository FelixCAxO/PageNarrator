import { chromium, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browserAdapterConfiguration } from '../../scripts/lib/browser-adapter.mjs';
import { STORAGE_KEYS } from '../../src/lib/storage-keys.js';
import {
  TEST_FLAG_STORAGE_KEYS,
  TEST_FORCE_KOKORO_FAILURE_STORAGE_KEY,
  TEST_HOOKS_STORAGE_KEY,
  TEST_RECORD_FLOW_STORAGE_KEY,
  TEST_SILENT_TTS_STORAGE_KEY,
} from '../../src/lib/extension-test-flags.js';

export const EXTENSION_DIR = process.env.PN_E2E_EXTENSION_DIR || path.resolve('dist');
export const HARDWARE_PROFILE_STORAGE_KEY = 'pnTestHardwareProfile';
const HARDWARE_PROFILE_RESET_KEYS = [
  HARDWARE_PROFILE_STORAGE_KEY,
  STORAGE_KEYS.TTS_HARDWARE_PROBE_SUMMARY,
  STORAGE_KEYS.GPU_CALIBRATION_CACHE,
  ...TEST_FLAG_STORAGE_KEYS,
];

export function resolveExtensionDir({ extensionDir = null, testInfo = null, env = process.env } = {}) {
  const selected = extensionDir
    || testInfo?.project?.use?.extensionDir
    || env.PN_E2E_EXTENSION_DIR
    || EXTENSION_DIR;
  return path.resolve(selected);
}

export async function launchExtensionContext({ extensionDir = null, hostPermissions = [], testInfo = null, locale = null } = {}) {
  if (locale && !/^[a-z]{2}(?:_[A-Z]{2})?$/u.test(locale)) throw new Error('Expected a Chrome locale code.');
  const selectedExtensionDir = resolveExtensionDir({ extensionDir, testInfo });
  const preparedExtension = hostPermissions.length
    ? await createExtensionCopyWithHostPermissions(selectedExtensionDir, hostPermissions)
    : { extensionDir: selectedExtensionDir, cleanup: async () => {} };
  expect(existsSync(path.join(preparedExtension.extensionDir, 'manifest.json'))).toBe(true);
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'pagenarrator-e2e-'));
  const e2eHeaded = /^(1|true|yes)$/i.test(process.env.PN_E2E_HEADED || '');
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !e2eHeaded,
    ...(locale ? { locale: locale.replace('_', '-') } : {}),
    args: [
      // Test narration must never reach the user's speakers, including headed runs.
      '--mute-audio',
      ...(locale ? [`--lang=${locale.replace('_', '-')}`, `--accept-lang=${locale.replace('_', '-')}`] : []),
      `--disable-extensions-except=${preparedExtension.extensionDir}`,
      `--load-extension=${preparedExtension.extensionDir}`,
      '--autoplay-policy=no-user-gesture-required',
      ...browserAdapterConfiguration().args,
    ],
  });

  const cleanup = async () => {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
    await preparedExtension.cleanup();
  };

  return { context, cleanup, userDataDir, extensionDir: preparedExtension.extensionDir };
}

async function createExtensionCopyWithHostPermissions(extensionDir, hostPermissions) {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'pagenarrator-extension-'));
  const copyDir = path.join(tmpRoot, 'extension');
  await cp(extensionDir, copyDir, { recursive: true });
  if (hostPermissions.length) {
    const manifestPath = path.join(copyDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const permissions = new Set([
      ...(manifest.host_permissions || []),
      ...hostPermissions,
    ]);
    manifest.host_permissions = [...permissions];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return {
    extensionDir: copyDir,
    cleanup: () => rm(tmpRoot, { recursive: true, force: true }),
  };
}

export async function getExtensionId(context) {
  const serviceWorker = await getServiceWorker(context);
  return new URL(serviceWorker.url()).hostname;
}

export async function seedFlowTestFlags(context) {
  const serviceWorker = await getServiceWorker(context);
  await serviceWorker.evaluate(() => chrome.storage.local.set({
    pnTestHooksEnabled: true,
    pnTestSilentTts: true,
    pnTestRecordFlow: true,
  }));
}

// Enables flow-log diagnostics without silent TTS so the read runs the real
// Kokoro model. Optionally seeds playback settings in the same write so the
// flags are never clobbered by a later storage reset.
export async function seedRealTtsFlowFlags(context, { playbackSettings = null } = {}) {
  const serviceWorker = await getServiceWorker(context);
  await serviceWorker.evaluate(({ settings, settingsKey }) => chrome.storage.local.set({
    pnTestHooksEnabled: true,
    pnTestRecordFlow: true,
    ...(settings ? { [settingsKey]: settings } : {}),
  }), { settings: playbackSettings, settingsKey: STORAGE_KEYS.PLAYBACK_SETTINGS });
}

export function buildHardwareProfileStorage(profile, {
  enableProbe = false,
  silentTts = false,
  recordFlow = silentTts,
} = {}) {
  const state = {};
  if (profile?.playbackSettings) {
    state[STORAGE_KEYS.PLAYBACK_SETTINGS] = { ...profile.playbackSettings };
  }
  if (enableProbe) {
    state[STORAGE_KEYS.TTS_HARDWARE_PROBE] = {
      enabled: true,
      profileName: profile?.name || 'test-hardware-profile',
      profileLabel: profile?.label || 'Test hardware profile',
    };
  }
  if (silentTts || recordFlow || profile?.forceKokoroFailure) state[TEST_HOOKS_STORAGE_KEY] = true;
  if (silentTts) state[TEST_SILENT_TTS_STORAGE_KEY] = true;
  if (recordFlow) state[TEST_RECORD_FLOW_STORAGE_KEY] = true;
  if (profile?.forceKokoroFailure) state[TEST_FORCE_KOKORO_FAILURE_STORAGE_KEY] = true;
  return state;
}

export function getHardwareProfileStorageResetKeys() {
  return [...HARDWARE_PROFILE_RESET_KEYS];
}

export async function seedHardwareProfile(context, profile, options = {}) {
  await seedTtsHardwareProfile(context, profile, options);
}

export async function seedTtsHardwareProfile(context, profile, options = {}) {
  await installHardwareProfileNavigatorOverride(context, profile);
  await replaceStorageState(context, buildHardwareProfileStorage(profile, options), {
    removeKeys: getHardwareProfileStorageResetKeys(),
  });
}

async function installHardwareProfileNavigatorOverride(context, profile = {}) {
  const navigatorProfile = profile?.navigator || {};
  await context.addInitScript(({ deviceMemory, hardwareConcurrency, disableWebGpu, gpuProfile }) => {
    const defineNavigatorGetter = (property, value, { allowUndefined = false } = {}) => {
      if (value === undefined && !allowUndefined) return;
      Object.defineProperty(Navigator.prototype, property, {
        configurable: true,
        get: () => value,
      });
    };

    defineNavigatorGetter('deviceMemory', deviceMemory);
    defineNavigatorGetter('hardwareConcurrency', hardwareConcurrency);
    if (disableWebGpu) defineNavigatorGetter('gpu', undefined, { allowUndefined: true });
    if (gpuProfile?.mode === 'no-adapter') {
      defineNavigatorGetter('gpu', { requestAdapter: async () => null });
    }
    if (gpuProfile.mode === 'simulated-adapter') {
      defineNavigatorGetter('gpu', createFakeGpuAdapter(gpuProfile));
    }

    function createFakeGpuAdapter(profileGpu) {
      const limits = profileGpu?.limits || {};
      const adapterInfo = {
        vendor: profileGpu?.vendor || '',
        architecture: profileGpu?.architecture || '',
        device: profileGpu?.device || '',
        description: profileGpu?.description || '',
      };
      globalThis.GPUBufferUsage ||= { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, MAP_READ: 1 };
      globalThis.GPUMapMode ||= { READ: 1 };
      const buffer = {
        destroy() { return undefined; },
        mapAsync: async () => undefined,
        unmap() { return undefined; },
      };
      const device = {
        createBuffer: () => buffer,
        createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
        createBindGroup: () => ({}),
        createShaderModule: () => ({}),
        createCommandEncoder: () => ({
          beginComputePass: () => ({
            setPipeline() { return undefined; },
            setBindGroup() { return undefined; },
            dispatchWorkgroups() { return undefined; },
            end() { return undefined; },
          }),
          copyBufferToBuffer() { return undefined; },
          finish: () => ({}),
        }),
        queue: {
          writeBuffer() { return undefined; },
          submit() { return undefined; },
          onSubmittedWorkDone: async () => undefined,
        },
        destroy() { return undefined; },
      };
      return {
        requestAdapter: async () => ({
          info: adapterInfo,
          limits: {
            maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize ?? null,
            maxBufferSize: limits.maxBufferSize ?? null,
          },
          features: { has: () => false },
          requestAdapterInfo: async () => adapterInfo,
          requestDevice: async () => device,
        }),
      };
    }
  }, {
    deviceMemory: navigatorProfile.deviceMemory,
    hardwareConcurrency: navigatorProfile.hardwareConcurrency,
    disableWebGpu: Boolean(profile?.disableWebGpu),
    gpuProfile: profile?.gpu || {},
  });
}

export async function openCorpusArticle(context, server, slug, { seedReadableTarget = true } = {}) {
  const page = await context.newPage();
  await page.goto(server.urlFor(slug), { waitUntil: 'domcontentloaded' });
  if (seedReadableTarget) await seedReadableTabTarget(context, page);
  return page;
}

export async function seedReadableTabTarget(context, page, {
  allowActiveExtensionTab = false,
  allowActiveTabFallback = false,
} = {}) {
  const tabId = await getChromeTabId(context, page.url(), {
    allowActiveExtensionTab,
    allowActiveTabFallback,
    page,
  });
  const serviceWorker = await getServiceWorker(context);
  await serviceWorker.evaluate((tab) => chrome.storage.local.set({
    readableTabTarget: {
      tabId: tab.id,
      tabSnapshot: tab,
      createdAt: Date.now(),
    },
  }), {
    id: tabId,
    title: await page.title(),
    url: page.url(),
  });
  return tabId;
}

export async function startReadFromToolbarPopup(context, page, { closePopup = true, selected = false, fromStart = false } = {}) {
  await page.bringToFront().catch((error) => {
    console.warn('Could not bring PageNarrator target page to front before opening the popup.', error);
  });
  const tabId = await getChromeTabId(context, page.url(), { allowActiveExtensionTab: true });
  await seedReadableTabTarget(context, page, { allowActiveExtensionTab: true });
  const serviceWorker = await getServiceWorker(context);
  const popupPromise = context.waitForEvent('page', {
    predicate: (candidate) => candidate.url().includes('/src/popup.html'),
    timeout: 5_000,
  });
  let popup;
  try {
    await serviceWorker.evaluate((id) => chrome.tabs.update(id, { active: true }).then(() => chrome.action.openPopup()), tabId);
    popup = await popupPromise;
  } catch {
    const extensionId = await getExtensionId(context);
    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/popup.html`);
    await popup.locator('#start-reading').waitFor({ timeout: 15_000 });
    await popup.waitForFunction(() => (
      document.getElementById('popup-voice')?.options?.length > 0
      && document.getElementById('popup-speed-out')?.textContent?.includes('x')
      && !document.getElementById('start-reading')?.disabled
    ), null, { timeout: 15_000 });
  }
  // A fallback popup is a normal tab in headless Chromium, so activate the
  // reading target only after that tab has finished opening and reseed the
  // target that its activation event temporarily replaced.
  await serviceWorker.evaluate((tab) => chrome.storage.local.set({
    readableTabTarget: { tabId: tab.id, tabSnapshot: tab, createdAt: Date.now() },
  }), { id: tabId, title: await page.title(), url: page.url() });
  await serviceWorker.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);
  const startButton = popup.locator(fromStart ? '#read-from-start' : selected ? '#read-selected' : '#start-reading');
  await startButton.click();
  // A previous read can still report finished while this click awaits settings
  // and dispatch. Keep the popup alive until its action has actually completed.
  await expect(startButton).not.toHaveAttribute('data-pending', 'true', { timeout: 15_000 });
  try {
    await serviceWorker.evaluate(() => new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const poll = () => {
        chrome.storage.session.get('readerEngineState').then((state) => {
          if (['preparing', 'reading', 'paused', 'finished', 'error'].includes(state.readerEngineState?.state)) {
            resolve(true);
            return;
          }
          if (Date.now() - startedAt > 10_000) {
            reject(new Error('Toolbar player did not start reading.'));
            return;
          }
          setTimeout(poll, 100);
        }, reject);
      };
      poll();
    }));
  } catch {
    const popupError = await popup.locator('#popup-error').textContent().catch(() => '');
    const activeTabs = await serviceWorker.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true })).catch(() => []);
    const engine = await serviceWorker.evaluate(async () => ({
      contexts: await chrome.runtime.getContexts({}),
      ping: await chrome.runtime.sendMessage({ type: 'readerEnginePing' }).catch((error) => ({ error: error?.message })),
      state: await chrome.storage.session.get('readerEngineState'),
    })).catch((error) => ({ error: error?.message }));
    throw new Error(`Toolbar player did not start. Popup error: ${popupError || 'none'} Active tabs: ${JSON.stringify(activeTabs)} Engine: ${JSON.stringify(engine)}`);
  }
  if (closePopup) {
    await popup.close().catch((error) => {
      console.warn('Could not close PageNarrator popup after starting read.', error);
    });
  }
  return popup;
}

export async function recordPlaybackEvents(page, context = null) {
  if (!context || page.url().startsWith('chrome-extension://')) {
    return page.evaluate(() => window.__pnFlowLog || []);
  }
  const tabId = await getChromeTabId(context, page.url());
  const serviceWorker = await getServiceWorker(context);
  return serviceWorker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'getFlowLog' })
    .then((response) => response?.log || [])
    .catch(() => chrome.scripting.executeScript({
      target: { tabId: id },
      func: () => window.__pnFlowLog || [],
    }).then((results) => results?.[0]?.result || [])), tabId);
}

async function getChromeTabId(context, url, {
  allowActiveExtensionTab = false,
  allowActiveTabFallback = false,
  page = null,
} = {}) {
  const serviceWorker = await getServiceWorker(context);
  let tabId = null;
  try {
    tabId = await serviceWorker.evaluate(({ targetUrl, allowActiveExtensionFallback }) => new Promise((resolve, reject) => {
      void chrome.tabs.query({}, (tabs) => {
        const tab = tabs.find((candidate) => tabUrlsMatch(candidate.url, targetUrl))
          || (allowActiveExtensionFallback && targetUrl.startsWith('chrome-extension://')
            ? tabs.find((candidate) => candidate.active)
            : null);
        if (!tab?.id) {
          reject(new Error(`Could not find tab for ${targetUrl}`));
          return;
        }
        resolve(tab.id);
      });

      function tabUrlsMatch(candidateUrl, expectedUrl) {
        if (candidateUrl === expectedUrl) return true;
        try {
          const candidate = new URL(candidateUrl);
          const expected = new URL(expectedUrl);
          if (candidate.origin !== expected.origin || candidate.pathname !== expected.pathname) {
            return false;
          }
          const candidateSrc = candidate.searchParams.get('src');
          const expectedSrc = expected.searchParams.get('src');
          if (candidateSrc || expectedSrc) return candidateSrc === expectedSrc;
          return candidate.search === expected.search && candidate.hash === expected.hash;
        } catch {
          return false;
        }
      }
    }), { targetUrl: url, allowActiveExtensionFallback: allowActiveExtensionTab });
  } catch (error) {
    if (!allowActiveTabFallback) throw error;
  }
  if (tabId || !allowActiveTabFallback) return tabId;
  await page?.bringToFront?.().catch((error) => {
    console.warn('Could not bring PageNarrator target page to front before active-tab fallback.', error);
  });
  return getActiveChromeTabId(context);
}

async function getActiveChromeTabId(context) {
  const serviceWorker = await getServiceWorker(context);
  return serviceWorker.evaluate(() => new Promise((resolve, reject) => {
    void chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        reject(new Error('Could not find active tab'));
        return;
      }
      resolve(tab.id);
    });
  }));
}

async function getServiceWorker(context) {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 60_000 });
  return serviceWorker;
}

async function replaceStorageState(context, state, { removeKeys = [] } = {}) {
  const serviceWorker = await getServiceWorker(context);
  await serviceWorker.evaluate(async ({ nextState, keysToRemove }) => {
    if (keysToRemove.length) await chrome.storage.local.remove(keysToRemove);
    if (Object.keys(nextState).length) await chrome.storage.local.set(nextState);
  }, { nextState: state, keysToRemove: removeKeys });
}

export async function openExtensionPage(context, pageName, suffix = '') {
  const serviceWorker = pageName === 'readerEngine' ? await getServiceWorker(context) : null;
  const panelTargetTabId = serviceWorker
    ? await serviceWorker.evaluate(async (storageKey) => {
      const state = await chrome.storage.local.get(storageKey);
      const storedTarget = state[storageKey];
      if (storedTarget?.tabSnapshot?.id) return storedTarget.tabSnapshot.id;
      if (storedTarget?.tabId) return storedTarget.tabId;
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return activeTab?.id || null;
    }, STORAGE_KEYS.READABLE_TAB_TARGET)
    : null;
  const extensionId = await getExtensionId(context);
  const page = await context.newPage();
  const fileName = pageName === 'readerEngine' ? 'reader-engine' : pageName;
  await page.goto(`chrome-extension://${extensionId}/src/${fileName}.html${suffix}`);
  if (serviceWorker && panelTargetTabId) {
    await serviceWorker.evaluate(async (tabId) => {
      // A saved tab ID can expire when the browser restarts or its source tab closes.
      if (await chrome.tabs.get(tabId).catch(() => null)) await chrome.tabs.update(tabId, { active: true });
    }, panelTargetTabId);
  }
  return page;
}

export async function createPdfDataUrl(fileName) {
  const fixturePath = path.resolve('tests/fixtures/pdfs', fileName);
  const bytes = await readFile(fixturePath);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  return `data:application/pdf;base64,${bytes.toString('base64')}`;
}

export async function openPdfViewer(context, fileNameOrUrl) {
  const extensionId = await getExtensionId(context);
  const page = await context.newPage();
  const pdfUrl = String(fileNameOrUrl || '').startsWith('data:')
    ? fileNameOrUrl
    : await createPdfDataUrl(fileNameOrUrl);
  await page.goto(`chrome-extension://${extensionId}/src/pdf-viewer.html?src=${encodeURIComponent(pdfUrl)}`);
  return page;
}
