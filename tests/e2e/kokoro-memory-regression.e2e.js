import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { launchExtensionContext, seedRealTtsFlowFlags, startReadFromToolbarPopup } from './extension-fixture.js';
import { openRoutedReaderEngine, routeKokoroModelFiles } from './kokoro-download-fixture.js';
import { acquireMeasurementLock } from '../../scripts/weak-hardware/measurement-lock.mjs';

test('shared runtime changes preserve exact Kokoro playback WAVs', async () => {
  test.skip(process.env.PN_E2E_MEMORY_PARITY !== '1', 'Explicit packaged baseline/candidate regression.');
  test.setTimeout(5 * 60_000);
  const root = path.resolve('artifacts/omnivoice-memory/kokoro-parity');
  await mkdir(root, { recursive: true });
  const lock = await acquireMeasurementLock({ owner: { purpose: 'Kokoro exact audio regression' } });
  const server = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html lang="en"><title>Kokoro verification</title><article><p>The morning sun warmed the garden as we opened the door and stepped outside.</p><p>A small bird landed on the wooden fence and sang softly in the fresh air.</p></article></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runs = [];
  try {
    for (const variant of ['baseline', 'candidate']) {
      const extensionDir = variant === 'baseline' ? path.resolve('artifacts/omnivoice-memory/baseline/extension')
        : path.resolve(process.env.PN_PARITY_CANDIDATE || 'dist');
      const { context, cleanup } = await launchExtensionContext({ extensionDir, hostPermissions: ['http://127.0.0.1/*'] });
      try {
        await routeKokoroModelFiles(context);
        await context.addInitScript(() => {
          const create = URL.createObjectURL.bind(URL); globalThis.__kokoroWavs = [];
          URL.createObjectURL = blob => {
            if (blob.type === 'audio/wav') globalThis.__kokoroWavs.push(blob.arrayBuffer());
            return create(blob);
          };
        });
        await seedRealTtsFlowFlags(context, { playbackSettings: { ttsEngine: 'kokoro', language: 'en', voice: 'af_heart', speed: 1,
          sectionPauseSeconds: 0, ttsPerformanceProfile: 'quality' } });
        const engine = await openRoutedReaderEngine(context), worker = context.serviceWorkers()[0];
        const article = await context.newPage(); await article.goto(`http://127.0.0.1:${server.address().port}/`);
        await startReadFromToolbarPopup(context, article);
        await expect.poll(async () => (await worker.evaluate(() => chrome.storage.session.get('readerEngineState'))).readerEngineState?.state,
          { timeout: 120_000 }).toBe('finished');
        const waves = await engine.evaluate(async () => Promise.all(__kokoroWavs.map(async bytes => Array.from(new Uint8Array(await bytes)))));
        expect(waves.length).toBeGreaterThanOrEqual(2);
        const hashes = [];
        for (const [index, bytes] of waves.entries()) {
          const wav = Buffer.from(bytes); await writeFile(path.join(root, `${variant}-${index}.wav`), wav);
          hashes.push(createHash('sha256').update(wav).digest('hex'));
        }
        runs.push({ variant, hashes });
      } finally { await cleanup(); }
    }
    expect(runs[1].hashes).toEqual(runs[0].hashes);
    await writeFile(path.join(root, 'results.json'), JSON.stringify({ passed: true, runs }, null, 2));
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); lock.release();
  }
});
