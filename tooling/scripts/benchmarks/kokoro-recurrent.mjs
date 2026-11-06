// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Same-process, counterbalanced native recurrent-kernel A/B; full speech is a separate gate.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cpus } from 'node:os';
import { ensureMeasurementLock } from '../weak-hardware/measurement-lock.mjs';
import { WasmKokoroCompute } from '../../../src/engines/kokoro-cpu-compute.js';
import { kokoroRecurrentFixture } from '../../../tests/helpers/kokoro-recurrent-fixture.js';

const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const baseline = option('--baseline', null), candidate = option('--candidate', 'extension/public/native/kokoro-engine.wasm');
assert(baseline, 'Usage: node tooling/scripts/benchmarks/kokoro-recurrent.mjs --baseline <original.wasm> [--candidate <new.wasm>] [--output <new.json>]');
const output = resolve(option('--output', `artifacts/engines/kokoro-recurrent-${Date.now()}.json`));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => { const sorted = values.toSorted((a, b) => a - b); return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2; };
const lock = await ensureMeasurementLock({ owner: { purpose: 'kokoro-recurrent native kernel A/B' },
  onWait: holder => console.log('Waiting for measurement lock', holder?.pid) });
try {
  const binaries = { baseline: await readFile(baseline), candidate: await readFile(candidate) };
  const report = { scope: 'Native recurrent kernel in Node V8; process CPU includes synchronous JS replay. Not full synthesis, browser CPU, energy or audible latency.',
    node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
    binarySha256: Object.fromEntries(Object.entries(binaries).map(([name, bytes]) => [name, hash(bytes)])),
    decisionRule: 'Exact output/state hashes; median process CPU reduction >=5% in each shape; median wall latency regression <=5%.', cases: [] };
  for (const config of [{ steps: 32, hidden: 256, features: 640, batch: 1 }, { steps: 128, hidden: 256, features: 640, batch: 1 }]) {
    const fixture = kokoroRecurrentFixture(config), lanes = {};
    try {
      for (const name of ['baseline', 'candidate']) {
        const engine = await WasmKokoroCompute.create(binaries[name]); lanes[name] = { engine };
        const inputs = fixture.specs.map(([data, shape, type]) => engine.upload(data, shape, type));
        const batch = engine.batch({ capture: true }), outputs = engine.kokoro.dynamicQuantizeLstm(batch, ...inputs, fixture.options);
        batch.submit(); Object.assign(lanes[name], { batch, outputs });
      }
      // Warm both independently before the frozen ABBA/BAAB sequence.
      for (let i = 0; i < 3; i++) for (const name of ['baseline', 'candidate']) lanes[name].batch.replay();
      const samples = [];
      for (const name of ['baseline', 'candidate', 'candidate', 'baseline', 'candidate', 'baseline', 'baseline', 'candidate']) {
        const cpu = process.cpuUsage(), start = performance.now();
        for (let i = 0; i < 30; i++) lanes[name].batch.replay();
        const wallMs = performance.now() - start, used = process.cpuUsage(cpu);
        samples.push({ name, wallMs, cpuMs: (used.user + used.system) / 1000, replays: 30 });
      }
      const hashes = {};
      for (const name of ['baseline', 'candidate']) hashes[name] = await Promise.all(lanes[name].outputs.map(async tensor => hash(new Uint8Array((await lanes[name].engine.read(tensor)).buffer))));
      assert.deepEqual(hashes.candidate, hashes.baseline, 'Recurrent outputs or final states changed');
      const stats = Object.fromEntries(['baseline', 'candidate'].map(name => [name, Object.fromEntries(['wallMs', 'cpuMs'].map(metric => [metric, median(samples.filter(x => x.name === name).map(x => x[metric]))]))]));
      const cpuReductionPercent = (1 - stats.candidate.cpuMs / stats.baseline.cpuMs) * 100;
      const wallReductionPercent = (1 - stats.candidate.wallMs / stats.baseline.wallMs) * 100;
      const row = { config, fixtureSha256: fixture.specs.map(([data]) => hash(new Uint8Array(data.buffer))), samples, hashes, stats, cpuReductionPercent, wallReductionPercent,
        accepted: cpuReductionPercent >= 5 && wallReductionPercent >= -5 };
      report.cases.push(row); console.log(JSON.stringify({ config, cpuReductionPercent, wallReductionPercent, accepted: row.accepted }));
    } finally { for (const { engine } of Object.values(lanes)) { await engine.dispose(); assert.equal(engine.buffers.size, 0); assert.equal(engine.tensors.size, 0); } }
  }
  report.accepted = report.cases.every(row => row.accepted);
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ accepted: report.accepted, output }));
  if (!report.accepted) process.exitCode = 1;
} finally { lock.release(); }
