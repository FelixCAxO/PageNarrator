// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Bounded, resumable development comparison of both complete text-to-PCM pipelines.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { makeQualityFreeze, readQualityFreeze, selectQualityCases, qualityFingerprint, hashQualityBytes, assessQualityTranscript } from './lib/kokoro-quality-controls.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const option = (name, fallback = null) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
if (process.argv.includes('--help')) {
  console.log('Original versus unmodified legacy full-pipeline quality diagnostic\n'
    + '--freeze <new-manifest.json> --cache <verified-model-dir> (rebuilds and pins the package; no inference)\n'
    + '--manifest <frozen-manifest.json> --cache <dir> --output <dir> --partition validation|test\n'
    + '--backend wasm|webgpu --voices af_heart|all|comma,list --cases comma,list --asr-model <offline-path>\n'
    + 'WebGPU requires explicit PN_GPU_ADAPTER_LUID and PN_GPU_VENDOR. Default validation/Heart/wasm.\n'
    + 'Final test is never used for tuning. ASR is separate from blinded listening; no release acceptance claim.');
} else {
  const cacheDirectory = resolve(option('--cache', `.cache/kokoro/onnx-community/Kokoro-82M-v1.0-ONNX`));
  const freezePath = option('--freeze');
  if (freezePath) {
    const path = resolve(freezePath), freeze = await makeQualityFreeze(root, cacheDirectory), bytes = `${JSON.stringify(freeze, null, 2)}\n`;
    await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, bytes, { flag: 'wx' });
    await writeFile(`${path}.sha256`, `${hashQualityBytes(bytes)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ manifest: path, sha256: hashQualityBytes(bytes), inferenceRun: false }));
  } else {
    const manifest = resolve(option('--manifest', 'artifacts/voice-listening/quality-freeze.json'));
    const freeze = await readQualityFreeze(root, manifest), partition = option('--partition', 'validation'), device = option('--backend', 'wasm');
    if (!['wasm', 'webgpu'].includes(device)) throw new Error('Quality requires an explicit CPU/WASM or WebGPU lane.');
    if (device === 'webgpu' && (!process.env.PN_GPU_ADAPTER_LUID || !process.env.PN_GPU_VENDOR)) throw new Error('Select the physical quality GPU explicitly.');
    const voices = option('--voices', 'af_heart') === 'all' ? freeze.corpus.voices : option('--voices', 'af_heart').split(',');
    const entries = selectQualityCases(freeze, { partition, voices, cases: option('--cases')?.split(',') ?? null });
    const outputDirectory = resolve(option('--output', 'artifacts/voice-listening/full-pipeline'));
    const groupId = qualityFingerprint({ manifest: hashQualityBytes(await readFile(manifest)), partition, device, voices, cases: entries.map(entry => entry.id),
      adapter: device === 'webgpu' ? `${process.env.PN_GPU_VENDOR}-${process.env.PN_GPU_ADAPTER_LUID}` : null }).slice(0, 20);
    const request = { manifest, partition, device, entries, cacheDirectory, outputDirectory, groupId };
    await mkdir(outputDirectory, { recursive: true });
    const requestPath = resolve(outputDirectory, `request-${groupId}.json`), requestBytes = `${JSON.stringify(request, null, 2)}\n`;
    try { await writeFile(requestPath, requestBytes, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST' || await readFile(requestPath, 'utf8') !== requestBytes) throw error; }
    const reportPath = resolve(outputDirectory, `assessment-${groupId}.json`), report = { status: 'incomplete', groupId, partition, device,
      manifestSha256: hashQualityBytes(await readFile(manifest)), corpusSha256: freeze.corpusSha256, scope: freeze.rules.scope, cases: [], listenerStudy: freeze.rules.listenerStudy };
    async function run(script, args) {
      await new Promise((done, reject) => { const child = spawn(process.execPath, [resolve(root, script), ...args], { stdio: 'inherit', windowsHide: true });
        child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error(`${script} failed (${code}).`))); });
    }
    try {
      // Separate process: the oracle's local-data fetch fixture cannot change the app's transport.
      await run('scripts/lib/kokoro-legacy-quality.mjs', [requestPath]);
      await run('scripts/probe-kokoro-registry.mjs', ['--quality-request', requestPath, '--backend', device, '--cache', cacheDirectory,
        '--output', resolve(outputDirectory, `registry-${groupId}.json`)]);
      const legacy = JSON.parse(await readFile(resolve(outputDirectory, `legacy-${groupId}.json`)));
      const candidate = JSON.parse(await readFile(resolve(outputDirectory, `candidate-${groupId}.json`)));
      if (legacy.records.length !== entries.length || candidate.records.length !== entries.length) throw new Error('Quality group coverage incomplete.');
      const asrManifest = { cases: entries.map(entry => { const original = candidate.records.find(record => record.entry.id === entry.id && record.entry.voice === entry.voice);
        const reference = legacy.records.find(record => record.entry.id === entry.id && record.entry.voice === entry.voice);
        return { id: `${entry.voice}-${entry.id}`, expectedText: entry.text, language: 'en', candidate: resolve(outputDirectory, original.wav.file), reference: resolve(outputDirectory, reference.wav.file) }; }) };
      const asrManifestPath = resolve(outputDirectory, `asr-manifest-${groupId}.json`), asrPath = resolve(outputDirectory, `asr-${groupId}.json`);
      await writeFile(asrManifestPath, `${JSON.stringify(asrManifest, null, 2)}\n`);
      const asrModel = option('--asr-model'); let asr = null;
      if (asrModel) {
        await new Promise((done, reject) => { const child = spawn(option('--python', 'python'), [resolve(root, 'scripts/kokoro-asr-review.py'), '--manifest', asrManifestPath,
          '--model', resolve(asrModel), '--output', asrPath], { stdio: 'inherit', windowsHide: true });
          child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error(`Offline quality ASR failed (${code}).`))); });
        asr = JSON.parse(await readFile(asrPath)); report.asrModel = asr.model;
      }
      for (const entry of entries) {
        const original = candidate.records.find(record => record.entry.id === entry.id && record.entry.voice === entry.voice);
        const reference = legacy.records.find(record => record.entry.id === entry.id && record.entry.voice === entry.voice), transcripts = asr?.cases.find(record => record.id === `${entry.voice}-${entry.id}`);
        report.cases.push({ entry, candidate: original, legacy: reference, assessment: transcripts ? {
          candidate: assessQualityTranscript(entry, transcripts.candidate.transcript, freeze.expectedSpoken),
          legacy: assessQualityTranscript(entry, transcripts.reference.transcript, freeze.expectedSpoken) } : null });
      }
      await readQualityFreeze(root, manifest);
      report.functionalStatus = 'pass';
      report.candidateTranscriptStatus = asr ? report.cases.every(record => record.assessment.candidate.completeTranscript && record.assessment.candidate.tailPass) ? 'pass' : 'fail' : 'not evaluated';
      report.legacyTranscriptStatus = asr ? report.cases.every(record => record.assessment.legacy.completeTranscript && record.assessment.legacy.tailPass) ? 'pass' : 'fail' : 'not evaluated';
      report.status = 'captured; formal listening and release acceptance not evaluated';
      if (report.candidateTranscriptStatus === 'fail') process.exitCode = 1;
    } catch (error) { report.status = 'failed'; report.failure = error.stack; process.exitCode = 1; }
    finally { await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); }
    console.log(JSON.stringify({ reportPath, status: report.status, functionalStatus: report.functionalStatus, candidateTranscriptStatus: report.candidateTranscriptStatus }));
  }
}
