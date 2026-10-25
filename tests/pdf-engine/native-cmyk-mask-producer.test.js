import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { simplePdf, stream, options } from './fixtures.js';

afterEach(() => vi.unstubAllGlobals());
const flat = commands => commands.flatMap(command => [command, ...(command.commands ? flat(command.commands) : [])]);
const gray = [0, 85, 170, 255];
function fixture({ pageGroup = true, isolated = true, state = '', elementary = false } = {}) {
  // Header-only authored JPEG tests producer transport. Separate frozen browser
  // controls exercise actual JPEG bytes/decoder/scalar and native pixels.
  const jpeg = Uint8Array.of(255, 216, 255, 192, 0, 11, 8, 0, 2, 0, 2, 1, 1, 17, 0, 255, 217);
  return simplePdf(elementary ? '/A gs .2 .3 .4 .5 k 0 0 2 2 re f' : '/A gs /T Do', {
    page: `${pageGroup ? '/Group << /S /Transparency /CS /DeviceCMYK >>' : ''} /Resources << /ExtGState << /A 6 0 R >> /XObject << /T 7 0 R >> >>`,
    extra: ['<< /ca .5 /SMask 9 0 R ' + state + ' >>',
      stream('.2 .3 .4 .5 k 0 0 2 2 re f', `/Subtype /Form /BBox [0 0 2 2] /Group << /S /Transparency /CS /DeviceCMYK /I ${isolated} >>`),
      '<< /ca 1 /CA 1 /BM /Normal /SMask /None /AIS false /OP false /op false >>',
      '<< /S /Luminosity /G 10 0 R /BC [1 1 1 1] >>',
      stream('q /R gs 2 0 0 2 0 0 cm /I Do Q', '/Subtype /Form /BBox [0 0 2 2] /Group << /S /Transparency /CS /DeviceCMYK /I false >> /Resources << /ExtGState << /R 8 0 R >> /XObject << /I 11 0 R >> >>'),
      stream(jpeg, '/Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /DCTDecode')],
  });
}
function decoder() {
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2, height: 2, close })));
  vi.stubGlobal('OffscreenCanvas', class {
    getContext() { return { drawImage() {}, getImageData() { return { data: Uint8ClampedArray.from(gray.flatMap(value => [value, value, value, 255])) }; } }; }
  });
  return close;
}
async function run(settings, test) {
  const core = await createPdfDocumentCore(fixture(settings), options);
  try { return await test(await core.pagePayload(1), core); } finally { core.destroy(); }
}
describe('isolated Normal native luminosity-mask producer admission', () => {
  it.each([false, true])('retains one outer mask without applying it again to inner paint: native parent=%s', async pageGroup => {
    const close = decoder();
    await run({ pageGroup }, async (payload, core) => {
      const commands = flat(payload.commands), groups = commands.filter(command => command.softMask), target = groups[0];
      expect(groups).toHaveLength(1); expect(target).toMatchObject({ op: 'group', nativeColorSpace: 'DeviceCMYK', alpha: .5, isolated: true, blend: 'source-over' });
      expect(target.softMask.deviceImage.samples).toEqual(Uint8Array.from(gray));
      const paint = flat(target.commands).find(command => command.op === 'paint' && command.kind === 'f');
      expect(paint.nativeCmykFill).toHaveLength(4); paint.nativeCmykFill.forEach((value, i) => expect(value).toBeCloseTo([.2, .3, .4, .5][i], 14));
      expect(paint.fillAlpha).toBe(1); expect(paint.softMask).toBeUndefined();
      const buffers = pdfPayloadBuffers(payload); expect(buffers).toHaveLength(2);
      const copied = structuredClone(payload, { transfer: buffers }); expect(buffers.every(buffer => buffer.byteLength === 0)).toBe(true);
      const mask = flat(copied.commands).find(command => command.softMask).softMask;
      expect(mask.deviceImage.samples).toEqual(Uint8Array.from(gray));
      core.cleanup(1); const rebuilt = flat((await core.pagePayload(1)).commands).find(command => command.softMask).softMask;
      expect(rebuilt.deviceImage.samples).not.toBe(mask.deviceImage.samples); expect(rebuilt.deviceImage.samples).toEqual(mask.deviceImage.samples);
    });
    expect(close).toHaveBeenCalledTimes(2);
  });
  it.each([{ isolated: false }, { state: '/AIS true' }, { state: '/OP true' }, { state: '/BM /Multiply' }, { elementary: true }])('keeps unsupported native mask/state scope closed: %j', async settings => {
    decoder(); await expect(run(settings, () => {})).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
});
