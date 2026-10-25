// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Explicit Lab PCS -> CMYK lut8Type/lut16Type, ICC.1 sections 6.5.7/6.5.8.
import { PdfEngineError } from './native-reader.js';

const clamp = n => Math.max(0, Math.min(1, n));
export function readIccLabB2a(bytes, tag) {
  if (!tag) return undefined;
  const fail = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
  const { at, size } = tag;
  const range = (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 0
      || offset < at || offset + length > at + size) fail('ICC inverse data exceeds its tag bounds.');
    return offset;
  };
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 8 || at + size > bytes.length) fail('Invalid ICC inverse tag.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const type = String.fromCharCode(...bytes.subarray(at, at + 4)), sixteen = type === 'mft2';
  if (!sixteen && type !== 'mft1') return undefined;
  range(at, sixteen ? 52 : 48);
  const u16 = offset => view.getUint16(range(offset, 2));
  const input = bytes[at + 8], output = bytes[at + 9], grid = bytes[at + 10];
  const inputEntries = sixteen ? u16(at + 48) : 256, outputEntries = sixteen ? u16(at + 50) : 256;
  if (input !== 3 || output !== 4 || grid < 2 || grid > 33
    || inputEntries < 2 || inputEntries > 4096 || outputEntries < 2 || outputEntries > 4096) fail('Invalid ICC inverse LUT dimensions.');
  const sampleBytes = sixteen ? 2 : 1, inputs = at + (sixteen ? 52 : 48);
  const clut = inputs + input * inputEntries * sampleBytes, outputs = clut + grid ** input * output * sampleBytes;
  range(outputs, output * outputEntries * sampleBytes);
  // A Lab-input LUT must not apply the XYZ-only matrix. Keep forward use available.
  for (let i = 0; i < 9; i++) if (view.getInt32(at + 12 + i * 4) !== (i % 4 === 0 ? 65536 : 0)) return undefined;
  const sample = offset => sixteen ? view.getUint16(offset) / 65535 : bytes[offset] / 255;
  const interpolate = (offset, count, value) => {
    const position = clamp(value) * (count - 1), left = Math.floor(position), fraction = position - left;
    return sample(offset + left * sampleBytes) * (1 - fraction)
      + sample(offset + Math.min(left + 1, count - 1) * sampleBytes) * fraction;
  };
  return values => {
    if (values?.length !== 3 || !Array.from(values).every(n => typeof n === 'number' && Number.isFinite(n))) fail('Invalid ICC inverse XYZ components.');
    const f = n => n > (6 / 29) ** 3 ? Math.cbrt(n) : n / (3 * (6 / 29) ** 2) + 4 / 29;
    const [x, y, z] = [f(values[0] / .9642), f(values[1]), f(values[2] / .8249)];
    const lab = [(116 * y - 16) / 100, (500 * (x - y) + 128) / 255, (200 * (y - z) + 128) / 255];
    if (!lab.every(Number.isFinite)) fail('Invalid ICC inverse Lab components.');
    // lut16Type retains legacy Lab encoding in v4 too: L*=100 is FF00, not FFFF.
    const factor = sixteen ? 65280 / 65535 : 1;
    const coordinates = lab.map((n, i) => interpolate(inputs + i * inputEntries * sampleBytes, inputEntries, n * factor) * (grid - 1));
    const base = coordinates.map(n => Math.min(grid - 2, Math.floor(n))), fractions = coordinates.map((n, i) => n - base[i]), result = [0, 0, 0, 0];
    for (let corner = 0; corner < 8; corner++) {
      let index = 0, weight = 1;
      for (let i = 0; i < 3; i++) { const upper = corner >> i & 1; index = index * grid + base[i] + upper; weight *= upper ? fractions[i] : 1 - fractions[i]; }
      for (let channel = 0; channel < 4; channel++) result[channel] += sample(clut + (index * 4 + channel) * sampleBytes) * weight;
    }
    return result.map((n, i) => interpolate(outputs + i * outputEntries * sampleBytes, outputEntries, n));
  };
}
