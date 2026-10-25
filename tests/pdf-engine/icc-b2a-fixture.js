// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Wholly original affine CMYK inverse profiles; no retained/private profile bytes.
export function syntheticCmykB2aProfile({ version = 2, sixteen = false, inverse = true, inverseType = null, matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1] } = {}) {
  const ascii = text => new Uint8Array(Buffer.from(text, 'ascii'));
  const fixed = (bytes, at, n) => new DataView(bytes.buffer).setInt32(at, Math.round(n * 65536));
  const tag = (name, length) => { const bytes = new Uint8Array(length); bytes.set(ascii(name)); return bytes; };
  const description = text => {
    if (version === 4) {
      const bytes = tag('mluc', 28 + text.length * 2), v = new DataView(bytes.buffer); v.setUint32(8, 1); v.setUint32(12, 12); v.setUint16(16, 0x656e); v.setUint16(18, 0x5553); v.setUint32(20, text.length * 2); v.setUint32(24, 28);
      [...text].forEach((c, i) => v.setUint16(28 + i * 2, c.charCodeAt(0))); return bytes;
    }
    const textBytes = ascii(text + '\0'), bytes = tag('desc', 12 + textBytes.length + 78); new DataView(bytes.buffer).setUint32(8, textBytes.length); bytes.set(textBytes, 12); return bytes;
  };
  const xyz = tag('XYZ ', 20); [.9642, 1, .8249].forEach((n, i) => fixed(xyz, 8 + i * 4, n));
  const forward = tag('mft1', 48 + 4 * 256 + 16 * 3 + 3 * 256); forward.set([4, 3, 2], 8); [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((n, i) => fixed(forward, 12 + i * 4, n));
  for (let c = 0; c < 4; c++) for (let i = 0; i < 256; i++) forward[48 + c * 256 + i] = i;
  for (let i = 0; i < 16; i++) forward.set([128, 128, 128], 48 + 4 * 256 + i * 3);
  for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) forward[48 + 4 * 256 + 16 * 3 + c * 256 + i] = i;
  const entries = sixteen ? 2 : 256, width = sixteen ? 2 : 1, head = sixteen ? 52 : 48;
  const reverse = tag(inverseType || (sixteen ? 'mft2' : 'mft1'), head + 3 * entries * width + 8 * 4 * width + 4 * entries * width), v = new DataView(reverse.buffer);
  reverse.set([3, 4, 2], 8); matrix.forEach((n, i) => fixed(reverse, 12 + i * 4, n)); if (sixteen) { v.setUint16(48, entries); v.setUint16(50, entries); }
  const sample = (at, value) => sixteen ? v.setUint16(at, value * 257) : reverse[at] = value;
  for (let c = 0; c < 3; c++) for (let i = 0; i < entries; i++) sample(head + (c * entries + i) * width, i / (entries - 1) * 255);
  const clut = head + 3 * entries * width;
  for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) {
    const values = [16 + 64 * x + 32 * y + 16 * z, 32 + 16 * x + 64 * y + 32 * z, 48 + 32 * x + 16 * y + 64 * z, 64 + 16 * x + 32 * y + 16 * z];
    values.forEach((value, c) => sample(clut + (((x * 2 + y) * 2 + z) * 4 + c) * width, value));
  }
  const outputs = clut + 8 * 4 * width;
  for (let c = 0; c < 4; c++) for (let i = 0; i < entries; i++) sample(outputs + (c * entries + i) * width, i / (entries - 1) * 255);
  const text = ascii('Original PageNarrator fixture\0'), copyright = version === 4 ? description('Original PageNarrator fixture') : tag('text', 8 + text.length); if (version !== 4) copyright.set(text, 8);
  const tags = [['desc', description('Original affine CMYK B2A')], ['cprt', copyright], ['wtpt', xyz], ['A2B0', forward], ...(inverse ? [['B2A0', reverse]] : [])];
  const align = n => Math.ceil(n / 4) * 4, bytes = new Uint8Array(align(132 + tags.length * 12) + tags.reduce((n, [, data]) => n + align(data.length), 0)), view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length); view.setUint32(8, version === 4 ? 0x04300000 : 0x02400000);
  for (const [at, name] of [[12, 'prtr'], [16, 'CMYK'], [20, 'Lab '], [36, 'acsp']]) bytes.set(ascii(name), at);
  [2026, 10, 23, 0, 0, 0].forEach((n, i) => view.setUint16(24 + i * 2, n)); [.9642, 1, .8249].forEach((n, i) => fixed(bytes, 68 + i * 4, n)); view.setUint32(128, tags.length);
  let at = align(132 + tags.length * 12);
  for (const [i, [name, data]] of tags.entries()) { const row = 132 + i * 12; bytes.set(ascii(name), row); view.setUint32(row + 4, at); view.setUint32(row + 8, data.length); bytes.set(data, at); at += align(data.length); }
  return bytes;
}

export function syntheticB2aExpected([L, a, b], sixteen = false) {
  // lut16Type has tag-specific legacy Lab encoding, including in v4 profiles.
  const factor = sixteen ? 65280 / 65535 : 1;
  const [x, y, z] = [L / 100, (a + 128) / 255, (b + 128) / 255].map(n => Math.max(0, Math.min(1, n * factor)));
  return [16 + 64 * x + 32 * y + 16 * z, 32 + 16 * x + 64 * y + 32 * z, 48 + 32 * x + 16 * y + 64 * z, 64 + 16 * x + 32 * y + 16 * z].map(n => n / 255);
}
