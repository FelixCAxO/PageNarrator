// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Wholly original literal samples and predictor encoding for source-only controls.
import { deflateSync } from 'node:zlib';
import { simplePdf, stream } from './fixtures.js';
export const flateWidth = 3, flateHeight = 2;
export const flateCmyk = Uint8Array.of(0, 64, 128, 255, 255, 128, 64, 0, 17, 91, 153, 223, 32, 96, 160, 224, 224, 160, 96, 32, 254, 1, 127, 65);
export const flateAlpha = Uint8Array.of(0, 64, 128, 255, 17, 239);
export function encodeNativeFlate(samples, colors, predictor) {
  const row = flateWidth * colors;
  if (predictor === 1) return new Uint8Array(samples);
  const png = predictor >= 10, out = new Uint8Array(samples.length + (png ? flateHeight : 0));
  let at = 0;
  for (let y = 0; y < flateHeight; y++) {
    const filter = png ? predictor - 10 : 1; if (png) out[at++] = filter;
    for (let x = 0; x < row; x++) {
      const value = samples[y * row + x], left = x >= colors ? samples[y * row + x - colors] : 0;
      const up = y ? samples[(y - 1) * row + x] : 0, corner = y && x >= colors ? samples[(y - 1) * row + x - colors] : 0;
      const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
      const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : a <= b && a <= c ? left : b <= c ? up : corner;
      out[at++] = value - prediction;
    }
  }
  return out;
}
export function nativeFlatePdf({ predictor = 1, mask = false, base = '', maskEntry = '', filter = '/FlateDecode', samples = flateCmyk, width = flateWidth, height = flateHeight, bits = 8, space = '/DeviceCMYK', encoded = null, maskEncoded = null } = {}) {
  const parameters = colors => `/DecodeParms << /Predictor ${predictor} /Colors ${colors} /Columns ${flateWidth} /BitsPerComponent 8 >>`;
  return simplePdf('/I Do', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [
    stream(encoded || deflateSync(encodeNativeFlate(samples, 4, predictor)), `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${space} /BitsPerComponent ${bits} /Filter ${filter} ${parameters(4)} ${mask ? '/SMask 7 0 R' : ''} ${base}`),
    stream(maskEncoded || deflateSync(encodeNativeFlate(flateAlpha, 1, predictor)), `/Type /XObject /Subtype /Image /Width ${flateWidth} /Height ${flateHeight} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ${parameters(1)} ${maskEntry}`),
  ] });
}
