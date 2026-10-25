// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development measurements; wraps allocation only, never model inputs/results.
const engines=[],runs=[];
export function observeOcrRun(session,feeds){runs.push({backend:'memory'in session.engine?'wasm':'webgpu',
  inputs:Object.fromEntries(Object.entries(feeds).map(([name,tensor])=>[name,tensor.shape])),outputs:session.outputNames});}
export function observeOcrEngine(engine){
  if(engines.some(item=>item.engine===engine))return engine;
  const bytes=()=>[...engine.buffers].reduce((sum,buffer)=>sum+buffer.size,0);
  const item={engine,allocations:0,peakLiveBufferBytes:bytes(),peakArenaBytes:engine.memory?.buffer.byteLength??null};
  const name=typeof engine.allocate==='function'?'allocate':'buffer',allocate=engine[name].bind(engine);
  engine[name]=(...args)=>{const value=allocate(...args);item.allocations++;item.peakLiveBufferBytes=Math.max(item.peakLiveBufferBytes,bytes());
    if(engine.memory)item.peakArenaBytes=Math.max(item.peakArenaBytes??0,engine.memory.buffer.byteLength);return value;};
  engines.push(item);return engine;
}
export function ocrEngineSnapshot(){
  return{scope:'Original engine-owned buffers and bounded WASM arena; excludes browser/JS/model/driver/process memory. Allocation observation adds timing overhead.',
    engines:engines.map(({engine,...peak})=>({...peak,backend:'memory'in engine?'wasm':'webgpu',closed:engine.closed,
      remainingBuffers:engine.buffers.size,remainingTensors:engine.tensors.size,
      liveBufferBytes:[...engine.buffers].reduce((sum,buffer)=>sum+buffer.size,0),arenaBytes:engine.memory?.buffer.byteLength??null,
      maximumArenaBytes:engine.maxBytes??null,nativeMemoryReleased:'memory'in engine?engine.memory===null:null,
      deviceLost:engine.lost?{reason:engine.lost.reason,message:engine.lost.message}:null,
      unexpectedDeviceLoss:Boolean(engine.lost&&!(engine.closed&&engine.lost.reason==='destroyed')),
      completionError:engine.completionError?{name:engine.completionError.name,message:engine.completionError.message}:null})),runs};
}
