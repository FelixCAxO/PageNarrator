// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original synthetic color data. No third-party profile bytes.
import { simplePdf, stream } from './fixtures.js';

export const SYNTHETIC_MATRIX = [.58, .25, .1342, .27, .67, .06, .02, .09, .7149];
export function syntheticRgbProfile({ curve = { gamma: 2 }, matrix = SYNTHETIC_MATRIX } = {}) {
  const tag = (type, size) => { const bytes = new Uint8Array(size); bytes.set(Buffer.from(type)); return bytes; };
  const fixed = (bytes, at, value) => new DataView(bytes.buffer).setInt32(at, Math.round(value * 65536));
  const xyz = values => { const bytes = tag('XYZ ', 20); values.forEach((value, i) => fixed(bytes, 8 + i * 4, value)); return bytes; };
  let trc;
  if (curve.parameters) {
    trc = tag('para', 12 + curve.parameters.length * 4); new DataView(trc.buffer).setUint16(8, curve.kind);
    curve.parameters.forEach((value, i) => fixed(trc, 12 + i * 4, value));
  } else {
    const samples = curve.samples || (curve.gamma === null ? [] : [Math.round(curve.gamma * 256)]);
    trc = tag('curv', 12 + samples.length * 2); new DataView(trc.buffer).setUint32(8, samples.length);
    samples.forEach((value, i) => new DataView(trc.buffer).setUint16(12 + i * 2, value));
  }
  const text = Buffer.from('PageNarrator original synthetic RGB\0'), description = tag('desc', 12 + text.length + 78);
  new DataView(description.buffer).setUint32(8, text.length); description.set(text, 12);
  const copyright = tag('text', 8 + text.length); copyright.set(text, 8);
  const tags = [['desc', description], ['cprt', copyright], ['wtpt', xyz([.9642, 1, .8249])],
    ...['r', 'g', 'b'].flatMap((channel, i) => [[`${channel}XYZ`, xyz([matrix[i], matrix[i + 3], matrix[i + 6]])], [`${channel}TRC`, trc]])];
  const align = value => Math.ceil(value / 4) * 4;
  const bytes = new Uint8Array(align(132 + tags.length * 12) + tags.reduce((size, [, data]) => size + align(data.length), 0)), view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length); view.setUint32(8, 0x02400000);
  for (const [at, value] of [[12, 'mntr'], [16, 'RGB '], [20, 'XYZ '], [36, 'acsp']]) bytes.set(Buffer.from(value), at);
  for (const [i, value] of [2026, 10, 16, 0, 0, 0].entries()) view.setUint16(24 + i * 2, value);
  [.9642, 1, .8249].forEach((value, i) => fixed(bytes, 68 + i * 4, value)); view.setUint32(128, tags.length);
  let offset = align(132 + tags.length * 12);
  tags.forEach(([name, data], i) => { const row = 132 + i * 12; bytes.set(Buffer.from(name), row); view.setUint32(row + 4, offset); view.setUint32(row + 8, data.length); bytes.set(data, offset); offset += align(data.length); });
  return bytes;
}

export function iccBlendPdf() {
  return simplePdf('.25 .45 .7 rg q 1 0 0 1 40 400 cm /F Do Q q 1 0 0 1 280 400 cm /R Do Q', {
    page: '/Resources << /XObject << /F 6 0 R /R 9 0 R >> >>',
    extra: [
      stream('0 0 100 80 re f /A gs .7 .2 .1 rg 50 40 100 80 re f q 40 0 0 40 10 130 cm /I Do Q q 1 0 0 1 100 130 cm /R Do Q',
        '/Type /XObject /Subtype /Form /BBox [0 0 220 220] /Group << /S /Transparency /I true /CS [/ICCBased 7 0 R] >> /Resources << /ExtGState << /A 8 0 R >> /XObject << /R 9 0 R /I 10 0 R >> >>'),
      stream(syntheticRgbProfile(), '/N 3'),
      '<< /Type /ExtGState /ca .5 /BM /Multiply >>',
      stream('.2 .7 .4 rg 0 0 80 60 re f q 40 0 0 40 10 90 cm /I Do Q',
        '/Type /XObject /Subtype /Form /BBox [0 0 100 150] /Group << /S /Transparency /I true /CS /DeviceRGB >> /Resources << /XObject << /I 10 0 R >> >>'),
      stream(Uint8Array.of(55, 120, 210), '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8'),
    ],
  });
}
