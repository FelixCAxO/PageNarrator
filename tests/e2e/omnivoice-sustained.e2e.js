import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchExtensionContext, openExtensionPage, seedHardwareProfile, startReadFromToolbarPopup } from './extension-fixture.js';
import { openRoutedReaderEngine, routeOmniVoiceModelFiles } from './kokoro-download-fixture.js';
import { installSilentOutputCapture } from './silent-output-capture.js';
import { ensureMeasurementLock } from '../../tooling/scripts/weak-hardware/measurement-lock.mjs';
import { hashDirectory } from '../../tooling/scripts/weak-hardware/run-provenance.mjs';
import { browserAdapterConfiguration, verifyBrowserAdapter } from '../../tooling/scripts/lib/browser-adapter.mjs';
import { resolveSustainedPlaybackConfig, scoreSustainedPlayback, summarizeSustainedMemory } from '../../tooling/scripts/weak-hardware/sustained-playback.mjs';
import { installSustainedEvidence } from './fixtures/sustained-omnivoice.js';

test('OmniVoice sustains real playback within a browser commit limit', async () => {
  test.skip(process.env.PN_E2E_SUSTAINED_OV !== '1', 'Explicit real-model memory-ceiling soak; physical output stays muted.');
  const config = resolveSustainedPlaybackConfig(process.env);
  const { minutes, commitGiB, browserCommitBytes } = config;
  test.setTimeout(config.timeoutMs);
  const root = path.resolve(process.env.PN_SUSTAINED_OUTPUT || 'artifacts/omnivoice-sustained');
  await mkdir(root, { recursive: true });
  const extensionPath = path.resolve(process.env.PN_SUSTAINED_EXTENSION_DIR || process.env.PN_E2E_EXTENSION_DIR || 'dist');
  const packageHash = await hashDirectory(extensionPath);
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({ ...config, extensionPath, packageHash,
    adapterConfiguration: browserAdapterConfiguration(), node: process.version, started: new Date().toISOString() }, null, 2), { flag: 'wx' });
  const lock = await ensureMeasurementLock({ owner: { purpose: `Muted ${minutes}-minute OmniVoice read within a browser memory ceiling` } });
  const passages = [
    'The morning sun warmed the garden as we opened the door and stepped outside. We followed the quiet path toward the trees, stopped beside the old stone wall, and listened to the water flowing slowly beneath the wooden bridge.',
    'Beyond the bridge, the river moved slowly past a field of bright yellow flowers. We sat beneath the branches for a while and talked about our plans before the clouds gathered and we walked home to make a pot of warm tea.',
    'A small bird landed on the wooden fence and sang softly in the fresh air. The light changed as the wind moved through the trees. We packed a basket with bread and fruit before setting off to explore the path along the river.',
    'We returned to the house before evening and put our coats beside the door. Through the kitchen window we could see the hills and the last of the afternoon light. Everyone sat down at the table to share a meal and talk about the day.',
    'We stopped. A bird sang.',
    'After a short rest we packed our bags and started walking again. The path climbed above the fields and the houses became smaller behind us. We could hear a bell from the village as the clouds moved across the sun. At the top of the hill we found a place to sit and shared the last of our bread before continuing toward the forest.',
    'The rain passed.',
    'In the afternoon we reached the edge of the forest, where the trees opened onto a quiet lake. A narrow track followed the shore past several wooden boats. We watched a family of ducks cross the water and waited until the wind had settled before taking the track toward the next village. The sky was clear by the time we arrived.',
  ];
  const server = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<html lang="en"><title>A long walking journal</title><article>${Array.from({ length: config.paragraphs }, (_, i) => `<p>On day ${i + 1} of our journey, we wrote the following account. ${passages[i % passages.length]}</p>`).join('')}</article></html>`);
  });
  let launched, timer, capture, engine, worker, evidence, captureFinished = false;
  const accounting = [], errors = [];
  const covered = query => query.browserProcesses.length > 0 && query.browserProcesses.every(p => p.inJob === true || p.listedInJob && p.openError === 87);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    launched = await launchExtensionContext({ extensionDir: extensionPath,
      hostPermissions: ['http://127.0.0.1/*'], browserCommitBytes });
    const { context, jobSupervisor, extensionDir } = launched;
    console.log(`Browser memory ceiling: ${commitGiB} GiB.`);
    await routeOmniVoiceModelFiles(context);
    capture = await installSilentOutputCapture(context, extensionDir, { outputPath: path.join(root, 'output.wav') });
    evidence = await installSustainedEvidence(context, root);
    await seedHardwareProfile(context, { name: 'sustained-with-commit-limit', navigator: {}, playbackSettings: {
      ttsEngine: 'omnivoice', language: 'en', voice: 'af_heart', speed: 1, sectionPauseSeconds: 0, ttsPerformanceProfile: 'quality',
      omniVoice: { gender: 'female', variation: 1, whisper: false },
    } }, { enableProbe: true, recordFlow: true });
    engine = await openRoutedReaderEngine(context); worker = context.serviceWorkers()[0];
    console.log('Reader engine ready.');
    const timeOrigin = await engine.evaluate(() => performance.timeOrigin);
    const adapter = await engine.evaluate(async () => {
      const gpu = await navigator.gpu.requestAdapter();
      return { vendor: gpu?.info?.vendor, architecture: gpu?.info?.architecture, description: gpu?.info?.description,
        features: [...(gpu?.features || [])] };
    });
    verifyBrowserAdapter(adapter, browserAdapterConfiguration());
    expect(adapter.features).toContain('shader-f16');
    await writeFile(path.join(root, 'adapter.json'), JSON.stringify(adapter, null, 2));
    await engine.evaluate(() => __silentCaptureReady);
    // Preserve startup inventory separately; transient renderers may exit during its WMI scan.
    await writeFile(path.join(root, 'startup-inventory.json'), JSON.stringify(await jobSupervisor.query(), null, 2));
    const sample = async () => { try { accounting.push({ at: Date.now(), ...await jobSupervisor.query() }); } catch (error) { errors.push(String(error)); } };
    await sample();
    expect(accounting).toHaveLength(1);
    expect(accounting.every(covered)).toBe(true);
    console.log('Memory accounting ready.');
    timer = setInterval(() => { void sample(); }, 5_000);
    const log = async () => (await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }))).log;
    // Poll compact progress; retain the full word/source log in the reader until final export.
    const progress = () => engine.evaluate(() => {
      const events = globalThis.__pnFlowLog || [], starts = events.filter(e => e.kind === 'chunk_play'), ends = events.filter(e => e.kind === 'chunk_end');
      return { completedSections: ends.length, completedSeconds: ends.length && starts.length ? ends.at(-1).t - starts[0].t : 0,
        failed: events.some(e => /synthesis_failed|browser_voice_fallback/.test(e.kind)), clipError: globalThis.__sustained.clipError };
    });
    const article = await context.newPage(); await article.goto(`http://127.0.0.1:${server.address().port}/`);
    await startReadFromToolbarPopup(context, article, { fromStart: true });
    console.log('Toolbar read requested.');
    await expect.poll(async () => (await log()).filter(e => e.kind === 'chunk_play').length, { timeout: 120_000 }).toBeGreaterThan(0);
    const started = Date.now();
    console.log('First real audio chunk playing.');
    for (let minute = 1; minute <= minutes; minute++) {
      await expect.poll(async () => {
        const observed = await progress();
        expect(observed.failed).toBe(false);
        expect(observed.clipError).toBeNull();
        return Date.now() - started;
      }, { timeout: 65_000, intervals: [1000] }).toBeGreaterThanOrEqual(minute * 60_000);
      console.log(`Sustained ${minute} minute(s): ${(await progress()).completedSections} completed chunks.`);
    }
    // End on a real section boundary rather than assuming the current section is at most 20 s long.
    // Keep this final boundary wait bounded separately from the required playback window.
    await expect.poll(async () => {
      const observed = await progress();
      expect(observed.failed).toBe(false);
      expect(observed.clipError).toBeNull();
      return observed.completedSeconds;
    }, { timeout: 120_000, intervals: [1000] }).toBeGreaterThanOrEqual(minutes * 60);
    const diagnostics = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
    const playback = scoreSustainedPlayback(diagnostics.log, config);
    await sample();
    clearInterval(timer);
    await writeFile(path.join(root, 'playback-accounting.json'), JSON.stringify({ browserCommitBytes, requestedMinutes: minutes, elapsedMs: Date.now() - started,
      accounting, errors, playback, memory: summarizeSustainedMemory(accounting, started),
      browserVersion: context.browser().version(), scope: 'Windows browser-job commit ceiling on development hardware; not an 8 GiB physical-machine qualification.' }, null, 2));
    // Stop closes the reader AudioContext, so flush the live render thread first.
    await capture.finish(engine);
    captureFinished = true;
    const controls = await openExtensionPage(context, 'popup'); await controls.locator('#popup-stop').click();
    await expect(controls.locator('#popup-status')).toHaveText('Ready to read', { timeout: 30_000 });
    const speech = await evidence.finish(engine);
    await writeFile(path.join(root, 'flow.json'), JSON.stringify({ diagnostics, speech, clips: evidence.clips, timeOrigin, packageHash }, null, 2));
    expect(playback.reasons).toEqual([]);
    expect(speech.clipError).toBeNull();
    expect(evidence.clips.length).toBeGreaterThanOrEqual(playback.completedSections);
    const completedJobs = speech.jobs.filter(job => job.frames > 0);
    expect(completedJobs.length).toBeGreaterThanOrEqual(playback.completedSections);
    expect(completedJobs.every(job => job.lang === 'en' && job.speakerId === 'female-1'
      && job.speaker?.id === 'female-1' && job.speaker?.referenceHash === completedJobs[0].speaker.anchorHash)).toBe(true);
    expect(speech.runtime?.main?.gpuWeightBytes).toBeGreaterThan(0);
    expect(speech.runtime?.decoder?.gpuWeightBytes).toBeGreaterThan(0);
    expect(accounting.every(query => Number(query.limits.jobMemoryLimitBytes) === browserCommitBytes)).toBe(true);
    expect(accounting.every(query => Number(query.limits.peakJobMemoryUsedBytes) <= browserCommitBytes)).toBe(true);
    expect(accounting.every(covered)).toBe(true);
    expect(errors).toEqual([]);
    await writeFile(path.join(root, 'result.json'), JSON.stringify({ passed: true, playback, packageHash, durationScope: config.durationScope,
      stopped: true, memory: summarizeSustainedMemory(accounting, started) }, null, 2), { flag: 'wx' });
  } finally {
    clearInterval(timer);
    // Preserve partial evidence when a mid-run assertion fails; no failed attempt gets a pass receipt.
    try {
      if (worker) await writeFile(path.join(root, 'flow-final.json'), JSON.stringify(await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' })), null, 2));
      if (engine && evidence) await writeFile(path.join(root, 'speech-final.json'), JSON.stringify(await evidence.finish(engine), null, 2));
      if (engine && capture && !captureFinished) await capture.finish(engine);
    } catch (error) { errors.push(`Final evidence incomplete: ${String(error)}`); }
    await writeFile(path.join(root, 'accounting-final.json'), JSON.stringify({ accounting, errors }, null, 2));
    try { await capture?.close(); }
    finally {
      try { await launched?.cleanup(); }
      finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); lock.release(); }
    }
  }
});
