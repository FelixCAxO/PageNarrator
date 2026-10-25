import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchExtensionContext, openExtensionPage, seedHardwareProfile, startReadFromToolbarPopup } from './extension-fixture.js';
import { selectNativeOption, setNativeRange } from './native-controls-fixture.js';
import { openRoutedReaderEngine, routeKokoroModelFiles, routeOmniVoiceModelFiles } from './kokoro-download-fixture.js';
import { acquireMeasurementLock } from '../../scripts/weak-hardware/measurement-lock.mjs';
import { processMemorySampler, gpuSampler } from '../../scripts/benchmarks/engine-resources.mjs';
import { installSilentOutputCapture } from './silent-output-capture.js';

for (const initial of ['kokoro', 'omnivoice']) test(`real audio stays continuous through ${initial} and both engine switches`, async () => {
  test.skip(process.env.PN_E2E_ENGINE_HANDOFF !== '1', 'Requires native WebGPU models. Playback remains muted.');
  test.setTimeout(5 * 60_000);
  const root = path.resolve('artifacts/omnivoice-memory/silent-handoff', initial);
  await mkdir(root, { recursive: true });
  const lock = await acquireMeasurementLock({ owner: { purpose: 'Muted real speech engine handoff verification' } });
  const paragraphs = Array.from({ length: 22 }, (_, i) => [
    'The bird is singing.',
    'The morning sun warmed the garden as we opened the door and stepped outside. We followed the quiet path toward the trees, stopped beside the old stone wall, and listened to the water flowing slowly beneath the wooden bridge.',
    'We stopped to listen.',
    'Beyond the bridge, the river moved slowly past a field of bright yellow flowers. We sat beneath the branches for a while and talked about our plans before the clouds gathered and we walked home to make a pot of warm tea.',
  ][i % 4]);
  const server = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<html lang="en"><title>Handoff verification</title><article>${paragraphs.map(p => `<p>${p}</p>`).join('')}</article></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { context, cleanup, extensionDir: instrumentedExtensionDir } = await launchExtensionContext({ extensionDir: process.env.PN_HANDOFF_EXTENSION_DIR || 'dist', hostPermissions: ['http://127.0.0.1/*'] });
  const monitors = [], resources = { ram: [], gpu: [], errors: [] };
  const stopFile = path.join(root, `capture-stop-${Date.now()}`);
  try {
    await routeKokoroModelFiles(context); await routeOmniVoiceModelFiles(context);
    await installSilentOutputCapture(context, instrumentedExtensionDir);
    await context.addInitScript(() => {
      const blobs = new Map(), played = new Set(); globalThis.__outputClips = [];
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { const url = create(blob); if (blob.type === 'audio/wav') blobs.set(url, blob); return url; };
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        globalThis.__currentOutputAudio = this;
        const url = this.currentSrc || this.src;
        if (blobs.has(url) && !played.has(url)) {
          played.add(url); globalThis.__outputClips.push({ bytes: blobs.get(url).arrayBuffer(), rate: this.playbackRate, at: Date.now() });
        }
        return play.apply(this, args);
      };
    });
    await seedHardwareProfile(context, { name: 'continuous-handoff', navigator: {}, playbackSettings: {
      ttsEngine: initial, language: 'en', voice: 'af_heart', speed: 1, sectionPauseSeconds: 0, ttsPerformanceProfile: 'quality',
      omniVoice: { gender: 'female', variation: 1, whisper: false },
    } }, { enableProbe: true, recordFlow: true });
    const engine = await openRoutedReaderEngine(context), worker = context.serviceWorkers()[0];
    await engine.evaluate(() => __silentCaptureReady);
    const cdp = await context.browser().newBrowserCDPSession();
    resources.rootPid = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser').id;
    const pids = path.join(root, 'pids.json');
    await writeFile(pids, JSON.stringify([resources.rootPid]));
    await writeFile(path.join(root, 'gpu-sampler.ps1'), gpuSampler);
    const monitor = (command, args, records) => {
      const child = spawn(command, args, { windowsHide: true }); monitors.push(child);
      let pending = '';
      child.stdout.on('data', bytes => {
        pending += bytes; const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines.filter(Boolean)) records.push(JSON.parse(line));
      });
      child.stderr.on('data', bytes => resources.errors.push(String(bytes)));
    };
    monitor('python', ['-u', '-c', processMemorySampler, String(resources.rootPid), pids], resources.ram);
    monitor('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'gpu-sampler.ps1'),
      '-Source', path.resolve('scripts/weak-hardware/windows-job-supervisor.cs'), '-Pids', pids, '-StopFile', stopFile], resources.gpu);
    const log = async () => (await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }))).log;
    // Physical output is muted. These traces verify scheduling, not acoustic loopback gaps.
    const article = await context.newPage(); await article.goto(`http://127.0.0.1:${server.address().port}/`);
    await startReadFromToolbarPopup(context, article);
    await expect.poll(async () => (await log()).filter(e => e.kind === 'chunk_play').length, { timeout: 120_000 }).toBeGreaterThanOrEqual(1);
    const other = initial === 'kokoro' ? 'omnivoice' : 'kokoro';
    const controls = await openExtensionPage(context, 'popup');
    await selectNativeOption(controls.locator('#popup-tts-engine'), other);
    await expect.poll(async () => (await log()).filter(e => e.kind === 'engine_handoff').length, { timeout: 120_000 }).toBe(1);
    await expect.poll(async () => (await log()).filter(e => e.kind === 'chunk_end').length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
    await selectNativeOption(controls.locator('#popup-tts-engine'), initial);
    await expect.poll(async () => (await log()).filter(e => e.kind === 'engine_handoff').length, { timeout: 120_000 }).toBe(2);
    const before = (await log()).filter(e => e.kind === 'chunk_end').length;
    await expect.poll(async () => (await log()).filter(e => e.kind === 'chunk_end').length, { timeout: 40_000 }).toBeGreaterThanOrEqual(before + 3);
    // Capture complete chunks only; stopping the read after writing evidence may interrupt the following chunk.
    const diagnostics = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
    const clips = await engine.evaluate(async () => Promise.all(__outputClips.map(async c => ({ ...c, bytes: Array.from(new Uint8Array(await c.bytes)) }))));
    for (const [index, clip] of clips.entries()) {
      await writeFile(path.join(root, `clip-${index}.wav`), Buffer.from(clip.bytes)); delete clip.bytes;
    }
    const timeOrigin = await engine.evaluate(() => performance.timeOrigin);
    await writeFile(path.join(root, 'flow.json'), JSON.stringify({ diagnostics, clips, timeOrigin }, null, 2));
    const captured = await engine.evaluate(() => __silentOutputCapture());
    await writeFile(path.join(root, 'output.wav'), Buffer.from(captured.base64, 'base64'));
    await writeFile(path.join(root, 'output.wav.json'), JSON.stringify(captured.metadata, null, 2));
    const starts = diagnostics.log.filter(e => e.kind === 'chunk_play'), ends = diagnostics.log.filter(e => e.kind === 'chunk_end');
    expect(ends.length).toBeGreaterThanOrEqual(6);
    expect(ends.map(e => e.chunkIndex)).toEqual(Array.from({ length: ends.length }, (_, i) => i + ends[0].chunkIndex));
    expect(diagnostics.log.filter(e => e.kind === 'engine_handoff').map(e => e.engine)).toEqual([other, initial]);
    expect(diagnostics.log.some(e => /synthesis_failed|browser_voice_fallback/.test(e.kind))).toBe(false);
    expect(starts.length - ends.length).toBeLessThanOrEqual(1);
    const gaps = ends.slice(0, -1).map((end, i) => {
      const next = starts[i + 1];
      const decoded = diagnostics.log.filter(e => e.kind === 'audio_preload_decode_latency' && e.chunkIndex === next.chunkIndex && e.t <= next.t).at(-1);
      return { chunkIndex: next.chunkIndex, milliseconds: 1000 * (next.t - end.t), ready: Boolean(decoded && decoded.t <= end.t) };
    });
    const readyGaps = gaps.filter(g => g.ready).map(g => g.milliseconds).sort((a, b) => a - b);
    await writeFile(path.join(root, 'pipeline-analysis.json'), JSON.stringify({ scope: 'Production playback event scheduling; excludes OS/device output latency', gaps,
      p95ReadyGapMs: readyGaps[Math.ceil(.95 * readyGaps.length) - 1], maximumReadyGapMs: readyGaps.at(-1) }, null, 2));
    expect(readyGaps.length).toBeGreaterThanOrEqual(5);
    expect(readyGaps[Math.ceil(.95 * readyGaps.length) - 1]).toBeLessThanOrEqual(50);
    expect(readyGaps.at(-1)).toBeLessThanOrEqual(100);
    for (const handoff of diagnostics.log.filter(e => e.kind === 'engine_handoff')) {
      const following = gaps.find(g => g.chunkIndex === handoff.chunkIndex + 1);
      if (following) expect(following.milliseconds).toBeLessThanOrEqual(100);
    }
    await controls.locator('#popup-toggle').click();
    await expect(controls.locator('#popup-status')).toHaveText('Paused');
    expect(await engine.evaluate(() => __currentOutputAudio.paused)).toBe(true);
    await controls.locator('#popup-toggle').click();
    await expect(controls.locator('#popup-status')).toHaveText('Reading');
    if (!await controls.locator('#popup-settings').evaluate(node => node.open)) await controls.locator('#popup-settings summary').click();
    await expect(controls.locator('#popup-speed')).toBeVisible();
    await setNativeRange(controls.locator('#popup-speed'), 3);
    const completed = (await log()).filter(e => e.kind === 'chunk_end').length;
    await expect.poll(async () => (await log()).filter(e => e.kind === 'chunk_end').length,
      { timeout: 30_000 }).toBeGreaterThan(completed);
    const requests = (await log()).filter(e => e.kind === 'engine_incoming_requested').length;
    await selectNativeOption(controls.locator('#popup-tts-engine'), other);
    await expect.poll(async () => (await log()).filter(e => e.kind === 'engine_incoming_requested').length).toBeGreaterThan(requests);
    await controls.locator('#popup-stop').click();
    await expect(controls.locator('#popup-status')).toHaveText('Ready to read', { timeout: 30_000 });
    await controls.close();
    const restart = await startReadFromToolbarPopup(context, article, { closePopup: false });
    await expect(restart.locator('#popup-status')).toHaveText('Reading', { timeout: 120_000 });
    await restart.locator('#popup-stop').click();
    await expect(restart.locator('#popup-status')).toHaveText('Ready to read', { timeout: 30_000 });
    await writeFile(path.join(root, 'controls.json'), JSON.stringify({ pauseResume: true, fastPlayback: 3, stopIncomingAndRestart: true }));
    expect(resources.ram.length).toBeGreaterThan(10);
    expect(resources.gpu.length).toBeGreaterThan(10);
    expect(resources.errors).toEqual([]);
  } finally {
    await writeFile(stopFile, 'stop');
    try { await cleanup(); } finally {
      for (const child of monitors) child.kill();
      await writeFile(path.join(root, 'resources.json'), JSON.stringify(resources));
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); lock.release();
    }
  }
});
