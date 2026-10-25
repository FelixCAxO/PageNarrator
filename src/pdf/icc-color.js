// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original ICC v2/v4 matrix/TRC and lut8/lut16 reader, ICC.1 sections 7-10.
import { PdfEngineError } from './native-reader.js';
import { inverseColorMatrix, multiplyColorMatrix } from './color-matrix.js';
import { readIccLabB2a } from './icc-lut-inverse.js';
const clamp = n => Math.max(0, Math.min(1, n));
const inverseAdaptation = inverseColorMatrix([.9555766, -.0230393, .0631636, -.0282895, 1.0099416, .0210077, .0122982, -.020483, 1.3299098]);
const inversePrimaries = inverseColorMatrix([3.2404542, -1.5371385, -.4985314, -.969266, 1.8760108, .041556, .0556434, -.2040259, 1.0572252]);
export function rgbToXyzD50(values) {
  const linear = values.map(value => { const n = clamp(value); return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
  return multiplyColorMatrix(inverseAdaptation, multiplyColorMatrix(inversePrimaries, linear));
}
export function adaptXyzToD50(xyz, white) {
  const forward = [.8951, .2664, -.1614, -.7502, 1.7135, .0367, .0389, -.0685, 1.0296], inverse = [.9869929, -.1470543, .1599627, .4323053, .5183603, .0492912, -.0085287, .0400428, .9684867];
  const product = (matrix, values) => [0, 1, 2].map(i => matrix[i * 3] * values[0] + matrix[i * 3 + 1] * values[1] + matrix[i * 3 + 2] * values[2]);
  const source = product(forward, white), target = product(forward, [.9642, 1, .8249]);
  if (source.some(n => n <= 0)) throw new PdfEngineError('Invalid calibrated PDF white point.', 'pdf_corrupt');
  return product(inverse, product(forward, xyz).map((n, i) => n * target[i] / source[i]));
}
export function xyzD50ToRgb([x, y, z]) {
  const X = .9555766 * x - .0230393 * y + .0631636 * z, Y = -.0282895 * x + 1.0099416 * y + .0210077 * z, Z = .0122982 * x - .020483 * y + 1.3299098 * z;
  return [3.2404542 * X - 1.5371385 * Y - .4985314 * Z, -.969266 * X + 1.8760108 * Y + .041556 * Z, .0556434 * X - .2040259 * Y + 1.0572252 * Z]
    .map(n => clamp(n <= .0031308 ? 12.92 * n : 1.055 * n ** (1 / 2.4) - .055));
}
export function labToXyz([L, a, b], white = [.9642, 1, .8249]) {
  const y = (L + 16) / 116, inverse = t => t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29);
  return [inverse(y + a / 500) * white[0], inverse(y) * white[1], inverse(y - b / 200) * white[2]];
}
export function parseIccProfile(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const error = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
  const range = (at, n) => { if (!Number.isSafeInteger(at) || at < 0 || n < 0 || at + n > bytes.length) error('ICC range exceeds its profile.'); return at; };
  const u8 = at => bytes[range(at, 1)], u16 = at => v.getUint16(range(at, 2)), u32 = at => v.getUint32(range(at, 4)), fixed = at => v.getInt32(range(at, 4)) / 65536;
  const signature = at => String.fromCharCode(...bytes.subarray(range(at, 4), at + 4));
  if (u32(0) !== bytes.length || signature(36) !== 'acsp' || ![2, 4].includes(u8(8))) error('Invalid ICC profile header.');
  const space = signature(16), pcs = signature(20), channels = ({ 'RGB ': 3, 'GRAY': 1, 'CMYK': 4 })[space];
  if (!channels || !['Lab ', 'XYZ '].includes(pcs)) throw new PdfEngineError(`ICC ${space}/${pcs} is not implemented yet.`);
  const count = u32(128), tags = new Map(); if (count > 256) error('Too many ICC tags.');
  for (let i = 0; i < count; i++) { const row = 132 + i * 12, at = u32(row + 4), size = u32(row + 8); range(at, size); if (size < 8) error('Truncated ICC tag.'); tags.set(signature(row), { at, size }); }
  const tag = name => { const t = tags.get(name); if (!t) error(`Missing ICC ${name} tag.`); return t; };
  const within = (t, at, size) => { if (at < t.at || at + size > t.at + t.size) error('ICC tag data exceeds its bounds.'); };
  const xyz = name => { const t = tag(name); within(t, t.at, 20); if (signature(t.at) !== 'XYZ ') error('Invalid ICC XYZ tag.'); return [fixed(t.at + 8), fixed(t.at + 12), fixed(t.at + 16)]; };
  const curve = name => {
    const t = tag(name), type = signature(t.at);
    if (type === 'curv') {
      within(t, t.at, 12); const count = u32(t.at + 8); if (count > 65536) error('ICC curve is too long.'); within(t, t.at + 12, count * 2);
      if (!count) return Object.assign(n => clamp(n), { inverse: n => clamp(n) });
      if (count === 1) { const gamma = u16(t.at + 12) / 256; if (!gamma) error('Invalid ICC gamma.'); return Object.assign(n => clamp(n) ** gamma, { inverse: n => clamp(n) ** (1 / gamma) }); }
      const values = Array.from({ length: count }, (_, index) => u16(t.at + 12 + index * 2));
      const forward = n => { const x = clamp(n) * (count - 1), left = Math.floor(x), right = Math.min(count - 1, left + 1); return (values[left] * (1 - (x - left)) + values[right] * (x - left)) / 65535; };
      const monotone = values.every((value, index) => !index || value >= values[index - 1]);
      return Object.assign(forward, { inverse: !monotone ? null : n => {
        const target = n * 65535; if (target <= values[0]) return 0; if (target >= values.at(-1)) return 1;
        let low = 0, high = count - 1;
        while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (values[middle] < target) low = middle; else high = middle; }
        return (low + (target - values[low]) / (values[high] - values[low])) / (count - 1);
      } });
    }
    if (type === 'para') {
      within(t, t.at, 12); const kind = u16(t.at + 8), lengths = [1, 3, 4, 5, 7]; if (kind > 4) error('Unknown ICC parametric curve.'); within(t, t.at + 12, lengths[kind] * 4);
      const p = Array.from({ length: lengths[kind] }, (_, i) => fixed(t.at + 12 + i * 4));
      if (p[0] <= 0 || kind && p[1] === 0) error('Invalid ICC parametric curve.');
      const forward = n => { const [g, a = 1, b = 0, c = 0, d = -b / a, e = c, f = 0] = p; n = clamp(n); return kind === 0 ? n ** g : kind <= 2 ? n >= -b / a ? (a * n + b) ** g + c : c : n >= d ? (a * n + b) ** g + (kind === 4 ? e : 0) : c * n + (kind === 4 ? f : 0); };
      const [g, a = 1, b = 0, c = 0, d = -b / a, e = c, f = 0] = p;
      const monotone = kind === 0 || a > 0 && (kind <= 2 || c >= 0 && a * Math.max(0, d) + b >= 0
        && (a * Math.max(0, d) + b) ** g + (kind === 4 ? e : 0) >= c * Math.max(0, d) + (kind === 4 ? f : 0));
      return Object.assign(forward, { inverse: !monotone ? null : n => {
        if (n <= forward(0)) return 0; if (n >= forward(1)) return 1;
        if (kind === 0) return clamp(n ** (1 / g));
        if (kind <= 2) return clamp(((Math.max(0, n - c)) ** (1 / g) - b) / a);
        const boundary = c * d + (kind === 4 ? f : 0);
        return clamp(n < boundary && c > 0 ? (n - (kind === 4 ? f : 0)) / c
          : Math.max(d, ((Math.max(0, n - (kind === 4 ? e : 0))) ** (1 / g) - b) / a));
      } });
    }
    throw new PdfEngineError(`ICC ${type} curve is not implemented yet.`);
  };
  const lut = tags.get('A2B0');
  if (lut) {
    const at = lut.at, type = signature(at), sixteen = type === 'mft2';
    if (!sixteen && type !== 'mft1') throw new PdfEngineError(`ICC ${type} transform is not implemented yet.`);
    within(lut, at, sixteen ? 52 : 48);
    const input = u8(at + 8), output = u8(at + 9), grid = u8(at + 10), inputEntries = sixteen ? u16(at + 48) : 256, outputEntries = sixteen ? u16(at + 50) : 256, sampleBytes = sixteen ? 2 : 1;
    if (input !== channels || output !== 3 || grid < 2 || grid > 33 || grid ** input > 2_000_000 || inputEntries < 2 || outputEntries < 2) error('Invalid ICC LUT dimensions.');
    const inputs = at + (sixteen ? 52 : 48), clut = inputs + input * inputEntries * sampleBytes, outputs = clut + grid ** input * output * sampleBytes;
    within(lut, outputs, output * outputEntries * sampleBytes);
    const sample = at => sixteen ? u16(at) / 65535 : u8(at) / 255;
    const interpolate = (at, count, n) => { const x = clamp(n) * (count - 1), left = Math.floor(x), fraction = x - left; return sample(at + left * sampleBytes) * (1 - fraction) + sample(at + Math.min(left + 1, count - 1) * sampleBytes) * fraction; };
    const matrix = Array.from({ length: 9 }, (_, i) => fixed(at + 12 + i * 4));
    const toXyz = values => {
      if (values.length !== input) error('ICC component count mismatch.');
      if (input === 3) values = [0, 1, 2].map(row => matrix[row * 3] * values[0] + matrix[row * 3 + 1] * values[1] + matrix[row * 3 + 2] * values[2]);
      const coordinates = values.map((n, i) => interpolate(inputs + i * inputEntries * sampleBytes, inputEntries, n) * (grid - 1));
      const base = coordinates.map(n => Math.min(grid - 2, Math.floor(n))), fractions = coordinates.map((n, i) => n - base[i]), result = [0, 0, 0];
      for (let corner = 0; corner < 1 << input; corner++) {
        let index = 0, weight = 1; for (let i = 0; i < input; i++) { const upper = corner >> i & 1; index = index * grid + base[i] + upper; weight *= upper ? fractions[i] : 1 - fractions[i]; }
        for (let channel = 0; channel < output; channel++) result[channel] += sample(clut + (index * output + channel) * sampleBytes) * weight;
      }
      const encoded = result.map((n, i) => interpolate(outputs + i * outputEntries * sampleBytes, outputEntries, n));
      if (pcs === 'XYZ ') return encoded.map(n => n * (sixteen ? 65535 / 32768 : 255 / 128));
      const factor = u8(8) === 2 && sixteen ? 65535 / 65280 : 1;
      return labToXyz([encoded[0] * factor * 100, encoded[1] * factor * 255 - 128, encoded[2] * factor * 255 - 128]);
    };
    const fromXyz = channels === 4 && pcs === 'Lab ' ? readIccLabB2a(bytes, tags.get('B2A0')) : undefined;
    return { channels, toXyz, ...(fromXyz ? { fromXyz } : {}), convert: values => xyzD50ToRgb(toXyz(values)) };
  }
  if (space === 'RGB ' && pcs === 'XYZ ') {
    const columns = ['r', 'g', 'b'].map(c => xyz(`${c}XYZ`)), curves = ['r', 'g', 'b'].map(c => curve(`${c}TRC`));
    const toXyz = values => { const linear = values.map((n, i) => curves[i](n)); return [0, 1, 2].map(row => columns.reduce((sum, column, i) => sum + column[row] * linear[i], 0)); };
    const inverse = inverseColorMatrix([0, 1, 2].flatMap(row => columns.map(column => column[row])));
    const fromXyz = inverse && curves.every(curve => curve.inverse) ? values => multiplyColorMatrix(inverse, values).map((n, i) => curves[i].inverse(n)) : null;
    return { channels, toXyz, fromXyz, convert: values => xyzD50ToRgb(toXyz(values)) };
  }
  if (space === 'GRAY' && pcs === 'XYZ ') { const white = xyz('wtpt'), gamma = curve('kTRC'), toXyz = values => white.map(n => n * gamma(values[0])); return { channels, toXyz, convert: values => xyzD50ToRgb(toXyz(values)) }; }
  throw new PdfEngineError('This ICC profile transform is not implemented yet.');
}
