import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { launchExtensionContext, openExtensionPage, seedRealTtsFlowFlags, startReadFromToolbarPopup } from './extension-fixture.js';
import { openRoutedReaderEngine, routeOmniVoiceModelFiles } from './kokoro-download-fixture.js';
import { OMNIVOICE_ENCODER_DATA } from '../../src/tts/omnivoice/reference-encoder.js';

const referenceText = 'Today we are reading a short story about a quiet garden beside the old stone bridge.';
const narrationText = 'Tomorrow we will walk along the river and watch the boats go by.';
const presetName = 'Test voice from generated speech';

test('imports, previews and narrates with a saved OmniVoice clone on WebGPU', async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_OMNIVOICE_CLONE !== '1', 'Requires the pinned voice encoder, synthesis models and WebGPU.');
  test.setTimeout(10 * 60_000);
  const server = createServer((request, response) => {
    const text = request.url === '/reference' ? referenceText : narrationText;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="en"><title>Voice cloning test</title><article><p>${text}</p></article></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let launched;
  try {
    launched = await launchExtensionContext({ testInfo, hostPermissions: ['http://127.0.0.1/*'], locale: 'en' });
    const { context } = launched;
    const { requests } = await routeOmniVoiceModelFiles(context, { includeEncoder: true });
    await observeSynthesis(context);
    await seedRealTtsFlowFlags(context, { playbackSettings: {
      ttsEngine: 'omnivoice', ttsEngineAuto: false, language: 'en', speed: 3, sectionPauseSeconds: 0,
    } });
    const engine = await openRoutedReaderEngine(context);
    const worker = context.serviceWorkers()[0];
    const article = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;

    // Use shipped speech as the import sample so the test needs no microphone or personal audio.
    await article.goto(`${origin}/reference`);
    await readArticle(context, worker, article);
    const source = await engine.evaluate(async () => {
      const bytes = new Uint8Array(await globalThis.__cloneWavs[0]);
      return { wav: bytes.toBase64(), jobs: globalThis.__cloneJobs };
    });
    expect(source.jobs).toHaveLength(1);
    expect(source.jobs[0]).toMatchObject({ text: referenceText, sampleRate: 24_000 });
    expect(source.jobs[0].rms).toBeGreaterThan(0.001);
    const wav = Buffer.from(source.wav, 'base64');
    const duration = (wav.length - 44) / (24_000 * 2);
    expect(duration).toBeGreaterThanOrEqual(3);
    expect(duration).toBeLessThanOrEqual(10);

    const popup = await openExtensionPage(context, 'popup');
    const manage = await context.newPage();
    await manage.goto(new URL('personal-voices.html', popup.url()).href);
    const status = manage.getByRole('status');
    const saved = manage.locator('#saved-voice');
    await manage.locator('#voice-file').setInputFiles({ name: 'reference.wav', mimeType: 'audio/wav', buffer: wav });
    await manage.locator('#voice-name').fill(presetName);
    await manage.locator('#voice-text').fill(referenceText);
    await manage.getByRole('button', { name: 'Save voice preset' }).click();
    await expect(status).toHaveText('Voice preset saved.', { timeout: 240_000 });
    expect(requests.some(url => url.endsWith(`/${OMNIVOICE_ENCODER_DATA.path}`))).toBe(true);
    const [reference] = await worker.evaluate(async () => (await chrome.storage.local.get('omnivoicePersonalReferences.v1'))['omnivoicePersonalReferences.v1']);
    expect(reference).toMatchObject({ id: expect.stringMatching(/^clone:/), name: presetName, lang: 'en', text: referenceText });
    expect(reference.codes).toHaveLength(8 * reference.frames);
    expect(new Set(reference.codes).size).toBeGreaterThan(1);
    const codeBytes = Buffer.alloc(reference.codes.length * 8);
    reference.codes.forEach((code, index) => codeBytes.writeBigUInt64LE(BigInt(code), index * 8));
    expect(reference.hash).toBe(createHash('sha256').update(codeBytes).digest('hex'));

    await manage.reload();
    await expect(saved).toHaveValue(reference.id);
    await manage.getByRole('button', { name: 'Preview voice' }).click();
    await expect(status).toHaveText('Voice preview ready.', { timeout: 240_000 });
    const preview = manage.locator('#preview-audio');
    await expect(preview).toBeVisible();
    await preview.evaluate(audio => audio.play());
    await expect.poll(() => preview.evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
    await preview.evaluate(audio => audio.pause());
    const previewJobs = await manage.evaluate(() => globalThis.__cloneJobs);
    expect(previewJobs).toHaveLength(1);
    expectCloneAudio(previewJobs[0], referenceText, reference);
    const previewUrl = await preview.getAttribute('src');
    await manage.getByRole('button', { name: 'Preview voice' }).click();
    await expect(status).toHaveText('Voice preview ready.', { timeout: 30_000 });
    await expect(preview).toHaveAttribute('src', previewUrl);
    expect(await manage.evaluate(() => globalThis.__cloneJobs.length)).toBe(1);

    await manage.getByRole('button', { name: 'Use for reading' }).click();
    await expect(status).toHaveText('Selected for reading.');
    await popup.reload();
    await popup.locator('#popup-settings summary').click();
    await expect(popup.locator('#popup-tts-engine')).toHaveValue('omnivoice-clone');
    await expect(popup.locator('#popup-personal-voice')).toHaveValue(reference.id);

    await article.goto(`${origin}/narration`);
    await readArticle(context, worker, article);
    const readJobs = await engine.evaluate(() => globalThis.__cloneJobs.slice(1));
    expect(readJobs).toHaveLength(1);
    expectCloneAudio(readJobs[0], narrationText, reference);

    const otherManager = await context.newPage();
    await otherManager.goto(manage.url());
    await expect(otherManager.locator('#saved-voice')).toHaveValue(reference.id);
    await otherManager.getByRole('button', { name: 'Delete preset' }).click();
    await expect(otherManager.getByRole('status')).toHaveText('Voice preset deleted.');
    await expect(saved).toBeDisabled();
    await expect(preview).toBeHidden();
    await expect(manage.getByRole('button', { name: 'Use for reading' })).toBeDisabled();
    await expect(popup.locator('#popup-personal-voice')).toBeDisabled();
    await expect(engine.locator('#personal-voice-select')).toBeDisabled();
    const stored = await worker.evaluate(() => chrome.storage.local.get(['playbackSettings', 'omnivoicePersonalReferences.v1']));
    expect(stored['omnivoicePersonalReferences.v1']).toEqual([]);
    expect(stored.playbackSettings.personalVoiceId).toBeUndefined();
  } finally {
    try { await launched?.cleanup(); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});

function expectCloneAudio(job, text, reference) {
  expect(job).toMatchObject({ text, lang: 'en', speakerId: reference.id, sampleRate: 24_000,
    speaker: { id: reference.id, referenceId: reference.id, referenceLanguage: 'en', referenceHash: reference.hash } });
  expect(job.rms).toBeGreaterThan(0.001);
}

async function readArticle(context, worker, article) {
  const start = (await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }))).log.length;
  await startReadFromToolbarPopup(context, article);
  await expect.poll(async () => {
    const { readerEngineState: state = {} } = await worker.evaluate(() => chrome.storage.session.get('readerEngineState'));
    if (state.state === 'error') throw new Error(JSON.stringify(state));
    const { log } = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
    const fresh = log.slice(start);
    return state.state === 'finished' && fresh.some(entry => entry.kind === 'chunk_end' && entry.mediaTime > 0);
  }, { timeout: 240_000 }).toBe(true);
}

async function observeSynthesis(context) {
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:') return;
    globalThis.__cloneJobs = [];
    globalThis.__cloneWavs = [];
    const NativeWorker = Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        const jobs = new Map();
        const post = this.postMessage.bind(this);
        this.postMessage = (message, ...options) => {
          if (message.method === 'synthesize') {
            const { text, lang, speakerId } = message.request;
            const job = { text, lang, speakerId };
            jobs.set(message.id, job);
            globalThis.__cloneJobs.push(job);
          }
          return post(message, ...options);
        };
        this.addEventListener('message', ({ data }) => {
          const job = jobs.get(data.id);
          if (!job || !data.result?.pcm) return;
          const { pcm, sampleRate, speaker } = data.result;
          const energy = pcm.reduce((sum, sample) => sum + sample * sample, 0);
          Object.assign(job, { sampleRate, speaker, rms: Math.sqrt(energy / pcm.length) });
        });
      }
    };
    const createUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      if (blob instanceof Blob && blob.type === 'audio/wav') globalThis.__cloneWavs.push(blob.arrayBuffer());
      return createUrl(blob);
    };
  });
}
