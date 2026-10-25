// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { broadcastShape, broadcastStrides, tensorSize } from './tensor-shape.js';
import { metadataTensor } from './onnx-metadata.js';
import { constantNumbers } from './onnx-tensor.js';
import { floatToHalf, halfToFloat, ONNX_TYPES } from './tensor-format.js';

function mapBroadcast(inputs, operation, dataType) {
  const shape = inputs.reduce((shape, input) => broadcastShape(shape, input.shape), []);
  const count = tensorSize(shape);
  if (count > 1024) return null;
  const strides = inputs.map(input => broadcastStrides(input.shape, shape));
  const data = Array.from({ length: count }, (_, index) => {
    const offsets = new Array(inputs.length).fill(0);
    for (let axis = shape.length - 1; axis >= 0; axis -= 1) {
      const coordinate = index % shape[axis]; index = Math.floor(index / shape[axis]);
      offsets.forEach((_, i) => { offsets[i] += coordinate * strides[i][axis]; });
    }
    const value = operation(...inputs.map((input, i) => input.data[offsets[i]]));
    if ([6, 7].includes(dataType) && !Number.isSafeInteger(value)) throw new RangeError('Metadata arithmetic exceeds exact integer range.');
    if (dataType === 6 && (value < -2147483648 || value > 2147483647)) throw new RangeError('Metadata arithmetic exceeds the supported int32 range.');
    return dataType === 1 ? Math.fround(value) : dataType === 10 ? halfToFloat(floatToHalf(value)) : value;
  });
  return metadataTensor(data, shape, dataType);
}

export function executeMetadataMath(node, { value, numbers }) {
  const a = node.attrs;
  if (node.opType === 'ConstantOfShape') {
    if (Object.keys(a).some(key => key !== 'value')) throw new Error('Unsupported ConstantOfShape attribute.');
    const shape = numbers(node.inputs[0]), count = tensorSize(shape), type = a.value?.dataType ?? 1;
    if (count > 1024) return null;
    const fill = a.value ? constantNumbers(a.value) : [0];
    if (fill.length !== 1) throw new Error('ConstantOfShape requires one fill value.');
    return metadataTensor(new Array(count).fill(fill[0]), shape, type);
  }
  if (!['Add', 'Sub', 'Mul', 'Div', 'Equal', 'Greater', 'GreaterOrEqual', 'Less', 'And', 'Where', 'Cast', 'Expand', 'NonZero', 'Range'].includes(node.opType)) return null;
  const inputs = node.inputs.map(value);
  if (inputs.some(input => !input.cpu)) return null;
  if (Object.keys(a).some(key => node.opType !== 'Cast' || !['to', 'saturate'].includes(key))) throw new Error(`Unsupported ${node.opType} attribute.`);
  if (node.opType === 'Cast' && a.saturate !== undefined && a.saturate !== 1) throw new Error('Only the default saturating Cast attribute is supported.');
  const first = inputs[0];
  if (node.opType === 'NonZero') {
    const indices = [];
    for (let i = 0; i < first.data.length; i++) if (first.data[i] !== 0) indices.push(i);
    const data = [];
    for (let axis = 0; axis < first.shape.length; axis++) {
      const stride = tensorSize(first.shape.slice(axis + 1));
      for (const index of indices) data.push(Math.floor(index / stride) % first.shape[axis]);
    }
    return metadataTensor(data, [first.shape.length, indices.length]);
  }
  if (node.opType === 'Range') {
    if (inputs.some(input => input.data.length !== 1 || input.dataType !== first.dataType)) throw new Error('Range requires matching scalar inputs.');
    const [start, end, step] = inputs.map(input => input.data[0]);
    if (![start, end, step].every(Number.isFinite) || !step) throw new RangeError('Invalid Range parameters.');
    const count = Math.max(0, Math.ceil((end - start) / step));
    if (count > 1024) return null;
    const data = Array.from({ length: count }, (_, i) => {
      const value = [6, 7].includes(first.dataType) ? Number(BigInt(start) + BigInt(i) * BigInt(step)) : start + i * step;
      if (first.dataType === 6 && (value < -2147483648 || value > 2147483647)) throw new RangeError('Range exceeds the supported int32 range.');
      if ([6, 7].includes(first.dataType) && !Number.isSafeInteger(value)) throw new RangeError('Range exceeds exact integer range.');
      return first.dataType === 1 ? Math.fround(value) : first.dataType === 10 ? halfToFloat(floatToHalf(value)) : value;
    });
    return metadataTensor(data, [count], first.dataType);
  }
  if (node.opType === 'Cast') {
    if (!ONNX_TYPES[a.to]) throw new Error('Unsupported metadata Cast type.');
    const convert = x => {
      if ([2, 3, 6, 7].includes(a.to)) {
        const result = Math.trunc(x);
        const range = { 2: [0, 255], 3: [-128, 127], 6: [-2147483648, 2147483647], 7: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] }[a.to];
        if (!Number.isSafeInteger(result) || result < range[0] || result > range[1]) throw new RangeError('Metadata Cast exceeds its supported integer range.');
        return result === 0 ? 0 : result;
      }
      return a.to === 9 ? Number(x !== 0) : a.to === 10 ? halfToFloat(floatToHalf(x)) : Math.fround(x);
    };
    return metadataTensor(first.data.map(convert), first.shape, a.to);
  }
  if (node.opType === 'Expand') {
    const shape = broadcastShape(first.shape, numbers(node.inputs[1]));
    const count = tensorSize(shape);
    if (count > 1024) return null;
    return mapBroadcast([first, metadataTensor(new Array(count).fill(0), shape, first.dataType)], x => x, first.dataType);
  }
  if (node.opType === 'Where') {
    if (first.dataType !== 9 || inputs[1].dataType !== inputs[2].dataType) throw new Error('Where requires bool conditions and matching alternatives.');
    return mapBroadcast(inputs, (condition, yes, no) => condition ? yes : no, inputs[1].dataType);
  }
  if (inputs[0].dataType !== inputs[1].dataType) throw new Error('Metadata arithmetic types do not match.');
  const integer = [6, 7].includes(first.dataType);
  if (node.opType === 'And' && first.dataType !== 9) throw new Error('And requires boolean operands.');
  const operations = { Add: (x, y) => x + y, Sub: (x, y) => x - y, Mul: (x, y) => x * y,
    Div: (x, y) => integer ? Math.trunc(x / y) : x / y, Equal: (x, y) => Number(x === y),
    Greater: (x, y) => Number(x > y), GreaterOrEqual: (x, y) => Number(x >= y), Less: (x, y) => Number(x < y), And: (x, y) => Number(Boolean(x && y)) };
  return mapBroadcast(inputs, operations[node.opType], ['Equal', 'Greater', 'GreaterOrEqual', 'Less', 'And'].includes(node.opType) ? 9 : first.dataType);
}
