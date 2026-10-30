import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { launchExtensionContext, seedRealTtsFlowFlags, startReadFromToolbarPopup } from './extension-fixture.js';
import { openRoutedReaderEngine, routeOmniVoiceModelFiles } from './kokoro-download-fixture.js';
import { processMemorySampler } from '../../scripts/benchmarks/engine-resources.mjs';
import { acquireMeasurementLock } from '../../scripts/weak-hardware/measurement-lock.mjs';
import { longNarrationParagraphs as paragraphs } from './fixtures/long-narration.js';

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test('OmniVoice long narration measures RAM stability and every handoff', async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_OMNIVOICE_LONG !== '1', 'Opt-in real WebGPU narration lasting about fifteen minutes.');
  test.setTimeout(35 * 60_000);
  expect(paragraphs).toHaveLength(180);
  expect(new Set(paragraphs).size).toBe(180);
  expect(paragraphs.every(text => text.length <= 120)).toBe(true);
  const lock = await acquireMeasurementLock({ owner: { purpose: 'Long OmniVoice narration RAM and continuity' },
    maxHoldMs: 35 * 60_000, waitTimeoutMs: 60_000, onWait: holder => console.log(`Waiting for measurement lock held by ${holder.pid}`) });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<html lang="en"><title>Long narration stability</title><article>${paragraphs.map(text => `<p>${text}</p>`).join('')}</article></html>`);
  });
  const ram = [], checkpoints = [], samplerErrors = [];
  let launched, sampler, engine, failure, report;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    launched = await launchExtensionContext({ testInfo, hostPermissions: ['http://127.0.0.1/*'] });
    const { context } = launched;
    await routeOmniVoiceModelFiles(context);
    await context.addInitScript(() => {
      const state = globalThis.__longRead = { jobs: [], resources: [], urls: new Map(), maxAudioUrls: 0, maxAudioBytes: 0, workersCreated: 0, workersTerminated: 0, inFlight: 0, maxInFlight: 0 };
      const NativeWorker = globalThis.Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          const jobs = new Map(), post = this.postMessage.bind(this);
          state.workersCreated++;
          this.postMessage = (message, ...options) => {
            if (message.method === 'synthesize') {
              const job = { id: message.id, text: message.request.text, steps: message.request.numStep, started: Date.now() };
              jobs.set(message.id, job); state.jobs.push(job);
              state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
            }
            return post(message, ...options);
          };
          const terminate = this.terminate.bind(this);
          this.terminate = () => { state.workersTerminated++; return terminate(); };
          this.addEventListener('message', ({ data }) => {
            if (data.result?.main) state.resources.push({ at: Date.now(), ...data.result });
            const job = jobs.get(data.id);
            if (!job || (!data.result?.pcm && !data.error)) return;
            Object.assign(job, { ended: Date.now(), error: data.error, audioSeconds: data.result?.pcm?.length / 24000, timings: data.result?.timings });
            jobs.delete(data.id); state.inFlight--;
            if (state.jobs.length % 10 === 0) post({ id: -1, method: 'diagnostics' });
          });
        }
      };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        const url = create(blob);
        if (blob instanceof Blob && blob.type === 'audio/wav') {
          state.urls.set(url, blob.size);
          state.maxAudioUrls = Math.max(state.maxAudioUrls, state.urls.size);
          state.maxAudioBytes = Math.max(state.maxAudioBytes, [...state.urls.values()].reduce((a, b) => a + b, 0));
        }
        return url;
      };
      URL.revokeObjectURL = url => { state.urls.delete(url); return revoke(url); };
    });
    await seedRealTtsFlowFlags(context, { playbackSettings: { ttsEngine: 'omnivoice', language: 'en', voice: 'af_heart', speed: 1, sectionPauseSeconds: 0,
      omniVoice: { gender: 'female', variation: 1, whisper: false } } });
    engine = await openRoutedReaderEngine(context);
    const browserCdp = await context.browser().newBrowserCDPSession(), renderer = await context.newCDPSession(engine);
    const rootPid = (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo.find(process => process.type === 'browser').id;
    const samplerCode = processMemorySampler.replace('time.sleep(max(0,.1-', 'time.sleep(max(0,2-');
    sampler = spawn('python', ['-u', '-c', samplerCode, String(rootPid), testInfo.outputPath('browser-pids.json')], { windowsHide: true });
    let pending = '';
    sampler.stdout.on('data', bytes => {
      pending += bytes; const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const sample = JSON.parse(line);
        sample.privateBytes = sample.processes.reduce((sum, process) => sum + process.private, 0);
        sample.uniqueResidentBytes = sample.processes.reduce((sum, process) => sum + process.uss, 0);
        ram.push(sample); appendFileSync(testInfo.outputPath('ram.jsonl'), `${JSON.stringify(sample)}\n`);
      }
    });
    sampler.stderr.on('data', bytes => samplerErrors.push(String(bytes)));
    const article = await context.newPage(); await article.goto(`http://127.0.0.1:${server.address().port}/`);
    const worker = context.serviceWorkers()[0], started = Date.now();
    await startReadFromToolbarPopup(context, article);
    let nextProgress = started;
    while (Date.now() - started < 30 * 60_000) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const readingState = await worker.evaluate(() => chrome.storage.session.get('readerEngineState').then(result => result.readerEngineState));
      const checkpoint = await engine.evaluate(() => {
        const log = globalThis.__pnFlowLog || [], starts = log.filter(e => e.kind === 'chunk_play'), ends = log.filter(e => e.kind === 'chunk_end');
        const gaps = starts.slice(1).map((start, index) => (start.t - ends[index].t) * 1000);
        return { at: Date.now(), played: starts.length, completed: ends.length, synthesisCompleted: __longRead.jobs.filter(job => job.ended).length,
          liveAudioUrls: __longRead.urls.size, liveAudioBytes: [...__longRead.urls.values()].reduce((a, b) => a + b, 0), maxGapMs: Math.max(0, ...gaps),
          lastGapMs: gaps.at(-1) ?? 0 };
      });
      checkpoint.readingState = readingState?.state;
      if (checkpoints.length % 5 === 0) checkpoint.heap = await renderer.send('Runtime.getHeapUsage');
      checkpoints.push(checkpoint);
      if (Date.now() >= nextProgress) {
        const progress = { elapsedSeconds: Math.round((Date.now() - started) / 1000), ...checkpoint,
          privateMiB: ram.at(-1)?.privateBytes / 1048576, residentMiB: ram.at(-1)?.uniqueResidentBytes / 1048576 };
        console.log(`[long-read-progress] ${JSON.stringify(progress)}`);
        await writeFile(testInfo.outputPath('progress.json'), JSON.stringify(progress, null, 2));
        nextProgress = Date.now() + 30_000;
      }
      if (readingState?.state === 'error') throw new Error(JSON.stringify(readingState));
      if (readingState?.state === 'finished') break;
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
    const diagnostics = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
    const telemetry = await engine.evaluate(() => ({ ...__longRead, urls: [...__longRead.urls] }));
    const log = diagnostics.log, starts = log.filter(e => e.kind === 'chunk_play'), ends = log.filter(e => e.kind === 'chunk_end');
    const gaps = starts.slice(1).map((start, index) => ({ from: ends[index].chunkIndex, to: start.chunkIndex, milliseconds: (start.t - ends[index].t) * 1000 }));
    const warmed = checkpoints.filter(c => c.completed >= 30 && c.completed < paragraphs.length - 2);
    const warmRam = ram.filter(sample => warmed.length && sample.at >= warmed[0].at && sample.at <= warmed.at(-1).at);
    const first = warmRam.filter(sample => sample.at <= warmRam[0]?.at + 60_000), last = warmRam.filter(sample => sample.at >= warmRam.at(-1)?.at - 60_000);
    report = { startedAt: started, finishedAt: Date.now(), browserVersion: context.browser().version(), paragraphs: paragraphs.length,
      audioSeconds: telemetry.jobs.reduce((sum, job) => sum + (job.audioSeconds || 0), 0), telemetry, checkpoints, gaps,
      maxGapMs: Math.max(0, ...gaps.map(gap => gap.milliseconds)), gapsOver500Ms: gaps.filter(gap => gap.milliseconds >= 500),
      memory: { samples: ram.length, warmSamples: warmRam.length,
        firstWarmPrivateMiB: median(first.map(s => s.privateBytes)) / 1048576, lastWarmPrivateMiB: median(last.map(s => s.privateBytes)) / 1048576,
        firstWarmResidentMiB: median(first.map(s => s.uniqueResidentBytes)) / 1048576, lastWarmResidentMiB: median(last.map(s => s.uniqueResidentBytes)) / 1048576,
        warmPeakPrivateMiB: Math.max(...warmRam.map(s => s.privateBytes)) / 1048576 },
      samplerErrors, diagnostics,
      method: 'Real extension, pinned OmniVoice, normal speed, one loaded model, four chunks of lookahead. No historical PCM/WAV capture. Browser-process-tree private committed and unique resident RAM every two seconds; first 30 completed chunks excluded from warm memory comparison. No forced GC during playback.' };
    await writeFile(testInfo.outputPath('long-read-report.json'), JSON.stringify(report, null, 2));
    console.log(`[long-read-result] ${JSON.stringify({ audioSeconds: report.audioSeconds, maxGapMs: report.maxGapMs, gapsOver500Ms: report.gapsOver500Ms.length, memory: report.memory, maxAudioUrls: telemetry.maxAudioUrls })}`);
    expect(telemetry.jobs.map(job => job.text)).toEqual(paragraphs);
    expect(starts).toHaveLength(paragraphs.length); expect(ends).toHaveLength(paragraphs.length);
    expect(telemetry.jobs.every(job => job.steps === 24 && !job.error)).toBe(true);
    expect(telemetry.maxInFlight).toBe(1); expect(telemetry.workersCreated).toBe(1);
    expect(telemetry.maxAudioUrls).toBeLessThanOrEqual(5); expect(telemetry.urls).toEqual([]);
    expect(report.audioSeconds).toBeGreaterThan(600); expect(warmRam.length).toBeGreaterThan(100);
    expect(samplerErrors).toEqual([]); expect(ram.every(sample => sample.errors.length === 0)).toBe(true);
    // Compare warm one-minute medians, allowing normal allocator and working-set variation.
    for (const metric of ['Private', 'Resident']) {
      const firstMiB = report.memory[`firstWarm${metric}MiB`], lastMiB = report.memory[`lastWarm${metric}MiB`];
      expect(lastMiB - firstMiB).toBeLessThanOrEqual(Math.max(64, firstMiB * .05));
    }
    expect(report.maxGapMs).toBeLessThan(500);
  } catch (error) { failure = error; throw error; }
  finally {
    sampler?.kill();
    await writeFile(testInfo.outputPath('checkpoints.json'), JSON.stringify({ failure: failure?.stack, checkpoints, samplerErrors }, null, 2));
    await launched?.cleanup();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    lock.release();
  }
});
