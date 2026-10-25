// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Frozen development speech comparison; tensor parity and listening are separate gates.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import manifest from '../tests/fixtures/browser-speech-models.json' with { type: 'json' };
import corpus from '../tests/fixtures/browser-speech-quality.json' with { type: 'json' };
import { browserAdapterConfiguration, verifyBrowserAdapter } from './lib/browser-adapter.mjs';
import { engineSourcePins } from './lib/engine-source-pins.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
const plans = Number(process.argv.find(arg => arg.startsWith('--plans='))?.slice(8) ?? 1);
const originalOnly = process.argv.includes('--original-only');
const explicitOutput = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
const adapterConfiguration = browserAdapterConfiguration();
if (process.argv.slice(2).some(arg => !arg.startsWith('--case=') && !arg.startsWith('--plans=') && !arg.startsWith('--output=') && arg !== '--original-only') || ![1, 2].includes(plans)
  || (selected && !corpus.cases.some(item => item.id === selected))) {
  throw new Error('Usage: node scripts/probe-omnivoice-speech.mjs [--case=english|swedish|arabic] [--plans=1|2]');
}
const cases = corpus.cases.filter(item => !selected || item.id === selected);
const modelRoot = resolve(root, process.env.PN_BROWSER_MODEL_DIR || '.cache/engine-models', manifest.modelId);
const outDir = explicitOutput ? resolve(root, explicitOutput) : resolve(root, 'artifacts/engines/omnivoice-original-speech',
  ...(adapterConfiguration.suffix ? [adapterConfiguration.suffix.slice(1)] : []), ...(plans === 2 ? ['plans-2'] : []));
const output = resolve(outDir, `report${selected ? `-${selected}` : ''}.json`);
try { await copyFile(output, output.replace(/\.json$/, `-${Date.now()}.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const voiceSources = (await readdir(resolve(root, 'src/tts/omnivoice'))).filter(name => name.endsWith('.js')).map(name => `src/tts/omnivoice/${name}`);
const pins = () => engineSourcePins(root, [...voiceSources, 'scripts/probe-omnivoice-speech.mjs', 'scripts/verify-omnivoice-speech.py',
  'scripts/lib/browser-adapter.mjs', 'scripts/lib/engine-source-pins.mjs', 'tests/fixtures/browser-speech-quality.json']);
const implementationPins = await pins();
for (const file of manifest.files) {
  const hash = createHash('sha256'); let count = 0;
  for await (const chunk of createReadStream(resolve(modelRoot, file.path))) { count += chunk.length; hash.update(chunk); }
  if (count !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`Pinned model bytes differ: ${file.path}`);
}
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
    if (pathname === '/') { response.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Original OmniVoice speech verification</title>'); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const model = manifest.files.find(file => pathname === `/models/${file.path}`);
    if (model) {
      response.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': model.bytes });
      createReadStream(resolve(modelRoot, model.path)).pipe(response); return;
    }
    const path = pathname.startsWith('/runtime/') ? resolve(root, 'node_modules/onnxruntime-web-omnivoice/dist', pathname.slice(9)) : resolve(root, `.${pathname}`);
    const type = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' }[extname(path)];
    if (!path.startsWith(`${root}${sep}`) || !type) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { ...headers, 'Content-Type': type }); response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
let browser;
try {
  await mkdir(outDir, { recursive: true });
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: adapterConfiguration.args });
  const page = await browser.newPage(), errors = [], recordings = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); else if (message.text().startsWith('PN speech')) console.log(message.text()); });
  await page.exposeFunction('saveRecording', async (id, backend, pcm, codes) => {
    const samples = Float32Array.from(pcm), header = Buffer.alloc(44), audio = Buffer.alloc(samples.length * 2);
    header.write('RIFF', 0); header.writeUInt32LE(36 + audio.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(audio.length, 40);
    for (let i = 0; i < samples.length; i++) audio.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
    const name = `${id}-${backend}.wav`, wav = Buffer.concat([header, audio]);
    await writeFile(resolve(outDir, name), wav);
    const codeData = Uint16Array.from(codes);
    recordings.push({ id, backend, wav: name, sha256: createHash('sha256').update(wav).digest('hex'),
      pcmSha256: createHash('sha256').update(new Uint8Array(samples.buffer)).digest('hex'),
      codeSha256: createHash('sha256').update(new Uint8Array(codeData.buffer)).digest('hex') });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async ({ cases, plans, originalOnly, expectedVendor }) => {
    const runtimePath = '/src/tts/omnivoice/runtime.js', tokenizerPath = '/src/engines/bytepair-tokenizer.js', ownPath = '/src/engines/browser-inference.js', referencePath = '/runtime/ort.webgpu.bundle.min.mjs';
    const [{ createOmniVoiceRuntime }, { BytePairTokenizer }, own, reference] = await Promise.all([
      import(runtimePath), import(tokenizerPath), import(ownPath), originalOnly ? Promise.resolve(null) : import(referencePath),
    ]);
    if (reference) { reference.env.wasm.numThreads = 1; reference.env.wasm.wasmPaths = `${location.origin}/runtime/`; reference.env.logLevel = 'error'; }
    const gpuAdapter = await navigator.gpu.requestAdapter(), adapter = gpuAdapter?.info;
    if (!adapter || expectedVendor && adapter.vendor !== expectedVendor) throw new Error('Requested GPU adapter was not selected.');
    const tokenizer = new BytePairTokenizer(await (await fetch('/models/tokenizer.json')).json(), await (await fetch('/models/tokenizer_config.json')).json());
    const results = [], expected = new Map(), validationErrors = [], engines = [];
    for (const [backend, api] of [['reference', reference], ['original', own]]) {
      if (originalOnly && backend === 'reference') continue;
      let lastCodes; const inferencePlans = [];
      const wrapped = { Tensor: api.Tensor, InferenceSession: { async create(source, options) {
        const session = await api.InferenceSession.create(source, { ...options, logSeverityLevel: 3, ...(backend === 'original' ? { maxCachedPlans: plans } : {}) });
        const engine = session.session?.engine;
        if (engine) { engines.push(engine); engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message)); }
        return { async run(feeds, outputs) {
          if (feeds.audio_codes) lastCodes = Array.from(feeds.audio_codes.data, Number);
          const result = await session.run(feeds, outputs);
          if (feeds.input_ids && session.session) inferencePlans.push({ ...session.session.lastRun,
            retainedPlans: session.session.cachedPlans.size });
          return result;
        }, release: () => session.release() };
      } } };
      const runtime = createOmniVoiceRuntime({ ort: wrapped, decoderRuntime: wrapped, tokenizer, fetch: fetch.bind(globalThis) });
      try {
        const loading = performance.now(); await runtime.init(`${location.origin}/models`);
        results.push({ backend, loadingMs: performance.now() - loading });
        for (const item of cases) {
          inferencePlans.length = 0;
          const started = performance.now(), audio = await runtime.synthesize(item);
          let peak = 0, energy = 0; for (const value of audio.pcm) { peak = Math.max(peak, Math.abs(value)); energy += value * value; }
          if (!audio.pcm.every(Number.isFinite) || !energy) throw new Error('Speech is non-finite or silent.');
          const metrics = { id: item.id, backend, samples: audio.pcm.length, seconds: audio.pcm.length / audio.sampleRate,
            peak, rms: Math.sqrt(energy / audio.pcm.length), elapsedMs: performance.now() - started };
          if (backend === 'reference') expected.set(item.id, { codes: lastCodes, samples: audio.pcm.length });
          else if (!originalOnly) {
            const baseline = expected.get(item.id);
            if (baseline.samples !== audio.pcm.length || baseline.codes.length !== lastCodes.length) throw new Error('Speech shape/token count differs.');
            metrics.matchingCodeFraction = lastCodes.filter((code, i) => code === baseline.codes[i]).length / lastCodes.length;
          }
          results.push(metrics); console.log(`PN speech ${JSON.stringify(metrics)}`);
          if (backend === 'original') metrics.inferencePlans = [...inferencePlans];
          await globalThis.saveRecording(item.id, backend, Array.from(audio.pcm), lastCodes);
        }
      } finally { await runtime.dispose(); }
    }
    if (engines.some(engine => engine.buffers.size || engine.tensors.size) || validationErrors.length) throw new Error('Speech engine validation or cleanup failed.');
    return { results, validationErrors, resourceCleanup: true,
      adapter: { vendor: adapter.vendor, architecture: adapter.architecture, isFallbackAdapter: adapter.isFallbackAdapter } };
  }, { cases, plans, originalOnly, expectedVendor: adapterConfiguration.expectedVendor });
  if (errors.length) throw new Error(errors.join('\n'));
  verifyBrowserAdapter(result.adapter, adapterConfiguration);
  const sourcesUnchanged = JSON.stringify(implementationPins) === JSON.stringify(await pins());
  if (!sourcesUnchanged) throw new Error('Speech sources changed during verification.');
  await writeFile(output, `${JSON.stringify({ status: 'review-required', corpus, files: manifest.files, ...result, recordings, originalOnly,
    implementationPins, sourcesUnchanged, browserArguments: adapterConfiguration.args, browserVersion: browser.version(),
    tensorParityPassed: false, listeningPassed: false, hardwarePerformanceAccepted: false,
    scope: 'Full 24-step bidirectional diffusion, original main/decoder/tokenizer. Numerical parity, ASR, human listening and representative hardware remain separate acceptance gates.' }, null, 2)}\n`);
  const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const html = `<!doctype html><meta charset="utf-8"><title>Original OmniVoice speech comparison</title><style>body{font:18px system-ui;max-width:900px;margin:40px auto;background:#181a20;color:#eee}article{padding:20px;border-bottom:1px solid #555}audio{display:block;margin:10px 0}</style><h1>Speech review — acceptance pending</h1><p>Frozen development cases. Tensor parity has not passed. Listen for pronunciation, omissions, noise and naturalness.</p>${cases.map(item => `<article><p lang="${escape(item.lang)}">${escape(item.text)}</p>${(originalOnly ? ['original'] : ['reference', 'original']).map(backend => `<p>${backend}<audio controls src="${escape(item.id)}-${backend}.wav"></audio></p>`).join('')}</article>`).join('')}`;
  await writeFile(resolve(outDir, `review${selected ? `-${selected}` : ''}.html`), html);
  console.log(output);
} catch (error) {
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify({ status: 'failed', error: error.stack }, null, 2)}\n`); throw error;
} finally { await browser?.close(); await new Promise(closed => server.close(closed)); }
