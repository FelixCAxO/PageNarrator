import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const modulePath = fileURLToPath(import.meta.url);

export function loadPcmCorpus(resultsPath) {
  const runs = JSON.parse(readFileSync(resultsPath, 'utf8'));
  return runs.flatMap(run => run.measurements.map(measurement => {
    const file = path.resolve(path.dirname(resultsPath), 'audio', path.basename(measurement.pcmFile));
    const bytes = readFileSync(file);
    assert(bytes.length > 0 && bytes.length % 4 === 0, `Invalid PCM: ${file}`);
    assert.equal(sha256(bytes), measurement.pcmSha256, `PCM changed: ${file}`);
    return { id: `${run.runId}-${measurement.id}`, file, sha256: measurement.pcmSha256,
      text: measurement.text, phonemes: measurement.phonemes, sampleRate: measurement.sampleRate,
      samples: bytes.length / 4, voice: run.config.voice, backend: run.config.device };
  }));
}

// One browser, serialized workloads, alternating order; copied tensors and output allocation stay inside the timer.
async function browserSetup({ baselineSpeech, candidateSpeech, baselineDetector, candidateDetector, candidateUnwarp, candidateOcr, native }) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const bytes = value => new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const equal = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
  const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value))))
    .map(value => value.toString(16).padStart(2, '0')).join('');
  const started = performance.now();
  await native.initializeNativeKernels(new URL('/native/kernels.wasm', location.href).href);
  check(native.processPcm(new Float32Array([0, 0.5, 0]), 0.001, 0.05), 'Native PCM kernel unavailable');
  const initializationMs = performance.now() - started;
  const pcm = [];
  const tasks = [];
  const parity = [];
  const legacyPack = (pixels, width, height, mode, outputWidth = width, target = null, offset = 0) => {
    const count = width * height, stride = outputWidth * height;
    const result = target || new Float32Array(stride * 3);
    if (mode === 'unit') {
      for (let p = 0; p < count; p++) for (let c = 0; c < 3; c++) result[c * count + p] = pixels[p * 4 + 2 - c] / 255;
      return result;
    }
    for (let c = 0; c < 3; c++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const value = pixels[(y * width + x) * 4 + 2 - c];
      result[offset + c * stride + y * outputWidth + x] = mode === 'unit' ? value / 255
        : mode === 'signed' ? value / 127.5 - 1
          : (value / 255 - [0.485, 0.456, 0.406][c]) / [0.229, 0.224, 0.225][c];
    }
    return result;
  };
  const legacyUnpack = (planar, pixels) => {
    const count = pixels.length / 4;
    for (let p = 0; p < count; p++) for (let c = 0; c < 3; c++) pixels[p * 4 + c] = Math.round(planar[(2 - c) * count + p] * 255);
    return pixels;
  };
  const generate = async (api, item) => api.synthesizeSpeechChunk({ generate: async () => ({
    audio: item.data, sampling_rate: item.sampleRate, phonemes: item.phonemes,
  }) }, item.text, { voice: item.voice, languageCode: 'en', useStream: false });
  const image = async url => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
    return canvas;
  };
  const save = async (id, value) => {
    const response = await fetch(`/captures/${id}`, { method: 'POST', body: bytes(value) });
    check(response.ok, `Capture save failed: ${id}`);
    return { id, bytes: value.byteLength, sha256: await hash(value) };
  };
  const resized = (source, maximumSide) => {
    const scale = maximumSide / Math.max(source.width, source.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(source.width * scale); canvas.height = Math.round(source.height * scale);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  };
  globalThis.nativeBenchmark = {
    initializationMs,
    async prepareRemaining(imageInputs, recorded) {
      const source = await image('/images/0');
      const preview = document.createElement('canvas'); preview.width = preview.height = 240;
      const context = preview.getContext('2d'); context.drawImage(source, 0, 0, 240, 240);
      const pixels = context.getImageData(0, 0, 240, 240).data;
      const paper = candidateUnwarp.findOcrPaperInPixels(pixels), gutter = candidateOcr.findOcrGutterInPixels(pixels);
      const region = [paper.left, paper.right];
      const readPreview = () => { context.drawImage(source, 0, 0, 240, 240); return context.getImageData(0, 0, 240, 240).data; };
      const empty = new Uint8ClampedArray(pixels.length).fill(255);
      const colored = new Uint8ClampedArray(pixels.length);
      for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) colored.set(x >= 74 && x <= 172 && y >= 75 && y <= 164
        ? [160, 158, 155, 255] : [175, 115, 60, 255], (y * 240 + x) * 4);
      for (const [id, kind, current] of [
        ['paper-real-pixels', 'actual-photo-preview', () => candidateUnwarp.findOcrPaperInPixels(pixels)],
        ['paper-real-readback', 'actual-photo-preview-with-canvas', () => candidateUnwarp.findOcrPaperInPixels(readPreview())],
        ['paper-colored-control', 'calibrated-colored-frame-control', () => candidateUnwarp.findOcrPaperInPixels(colored)],
        ['gutter-real-pixels', 'portrait-preview-diagnostic-guarded-out-in-production', () => candidateOcr.findOcrGutterInPixels(pixels)],
        ['interior-real-pixels', 'actual-photo-preview', () => candidateDetector.hasPdfOcrInteriorInk(pixels, ...region)],
        ['interior-empty-control', 'calibrated-empty-preview-control', () => candidateDetector.hasPdfOcrInteriorInk(empty, 0, 1)],
      ]) tasks.push({ id, kind, inputBytes: pixels.byteLength, current });
      const outputs = [];
      for (const record of recorded.detectorRecords) outputs.push({ dims: record.outputDims,
        data: new Float32Array(await (await fetch(record.url)).arrayBuffer()) });
      let index = 0;
      const boxes = await candidateDetector.detectPdfOcrLines(source, { Tensor: class {
        constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
      } }, { inputNames: ['x'], outputNames: ['y'], run: async () => {
        const output = outputs[index++]; check(output, 'Unexpected recorded detector call');
        return { y: { dims: output.dims, data: output.data.slice() } };
      } });
      check(boxes.length === recorded.expectedBoxes && index === outputs.length, 'Recorded detector components changed');
      const tall = boxes.filter(box => box.y1 - box.y0 >= (box.x1 - box.x0) * 2);
      const readbacks = [];
      const tracked = { width: source.width, height: source.height, getContext: () => ({
        getImageData(x, y, width, height) { readbacks.push({ x, y, width, height, pixels: width * height });
          return source.getContext('2d').getImageData(x, y, width, height); },
      }) };
      const split = candidateDetector.splitPdfOcrTallComponents(tracked, boxes);
      tasks.push({ id: 'splitter-real-detector-boxes', kind: 'actual-photo-detector-output-replay',
        inputBytes: readbacks.reduce((sum, box) => sum + box.pixels * 4, 0), current: () => candidateDetector.splitPdfOcrTallComponents(source, boxes) });
      const large = document.createElement('canvas'); large.width = 1000; large.height = 4000;
      const largeContext = large.getContext('2d'); largeContext.fillStyle = 'rgb(220,220,220)'; largeContext.fillRect(0, 0, 1000, 4000);
      largeContext.fillStyle = 'rgb(100,100,100)';
      for (const [top, bottom] of [[300, 1100], [1500, 2200], [2800, 3600]]) largeContext.fillRect(0, top, 1000, bottom - top);
      const largeBox = { x0: 0, x1: 1000, y0: 0, y1: 4000, slope: 0, score: 0.9 };
      const largeSplit = candidateDetector.splitPdfOcrTallComponents(large, [largeBox]);
      check(largeSplit.length === 3, 'Tall grayscale control did not exercise splitting');
      tasks.push({ id: 'splitter-four-million-pixel-control', kind: 'calibrated-tall-grayscale-control-with-canvas', inputBytes: 16_000_000,
        current: () => candidateDetector.splitPdfOcrTallComponents(large, [largeBox]) });
      tasks.push({ id: 'readback-four-million-pixel-control', kind: 'calibrated-canvas-readback-control', inputBytes: 16_000_000,
        current: () => largeContext.getImageData(0, 0, 1000, 4000) });
      return { image: imageInputs[0], sourceWidth: source.width, sourceHeight: source.height, paper, gutter,
        gutterProductionSkipped: source.width < source.height * 1.2, interiorHasInk: candidateDetector.hasPdfOcrInteriorInk(pixels, ...region),
        detectorBoxes: boxes.length, tallConditionCount: tall.length, splitterResultBoxes: split.length,
        readbacks, actualScannedPixels: readbacks.reduce((sum, box) => sum + box.pixels, 0), largeControl: { width: 1000, height: 4000, resultBoxes: largeSplit },
        tasks: tasks.map(({ id, kind, inputBytes }) => ({ id, kind, inputBytes })) };
    },
    async prepare(corpus, imageInputs, captureOcr) {
      for (const item of corpus) {
        const data = new Float32Array(await (await fetch(`/pcm/${pcm.length}`)).arrayBuffer());
        check(await hash(data) === item.sha256 && data.every(Number.isFinite), `Invalid recording ${item.id}`);
        const recording = { ...item, data }; pcm.push(recording);
        const baseline = await generate(baselineSpeech, recording), candidate = await generate(candidateSpeech, recording);
        const left = new Uint8Array(await baseline.blob.arrayBuffer()), right = new Uint8Array(await candidate.blob.arrayBuffer());
        check(equal(left, right), `WAV mismatch: ${item.id}`);
        check(JSON.stringify(baseline.wordTimings) === JSON.stringify(candidate.wordTimings), `Timing mismatch: ${item.id}`);
        check(baseline.durationSeconds === candidate.durationSeconds, `Duration mismatch: ${item.id}`);
        parity.push({ id: item.id, kind: 'historical-real-pcm-replay', wavSha256: await hash(left),
          words: candidate.wordTimings.length, samples: data.length });
      }
      const representatives = [pcm.find(item => item.id.includes('wasm-af_heart') && item.id.endsWith('test-selection')),
        pcm.find(item => item.id.includes('wasm-af_heart') && item.id.endsWith('test-paragraph')),
        pcm.find(item => item.id.includes('webgpu-af_heart') && item.id.endsWith('test-paragraph'))].filter(Boolean);
      for (const item of representatives) tasks.push({ id: `speech-production-${item.id}`, kind: 'historical-real-pcm-replay',
        inputBytes: item.data.byteLength, baseline: () => generate(baselineSpeech, item), native: () => generate(candidateSpeech, item) });
      let ort, session, recognizer, alphabet;
      const captures = [];
      if (captureOcr) {
        const runtimeUrl = '/runtime/ort.webgpu.bundle.min.mjs';
        ort = await import(/* @vite-ignore */ runtimeUrl);
        ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = `${location.origin}/runtime/`;
        session = await ort.InferenceSession.create('/models/tiny-det.onnx', { executionProviders: ['webgpu'] });
        recognizer = await ort.InferenceSession.create('/models/small-rec.onnx', { executionProviders: ['webgpu'] });
        alphabet = await (await fetch('/models/small-rec-alphabet.json')).json();
      }
      try {
        for (let imageIndex = 0; imageIndex < imageInputs.length; imageIndex++) {
          const source = await image(`/images/${imageIndex}`);
          for (const maximumSide of [240, 640, 1280, 2000]) {
            const canvas = resized(source, maximumSide), { width, height } = canvas;
            const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
            for (const mode of ['unit', 'detector', 'signed']) {
              const outputWidth = mode === 'signed' ? Math.ceil(width / 128) * 128 : width;
              const left = legacyPack(pixels, width, height, mode, outputWidth), right = native.packRgba(pixels, width, height, mode, outputWidth);
              check(equal(bytes(left), bytes(right)), `OCR packing mismatch ${imageIndex}/${maximumSide}/${mode}`);
              const id = `rgba-${imageIndex}-${maximumSide}-${mode}`;
              parity.push({ id, kind: 'stored-photograph-resize', width, height, outputWidth, sha256: await hash(right) });
              tasks.push({ id, kind: 'stored-photograph-resize', inputBytes: pixels.byteLength,
                baseline: () => legacyPack(pixels, width, height, mode, outputWidth),
                native: () => native.packRgba(pixels, width, height, mode, outputWidth) });
              if (mode === 'unit') {
                const leftPixels = legacyUnpack(left, pixels.slice()), rightPixels = pixels.slice(); native.unpackRgb(left, rightPixels);
                check(equal(leftPixels, rightPixels), `OCR unpack mismatch ${imageIndex}/${maximumSide}`);
                tasks.push({ id: `unpack-${imageIndex}-${maximumSide}`, kind: 'identity-planar-control', inputBytes: left.byteLength,
                  baseline: () => legacyUnpack(left, pixels.slice()), native: () => native.unpackRgb(left, pixels.slice()) });
              }
            }
            canvas.width = canvas.height = 0;
          }
          const border = Math.ceil(Math.max(source.width, source.height) * 0.15);
          const pw = source.width + 2 * border, ph = source.height + 2 * border;
          const scale = Math.min(1, Math.sqrt(4_000_000 / (pw * ph)));
          const fullPage = document.createElement('canvas'); fullPage.width = Math.floor(pw * scale); fullPage.height = Math.floor(ph * scale);
          const context = fullPage.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, fullPage.width, fullPage.height);
          context.drawImage(source, border * fullPage.width / pw, border * fullPage.height / ph, source.width * fullPage.width / pw, source.height * fullPage.height / ph);
          const fullPixels = context.getImageData(0, 0, fullPage.width, fullPage.height).data;
          const fullPlanar = legacyPack(fullPixels, fullPage.width, fullPage.height, 'unit');
          check(equal(bytes(fullPlanar), bytes(native.packRgba(fullPixels, fullPage.width, fullPage.height))), 'Full-page unit packing mismatch');
          parity.push({ id: `unit-fullpage-${imageIndex}`, kind: 'production-padded-page-pixels', width: fullPage.width, height: fullPage.height,
            pixels: fullPage.width * fullPage.height, sha256: await hash(fullPlanar) });
          tasks.push({ id: `unit-fullpage-${imageIndex}`, kind: 'production-padded-page-pixels', inputBytes: fullPixels.byteLength,
            baseline: () => legacyPack(fullPixels, fullPage.width, fullPage.height, 'unit'),
            native: () => native.packRgba(fullPixels, fullPage.width, fullPage.height) });
          tasks.push({ id: `unpack-fullpage-${imageIndex}`, kind: 'identity-planar-control', inputBytes: fullPlanar.byteLength,
            baseline: () => legacyUnpack(fullPlanar, fullPixels.slice()), native: () => native.unpackRgb(fullPlanar, fullPixels.slice()) });
          if (session) {
            const recorded = [];
            const recordingSession = { inputNames: session.inputNames, outputNames: session.outputNames, async run(feeds) {
              const input = feeds[session.inputNames[0]], output = await session.run(feeds);
              const result = output[session.outputNames[0]];
              recorded.push({ input: input.data.slice(), inputDims: [...input.dims], output: result.data.slice(), outputDims: [...result.dims] });
              return output;
            } };
            const baselineBoxes = await baselineDetector.detectPdfOcrLines(source, ort, recordingSession);
            const replay = (api, verify = false) => {
              let index = 0;
              return api.detectPdfOcrLines(source, ort, { inputNames: session.inputNames, outputNames: session.outputNames,
                async run(feeds) {
                  const expected = recorded[index++], input = feeds[session.inputNames[0]];
                  check(expected, 'Unexpected detector inference call');
                  if (verify) check(equal(bytes(input.data), bytes(expected.input)), 'Production detector tensor mismatch');
                  return { [session.outputNames[0]]: new ort.Tensor('float32', expected.output.slice(), expected.outputDims) };
                } });
            };
            const candidateBoxes = await replay(candidateDetector, true);
            check(JSON.stringify(baselineBoxes) === JSON.stringify(candidateBoxes), 'Production detector component mismatch');
            for (const [index, record] of recorded.entries()) captures.push({ image: imageInputs[imageIndex], inputDims: record.inputDims,
              outputDims: record.outputDims, input: await save(`detector-${imageIndex}-${index}-input.f32`, record.input),
              output: await save(`detector-${imageIndex}-${index}-output.f32`, record.output) });
            parity.push({ id: `detector-${imageIndex}`, kind: 'fresh-detector-output-replay', boxes: candidateBoxes.length, calls: recorded.length });
            tasks.push({ id: `detector-production-${imageIndex}`, kind: 'fresh-detector-output-replay',
              inputBytes: recorded.reduce((sum, record) => sum + record.input.byteLength + record.output.byteLength, 0),
              baseline: () => replay(baselineDetector), native: () => replay(candidateDetector) });
            const lineBoxes = baselineBoxes.slice(0, 2); check(lineBoxes.length > 0, 'No real detector line crops');
            const line = document.createElement('canvas'); line.height = 48;
            const box = lineBoxes[0];
            for (const outputWidth of [320, 512, 1024, 2048, 4096, 8192]) {
              const cropPixels = [17, 51].map(padding => {
                line.width = outputWidth - padding;
                line.getContext('2d').drawImage(source, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, 0, 0, line.width, 48);
                return line.getContext('2d').getImageData(0, 0, line.width, 48).data;
              });
              const batch = api => {
                const stride = outputWidth * 48 * 3, target = new Float32Array(stride * 2);
                cropPixels.forEach((pixels, index) => api(pixels, pixels.length / 4 / 48, 48, 'signed', outputWidth, target, index * stride));
                return target;
              };
              const left = batch(legacyPack), right = batch(native.packRgba);
              check(equal(bytes(left), bytes(right)), `Signed batch tensor mismatch: ${outputWidth}`);
              parity.push({ id: `signed-batch-${outputWidth}`, kind: 'scaled-real-line-crop-control', outputWidth, height: 48,
                batch: 2, cropWidths: cropPixels.map(pixels => pixels.length / 4 / 48), sha256: await hash(right) });
              tasks.push({ id: `signed-batch-${outputWidth}`, kind: 'scaled-real-line-crop-control', inputBytes: cropPixels.reduce((sum, pixels) => sum + pixels.byteLength, 0),
                baseline: () => batch(legacyPack), native: () => batch(native.packRgba) });
            }
            line.width = line.height = 0;
            const recognizedRecords = [];
            const recordingRecognizer = { inputNames: recognizer.inputNames, async run(feeds) {
              const input = feeds[recognizer.inputNames[0]], outputs = await recognizer.run(feeds);
              recognizedRecords.push({ input: input.data.slice(), inputDims: [...input.dims], outputs: Object.fromEntries(Object.entries(outputs)
                .map(([name, tensor]) => [name, { type: tensor.type, dims: [...tensor.dims], data: tensor.data.slice() }])) });
              return outputs;
            } };
            const recognize = (api, recognitionSession) => api.recognizePdfOcrDetectedLines(source, ort, session, recognitionSession, alphabet, () => false, lineBoxes);
            const baselineLines = await recognize(baselineDetector, recordingRecognizer);
            const replayRecognizer = (api, verify = false) => {
              let index = 0;
              return recognize(api, { inputNames: recognizer.inputNames, async run(feeds) {
                const expected = recognizedRecords[index++]; check(expected, 'Unexpected recognizer call');
                if (verify) check(equal(bytes(feeds[recognizer.inputNames[0]].data), bytes(expected.input)), 'Production recognizer tensor mismatch');
                return Object.fromEntries(Object.entries(expected.outputs).map(([name, tensor]) => [name, new ort.Tensor(tensor.type, tensor.data.slice(), tensor.dims)]));
              } });
            };
            const candidateLines = await replayRecognizer(candidateDetector, true);
            check(JSON.stringify(baselineLines) === JSON.stringify(candidateLines), 'Production recognizer word/bounds mismatch');
            for (const [index, record] of recognizedRecords.entries()) captures.push({ image: imageInputs[imageIndex], inputDims: record.inputDims,
              input: await save(`recognizer-${imageIndex}-${index}-input.f32`, record.input), outputs: await Promise.all(Object.entries(record.outputs).map(async ([name, tensor]) => ({
                name, type: tensor.type, dims: tensor.dims, ...await save(`recognizer-${imageIndex}-${index}-${name.replaceAll('_', '-')}.${tensor.type === 'int64' ? 'i64' : 'f32'}`, tensor.data),
              }))) });
            parity.push({ id: `recognizer-${imageIndex}`, kind: 'fresh-recognizer-output-replay', lines: candidateLines.length,
              words: candidateLines.reduce((sum, item) => sum + item.words.length, 0), calls: recognizedRecords.length });
            tasks.push({ id: `recognizer-production-${imageIndex}`, kind: 'fresh-recognizer-output-replay',
              inputBytes: recognizedRecords.reduce((sum, record) => sum + record.input.byteLength, 0),
              baseline: () => replayRecognizer(baselineDetector), native: () => replayRecognizer(candidateDetector) });
          }
          if (!session) source.width = source.height = 0;
        }
      } finally { await Promise.all([session?.release(), recognizer?.release()]); }
      return { initializationMs, parity, captures, tasks: tasks.map(({ id, kind, inputBytes }) => ({ id, kind, inputBytes })) };
    },
    async sample(id, variant, minimumMs = 150) {
      const task = tasks.find(task => task.id === id); check(task, `Unknown workload ${id}`);
      const start = performance.now(); let iterations = 0, result;
      do { result = await task[variant](); iterations++; } while (performance.now() - start < minimumMs);
      // Keep the returned allocation observable without copying it into the protocol response.
      globalThis.nativeBenchmarkLastResult = result;
      return { id, variant, iterations, totalMs: performance.now() - start,
        jsHeapBytes: performance.memory?.usedJSHeapSize ?? null };
    },
  };
}

export async function run({ baselineSource, output = 'artifacts/native-kernels-2026-10-08',
  pcmResults = 'artifacts/feedback-2026-10-03/candidate-voices/results.json', repeats = 5,
  images = ['tmp/ocr-quality/docunet/35_1.jpg'], captureOcr = true, minimumMs = 150,
  remainingOnly = false, recordedResults = 'artifacts/native-kernels-final-2026-10-08/results.json' } = {}) {
  assert(baselineSource, 'Supply baselineSource pointing to a frozen pre-change source tree');
  assert(Number.isInteger(repeats) && repeats > 0 && Number.isFinite(minimumMs) && minimumMs > 0);
  const directory = path.resolve(root, output), bundle = path.join(directory, 'bundle'); mkdirSync(directory, { recursive: true });
  const corpus = remainingOnly ? [] : loadPcmCorpus(path.resolve(root, pcmResults)); assert(remainingOnly || corpus.length > 0, 'No historical recordings');
  const imageInputs = images.map(file => ({ file: path.resolve(root, file), sha256: sha256(readFileSync(path.resolve(root, file))) }));
  const sourcePaths = { baselineSpeech: path.resolve(baselineSource, 'src/lib/core/speech-audio.js'),
    candidateSpeech: path.join(root, 'src/lib/core/speech-audio.js'), baselineDetector: path.resolve(baselineSource, 'src/lib/pdf-ocr-detector.js'),
    candidateDetector: path.join(root, 'src/lib/pdf-ocr-detector.js'), candidateUnwarp: path.join(root, 'src/lib/pdf-ocr-unwarp.js'),
    candidateOcr: path.join(root, 'src/lib/pdf-ocr.js'), native: path.join(root, 'src/lib/native-kernels.js') };
  const identityPaths = { ...sourcePaths, candidateRecognizer: path.join(root, 'src/lib/pdf-ocr-neural-batch.js'),
    candidateUnwarp: path.join(root, 'src/lib/pdf-ocr-unwarp.js'), nativeFallback: path.join(root, 'src/lib/native-kernels-fallback.js'),
    baselineRecognizer: path.resolve(baselineSource, 'src/lib/pdf-ocr-neural-batch.js'), baselineUnwarp: path.resolve(baselineSource, 'src/lib/pdf-ocr-unwarp.js'),
    cpp: path.join(root, 'native/kernels.cpp'), metadata: path.join(root, 'public/native/kernels.json'),
    compiler: path.join(root, 'scripts/build-native-kernels.mjs'), harness: modulePath };
  const snapshot = path.join(directory, 'source-snapshot'); mkdirSync(snapshot, { recursive: true });
  const sourceHashes = Object.fromEntries(Object.entries(identityPaths).map(([name, file]) => {
    const content = readFileSync(file), savedFile = path.join(snapshot, `${name}-${path.basename(file)}`); writeFileSync(savedFile, content);
    return [name, { file, savedFile, sha256: sha256(content) }];
  }));
  const frozenWasm = path.join(snapshot, 'kernels.wasm'); writeFileSync(frozenWasm, readFileSync(path.join(root, 'public/native/kernels.wasm')));
  const wasmSha256 = sha256(readFileSync(frozenWasm));
  const imports = Object.entries(sourcePaths).map(([name, file]) => `import * as ${name} from ${JSON.stringify(file.replace(/\\/g, '/'))};`).join('\n');
  await build({ configFile: false, root, publicDir: false, logLevel: 'warn', plugins: [{ name: 'native-benchmark',
    resolveId(id) { if (id === 'native-benchmark') return '\0native-benchmark'; },
    load(id) { if (id === '\0native-benchmark') return `${imports}\nawait (${browserSetup.toString()})({${Object.keys(sourcePaths).join(',')}});`; },
  }], build: { target: 'esnext', outDir: bundle, emptyOutDir: true,
    rollupOptions: { input: 'native-benchmark', output: { entryFileNames: 'bench.js' } } } });
  const servedFiles = new Map([['/bench.js', path.join(bundle, 'bench.js')], ['/native/kernels.wasm', frozenWasm]]);
  corpus.forEach((item, index) => servedFiles.set(`/pcm/${index}`, item.file));
  imageInputs.forEach((item, index) => servedFiles.set(`/images/${index}`, item.file));
  const runtimeRoot = path.join(root, 'node_modules/onnxruntime-web/dist');
  for (const file of ['ort.webgpu.bundle.min.mjs', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) servedFiles.set(`/runtime/${file}`, path.join(runtimeRoot, file));
  servedFiles.set('/models/tiny-det.onnx', path.join(root, 'public/assets/ocr/tiny-det.onnx'));
  servedFiles.set('/models/small-rec.onnx', path.join(root, 'public/assets/ocr/small-rec.onnx'));
  servedFiles.set('/models/small-rec-alphabet.json', path.join(root, 'public/assets/ocr/small-rec-alphabet.json'));
  let recorded;
  if (remainingOnly) {
    const file = path.resolve(root, recordedResults), previous = JSON.parse(readFileSync(file, 'utf8'));
    const detectorRecords = previous.preparation.captures.filter(capture => capture.output && capture.input.id.startsWith('detector'));
    recorded = { expectedBoxes: previous.preparation.parity.find(item => item.id === 'detector-0').boxes,
      detectorRecords: detectorRecords.map((capture, index) => {
        const output = path.join(path.dirname(file), 'captures', capture.output.id), url = `/recorded/${index}`;
        assert.equal(sha256(readFileSync(output)), capture.output.sha256, 'Recorded probability bytes changed'); servedFiles.set(url, output);
        return { ...capture, url };
      }) };
  }
  const server = createServer(async (request, response) => {
    try {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/') return response.setHeader('Content-Type', 'text/html').end('<script type="module" src="/bench.js"></script>');
      if (request.method === 'POST' && /^\/captures\/[a-z0-9-]+\.(?:f32|i64)$/.test(pathname)) {
        const chunks = []; let length = 0;
        for await (const chunk of request) { length += chunk.length; assert(length <= 64 * 1024 * 1024); chunks.push(chunk); }
        const destination = path.join(directory, 'captures', path.basename(pathname)); mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, Buffer.concat(chunks)); return response.end('saved');
      }
      const file = servedFiles.get(pathname);
      if (!file || !existsSync(file)) return response.writeHead(404).end();
      response.setHeader('Content-Type', /\.(?:m?js)$/.test(file) ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
      response.setHeader('Content-Length', statSync(file).size); createReadStream(file).pipe(response);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), workload: remainingOnly
    ? 'Remaining current JavaScript pixel paths; actual-photo outputs and separate calibrated controls' : 'Historical PCM and fresh OCR tensor replay; no synthesis/inference/energy speed claim',
    sourceHashes, wasmSha256, executedBundleSha256: sha256(readFileSync(path.join(bundle, 'bench.js'))), corpus, images: imageInputs, repeats, samples: [], errors: [],
    measurementDefinitions: { totalMs: 'Browser elapsed cost including calls, input copies, output allocations and production Canvas where used',
      cpuSeconds: 'Cumulative CPU seconds across all threads of Chromium processes; includes GC and other browser work', jsHeapBytes: 'Sampled JS heap after batch; not RSS or peak memory' },
    unavailableMetrics: ['resident-memory savings', 'energy savings', 'fresh synthesis latency', 'inference latency reduction'] };
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--enable-precise-memory-info'] });
    report.browser = browser.version();
    const cdp = await browser.newBrowserCDPSession();
    const cpu = async () => (await cdp.send('SystemInfo.getProcessInfo')).processInfo.reduce((sum, item) => sum + item.cpuTime, 0);
    const page = await browser.newPage();
    page.on('pageerror', error => report.errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => globalThis.nativeBenchmark, { timeout: 30000 });
    report.preparation = remainingOnly
      ? await page.evaluate(({ imageInputs, recorded }) => globalThis.nativeBenchmark.prepareRemaining(imageInputs, recorded), { imageInputs, recorded })
      : await page.evaluate(({ corpus, imageInputs, captureOcr }) => globalThis.nativeBenchmark.prepare(corpus, imageInputs, captureOcr), { corpus, imageInputs, captureOcr });
    const variants = remainingOnly ? ['current'] : ['baseline', 'native'];
    for (const task of report.preparation.tasks) {
      for (const variant of variants) await page.evaluate(({ id, variant }) => globalThis.nativeBenchmark.sample(id, variant, 50), { id: task.id, variant });
      for (let repeat = 0; repeat < repeats; repeat++) for (const variant of repeat % 2 ? [...variants].reverse() : variants) {
        const before = await cpu();
        const sample = await page.evaluate(({ id, variant, minimumMs }) => globalThis.nativeBenchmark.sample(id, variant, minimumMs), { id: task.id, variant, minimumMs });
        const cpuSeconds = await cpu() - before;
        report.samples.push({ ...sample, repeat: repeat + 1, cpuSeconds, msPerCall: sample.totalMs / sample.iterations, cpuSecondsPerCall: cpuSeconds / sample.iterations });
      }
      console.log(JSON.stringify({ id: task.id, samples: report.samples.filter(sample => sample.id === task.id).length }));
    }
    report.summary = report.preparation.tasks.map(task => {
      const mean = variant => {
        const samples = report.samples.filter(sample => sample.id === task.id && sample.variant === variant);
        const calls = samples.reduce((sum, sample) => sum + sample.iterations, 0);
        const values = samples.map(sample => sample.msPerCall), average = values.reduce((sum, value) => sum + value, 0) / values.length;
        return { calls, msPerCall: samples.reduce((sum, sample) => sum + sample.totalMs, 0) / calls,
          cpuSecondsPerCall: samples.reduce((sum, sample) => sum + sample.cpuSeconds, 0) / calls,
          dispersion: { minMs: Math.min(...values), maxMs: Math.max(...values),
            standardDeviationMs: Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(1, values.length - 1)) } };
      };
      if (remainingOnly) return { ...task, current: mean('current') };
      const baseline = mean('baseline'), native = mean('native');
      const pairedElapsedRatios = Array.from({ length: repeats }, (_, repeat) => {
        const samples = report.samples.filter(sample => sample.id === task.id && sample.repeat === repeat + 1);
        return samples.find(sample => sample.variant === 'native').msPerCall / samples.find(sample => sample.variant === 'baseline').msPerCall;
      });
      return { ...task, baseline, native, elapsedRatio: native.msPerCall / baseline.msPerCall,
        cpuRatio: baseline.cpuSecondsPerCall > 0 ? native.cpuSecondsPerCall / baseline.cpuSecondsPerCall : null, pairedElapsedRatios };
    });
    report.sourceDrift = Object.entries(sourceHashes).filter(([, identity]) => sha256(readFileSync(identity.file)) !== identity.sha256).map(([name]) => name);
    report.wasmDrift = sha256(readFileSync(path.join(root, 'public/native/kernels.wasm'))) !== wasmSha256;
    assert.deepEqual(report.sourceDrift, [], 'Sources changed during benchmark'); assert.equal(report.wasmDrift, false, 'Wasm changed during benchmark');
    assert.deepEqual(report.errors, []); report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.errors.push(String(error)); throw error; }
  finally {
    writeFileSync(path.join(directory, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  if (process.argv[2] === '--self-check') {
    const corpus = loadPcmCorpus(path.join(root, 'artifacts/feedback-2026-10-03/candidate-voices/results.json'));
    assert.equal(corpus.length, 160); assert.equal(new Set(corpus.map(item => item.id)).size, 160);
    console.log('160 stored PCM identities verified.');
  } else {
    const config = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : { baselineSource: process.env.PN_NATIVE_BASELINE_SOURCE };
    await run(config);
  }
}
