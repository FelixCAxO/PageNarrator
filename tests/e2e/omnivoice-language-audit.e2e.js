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
import { acquireMeasurementLock } from '../../scripts/weak-hardware/measurement-lock.mjs';
import { getOmniVoiceSpeakerReference } from '../../src/tts/omnivoice/speakers.js';
import { renderOmniVoiceWhisper } from '../../src/tts/omnivoice/whisper.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(process.env.PN_E2E_LANGUAGE_AUDIT_DIR || 'artifacts/omnivoice-language-audit');

test('audits every OmniVoice language with resumable real GPU recordings', async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_LANGUAGE_AUDIT !== '1', 'Explicit opt-in: hundreds of real model syntheses.');
  test.setTimeout(4 * 60 * 60_000);
  const corpus = JSON.parse(await readFile(path.join(root, 'corpus.json'), 'utf8')).languages;
  const reuseBacking = process.env.PN_E2E_LANGUAGE_AUDIT_REUSE_BACKING === '1';
  const rendererSha256 = hash(await readFile('src/tts/omnivoice/whisper.js'));
  const requestFactorySha256 = hash(await readFile('src/lib/omnivoice-settings.js'));
  expect(corpus.length).toBeGreaterThan(0);
  expect(new Set(corpus.map(item => item.id || item.code)).size).toBe(corpus.length);
  const [shardIndex, shardCount] = (process.env.PN_E2E_LANGUAGE_AUDIT_SHARD || '0/1').split('/').map(Number);
  expect(Number.isInteger(shardIndex) && Number.isInteger(shardCount)
    && shardCount > 0 && shardIndex >= 0 && shardIndex < shardCount).toBe(true);
  const cases = corpus.filter((_, index) => index % shardCount === shardIndex);
  await mkdir(path.join(root, 'wav'), { recursive: true });
  await mkdir(path.join(root, 'records'), { recursive: true });
  await mkdir(path.join(root, 'pcm'), { recursive: true });
  const lock = await acquireMeasurementLock({ owner: { purpose: 'Packaged OmniVoice language retest' },
    onWait: holder => console.log(`Waiting for measurement process ${holder?.pid}.`) });
  let cleanup = async () => {};
  try {
    const launched = await launchExtensionContext({ testInfo, hostPermissions: ['http://127.0.0.1/*'] });
    const { context, extensionDir } = launched;
    cleanup = launched.cleanup;
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
    await writeFile(path.join(root, shardCount === 1 ? 'runtime.json' : `runtime-shard-${shardIndex}.json`), JSON.stringify({ workerSha256, script, adapter, requestFactorySha256,
      shardIndex, shardCount,
      settings: 'Fixed speaker presets; per-sample settings and sampling retries recorded with each request.',
      builtManifestSha256: hash(await readFile(path.join(extensionDir, 'manifest.json'))),
      startedAt: new Date().toISOString(), modelBaseUrl: OMNIVOICE_MODEL_BASE_URL }, null, 2));
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
      const sampleId = item.id || item.code;
      const request = createOmniVoiceRequest(text, { detectCode: item.code, omniVoice: item.omniVoice || { gender: 'female', variation: 1, whisper: false } });
      const requestSha256 = hash(JSON.stringify(request));
      const recordPath = path.join(root, 'records', `${sampleId}.json`);
      try {
        const old = JSON.parse(await readFile(recordPath, 'utf8'));
        if (old.workerSha256 === workerSha256 && old.requestSha256 === requestSha256 && old.wavSha256
          && hash(await readFile(path.join(root, old.wav))) === old.wavSha256
          && (!reuseBacking || request.whisper || (old.pcmFile && hash(await readFile(path.join(root,old.pcmFile))) === old.pcmSha256))) { processed += 1; continue; }
      } catch { /* No complete matching checkpoint: generate it. */ }
      if (processed && processed % 32 === 0) await page.evaluate(() => __languageAuditReset());
      const record = { id: sampleId, code: item.code, name: item.name, iso: item.iso, nativeText: item.nativeText,
        text, source: item.source, sourceUrl: item.sourceUrl, workerSha256, requestSha256, request,
        semanticStatus: item.nativeText ? 'awaiting-independent-analysis' : 'unverified-no-native-reference', attempts: [] };
      if(item.replayOf){
        await page.evaluate(()=>__languageAuditReset());
        const warmup=createOmniVoiceRequest(item.warmupText,{detectCode:item.code,omniVoice:item.omniVoice});
        record.warmupSpeaker=await page.evaluate(async request=>(await __languageAuditCall('synthesize',{request})).speaker,warmup);
        expect(record.warmupSpeaker.referenceHash).toBe(getOmniVoiceSpeakerReference(request).hash);
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const started = Date.now();
        const attemptRequest = { ...request, seed: request.seed + attempt };
        try {
          // Every normal preset and both variation-one whisper presets per language use the real worker.
          // The remaining pure DSP probes use its exact float32 backing, with the same renderer and seed.
          const deriveWhisper = reuseBacking && request.whisper && item.omniVoice.variation !== 1 && item.code !== 'sv' && !item.replayOf;
          let result;
          const baselineId = sampleId.replace(/-whisper$/u,'');
          if (deriveWhisper) {
            const baseline = JSON.parse(await readFile(path.join(root,'records',baselineId+'.json'),'utf8'));
            const raw = await readFile(path.join(root,baseline.pcmFile));
            expect(hash(raw)).toBe(baseline.pcmSha256);
            const backing = new Float32Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength));
            const speaker = baseline.attempts.find(attempt=>attempt.speaker).speaker;
            result = {pcm:renderOmniVoiceWhisper(backing,attemptRequest.seed,request.lang),sampleRate:24000,speaker,
              backingPcmSha256:baseline.pcmSha256,timings:{whisperMs:Date.now()-started}};
            record.captureOrigin = 'production-renderer-from-exact-worker-float32';
            record.rendererSha256 = rendererSha256;
            record.backingRecord = baselineId;
          } else {
            result = await page.evaluate(async request => {
            const result = await __languageAuditCall('synthesize', { request });
            return { pcm: Array.from(result.pcm), sampleRate: result.sampleRate, speaker: result.speaker, timings: result.timings,
              backingPcmSha256: result.backingPcmSha256 };
            }, attemptRequest);
            record.captureOrigin = 'packaged-worker';
          }
          expect(result.sampleRate).toBe(24000);
          expect(result.speaker.id).toBe(request.speakerId);
          expect(result.speaker.referenceHash).toBe(getOmniVoiceSpeakerReference(request).hash);
          expect(result.speaker.referenceId).toBe(getOmniVoiceSpeakerReference(request).referenceId);
          expect(result.speaker.referenceLanguage).toBe(getOmniVoiceSpeakerReference(request).lang);
          const pcm = Float32Array.from(result.pcm), wav = waveBytes(pcm);
          record.attempts.push({ seed: attemptRequest.seed, elapsedMs: Date.now() - started, speaker: result.speaker, timings: result.timings });
          record.wav = `wav/${sampleId}.wav`; record.wavSha256 = hash(wav); record.signal = audioMeasures(pcm);
          record.pcmSha256=hash(new Uint8Array(pcm.buffer));
          record.backingPcmSha256=result.backingPcmSha256;
          if (!request.whisper) {
            record.pcmFile = `pcm/${sampleId}.f32`;
            await writeFile(path.join(root,record.pcmFile),new Uint8Array(pcm.buffer));
          } else if (reuseBacking && !deriveWhisper && !item.replayOf) {
            const baseline = JSON.parse(await readFile(path.join(root,'records',baselineId+'.json'),'utf8'));
            const raw = await readFile(path.join(root,baseline.pcmFile));
            expect(hash(raw)).toBe(baseline.pcmSha256);
            const backing = new Float32Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength));
            const expected = renderOmniVoiceWhisper(backing,attemptRequest.seed,request.lang);
            let maxAbsoluteError = 0;
            expect(expected.length).toBe(pcm.length);
            for(let i=0;i<pcm.length;i++)maxAbsoluteError=Math.max(maxAbsoluteError,Math.abs(expected[i]-pcm[i]));
            // Node and Chromium libm can round transcendental functions differently; retain exact equality too.
            record.rendererConformance = {equalPcm:hash(new Uint8Array(expected.buffer))===record.pcmSha256,
              maxAbsoluteError,tolerance:1e-6,passed:maxAbsoluteError<=1e-6,rendererSha256};
            expect(record.rendererConformance.passed).toBe(true);
          }
          if(item.replayOf){
            const baseline=JSON.parse(await readFile(path.join(root,'records',`${item.replayOf}.json`),'utf8'));
            record.replay={baseline:item.replayOf,baselinePcmSha256:baseline.pcmSha256,
              equalPcm:record.pcmSha256===baseline.pcmSha256,equalWav:record.wavSha256===baseline.wavSha256};
          }
          record.status = attempt ? 'generated-after-reset' : 'generated';
          await writeFile(path.join(root, record.wav), wav);
          break;
        } catch (error) {
          record.attempts.push({ seed: attemptRequest.seed, elapsedMs: Date.now() - started, error: String(error) });
          record.status = 'synthesis-failed';
          if (!attempt) await page.evaluate(() => __languageAuditReset());
        }
      }
      await writeFile(recordPath, JSON.stringify(record, null, 2));
      processed += 1;
      console.log(JSON.stringify({ processed, total: cases.length, shardIndex, id: sampleId, code: item.code, nativeText: item.nativeText,
        status: record.status, seconds: record.signal?.seconds }));
    }
    // This verifies complete capture, including retained failures. Only the independent
    // analysis and report --require-pass decide quality acceptance.
    const records = new Set((await readdir(path.join(root, 'records'))).filter(name => name.endsWith('.json')));
    expect(cases.every(item => records.has(`${item.id || item.code}.json`))).toBe(true);
  } finally { try { await cleanup(); } finally { lock.release(); } }
});
