import {contiguousStrides,slicePlan} from './index-shape.js';

export function fuseHalfRotaryEmbeddings(nodes,valueTypes) {
  const producers=new Map(nodes.flatMap(n=>n.outputs.map(name=>[name,n])));
  const plain=(n,op,count,attrs=[])=>n?.opType===op&&(!n.domain||n.domain==='ai.onnx')&&n.inputs.length===count&&n.outputs.length===1&&Object.keys(n.attrs).every(key=>attrs.includes(key));
  return nodes.map(n=>{
    if(!plain(n,'Add',2))return n;
    const direct=producers.get(n.inputs[0]),product=producers.get(n.inputs[1]);
    if(!plain(direct,'Mul',2)||!plain(product,'Mul',2))return n;
    const concat=producers.get(product.inputs[0]);
    if(!plain(concat,'Concat',2,['axis'])||concat.attrs.axis!==-1)return n;
    const negative=producers.get(concat.inputs[0]),first=producers.get(concat.inputs[1]);
    const second=negative&&producers.get(negative.inputs[0]);
    if(!plain(negative,'Neg',1)||!plain(first,'Slice',5)||!plain(second,'Slice',5)
      ||first.inputs[0]!==direct.inputs[0]||second.inputs[0]!==direct.inputs[0])return n;
    const floats=[...direct.inputs,...product.inputs,first.outputs[0],second.outputs[0],negative.outputs[0],...n.inputs,n.outputs[0]];
    if(!floats.every(name=>valueTypes.get(name)===10))return n;
    return{...n,opType:'FusedHalfRotary',inputs:[...direct.inputs,product.inputs[1],...first.inputs.slice(1),...second.inputs.slice(1)],attrs:{}};
  });
}

export function executeHalfRotary(node,{input,batch,value,numbers,asGpu}) {
  const cosine=asGpu(value(node.inputs[1])),sine=asGpu(value(node.inputs[2]));
  const plans=[3,7].map(start=>slicePlan(input.shape,numbers(node.inputs[start],true),numbers(node.inputs[start+1],true),numbers(node.inputs[start+2]),numbers(node.inputs[start+3])));
  const strides=contiguousStrides(input.shape),width=input.shape.at(-1),split=plans[0].shape.at(-1);
  // Only complementary contiguous last-axis slices qualify; keep other valid models on the original operations.
  if(input.shape.length&&plans[0].offset===0&&plans[1].offset===split
    &&plans[1].shape.at(-1)===width-split&&plans.every(plan=>plan.strides.every((s,i)=>s===strides[i])
      &&plan.shape.slice(0,-1).every((size,i)=>size===input.shape[i])))return batch.rotary(input,cosine,sine,split);
  const direct=batch.binary('Mul',input,cosine),left=batch.index(input,plans[0]),right=batch.index(input,plans[1]),negative=batch.unary('Neg',right);
  const rotated=batch.concat([negative,left],-1),product=batch.binary('Mul',rotated,sine),output=batch.binary('Add',direct,product);
  for(const temporary of [direct,left,right,negative,rotated,product])batch.recycle(temporary);
  return output;
}
