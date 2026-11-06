// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Counterbalanced native A/B on captured production integer convolution operands, not full speech.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cpus } from 'node:os';
import { ensureMeasurementLock } from '../weak-hardware/measurement-lock.mjs';
import { WasmKokoroCompute } from '../../../src/engines/kokoro-cpu-compute.js';

const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const baseline = option('--baseline', null), fixtures = option('--fixtures', null);
assert(baseline && fixtures, 'Use --baseline original.wasm --fixtures captured/manifest.json [--candidate new.wasm] [--output new.json]');
const output = resolve(option('--output', `artifacts/engines/kokoro-conv-integer-${Date.now()}.json`));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => { values = values.toSorted((a,b) => a-b); return (values[(values.length-1)>>1]+values[values.length>>1])/2; };
const lock = await ensureMeasurementLock({ owner: { purpose: 'kokoro-conv-integer native kernel A/B' },
  onWait: holder => console.log('Waiting for measurement lock', holder?.pid) });
try {
  const manifest = JSON.parse(await readFile(fixtures, 'utf8'));
  const binaries = { baseline: await readFile(baseline), candidate: await readFile(option('--candidate', 'extension/public/native/kokoro-engine.wasm')) };
  assert.equal(manifest.nativeSha256, hash(binaries.baseline), 'Capture must come from the frozen baseline binary');
  const report = { scope: 'Node V8 native integer convolution kernel on captured production operands; not full synthesis, energy or audible latency.',
    node: process.version, cpu: cpus()[0]?.model, binarySha256: Object.fromEntries(Object.entries(binaries).map(([k,v]) => [k,hash(v)])),
    decisionRule: 'Exact baseline and captured output hashes; >=5% lower median process CPU in every shape; <=5% median wall regression.', cases: [] };
  assert(manifest.cases.length > 0);
  for (const fixture of manifest.cases) {
    assert.equal(fixture.name, 'pn_kokoro_conv_integer');
    const operands = await Promise.all(fixture.operands.map(async spec => {
      const bytes = await readFile(resolve(dirname(fixtures), spec.filename));
      assert.equal(hash(bytes),spec.sha256); assert.equal(bytes.length,spec.bytes); assert(['float32','int32','uint8','int8'].includes(spec.type));
      return { ...spec, data: new ({float32:Float32Array,int32:Int32Array,uint8:Uint8Array,int8:Int8Array}[spec.type])(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)) };
    }));
    const lanes = {};
    try {
      for (const name of ['baseline','candidate']) {
        const engine = await WasmKokoroCompute.create(binaries[name]); lanes[name] = { engine };
        const inputs = operands.slice(0,4).map(x => engine.upload(x.data,x.shape,x.type)), p = fixture.parameters;
        const right = (p[4]-1)*p[8]+(p[7]-1)*p[9]+1-p[2]-p[10];
        const batch = engine.batch({ capture: true });
        const out = engine.kokoro.convInteger(batch,...inputs,{strides:[p[8]],dilations:[p[9]],pads:[p[10],right],group:p[1]/p[5]}); batch.submit();
        Object.assign(lanes[name],{ batch,out });
      }
      for (let i=0;i<3;i++) for (const lane of Object.values(lanes)) lane.batch.replay();
      const samples=[];
      for (const name of ['baseline','candidate','candidate','baseline','candidate','baseline','baseline','candidate']) {
        const cpu=process.cpuUsage(),at=performance.now();
        for (let i=0;i<30;i++) lanes[name].batch.replay();
        const wallMs=performance.now()-at,used=process.cpuUsage(cpu);
        samples.push({name,replays:30,wallMs,cpuMs:(used.user+used.system)/1000});
      }
      const hashes={};
      for (const [name,lane] of Object.entries(lanes)) {
        const values=await lane.engine.read(lane.out); hashes[name]=hash(new Uint8Array(values.buffer,values.byteOffset,values.byteLength));
        assert.equal(hashes[name],operands[4].sha256,'Captured production output changed');
      }
      const stats=Object.fromEntries(['baseline','candidate'].map(name => [name,Object.fromEntries(['cpuMs','wallMs'].map(metric => [metric,median(samples.filter(s=>s.name===name).map(s=>s[metric]))]))]));
      const cpuReductionPercent=(1-stats.candidate.cpuMs/stats.baseline.cpuMs)*100,wallReductionPercent=(1-stats.candidate.wallMs/stats.baseline.wallMs)*100;
      const row={shape:operands[0].shape,parameters:fixture.parameters,operandSha256:operands.map(x=>x.sha256),hashes,samples,stats,cpuReductionPercent,wallReductionPercent,accepted:cpuReductionPercent>=5&&wallReductionPercent>=-5};
      report.cases.push(row);console.log(JSON.stringify({shape:row.shape,cpuReductionPercent,wallReductionPercent,accepted:row.accepted}));
    } finally { for (const {engine} of Object.values(lanes)) { await engine.dispose();assert.equal(engine.buffers.size,0);assert.equal(engine.tensors.size,0); } }
  }
  report.accepted=report.cases.every(x=>x.accepted);
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({accepted:report.accepted,output}));if(!report.accepted)process.exitCode=1;
} finally { lock.release(); }
