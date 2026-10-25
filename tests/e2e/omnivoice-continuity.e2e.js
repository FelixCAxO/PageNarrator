import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { launchExtensionContext, seedRealTtsFlowFlags, startReadFromToolbarPopup } from './extension-fixture.js';
import { openRoutedReaderEngine, routeOmniVoiceModelFiles } from './kokoro-download-fixture.js';

const cases = [
  { language: 'en', gender: 'female', paragraphs: [
    'The morning sun warmed the garden as we opened the door and stepped outside.',
    'A small bird landed on the wooden fence and sang softly in the fresh air.',
    'We followed the quiet path toward the trees and stopped beside the old stone wall.',
  ] },
  { language: 'sv', gender: 'male', paragraphs: [
    'Morgonsolen värmde trädgården när vi öppnade dörren och gick ut i den friska luften.',
    'En liten fågel landade på staketet och sjöng medan vinden rörde sig genom träden.',
    'Vi följde den lugna stigen och stannade en stund för att lyssna på vattnet vid bron.',
  ] },
];
cases.push({ ...cases[1], gender: 'female', recoverStatic: true,
  paragraphs: ['Morgonsolen värmde trädgården när vi öppnade dörren.', ...cases[1].paragraphs.slice(1)] });
for (const whisper of [false, true]) cases.push({ language: 'hi', gender: whisper ? 'male' : 'female', whisper,
  variation: whisper ? 7 : 1, paragraphs: ['नमस्ते! आज हम एक शांत बगीचे के बारे में एक छोटी कहानी पढ़ते हैं।'] });

for (const { language, gender, paragraphs, recoverStatic = false, variation = 1, whisper = false } of cases) {
test(`OmniVoice keeps one ${language} ${whisper ? 'whisper ' : ''}speaker through consecutive sentences${recoverStatic ? ' after rejecting static' : ' without synthesis gaps'}`, async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_OMNIVOICE !== '1', 'Requires pinned OmniVoice models and native WebGPU.');
  test.setTimeout(5 * 60_000);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<html lang="${language}"><title>Continuous narration</title><article>${paragraphs.map(text => `<p>${text}</p>`).join('')}</article></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { context, cleanup } = await launchExtensionContext({ testInfo, hostPermissions: ['http://127.0.0.1/*'] });
  let engine;
  try {
    await routeOmniVoiceModelFiles(context);
    await context.addInitScript(({ recoverStatic }) => {
      globalThis.__continuity = { jobs: [], wavs: [], injectedStatic: false };
      const NativeWorker = globalThis.Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          const jobs = new Map();
          const post = this.postMessage.bind(this);
          this.postMessage = (message, ...options) => {
            if (message.method === 'synthesize') {
              const job = { id: message.id, ...message.request, started: Date.now() };
              jobs.set(message.id, job);
              globalThis.__continuity.jobs.push(job);
            }
            return post(message, ...options);
          };
          this.addEventListener('message', ({ data }) => {
            const job = jobs.get(data.id);
            if (!job) return;
            if (data.result?.pcm) job.pcmSha256 = crypto.subtle.digest('SHA-256', data.result.pcm.slice().buffer)
              .then(bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join(''));
            // Corrupt one real worker reply: no static may reach WAV encoding,
            // and recovery must replace the worker and its speaker reference.
            if (recoverStatic && data.result?.pcm && !globalThis.__continuity.injectedStatic) {
              globalThis.__continuity.injectedStatic = true;
              job.rejectedStaticInjection = true;
              data.result.pcm.fill(1);
            }
            Object.assign(job, { ended: Date.now(), error: data.error,
              audioSeconds: data.result?.pcm?.length / 24000, speaker: data.result?.speaker, timings: data.result?.timings });
          });
        }
      };
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        if (blob instanceof Blob && blob.type === 'audio/wav') globalThis.__continuity.wavs.push(blob.arrayBuffer());
        return create(blob);
      };
    }, { recoverStatic });
    await seedRealTtsFlowFlags(context, { playbackSettings: {
      ttsEngine: 'omnivoice', language, voice: 'af_heart', speed: 1, sectionPauseSeconds: 0,
      omniVoice: { gender, variation, whisper },
    } });
    engine = await openRoutedReaderEngine(context);
    const article = await context.newPage();
    await article.goto(`http://127.0.0.1:${server.address().port}/`);
    await startReadFromToolbarPopup(context, article);
    const worker = context.serviceWorkers()[0];
    await expect.poll(async () => {
      const { readerEngineState: state = {} } = await worker.evaluate(() => chrome.storage.session.get('readerEngineState'));
      if (state.state === 'error') throw new Error(JSON.stringify(state));
      return state.state;
    }, { timeout: 240_000 }).toBe('finished');
    const diagnostics = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
    const { jobs, wavs } = await engine.evaluate(async () => ({ jobs: await Promise.all(globalThis.__continuity.jobs.map(async job => ({ ...job, pcmSha256: await job.pcmSha256 }))),
      wavs: await Promise.all(globalThis.__continuity.wavs.map(async bytes => Array.from(new Uint8Array(await bytes)))) }));
    const starts = diagnostics.log.filter(entry => entry.kind === 'chunk_play');
    const ends = diagnostics.log.filter(entry => entry.kind === 'chunk_end');
    const gaps = starts.slice(1).map((start, index) => (start.t - ends[index].t) * 1000);
    const report = { language, gender, whisper, variation, recoverStatic, jobs, starts, ends, gaps, diagnostics };
    await writeFile(testInfo.outputPath('continuity.json'), JSON.stringify(report, null, 2));
    for (let index = 0; index < wavs.length; index += 1) await writeFile(testInfo.outputPath(`sentence-${index}.wav`), Buffer.from(wavs[index]));
    console.log(`[omnivoice-continuity] ${JSON.stringify({ jobs, gaps })}`);
    expect(jobs.map(job => job.text)).toEqual(recoverStatic ? [paragraphs[0], ...paragraphs] : paragraphs);
    const expectedSteps = [24, ...paragraphs.slice(1).map(() => 12)];
    expect(jobs.map(job => job.numStep)).toEqual(recoverStatic ? [24, ...expectedSteps] : expectedSteps);
    const selectedSeed = 41 + variation;
    expect(jobs.map(job => job.seed)).toEqual(recoverStatic
      ? [selectedSeed, ...paragraphs.map(() => selectedSeed + 1)]
      : paragraphs.map(() => selectedSeed));
    expect(jobs.every(job => job.lang === language)).toBe(true);
    expect(wavs).toHaveLength(paragraphs.length);
    if (recoverStatic) expect(jobs[1].pcmSha256).not.toBe(jobs[0].pcmSha256);
    expect(ends).toHaveLength(paragraphs.length);
    expect(jobs.every(job => job.audioSeconds > 1)).toBe(true);
    expect(Math.max(...gaps)).toBeLessThan(500);
    const playedJobs = recoverStatic ? jobs.slice(1) : jobs;
    for (const job of playedJobs.slice(1)) expect(job.speaker?.referenceHash).toBe(playedJobs[0].speaker.anchorHash);
  } finally {
    await cleanup();
    await new Promise(resolve => server.close(resolve));
  }
});
}
