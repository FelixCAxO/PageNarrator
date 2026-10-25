import { chromium, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveExtensionDir } from './extension-fixture.js';

test('rejects external extension messages and ports without exposing or changing private state', async ({}, testInfo) => {
  const extensionDir = resolveExtensionDir({ testInfo });
  const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
  // Empty ids/matches produces an install warning; omission still requires an
  // explicit onMessageExternal/onConnectExternal listener to receive messages.
  expect.soft(Object.hasOwn(manifest, 'externally_connectable')).toBe(false);
  const scratchDir = await mkdtemp(path.join(tmpdir(), 'pagenarrator-external-probe-'));
  let context;
  try {
    const probeDir = path.join(scratchDir, 'probe');
    await mkdir(probeDir);
    await writeFile(path.join(probeDir, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Untrusted external extension probe',
      version: '1.0.0',
      background: { service_worker: 'probe.js' },
    }));
    await writeFile(path.join(probeDir, 'probe.js'), 'chrome.runtime.onInstalled.addListener(() => {});\n');
    context = await chromium.launchPersistentContext(path.join(scratchDir, 'profile'), {
      channel: 'chromium',
      headless: !/^(1|true|yes)$/i.test(process.env.PN_E2E_HEADED || ''),
      args: [
        '--mute-audio',
        `--disable-extensions-except=${extensionDir},${probeDir}`,
        `--load-extension=${extensionDir},${probeDir}`,
      ],
    });
    const findWorker = async (workerPath) => {
      const matches = (worker) => new URL(worker.url()).pathname === `/${workerPath}`;
      return context.serviceWorkers().find(matches)
        || context.waitForEvent('serviceworker', { predicate: matches });
    };
    const [targetWorker, probeWorker] = await Promise.all([
      findWorker(manifest.background.service_worker),
      findWorker('probe.js'),
    ]);
    const targetId = new URL(targetWorker.url()).hostname;
    const probeId = new URL(probeWorker.url()).hostname;
    expect(probeId).not.toBe(targetId);
    expect(await targetWorker.evaluate(() => ({
      name: chrome.runtime.getManifest().name,
      handlesInternalMessages: chrome.runtime.onMessage.hasListeners(),
    }))).toEqual({ name: 'PageNarrator', handlesInternalMessages: true });

    await targetWorker.evaluate(async () => {
      await chrome.storage.local.set({ securityProbeSentinel: 'private-extension-setting' });
      await chrome.storage.session.set({ readerEngineState: { state: 'paused', title: 'Private reading title' } });
    });
    const snapshot = () => targetWorker.evaluate(async () => ({
      local: await chrome.storage.local.get(['securityProbeSentinel', 'readableTabTarget']),
      session: await chrome.storage.session.get('readerEngineState'),
      engines: await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }),
      tabIds: (await chrome.tabs.query({})).map((tab) => tab.id).sort((a, b) => a - b),
    }));
    const before = await snapshot();
    expect(before.engines).toEqual([]);
    expect(before.tabIds.length).toBeGreaterThan(0);
    const requests = [
      { type: 'readerEngineGetState' },
      { type: 'readerEngineRpc', operation: 'storage.local.get', args: [null] },
      { type: 'readerEngineRpc', operation: 'storage.local.set', args: [{ securityProbeSentinel: 'attacker-changed' }] },
      { type: 'readerEngineRpc', operation: 'tabs.create', args: [{ url: 'https://untrusted-extension.test/' }] },
      { type: 'readerStateChanged', state: 'reading', title: 'Attacker-changed title' },
      { type: 'readerEngineActionRequest', action: { type: 'togglePlayback' }, tab: { id: before.tabIds[0], url: 'https://untrusted-extension.test/article' } },
      { type: 'readerEngineAction', action: { type: 'stop' } },
      { type: 'getFlowLog' },
    ];
    const attempts = await probeWorker.evaluate(async ({ extensionId, messages }) => {
      const responses = [];
      for (const message of messages) {
        try {
          responses.push({ type: message.type, rejected: false, value: await chrome.runtime.sendMessage(extensionId, message) ?? null });
        } catch (error) {
          responses.push({ type: message.type, rejected: true, value: null, error: error.message });
        }
      }
      const portResult = await new Promise((resolve) => {
        const port = chrome.runtime.connect(extensionId, { name: 'external-security-probe' });
        const received = [];
        const timer = setTimeout(() => {
          port.disconnect();
          resolve({ disconnected: false, received, error: 'No native disconnect within 5 seconds' });
        }, 5_000);
        port.onMessage.addListener((message) => received.push(message));
        port.onDisconnect.addListener(() => {
          const error = chrome.runtime.lastError?.message ?? null;
          clearTimeout(timer);
          resolve({ disconnected: true, received, error });
        });
        for (const message of messages) port.postMessage(message);
      });
      return { responses, port: portResult };
    }, { extensionId: targetId, messages: requests });
    const after = await snapshot();
    const evidence = JSON.stringify({ targetId, probeId, requests, attempts, before, after }, null, 2);
    await writeFile(testInfo.outputPath('external-extension-boundary.json'), evidence);
    await testInfo.attach('external-extension-boundary.json', {
      body: evidence,
      contentType: 'application/json',
    });
    for (const response of attempts.responses) expect(response).toMatchObject({
      rejected: true, value: null, error: expect.stringMatching(/receiving end does not exist/i),
    });
    expect(attempts.port).toEqual({
      disconnected: true, received: [], error: expect.stringMatching(/receiving end does not exist/i),
    });
    expect(after).toEqual(before);
  } finally {
    await context?.close();
    await rm(scratchDir, { recursive: true, force: true });
  }
});
