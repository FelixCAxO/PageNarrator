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
cases.push({ ...cases[0], extended: true, paragraphs: [
  ...cases[0].paragraphs,
  'Behind the wall, a narrow stream carried fallen leaves toward a wooden bridge.',
  'We crossed the bridge and watched the water ripple around the smooth grey stones.',
  'On the far bank, a family had spread a picnic blanket beneath a tall green tree.',
  'Their children waved as we passed and pointed to a red kite floating in the sky.',
  'We walked back through the garden and reached our door just before the rain began.',
] });
cases.push({ ...cases.at(-1), paragraphs: [
  ...cases.at(-1).paragraphs,
  'Inside the house, we put our muddy shoes beside the mat and opened the curtains.',
  'The rain tapped gently on the windows while the kettle warmed on the kitchen stove.',
  'I chose two blue cups from the shelf and carried them carefully to the little table.',
  'Through the glass, we could see the garden flowers bending under the falling rain.',
  'A neighbour hurried past with a yellow umbrella and a basket full of fresh apples.',
  'We invited her inside to warm up and found another cup beside the old wooden clock.',
  'She told us about the market and the musicians playing near the station that morning.',
  'After a while, the rain stopped and a patch of sunlight appeared on the kitchen floor.',
  'We opened the back door and listened to the drops falling from the branches outside.',
  'The little bird returned to the fence and shook the water from its silver feathers.',
  'Our neighbour picked up her basket and waved goodbye as she walked down the path.',
  'We stayed at the table for a moment and enjoyed the quiet before starting our day.',
] });
cases.push({ ...cases[1], gender: 'female', recoverStatic: true,
  paragraphs: ['Morgonsolen värmde trädgården när vi öppnade dörren.', ...cases[1].paragraphs.slice(1)] });
for (const whisper of [false, true]) cases.push({ language: 'hi', gender: whisper ? 'male' : 'female', whisper,
  variation: whisper ? 7 : 1, paragraphs: ['नमस्ते! आज हम एक शांत बगीचे के बारे में एक छोटी कहानी पढ़ते हैं।'] });

for (const { language, gender, paragraphs, recoverStatic = false, variation = 1, whisper = false, extended = false } of cases) {
test(`OmniVoice keeps one ${language} ${whisper ? 'whisper ' : ''}speaker through consecutive sentences${recoverStatic ? ' after rejecting static' : ' without synthesis gaps'}${extended ? ` over ${paragraphs.length} paragraphs` : ''}`, async ({}, testInfo) => {
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
      globalThis.__continuity = { jobs: [], wavs: [], runtimeDiagnostics: [], injectedStatic: false };
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
            if (data.result?.main) globalThis.__continuity.runtimeDiagnostics.push(data.result);
            const job = jobs.get(data.id);
            if (!job) return;
            if (data.result?.pcm || data.synthesisProgress) post({ id: -1, method: 'diagnostics' });
            if (data.result?.pcm) job.pcmSha256 = crypto.subtle.digest('SHA-256', data.result.pcm.slice().buffer)
              .then(bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join(''));
            // Corrupt one real worker reply: no static may reach WAV encoding,
            // and recovery must replace the worker while retaining its fixed speaker reference.
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
    const { jobs, wavs, runtimeDiagnostics } = await engine.evaluate(async () => ({ jobs: await Promise.all(globalThis.__continuity.jobs.map(async job => ({ ...job, pcmSha256: await job.pcmSha256 }))),
      runtimeDiagnostics: globalThis.__continuity.runtimeDiagnostics,
      wavs: await Promise.all(globalThis.__continuity.wavs.map(async bytes => Array.from(new Uint8Array(await bytes)))) }));
    const starts = diagnostics.log.filter(entry => entry.kind === 'chunk_play');
    const ends = diagnostics.log.filter(entry => entry.kind === 'chunk_end');
    const gaps = starts.slice(1).map((start, index) => (start.t - ends[index].t) * 1000);
    const report = { language, gender, whisper, variation, recoverStatic, jobs, starts, ends, gaps, diagnostics, runtimeDiagnostics };
    await writeFile(testInfo.outputPath('continuity.json'), JSON.stringify(report, null, 2));
    for (let index = 0; index < wavs.length; index += 1) await writeFile(testInfo.outputPath(`sentence-${index}.wav`), Buffer.from(wavs[index]));
    console.log(`[omnivoice-continuity] ${JSON.stringify({ jobs, gaps })}`);
    expect(jobs.map(job => job.text)).toEqual(recoverStatic ? [paragraphs[0], ...paragraphs] : paragraphs);
    for (let index = 1; index < jobs.length; index++) expect(jobs[index].started).toBeGreaterThanOrEqual(jobs[index - 1].ended);
    const expectedSteps = paragraphs.map(() => 24);
    expect(jobs.map(job => job.numStep)).toEqual(recoverStatic ? [24, ...expectedSteps] : expectedSteps);
    const selectedSeed = 41 + variation;
    expect(jobs.map(job => job.seed)).toEqual(recoverStatic
      ? [selectedSeed, selectedSeed + 1, ...paragraphs.slice(1).map(() => selectedSeed)]
      : paragraphs.map(() => selectedSeed));
    expect(jobs.every(job => job.lang === language)).toBe(true);
    expect(wavs).toHaveLength(paragraphs.length);
    if (recoverStatic) expect(jobs[1].speaker.referenceHash).toBe(jobs[0].speaker.referenceHash);
    expect(ends).toHaveLength(paragraphs.length);
    expect(jobs.every(job => job.audioSeconds > 1)).toBe(true);
    expect(Math.max(...gaps)).toBeLessThan(500);
    const playedJobs = recoverStatic ? jobs.slice(1) : jobs;
    for (const job of playedJobs) {
      expect(job.speaker?.referenceHash).toBe(playedJobs[0].speaker.anchorHash);
      expect(job.speaker?.id).toBe(`${gender}-${variation}`);
    }
  } finally {
    await cleanup();
    await new Promise(resolve => server.close(resolve));
  }
});
}
