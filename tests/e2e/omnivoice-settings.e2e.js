import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { launchExtensionContext, openExtensionPage, seedRealTtsFlowFlags, startReadFromToolbarPopup } from './extension-fixture.js';
import { openRoutedReaderEngine, routeOmniVoiceModelFiles } from './kokoro-download-fixture.js';
import { selectNativeOption, setNativeRange } from './native-controls-fixture.js';

const base = { gender: 'female', variation: 1, whisper: false };
const cases = [
  { id: 'baseline' }, { id: 'male', gender: 'male' }, { id: 'whisper', whisper: true },
  { id: 'variation-4', variation: 4 }, { id: 'variation-10', variation: 10 },
  { id: 'swedish', language: 'sv' },
  { id: 'playback-slow', playbackRate: 0.5 }, { id: 'playback-fast', playbackRate: 3 },
];
const texts = {
  en: 'Today we are reading a short story about a quiet garden beside the old stone bridge.',
  sv: 'Idag läser vi en kort berättelse om en lugn trädgård bredvid den gamla stenbron.',
};

test('every OmniVoice control reaches real synthesis and survives reopening', async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_OMNIVOICE !== '1', 'Requires pinned models and native WebGPU.');
  test.setTimeout(15 * 60_000);
  const server = createServer((request, response) => {
    const lang = new URL(request.url, 'http://localhost').searchParams.get('lang') === 'sv' ? 'sv' : 'en';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<html lang="${lang}"><title>Settings verification</title><article><p>${texts[lang]}</p></article></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { context, cleanup } = await launchExtensionContext({ testInfo, hostPermissions: ['http://127.0.0.1/*'] });
  const results = [];
  try {
    await routeOmniVoiceModelFiles(context);
    await context.addInitScript(() => {
      globalThis.__settingAudio = { jobs: [], wavs: [], plays: [] };
      const NativeWorker = Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          const jobs = new Map(), post = this.postMessage.bind(this);
          this.postMessage = (message, ...options) => {
            if (message.method === 'synthesize') {
              const job = { ...message.request, started: Date.now() };
              jobs.set(message.id, job); globalThis.__settingAudio.jobs.push(job);
            }
            return post(message, ...options);
          };
          this.addEventListener('message', ({ data }) => {
            const job = jobs.get(data.id);
            if (job) Object.assign(job, { ended: Date.now(), error: data.error, speaker: data.result?.speaker,
              samples: data.result?.pcm?.length, sampleRate: data.result?.sampleRate });
          });
        }
      };
      const createUrl = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        if (blob instanceof Blob && blob.type === 'audio/wav') globalThis.__settingAudio.wavs.push(blob.arrayBuffer());
        return createUrl(blob);
      };
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        if (this.src.startsWith('blob:')) globalThis.__settingAudio.plays.push({ rate: this.playbackRate, duration: this.duration });
        return play.apply(this, args);
      };
    });
    await seedRealTtsFlowFlags(context, { playbackSettings: { ttsEngine: 'kokoro', language: 'en', voice: 'af_heart', speed: 1, sectionPauseSeconds: 0,
      omniVoice: { ...base, pitch: 0, age: 4 } } });
    const engine = await openRoutedReaderEngine(context);
    await expect(engine.locator('#omnivoice-pitch, #omnivoice-age, #omnivoice-tempo')).toHaveCount(0);
    const worker = context.serviceWorkers()[0];
    const popup = await openExtensionPage(context, 'popup');
    await selectNativeOption(popup.locator('#popup-tts-engine'), 'omnivoice');
    await popup.locator('#popup-settings summary').click();
    await expect(popup.locator('#popup-language option')).toHaveCount(32);
    await expect(popup.locator('#popup-omnivoice-pitch, #popup-omnivoice-age, #popup-omnivoice-tempo')).toHaveCount(0);
    const article = await context.newPage();
    for (const item of cases) {
      const language = item.language || 'en';
      const settings = Object.fromEntries(Object.keys(base).map(key => [key, item[key] ?? base[key]]));
      await selectNativeOption(popup.locator('#popup-language'), language);
      await selectNativeOption(popup.locator('#popup-omnivoice-gender'), settings.gender);
      for (const key of ['variation']) await setNativeRange(popup.locator(`#popup-omnivoice-${key}`), settings[key]);
      await popup.locator('#popup-omnivoice-whisper').setChecked(settings.whisper);
      await setNativeRange(popup.locator('#popup-speed'), item.playbackRate || 1);
      await expect.poll(() => worker.evaluate(() => chrome.storage.local.get('playbackSettings').then(result => result.playbackSettings)))
        .toMatchObject({ ttsEngine: 'omnivoice', language, omniVoice: settings, speed: item.playbackRate || 1 });
      expect(await worker.evaluate(() => chrome.storage.local.get('playbackSettings').then(result => result.playbackSettings.omniVoice))).toEqual(settings);
      await popup.reload();
      await expect(popup.locator('#popup-omnivoice-gender')).toHaveValue(settings.gender);
      for (const key of ['variation']) await expect(popup.locator(`#popup-omnivoice-${key}`)).toHaveValue(String(settings[key]));
      await expect(popup.locator('#popup-omnivoice-whisper')).toBeChecked({ checked: settings.whisper });
      await popup.locator('#popup-settings summary').click();
      const start = await engine.evaluate(() => ({ jobs: __settingAudio.jobs.length, wavs: __settingAudio.wavs.length, plays: __settingAudio.plays.length }));
      const flowStart = (await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }))).log.length;
      await article.goto(`http://127.0.0.1:${server.address().port}/?lang=${language}&case=${item.id}`);
      await startReadFromToolbarPopup(context, article);
      await expect.poll(async () => {
        const flow = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
        return flow.log.slice(flowStart).some(entry => entry.kind === 'chunks_extracted');
      }, { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => {
        const { readerEngineState: state = {} } = await worker.evaluate(() => chrome.storage.session.get('readerEngineState'));
        if (state.state === 'error') throw new Error(JSON.stringify(state));
        return state.state;
      }, { timeout: 120_000 }).toBe('finished');
      const actual = await engine.evaluate(async start => ({ jobs: __settingAudio.jobs.slice(start.jobs), plays: __settingAudio.plays.slice(start.plays),
        wavs: await Promise.all(__settingAudio.wavs.slice(start.wavs).map(async bytes => Array.from(new Uint8Array(await bytes)))) }), start);
      expect(actual.jobs).toHaveLength(1);
      expect(actual.wavs).toHaveLength(1);
      expect(actual.jobs[0]).toMatchObject({ text: texts[language], lang: language, speed: 1, seed: 41 + settings.variation });
      expect(actual.jobs[0].instruct).toBe(settings.gender);
      expect(actual.jobs[0].speaker.id).toBe(`${settings.gender}-${settings.variation}`);
      expect(actual.jobs[0].whisper === true).toBe(settings.whisper);
      expect(actual.plays.some(play => play.rate === (item.playbackRate || 1))).toBe(true);
      const audio = Buffer.from(actual.wavs[0]), filename = `${item.id}.wav`;
      await writeFile(testInfo.outputPath(filename), audio);
      results.push({ id: item.id, settings, language, playbackRate: item.playbackRate || 1, jobs: actual.jobs, plays: actual.plays,
        wav: filename, sha256: createHash('sha256').update(audio).digest('hex'), audioSeconds: (audio.length - 44) / 48000 });
      await writeFile(testInfo.outputPath('settings.json'), JSON.stringify(results, null, 2));
      console.log(`[omnivoice-setting] ${JSON.stringify(results.at(-1))}`);
    }
    for (const id of ['variation-4', 'variation-10']) expect(results.find(item => item.id === id).sha256).not.toBe(results[0].sha256);
  } finally {
    await cleanup(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('OmniVoice replaces preloaded speech when voice settings change during narration', async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_OMNIVOICE !== '1', 'Requires pinned models and native WebGPU.');
  test.setTimeout(4 * 60_000);
  const paragraphs = [
    'The morning sun shines through the trees as we walk slowly along the quiet garden path beside the old stone bridge and listen to the birds singing softly in the fresh air.',
    'A small bird lands on the wooden fence and sings softly in the fresh air.',
    'We follow the quiet path toward the trees and stop beside the old stone wall.',
  ];
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<html lang="en"><title>Live voice change</title><article>${paragraphs.map(text => `<p>${text}</p>`).join('')}</article></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { context, cleanup } = await launchExtensionContext({ testInfo, hostPermissions: ['http://127.0.0.1/*'] });
  try {
    await routeOmniVoiceModelFiles(context);
    await context.addInitScript(() => {
      globalThis.__liveSettings = { jobs: [], plays: [] };
      let completed;
      const urls = new Map(), NativeWorker = Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          const jobs = new Map(), post = this.postMessage.bind(this);
          this.postMessage = (message, ...options) => {
            if (message.method === 'synthesize') {
              const job = { ...message.request };
              jobs.set(message.id, job); __liveSettings.jobs.push(job);
            }
            return post(message, ...options);
          };
          this.addEventListener('message', ({ data }) => {
            const job = jobs.get(data.id);
            if (job && data.result?.pcm) {
              Object.assign(job, { speaker: data.result.speaker }); completed = job;
            }
          });
        }
      };
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        const url = create(blob);
        if (blob instanceof Blob && blob.type === 'audio/wav') urls.set(url, completed);
        return url;
      };
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        if (urls.has(this.src)) __liveSettings.plays.push({ ...urls.get(this.src), rate: this.playbackRate });
        return play.apply(this, args);
      };
    });
    await seedRealTtsFlowFlags(context, { playbackSettings: { ttsEngine: 'omnivoice', language: 'en', voice: 'af_heart',
      speed: 0.5, sectionPauseSeconds: 0, omniVoice: base } });
    const engine = await openRoutedReaderEngine(context);
    const article = await context.newPage();
    await article.goto(`http://127.0.0.1:${server.address().port}/`);
    await startReadFromToolbarPopup(context, article);
    await expect.poll(() => engine.evaluate(() => __liveSettings.plays.length), { timeout: 90_000 }).toBe(1);
    // Let the old voice finish preloading before changing it, while section one still plays.
    await expect.poll(() => engine.evaluate(() => __liveSettings.jobs.filter(job => job.speaker).length), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    const popup = await openExtensionPage(context, 'popup');
    await popup.locator('#popup-settings summary').click();
    await expect(popup.locator('#popup-omnivoice-settings')).toContainText('Changes apply at the next section.');
    await setNativeRange(popup.locator('#popup-omnivoice-variation'), 4);
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => worker.evaluate(() => chrome.storage.local.get('playbackSettings').then(result => result.playbackSettings.omniVoice.variation))).toBe(4);
    await expect.poll(async () => {
      const { readerEngineState: state = {} } = await worker.evaluate(() => chrome.storage.session.get('readerEngineState'));
      if (state.state === 'error') throw new Error(JSON.stringify(state));
      return state.state;
    }, { timeout: 150_000 }).toBe('finished');
    const actual = await engine.evaluate(() => __liveSettings);
    await writeFile(testInfo.outputPath('live-settings.json'), JSON.stringify(actual, null, 2));
    expect(actual.plays.map(job => job.text).join(' ')).toBe(paragraphs.join(' '));
    expect(actual.plays.length).toBeGreaterThanOrEqual(3);
    expect(actual.plays[0].instruct).toBe('female');
    expect(actual.plays[0].seed).toBe(42);
    expect(actual.plays.slice(1).every(job => job.seed === 45 && job.instruct === 'female')).toBe(true);
    expect(actual.plays.every(job => job.numStep === 24)).toBe(true);
    expect(actual.plays[1].speaker.referenceId).toBe('en-female-4');
    expect(actual.plays.slice(1).every(job => job.speaker.referenceHash === actual.plays[1].speaker.anchorHash)).toBe(true);
  } finally {
    await cleanup(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
