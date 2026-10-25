// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Measures original registry calls; no upstream runtime or cache patches.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { waveBytes } from './kokoro-speech-acceptance.mjs';

export async function measureKokoroWorker(page, { device, entry, phase, repeat, captureAudio = false }) {
  return page.evaluate(async ({ device, entry, phase, repeat, captureAudio }) => {
    const progress = [], longTasks = [], beats = [];
    const supported = PerformanceObserver.supportedEntryTypes.includes('longtask');
    const observer = supported ? new PerformanceObserver(list => longTasks.push(...list.getEntries().map(value => ({ startTime: value.startTime, duration: value.duration })))) : null;
    observer?.observe({ type: 'longtask' });
    let previous = performance.now();
    const timer = setInterval(() => { const now = performance.now(); beats.push(now - previous); previous = now; }, 25);
    const start = performance.now(); let readyAt, firstAt = null, completeAt;
    try {
      const model = await registry.ensureVoiceModel({ backendPlan: { device, dtype: device === 'wasm' ? 'q8' : 'fp32' },
        warmupVoice: entry.voice, ...(entry.mode === 'batch' ? { warmupText: entry.text } : {}), onProgress: value => progress.push(value),
        onFallback: error => { throw error; } });
      readyAt = performance.now();
      const worker = performanceWorkers.at(-1);
      const before = await worker.snapshot(), chunks = [];
      const iterator = entry.mode === 'batch' ? (async function* () { yield { text: entry.text, audio: await model.generate(entry.text, { voice: entry.voice, speed: entry.speed }) }; })()
        : model.stream(entry.text, { voice: entry.voice, speed: entry.speed });
      for await (const chunk of iterator) {
        firstAt ??= performance.now();
        if (!(chunk.audio?.audio instanceof Float32Array) || !chunk.audio.audio.length || !chunk.audio.audio.every(Number.isFinite)) throw new Error('Invalid benchmark audio.');
        chunks.push({ text: chunk.text, pcm: chunk.audio.audio, sampleRate: chunk.audio.sampling_rate, phonemes: chunk.phonemes ?? chunk.audio.phonemes });
      }
      completeAt = performance.now();
      const heartbeat = { heartbeatTicks: beats.length, maximumHeartbeatGapMs: Math.max(completeAt - previous, ...beats), nominalHeartbeatMs: 25 };
      const native = await worker.snapshot();
      if (!native.engines.length || native.engines.some(engine => engine.backend !== device)) throw new Error('The requested benchmark backend fell back to a different engine.');
      if (native.engines.some(engine => engine.deviceLost || engine.completionError)) throw new Error('Original worker benchmark recorded a GPU loss or completion error.');
      if (!chunks.length || chunks.map(value => value.text).join('') !== entry.text || chunks.some(chunk => chunk.sampleRate !== 24000)) throw new Error('Benchmark source or sample rate changed.');
      const pcm = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.pcm.length, 0)); let offset = 0, squares = 0;
      for (const chunk of chunks) { pcm.set(chunk.pcm, offset); offset += chunk.pcm.length; }
      for (const value of pcm) squares += value * value;
      if (Math.sqrt(squares / pcm.length) < .001) throw new Error('Benchmark speech is silent.');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pcm));
      let pcmBase64;
      if (captureAudio) {
        const bytes = new Uint8Array(pcm.buffer); let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        pcmBase64 = btoa(binary);
      }
      if (observer) longTasks.push(...observer.takeRecords().map(value => ({ startTime: value.startTime, duration: value.duration })));
      return { id: entry.id, voice: entry.voice, speed: entry.speed, mode: entry.mode, phase, repeat, device,
        modelInfo: model.modelInfo, modelReadyMs: readyAt - start, firstAudioReadyMs: firstAt - start, completionMs: completeAt - start, ...(captureAudio ? { pcmBase64 } : {}),
        synthesisAfterReadyMs: completeAt - readyAt, audioSeconds: pcm.length / 24000, pcmFloat32Sha256: [...digest].map(value => value.toString(16).padStart(2, '0')).join(''),
        chunks: chunks.map(({ text, phonemes, pcm }) => ({ text, phonemes, samples: pcm.length })),
        warmupPolicy: entry.mode === 'batch' ? 'Opening-text prefetch, including actual cold model feeds.' : 'No opening-text prefetch; preserves identical requested streaming chunks.',
        nativeInputs: native.inputs.slice(entry.mode === 'batch' && phase === 'runtime-cold' ? 0 : before.inputs.length), resources: { ...native, inputs: undefined }, progress,
        ui: { longTaskSupport: supported, longTasks: supported ? longTasks.filter(value => value.startTime >= start && value.startTime < completeAt) : null,
          ...heartbeat } };
    } finally {
      clearInterval(timer); observer?.disconnect();
    }
  }, { device, entry, phase, repeat, captureAudio });
}

export async function runKokoroWorkerBenchmark({ page, device, corpus, repeats, report, captureDirectory = null }) {
  for (const entry of corpus.cases) {
    await page.evaluate(() => registry.releaseVoiceModel());
    for (let repeat = 0; repeat <= repeats; repeat++) {
      const result = await measureKokoroWorker(page, { device, entry, repeat, phase: repeat ? 'warm' : 'runtime-cold', captureAudio: Boolean(captureDirectory) });
      if (captureDirectory) {
        await mkdir(captureDirectory, { recursive: true });
        const raw = Buffer.from(result.pcmBase64, 'base64'), pcm = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)); delete result.pcmBase64;
        if (createHash('sha256').update(raw).digest('hex') !== result.pcmFloat32Sha256) throw new Error('Captured raw PCM transport changed.');
        const wav = waveBytes(pcm), rawFile = resolve(captureDirectory, `${device}-${entry.id}-${repeat}.f32`), wavFile = rawFile.replace(/\.f32$/, '.wav');
        await writeFile(rawFile, raw, { flag: 'wx' }); await writeFile(wavFile, wav, { flag: 'wx' });
        result.recording = { rawFloat32: { file: rawFile, bytes: raw.length, sha256: result.pcmFloat32Sha256 }, wav: { file: wavFile, bytes: wav.length, sha256: createHash('sha256').update(wav).digest('hex') } };
      }
      const first = report.cases.find(value => value.device === device && value.id === entry.id);
      result.identicalToFirst = !first || (result.pcmFloat32Sha256 === first.pcmFloat32Sha256
        && JSON.stringify(result.nativeInputs) === JSON.stringify(first.nativeInputs)
        && JSON.stringify(result.chunks) === JSON.stringify(first.chunks));
      report.cases.push(result);
      console.log(JSON.stringify({ id: entry.id, device, repeat, completionMs: result.completionMs, firstAudioReadyMs: result.firstAudioReadyMs, identical: result.identicalToFirst }));
      if (!result.identicalToFirst) throw new Error('Frozen cold/warm speech or model feeds changed.');
    }
    await page.evaluate(() => registry.releaseVoiceModel());
  }
  await page.waitForFunction(() => performanceWorkers.every(worker => worker.probeTerminated));
  report.workerPerformance = await page.evaluate(() => performanceWorkers.map(worker => ({ id: worker.probeId, terminated: worker.probeTerminated,
    final: worker.final ?? null, cpuCleanupScope: worker.final ? null : 'CPU synchronous execution is preempted by Worker.terminate; the execution context closes, so native counters are unavailable afterward.' })));
  if (report.workerPerformance.some(worker => worker.final && (!worker.final.modelReferencesReleased || worker.final.phonemizerNativeBytes
    || worker.final.engines.some(engine => !engine.closed || engine.remainingBuffers || engine.remainingTensors
      || engine.unexpectedDeviceLoss || engine.completionError)))) throw new Error('Original worker benchmark retained native resources or recorded a GPU failure.');
}
