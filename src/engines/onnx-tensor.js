// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { tensorSize } from './tensor-shape.js';
import { halfToFloat } from './tensor-format.js';

export function tensorBytes(tensor) {
  if (tensor.dataType === 1) return floatTensorBytes(tensor);
  if (tensor.dataLocation || tensor.externalData.size) throw new Error(`External tensor ${tensor.name} needs its verified weight payload.`);
  const width = { 2: 1, 3: 1, 6: 4, 7: 8, 9: 1, 10: 2 }[tensor.dataType], count = tensorSize(tensor.dims);
  if (!width) throw new Error(`Unsupported tensor type ${tensor.dataType}.`);
  if (tensor.rawData) {
    if (tensor.rawData.byteLength !== count * width || tensor.typedData.size) throw new Error(`Tensor ${tensor.name} has an invalid typed payload.`);
    if (tensor.dataType === 9 && tensor.rawData.some(value => value !== 0 && value !== 1)) throw new Error('Invalid bool tensor payload.');
    return tensor.rawData;
  }
  const values = integerLiterals(tensor, tensor.dataType === 7 ? 7 : 5, count, tensor.dataType === 7 ? 8 : 4);
  const result = new Uint8Array(count * width), view = new DataView(result.buffer);
  values.forEach((value, i) => {
    if (width === 8) view.setBigInt64(i * width, value, true);
    else {
      const number = Number(value);
      if ((tensor.dataType === 10 && (number < 0 || number > 65535)) || (tensor.dataType === 9 && number !== 0 && number !== 1)) throw new RangeError('Invalid half or bool tensor literal.');
      if ((tensor.dataType === 2 && (number < 0 || number > 255)) || (tensor.dataType === 3 && (number < -128 || number > 127))) throw new RangeError('Invalid quantized tensor literal.');
      if (width === 4) view.setInt32(i * width, number, true);
      else if (width === 2) view.setUint16(i * width, number, true);
      else if (tensor.dataType === 3) view.setInt8(i, number);
      else view.setUint8(i, number);
    }
  });
  return result;
}

function integerLiterals(tensor, key, count, width) {
  const output = [];
  const append = value => { output.push(BigInt.asIntN(width * 8, value)); if (output.length > count) throw new Error('Too many integer literals.'); };
  for (const field of tensor.typedData.get(key) ?? []) {
    if (field.wire === 0) append(field.value);
    else if (field.wire === 2) {
      let value = 0n, shift = 0n;
      for (const byte of field.value) {
        if (shift >= 64n || (shift === 63n && byte > 1)) throw new Error('Invalid integer literal varint.');
        value |= BigInt(byte & 127) << shift;
        if (byte & 128) shift += 7n;
        else { append(value); value = 0n; shift = 0n; }
      }
      if (shift) throw new Error('Truncated integer literal varint.');
    } else throw new Error('Invalid integer literal wire type.');
  }
  if (output.length !== count || [...tensor.typedData.keys()].some(item => item !== key)) throw new Error(`Constant ${tensor.name} has an incomplete integer payload.`);
  return output;
}

/** Retain int64 Slice sentinels exactly until the indexing planner clamps to an axis. */
export function constantIntegers(tensor, maximum = 1024) {
  const count = tensorSize(tensor.dims);
  if (![6, 7].includes(tensor.dataType) || count > maximum) throw new RangeError('Invalid or oversized integer metadata.');
  const bytes = tensorBytes(tensor), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, i) => tensor.dataType === 7 ? view.getBigInt64(i * 8, true) : BigInt(view.getInt32(i * 4, true)));
}

export function floatTensorBytes(tensor) {
  if (tensor.dataType !== 1) throw new Error(`Tensor ${tensor.name} requires float32 data.`);
  if (tensor.dataLocation || tensor.externalData.size) throw new Error(`External tensor ${tensor.name} needs its verified weight payload.`);
  const count = tensorSize(tensor.dims);
  if (tensor.rawData) {
    if (tensor.rawData.byteLength !== count * 4 || tensor.typedData.size) throw new Error(`Tensor ${tensor.name} has an invalid float32 payload.`);
    return tensor.rawData;
  }
  const result = new Uint8Array(count * 4);
  let offset = 0;
  for (const field of tensor.typedData.get(4) ?? []) {
    if ((field.wire !== 2 && field.wire !== 5) || field.value.byteLength % 4 || offset + field.value.byteLength > result.byteLength) {
      throw new Error(`Tensor ${tensor.name} has invalid float32 literals.`);
    }
    result.set(field.value, offset);
    offset += field.value.byteLength;
  }
  if (offset !== result.byteLength || [...tensor.typedData.keys()].some(key => key !== 4)) throw new Error(`Tensor ${tensor.name} has an incomplete float32 payload.`);
  return result;
}

export function constantNumbers(tensor, maximum = 1024) {
  const count = tensorSize(tensor.dims);
  if (count > maximum) throw new RangeError(`Constant ${tensor.name} exceeds the metadata element limit.`);
  if (tensor.dataLocation || tensor.externalData.size) throw new Error(`External constant ${tensor.name} needs its verified weight payload.`);
  if ([6, 7].includes(tensor.dataType)) {
    const width = tensor.dataType === 7 ? 8 : 4;
    const exact = value => {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new RangeError(`Constant ${tensor.name} exceeds the exact integer range.`);
      return number;
    };
    if (tensor.rawData) {
      if (tensor.rawData.byteLength !== count * width || tensor.typedData.size) throw new Error(`Constant ${tensor.name} has an invalid integer payload.`);
      const view = new DataView(tensor.rawData.buffer, tensor.rawData.byteOffset, tensor.rawData.byteLength);
      return Array.from({ length: count }, (_, i) => exact(width === 8 ? view.getBigInt64(i * 8, true) : view.getInt32(i * 4, true)));
    }
    return integerLiterals(tensor, width === 8 ? 7 : 5, count, width).map(exact);
  }
  if (![1, 2, 3, 9, 10].includes(tensor.dataType)) throw new Error(`Constant ${tensor.name} requires a supported numeric type.`);
  const bytes = tensorBytes(tensor);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, i) => tensor.dataType === 10 ? halfToFloat(view.getUint16(i * 2, true))
    : [2, 9].includes(tensor.dataType) ? view.getUint8(i) : tensor.dataType === 3 ? view.getInt8(i) : view.getFloat32(i * 4, true));
}
