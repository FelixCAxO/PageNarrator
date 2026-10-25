// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
export const ONNX_TYPES = Object.freeze({ 1: 'float32', 2: 'uint8', 3: 'int8', 6: 'int32', 7: 'int64', 9: 'bool', 10: 'float16' });

export function storageWidth(type) {
  if (!['float32', 'int32', 'bool', 'float16', 'uint8', 'int8'].includes(type)) throw new Error(`Unsupported tensor storage ${type}.`);
  return ['uint8', 'int8'].includes(type) ? 1 : type === 'float16' ? 2 : 4;
}

export function tensorArray(type) {
  const result = { float32: Float32Array, float16: Uint16Array, int32: Int32Array, int64: BigInt64Array, bool: Uint8Array, uint8: Uint8Array, int8: Int8Array }[type];
  if (!result) throw new Error(`Unsupported tensor type ${type}.`);
  return result;
}

export function halfToFloat(bits) {
  const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >>> 10) & 31, fraction = bits & 1023;
  return exponent === 31 ? fraction ? NaN : sign * Infinity
    : sign * (exponent ? (1 + fraction / 1024) * 2 ** (exponent - 15) : fraction * 2 ** -24);
}

/** IEEE binary32 -> binary16, round to nearest with ties to even. */
export function floatToHalf(value) {
  const bits = new Uint32Array(Float32Array.of(value).buffer)[0];
  const sign = (bits >>> 16) & 0x8000, exponent = (bits >>> 23) & 255, fraction = bits & 0x7fffff;
  if (exponent === 255) return sign | 0x7c00 | (fraction ? 0x200 : 0);
  if (exponent > 142) return sign | 0x7c00;
  if (exponent < 102) return sign;
  const shift = exponent < 113 ? 126 - exponent : 13;
  const mantissa = exponent < 113 ? fraction | 0x800000 : fraction;
  let rounded = Math.floor(mantissa / 2 ** shift);
  const remainder = mantissa - rounded * 2 ** shift, halfway = 2 ** (shift - 1);
  if (remainder > halfway || (remainder === halfway && (rounded & 1))) rounded += 1;
  return sign | (exponent < 113 ? rounded : ((exponent - 112) << 10) + rounded);
}
