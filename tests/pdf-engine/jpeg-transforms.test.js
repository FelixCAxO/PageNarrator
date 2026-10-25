import { describe, expect, it } from 'vitest';
import { jpegForPdfColorTransform, readJpegHeader } from '../../src/pdf/jpeg-metadata.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { decodePdfStream } from '../../src/pdf/streams.js';
import { simplePdf, stream, options } from './fixtures.js';

const segment = (marker, body) => [255, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
const adobe = transform => segment(238, [65, 100, 111, 98, 101, 0, 100, 0, 0, 0, 0, transform]);
const jfif = segment(224, [74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const frame = (components = 3, bits = 8) => segment(192, [bits, 0, 1, 0, 2, components, ...Array.from({ length: components }, (_, index) => [index + 1, 17, 0]).flat()]);
const jpeg = (...segments) => Uint8Array.from([255, 216, ...segments.flat(), 255, 217]);
async function decode(source, value) {
  const reader = await NativePdfReader.create(simplePdf('', { extra: [stream(source, `/Filter /DCTDecode /DecodeParms << /ColorTransform ${value} >>`)] }), options);
  try { return await decodePdfStream(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0)), { image: true }); }
  finally { reader.destroy(); }
}

describe('PDF DCT ColorTransform metadata', () => {
  it.each([[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [2, 1]])('honours Adobe %i rather than dictionary %i', (marker, requested) => {
    const source = jpeg(adobe(marker), frame(marker === 2 ? 4 : 3));
    expect(jpegForPdfColorTransform(source, requested)).toBe(source);
  });

  it.each([1, 2])('ignores the option for %i component images', components => {
    const source = jpeg(frame(components));
    for (const requested of [0, 1]) expect(jpegForPdfColorTransform(source, requested)).toBe(source);
  });

  it.each([[3, 0, 0], [3, 1, 1], [4, 0, 0], [4, 1, 2]])('declares the PDF transform for unmarked %i-channel data', (components, requested, expected) => {
    const source = jpeg(frame(components)), before = source.slice(), result = jpegForPdfColorTransform(source, requested);
    expect(readJpegHeader(result).adobeTransform).toBe(expected);
    expect(result.subarray(18)).toEqual(source.subarray(2));
    expect(source).toEqual(before);
  });

  it('removes only conflicting JFIF metadata, preserving every compressed sample and other segment', () => {
    const extra = segment(226, [73, 67, 67, 0, 42]), source = jpeg(jfif, extra, frame());
    const result = jpegForPdfColorTransform(source, 0);
    expect(readJpegHeader(result)).toMatchObject({ components: 3, adobeTransform: 0, jfif: [] });
    expect(result.subarray(18)).toEqual(Uint8Array.from([...extra, ...frame(), 255, 217]));
    expect(readJpegHeader(source).jfif).toHaveLength(1);
    const existing = jpeg(jfif, adobe(0), frame());
    expect(jpegForPdfColorTransform(existing, 1)).toEqual(jpeg(adobe(0), frame()));
  });

  it('retains JFIF for YCbCr and finds an Adobe marker after the sample frame', () => {
    const source = jpeg(jfif, frame(), adobe(1));
    expect(jpegForPdfColorTransform(source, 0)).toBe(source);
    expect(readJpegHeader(source).adobeTransform).toBe(1);
  });

  it.each(['true', '0.5', '2', '/Identity'])('rejects invalid dictionary parameter %s', async value => {
    await expect(decode(jpeg(frame()), value)).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it('applies the option through the production stream decoder and treats null as omitted', async () => {
    const source = jpeg(frame());
    expect(readJpegHeader((await decode(source, '0')).bytes).adobeTransform).toBe(0);
    expect((await decode(source, 'null')).bytes).toEqual(source);
  });

  it.each([
    jpeg(frame(), adobe(0), adobe(1)), jpeg(adobe(3), frame()), jpeg(adobe(2), frame()),
    jpeg(segment(238, [65, 100, 111, 98, 101]), frame()), jpeg(segment(224, [74, 70, 73, 70, 0]), frame()),
    jpeg(frame(), frame()), Uint8Array.of(255, 216, 255, 224, 0, 9, 0),
  ])('rejects malformed or contradictory header metadata', source => {
    expect(() => jpegForPdfColorTransform(source, 0)).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
  });

  it('bounds marker work and rejects unsupported precision', () => {
    expect(() => readJpegHeader(jpeg(Array.from({ length: 4097 }, () => [255, 1]).flat(), frame()))).toThrow(expect.objectContaining({ code: 'pdf_limit' }));
    expect(() => jpegForPdfColorTransform(jpeg(frame(3, 12)), 1)).toThrow(expect.objectContaining({ code: 'pdf_unsupported' }));
  });
});
