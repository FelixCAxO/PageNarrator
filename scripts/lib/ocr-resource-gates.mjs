// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Reject absent evidence as well as measured failures; worker arenas are sampled before termination.
export function ocrResourceFailures(entry,backend){
  const failures=[],r=entry?.resources,positive=value=>Number.isFinite(value)&&value>0;
  if(entry?.actualBackend!==backend)failures.push('actual primary backend differs');
  if(!r||!Array.isArray(r.errors)||r.errors.length||r.workersRemaining!==0||r.workersAfterForcedCleanup!==0)
    failures.push('errors or worker closure evidence missing/failed');
  const page=r?.page,workers=r?.workerSnapshots;
  if(!Array.isArray(page?.engines)||!Array.isArray(page?.runs)||!Array.isArray(workers)||!Array.isArray(r?.workerRequests)){
    failures.push('engine/run observation arrays missing');return failures;
  }
  const cpu=workers.flatMap(s=>Array.isArray(s?.engines)?s.engines:[]);
  if(workers.some(s=>!Array.isArray(s?.engines)||!Array.isArray(s?.runs)))failures.push('worker observation malformed');
  if(cpu.some(e=>e.backend!=='wasm'||!positive(e.peakArenaBytes)||!positive(e.maximumArenaBytes)
    ||e.peakArenaBytes>e.maximumArenaBytes||e.maximumArenaBytes>512*1024*1024))failures.push('finite bounded CPU arena evidence failed');
  if(page.engines.some(e=>e.backend!=='webgpu'||e.closed!==true||e.remainingBuffers!==0||e.remainingTensors!==0
    ||e.liveBufferBytes!==0||e.unexpectedDeviceLoss!==false||e.completionError!==null))failures.push('GPU cleanup/device evidence failed');
  if(backend==='wasm'){
    if(!cpu.some(e=>positive(e.allocations)&&positive(e.peakArenaBytes)&&positive(e.maximumArenaBytes))
      ||!workers.some(s=>s.runs?.some(run=>run.backend==='wasm')))failures.push('no actual allocated CPU engine/run observed');
  }else if(backend==='webgpu'){
    if(!page.engines.some(e=>positive(e.allocations)&&positive(e.peakLiveBufferBytes))
      ||!page.runs.some(run=>run.backend==='webgpu'))failures.push('no actual allocated GPU engine/run observed');
  }else failures.push('unknown resource backend');
  return failures;
}
