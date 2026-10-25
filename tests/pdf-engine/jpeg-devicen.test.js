import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { readPdfImage } from '../../src/pdf/image-data.js';
import { resolvePdfColorSpace } from '../../src/pdf/color-spaces.js';
import { simplePdf, stream, options } from './fixtures.js';

vi.mock('../../src/pdf/image-limits.js', async importOriginal => ({ ...await importOriginal(), MAX_IMAGE_BAND_PIXELS: 4 }));
afterEach(() => vi.unstubAllGlobals());
const frame = (width = 1, height = 1) => Uint8Array.of(255, 216, 255, 192, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217);
const transform = stream('{exch 3 1 roll 1 exch sub exch dup mul}', '/FunctionType 4 /Domain [0 1 0 1 0 1] /Range [0 1 0 1 0 1]');
function imagePdf({ width = 1, height = 1, source = frame(width, height), dictionary = '', space = '[/DeviceN [/InkA /InkB /InkC] /DeviceRGB 7 0 R]', extra = [], fn = transform } = {}) {
  return simplePdf('/I Do', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [
    stream(source, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8 /Filter /DCTDecode /ColorSpace ${space} ${dictionary}`), fn, ...extra,
  ] });
}
async function payload(data) { const core = await createPdfDocumentCore(data, options); try { return await core.pagePayload(1); } finally { core.destroy(); } }
function decoder(rgb, width = 1, height = 1, { bitmapWidth = width, opacity = 255 } = {}) {
  const close = vi.fn(), surfaces = [], draws = [];
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: bitmapWidth, height, close })));
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(w, h) { this.width = w; this.height = h; surfaces.push(this); }
    getContext() { let top; return {
      drawImage(_bitmap, _x, y, w, rows) { top = y; draws.push({ top, width: w, rows }); },
      getImageData(_x, _y, w, rows) { return { data: Uint8ClampedArray.from(Array.from({ length: w * rows }, (_, i) => [...rgb.slice((top * width + i) * 3, (top * width + i + 1) * 3), opacity]).flat()) }; },
    }; }
  });
  return { close, surfaces, draws };
}

describe('three-component JPEG DeviceN tint inputs', () => {
  it('applies a nontrivial declared tint instead of displaying native decoded RGB', async () => {
    const resources = decoder([64, 128, 192]);
    const image = (await payload(imagePdf())).commands.find(c => c.op === 'image');
    expect([...image.pixels]).toEqual([128, 63, 16, 255]);
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
    expect(resources.close).toHaveBeenCalledOnce(); expect(resources.surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });

  it('applies each Decode component before tint clipping and transformation', async () => {
    decoder([64, 128, 192]);
    const image = (await payload(imagePdf({ dictionary: '/Decode [1 0 .1 .9 0 2]' }))).commands.find(c => c.op === 'image');
    expect([...image.pixels]).toEqual([...new Uint8ClampedArray([(.1 + .8 * 128 / 255) * 255, 0, (1 - 64 / 255) ** 2 * 255]), 255]);
  });

  it('tests color-key intervals against original decoded samples', async () => {
    decoder([64, 128, 192]);
    const image = (await payload(imagePdf({ dictionary: '/Mask [64 64 128 128 192 192]' }))).commands.find(c => c.op === 'image');
    expect([...image.pixels]).toEqual([128, 63, 16, 0]);
  });

  it('unblends Matte in the original DeviceN components before applying the tint', async () => {
    decoder([128, 128, 255]);
    const mask = stream(Uint8Array.of(128), '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Matte [1 1 1]');
    const image = (await payload(imagePdf({ dictionary: '/SMask 8 0 R', extra: [mask] }))).commands.find(c => c.op === 'image');
    expect([...image.pixels]).toEqual([2, 0, 0, 128]);
  });

  it('uses the active PCS output profile after the declared alternate', async () => {
    decoder([64, 128, 192]); const reader = await NativePdfReader.create(imagePdf(), options);
    try {
      const id = reader.checked(reader.api.pn_pdf_resolve(6, 0)), space = await resolvePdfColorSpace(reader, 0, reader.field(id, 'ColorSpace'), options.loadAsset);
      const outputProfile = { channels: 3, fromXyz: vi.fn(xyz => [xyz[0], xyz[1] / 2, xyz[2] / 3]) };
      const image = await readPdfImage(reader, id, { loadAsset: options.loadAsset, outputProfile });
      const xyz = space.toXyz([64 / 255, 128 / 255, 192 / 255]);
      expect(outputProfile.fromXyz).toHaveBeenCalledWith(xyz);
      expect([...image.pixels]).toEqual([...new Uint8ClampedArray([xyz[0], xyz[1] / 2, xyz[2] / 3].map(v => v * 255)), 255]);
    } finally { reader.destroy(); }
  });

  it('preserves all three sample channels across bounded readback bands', async () => {
    const rgb = [0, 32, 64, 64, 96, 128, 128, 160, 192, 192, 224, 255, 32, 64, 96, 96, 128, 160];
    const resources = decoder(rgb, 2, 3); const image = (await payload(imagePdf({ width: 2, height: 3 }))).commands.find(c => c.op === 'image');
    const expected = Array.from({ length: 6 }, (_, i) => [rgb[i * 3 + 1], 255 - rgb[i * 3 + 2], Math.round(rgb[i * 3] ** 2 / 255), 255]).flat();
    expect([...image.pixels]).toEqual(expected); expect(resources.draws).toEqual([{ top: 0, width: 2, rows: 2 }, { top: 2, width: 2, rows: 1 }]);
    expect(resources.close).toHaveBeenCalledOnce(); expect(resources.surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });

  it.each([
    ['one decoded channel', { source: Uint8Array.of(255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 217) }, 'pdf_unsupported'],
    ['wrong source bit depth', { source: frame().map((v, i) => i === 6 ? 12 : v) }, 'pdf_unsupported'],
    ['wrong PDF bit depth', { dictionary: '/BitsPerComponent 16' }, 'pdf_unsupported'],
    ['wrong source dimensions', { source: frame(2, 1) }, 'pdf_corrupt'],
  ])('rejects %s before native decode', async (_label, attributes, code) => {
    decoder([64, 128, 192]); await expect(payload(imagePdf(attributes))).rejects.toMatchObject({ code }); expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it.each([2, 4])('keeps %i-component DeviceN JPEG samples explicitly unsupported', async components => {
    decoder([64, 128, 192]);
    const names = Array.from({ length: components }, (_, i) => `/Ink${i}`).join(' '), domain = '0 1 '.repeat(components), program = components === 2 ? '{0}' : '{pop}';
    await expect(payload(imagePdf({ space: `[/DeviceN [${names}] /DeviceRGB 7 0 R]`, fn: stream(program, `/FunctionType 4 /Domain [${domain}] /Range [0 1 0 1 0 1]`) }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it.each([{ bitmapWidth: 2 }, { opacity: 128 }])('releases native resources after invalid decoded output: %j', async config => {
    const resources = decoder([64, 128, 192], 1, 1, config); await expect(payload(imagePdf())).rejects.toMatchObject({ code: 'pdf_corrupt' }); expect(resources.close).toHaveBeenCalledOnce();
    for (const surface of resources.surfaces) expect(surface).toMatchObject({ width: 0, height: 0 });
  });
});
