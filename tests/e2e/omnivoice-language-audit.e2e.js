// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchExtensionContext, seedRealTtsFlowFlags } from './extension-fixture.js';
import { openRoutedReaderEngine, routeOmniVoiceModelFiles } from './kokoro-download-fixture.js';
import { createOmniVoiceRequest } from '../../src/lib/omnivoice-settings.js';
import { OMNIVOICE_MODEL_BASE_URL } from '../../src/tts/omnivoice/loader.js';
import { waveBytes, audioMeasures } from '../../scripts/lib/kokoro-speech-acceptance.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve('artifacts/omnivoice-language-audit');

test('audits every OmniVoice language with resumable real GPU recordings', async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_LANGUAGE_AUDIT !== '1', 'Explicit opt-in: hundreds of real model syntheses.');
  test.setTimeout(4 * 60 * 60_000);
  const corpus = JSON.parse(await readFile(path.join(root, 'corpus.json'), 'utf8')).languages;
  expect(corpus).toHaveLength(646);
  expect(new Set(corpus.map(item => item.code)).size).toBe(646);
  const [shardIndex, shardCount] = (process.env.PN_E2E_LANGUAGE_AUDIT_SHARD || '0/1').split('/').map(Number);
  expect(Number.isInteger(shardIndex) && Number.isInteger(shardCount)
    && shardCount > 0 && shardIndex >= 0 && shardIndex < shardCount).toBe(true);
  const cases = corpus.filter((_, index) => index % shardCount === shardIndex);
  await mkdir(path.join(root, 'wav'), { recursive: true });
  await mkdir(path.join(root, 'records'), { recursive: true });
  const { context, cleanup, extensionDir } = await launchExtensionContext({ testInfo, hostPermissions: ['http://127.0.0.1/*'] });
  try {
    const assets = await readdir(path.join(extensionDir, 'assets'));
    let script;
    for (const name of assets.filter(name => /^worker-.*\.js$/.test(name))) {
      if ((await readFile(path.join(extensionDir, 'assets', name), 'utf8')).includes('Unknown OmniVoice worker method')) script = name;
    }
    expect(script).toBeTruthy();
    const workerSha256 = hash(await readFile(path.join(extensionDir, 'assets', script)));
    await routeOmniVoiceModelFiles(context);
    await seedRealTtsFlowFlags(context);
    const page = await openRoutedReaderEngine(context);
    const adapter = await page.evaluate(async () => {
      const a = await navigator.gpu.requestAdapter();
      return { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description };
    });
    await writeFile(path.join(root, shardCount === 1 ? 'runtime.json' : `runtime-shard-${shardIndex}.json`), JSON.stringify({ workerSha256, script, adapter,
      shardIndex, shardCount,
      settings: { gender: 'female', variation: 1, whisper: false }, modelBaseUrl: OMNIVOICE_MODEL_BASE_URL }, null, 2));
    await page.evaluate(({ script, baseUrl }) => {
      let worker, id = 0;
      globalThis.__languageAuditCall = (method, payload = {}) => new Promise((resolve, reject) => {
        const current = ++id;
        const timer = setTimeout(() => { worker.removeEventListener('message', listener); reject(new Error('OmniVoice audit RPC timed out.')); }, 120_000);
        const listener = ({ data }) => {
          if (data.id !== current) return;
          clearTimeout(timer); worker.removeEventListener('message', listener);
          if (data.error) reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
          else resolve(data.result);
        };
        worker.addEventListener('message', listener);
        worker.postMessage({ id: current, method, ...payload });
      });
      globalThis.__languageAuditReset = async () => {
        worker?.terminate();
        worker = new Worker(chrome.runtime.getURL(`assets/${script}`), { type: 'module' });
        await __languageAuditCall('init', { baseUrl, runtimeRoot: chrome.runtime.getURL('') });
      };
    }, { script, baseUrl: OMNIVOICE_MODEL_BASE_URL });
    await page.evaluate(() => __languageAuditReset());
    let processed = 0;
    for (const scheduled of [...cases.filter(item => item.nativeText), ...cases.filter(item => !item.nativeText)]) {
      // A newly obtained native source may replace a pending signal-only probe.
      const item = scheduled.nativeText ? scheduled : JSON.parse(await readFile(path.join(root, 'corpus.json'), 'utf8'))
        .languages.find(item => item.code === scheduled.code);
      const text = item.text || 'Today we are reading a short story about a quiet garden.';
      const request = createOmniVoiceRequest(text, { detectCode: item.code, omniVoice: { gender: 'female', variation: 1, whisper: false } });
      const requestSha256 = hash(JSON.stringify(request));
      const recordPath = path.join(root, 'records', `${item.code}.json`);
      try {
        const old = JSON.parse(await readFile(recordPath, 'utf8'));
        if (old.workerSha256 === workerSha256 && old.requestSha256 === requestSha256 && old.wavSha256
          && hash(await readFile(path.join(root, old.wav))) === old.wavSha256) { processed += 1; continue; }
      } catch { /* No complete matching checkpoint: generate it. */ }
      if (processed && processed % 32 === 0) await page.evaluate(() => __languageAuditReset());
      const record = { code: item.code, name: item.name, iso: item.iso, nativeText: item.nativeText,
        text, source: item.source, sourceUrl: item.sourceUrl, workerSha256, requestSha256, request,
        semanticStatus: item.nativeText ? 'awaiting-independent-analysis' : 'unverified-no-native-reference', attempts: [] };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const started = Date.now();
        try {
          const result = await page.evaluate(async request => {
            const result = await __languageAuditCall('synthesize', { request });
            return { pcm: Array.from(result.pcm), sampleRate: result.sampleRate, speaker: result.speaker, timings: result.timings };
          }, request);
          expect(result.sampleRate).toBe(24000);
          const pcm = Float32Array.from(result.pcm), wav = waveBytes(pcm);
          record.attempts.push({ elapsedMs: Date.now() - started, speaker: result.speaker, timings: result.timings });
          record.wav = `wav/${item.code}.wav`; record.wavSha256 = hash(wav); record.signal = audioMeasures(pcm);
          record.status = attempt ? 'generated-after-reset' : 'generated';
          await writeFile(path.join(root, record.wav), wav);
          break;
        } catch (error) {
          record.attempts.push({ elapsedMs: Date.now() - started, error: String(error) });
          record.status = 'synthesis-failed';
          if (!attempt) await page.evaluate(() => __languageAuditReset());
        }
      }
      await writeFile(recordPath, JSON.stringify(record, null, 2));
      processed += 1;
      console.log(JSON.stringify({ processed, total: cases.length, shardIndex, code: item.code, nativeText: item.nativeText,
        status: record.status, seconds: record.signal?.seconds }));
    }
    // This verifies complete capture, including retained failures. Only the independent
    // analysis and report --require-pass decide quality acceptance.
    const records = new Set((await readdir(path.join(root, 'records'))).filter(name => name.endsWith('.json')));
    expect(cases.every(item => records.has(`${item.code}.json`))).toBe(true);
  } finally { await cleanup(); }
});
