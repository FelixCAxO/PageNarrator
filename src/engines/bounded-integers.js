// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// WGSL has no int64. Narrow integer data only when its exact range is proven.
import { tensorSize } from './tensor-shape.js';
import { ONNX_TYPES } from './tensor-format.js';
export function integerRange(data) {
  let min = Infinity, max = -Infinity;
  for (const value of data) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647) throw new RangeError('Integer tensor exceeds the exact GPU int32 range.');
    min = Math.min(min, number); max = Math.max(max, number);
  }
  return Object.freeze(data.length ? { min, max } : { min: 0, max: 0 });
}

export function integerAddRange(a, b) {
  if (!a || !b) throw new Error('Integer addition requires proven operand ranges.');
  const min = a.min + b.min, max = a.max + b.max;
  if (min < -2147483648 || max > 2147483647) throw new RangeError('Integer addition may overflow its exact GPU range.');
  return Object.freeze({ min, max });
}

export function integerMultiplyRange(a, b) {
  if (!a || !b) throw new Error('Integer multiplication requires proven operand ranges.');
  const products = [a.min * b.min, a.min * b.max, a.max * b.min, a.max * b.max];
  const min = Math.min(...products), max = Math.max(...products);
  if (min < -2147483648 || max > 2147483647) throw new RangeError('Integer multiplication may overflow its exact GPU range.');
  return Object.freeze({ min, max });
}

export function modelFeed(info, feed) {
  if (!Array.isArray(feed?.shape) || (info.dims && (info.dims.length !== feed.shape.length
    || info.dims.some((dim, i) => typeof dim === 'number' && dim !== feed.shape[i])))) throw new Error(`Input ${info.name} does not match its model shape.`);
  if (feed.data?.length !== tensorSize(feed.shape)) throw new RangeError(`Input ${info.name} data does not match its element count.`);
  if (feed.type !== undefined && feed.type !== ONNX_TYPES[info.dataType]) throw new Error(`Input ${info.name} has a mismatched declared model type.`);
  if (info.dataType === 1 && feed.data instanceof Float32Array) return { ...feed, bounds: null, type: 'float32' };
  if (info.dataType === 10 && feed.data instanceof Uint16Array) return { ...feed, bounds: null, type: 'float16' };
  if (info.dataType === 2 && feed.data instanceof Uint8Array) return { ...feed, bounds: null, type: 'uint8' };
  if (info.dataType === 3 && feed.data instanceof Int8Array) return { ...feed, bounds: null, type: 'int8' };
  if (info.dataType === 9 && feed.data instanceof Uint8Array) {
    if (feed.data.some(value => value !== 0 && value !== 1)) throw new RangeError('Boolean feeds must contain only zero or one.');
    return { shape: feed.shape, data: Uint32Array.from(feed.data), bounds: null, type: 'bool' };
  }
  if ((info.dataType === 7 && feed.data instanceof BigInt64Array) || (info.dataType === 6 && feed.data instanceof Int32Array)) {
    const bounds = integerRange(feed.data);
    return { shape: feed.shape, data: feed.data instanceof Int32Array ? feed.data : Int32Array.from(feed.data, Number), bounds, type: 'int32' };
  }
  throw new Error(`Input ${info.name} has an unsupported or mismatched model type.`);
}
