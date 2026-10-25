import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { launchExtensionContext, getExtensionId } from './extension-fixture.js';

const execFileAsync = promisify(execFile);
const rootDir = fileURLToPath(new URL('../..', import.meta.url));

test('current build loads the extension without startup errors or installation warnings', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const buildDir = await buildIsolatedExtension();

  const extensionErrors = [];
  const { context, cleanup } = await launchExtensionContext({
    extensionDir: buildDir.dist,
    testInfo,
  });
  watchExtensionErrors(context, extensionErrors);

  try {
    const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await expect.poll(
      () => serviceWorker.evaluate(() => chrome.runtime.getManifest().name),
      { timeout: 15_000 },
    ).toContain('PageNarrator');

    const pages = [];
    const extensionId = await getExtensionId(context);
    const installationIssues = await inspectExtensionInstallation(context, extensionId);
    for (const pageName of ['popup', 'reader-engine']) {
      const page = await openWatchedExtensionPage(context, extensionId, pageName, extensionErrors);
      pages.push(page);
      if (pageName === 'popup') await expect(page.locator('body')).toBeVisible();
      else await expect(page.locator('body')).toBeHidden();
    }

    await Promise.all(pages.map((page) => page.waitForLoadState('networkidle', { timeout: 15_000 })));

    expect(extensionErrors).toEqual([]);
    expect(installationIssues).toEqual({ installWarnings: [], manifestErrors: [], runtimeWarnings: [] });
  } finally {
    await cleanup();
    await buildDir.cleanup();
  }
});

async function inspectExtensionInstallation(context, extensionId) {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions');
    return await page.evaluate(async (id) => {
      const api = chrome.developerPrivate;
      // Command-line loading hides manifest warnings until developer error collection is enabled.
      await api.updateProfileConfiguration({ inDeveloperMode: true });
      await api.updateExtensionConfiguration({ extensionId: id, errorCollection: true });
      await api.reload(id, { failQuietly: true, populateErrorForUnpacked: true });
      const info = await new Promise((resolve, reject) => {
        api.getExtensionInfo(id, (value) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(value);
        });
      });
      return {
        installWarnings: info.installWarnings,
        manifestErrors: info.manifestErrors,
        runtimeWarnings: info.runtimeWarnings,
      };
    }, extensionId);
  } finally {
    await page.close();
  }
}

async function openWatchedExtensionPage(context, extensionId, pageName, errors) {
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    errors.push(`${pageName}: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${pageName}: ${message.text()}`);
  });
  await page.goto(`chrome-extension://${extensionId}/src/${pageName}.html`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

function watchExtensionErrors(context, errors) {
  const watchWorker = (worker) => {
    worker.on('console', (message) => {
      if (message.type() === 'error' && isExtensionUrl(worker.url())) {
        errors.push(`service-worker: ${message.text()}`);
      }
    });
  };

  for (const worker of context.serviceWorkers()) watchWorker(worker);
  context.on('serviceworker', watchWorker);
  context.on('console', (message) => {
    if (message.type() !== 'error') return;
    const url = message.location().url || message.page()?.url() || message.worker()?.url();
    if (isExtensionUrl(url)) errors.push(`${url}: ${message.text()}`);
  });
  context.on('weberror', (webError) => {
    const location = webError.location();
    if (isExtensionUrl(location.url)) errors.push(`${location.url}: ${webError.error().message}`);
  });
}

function isExtensionUrl(url) {
  return String(url || '').startsWith('chrome-extension://');
}

async function buildIsolatedExtension() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'pagenarrator-build-load-'));
  const dist = path.join(tempRoot, 'dist');
  try {
    await runViteBuild(dist);
    return {
      dist,
      cleanup: () => rm(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function runViteBuild(outDir) {
  const viteBin = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');
  return execFileAsync(process.execPath, [viteBin, 'build'], {
    cwd: rootDir,
    env: {
      ...process.env,
      PN_OUT_DIR: outDir,
    },
    maxBuffer: 1024 * 1024 * 16,
  });
}
