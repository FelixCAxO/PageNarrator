import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { decodeFourComponentJpeg } from '../../src/pdf/jpeg.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { simplePdf, stream, options, loadAsset } from './fixtures.js';

const directory = new URL('./fixtures/jpeg-original/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
const colours = JSON.parse(await readFile(new URL('colour-controls.json', directory), 'utf8'));
const input = name => readFile(new URL(name, directory)).then(bytes => new Uint8Array(bytes));
async function readerFor(run) { const reader = await NativePdfReader.create(simplePdf(''), options); try { return await run(reader); } finally { reader.destroy(); } }
const position = (bytes, marker) => bytes.findIndex((value, i) => value === 255 && bytes[i + 1] === marker);
const changed = (source, edit) => { const result = source.slice(); edit(result); return result; };

describe('original bounded four-component baseline JPEG', () => {
  it.each(manifest.records)('reconstructs authored $id with an independent direct-IDCT reference', async fixture => {
    const bytes = await input(fixture.input.path), expected = await input(fixture.expected.path);
    await readerFor(reader => {
      const actual = decodeFourComponentJpeg(reader, bytes, fixture.width, fixture.height);
      expect(actual).toHaveLength(expected.length);
      expect(actual.reduce((max, value, i) => Math.max(max, Math.abs(value - expected[i])), 0)).toBeLessThanOrEqual(fixture.rawSampleBound);
    });
  });

  it('matches inverse-RGB rounding before YCCK complement on exact half ties', async () => {
    const bytes = await input('rounding-adobe2.jpg');
    await readerFor(reader => {
      const actual = decodeFourComponentJpeg(reader, bytes, 16, 8);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) expect([...actual.subarray((y * 16 + x) * 4, (y * 16 + x + 1) * 4)]).toEqual(x < 8 ? [255, 255, 33, 0] : [222, 255, 0, 0]);
    });
  });

  it('decodes maximum-length Huffman codes and all63 category10 AC positions against a direct-IDCT oracle', async () => {
    const fixture = JSON.parse(await readFile(new URL('dense-long-huffman.json', directory), 'utf8'));
    const bytes = await input(fixture.input.path), expected = await input(fixture.expected.path);
    expect(fixture.maximumCodeLength).toBe(16); expect(fixture.symbols).toBe(256);
    await readerFor(reader => {
      const actual = decodeFourComponentJpeg(reader, bytes, fixture.width, fixture.height);
      expect(actual).toHaveLength(expected.length);
      expect(actual.reduce((max, value, i) => Math.max(max, Math.abs(value - expected[i])), 0)).toBeLessThanOrEqual(fixture.maximumAbsoluteSampleDifference);
    });
  });

  it('rewinds temporary WASM allocation after successful and malformed image decoding', async () => {
    const bytes = await input('dc-only.jpg');
    await readerFor(reader => {
      const cursor = () => { reader.api.pn_pdf_mark(); const at = reader.api.pn_pdf_alloc(16); reader.api.pn_pdf_rewind(); return at; };
      const before = cursor(); decodeFourComponentJpeg(reader, bytes, 8, 8); expect(cursor()).toBe(before);
      expect(() => decodeFourComponentJpeg(reader, bytes.subarray(0, -2), 8, 8)).toThrow(/baseline/); expect(cursor()).toBe(before);
      expect(reader.api.pn_pdf_error()).toBe(0);
    });
  });

  it('rejects unsupported coding, malformed tables, stuffing and restart sequences', async () => {
    const bytes = await input('dc-only.jpg'), ac = await input('ac-and-stuffing.jpg'), restart = await input('restart-reset.jpg');
    const cases = [
      [bytes.subarray(0, -2), 1], [Uint8Array.from([...bytes, 1]), 1],
      [changed(bytes, b => { b[position(b, 192) + 1] = 194; }), 3],
      [changed(bytes, b => { b[position(b, 192) + 4] = 12; }), 3],
      [changed(bytes, b => { b[position(b, 219) + 5] = 0; }), 1],
      [changed(bytes, b => { const p = position(b, 192); b[p + 13] = b[p + 10]; }), 1],
      [changed(bytes, b => { b[position(b, 196) + 5] = 3; }), 1],
      [changed(bytes, b => { b[position(b, 218) + 6] = 51; }), 1],
      [changed(ac, b => { b[position(b, 0) + 1] = 1; }), 1],
      [changed(restart, b => { b[position(b, 208) + 1] = 211; }), 1],
    ];
    await readerFor(reader => {
      for (const [source, expected] of cases) {
        reader.api.pn_pdf_mark();
        try {
          const pointer = reader.copy(source), result = reader.api.pn_pdf_jpeg(pointer, source.length, 0, 0, 0, 0);
          const status = new DataView(reader.api.memory.buffer, result, 28).getUint32(0, true);
          if (status) expect(status).toBe(expected);
          else {
            const info = new Uint32Array(reader.api.memory.buffer, result, 7).slice(), output = reader.api.pn_pdf_alloc(info[5]), scratch = reader.api.pn_pdf_alloc(info[4]);
            expect(new DataView(reader.api.memory.buffer, reader.api.pn_pdf_jpeg(pointer, source.length, output, info[5], scratch, info[4]), 28).getUint32(0, true)).toBe(expected);
          }
        } finally { reader.api.pn_pdf_rewind(); }
      }
    });
  });

  it('keeps output/scratch canaries intact and enforces capacities, dimensions, input and pointer budgets', async () => {
    const bytes = await input('dc-only.jpg');
    await readerFor(reader => {
      reader.api.pn_pdf_mark();
      try {
        const pointer = reader.copy(bytes), at = reader.api.pn_pdf_jpeg(pointer, bytes.length, 0, 0, 0, 0), info = new Uint32Array(reader.api.memory.buffer, at, 7).slice();
        const output = reader.api.pn_pdf_alloc(info[5] + 32), scratch = reader.api.pn_pdf_alloc(info[4] + 32);
        new Uint8Array(reader.api.memory.buffer, output, info[5] + 32).fill(165); new Uint8Array(reader.api.memory.buffer, scratch, info[4] + 32).fill(165);
        const status = (...args) => new DataView(reader.api.memory.buffer, reader.api.pn_pdf_jpeg(...args), 28).getUint32(0, true);
        expect(status(pointer, bytes.length, output + 16, info[5] - 1, scratch + 16, info[4])).toBe(2);
        expect(status(pointer, bytes.length, output + 16, info[5], scratch + 16, info[4] - 1)).toBe(2);
        expect(status(0, bytes.length, 0, 0, 0, 0)).toBe(1); expect(status(pointer, 32 * 1024 * 1024 + 1, 0, 0, 0, 0)).toBe(2);
        expect(status(pointer, bytes.length, output + 16, info[5], scratch + 16, info[4])).toBe(0);
        for (const [p, size] of [[output, info[5]], [scratch, info[4]]]) {
          expect(new Uint8Array(reader.api.memory.buffer, p, 16).every(v => v === 165)).toBe(true);
          expect(new Uint8Array(reader.api.memory.buffer, p + 16 + size, 16).every(v => v === 165)).toBe(true);
        }
        const huge = changed(bytes, b => { const p = position(b, 192); b[p + 5] = b[p + 6] = b[p + 7] = b[p + 8] = 255; }), hugePointer = reader.copy(huge);
        expect(status(hugePointer, huge.length, 0, 0, 0, 0)).toBe(2);
      } finally { reader.api.pn_pdf_rewind(); }
    });
  });
});

async function pixels(bytes, { width, height, jpeg, parameter, decode, icc }) {
  const profile = icc ? stream(await loadAsset('iccs/CGATS001Compat-v2-micro.icc'), '/N 4') : null;
  const space = icc ? '[/ICCBased 7 0 R]' : '/DeviceCMYK';
  const data = simplePdf('/I Do', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [
    stream(bytes, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8 /ColorSpace ${space} ${jpeg ? '/Filter /DCTDecode' : ''} ${jpeg && parameter !== null ? `/DecodeParms << /ColorTransform ${parameter} >>` : ''} ${decode ? '/Decode [1 0 1 0 1 0 1 0]' : ''}`), ...(profile ? [profile] : []),
  ] });
  const core = await createPdfDocumentCore(data, options); try { return (await core.pagePayload(1)).commands.find(c => c.op === 'image').pixels; } finally { core.destroy(); }
}
const cases = colours.streams.flatMap(source => [null, 0, 1].flatMap(parameter => [false, true].flatMap(decode => [false, true].map(icc => ({ source, parameter, decode, icc })))));
describe('PDF four-channel JPEG transform, Decode and ICC contract', () => {
  it.each(cases)('matches independently authored raw components: $source.id CT=$parameter reverse=$decode ICC=$icc', async ({ source, parameter, decode, icc }) => {
    const bytes = await input(source.id + '.jpg'), transform = source.marker ?? (parameter === 1 ? 2 : 0), patches = transform === 2 ? source.inverseYcckPatches : source.literalPatches;
    const raw = Uint8Array.from(Array.from({ length: source.width * source.height }, (_, i) => patches[Math.floor((i % source.width) / 8)]).flat());
    const settings = { width: source.width, height: source.height, parameter, decode, icc };
    expect([...await pixels(bytes, { ...settings, jpeg: true })]).toEqual([...await pixels(raw, { ...settings, jpeg: false })]);
  });
});
