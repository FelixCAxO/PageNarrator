// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { concatPlan } from './cnn-shape.js';
import { axisIndex, reshapeShape, slicePlan, squeezeShape, transposePlan, unsqueezeShape } from './index-shape.js';
import { tensorSize } from './tensor-shape.js';
import { METADATA_LIMIT } from './onnx-metadata-inputs.js';

export function metadataTensor(data, shape, dataType = 7) {
  if (tensorSize(shape) !== data.length || data.length > METADATA_LIMIT) throw new RangeError('Invalid or oversized metadata tensor.');
  return { cpu: true, data, shape, dataType };
}

function cpuIndex(input, plan) {
  const count = tensorSize(plan.shape);
  if (count > METADATA_LIMIT) throw new RangeError('Indexed metadata exceeds its element limit.');
  const output = Array.from({ length: count }, (_, i) => {
    let source = plan.offset, remaining = i;
    for (let axis = plan.shape.length - 1; axis >= 0; axis -= 1) {
      source += (remaining % plan.shape[axis]) * plan.strides[axis]; remaining = Math.floor(remaining / plan.shape[axis]);
    }
    return input.data[source];
  });
  return metadataTensor(output, plan.shape, input.dataType);
}

export function executeIndexNode(node, { value, numbers, descriptor, batch, asGpu }) {
  const a = node.attrs;
  if (node.opType === 'Shape') {
    if (Object.keys(a).some(key => !['start', 'end'].includes(key))) throw new Error('Unsupported Shape attribute.');
    const shape = descriptor(node.inputs[0]).shape;
    const clamp = value => Math.max(0, Math.min(shape.length, value < 0 ? value + shape.length : value));
    if (![a.start ?? 0, a.end ?? shape.length].every(Number.isSafeInteger)) throw new Error('Shape start/end must be exact integers.');
    const selected = shape.slice(clamp(a.start ?? 0), clamp(a.end ?? shape.length));
    return metadataTensor([...selected], [selected.length]);
  }
  if (!['Identity', 'Reshape', 'Squeeze', 'Unsqueeze', 'Slice', 'Transpose', 'Gather', 'Concat'].includes(node.opType)) return null;
  const input = value(node.inputs[0]);
  const allowed = { Identity: [], Reshape: ['allowzero'], Squeeze: ['axes'], Unsqueeze: ['axes'], Slice: node.inputs.length === 1 ? ['starts', 'ends', 'axes'] : [], Transpose: ['perm'], Gather: ['axis'], Concat: ['axis'] }[node.opType];
  if (Object.keys(a).some(key => !allowed.includes(key))) throw new Error(`Unsupported ${node.opType} attribute.`);
  let shape, plan;
  switch (node.opType) {
    case 'Identity': return input;
    case 'Reshape': shape = reshapeShape(input.shape, numbers(node.inputs[1]), Boolean(a.allowzero)); break;
    case 'Squeeze': shape = squeezeShape(input.shape, a.axes ?? (node.inputs[1] ? numbers(node.inputs[1]) : null)); break;
    case 'Unsqueeze': shape = unsqueezeShape(input.shape, a.axes ?? numbers(node.inputs[1])); break;
    case 'Transpose': plan = transposePlan(input.shape, a.perm); break;
    case 'Slice': plan = node.inputs.length === 1 ? slicePlan(input.shape, a.starts, a.ends, a.axes)
      : slicePlan(input.shape, numbers(node.inputs[1], true), numbers(node.inputs[2], true),
        node.inputs[3] ? numbers(node.inputs[3]) : null, node.inputs[4] ? numbers(node.inputs[4]) : null); break;
    case 'Gather': {
      const dynamicIndices = value(node.inputs[1]);
      if (!dynamicIndices.cpu) {
        return batch.gatherTensor(input.cpu ? asGpu(input) : input, dynamicIndices, a.axis ?? 0);
      }
      const indices = numbers(node.inputs[1]), info = descriptor(node.inputs[1]);
      if (!input.cpu) return batch.gather(input, indices, info.shape, a.axis ?? 0);
      const axis = axisIndex(a.axis ?? 0, input.shape.length);
      const shape = [...input.shape.slice(0, axis), ...info.shape, ...input.shape.slice(axis + 1)], count = tensorSize(shape);
      const dimension = input.shape[axis], inner = tensorSize(input.shape.slice(axis + 1));
      if (indices.some(index => !Number.isSafeInteger(index) || index < -dimension || index >= dimension)) throw new RangeError('Metadata Gather index is out of range.');
      if (count > METADATA_LIMIT) return batch.gather(asGpu(input), indices, info.shape, axis);
      const data = Array.from({ length: count }, (_, i) => {
        let index = indices[Math.floor(i / inner) % indices.length]; if (index < 0) index += dimension;
        return input.data[(Math.floor(i / (indices.length * inner)) * dimension + index) * inner + i % inner];
      });
      return metadataTensor(data, shape, input.dataType);
    }
    case 'Concat': {
      const inputs = node.inputs.map(value);
      if (!inputs.some(item => item.cpu)) return batch.concat(inputs, a.axis);
      if (inputs.some(item => !item.cpu)) return batch.concat(inputs.map(asGpu), a.axis);
      if (inputs.some(item => item.dataType !== input.dataType)) throw new Error('Concat metadata types do not match.');
      const combined = concatPlan(inputs.map(item => item.shape), a.axis);
      const count = tensorSize(combined.shape);
      if (count > METADATA_LIMIT) return batch.concat(inputs.map(asGpu), a.axis);
      const data = new Array(count);
      let offset = 0;
      for (const item of inputs) {
        const block = item.shape[combined.axis] * combined.innerSize;
        for (let i = 0; i < item.data.length; i += 1) data[(Math.floor(i / block) * combined.shape[combined.axis] + offset) * combined.innerSize + i % block] = item.data[i];
        offset += item.shape[combined.axis];
      }
      return metadataTensor(data, combined.shape, input.dataType);
    }
    default: throw new Error('Unexpected index operation.');
  }
  if (shape) return input.cpu ? metadataTensor(input.data, shape, input.dataType) : batch.view(input, shape);
  return input.cpu ? cpuIndex(input, plan) : batch.index(input, plan);
}
