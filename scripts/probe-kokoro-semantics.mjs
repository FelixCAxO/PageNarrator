// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import * as oracle from 'onnxruntime-node';
import { WasmKokoroCompute } from '../src/engines/kokoro-cpu-compute.js';
import { WebGpuOnnxSession } from '../src/engines/webgpu-onnx-session.js';
import { InferenceSession, Tensor } from '../src/engines/browser-inference.js';
import { createEnglishPhonemizer } from '../src/tts/kokoro/english-phonemizer.js';
import { createKokoroTokenizer } from '../src/tts/kokoro/tokenizer.js';
import { createBrowserKokoroBackend } from '../src/tts/kokoro/runtime.js';
import { KOKORO_DATA } from '../src/tts/kokoro/model-data.js';
import { compareAudio, compareTranscripts, escapeHtml, waveBytes } from './lib/kokoro-speech-acceptance.mjs';
import { createKokoroBrowserSession } from './lib/kokoro-browser-session.mjs';
import { kokoroProbeModelMode, prepareKokoroProbeModel, requireNewKokoroProbeReport } from './lib/kokoro-probe-model.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const directory = resolve(option('--cache', `.cache/kokoro/${KOKORO_DATA.modelId}`)), webgpu = process.argv.includes('--webgpu'), fp32 = webgpu || process.argv.includes('--fp32'), dtype = fp32 ? 'fp32' : 'q8';
const modelMode = kokoroProbeModelMode();
const outputDirectory = resolve(root, option('--output', `artifacts/engines/kokoro-${webgpu ? 'gpu-fp32' : dtype}-semantic${modelMode === 'production' ? '-production' : ''}`)), reportFile = resolve(outputDirectory, 'report.json');
const profile = process.argv.includes('--profile');
const nativeWasmPath = option('--native-wasm', 'public/native/kokoro-engine.wasm');
if (process.argv.includes('--native-wasm') && (webgpu || !process.argv.includes('--output'))) throw new Error('Isolated native candidates require a CPU backend and explicit separate --output.');
await requireNewKokoroProbeReport(reportFile);
const corpusPath = option('--corpus', 'tests/fixtures/kokoro-semantic-corpus.json');
const frozenCorpora = { 'tests/fixtures/kokoro-semantic-corpus.json': '0fd95744f56191e668fa0f39d1e2a83d79f14821ee8d657cd4dbae4995310442',
  'tests/fixtures/kokoro-connected-prose.json': 'da954a98973a691563523d22111806e73898e6141498e62f4bf5a3a24c3e56b7' };
if (!Object.hasOwn(frozenCorpora, corpusPath)) throw new Error('Unknown frozen Kokoro speech corpus.');
const fixtureBytes = await readFile(resolve(root, corpusPath));
const corpusSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
if (corpusSha256 !== frozenCorpora[corpusPath]) throw new Error('Frozen Kokoro semantic corpus changed.');
const corpus = JSON.parse(fixtureBytes), report = { status: 'incomplete', dtype, backend: webgpu ? 'webgpu' : 'wasm', corpusSha256, modelRevision: KOKORO_DATA.revision,
  corpusPath, modelMode, scope: `Frozen US/UK development evaluation; both paths use the same ${modelMode === 'production' ? 'production phase-v2' : 'unmodified retained'} graph and original phonemizer/tokenizer. Reference is ORT CPU/fp32 (or CPU/q8 for q8 model), not legacy full-pipeline phonemization. ASR is diagnostic and human listening remains pending.`, gates: corpus.gates, cases: [], humanListening: 'pending' };
await mkdir(outputDirectory, { recursive: true });
// Pin every engine module, including imported planners/shaders, rather than just entry points.
// The complete engine directory is small; a concurrent unrelated engine edit invalidates the
// source snapshot explicitly instead of risking a false claim that inference stayed frozen.
const sourceFiles = [...(await Promise.all(['src/engines', 'src/tts/kokoro'].map(async directory =>
  (await readdir(resolve(root, directory))).filter(file => file.endsWith('.js')).map(file => `${directory}/${file}`)))).flat(),
  'scripts/probe-kokoro-semantics.mjs', 'scripts/lib/kokoro-browser-session.mjs', 'scripts/lib/kokoro-speech-acceptance.mjs', 'scripts/lib/kokoro-probe-model.mjs', 'scripts/kokoro-asr-review.py',
  nativeWasmPath, 'public/assets/phonemizer/english.wasm', 'public/assets/phonemizer/pronunciations.bin'].sort();
const sourcePins = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])));
report.implementationPins = await sourcePins();
report.implementationPinScope = 'All JavaScript engine and Kokoro modules, probe/ASR code, runtime WASM and pronunciation data. Model, tokenizer and style bytes are verified separately against pinned manifests.';
async function verified(path) {
  const bytes = await readFile(resolve(directory, path)), file = KOKORO_DATA.files.find(item => item.path === path);
  if (!file || file.bytes !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Invalid model data pin: ${path}.`);
  return bytes;
}
if (!webgpu) report.nativeWasm = { path: nativeWasmPath, sha256: report.implementationPins[nativeWasmPath] };
const engine = webgpu ? null : await WasmKokoroCompute.create(await readFile(resolve(root, nativeWasmPath)));
let nativeOperations = {}, nativePatterns = new Map();
if (engine && profile) {
  const invoke = engine.invoke.bind(engine);
  engine.invoke = (name, tensors, parameters, ...extra) => {
    const started = performance.now();
    try { return invoke(name, tensors, parameters, ...extra); }
    finally {
      const elapsedMs = performance.now() - started; nativeOperations[name] = (nativeOperations[name] ?? 0) + elapsedMs;
      const key = `${name}:${Array.from(parameters)}`, entry = nativePatterns.get(key) ?? { name, parameters: Array.from(parameters), shapes: tensors.map(tensor => tensor.shape), count: 0, elapsedMs: 0 };
      entry.count++; entry.elapsedMs += elapsedMs; nativePatterns.set(key, entry);
    }
  };
}
const arena = engine ? { peakArenaBytes: engine.memory.buffer.byteLength, peakLiveBytes: 0, allocationCount: 0, failures: [] } : null;
if (engine) {
  const allocate = engine.allocate.bind(engine);
  engine.allocate = bytes => {
    try {
      const result = allocate(bytes); arena.allocationCount++;
      arena.peakArenaBytes = Math.max(arena.peakArenaBytes, engine.memory.buffer.byteLength);
      arena.peakLiveBytes = Math.max(arena.peakLiveBytes, [...engine.buffers].reduce((sum, buffer) => sum + buffer.size, 0));
      return result;
    } catch (error) {
      arena.failures.push({ requestedBytes: bytes, arenaBytes: engine.memory.buffer.byteLength, cursor: engine.cursor,
        largestTensors: [...engine.tensors].sort((a, b) => b.buffer.size - a.buffer.size).slice(0, 6).map(value => ({ shape: value.shape, bytes: value.buffer.size })) });
      throw error;
    }
  };
}
let candidate, reference, candidateSession, referenceSession, browserSession;
const asrCases = [];
try {
  const model = await verified(fp32 ? 'onnx/model.onnx' : 'onnx/model_quantized.onnx'); report.modelSha256 = createHash('sha256').update(model).digest('hex');
  const prepared = await prepareKokoroProbeModel(model, modelMode), probeModel = prepared.bytes;
  report.phaseCorrection = prepared.phaseCorrection;
  report.comparedModelSha256 = createHash('sha256').update(probeModel).digest('hex');
  const tokenizer = createKokoroTokenizer(JSON.parse(await verified('tokenizer.json')), JSON.parse(await verified('tokenizer_config.json')));
  const native = { wasmBinary: await readFile(resolve(root, 'public/assets/phonemizer/english.wasm')), pronunciationData: await readFile(resolve(root, 'public/assets/phonemizer/pronunciations.bin')) };
  const styles = new Map();
  const loadStyle = async voice => {
    if (!styles.has(voice)) styles.set(voice, verified(`voices/${voice}.bin`).then(bytes => new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))));
    return styles.get(voice);
  };
  if (webgpu) {
    browserSession = await createKokoroBrowserSession(probeModel, root);
    candidateSession = { inputNames: ['input_ids', 'style', 'speed'], outputNames: ['waveform'], async run(feeds, outputs) {
      const result = await browserSession.run(feeds, outputs);
      return Object.fromEntries(Object.entries(result).map(([name, value]) => [name, { ...value, data: Float32Array.from(value.data) }]));
    }, dispose: () => browserSession.dispose() };
  } else candidateSession = await WebGpuOnnxSession.create(probeModel, { engine });
  referenceSession = await oracle.InferenceSession.create(probeModel, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled' });
  const baselineAdapter = { async run(feeds) {
    const outputs = await referenceSession.run(Object.fromEntries(Object.entries(feeds).map(([name, tensor]) => [name, new oracle.Tensor(tensor.type, tensor.data, tensor.dims)])));
    return Object.fromEntries(Object.entries(outputs).map(([name, tensor]) => [name, new Tensor(tensor.type, tensor.data, tensor.dims)]));
  }, release: () => referenceSession.release() };
  const traces = { candidate: [], reference: [] };
  const traced = (session, variant) => ({ async run(feeds, outputs) {
    traces[variant].push({ ids: Array.from(feeds.input_ids.data, Number), styleRow: feeds.input_ids.data.length - 2,
      styleSha256: createHash('sha256').update(new Uint8Array(feeds.style.data.buffer, feeds.style.data.byteOffset, feeds.style.data.byteLength)).digest('hex'), speed: Array.from(feeds.speed.data) });
    return session.run(feeds, outputs);
  }, release: () => session.release() });
  candidate = createBrowserKokoroBackend({ session: traced(new InferenceSession(candidateSession), 'candidate'), tokenizer, phonemizer: await createEnglishPhonemizer(native), Tensor, loadStyle });
  reference = createBrowserKokoroBackend({ session: traced(baselineAdapter, 'reference'), tokenizer, phonemizer: await createEnglishPhonemizer(native), Tensor, loadStyle });
  async function generate(backend, entry) {
    const start = performance.now(), options = { voice: entry.voice, speed: entry.speed };
    if (entry.mode !== 'stream') {
      const value = await backend.generate(entry.text, options);
      return { pcm: value.audio, phonemes: value.phonemes, elapsedMs: performance.now() - start, sourcePreserved: true };
    }
    const chunks = []; for await (const chunk of backend.stream(entry.text, options)) chunks.push(chunk);
    const pcm = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.audio.audio.length, 0)); let offset = 0;
    for (const chunk of chunks) { pcm.set(chunk.audio.audio, offset); offset += chunk.audio.audio.length; }
    return { pcm, phonemes: chunks.map(chunk => chunk.phonemes).join(' '), chunks: chunks.map(chunk => ({ text: chunk.text, samples: chunk.audio.audio.length })), elapsedMs: performance.now() - start,
      sourcePreserved: chunks.map(chunk => chunk.text).join('') === entry.text };
  }
  for (const entry of corpus.cases) {
    nativeOperations = {}; nativePatterns = new Map();
    const record = { ...entry, dialect: entry.voice[0] === 'b' ? 'en-gb' : 'en-us' };
    try {
      const traceStart = { candidate: traces.candidate.length, reference: traces.reference.length };
      const expected = await generate(reference, entry), actual = await generate(candidate, entry);
      record.audio = compareAudio(actual.pcm, expected.pcm, corpus.gates);
      record.phonemes = actual.phonemes; record.identicalPhoneInputs = actual.phonemes === expected.phonemes;
      record.inputTraces = Object.fromEntries(Object.entries(traces).map(([variant, inputs]) => [variant, inputs.slice(traceStart[variant])]));
      record.identicalInferenceInputs = JSON.stringify(record.inputTraces.candidate) === JSON.stringify(record.inputTraces.reference);
      record.sourcePreserved = actual.sourcePreserved && expected.sourcePreserved;
      record.candidateChunks = actual.chunks; record.referenceChunks = expected.chunks;
      record.diagnosticTiming = { candidateMs: actual.elapsedMs, referenceMs: expected.elapsedMs, acceptance: 'not an exclusive browser or weak-device benchmark' };
      if (profile && engine) record.nativeProfile = { operations: nativeOperations, topPatterns: [...nativePatterns.values()].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 12) };
      if (engine) record.arenaBytes = engine.memory.buffer.byteLength;
      if (browserSession) record.browser = await browserSession.snapshot();
      record.files = {}; record.rawPcm = {}; record.wavSha256 = {};
      for (const [variant, value] of [['candidate', actual], ['reference', expected]]) {
        const wav = waveBytes(value.pcm), raw = new Uint8Array(value.pcm.buffer, value.pcm.byteOffset, value.pcm.byteLength);
        record.files[variant] = `${entry.id}-${variant}.wav`; await writeFile(resolve(outputDirectory, record.files[variant]), wav, { flag: 'wx' });
        record.wavSha256[variant] = createHash('sha256').update(wav).digest('hex');
        record.rawPcm[variant] = { file: `${entry.id}-${variant}.f32`, bytes: raw.byteLength, sha256: createHash('sha256').update(raw).digest('hex') };
        await writeFile(resolve(outputDirectory, record.rawPcm[variant].file), raw, { flag: 'wx' });
      }
      record.functionalPass = record.audio.finitePass && record.audio.nonSilentPass && record.audio.durationPass && record.sourcePreserved && record.identicalPhoneInputs && record.identicalInferenceInputs;
      asrCases.push({ id: entry.id, expectedText: entry.text, language: 'en', candidate: resolve(outputDirectory, record.files.candidate), reference: resolve(outputDirectory, record.files.reference) });
    } catch (error) { record.failure = error.message; record.functionalPass = false; }
    if (arena) record.arena = structuredClone(arena);
    report.cases.push(record); await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(record));
  }
} finally {
  await candidate?.dispose(); if (!candidate) await candidateSession?.dispose();
  await reference?.dispose(); if (!reference) await referenceSession?.release();
  if (engine) {
    report.remainingBuffers = engine.buffers.size; report.remainingTensors = engine.tensors.size; report.resourceCleanup = !engine.buffers.size && !engine.tensors.size; await engine.dispose();
  } else if (browserSession) {
    const cleanup = await browserSession.dispose(); Object.assign(report, cleanup);
    report.resourceCleanup = !cleanup.remainingBuffers && !cleanup.remainingTensors;
  }
}
const manifestFile = resolve(outputDirectory, 'asr-manifest.json'), asrFile = resolve(outputDirectory, 'asr.json');
await writeFile(manifestFile, `${JSON.stringify({ cases: asrCases }, null, 2)}\n`);
const asrModel = option('--asr-model', null);
if (asrModel && asrCases.length) {
  await new Promise((done, reject) => {
    const child = spawn(option('--python', 'python'), [resolve(root, 'scripts/kokoro-asr-review.py'), '--manifest', manifestFile, '--model', asrModel, '--output', asrFile], { stdio: 'inherit', windowsHide: true });
    child.on('error', reject); child.on('exit', code => code === 0 ? done() : reject(new Error(`Offline ASR exited ${code}.`)));
  });
  const asr = JSON.parse(await readFile(asrFile)); report.asrModel = asr.model;
  for (const record of report.cases) {
    const output = asr.cases.find(entry => entry.id === record.id);
    if (output) { record.transcripts = output; record.semantic = compareTranscripts(output, record.text, record.dialect, corpus.gates); }
  }
}
report.implementationUnchangedDuringProbe = JSON.stringify(report.implementationPins) === JSON.stringify(await sourcePins());
report.functionalStatus = report.cases.length === corpus.cases.length && report.cases.every(record => record.functionalPass) && report.resourceCleanup && report.implementationUnchangedDuringProbe && !report.validationErrors?.length && !report.consoleErrors?.length ? 'pass' : 'fail';
report.semanticStatus = asrModel ? report.cases.every(record => record.semantic?.pass) ? 'pass' : 'fail' : 'not evaluated';
report.pcmStatus = report.cases.every(record => record.audio?.pcm.pass) ? 'pass' : 'fail';
report.status = report.functionalStatus === 'pass' && report.semanticStatus === 'pass' && report.pcmStatus === 'pass' ? 'automated gates pass; human listening pending' : 'acceptance incomplete or failed';
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
const cards = report.cases.map(record => `<section><h2>${escapeHtml(record.id)} · ${escapeHtml(record.voice)} · ${record.speed}×</h2><p>${escapeHtml(record.text)}</p><p>Functional: ${record.functionalPass}; semantic: ${record.semantic?.pass ?? 'pending'}; strict PCM: ${record.audio?.pcm.pass ?? false}</p>${['reference', 'candidate'].map(variant => record.files?.[variant] ? `<p>${variant}: ${escapeHtml(record.transcripts?.[variant].transcript ?? 'ASR pending')}</p><audio controls preload="none" src="${record.files[variant]}"></audio>` : '').join('')}<details><summary>Diagnostic evidence</summary><pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre></details></section>`).join('');
await writeFile(resolve(outputDirectory, 'review.html'), `<!doctype html><meta charset="utf-8"><title>Kokoro ${dtype} paired speech review</title><style>body{max-width:900px;margin:40px auto;background:#171a20;color:#eee;font:16px/1.5 system-ui}section{border-top:1px solid #555;padding:20px 0}audio{width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Kokoro ${dtype}: paired review</h1><p>Human listening pending. Automated status: ${escapeHtml(report.status)}. Frozen corpus SHA-256: ${corpusSha256}. Both paths use the same original phonemizer; this does not test parity with eSpeak.</p>${cards}`);
console.log(JSON.stringify({ reportFile, functionalStatus: report.functionalStatus, semanticStatus: report.semanticStatus, pcmStatus: report.pcmStatus }));
if (report.functionalStatus !== 'pass' || report.semanticStatus !== 'pass' || report.pcmStatus !== 'pass') process.exitCode = 1;
