import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { WasmOcrCompute } from '../../src/engines/wasm-ocr-compute.js';

const operations = { Add:(a,b)=>a+b, Mul:(a,b)=>a*b, Div:(a,b)=>a/b, Sub:(a,b)=>a-b };
const cases = [
  [[2,3,7],[1,3,1],[2,3,7]], [[1,3,1],[2,3,9],[2,3,9]],
  [[2,1,5],[1,3,5],[2,3,5]], [[2,3,1,5],[1,3,4,1],[2,3,4,5]],
  [[2,3,5],[5],[2,3,5]], [[1],[2,3,5],[2,3,5]], [[2,3,5],[],[2,3,5]],
  [[2,3,1],[1,3,1],[2,3,1]], [[2,3,2],[1,3,1],[2,3,2]], [[2,3,3],[1,3,1],[2,3,3]],
  [[17],[17],[17]], [[],[],[]],
];
const size = shape => shape.reduce((product,value)=>product*value,1);
const values = [0,-0,Infinity,-Infinity,NaN,2**-149,-(2**-149),1,-1,1+2**-23,1e20,-1e-20,3.5];
const make = (shape,shift) => Float32Array.from({length:size(shape)},(_,i)=>values[(i*7+shift)%values.length]);

// Independent scalar coordinates: no runtime stride planner or native indexer.
function sourceIndex(index, outputShape, inputShape) {
  const coordinates=new Array(outputShape.length);
  for(let axis=outputShape.length-1;axis>=0;axis--){coordinates[axis]=index%outputShape[axis];index=Math.floor(index/outputShape[axis]);}
  let result=0;
  for(let axis=0;axis<inputShape.length;axis++)result=result*inputShape[axis]+(inputShape[axis]===1?0:coordinates[axis+outputShape.length-inputShape.length]);
  return result;
}

it.each(Object.keys(operations))('preserves scalar %s across channel runs, reverse operands, tails and short-axis fallback', async operation => {
  const engine=await WasmOcrCompute.create(readFileSync('public/native/ocr-engine.wasm'));
  try {
    for(const [aShape,bShape,shape]of cases){
      const a=make(aShape,0),b=make(bShape,3),left=engine.upload(a,aShape),right=engine.upload(b,bShape),batch=engine.batch();
      const output=batch.binary(operation,left,right);batch.submit();
      const actual=await engine.read(output);
      expect(output.shape).toEqual(shape);
      for(let i=0;i<actual.length;i++){
        const expected=Math.fround(operations[operation](a[sourceIndex(i,shape,aShape)],b[sourceIndex(i,shape,bShape)]));
        expect(Number.isNaN(expected)?Number.isNaN(actual[i]):Object.is(actual[i],expected),`${operation} ${aShape} / ${bShape} element${i}`).toBe(true);
      }
      await engine.releaseMany([...engine.tensors],batch.scratchBuffers());
      expect(engine.buffers.size).toBe(0);
    }
  } finally { await engine.dispose(); }
});

it('keeps square-exponent validation and already-computed output order unchanged', async () => {
  const engine=await WasmOcrCompute.create(readFileSync('public/native/ocr-engine.wasm'));
  try {
    const a=engine.upload(Float32Array.of(-0,2,3,4,5),[5]),b=engine.upload(Float32Array.of(2,2,3,2,2),[5]);
    const batch=engine.batch(),output=batch.binary('Pow',a,b);
    expect(()=>batch.submit()).toThrow(/square exponent/);
    const actual=await engine.read(output);
    expect(Object.is(actual[0],0)).toBe(true);expect(actual[1]).toBe(4);expect(actual[2]).toBe(0);
  } finally { await engine.dispose(); }
});
