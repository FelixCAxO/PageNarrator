// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readQualityFreeze, qualityFingerprint, qualitySourceAssociation, reusableQualityClip, saveQualityClip } from './kokoro-quality-controls.mjs';

export async function runKokoroQualityCandidate({ root, page, device, requestPath, report }) {
  const request = JSON.parse(await readFile(requestPath)), freeze = await readQualityFreeze(root, request.manifest);
  if (request.device !== device) throw new Error('Requested quality backend differs from the actual registry lane.');
  const dtype = device === 'wasm' ? 'q8' : 'fp32', lane = device === 'wasm' ? 'wasm' : `${report.adapter.vendor}-${process.env.PN_GPU_ADAPTER_LUID}`;
  const records = [];
  try {
    for (const entry of request.entries) {
      const key = `${request.partition}-${entry.voice}-${entry.id}-candidate-${lane}`;
      const fingerprint = qualityFingerprint({ corpus: freeze.corpusSha256, entry, dtype, lane, data: freeze.data,
        sourcePins: freeze.sourcePins, packagedBuild: freeze.packagedBuild, policy: 'Actual app registry/worker, raw fixture text into stream, phase correction enabled.' });
      let record = await reusableQualityClip(request.outputDirectory, key, fingerprint);
      if (!record) {
        const value = await page.evaluate(async ({ device, entry }) => {
          const model = await registry.ensureVoiceModel({ backendPlan: { device, dtype: device === 'wasm' ? 'q8' : 'fp32' }, warmupVoice: entry.voice,
            onFallback: error => { throw error; } });
          const chunks = []; for await (const chunk of model.stream(entry.text, { voice: entry.voice, speed: entry.speed })) {
            if (chunk.audio.sampling_rate !== 24000 || !(chunk.audio.audio instanceof Float32Array) || !chunk.audio.audio.length || !chunk.audio.audio.every(Number.isFinite)) throw new Error('Invalid actual-registry quality audio.');
            chunks.push({ text: chunk.text, phonemes: chunk.phonemes, audio: Array.from(chunk.audio.audio) });
          }
          return { modelInfo: model.modelInfo, chunks };
        }, { device, entry });
        const graph = freeze.data.files.find(file => file.path === (device === 'wasm' ? 'onnx/model_quantized.onnx' : 'onnx/model.onnx'));
        if (value.modelInfo?.originalSha256 !== graph.sha256 || value.modelInfo?.version !== 'kokoro-exact-zero-phase-v2') throw new Error('Actual quality graph or correction policy differs from the frozen lane.');
        const sourceAssociation = qualitySourceAssociation(entry.text, value.chunks);
        const pcm = Float32Array.from(value.chunks.flatMap(chunk => chunk.audio));
        record = await saveQualityClip(request.outputDirectory, key, pcm, { fingerprint, entry, variant: 'original-full-pipeline', dtype, backend: lane,
          modelInfo: value.modelInfo, sourceAssociation, chunks: value.chunks.map(({ text, phonemes, audio }) => ({ text, phonemes, samples: audio.length })) });
      }
      records.push(record); console.log(JSON.stringify({ variant: 'candidate', lane, voice: entry.voice, id: entry.id, samples: record.samples }));
    }
  } finally { await page.evaluate(() => registry.releaseVoiceModel()); }
  const ownership = await page.evaluate(() => ({ created: workerEvents.filter(value => value.event === 'created').length, terminated: workerEvents.filter(value => value.event === 'terminated').length,
    coordinators: workerEvents.filter(value => value.event === 'created' && value.role === 'coordinator').length,
    helpers: workerEvents.filter(value => value.event === 'created' && value.role === 'helper').length,
    workers: workerEvents.filter(value => value.event === 'created').map(value => value.url) }));
  if (ownership.created !== ownership.terminated) throw new Error('Quality worker survived disposal.');
  if (!ownership.created || ownership.workers.some(url => !new URL(url).pathname.startsWith('/packaged/assets/'))) throw new Error('Quality capture did not execute the frozen packaged workers.');
  const parallelCpu = device === 'wasm' && report.cpuCapabilities?.isolated && report.cpuCapabilities.sharedArrayBuffer && report.cpuCapabilities.atomicsWait && report.cpuCapabilities.logicalCores >= 4;
  if (ownership.created && (ownership.coordinators !== 1 || ownership.helpers !== (parallelCpu ? 3 : 0))) throw new Error('Actual quality worker selection differs from the frozen production capability policy.');
  await readQualityFreeze(root, request.manifest);
  report.quality = { records, ownership, cpuCapabilities: report.cpuCapabilities, lane, scope: freeze.rules.scope };
  await writeFile(resolve(request.outputDirectory, `candidate-${request.groupId}.json`), `${JSON.stringify(report.quality, null, 2)}\n`);
}
