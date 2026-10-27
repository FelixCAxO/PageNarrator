import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { launchExtensionContext, openExtensionPage, seedRealTtsFlowFlags, startReadFromToolbarPopup } from './extension-fixture.js';
import { openRoutedReaderEngine, routeKokoroModelFiles, routeOmniVoiceModelFiles, seedKokoroModelCache } from './kokoro-download-fixture.js';
import { buildCorpusFlowReport } from './corpus-flow-invariants.js';
import { selectNativeOption, setNativeRange } from './native-controls-fixture.js';
import { browserAdapterConfiguration, verifyBrowserAdapter } from '../../scripts/lib/browser-adapter.mjs';

const SAMPLES = [
  {
    "code": "en",
    "text": "Hello! Today we are reading a short story about a quiet garden."
  },
  {
    "code": "sv",
    "text": "Hej! Idag läser vi en kort berättelse om en lugn trädgård."
  },
  {
    "code": "de",
    "text": "Hallo! Heute lesen wir eine kurze Geschichte über einen ruhigen Garten."
  },
  {
    "code": "fr",
    "text": "Bonjour ! Aujourd’hui, nous lisons une courte histoire sur un jardin tranquille."
  },
  {
    "code": "es",
    "text": "¡Hola! Hoy leemos una historia corta sobre un jardín tranquilo."
  },
  {
    "code": "ru",
    "text": "Привет! Сегодня мы читаем короткую историю о тихом саде."
  },
  {
    "code": "zh",
    "text": "你好！今天我们一起阅读一个关于安静花园的小故事。"
  },
  {
    "code": "ja",
    "text": "こんにちは。今日は静かな庭についての短い物語を読みます。"
  },
  {
    "code": "arb",
    "text": "مرحباً! اليوم نقرأ قصة قصيرة عن حديقة هادئة."
  },
  {
    "code": "hi",
    "text": "नमस्ते! आज हम एक शांत बगीचे के बारे में एक छोटी कहानी पढ़ते हैं।"
  }
];

test('keeps Kokoro as default and reads with OmniVoice sliders on WebGPU', async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_OMNIVOICE !== '1', 'Set PN_E2E_OMNIVOICE=1: requires pinned local speech fixtures and native WebGPU.');
  test.setTimeout(20 * 60_000);
  const server = createServer((request, response) => {
    const sample = SAMPLES.find(item => request.url === '/' + item.code) || SAMPLES[0];
    const htmlLanguage = sample.code === 'arb' ? 'ar' : sample.code;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<html lang="${htmlLanguage}"><title>Voice test</title><article><p>${sample.text}</p></article></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { context, cleanup } = await launchExtensionContext({ testInfo, hostPermissions: ['http://127.0.0.1/*'] });
  context.setDefaultTimeout(30_000);
  try {
    await routeKokoroModelFiles(context);
    await seedKokoroModelCache(context);
    await routeOmniVoiceModelFiles(context);
    context.on('page', page => page.on('worker', worker => {
      worker.evaluate(() => {
        let submissions = 0;
        const telemetry = self.__omniJourney = {
          requests: [], replies: [], submissions: 0, mapsStarted: 0, mapsFinished: 0,
          mapErrors: [], deviceEvents: [], lastSubmit: 0, lastMapStarted: 0, lastMapFinished: 0,
        };
        self.addEventListener('message', ({ data }) => {
          telemetry.requests.push({ t: performance.now(), id: data.id, method: data.method });
        });
        const requestDevice = GPUAdapter.prototype.requestDevice;
        GPUAdapter.prototype.requestDevice = async function (...args) {
          const device = await requestDevice.apply(this, args);
          device.lost.then(info => telemetry.deviceEvents.push({ t: performance.now(), reason: info.reason, message: info.message }));
          device.addEventListener('uncapturederror', event => telemetry.deviceEvents.push({ t: performance.now(), message: event.error.message }));
          return device;
        };
        const mapAsync = GPUBuffer.prototype.mapAsync;
        GPUBuffer.prototype.mapAsync = async function (...args) {
          telemetry.mapsStarted += 1; telemetry.lastMapStarted = performance.now();
          try { return await mapAsync.apply(this, args); }
          catch (error) { telemetry.mapErrors.push(String(error)); throw error; }
          finally { telemetry.mapsFinished += 1; telemetry.lastMapFinished = performance.now(); }
        };
        const submit = GPUQueue.prototype.submit;
        GPUQueue.prototype.submit = function (...args) {
          submissions += 1;
          telemetry.submissions += 1; telemetry.lastSubmit = performance.now();
          return submit.apply(this, args);
        };
        const post = self.postMessage.bind(self);
        self.postMessage = (message, options) => {
          if (message.id !== undefined) telemetry.replies.push({ t: performance.now(), id: message.id, error: message.error });
          if (message.result?.pcm) {
            message.result.testGpuSubmissions = submissions;
            submissions = 0;
          }
          return post(message, options);
        };
      }).catch(error => console.log(`[worker-instrumentation] ${error.message}`));
    }));
    await context.addInitScript(() => {
      globalThis.__omniGpuSubmissions = 0;
      globalThis.__voiceWavs = [];
      const NativeWorker = globalThis.Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            globalThis.__omniGpuSubmissions += data.result?.testGpuSubmissions || 0;
          });
        }
      };
      const createUrl = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        if (blob instanceof Blob && blob.type === 'audio/wav') globalThis.__voiceWavs.push(blob.arrayBuffer());
        return createUrl(blob);
      };
      if (globalThis.GPUQueue) {
        const submit = GPUQueue.prototype.submit;
        GPUQueue.prototype.submit = function (...args) {
          globalThis.__omniGpuSubmissions += 1;
          return submit.apply(this, args);
        };
      }
    });
    await seedRealTtsFlowFlags(context, { playbackSettings: { language: 'en', voice: 'af_heart', speed: 3, sectionPauseSeconds: 0 } });
    let engine = await openRoutedReaderEngine(context);
    await expect(engine.locator('#tts-engine-select')).toHaveValue('kokoro');
    const article = await context.newPage();
    await article.goto(`${origin}/en`);
    await startAndVerify(context, article, 'kokoro');

    const popup = await openExtensionPage(context, 'popup');
    await popup.locator('#popup-settings summary').click();
    await selectNativeOption(popup.locator('#popup-tts-engine'), 'omnivoice');
    await expect(popup.locator('#popup-omnivoice-settings')).toBeVisible();
    await expect(popup.locator('#popup-language option')).toHaveCount(32);
    await expect(popup.locator('#popup-voice')).toBeHidden();
    await selectNativeOption(popup.locator('#popup-language'), 'sv');
    await selectNativeOption(popup.locator('#popup-omnivoice-gender'), 'male');
    await setNativeRange(popup.locator('#popup-omnivoice-variation'), 7);
    await popup.locator('#popup-omnivoice-whisper').check();
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => worker.evaluate(() => chrome.storage.local.get('playbackSettings').then((s) => s.playbackSettings)))
      .toMatchObject({ ttsEngine: 'omnivoice', omniVoice: { gender: 'male', variation: 7, whisper: true }, voice: 'af_heart' });
    const submitsBefore = await engine.evaluate(() => globalThis.__omniGpuSubmissions);
    for (const sample of SAMPLES) {
      await selectNativeOption(popup.locator('#popup-language'), sample.code);
      await article.goto(`${origin}/${sample.code}`);
      await startAndVerify(context, article, `omnivoice-${sample.code}`);
      if (['en', 'zh', 'arb'].includes(sample.code)) {
        await popup.reload();
        await expect(popup.locator('#popup-tts-engine')).toHaveValue('omnivoice');
        await popup.locator('#popup-settings summary').click();
        await selectNativeOption(popup.locator('#popup-omnivoice-gender'), 'female');
        await setNativeRange(popup.locator('#popup-omnivoice-variation'), 4);
        await popup.locator('#popup-omnivoice-whisper').uncheck();
        await expect.poll(() => worker.evaluate(() => chrome.storage.local.get('playbackSettings').then(s => s.playbackSettings)))
          .toMatchObject({ language: sample.code, omniVoice: { gender: 'female', variation: 4, whisper: false } });
        await article.goto(`${origin}/${sample.code}`);
        await startAndVerify(context, article, `omnivoice-${sample.code}-variation`);
        await selectNativeOption(popup.locator('#popup-omnivoice-gender'), 'male');
        await setNativeRange(popup.locator('#popup-omnivoice-variation'), 7);
        await popup.locator('#popup-omnivoice-whisper').check();
      }
    }
    const gpuSubmissions = await engine.evaluate(() => globalThis.__omniGpuSubmissions);
    expect(gpuSubmissions).toBeGreaterThan(submitsBefore + 100);
    const adapterInfo = await engine.evaluate(async () => {
      const { info } = await navigator.gpu.requestAdapter();
      return { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
    });
    verifyBrowserAdapter(adapterInfo, browserAdapterConfiguration());
    console.log(`[omnivoice-webgpu] ${JSON.stringify({ gpuSubmissions: gpuSubmissions - submitsBefore, adapterInfo })}`);
    await test.info().attach('native-webgpu', { body: Buffer.from(JSON.stringify({ gpuSubmissions, adapterInfo })), contentType: 'application/json' });
    const cacheCount = await engine.evaluate(async () => (await (await caches.open('pagenarrator-omnivoice-v1')).keys()).length);
    expect(cacheCount).toBe(7);
    await popup.screenshot({ path: testInfo.outputPath('omnivoice-settings.png'), fullPage: true });

    await selectNativeOption(popup.locator('#popup-language'), 'sv');
    await article.goto(`${origin}/sv`);
    await startAndVerify(context, article, 'omnivoice-sv-restored');

    // A fresh engine must restore sliders and reload model data from cache while offline.
    await engine.close();
    engine = await openRoutedReaderEngine(context);
    await expect(engine.locator('#tts-engine-select')).toHaveValue('omnivoice');
    await popup.reload();
    await expect(popup.locator('#popup-omnivoice-variation')).toHaveValue('7');
    await expect(popup.locator('#popup-omnivoice-whisper')).toBeChecked();
    const network = await context.newCDPSession(engine);
    await network.send('Network.enable');
    await network.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await startAndVerify(context, article, 'omnivoice-offline');
    expect(await engine.evaluate(() => globalThis.__omniGpuSubmissions)).toBeGreaterThan(100);
  } finally {
    await cleanup();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function startAndVerify(context, article, label) {
  let lastDetail = '';
  const worker = context.serviceWorkers()[0];
  const engine = context.pages().find(page => page.url().includes('/reader-engine.html'));
  const wavStart = await engine.evaluate(() => globalThis.__voiceWavs.length);
  const before = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
  const logStart = before?.log?.length || 0;
  await startReadFromToolbarPopup(context, article);
  // A previous read may still report finished until the next read starts.
  try {
    await expect.poll(async () => {
      const flow = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
      return flow?.log?.slice(logStart).some(entry => entry.kind === 'chunks_extracted');
    }, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => {
      const { readerEngineState: snapshot } = await worker.evaluate(() => chrome.storage.session.get('readerEngineState'));
      if (snapshot?.modelSetup?.detail && snapshot.modelSetup.detail !== lastDetail) { lastDetail = snapshot.modelSetup.detail; console.log(`[${label}] ${lastDetail}`); }
      if (snapshot?.state === 'error') throw new Error(`${label}: ${JSON.stringify(snapshot)}`);
      return snapshot?.state;
    }, { timeout: 5 * 60_000, intervals: [500, 1000, 2000] }).toBe('finished');
  } catch (error) {
    const diagnostics = await worker.evaluate(async () => ({
      state: await chrome.storage.session.get('readerEngineState'),
      flow: await chrome.runtime.sendMessage({ type: 'getFlowLog' }),
    }));
    const workers = await Promise.all(engine.workers().map(async instance => ({
      url: instance.url(),
      telemetry: await instance.evaluate(() => self.__omniJourney).catch(failure => ({ closed: failure.message })),
    })));
    await test.info().attach(`${label}-failure-diagnostics`, {
      body: Buffer.from(JSON.stringify({ diagnostics, workers })), contentType: 'application/json',
    });
    throw error;
  }
  const diagnostics = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
  diagnostics.log = diagnostics.log.slice(logStart);
  const report = buildCorpusFlowReport({ readerEngineLog: diagnostics.log });
  expect(report.synthesisFailures).toEqual([]);
  expect(report.chunksExtracted).toBeGreaterThan(0);
  expect(report.chunksSpoken).toBe(report.chunksExtracted);
  expect(report.unendedChunkIndices).toEqual([]);
  expect(report.missingChunkIndices).toEqual([]);
  expect(report.replayedChunkIndices).toEqual([]);
  expect(report.chunkEnds.some((entry) => entry.mediaTime > 0)).toBe(true);
  expect(diagnostics.log.some((entry) => ['audio_decode_latency', 'audio_preload_decode_latency'].includes(entry.kind))).toBe(true);
  console.log(`[${label}] ${JSON.stringify({ chunks: report.chunksSpoken, chunkEnds: report.chunkEnds, backend: diagnostics.hardwareProbe?.selectedBackendPlan })}`);
  await test.info().attach(label, { body: Buffer.from(JSON.stringify(diagnostics)), contentType: 'application/json' });
  const wavs = await engine.evaluate(async start => Promise.all(globalThis.__voiceWavs.slice(start).map(async wav => Array.from(new Uint8Array(await wav)))), wavStart);
  expect(wavs.length).toBeGreaterThan(0);
  for (let index = 0; index < wavs.length; index += 1) {
    const audio = Buffer.from(wavs[index]);
    expect(audio.readUInt32LE(24)).toBe(24000);
    let energy = 0;
    for (let offset = 44; offset < audio.length; offset += 2) energy += (audio.readInt16LE(offset) / 32768) ** 2;
    expect(Math.sqrt(energy / ((audio.length - 44) / 2))).toBeGreaterThan(0.0001);
    const path = test.info().outputPath(`${label}-chunk-${index}.wav`);
    await writeFile(path, audio);
    await test.info().attach(`${label}-chunk-${index}.wav`, { path, contentType: 'audio/wav' });
  }
  return report.chunkEnds.reduce((seconds, entry) => seconds + entry.mediaTime, 0);
}
