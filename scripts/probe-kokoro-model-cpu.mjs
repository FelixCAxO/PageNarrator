// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import * as oracle from 'onnxruntime-node';
import { WasmKokoroCompute } from '../src/engines/kokoro-cpu-compute.js';
import { WebGpuOnnxSession } from '../src/engines/webgpu-onnx-session.js';
import { createEnglishPhonemizer } from '../src/tts/kokoro/english-phonemizer.js';
import { createKokoroTokenizer } from '../src/tts/kokoro/tokenizer.js';
import { KOKORO_DATA } from '../src/tts/kokoro/model-data.js';
import { kokoroProbeModelMode, prepareKokoroProbeModel, requireNewKokoroProbeReport } from './lib/kokoro-probe-model.mjs';

const cacheIndex = process.argv.indexOf('--cache');
const directory = resolve(cacheIndex >= 0 ? process.argv[cacheIndex + 1] : `.cache/kokoro/${KOKORO_DATA.modelId}`);
const quick = process.argv.includes('--quick'), profile = process.argv.includes('--profile');
const fp32 = process.argv.includes('--fp32'), dtype = fp32 ? 'fp32' : 'q8';
const modelMode = kokoroProbeModelMode();
const captureIndex = process.argv.indexOf('--capture-kernels'), captureDirectory = captureIndex < 0 ? null : resolve(process.argv[captureIndex + 1]);
const captureOperationsIndex = process.argv.indexOf('--capture-operations');
const captureOperations = new Set(captureOperationsIndex < 0 ? ['pn_kokoro_conv_integer'] : process.argv[captureOperationsIndex + 1].split(','));
if ([...captureOperations].some(name => !['pn_kokoro_conv_integer', 'pn_kokoro_matmul_integer', 'pn_ocr_binary', 'pn_kokoro_integer_binary', 'pn_kokoro_dynamic_quantize', 'pn_kokoro_snake'].includes(name))) throw new Error('Unsupported diagnostic capture operation.');
const outputIndex = process.argv.indexOf('--output'), outputFile = outputIndex < 0 ? fileURLToPath(new URL(`../artifacts/engines/kokoro-cpu-${fp32 ? 'fp32-' : ''}model${modelMode === 'production' ? '-production' : ''}.json`, import.meta.url)) : resolve(process.argv[outputIndex + 1]);
if (captureDirectory && (outputIndex < 0 || !profile || !quick)) throw new Error('Kernel capture requires --quick --profile and a separate --output.');
await requireNewKokoroProbeReport(outputFile);
if (captureDirectory) await requireNewKokoroProbeReport(resolve(captureDirectory, 'manifest.json'));
const captured = new Map(), histogram = new Map();
const report = { status: 'incomplete', modelRevision: KOKORO_DATA.revision,
  dtype,
  reference: 'ONNX Runtime Node CPU, one thread, graph optimization disabled',
  modelMode, scope: `${modelMode === 'production' ? 'Same production phase-v2 graph on both paths' : 'Same unmodified retained graph on both paths'}; ${dtype}, identical phonemizer/token IDs/style/speed inputs. Numerical PCM and arena lifecycle, not listening/weak-device acceptance.`, cases: [] };
function wave(pcm) {
  const bytes = Buffer.alloc(44 + pcm.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(pcm.length * 2, 40);
  pcm.forEach((value, i) => bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2));
  return bytes;
}
async function verified(path) {
  const bytes = await readFile(resolve(directory, path)), file = KOKORO_DATA.files.find(item => item.path === path);
  if (!file || file.bytes !== bytes.byteLength || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Model data pin mismatch: ${path}.`);
  return bytes;
}
const engine = await WasmKokoroCompute.create(await readFile(new URL('../public/native/kokoro-engine.wasm', import.meta.url)));
let candidate, baseline, phonemizer;
let operations = {};
if (profile) {
  const invoke = engine.invoke.bind(engine);
  engine.invoke = (name, ...args) => {
    const start = performance.now();
    try { return invoke(name, ...args); }
    finally {
      const elapsedMs = performance.now() - start; operations[name] = (operations[name] ?? 0) + elapsedMs;
      if (captureDirectory && captureOperations.has(name)) {
        const [tensors, parameters] = args, key = `${name}:${[...parameters]}`, previous = captured.get(key);
        const summary = histogram.get(key) ?? { name, parameters: Array.from(parameters), shapes: tensors.map(tensor => tensor.shape), count: 0, elapsedMs: 0 };
        summary.count++; summary.elapsedMs += elapsedMs; histogram.set(key, summary);
        const group = [...captured].filter(([, value]) => value.name === name);
        if ((!previous || elapsedMs > previous.elapsedMs) && (group.length < 3 || previous || elapsedMs > Math.min(...group.map(([, value]) => value.elapsedMs)))) {
          const operands = (name === 'pn_kokoro_conv_integer' ? tensors.slice(0, 5) : tensors).map(tensor => ({ shape: tensor.shape, type: tensor.dataType,
            bytes: new Uint8Array(engine.memory.buffer, tensor.buffer.offset, tensor.length * tensor.elementBytes).slice() }));
          captured.set(key, { name, elapsedMs, parameters: Array.from(parameters), operands });
          const retained = [...captured].filter(([, value]) => value.name === name);
          if (retained.length > 3) captured.delete(retained.sort((a, b) => a[1].elapsedMs - b[1].elapsedMs)[0][0]);
        }
      }
    }
  };
  const allocate = engine.allocate.bind(engine);
  engine.allocate = bytes => {
    try { return allocate(bytes); }
    catch (error) {
      report.allocationFailure = { requestedBytes: bytes, arenaCursor: engine.cursor, memoryBytes: engine.memory.buffer.byteLength,
        liveBufferBytes: [...engine.buffers].reduce((sum, buffer) => sum + buffer.size, 0), freeBytes: engine.free.reduce((sum, buffer) => sum + buffer.size, 0),
        largestTensors: [...engine.tensors].sort((a, b) => b.buffer.size - a.buffer.size).slice(0, 12).map(tensor => ({ shape: tensor.shape, type: tensor.dataType, bytes: tensor.buffer.size, submitted: tensor.batch?.submitted ?? null })) };
      throw error;
    }
  };
}
try {
  const model = await verified(fp32 ? 'onnx/model.onnx' : 'onnx/model_quantized.onnx'); report.modelSha256 = createHash('sha256').update(model).digest('hex');
  const tokenizer = createKokoroTokenizer(JSON.parse(await verified('tokenizer.json')), JSON.parse(await verified('tokenizer_config.json')));
  phonemizer = await createEnglishPhonemizer({ wasmBinary: await readFile(new URL('../public/assets/phonemizer/english.wasm', import.meta.url)),
    pronunciationData: await readFile(new URL('../public/assets/phonemizer/pronunciations.bin', import.meta.url)) });
  const prepared = await prepareKokoroProbeModel(model, modelMode), probeModel = prepared.bytes;
  report.phaseCorrection = prepared.phaseCorrection;
  report.comparedModelSha256 = createHash('sha256').update(probeModel).digest('hex');
  candidate = await WebGpuOnnxSession.create(probeModel, { engine });
  baseline = await oracle.InferenceSession.create(probeModel, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'disabled' });
  const corpus = quick ? [['Hello.', 'af_heart', 1]] : [['Hello.', 'af_heart', 1], ['The browser reads this page.', 'am_michael', 1.25], ['Dr. Smith paid £12.50 on 2026-10-16.', 'bf_emma', .85]];
  for (const [text, voice, speed] of corpus) {
    const dialect = voice[0] === 'b' ? 'en-gb' : 'en-us', phones = await phonemizer.phonemizeText(text, dialect), ids = tokenizer.encode(phones, { strict: true });
    const styleBytes = await verified(`voices/${voice}.bin`), row = Math.min(509, ids.length - 2);
    const style = new Float32Array(styleBytes.buffer.slice(styleBytes.byteOffset + row * 1024, styleBytes.byteOffset + (row + 1) * 1024));
    const feeds = { input_ids: { shape: [1, ids.length], data: ids }, style: { shape: [1, 256], data: style }, speed: { shape: [1], data: Float32Array.of(speed) } };
    const expected = await baseline.run(Object.fromEntries(Object.entries(feeds).map(([name, feed]) => [name, new oracle.Tensor(name === 'input_ids' ? 'int64' : 'float32', feed.data, feed.shape)])));
    for (let repeat = 0; repeat < 2; repeat++) {
      operations = {}; const start = performance.now(), result = await candidate.run(feeds, ['waveform']);
      const elapsedMs = performance.now() - start, actual = result.waveform, other = expected.waveform;
      if (actual.shape.join(',') !== other.dims.join(',')) throw new Error(`Kokoro ${dtype} waveform shape differs (${actual.shape}/${other.dims}).`);
      let maximumAbsolute = 0, squareError = 0, squareReference = 0, mismatches = 0;
      for (let i = 0; i < actual.data.length; i++) {
        const a = actual.data[i], b = other.data[i], error = Math.abs(a - b);
        if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Nonfinite Kokoro ${dtype} waveform.`);
        maximumAbsolute = Math.max(maximumAbsolute, error); squareError += error * error; squareReference += b * b;
        if (error > 3e-4 + Math.abs(b) * 3e-3) mismatches++;
      }
      const record = { text, voice, speed, dialect, phones, tokens: [...ids].map(Number), repeat, samples: actual.data.length, elapsedMs,
        maximumAbsolute, relativeRmse: Math.sqrt(squareError / Math.max(1e-30, squareReference)), mismatches,
        arenaBytes: engine.memory.buffer.byteLength, stats: candidate.lastRun, ...(profile ? { operations } : {}) };
      if (repeat === 0) {
        const audioDirectory = `${outputFile.replace(/\.json$/u, '')}-audio`;
        await mkdir(audioDirectory, { recursive: true });
        const id = `${corpus.findIndex(item => item[0] === text)}-${voice}`;
        const candidateAudio = resolve(audioDirectory, `${id}-candidate.wav`), referenceAudio = resolve(audioDirectory, `${id}-reference.wav`);
        await writeFile(candidateAudio, wave(actual.data), { flag: 'wx' });
        await writeFile(referenceAudio, wave(other.data), { flag: 'wx' });
        record.audio = { candidate: relative(resolve(import.meta.dirname, '..'), candidateAudio),
          reference: relative(resolve(import.meta.dirname, '..'), referenceAudio), acceptance: 'diagnostic only; listening not evaluated' };
      }
      report.cases.push(record); console.log(JSON.stringify(record));
      if (mismatches) throw new Error(`Kokoro ${dtype} independent PCM parity failed.`);
    }
  }
  await candidate.dispose(); candidate = null;
  if (engine.buffers.size || engine.tensors.size) throw new Error(`Kokoro ${dtype} session leaked persistent arena storage.`);
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.failure = error.message; if (profile) report.partialOperations = operations; throw error; }
finally {
  await candidate?.dispose(); await baseline?.release(); phonemizer?.dispose();
  report.remainingBuffers = engine.buffers.size; report.remainingTensors = engine.tensors.size; await engine.dispose();
  await mkdir(new URL('../artifacts/engines/', import.meta.url), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  if (captureDirectory) {
    await mkdir(captureDirectory, { recursive: true }); const cases = [];
    for (const [index, record] of [...captured.values()].sort((a, b) => b.elapsedMs - a.elapsedMs).entries()) {
      const operands = [];
      for (const [operandIndex, operand] of record.operands.entries()) {
        const filename = `${record.name}-${index}-operand-${operandIndex}.bin`; await writeFile(resolve(captureDirectory, filename), operand.bytes, { flag: 'wx' });
        operands.push({ shape: operand.shape, type: operand.type, filename, bytes: operand.bytes.length, sha256: createHash('sha256').update(operand.bytes).digest('hex') });
      }
      cases.push({ name: record.name, elapsedMs: record.elapsedMs, parameters: record.parameters, operands });
    }
    await writeFile(resolve(captureDirectory, 'manifest.json'), `${JSON.stringify({ scope: 'Fixed actual original q8 Hello graph operands and exact original native output; profiling timing is diagnostic.',
      modelSha256: report.modelSha256, phaseCorrection: report.phaseCorrection, nativeSha256: createHash('sha256').update(await readFile(new URL('../public/native/kokoro-engine.wasm', import.meta.url))).digest('hex'), cases,
      histogram: [...histogram.values()].sort((a, b) => b.elapsedMs - a.elapsedMs) }, null, 2)}\n`, { flag: 'wx' });
  }
}
