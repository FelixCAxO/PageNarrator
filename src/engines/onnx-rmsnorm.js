import { constantNumbers } from './onnx-tensor.js';

// Fuse the corrected half RMSNorm chain; its explicit half rounding precedes learned weights.
export function fuseHalfRmsNorms(nodes, initializers, valueTypes) {
  const producers = new Map(nodes.flatMap(node => node.outputs.map(name => [name, node])));
  const plain = (node, op, allowed = []) => node?.opType === op && Object.keys(node.attrs).every(key => allowed.includes(key));
  const cast = (name, to) => {
    const node = producers.get(name);
    return plain(node, 'Cast', ['to']) && node.attrs.to === to ? node : null;
  };
  const scalar = name => {
    const conversion = cast(name, 1);
    const tensor = initializers.get(conversion?.inputs[0] ?? name);
    return tensor && tensor.dims.length === 0 ? constantNumbers(tensor)[0] : null;
  };
  return nodes.map(node => {
    if (!plain(node, 'Mul')) return node;
    for (const side of [0, 1]) {
      const weightName = node.inputs[side], weight = initializers.get(weightName);
      if (weight?.dataType !== 10 || weight.dims.length !== 1 || ![128, 1024].includes(weight.dims[0])) continue;
      const half = cast(node.inputs[1 - side], 10);
      const output = half && cast(half.inputs[0], 1);
      const multiply = output && producers.get(output.inputs[0]);
      if (!plain(multiply, 'Mul')) continue;
      const input = cast(multiply.inputs[0], 1), divide = producers.get(multiply.inputs[1]);
      const source = input && cast(input.inputs[0], 1);
      if (!source || valueTypes.get(source.inputs[0]) !== 10 || !plain(divide, 'Div') || scalar(divide.inputs[0]) !== 1) continue;
      const sqrt = producers.get(divide.inputs[1]);
      const add = plain(sqrt, 'Sqrt') && producers.get(sqrt.inputs[0]);
      if (!plain(add, 'Add') || scalar(add.inputs[1]) !== Math.fround(1e-6)) continue;
      const meanCast = cast(add.inputs[0], 1);
      const mean = meanCast && producers.get(meanCast.inputs[0]);
      if (!plain(mean, 'ReduceMean', ['axes', 'keepdims']) || mean.attrs.keepdims === 0 || mean.attrs.axes?.length !== 1 || mean.attrs.axes[0] !== -1) continue;
      const square = producers.get(mean.inputs[0]);
      if (!plain(square, 'Pow') || square.inputs[0] !== source.outputs[0] || scalar(square.inputs[1]) !== 2) continue;
      return { ...node, opType: 'FusedHalfRmsNorm', inputs: [source.inputs[0], weightName] };
    }
    return node;
  });
}

export function fuseHalfRmsNormTransposes(nodes,initializers,valueTypes) {
  const producers=new Map(nodes.flatMap(node=>node.outputs.map(name=>[name,node])));
  const plain=(node,op,inputs,attrs=[])=>node?.opType===op&&(!node.domain||node.domain==='ai.onnx')&&node.inputs.length===inputs&&node.outputs.length===1&&Object.keys(node.attrs).every(key=>attrs.includes(key));
  return nodes.map(node=>{
    if(!plain(node,'Transpose',1,['perm'])||!Array.isArray(node.attrs.perm)||node.attrs.perm.length!==4||!node.attrs.perm.every((axis,i)=>axis===[0,2,1,3][i]))return node;
    const norm=producers.get(node.inputs[0]),weight=norm&&initializers.get(norm.inputs[1]);
    if(!plain(norm,'FusedHalfRmsNorm',2)||weight?.dataType!==10||weight.dims.length!==1||weight.dims[0]!==128||![...norm.inputs,...norm.outputs,...node.outputs].every(name=>valueTypes.get(name)===10))return node;
    return {...node,opType:'FusedHalfRmsNormTranspose',inputs:[...norm.inputs],attrs:{}};
  });
}
