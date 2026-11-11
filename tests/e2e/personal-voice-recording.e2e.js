import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { pcmToWavBlob } from '../../src/lib/speech-audio.js';
import { getExtensionId, launchExtensionContext } from './extension-fixture.js';

test('records a guided sample and saves recorded or imported audio', async ({}, testInfo) => {
  const { context, cleanup } = await launchExtensionContext({ testInfo, browserArgs: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  ], locale: 'en' });
  try {
    await context.addInitScript(() => {
      const openMic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      globalThis.microphoneTracks = [];
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await openMic(constraints);
        globalThis.microphoneTracks.push(...stream.getAudioTracks());
        return stream;
      };
      Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } });
      // Exercise real recording and decoding. Substitute only model inference for this UI regression.
      const NativeWorker = Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(url, options) {
          super(url, options);
          this.cleanupWorker = String(url).includes('reference-cleanup-worker');
        }
        postMessage(message) {
          if (this.cleanupWorker) {
            const pcm = new Float32Array(message.pcm.length * 3 + 6);
            pcm.fill(0.125, 24_000, pcm.length - 24_000);
            const data = globalThis.failCleanup
              ? { error: 'WebGPU is unavailable.' }
              : { pcm };
            queueMicrotask(() => this.onmessage({ data }));
            return;
          }
          globalThis.encodedSamples = message.pcm?.length;
          globalThis.encodedCleanedClip = Math.abs(message.pcm[Math.floor(message.pcm.length / 2)] - 0.125) < 0.001;
          const frames = Math.ceil(message.pcm.length / 1920) * 2;
          queueMicrotask(() => this.onmessage({ data: { result: { frames, codes: new Uint16Array(8 * frames) } } }));
        }
      };
    });
    const page = await context.newPage();
    const extensionId = await getExtensionId(context);
    await page.goto(`chrome-extension://${extensionId}/src/personal-voices.html`);
    const record = page.getByRole('button', { name: 'Record a clip' });
    const stop = page.getByRole('button', { name: 'Stop recording' });
    const playback = page.locator('#recorded-clip');
    const transcript = page.locator('#voice-text');
    const language = page.locator('#voice-language');
    const prompt = page.locator('#recording-prompt');
    const swedish = 'Jag läser den här korta meningen med min vanliga röst. Utanför fönstret skiner solen.';
    // Type-ahead on the native select dispatches a trusted change event.
    await language.selectOption('es');
    await language.press('s');
    await expect(language).toHaveValue('sv');
    await expect(prompt).toHaveText(swedish);
    await expect(prompt).toHaveAttribute('lang', 'sv');
    await expect(transcript).toHaveValue('');
    await record.click();
    await expect(stop).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(record).toBeEnabled();
    await expect(playback).toBeHidden();
    await expect(transcript).toHaveValue('');
    expect(await page.evaluate(() => globalThis.microphoneTracks.map(track => track.readyState))).toEqual(['ended']);

    await record.click();
    await expect(stop).toBeVisible();
    await expect(stop).toBeEnabled({ timeout: 5_000 });
    await stop.click();
    await expect(playback).toBeVisible();
    await expect(transcript).toHaveValue(swedish);
    await expect.poll(() => playback.evaluate(audio => audio.duration)).toBeGreaterThanOrEqual(3);
    await playback.evaluate(audio => audio.play());
    await expect.poll(() => playback.evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
    await playback.evaluate(audio => audio.pause());
    expect(await page.evaluate(() => globalThis.microphoneTracks.every(track => track.readyState === 'ended'))).toBe(true);
    const clean = page.getByRole('button', { name: 'Clean up background noise' });
    const original = page.getByRole('button', { name: 'Use original clip' });
    const before = await playback.getAttribute('src');
    await page.evaluate(() => { globalThis.failCleanup = true; });
    await clean.click();
    await expect(page.getByRole('status')).toHaveText('Noise cleanup unavailable. Your original clip is ready to save.');
    await expect(playback).toHaveAttribute('src', before);
    await page.evaluate(() => { globalThis.failCleanup = false; });
    await clean.click();
    await expect(original).toBeVisible();
    await expect(playback).not.toHaveAttribute('src', before);
    await original.click();
    await expect(original).toBeHidden();
    await clean.click();
    await expect(original).toBeVisible();
    await page.locator('#voice-name').fill('Microphone sample');
    await transcript.fill('Hej, det här är min inspelning.');
    await page.getByRole('button', { name: 'Save voice preset' }).click();
    await expect(page.getByRole('status')).toHaveText('Voice preset saved.');
    expect(await page.evaluate(() => globalThis.encodedSamples)).toBeGreaterThanOrEqual(72_000);
    expect(await page.evaluate(() => globalThis.encodedCleanedClip)).toBe(true);
    await expect(page.locator('#saved-voice option')).toHaveText('Microphone sample');
    await expect(playback).toBeHidden();

    const originalPath = testInfo.outputPath('original.wav');
    const originalWav = pcmToWavBlob(new Float32Array(5 * 24_000).fill(0.25), 24_000);
    await writeFile(originalPath, Buffer.from(await originalWav.arrayBuffer()));
    await page.locator('#voice-file').setInputFiles(originalPath);
    await expect(transcript).toHaveValue('');
    await page.evaluate(() => { globalThis.failCleanup = true; });
    await clean.click();
    await expect(page.getByRole('status')).toHaveText('Noise cleanup unavailable. Your original clip is ready to save.');
    await expect.poll(() => playback.evaluate(audio => audio.duration)).toBe(5);
    await page.evaluate(() => { globalThis.failCleanup = false; });
    await clean.click();
    await expect.poll(() => playback.evaluate(audio => audio.duration)).toBeCloseTo(4.28, 1);
    await original.click();
    await expect.poll(() => playback.evaluate(audio => audio.duration)).toBe(5);
    await page.locator('#voice-name').fill('Original sample');
    await page.locator('#voice-text').fill('This is my example recording.');
    await page.getByRole('button', { name: 'Save voice preset' }).click();
    await expect(page.getByRole('status')).toHaveText('Voice preset saved.');
    expect(await page.evaluate(() => globalThis.encodedCleanedClip)).toBe(false);
    await expect(page.locator('#saved-voice option', { hasText: 'Original sample' })).toHaveCount(1);
  } finally { await cleanup(); }
});
