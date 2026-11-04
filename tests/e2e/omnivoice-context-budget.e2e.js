import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchExtensionContext, seedRealTtsFlowFlags } from './extension-fixture.js';
import { openRoutedReaderEngine, routeOmniVoiceModelFiles } from './kokoro-download-fixture.js';
import { ensureMeasurementLock } from '../../tooling/scripts/weak-hardware/measurement-lock.mjs';
import { estimateOmniVoiceFrames } from '../../src/tts/omnivoice/runtime.js';
import catalog from '../../src/tts/omnivoice/speaker-data.js';
import { createOmniVoiceRequest } from '../../src/lib/omnivoice-settings.js';

test('splits an oversized OmniVoice section with one worker and a fixed preset', async ({}, testInfo) => {
  test.skip(process.env.PN_E2E_OMNIVOICE_CONTEXT !== '1', 'Explicit opt-in: real speech model and WebGPU.');
  test.setTimeout(4 * 60 * 60_000);
  let selected;
  for (const characters of [240, 480, 960, 1440, 2000]) {
    const text = '1234567890'.repeat(Math.ceil(characters / 10)).slice(0, characters);
    const reference = catalog.speakers.filter(row => row.lang === 'en')
      .find(row => estimateOmniVoiceFrames(text, 1, row) + row.frames > 2048);
    if (reference) { selected = { text, reference }; break; }
  }
  expect(selected).toBeTruthy();
  const { text, reference } = selected;
  const voice = { detectCode: 'en', omniVoice: { gender: reference.gender, variation: reference.variation, whisper: false } };
  const selectedSeed = createOmniVoiceRequest(text, voice).seed;
  const lock = await ensureMeasurementLock({ owner: { purpose: 'Verify OmniVoice long-section playback' },
    onWait: holder => console.log(`Waiting for measurement process ${holder?.pid}.`) });
  let cleanup = async () => {};
  try {
    const launched = await launchExtensionContext({ testInfo, hostPermissions: ['http://127.0.0.1/*'] });
    cleanup = launched.cleanup;
    await routeOmniVoiceModelFiles(launched.context);
    await seedRealTtsFlowFlags(launched.context);
    const page = await openRoutedReaderEngine(launched.context);
    const result = await page.evaluate(async ({ text, voice }) => {
      const NativeWorker = globalThis.Worker, requests = [], replies = [], errors = [];
      let workerCount = 0;
      globalThis.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          this.contextCheckId = ++workerCount;
          this.addEventListener('message', ({ data }) => {
            if (data.error) errors.push(data.error);
            if (data.result?.pcm) replies.push({ speaker: data.result.speaker, samples: data.result.pcm.length });
          });
        }
        postMessage(message, ...args) {
          if (message.method === 'synthesize') requests.push({ worker: this.contextCheckId, request: message.request });
          return super.postMessage(message, ...args);
        }
      };
      let tts;
      try {
        const module = await import(chrome.runtime.getURL('assets/tts.js'));
        tts = module.createOmniVoiceTts();
        const result = await tts.generate(text, { voice });
        let energy = 0;
        for (const sample of result.audio) {
          if (!Number.isFinite(sample)) throw new Error('Non-finite joined audio');
          energy += sample * sample;
        }
        return { samples: result.audio.length, sampleRate: result.sampling_rate, rms: Math.sqrt(energy / result.audio.length),
          voiceRecovery: result.voiceRecovery ?? null, requests, replies, errors };
      } catch (error) {
        return { failure: { name: error.name, message: error.message }, requests, replies, errors };
      } finally {
        await tts?.dispose();
        globalThis.Worker = NativeWorker;
      }
    }, { text, voice });
    const output = path.resolve(process.env.PN_E2E_OMNIVOICE_CONTEXT_DIR || 'artifacts/omnivoice-context-check');
    await mkdir(output, { recursive: true });
    const report = { status: result.failure ? 'failed' : 'captured-pending-assertions',
      scope: 'Real model, adapter context splitting, physical output and preset/seed continuity; pronunciation and perceived quality are separate.',
      referenceId: reference.id, referenceHash: reference.hash, characters: text.length, ...result };
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    expect(result.failure).toBeUndefined();
    expect(result.errors.some(error => error.name === 'OmniVoiceSectionLengthError')).toBe(true);
    expect(result.errors.every(error => error.name === 'OmniVoiceSectionLengthError')).toBe(true);
    expect(result.replies.length).toBeGreaterThan(1);
    expect(new Set(result.requests.map(row => row.worker)).size).toBe(1);
    expect(result.requests.every(row => row.request.speakerId === `${reference.gender}-${reference.variation}`
      && row.request.seed === selectedSeed)).toBe(true);
    expect(result.replies.every(row => row.speaker.referenceHash === reference.hash)).toBe(true);
    expect(result.voiceRecovery).toBeNull();
    expect(result.sampleRate).toBe(24000); expect(result.samples).toBeGreaterThan(24000); expect(result.rms).toBeGreaterThan(0);
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, status: 'passed' }, null, 2) + '\n');
  } finally { try { await cleanup(); } finally { lock.release(); } }
});
