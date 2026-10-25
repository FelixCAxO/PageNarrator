// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { decodeOnnxModel, summarizeOnnxModel } from '../src/engines/onnx-model.js';

const args = process.argv.slice(2);
const outputFlag = args.find(arg => arg.startsWith('--output='));
const paths = args.filter(arg => !arg.startsWith('--'));
if (!paths.length || args.some(arg => arg.startsWith('--') && arg !== outputFlag)) {
  throw new Error('Usage: node scripts/inspect-models.mjs model.onnx [...] [--output=inventory.json]');
}
const models = paths.map(path => {
  const data = readFileSync(path);
  const started = performance.now();
  const summary = summarizeOnnxModel(decodeOnnxModel(data));
  const decodeMs = performance.now() - started;
  return { file: basename(path), bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex'),
    decodeMs, ...summary };
});
const operators = [...new Set(models.flatMap(model => Object.keys(model.operators)))].sort();
const report = { models, operators };
if (outputFlag) {
  const output = resolve(outputFlag.slice('--output='.length));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
for (const model of models) {
  console.log(`${model.file}: ${model.nodes} nodes, ${Object.keys(model.operators).length} operators; ${Math.round(model.decodeMs)} ms metadata decode`);
}
console.log(`Required operators (${operators.length}): ${operators.join(', ')}`);
