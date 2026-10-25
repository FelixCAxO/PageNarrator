import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchExtensionContext, seedRealTtsFlowFlags } from './extension-fixture.js';
import { openRoutedReaderEngine, routeOmniVoiceModelFiles } from './kokoro-download-fixture.js';
import { createOmniVoiceRequest } from '../../src/lib/omnivoice-settings.js';
import { OMNIVOICE_MODEL_BASE_URL } from '../../src/tts/omnivoice/loader.js';
import { waveBytes } from '../../scripts/lib/kokoro-speech-acceptance.mjs';
import { acquireMeasurementLock } from '../../scripts/weak-hardware/measurement-lock.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve('artifacts/omnivoice-memory/parity');
const cases = [
  { lang: 'en', text: 'The morning sun warmed the garden as we stepped outside.' },
  { lang: 'en', text: 'A small bird landed on the fence and sang softly.' },
  { lang: 'sv', text: 'Morgonsolen värmde trädgården när vi öppnade dörren.' },
  { lang: 'sv', text: 'En liten fågel landade på staketet och sjöng.' },
  { lang: 'hi', text: 'नमस्ते! आज हम एक शांत बगीचे के बारे में एक छोटी कहानी पढ़ते हैं।' },
  { lang: 'ar', text: 'صباح الخير. نقرأ اليوم قصة قصيرة عن حديقة هادئة.' },
  { lang: 'ja', text: 'こんにちは。今日は静かな庭についての短い物語を読みます。' },
  { lang: 'en', text: 'The garden is quiet and the sky is blue.', variation: 7 },
  { lang: 'hi', text: 'नमस्ते! आज हम एक शांत बगीचे के बारे में एक छोटी कहानी पढ़ते हैं।', gender: 'male', whisper: true, variation: 7 },
  { lang: 'sv', text: 'Morgonsolen värmde trädgården när vi öppnade dörren.', freshAfterRecovery: true },
];

test('preserves exact OmniVoice PCM in paired baseline/candidate performance trials', async () => {
  test.skip(process.env.PN_E2E_MEMORY_PARITY !== '1', 'Explicit real-model memory optimization comparison.');
  test.setTimeout(30 * 60_000);
  await mkdir(root, { recursive: true });
  const lock = await acquireMeasurementLock({ owner: { purpose: 'OmniVoice exact PCM and paired performance' } });
  const runs = [];
  const trials = Number(process.env.PN_PARITY_TRIALS || 5);
  try {
    for (let repeat = 0; repeat < trials; repeat++) for (const variant of repeat % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const extensionDir = variant === 'baseline' ? path.resolve('artifacts/omnivoice-memory/baseline/extension')
        : path.resolve(process.env.PN_PARITY_CANDIDATE || 'dist');
      const { context, cleanup } = await launchExtensionContext({ extensionDir, hostPermissions: ['http://127.0.0.1/*'] });
      const run = { variant, repeat, samples: [] };
      try {
        await routeOmniVoiceModelFiles(context); await seedRealTtsFlowFlags(context);
        const page = await openRoutedReaderEngine(context);
        const assets = await readdir(path.join(extensionDir, 'assets'));
        let script;
        for (const name of assets.filter(name => /^worker-.*\.js$/.test(name))) {
          if ((await readFile(path.join(extensionDir, 'assets', name), 'utf8')).includes('Unknown OmniVoice worker method')) script = name;
        }
        expect(script).toBeTruthy(); run.workerSha256 = hash(await readFile(path.join(extensionDir, 'assets', script)));
        await page.evaluate(({ script, baseUrl }) => {
          const worker = new Worker(chrome.runtime.getURL(`assets/${script}`), { type: 'module' }); let id = 0;
          globalThis.__parityStages = [];
          worker.addEventListener('message', ({ data }) => {
            if (data.progress) __parityStages.push({ at: Date.now(), progress: data.progress });
          });
          globalThis.__parityCall = (method, payload = {}) => new Promise((resolve, reject) => {
            const current = ++id;
            const listener = ({ data }) => {
              if (data.id !== current) return; worker.removeEventListener('message', listener);
              if (data.error) reject(Object.assign(new Error(data.error.message), { name: data.error.name })); else resolve(data.result);
            };
            worker.addEventListener('message', listener); worker.postMessage({ id: current, method, ...payload });
          });
          globalThis.__parityInit = () => __parityCall('init', { baseUrl, runtimeRoot: chrome.runtime.getURL('') });
        }, { script, baseUrl: OMNIVOICE_MODEL_BASE_URL });
        const started = Date.now(); await page.evaluate(() => __parityInit()); run.initMs = Date.now() - started;
        run.initializationStages = await page.evaluate(() => __parityStages);
        let speakerKey;
        for (const [index, item] of (repeat ? cases.slice(0, 2) : cases).entries()) {
          if (item.freshAfterRecovery) {
            await page.evaluate(async () => { await __parityCall('dispose'); await __parityInit(); });
            speakerKey = null;
          }
          const request = createOmniVoiceRequest(item.text, { detectCode: item.lang,
            omniVoice: { gender: item.gender || 'female', variation: item.variation || 1, whisper: !!item.whisper } });
          const key = JSON.stringify([request.lang, request.instruct, request.seed]);
          if (key === speakerKey) request.numStep = 12;
          const sample = await page.evaluate(async request => {
            const started = performance.now(), result = await __parityCall('synthesize', { request });
            return { elapsedMs: performance.now() - started, pcm: Array.from(result.pcm), sampleRate: result.sampleRate,
              speaker: result.speaker, timings: result.timings, resources: result.resources };
          }, request);
          if (variant === 'candidate') {
            sample.resources = await page.evaluate(() => __parityCall('diagnostics'));
            expect(sample.resources.main.hostWeightBytes).toBeLessThan(1024 * 1024);
            expect(sample.resources.decoder.hostWeightBytes).toBeLessThan(1024 * 1024);
            expect(sample.resources.main.gpuWeightBytes).toBeGreaterThan(1_000_000_000);
          }
          speakerKey = key;
          const pcm = Float32Array.from(sample.pcm); delete sample.pcm;
          Object.assign(sample, { request, samples: pcm.length, pcmSha256: hash(new Uint8Array(pcm.buffer)) });
          if (!repeat) await writeFile(path.join(root, `${variant}-${index}-${item.lang}.wav`), waveBytes(pcm));
          run.samples.push(sample);
          if (item.freshAfterRecovery) expect(sample.pcmSha256).toBe(run.samples[2].pcmSha256);
          const paired = runs.find(r => r.repeat === repeat && r.variant !== variant)?.samples[index];
          if (paired) expect([sample.sampleRate, sample.samples, sample.pcmSha256, sample.speaker]).toEqual([paired.sampleRate, paired.samples, paired.pcmSha256, paired.speaker]);
        }
        await page.evaluate(() => __parityCall('dispose'));
        console.log(JSON.stringify({ variant, repeat, initMs: run.initMs, synthesisMs: run.samples.map(s => s.elapsedMs) }));
        runs.push(run); await writeFile(path.join(root, 'results.json'), JSON.stringify({ cases, runs }, null, 2));
      } finally { await cleanup(); }
    }
    for (let repeat = 0; repeat < trials; repeat++) {
      const baseline = runs.find(r => r.repeat === repeat && r.variant === 'baseline');
      const candidate = runs.find(r => r.repeat === repeat && r.variant === 'candidate');
      expect(candidate.samples.map(s => [s.sampleRate, s.samples, s.pcmSha256, s.speaker])).toEqual(baseline.samples.map(s => [s.sampleRate, s.samples, s.pcmSha256, s.speaker]));
    }
  } finally { lock.release(); }
});
