import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { readPdfImage } from '../../src/pdf/image-data.js';
import { simplePdf, stream, options } from './fixtures.js';

vi.mock('../../src/pdf/image-limits.js', async importOriginal => ({ ...await importOriginal(), MAX_IMAGE_BAND_PIXELS: 4 }));
afterEach(() => vi.unstubAllGlobals());

// Header-only fixtures exercise transport and sample interpretation; real JPEG decoding has browser controls.
const frame = (width, height) => Uint8Array.of(255, 216, 255, 192, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 17, 0, 255, 217);
function imagePdf({ width = 2, height = 1, maskWidth = width, maskHeight = height, mask = '', source = frame(maskWidth, maskHeight), base = '', samples = new Uint8Array(width * height * 3).fill(255), maskKey = 'SMask', maskSpace = 'DeviceGray', bits = 8 } = {}) {
  return simplePdf('/I Do', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [
    stream(samples, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /${maskKey} 7 0 R ${base}`),
    stream(source, `/Type /XObject /Subtype /Image /Width ${maskWidth} /Height ${maskHeight} /ColorSpace /${maskSpace} /BitsPerComponent ${bits} /Filter /DCTDecode ${mask}`),
  ] });
}
async function payload(data) {
  const core = await createPdfDocumentCore(data, options);
  try { return await core.pagePayload(1); } finally { core.destroy(); }
}
function decoder(samples, width, height, { bitmapWidth = width, bitmapHeight = height, contextError = null, pixelsError = null, missingContext = false, rgba = null } = {}) {
  const close = vi.fn(), surfaces = [], draws = [];
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: bitmapWidth, height: bitmapHeight, close })));
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(w, h) { this.width = w; this.height = h; surfaces.push(this); }
    getContext() {
      if (contextError) throw contextError;
      if (missingContext) return null;
      let top = 0;
      return {
        drawImage(_bitmap, _x, y, w, rows) { top = y; draws.push({ top, width: w, rows }); },
        getImageData(_x, _y, w, rows) {
          if (pixelsError) throw pixelsError;
          return { data: rgba || Uint8ClampedArray.from(Array.from({ length: w * rows }, (_, i) => [samples[top * width + i], samples[top * width + i], samples[top * width + i], 255]).flat()) };
        },
      };
    }
  });
  return { close, surfaces, draws };
}
const alpha = image => [...image.pixels].filter((_, i) => i % 4 === 3);

describe('bounded one-component JPEG soft-mask samples', () => {
  it.each([['', [0, 128, 255]], ['/Decode [1 0]', [255, 127, 0]], ['/Decode [-1 2]', [0, 129, 255]]])('applies PDF alpha Decode once: %s', async (mask, expected) => {
    const resources = decoder([0, 128, 255], 3, 1);
    const image = (await payload(imagePdf({ width: 3, mask }))).commands.find(c => c.op === 'image');
    expect(alpha(image)).toEqual(expected);
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
    expect(resources.close).toHaveBeenCalledOnce(); expect(resources.surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });

  it.each([['', [0, 0, 255, 255]], ['/Interpolate true', [0, 64, 191, 255]]])('resamples independent mask dimensions through existing PDF interpolation: %s', async (mask, expected) => {
    decoder([0, 255], 2, 1);
    const image = (await payload(imagePdf({ width: 4, maskWidth: 2, mask }))).commands.find(c => c.op === 'image');
    expect(alpha(image)).toEqual(expected);
  });

  it('retains JPEG parent transport and distinct mask alpha', async () => {
    decoder([64, 192], 2, 1);
    const image = (await payload(imagePdf({ base: '/Filter /DCTDecode', samples: frame(2, 1) }))).commands.find(c => c.op === 'jpeg');
    expect([...image.maskAlpha]).toEqual([64, 192]); expect(image.alpha).toBe(1); expect(image.bytes).toEqual(frame(2, 1));
  });

  it('undoes Matte preblending after Decode and rejects mismatched Matte dimensions', async () => {
    decoder([128], 1, 1);
    const image = (await payload(imagePdf({ width: 1, samples: Uint8Array.of(128, 128, 255), mask: '/Matte [1 1 1]' }))).commands.find(c => c.op === 'image');
    expect([...image.pixels]).toEqual([2, 2, 255, 128]);
    await expect(payload(imagePdf({ width: 2, maskWidth: 1, mask: '/Matte [1 1 1]' }))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it('uses bounded canvas bands without losing sample rows', async () => {
    const resources = decoder([0, 32, 64, 128, 192, 255], 2, 3);
    const image = (await payload(imagePdf({ width: 2, height: 3 }))).commands.find(c => c.op === 'image');
    expect(alpha(image)).toEqual([0, 32, 64, 128, 192, 255]);
    expect(resources.draws).toEqual([{ top: 0, width: 2, rows: 2 }, { top: 2, width: 2, rows: 1 }]);
    expect(resources.close).toHaveBeenCalledOnce(); expect(resources.surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });

  it.each([
    ['PDF/source dimensions disagree', { source: frame(1, 1) }, 'pdf_corrupt'],
    ['non-eight-bit frame', { source: frame(2, 1).map((v, i) => i === 6 ? 12 : v) }, 'pdf_unsupported'],
    ['RGB frame', { source: Uint8Array.of(255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 2, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217) }, 'pdf_unsupported'],
    ['wrong PDF color space', { maskSpace: 'DeviceRGB' }, 'pdf_unsupported'],
    ['wrong PDF bit depth', { bits: 16 }, 'pdf_unsupported'],
    ['explicit image-mask stream', { maskKey: 'Mask' }, 'pdf_unsupported'],
    ['stencil soft mask', { mask: '/ImageMask true' }, 'pdf_unsupported'],
  ])('rejects %s before native decode', async (_label, attributes, code) => {
    decoder([0, 255], 2, 1);
    await expect(payload(imagePdf(attributes))).rejects.toMatchObject({ code }); expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it.each([
    ['decoded dimensions', { bitmapWidth: 3 }, 'pdf_corrupt'],
    ['missing context', { missingContext: true }, 'pdf_render'],
    ['non-gray result', { rgba: Uint8ClampedArray.of(0, 1, 0, 255, 255, 255, 255, 255) }, 'pdf_corrupt'],
    ['non-opaque result', { rgba: Uint8ClampedArray.of(0, 0, 0, 128, 255, 255, 255, 255) }, 'pdf_corrupt'],
  ])('releases decoded resources after %s rejection', async (_label, config, code) => {
    const resources = decoder([0, 255], 2, 1, config);
    await expect(payload(imagePdf())).rejects.toMatchObject({ code }); expect(resources.close).toHaveBeenCalledOnce();
    for (const surface of resources.surfaces) expect(surface).toMatchObject({ width: 0, height: 0 });
  });

  it.each(['contextError', 'pixelsError'])('releases resources on thrown %s', async kind => {
    const error = new Error('native canvas failure'), resources = decoder([0, 255], 2, 1, { [kind]: error });
    await expect(payload(imagePdf())).rejects.toBe(error); expect(resources.close).toHaveBeenCalledOnce(); expect(resources.surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });

  it('closes the asynchronously decoded bitmap when the reader is cancelled', async () => {
    const reader = await NativePdfReader.create(imagePdf(), options), close = vi.fn();
    const check = vi.spyOn(reader, 'check');
    vi.stubGlobal('OffscreenCanvas', class { constructor() { throw Error('must not allocate'); } });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { check.mockImplementation(() => { throw new Error('cancelled reader'); }); return { width: 2, height: 1, close }; }));
    try { await expect(readPdfImage(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0)), { loadAsset: options.loadAsset })).rejects.toThrow('cancelled reader'); expect(close).toHaveBeenCalledOnce(); }
    finally { check.mockRestore(); reader.destroy(); }
  });

  it('does not pretend to decode JPEG alpha without browser image APIs', async () => {
    vi.stubGlobal('createImageBitmap', undefined); vi.stubGlobal('OffscreenCanvas', undefined);
    await expect(payload(imagePdf())).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
});
