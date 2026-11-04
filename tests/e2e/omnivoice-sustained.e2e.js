import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchExtensionContext, openExtensionPage, seedHardwareProfile, startReadFromToolbarPopup } from './extension-fixture.js';
import { openRoutedReaderEngine, routeOmniVoiceModelFiles } from './kokoro-download-fixture.js';
import { installSilentOutputCapture } from './silent-output-capture.js';
import { ensureMeasurementLock } from '../../tooling/scripts/weak-hardware/measurement-lock.mjs';

test('OmniVoice sustains real playback within a browser commit limit', async () => {
  test.skip(process.env.PN_E2E_SUSTAINED_OV !== '1', 'Explicit real-model memory-ceiling soak; physical output stays muted.');
  const minutes = Number(process.env.PN_SUSTAINED_MINUTES || 5);
  expect(Number.isInteger(minutes) && minutes >= 1 && minutes <= 10).toBe(true);
  test.setTimeout((minutes + 3) * 60_000);
  const root = path.resolve(process.env.PN_SUSTAINED_OUTPUT || 'artifacts/omnivoice-sustained');
  const commitGiB = Number(process.env.PN_SUSTAINED_COMMIT_GIB || 6), browserCommitBytes = commitGiB * 1024 ** 3;
  expect(Number.isSafeInteger(browserCommitBytes) && commitGiB >= 2 && commitGiB <= 8).toBe(true);
  await mkdir(root, { recursive: true });
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
    response.end(`<html lang="en"><title>A long walking journal</title><article>${Array.from({ length: 60 }, (_, i) => `<p>On day ${i + 1} of our journey, we wrote the following account. ${passages[i % passages.length]}</p>`).join('')}</article></html>`);
  });
  let launched, timer, capture;
  const accounting = [], errors = [];
  const covered = query => query.browserProcesses.length > 0 && query.browserProcesses.every(p => p.inJob === true || p.listedInJob && p.openError === 87);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    launched = await launchExtensionContext({ extensionDir: process.env.PN_SUSTAINED_EXTENSION_DIR || 'dist',
      hostPermissions: ['http://127.0.0.1/*'], browserCommitBytes });
    const { context, jobSupervisor, extensionDir } = launched;
    console.log(`Browser memory ceiling: ${commitGiB} GiB.`);
    await routeOmniVoiceModelFiles(context);
    capture = await installSilentOutputCapture(context, extensionDir, { outputPath: path.join(root, 'output.wav') });
    await context.addInitScript(() => {
      const blobs = new Map(), played = new Set(); globalThis.__outputClips = [];
      const create = URL.createObjectURL.bind(URL), play = HTMLMediaElement.prototype.play;
      URL.createObjectURL = blob => { const url = create(blob); if (blob.type === 'audio/wav') blobs.set(url, blob); return url; };
      HTMLMediaElement.prototype.play = function (...args) {
        const url = this.currentSrc || this.src;
        if (blobs.has(url) && !played.has(url)) {
          played.add(url); globalThis.__outputClips.push({ bytes: blobs.get(url).arrayBuffer(), rate: this.playbackRate, at: Date.now() });
        }
        return play.apply(this, args);
      };
    });
    await seedHardwareProfile(context, { name: 'sustained-with-commit-limit', navigator: {}, playbackSettings: {
      ttsEngine: 'omnivoice', language: 'en', voice: 'af_heart', speed: 1, sectionPauseSeconds: 0, ttsPerformanceProfile: 'quality',
      omniVoice: { gender: 'female', variation: 1, whisper: false },
    } }, { enableProbe: true, recordFlow: true });
    const engine = await openRoutedReaderEngine(context), worker = context.serviceWorkers()[0];
    console.log('Reader engine ready.');
    const timeOrigin = await engine.evaluate(() => performance.timeOrigin);
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
    const article = await context.newPage(); await article.goto(`http://127.0.0.1:${server.address().port}/`);
    await startReadFromToolbarPopup(context, article);
    console.log('Toolbar read requested.');
    await expect.poll(async () => (await log()).filter(e => e.kind === 'chunk_play').length, { timeout: 120_000 }).toBeGreaterThan(0);
    const started = Date.now();
    console.log('First real audio chunk playing.');
    for (let minute = 1; minute <= minutes; minute++) {
      await expect.poll(async () => {
        const events = await log();
        expect(events.some(e => /synthesis_failed|browser_voice_fallback/.test(e.kind))).toBe(false);
        return Date.now() - started;
      }, { timeout: 65_000, intervals: [1000] }).toBeGreaterThanOrEqual(minute * 60_000);
      const events = await log();
      console.log(`Sustained ${minute} minute(s): ${events.filter(e => e.kind === 'chunk_end').length} completed chunks.`);
    }
    const diagnostics = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
    const starts = diagnostics.log.filter(e => e.kind === 'chunk_play'), ends = diagnostics.log.filter(e => e.kind === 'chunk_end');
    expect(ends.length).toBeGreaterThan(5);
    expect(ends.at(-1).t - starts[0].t).toBeGreaterThanOrEqual(minutes * 60 - 20);
    expect(ends.map(e => e.chunkIndex)).toEqual(Array.from({ length: ends.length }, (_, i) => i + ends[0].chunkIndex));
    const gaps = ends.flatMap(end => {
      const next = starts.find(start => start.chunkIndex === end.chunkIndex + 1);
      if (!next) return [];
      const decoded = diagnostics.log.find(e => e.kind === 'audio_preload_decode_latency' && e.chunkIndex === next.chunkIndex && e.t <= end.t);
      return [{ chunkIndex: next.chunkIndex, milliseconds: 1000 * (next.t - end.t), ready: Boolean(decoded) }];
    });
    await sample();
    await writeFile(path.join(root, 'playback-accounting.json'), JSON.stringify({ browserCommitBytes, requestedMinutes: minutes, elapsedMs: Date.now() - started,
      accounting, errors, gaps, browserVersion: context.browser().version(), scope: 'Windows browser-job commit ceiling on development hardware; not an 8 GiB physical-machine qualification.' }, null, 2));
    const clips = await engine.evaluate(() => __outputClips.map(({ bytes: _bytes, ...clip }) => clip));
    await writeFile(path.join(root, 'flow.json'), JSON.stringify({ diagnostics, clips, timeOrigin }, null, 2));
    // Numeric CDP arrays and trace copies can exceed the memory ceiling; export one encoded clip at a time.
    for (let index = 0; index < clips.length; index++) {
      const base64 = await engine.evaluate(async index => {
        const bytes = new Uint8Array(await __outputClips[index].bytes);
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
        return btoa(binary);
      }, index);
      await writeFile(path.join(root, `clip-${index}.wav`), Buffer.from(base64, 'base64'));
    }
    await capture.finish(engine);
    expect(gaps.every(gap => gap.ready && gap.milliseconds >= 0 && gap.milliseconds <= 100)).toBe(true);
    expect(accounting.every(query => Number(query.limits.jobMemoryLimitBytes) === browserCommitBytes)).toBe(true);
    expect(accounting.every(query => Number(query.limits.peakJobMemoryUsedBytes) <= browserCommitBytes)).toBe(true);
    expect(accounting.every(covered)).toBe(true);
    expect(errors).toEqual([]);
    const controls = await openExtensionPage(context, 'popup'); await controls.locator('#popup-stop').click();
    await expect(controls.locator('#popup-status')).toHaveText('Ready to read', { timeout: 30_000 });
  } finally {
    clearInterval(timer);
    await writeFile(path.join(root, 'accounting-final.json'), JSON.stringify({ accounting, errors }, null, 2));
    try { await capture?.close(); }
    finally {
      try { await launched?.cleanup(); }
      finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); lock.release(); }
    }
  }
});
