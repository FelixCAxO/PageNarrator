import {expect,it} from 'vitest';
import {eliminateHalfCastRoundTrips} from '../../src/engines/onnx-optimize.js';
import {selectExecutionPlan} from '../../src/engines/onnx-execution-plan.js';
const node=(opType,inputs,output,attrs={})=>({name:output,opType,inputs,outputs:[output],attrs});
const types=new Map([['half',10],['float',1],['wide',1],['view',1],['out',10]]);
it.each([
  ['Unsqueeze',['wide'],{axes:[-1]}],['Unsqueeze',['wide','axes'],{}],
  ['Squeeze',['wide'],{axes:[0]}],['Squeeze',['wide','axes'],{}],
  ['Reshape',['wide','shape'],{}],['Reshape',['wide','shape'],{allowzero:1}],
])('moves %s onto the original half input, retaining metadata and named float side outputs',(op,inputs,attrs)=>{
  const nodes=[node('Cast',['half'],'wide',{to:1}),node(op,inputs,'view',attrs),node('Cast',['view'],'out',{to:10})];
  const result=eliminateHalfCastRoundTrips(nodes,types);
  expect(result[2]).toEqual({...nodes[1],name:'out',inputs:['half',...inputs.slice(1)],outputs:['out']});
  expect(result[0]).toBe(nodes[0]);expect(result[1]).toBe(nodes[1]);expect(nodes[2].opType).toBe('Cast');
  expect(selectExecutionPlan(result,['wide','view','out']).nodes).toHaveLength(3);
  expect(selectExecutionPlan(result,['out']).nodes).toEqual([result[2]]);
});
it.each(['Transpose','Gather','Slice','Add','Relu'])('does not move through %s',op=>{
  const nodes=[node('Cast',['half'],'wide',{to:1}),node(op,['wide'],'view'),node('Cast',['view'],'out',{to:10})];
  expect(eliminateHalfCastRoundTrips(nodes,types)[2]).toBe(nodes[2]);
});
it('preserves view validation attributes and its source nodes',()=>{
  const nodes=[node('Cast',['half'],'wide',{to:1}),node('Unsqueeze',['wide'],'view',{axes:[0],extra:1}),node('Cast',['view'],'out',{to:10})];
  expect(eliminateHalfCastRoundTrips(nodes,types)[2].attrs).toEqual(nodes[1].attrs);
});
it.each(['domain','outputs','float','cast-attrs','view-chain'])('keeps an unproven or unsupported %s chain unchanged',mode=>{
  const nodes=[node('Cast',[mode==='float'?'float':'half'],'wide',{to:1}),node('Unsqueeze',['wide'],'view',{axes:[0]}),node('Cast',['view'],'out',{to:10})];
  if(mode==='domain')nodes[1].domain='other';if(mode==='outputs')nodes[1].outputs.push('extra');if(mode==='cast-attrs')nodes[2].attrs.extra=1;
  if(mode==='view-chain'){nodes.splice(2,0,node('Squeeze',['view'],'second',{axes:[0]}));nodes[3].inputs=['second'];}
  expect(eliminateHalfCastRoundTrips(nodes,types).at(-1)).toBe(nodes.at(-1));
});
