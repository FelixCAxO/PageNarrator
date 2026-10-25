import{expect,it}from'vitest';
import{ocrResourceFailures}from'../../scripts/lib/ocr-resource-gates.mjs';

const cpuEngine=()=>({backend:'wasm',allocations:3,peakArenaBytes:131072,maximumArenaBytes:512*1024*1024});
const gpuEngine=()=>({backend:'webgpu',allocations:3,peakLiveBufferBytes:64,closed:true,remainingBuffers:0,remainingTensors:0,
  liveBufferBytes:0,unexpectedDeviceLoss:false,completionError:null});
function entry(backend){return{actualBackend:backend,resources:{errors:[],workersRemaining:0,workersAfterForcedCleanup:0,workerRequests:[],
  page:{engines:backend==='webgpu'?[gpuEngine()]:[],runs:backend==='webgpu'?[{backend:'webgpu'}]:[]},
  workerSnapshots:backend==='wasm'?[{engines:[cpuEngine()],runs:[{backend:'wasm'}]}]:[]}};}
it.each(['wasm','webgpu'])('accepts positively observed allocated %s with bounded/closed resources',backend=>{
  expect(ocrResourceFailures(entry(backend),backend)).toEqual([]);
});
it.each([null,undefined,{actualBackend:'wasm'},{actualBackend:'wasm',resources:{}}])('rejects absent/null resource evidence',value=>{
  expect(ocrResourceFailures(value,'wasm').length).toBeGreaterThan(0);
});
it.each(['wasm','webgpu'])('rejects empty engine/run telemetry for %s',backend=>{
  const value=entry(backend);value.resources.page={engines:[],runs:[]};value.resources.workerSnapshots=[];
  expect(ocrResourceFailures(value,backend).length).toBeGreaterThan(0);
});
it.each([null,0,NaN,Infinity,512*1024*1024+65536])('rejects missing/nonfinite/oversized CPU peak %s',peak=>{
  const value=entry('wasm');value.resources.workerSnapshots[0].engines[0].peakArenaBytes=peak;
  expect(ocrResourceFailures(value,'wasm').length).toBeGreaterThan(0);
});
it('rejects a CPU allocation without an actual model run or bounded maximum',()=>{
  const value=entry('wasm');value.resources.workerSnapshots[0].runs=[];
  expect(ocrResourceFailures(value,'wasm').length).toBeGreaterThan(0);
  value.resources.workerSnapshots[0].runs=[{backend:'wasm'}];value.resources.workerSnapshots[0].engines[0].maximumArenaBytes=null;
  expect(ocrResourceFailures(value,'wasm').length).toBeGreaterThan(0);
});
it.each(['allocations','peakLiveBufferBytes'])('rejects a zero observed GPU %s',field=>{
  const value=entry('webgpu');value.resources.page.engines[0][field]=0;
  expect(ocrResourceFailures(value,'webgpu').length).toBeGreaterThan(0);
});
it('rejects unobserved GPU runs, residual buffers, device errors and forced worker cleanup',()=>{
  for(const change of[v=>v.resources.page.runs=[],v=>v.resources.page.engines[0].remainingBuffers=1,
    v=>v.resources.page.engines[0].completionError={message:'failed'},v=>v.resources.workersRemaining=1]){
    const value=entry('webgpu');change(value);expect(ocrResourceFailures(value,'webgpu').length).toBeGreaterThan(0);
  }
});
