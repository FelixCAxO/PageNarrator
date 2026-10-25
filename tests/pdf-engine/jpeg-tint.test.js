import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { readPdfImage } from '../../src/pdf/image-data.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { resolvePdfColorSpace } from '../../src/pdf/color-spaces.js';
import { simplePdf, stream, options } from './fixtures.js';

afterEach(() => vi.unstubAllGlobals());
// Sample-frame fixture only; actual JPEG decoding is checked in browser replay.
const frame = Uint8Array.of(255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 2, 1, 1, 17, 0, 255, 217);
const fn = '<< /FunctionType 2 /Domain [0 1] /C0 [1 .5 0] /C1 [0 .25 1] /N 2 >>';
function imagePdf({ source = frame, space = '[/Separation /LogoInk /DeviceRGB 7 0 R]', image = '', extra = [] } = {}) {
  return simplePdf('/I Do', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [
    stream(source, `/Type /XObject /Subtype /Image /Width 2 /Height 1 /BitsPerComponent 8 /Filter /DCTDecode /ColorSpace ${space} ${image}`), fn, ...extra,
  ] });
}
async function payload(data) {
  const core = await createPdfDocumentCore(data, options);
  try { return await core.pagePayload(1); } finally { core.destroy(); }
}

describe('single-component JPEG samples in PDF tint and indexed spaces', () => {
  it('precomputes every eight-bit nonlinear tint including reversed Decode values', async () => {
    const image = (await payload(imagePdf({ image: '/Decode [1 0]' }))).commands.find(command => command.op === 'jpeg');
    expect(image.components).toBe(1); expect(image.colorLookup).toHaveLength(768);
    for (let sample = 0; sample < 256; sample++) {
      const tint = 1 - sample / 255;
      expect([...image.colorLookup.subarray(sample * 3, sample * 3 + 3)]).toEqual([...new Uint8ClampedArray([1 - tint * tint, .5 - .25 * tint * tint, tint * tint].map(value => value * 255))]);
    }
    expect(pdfPayloadBuffers({ commands: [image] })).toContain(image.colorLookup.buffer);
    const cloned = structuredClone(image, { transfer: [image.colorLookup.buffer] });
    expect(image.colorLookup.byteLength).toBe(0); expect(cloned.colorLookup).toHaveLength(768);
  });

  it('uses the declared Indexed table and the default full eight-bit Decode range', async () => {
    const image = (await payload(imagePdf({ space: '[/Indexed /DeviceRGB 1 <ff000000ff00>]' }))).commands.find(command => command.op === 'jpeg');
    expect(image.decode).toEqual([0, 255]);
    expect([...image.colorLookup.subarray(0, 6)]).toEqual([255, 0, 0, 0, 255, 0]);
    expect([...image.colorLookup.subarray(765)]).toEqual([0, 255, 0]);
  });

  it('converts tint colours through the active blend profile before transfer', async () => {
    const reader = await NativePdfReader.create(imagePdf(), options);
    try {
      const id = reader.checked(reader.api.pn_pdf_resolve(6, 0)), space = await resolvePdfColorSpace(reader, 0, reader.field(id, 'ColorSpace'), options.loadAsset);
      const outputProfile = { channels: 3, fromXyz: xyz => [xyz[0], xyz[1] / 2, xyz[2] / 3] };
      const image = await readPdfImage(reader, id, { loadAsset: options.loadAsset, outputProfile });
      for (const sample of [0, 63, 127, 255]) expect([...image.colorLookup.subarray(sample * 3, sample * 3 + 3)]).toEqual([...new Uint8ClampedArray(outputProfile.fromXyz(space.toXyz([sample / 255])).map(value => value * 255))]);
    } finally { reader.destroy(); }
  });

  it('renders mapped colour samples with independent mask alpha and releases resources', async () => {
    const mask = stream(Uint8Array.of(128, 255), '/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8');
    const model = await payload(imagePdf({ image: '/SMask 8 0 R', extra: [mask] }));
    const close = vi.fn(), written = [], surfaces = [];
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2, height: 1, close })));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(width, height) { this.width = width; this.height = height; surfaces.push(this); }
      getContext() { return { drawImage() {}, getImageData: () => ({ data: Uint8ClampedArray.of(0, 0, 0, 255, 255, 255, 255, 255) }), putImageData: pixels => written.push([...pixels.data]) }; }
    });
    const ctx = { canvas: { width: 40, height: 40 }, save() {}, restore() {}, setTransform() {}, transform() {}, fillRect() {}, beginPath() {}, scale() {}, drawImage() {} };
    await renderPdfDisplayList(model, { canvasContext: ctx, viewport: createPdfViewport([0, 0, 40, 40]) }).promise;
    expect(written).toEqual([[255, 128, 0, 128, 0, 64, 255, 255]]);
    expect(close).toHaveBeenCalledOnce(); expect(surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });

  it.each([
    ['missing sample frame', Uint8Array.of(255, 216, 255, 217), 'pdf_corrupt'],
    ['truncated segment', frame.subarray(0, 12), 'pdf_corrupt'],
    ['dimensions disagree', frame.map((value, i) => i === 10 ? 3 : value), 'pdf_corrupt'],
    ['multiple components', Uint8Array.of(255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 2, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217), 'pdf_unsupported'],
    ['non-eight-bit samples', frame.map((value, i) => i === 6 ? 12 : value), 'pdf_unsupported'],
  ])('rejects %s without treating RGB pixels as original tint samples', async (_label, source, code) => {
    await expect(payload(imagePdf({ source }))).rejects.toMatchObject({ code });
  });

  it('keeps unsupported tint Matte and four-component JPEG data fail-closed', async () => {
    const mask = stream(Uint8Array.of(128, 255), '/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Matte [1]');
    await expect(payload(imagePdf({ image: '/SMask 8 0 R', extra: [mask] }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
    await expect(payload(imagePdf({ space: '/DeviceCMYK' }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
});
