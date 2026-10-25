// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { constants, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { buildPdfDisplayList } from '../../src/pdf/display-list.js';
import { iteratePdfContent } from '../../src/pdf/inline-image.js';
import { options, simplePdf, show } from './fixtures.js';

const latin = bytes => Buffer.from(bytes).toString('latin1');
const raw = Uint8Array.of(32, 69, 73, 32, 0, 255, 10, 13);
const grayPixels = bytes => [...bytes].flatMap(value => [value, value, value, 255]);
function inline(bytes, dictionary = '/W 8 /H 1 /BPC 8 /CS /G', separator = ' ') {
  return `BI ${dictionary} ID${separator}${latin(bytes)}\nEI`;
}
async function payload(bytes) {
  const core = await createPdfDocumentCore(bytes, options);
  try { return await core.pagePayload(1); } finally { core.destroy(); }
}
function ascii85(bytes) {
  let result = '';
  for (let at = 0; at < bytes.length; at += 4) {
    const count = Math.min(4, bytes.length - at);
    let value = 0;
    for (let i = 0; i < 4; i++) value = value * 256 + (bytes[at + i] ?? 0);
    const digits = Array(5);
    for (let i = 4; i >= 0; i--) { digits[i] = String.fromCharCode(value % 85 + 33); value = Math.floor(value / 85); }
    result += digits.slice(0, count + 1).join('');
  }
  return Buffer.from(`${result}~>`, 'ascii');
}
function literalLzw(bytes) {
  const bits = [256, ...bytes, 257].map(code => code.toString(2).padStart(9, '0')).join('');
  return Buffer.from(bits.padEnd(Math.ceil(bits.length / 8) * 8, '0').match(/.{8}/g).map(byte => parseInt(byte, 2)));
}

describe('original inline PDF images', () => {
  it('preserves binary whitespace and embedded EI bytes using exact raw row lengths', async () => {
    const result = await payload(simplePdf(inline(raw)));
    expect([...result.commands.find(command => command.op === 'image').pixels]).toEqual(grayPixels(raw));
    expect(result.inspection.hasRasterImage).toBe(true);
  });

  it.each([
    ['ASCIIHex', Buffer.from(`${Buffer.from(raw).toString('hex')}>`), '/AHx'],
    ['ASCII85', ascii85(raw), '/A85'],
    ['RunLength', Buffer.from([raw.length - 1, ...raw, 128]), '/RL'],
    ['LZW', literalLzw(raw), '/LZW'],
    ['Flate dynamic', deflateSync(raw), '/Fl'],
    ['Flate fixed', deflateSync(raw, { strategy: constants.Z_FIXED }), '/FlateDecode'],
    ['Flate stored', deflateSync(raw, { level: 0 }), '/Fl'],
    ['ASCII85 then Flate', ascii85(deflateSync(raw)), '[/A85 /Fl]'],
  ])('frames %s at its encoded end instead of scanning for EI', async (_name, encoded, filter) => {
    const result = await payload(simplePdf(inline(encoded, `/W 8 /H 1 /BPC 8 /CS /G /F ${filter}`)));
    expect([...result.commands.find(command => command.op === 'image').pixels]).toEqual(grayPixels(raw));
  });

  it('resumes the same graphics and text state across multiple inline images', async () => {
    const result = await payload(simplePdf(`q 2 0 0 3 10 20 cm ${inline(raw)} ${inline(raw)} Q ${show('After images')}`));
    const images = result.commands.filter(command => command.op === 'image');
    expect(images).toHaveLength(2);
    expect(images.map(image => image.matrix)).toEqual([[2, 0, 0, 3, 10, 20], [2, 0, 0, 3, 10, 20]]);
    expect(result.items.map(item => item.str)).toEqual(['After images']);
    expect(result.items[0].transform).toEqual([12, 0, 0, 12, 54, 700]);
  });

  it('uses a named indexed color resource and byte-aligned packed rows', async () => {
    const result = await payload(simplePdf(inline([0b01000000, 0b10000000], '/W 2 /H 2 /BPC 1 /CS /Palette'), {
      page: '/Resources << /ColorSpace << /Palette [/Indexed /DeviceRGB 1 <ff000000ff00>] >> >>',
    }));
    expect([...result.commands.find(command => command.op === 'image').pixels]).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255,
    ]);
  });

  it.each([
    '/Width 99 /W 8 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray',
    '/W 8 /Width 99 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray',
  ])('gives abbreviated inline keys precedence independent of order: %s', async dictionary => {
    const result = await payload(simplePdf(inline(raw, dictionary)));
    expect(result.commands.find(command => command.op === 'image').width).toBe(8);
  });

  it('ignores an untrusted Length key when locating inline data', async () => {
    const result = await payload(simplePdf(inline(raw, '/W 8 /H 1 /BPC 8 /CS /G /Length 1')));
    expect([...result.commands.find(command => command.op === 'image').pixels]).toEqual(grayPixels(raw));
  });

  it('ignores unlisted mask keys rather than applying XObject-only transparency', async () => {
    const result = await payload(simplePdf(inline(raw, '/W 8 /H 1 /BPC 8 /CS /G /Mask [32 32] /SMask null /Type /XObject')));
    expect([...result.commands.find(command => command.op === 'image').pixels]).toEqual(grayPixels(raw));
  });

  it.each(['constructor', 'toString'])('resolves the legal resource /%s and ignores unlisted keys with that name', async name => {
    const result = await payload(simplePdf(inline(raw, `/W 8 /H 1 /BPC 8 /CS /${name} /${name} 7`), {
      page: `/Resources << /ColorSpace << /${name} /DeviceGray >> >>`,
    }));
    expect([...result.commands.find(command => command.op === 'image').pixels]).toEqual(grayPixels(raw));
  });

  it('preserves LF as the first sample after a single CR separator', async () => {
    const result = await payload(simplePdf(inline([10], '/W 1 /H 1 /BPC 8 /CS /G', '\r')));
    expect([...result.commands.find(command => command.op === 'image').pixels]).toEqual([10, 10, 10, 255]);
  });

  it('permits an ASCII85 delimiter to start data immediately after ID', async () => {
    const result = await payload(simplePdf('BI /W 4 /H 1 /BPC 8 /CS /G /F /A85 ID<!!!!~> EI'));
    expect([...result.commands.find(command => command.op === 'image').pixels]).toEqual(grayPixels([84, 1, 254, 171]));
  });

  it('frames a verified dynamic Huffman stream with repeated-distance symbols', async () => {
    const samples = Buffer.from(' BI data EI bytes and a repeated grayscale plane. '.repeat(512), 'ascii'), encoded = deflateSync(samples);
    expect(encoded[2] >> 1 & 3).toBe(2);
    const result = await payload(simplePdf(inline(encoded, `/W ${samples.length} /H 1 /BPC 8 /CS /G /F /Fl`)));
    expect([...result.commands.find(command => command.op === 'image').pixels]).toEqual(grayPixels(samples));
  });

  it('uses actual fax row consumption to frame a two-row inline image', async () => {
    const bits = '10011' + '00110101' + '000101';
    const encoded = Buffer.from(bits.padEnd(Math.ceil(bits.length / 8) * 8, '0').match(/.{8}/g).map(byte => parseInt(byte, 2)));
    const result = await payload(simplePdf(inline(encoded, '/W 8 /H 2 /BPC 1 /CS /G /F /CCF /DP << /Columns 8 /Rows 2 /EndOfBlock false >>')));
    expect([...result.commands.find(command => command.op === 'image').pixels]).toEqual(grayPixels([...Array(8).fill(255), ...Array(8).fill(0)]));
  });

  it('frames JPEG markers while skipping false EOI and EI bytes in segment payloads', async () => {
    // This exercises marker framing only; browser JPEG decoding is a separate gate.
    const encoded = Uint8Array.of(255, 216, 255, 225, 0, 8, 255, 217, 32, 69, 73, 32, 255, 218, 0, 2, 65, 255, 0, 69, 255, 208, 66, 255, 217);
    const result = await payload(simplePdf(inline(encoded, '/W 1 /H 1 /BPC 8 /CS /G /F /DCT')));
    expect(result.commands.find(command => command.op === 'jpeg').bytes).toEqual(encoded);
  });

  it.each([
    '[/CalGray << /WhitePoint [1 1 1] >>]',
    '[/ICCBased << /N 1 >>]',
    '[/Indexed /CalGray 1 <0000>]',
  ])('rejects a disallowed direct color space: %s', async space => {
    await expect(payload(simplePdf(inline([0], `/W 1 /H 1 /BPC 8 /CS ${space}`)))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it.each([
    '/F [Fl]', '/CS [I RGB 0 <000000>]', '/DP << /Unknown 1 0 R >>', '/IM 1',
  ])('rejects malformed nested/direct inline header values: %s', async extra => {
    await expect(payload(simplePdf(inline(raw, `/W 8 /H 1 /BPC 8 /CS /G ${extra}`)))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it('routes the unchanged retained inline scan through actual image decoding', async () => {
    const result = await payload(new Uint8Array(await readFile(new URL('../fixtures/pdfs/image-only/inline-image.pdf', import.meta.url))));
    expect(result.items).toEqual([]);
    expect(result.inspection).toMatchObject({ hasRasterImage: true, inspectionFailed: false });
    expect(result.commands.find(command => command.op === 'image')).toMatchObject({ width: 1000, height: 1294 });
  });

  it.each([
    'BI /W 1 /H 1 /BPC 8 /CS /G ID ',
    'BI /W 8 /H 1 /BPC 8 /CS /G ID abc\nEI',
    'BI /W 1 /H 1 /BPC 8 /CS /G /F /AHx ID ff\nEI',
    'BI /W 1 /H 1 /BPC 8 /CS /G /F /RL ID \x00a\nEI',
    'BI /W 1 /H 1 /BPC 8 /CS /G /F /A85 ID !!!!!~>\nEIx',
  ])('keeps malformed inline image data corrupt: %s', async content => {
    await expect(payload(simplePdf(content))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it('releases content tokens after native scratch is reused and on document destruction', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      const tokens = reader.content(Buffer.from(inline(raw), 'latin1'));
      const image = tokens.find(id => reader.node(id).kind === 'stream');
      reader.api.pn_pdf_mark(); reader.copy(new Uint8Array(1024).fill(77)); reader.api.pn_pdf_rewind();
      expect([...reader.bytes(image).subarray(0, raw.length)]).toEqual([...raw]);
      reader.releaseContent(tokens);
      expect(reader.temporary.size).toBe(0);
    } finally { reader.destroy(); }
    expect(reader.api).toBeNull();
  });

  it('releases the entire prefix if image framing fails', async () => {
    const reader = await NativePdfReader.create(simplePdf('BI /W 1 /H 1 /BPC 8 /CS /G /F /A85 ID!!!!!~> EIx'), options);
    try {
      const page = reader.checked(reader.api.pn_pdf_resolve(3, 0));
      await expect(buildPdfDisplayList(reader, page, 0, options.loadAsset)).rejects.toMatchObject({ code: 'pdf_corrupt' });
      expect(reader.temporary.size).toBe(0);
    } finally { reader.destroy(); }
  });

  it('releases a suspended prefix when the consumer cancels iteration', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      const iterator = iteratePdfContent(reader, Buffer.from(`${inline(raw)} q Q`, 'latin1'), 0, options.loadAsset);
      expect((await iterator.next()).value.length).toBeGreaterThan(0);
      expect(reader.temporary.size).toBeGreaterThan(0);
      await iterator.return(); expect(reader.temporary.size).toBe(0);
    } finally { reader.destroy(); }
  });
});
