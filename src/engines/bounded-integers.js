// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// WGSL has no int64. Narrow integer data only when its exact range is proven.
import { tensorSize } from './tensor-shape.js';
import { ONNX_TYPES } from './tensor-format.js';
export class IntegerRangeProofError extends RangeError {}
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
  if (min < -2147483648 || max > 2147483647) throw new IntegerRangeProofError('Integer addition may overflow its exact GPU range.');
  return Object.freeze({ min, max });
}

export function integerMultiplyRange(a, b) {
  if (!a || !b) throw new Error('Integer multiplication requires proven operand ranges.');
  const products = [a.min * b.min, a.min * b.max, a.max * b.min, a.max * b.max];
  const min = Math.min(...products), max = Math.max(...products);
  if (min < -2147483648 || max > 2147483647) throw new IntegerRangeProofError('Integer multiplication may overflow its exact GPU range.');
  return Object.freeze({ min, max });
}

/** @param {any} info @param {any} feed @param {Map<string, Uint32Array> | null} [booleanFeeds] */
export function modelFeed(info, feed, booleanFeeds = null) {
  if (!Array.isArray(feed?.shape) || (info.dims && (info.dims.length !== feed.shape.length
    || info.dims.some((dim, i) => typeof dim === 'number' && dim !== feed.shape[i])))) throw new Error(`Input ${info.name} does not match its model shape.`);
  if (feed.data?.length !== tensorSize(feed.shape)) throw new RangeError(`Input ${info.name} data does not match its element count.`);
  if (feed.type !== undefined && feed.type !== ONNX_TYPES[info.dataType]) throw new Error(`Input ${info.name} has a mismatched declared model type.`);
  if (info.dataType === 1 && feed.data instanceof Float32Array) return { ...feed, bounds: null, type: 'float32' };
  if (info.dataType === 10 && feed.data instanceof Uint16Array) return { ...feed, bounds: null, type: 'float16' };
  if (info.dataType === 2 && feed.data instanceof Uint8Array) return { ...feed, bounds: null, type: 'uint8' };
  if (info.dataType === 3 && feed.data instanceof Int8Array) return { ...feed, bounds: null, type: 'int8' };
  if (info.dataType === 9 && feed.data instanceof Uint8Array) {
    const previous = booleanFeeds?.get(info.name);
    const data = previous && previous.length >= feed.data.length && previous.buffer !== feed.data.buffer
      ? previous.length === feed.data.length ? previous : previous.subarray(0, feed.data.length)
      : new Uint32Array(feed.data.length);
    for (let i = 0; i < data.length; i += 1) {
      const value = feed.data[i];
      if (value > 1) throw new RangeError('Boolean feeds must contain only zero or one.');
      data[i] = value;
    }
    // Only serialized session runs reuse storage; retain at most 4 MiB across bool inputs.
    if (booleanFeeds && (!previous || previous.length < data.length)
      && [...booleanFeeds.values()].reduce((sum, item) => sum + item.byteLength, 0) - (previous?.byteLength ?? 0) + data.byteLength <= 4 * 1024 * 1024) booleanFeeds.set(info.name, data);
    return { shape: feed.shape, data, bounds: null, type: 'bool' };
  }
  if ((info.dataType === 7 && feed.data instanceof BigInt64Array) || (info.dataType === 6 && feed.data instanceof Int32Array)) {
    const bounds = integerRange(feed.data);
    return { shape: feed.shape, data: feed.data instanceof Int32Array ? feed.data : Int32Array.from(feed.data, Number), bounds, type: 'int32' };
  }
  throw new Error(`Input ${info.name} has an unsupported or mismatched model type.`);
}
