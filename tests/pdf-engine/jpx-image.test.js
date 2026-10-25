// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest';
import lossless from '../fixtures/jpx-lossless.json';
import lossy from '../fixtures/jpx-irreversible.json';
import mapping from '../fixtures/jpx-channel-mapping.json';
import * as reference from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { readPdfImage } from '../../src/pdf/image-data.js';
import { parseJpxContainer } from '../../src/pdf/jpx.js';
import { simplePdf, stream, options } from './fixtures.js';
const source = item => new Uint8Array(Buffer.from(item.encoded, 'base64'));
function imagePdf(item, dictionary = '', bytes = source(item)) {
  return simplePdf('q 170 0 0 110 0 0 cm /I Do Q', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [stream(bytes, `/Type /XObject /Subtype /Image /Width ${item.width} /Height ${item.height} /Filter /JPXDecode ${dictionary}`)] });
}
const u32 = value => Buffer.from([value >>> 24, value >>> 16, value >>> 8, value]);
const box = (type, ...parts) => { const bytes = Buffer.concat(parts.map(part => Buffer.from(part))); return Buffer.concat([u32(bytes.length + 8), Buffer.from(type), bytes]); };
function container(item, { enumeration = item.components === 1 ? 17 : 16, definitions = [], headerBoxes = [] } = {}) {
  const channelData = definitions.length ? box('cdef', [0, definitions.length], ...definitions.map(([channel, type, association]) => [channel >> 8, channel, type >> 8, type, association >> 8, association])) : [];
  return new Uint8Array(Buffer.concat([box('jP  ', [13, 10, 135, 10]), box('ftyp', Buffer.from('jp2 '), u32(0), Buffer.from('jp2 ')), box('jp2h', box('ihdr', u32(item.height), u32(item.width), [0, item.components, item.bits - 1, 7, 0, 0]), box('colr', [1, 0, 0], u32(enumeration)), channelData, ...headerBoxes), box('jp2c', parseJpxContainer(source(item)).codestream)]));
}

for (const item of [...lossless.cases, ...lossy.cases]) it(`renders independently encoded JPX ${item.id} as PDF image samples`, async () => {
  const core = await createPdfDocumentCore(imagePdf(item), options), expected = new Uint8Array(Buffer.from(item.expected, 'base64'));
  try {
    const image = (await core.pagePayload(1)).commands.find(command => command.op === 'image');
    expect(image).toMatchObject({ width: item.width, height: item.height, format: 'raw' });
    const raw = at => item.bits === 16 ? (expected[at * 2] * 256 + expected[at * 2 + 1]) / 257 : expected[at];
    for (let pixel = 0; pixel < item.width * item.height; pixel++) {
      for (let c = 0; c < 3; c++) expect(Math.abs(image.pixels[pixel * 4 + c] - Math.round(raw(pixel * item.components + (item.components === 1 ? 0 : c))))).toBeLessThanOrEqual(item.maxSampleError || 0);
      expect(image.pixels[pixel * 4 + 3]).toBe(255);
    }
  } finally { core.destroy(); }
});

for (const item of mapping.cases) it(`renders independently decoded JPX ${item.id} channels and opacity`, async () => {
  const alpha = item.components === 2 || item.components === 4, premultiplied = item.id.endsWith('-premultiplied'), core = await createPdfDocumentCore(imagePdf(item, alpha ? `/SMaskInData ${premultiplied ? 2 : 1}` : ''), options), expected = new Uint8Array(Buffer.from(item.expected, 'base64'));
  try {
    const image = (await core.pagePayload(1)).commands.find(command => command.op === 'image');
    for (let pixel = 0; pixel < item.width * item.height; pixel++) {
      const opacity = alpha ? expected[pixel * item.components + item.components - 1] : 255;
      for (let c = 0; c < 3; c++) { const value = expected[pixel * item.components + (item.components === 2 ? 0 : c)]; expect(image.pixels[pixel * 4 + c]).toBe(Math.min(255, Math.round(premultiplied && opacity ? value * 255 / opacity : value))); }
      expect(image.pixels[pixel * 4 + 3]).toBe(opacity);
    }
  } finally { core.destroy(); }
});

it('lets PDF ColorSpace override embedded color and orders cdef color channels', async () => {
  const item = lossless.cases.find(item => item.id === 'rgb'), expected = new Uint8Array(Buffer.from(item.expected, 'base64'));
  for (const [bytes, dictionary, order] of [[container(item, { enumeration: 17 }), '/ColorSpace /DeviceRGB', [0, 1, 2]], [container(item, { definitions: [[0, 0, 3], [1, 0, 2], [2, 0, 1]] }), '', [2, 1, 0]]]) {
    const core = await createPdfDocumentCore(imagePdf(item, dictionary, bytes), options);
    try { const image = (await core.pagePayload(1)).commands.find(command => command.op === 'image'); for (let pixel = 0; pixel < item.width * item.height; pixel++) for (let c = 0; c < 3; c++) expect(image.pixels[pixel * 4 + c]).toBe(expected[pixel * 3 + order[c]]); } finally { core.destroy(); }
  }
});
it('recovers original two-bit JPX indices and color-key ranges after normalized storage', async () => {
  const item = { ...mapping.cases.find(item => item.id === 'palette-rgb'), components: 1 };
  const encoded = container(item, { headerBoxes: [box('pclr', [0, 4, 1, 1, 0, 1, 2, 3]), box('cmap', [0, 0, 1, 0])] });
  const core = await createPdfDocumentCore(imagePdf(item, '/ColorSpace [/Indexed /DeviceRGB 3 <000000 ff0000 00ff00 0000ff>] /Mask [1 2] /Decode [1 0]', encoded), options);
  const palette = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
  try {
    const image = (await core.pagePayload(1)).commands.find(command => command.op === 'image');
    for (let pixel = 0; pixel < item.width * item.height; pixel++) { expect([...image.pixels.slice(pixel * 4, pixel * 4 + 3)]).toEqual(palette[pixel % 4]); expect(image.pixels[pixel * 4 + 3]).toBe([1, 2].includes(pixel % 4) ? 0 : 255); }
  } finally { core.destroy(); }
});

it.each(['gray-edges', 'rgb-rct', 'gray16-wavelet2'])('matches independent PDF image decoding for %s', async name => {
  const item = lossless.cases.find(item => item.id === name), data = imagePdf(item), core = await createPdfDocumentCore(data, options), task = reference.getDocument({ data: data.slice(), wasmUrl: fileURLToPath(new URL('../../node_modules/pdfjs-dist/wasm/', import.meta.url)).replaceAll('\\', '/') });
  try {
    const image = (await core.pagePayload(1)).commands.find(command => command.op === 'image'), page = await (await task.promise).getPage(1), list = await page.getOperatorList();
    const index = list.fnArray.findIndex(op => op === reference.OPS.paintImageXObject || op === reference.OPS.paintInlineImageXObject); expect(index).toBeGreaterThanOrEqual(0);
    const oracle = list.fnArray[index] === reference.OPS.paintInlineImageXObject ? list.argsArray[index][0] : await new Promise(resolve => page.objs.get(list.argsArray[index][0], resolve));
    expect(oracle).toMatchObject({ width: item.width, height: item.height });
    for (let pixel = 0; pixel < item.width * item.height; pixel++) for (let c = 0; c < 3; c++) expect(Math.abs(image.pixels[pixel * 4 + c] - oracle.data[pixel * (oracle.kind === 3 ? 4 : 3) + c])).toBeLessThanOrEqual(1);
  } finally { core.destroy(); await task.destroy(); }
});

it('takes JPX precision from the codestream and ignores non-stencil Decode', async () => {
  const item = lossless.cases.find(item => item.id === 'gray16'), core = await createPdfDocumentCore(imagePdf(item, '/BitsPerComponent 1 /Decode [1 0]'), options);
  try {
    const image = (await core.pagePayload(1)).commands.find(command => command.op === 'image'), expected = new Uint8Array(Buffer.from(item.expected, 'base64'));
    for (let pixel = 0; pixel < item.width * item.height; pixel++) expect(image.pixels[pixel * 4]).toBe(Math.round((expected[pixel * 2] * 256 + expected[pixel * 2 + 1]) / 257));
  } finally { core.destroy(); }
});

it('rejects contradictory image dimensions and color components before rendering', async () => {
  const item = lossless.cases.find(item => item.id === 'rgb');
  for (const [fixture, message] of [[{ ...item, width: item.width + 1 }, /dimensions disagree/], [item, /component counts disagree/]]) {
    const core = await createPdfDocumentCore(imagePdf(fixture, fixture === item ? '/ColorSpace /DeviceGray' : ''), options);
    try { await expect(core.pagePayload(1)).rejects.toThrow(message); } finally { core.destroy(); }
  }
});

it('does not accept JPXDecode in an ordinary non-image stream', async () => {
  const item = lossless.cases[0], reader = await NativePdfReader.create(imagePdf(item), options);
  try {
    const id = reader.checked(reader.api.pn_pdf_resolve(6, 0));
    const { decodePdfStream } = await import('../../src/pdf/streams.js');
    await expect(decodePdfStream(reader, id)).rejects.toThrow(/image XObject/);
    expect((await readPdfImage(reader, id, options)).pixels.length).toBe(item.width * item.height * 4);
  } finally { reader.destroy(); }
});
