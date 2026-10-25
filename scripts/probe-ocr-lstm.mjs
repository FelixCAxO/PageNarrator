// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Independent upstream math is a development oracle outside the repository runtime.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { TesseractLineModel } from '../src/engines/tesseract-line-model.js';
import { normalizeTesseractLine, decodeTesseractLine } from '../src/engines/tesseract-line-recognizer.js';

const oracle = process.env.PN_TESSERACT_ORACLE;
if (!oracle) throw new Error('Set PN_TESSERACT_ORACLE to the pinned development-only upstream posterior oracle directory.');
const directory = resolve('.cache/tesseract-english-candidate'), outputDirectory = resolve(directory, 'posterior-probe');
await mkdir(outputDirectory, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(directory, 'model.json'), 'utf8'));
const model = await TesseractLineModel.create(manifest, await readFile(resolve(directory, 'weights.bin')), await readFile('public/native/ocr-lstm-engine.wasm'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = JSON.parse(await readFile(resolve(oracle, 'oracle-sources.json'), 'utf8'));
const report = { status: 'incomplete', scope: 'Original retained English int8 network vs pinned independent upstream normalized-tensor posteriors. Resampling/normalization is original and is not independently image-quality accepted.',
  timingScope: 'CPU diagnostic only; concurrent host work uncontrolled', model: manifest.source, oracle: { sources, executableSha256: hash(await readFile(resolve(oracle, 'oracle.exe'))) },
  tolerance: { absolute: 3e-4, relative: 3e-3 }, cases: [] };
const cases = [];
for (const width of [3, 5, 31, 32, 33, 96, 320, 641]) cases.push({ name: `pattern-${width}`, width, data: Int8Array.from({ length: 36 * width }, (_, i) => (i * 13 + 7) % 255 - 127) });
for (const value of [-127, 0, 127]) cases.push({ name: `constant-${value}`, width: 96, data: new Int8Array(36 * 96).fill(value) });
cases.push({ name: 'changed-feed-replay', width: 96, data: Int8Array.from({ length: 36 * 96 }, (_, i) => (i * 17 + 23) % 255 - 127) });
const cropReport = JSON.parse(await readFile('artifacts/engines/ocr-source-crops.json', 'utf8'));
const imageBytes = await readFile(cropReport.input);
if (hash(imageBytes) !== cropReport.sha256) throw new Error('Frozen development crop image differs.');
const image = await sharp(imageBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
for (const [index, item] of cropReport.cases.entries()) {
  // Source factors already tested with the previous runtime; fixed original resampling
  // now maps the same source crop directly to the learned network's height.
  const input = normalizeTesseractLine({ data: image.data, width: image.info.width, height: image.info.height },
    { left: item.crop.left, top: item.crop.top, cropWidth: item.crop.width, cropHeight: item.crop.height });
  cases.push({ name: `frozen-crop-${index}`, ...input, crop: item.crop });
}
const extended = process.argv.includes('--extended');
if (extended) {
  for (const width of [3, 35, 320]) for (const seed of [1n, model.defaultSeed, 0xffffffffffffffffn]) cases.push({ name: `seed-${width}-${seed}`, seed, width,
    data: Int8Array.from({ length: 36 * width }, (_, i) => (i * 19 + 53) % 255 - 127) });
  cases.push({ name: 'maximum-width-8192', width: 8192, seed: 0n, data: Int8Array.from({ length: 36 * 8192 }, (_, i) => (i * 13 + 7) % 255 - 127) });
}
try {
  for (const [index, input] of cases.entries()) {
    const bytes = Buffer.alloc(12 + input.data.length); bytes.writeUInt32LE(36); bytes.writeUInt32LE(input.width, 4); bytes.writeUInt32LE(1, 8);
    bytes.set(new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength), 12);
    const inputPath = resolve(outputDirectory, `${index}.q8`), outputPath = resolve(outputDirectory, `${index}.f32`);
    await writeFile(inputPath, bytes);
    const seed = input.seed ?? 0n;
    execFileSync(resolve(oracle, 'oracle.exe'), [resolve(directory, 'reference-network.lstm'), inputPath, outputPath, ...(extended ? [String(seed)] : [])], { timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const expectedBytes = await readFile(outputPath), expected = new Float32Array(expectedBytes.buffer, expectedBytes.byteOffset + 8, (expectedBytes.length - 8) / 4);
    const start = performance.now(), actual = await model.runPixels(input.data, input.width, { seed }), elapsedMs = performance.now() - start;
    if (actual.dims.join(',') !== `${expectedBytes.readUInt32LE(0)},${expectedBytes.readUInt32LE(4)}`) throw new Error(`Posterior dimensions differ: ${input.name}`);
    let maxAbsolute = 0, toleranceFailures = 0, labelMismatches = 0;
    for (let frame = 0; frame < actual.dims[0]; frame++) {
      let actualBest = 0, expectedBest = 0;
      for (let c = 0; c < 111; c++) {
        const offset = frame * 111 + c, error = Math.abs(actual.data[offset] - expected[offset]);
        maxAbsolute = Math.max(maxAbsolute, error);
        if (!Number.isFinite(error) || error > 3e-4 + Math.abs(expected[offset]) * 3e-3) toleranceFailures++;
        if (actual.data[offset] > actual.data[frame * 111 + actualBest]) actualBest = c;
        if (expected[offset] > expected[frame * 111 + expectedBest]) expectedBest = c;
      }
      if (actualBest !== expectedBest) labelMismatches++;
    }
    const text = decodeTesseractLine(actual, manifest.alphabet, { left: 0, top: 0, height: 36, width: input.width, inputWidth: input.width }).map(word => word.text).join(' ');
    const replay = await model.runPixels(input.data, input.width, { seed });
    if (replay.data.some((value, i) => value !== actual.data[i])) throw new Error('English captured command replay changed deterministic output.');
    const result = { name: input.name, seed: String(seed), width: input.width, crop: input.crop, inputSha256: hash(bytes), outputSha256: hash(expectedBytes), dimensions: actual.dims,
      maxAbsolute, toleranceFailures, labelMismatches, elapsedMs, text, arenaBytes: model.engine.memory.buffer.byteLength, buffers: model.engine.buffers.size };
    report.cases.push(result); console.log(JSON.stringify(result));
    if (toleranceFailures || labelMismatches) throw new Error(`Original English posterior parity failed: ${input.name}`);
  }
  await model.clearPlan();
  report.retainedWeightBuffers = model.engine.buffers.size;
  await model.dispose();
  report.releasedBuffers = model.engine.buffers.size; report.releasedTensors = model.engine.tensors.size;
  if (report.releasedBuffers || report.releasedTensors) throw new Error('Original English runner retained disposed resources.');
  report.status = 'pass-posterior-parity-only';
} catch (error) { report.status = 'fail'; report.failure = error.stack; throw error; }
finally {
  await model.dispose(); await mkdir('artifacts/engines', { recursive: true });
  await writeFile(`artifacts/engines/ocr-lstm-posteriors${extended ? '-extended' : ''}.json`, `${JSON.stringify(report, null, 2)}\n`);
}
